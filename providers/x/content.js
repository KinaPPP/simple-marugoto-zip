(() => {
  // Manifestによる通常注入と、background.jsによる後付け注入の両方に対応。
  // 同じタブへ二重注入されてもイベントリスナーやスクロール処理を重複させない。
  if (globalThis.__SMZ_X_CONTENT_INSTALLED__) return;
  globalThis.__SMZ_X_CONTENT_INSTALLED__ = true;

  const POST_SOURCE = 'simple-marugoto-zip';
  const RESERVED = new Set([
    'home', 'explore', 'search', 'notifications', 'messages', 'i', 'settings',
    'compose', 'login', 'logout', 'signup', 'tos', 'privacy', 'jobs', 'intent', 'share', 'hashtag', 'account', 'download', 'about'
  ]);

  let activeHandle = null;
  let activeCollectionId = null;
  let running = false;
  let collectionMode = 'auto';
  let deltaBaselinePostId = null;
  let deltaBoundaryReached = false;
  let deltaFinishTimer = null;
  let lastReportedPhase = null;
  let pendingMediaWrites = 0;
  let timer = null;
  let lastNewMediaAt = Date.now();
  let lastRelevantResponseAt = 0;
  let lastScrollAt = 0;
  let lastScrollHeight = 0;
  let stableHeightCycles = 0;
  let scrollCount = 0;
  let awaitingResponseAfterScroll = false;
  let networkSeenAfterLastScroll = false;
  const inflightRequests = new Set();
  // X新UIでは /media（動画）と /media?filter=photo（画像）を同じ収集ジョブで巡回。
  // sessionStorage上の段階は同一タブ内だけに残し、アカウント・ジョブIDが変われば無視する。
  const UI_SETTINGS_KEY = 'smz_user_settings_v1';
  const SPLIT_STAGE_KEY = 'smz_x_split_collection_stage';
  let uiSettings = { xSplitMedia: true, xRevertProfileTabs: false };
  let splitLayout = null; // Xの実効フラグ。Control Panelによる旧UI化も検出する。
  let successfulPageResponses = 0;
  const uiSettingsReady = chrome.storage?.local?.get ? chrome.storage.local.get(UI_SETTINGS_KEY).then((storage) => {
    const source = storage?.[UI_SETTINGS_KEY] || {};
    uiSettings = { xSplitMedia: source.xSplitMedia !== false,
      xRevertProfileTabs: source.xRevertProfileTabs === true };
    window.postMessage({ source: 'simple-marugoto-zip', type: 'SMZ_X_UI_SETTINGS',
      revertProfileTabs: uiSettings.xRevertProfileTabs }, '*');
  }).catch(() => {}) : null;

  function getSplitStage() {
    try {
      const v = JSON.parse(sessionStorage.getItem(SPLIT_STAGE_KEY) || 'null');
      return v?.handle === activeHandle?.toLowerCase() && v?.collectionId === activeCollectionId ? v : null;
    } catch { return null; }
  }
  function saveSplitStage(phase) {
    if (!activeHandle || !activeCollectionId) return;
    try {
      sessionStorage.setItem(SPLIT_STAGE_KEY, JSON.stringify({
        handle: activeHandle.toLowerCase(), collectionId: activeCollectionId, phase
      }));
    } catch {}
  }
  function clearSplitStage() {
    try { sessionStorage.removeItem(SPLIT_STAGE_KEY); } catch {}
  }
  function currentRouteIsPhoto() {
    return /(?:^|[?&])filter=photo(?:&|$)/.test(String(location.search || ''));
  }


  // v0.0.17: 一定間隔で盲目的にスクロールするのではなく、
  // X自身のUserMedia等の通信が終わるのを待ってから次へ進む。
  // 人間らしさの偽装ではなく、ページとサーバーへ余計な要求を重ねないための明示的なペーシング。
  const PACING_TICK_MS = 350;
  const MIN_SCROLL_GAP_MS = 2600;
  const RESPONSE_SETTLE_MS = 1200;
  const NO_RESPONSE_RETRY_MS = 6500;
  const COMPLETE_IDLE_MS = 28000;
  const COMPLETE_RESPONSE_IDLE_MS = 6500;
  const MIN_SCROLLS_BEFORE_COMPLETE = 5;
  const STABLE_HEIGHT_CYCLES = 5;

  function parseTarget() {
    const host = location.hostname.toLowerCase();
    if (host !== 'x.com' && host !== 'www.x.com' && host !== 'twitter.com' && host !== 'www.twitter.com') return null;
    const parts = location.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    const handle = parts[0].replace(/^@/, '');
    if (!handle || RESERVED.has(handle.toLowerCase())) return null;
    return {
      platform: 'x',
      handle,
      isMediaPage: parts[1]?.toLowerCase() === 'media'
    };
  }

  function setSessionMarker(handle) {
    try {
      if (handle) sessionStorage.setItem('smz_x_collect_handle', handle);
      else sessionStorage.removeItem('smz_x_collect_handle');
    } catch {}
  }

  function setHook(enabled, handle = activeHandle) {
    window.postMessage({
      source: POST_SOURCE,
      type: 'SMZ_X_CONTROL',
      enabled,
      handle: handle || ''
    }, '*');
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function clearDeltaTimer() {
    if (deltaFinishTimer) clearTimeout(deltaFinishTimer);
    deltaFinishTimer = null;
  }

  function scheduleDeltaCompletion(delay = 1800) {
    if (!running || !deltaBaselinePostId || !deltaBoundaryReached) return;
    clearDeltaTimer();
    deltaFinishTimer = setTimeout(async () => {
      deltaFinishTimer = null;
      if (!running || !deltaBoundaryReached) return;
      const idleMs = lastRelevantResponseAt ? Date.now() - lastRelevantResponseAt : 1800;
      if (inflightRequests.size > 0 || pendingMediaWrites > 0 || idleMs < 1200) {
        scheduleDeltaCompletion(800);
        return;
      }
      await completeCollection({ endOfFeed: false });
    }, delay);
  }

  function scheduleTick(delay = PACING_TICK_MS) {
    // 手動モードでは拡張自身からスクロールも監視タイマーも発火させない。
    if (!running || collectionMode === 'manual') return;
    clearTimer();
    timer = setTimeout(tick, Math.max(50, delay));
  }

  function resetPacingState() {
    inflightRequests.clear();
    lastNewMediaAt = Date.now();
    lastRelevantResponseAt = 0;
    lastScrollAt = 0;
    lastScrollHeight = 0;
    stableHeightCycles = 0;
    scrollCount = 0;
    awaitingResponseAfterScroll = false;
    networkSeenAfterLastScroll = false;
    lastReportedPhase = null;
    successfulPageResponses = 0;
  }

  function stopLocal({ clearMarker = true } = {}) {
    running = false;
    clearTimer();
    clearDeltaTimer();
    inflightRequests.clear();
    awaitingResponseAfterScroll = false;
    networkSeenAfterLastScroll = false;
    setHook(false);
    lastReportedPhase = null;
    if (clearMarker) setSessionMarker(null);
  }

  function parseLocalizedMediaCount(text) {
    const source = String(text || '').replace(/\u00a0/g, ' ');
    const jaMan = source.match(/([\d,.]+)\s*万\s*件の画像と動画/);
    if (jaMan) {
      const n = Number(jaMan[1].replace(/,/g, ''));
      if (Number.isFinite(n)) return Math.round(n * 10000);
    }
    const ja = source.match(/([\d,]+)\s*件の画像と動画/);
    if (ja) {
      const n = Number(ja[1].replace(/,/g, ''));
      if (Number.isFinite(n)) return Math.round(n);
    }

    const en = source.match(/([\d,.]+)\s*([KkMm])?\s*(?:photos?\s*(?:and|&)\s*videos?|images?\s*(?:and|&)\s*videos?|media)/i);
    if (en) {
      let n = Number(en[1].replace(/,/g, ''));
      if (!Number.isFinite(n)) return null;
      if (en[2]?.toLowerCase() === 'k') n *= 1000;
      if (en[2]?.toLowerCase() === 'm') n *= 1000000;
      return Math.round(n);
    }
    return null;
  }

  function visibleMediaCount() {
    const bodyText = document.body?.innerText || '';
    return parseLocalizedMediaCount(bodyText);
  }

  async function waitForMediaCount(maxWaitMs = 4000) {
    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      const count = visibleMediaCount();
      if (Number.isFinite(count) && count >= 0) return count;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return null;
  }

  async function confirmLargeCollectionIfNeeded(handle) {
    const count = await waitForMediaCount();
    if (!Number.isFinite(count)) return true;

    const result = await chrome.runtime.sendMessage({
      type: 'SMZ_COLLECTION_MEDIA_COUNT',
      platform: 'x',
      handle,
      mediaCount: count
    });
    if (!result?.ok || !result.needConfirmation) return true;

    // 大量件数の確認はブラウザ標準confirmではなく、拡張ポップアップの
    // ステータス領域で行う。ここでは収集開始前の待機状態へ移るだけ。
    return false;
  }

  function nearBottom() {
    const doc = document.documentElement;
    return window.scrollY + window.innerHeight >= doc.scrollHeight - Math.max(1000, window.innerHeight * 1.5);
  }

  async function completeCollection({ endOfFeed = false } = {}) {
    if (!running || !activeHandle || (collectionMode === 'manual' && !deltaBoundaryReached)) return;
    const handle = activeHandle;
    const collectionId = activeCollectionId;
    if (uiSettingsReady) await uiSettingsReady;
    const stage = getSplitStage();
    // デフォルトの新UIで動画と画像を別々に収集。旧UIと判定できたら二度巡回しない。
    if (endOfFeed && collectionMode === 'auto' && uiSettings.xSplitMedia &&
        stage?.phase !== 'photos' && splitLayout !== false) {
      saveSplitStage('photos');
      stopLocal({ clearMarker: false });
      location.href = `https://x.com/${encodeURIComponent(handle)}/media?filter=photo`;
      return;
    }
    // 0件が「正常な空アカウント」なのか「未対応UI」なのかを区別する。
    // メディア画面から一度も対象GraphQLの正常応答が無い場合、0件完了を出さない。
    if (endOfFeed && successfulPageResponses === 0 &&
        (stage?.phase === 'photos' || splitLayout === false || !uiSettings.xSplitMedia)) {
      stopLocal();
      await chrome.runtime.sendMessage({ type: 'SMZ_COLLECTION_ERROR', platform: 'x', handle, collectionId,
        error: 'XのメディアAPI応答を確認できません。Xの画面更新により収集できていない可能性があります。' });
      return;
    }
    stopLocal();
    clearSplitStage();
    await chrome.runtime.sendMessage({ type: 'SMZ_COLLECTION_COMPLETE', platform: 'x', handle, collectionId, endOfFeed });
  }

  function reportPhase(phase) {
    if (!running || collectionMode === 'manual' || phase === lastReportedPhase) return;
    lastReportedPhase = phase;
    void chrome.runtime.sendMessage({ type: 'SMZ_COLLECTION_PHASE', platform: 'x', handle: activeHandle,
      collectionId: activeCollectionId, phase }).catch(() => {});
  }

  function noteRequestStart(requestId) {
    if (!running || !requestId) return;
    inflightRequests.add(String(requestId));
    reportPhase(null);
    if (lastScrollAt) networkSeenAfterLastScroll = true;
    scheduleTick(PACING_TICK_MS);
  }

  function noteRequestEnd(requestId) {
    if (!running) return;
    if (requestId) inflightRequests.delete(String(requestId));
    lastRelevantResponseAt = Date.now();
    if (lastScrollAt) networkSeenAfterLastScroll = true;
    // 解析・DOM更新の直後に次のスクロールを重ねず、少し落ち着く時間を置く。
    scheduleTick(RESPONSE_SETTLE_MS);
    if (deltaBoundaryReached && (collectionMode === 'manual' ? splitLayout !== true : (!uiSettings.xSplitMedia || splitLayout === false))) scheduleDeltaCompletion();
  }

  async function tick() {
    if (!running || collectionMode === 'manual') return;
    // 新UIの動画側だけで差分境界が見えても、画像側に未収集の新着が残る。
    // 新UIの差分は両ページの末尾まで確認し、誤った早期完了を避ける。
    if (deltaBaselinePostId && deltaBoundaryReached &&
        (!uiSettings.xSplitMedia || splitLayout === false)) {
      scheduleDeltaCompletion();
      return;
    }
    const target = parseTarget();
    if (!target || target.handle.toLowerCase() !== activeHandle.toLowerCase() || !target.isMediaPage) {
      stopLocal();
      await chrome.runtime.sendMessage({
        type: 'SMZ_COLLECTION_ERROR',
        platform: 'x',
        handle: activeHandle,
        collectionId: activeCollectionId,
        error: '収集中に対象ユーザーのメディアページから移動しました'
      });
      return;
    }

    const now = Date.now();

    // X自身がUserMedia等を処理中なら、その通信が終わるまで次のスクロールを送らない。
    if (inflightRequests.size > 0 || pendingMediaWrites > 0) {
      scheduleTick(PACING_TICK_MS);
      return;
    }

    if (lastRelevantResponseAt && now - lastRelevantResponseAt < RESPONSE_SETTLE_MS) {
      scheduleTick(RESPONSE_SETTLE_MS - (now - lastRelevantResponseAt));
      return;
    }

    if (lastScrollAt && now - lastScrollAt < MIN_SCROLL_GAP_MS) {
      scheduleTick(MIN_SCROLL_GAP_MS - (now - lastScrollAt));
      return;
    }

    // 前回スクロール後に通信が始まった場合は、そのレスポンス完了＋settleを待ったので次へ進める。
    // 何も通信が起きなかった場合は、ページ最下部判定のため一定時間後にだけ再度プローブする。
    if (awaitingResponseAfterScroll) {
      if (networkSeenAfterLastScroll) {
        awaitingResponseAfterScroll = false;
      } else if (now - lastScrollAt < NO_RESPONSE_RETRY_MS) {
        scheduleTick(NO_RESPONSE_RETRY_MS - (now - lastScrollAt));
        return;
      } else {
        awaitingResponseAfterScroll = false;
      }
    }

    const height = Math.max(document.body?.scrollHeight || 0, document.documentElement.scrollHeight || 0);
    if (height === lastScrollHeight) stableHeightCycles++;
    else stableHeightCycles = 0;
    lastScrollHeight = height;

    const idleMs = now - lastNewMediaAt;
    const responseIdleMs = lastRelevantResponseAt ? now - lastRelevantResponseAt : Number.POSITIVE_INFINITY;
    const checkingEnd = scrollCount >= MIN_SCROLLS_BEFORE_COMPLETE &&
      idleMs >= 12000 && responseIdleMs >= 3500 && stableHeightCycles >= 2 && nearBottom();
    reportPhase(checkingEnd ? 'final_check' : null);
    if (
      scrollCount >= MIN_SCROLLS_BEFORE_COMPLETE &&
      idleMs >= COMPLETE_IDLE_MS &&
      responseIdleMs >= COMPLETE_RESPONSE_IDLE_MS &&
      stableHeightCycles >= STABLE_HEIGHT_CYCLES &&
      nearBottom()
    ) {
      await completeCollection({ endOfFeed: true });
      return;
    }

    window.scrollTo({ top: height, behavior: 'smooth' });
    scrollCount++;
    lastScrollAt = Date.now();
    awaitingResponseAfterScroll = true;
    networkSeenAfterLastScroll = false;
    scheduleTick(MIN_SCROLL_GAP_MS);
  }

  async function startCollecting(handle, { resetPosition = false, skipLargeWarning = false, mode = 'auto', baselinePostId = null } = {}) {
    if (uiSettingsReady) await uiSettingsReady;
    activeHandle = handle;
    collectionMode = mode === 'manual' ? 'manual' : 'auto';
    deltaBaselinePostId = /^\d+$/.test(String(baselinePostId || '')) ? String(baselinePostId) : null;
    deltaBoundaryReached = false;
    if (!getSplitStage() && collectionMode === 'auto') {
      saveSplitStage(currentRouteIsPhoto() ? 'photos' : 'videos');
    }
    setSessionMarker(handle);
    running = true;
    resetPacingState();
    clearTimer();
    setHook(true, handle);
    if (resetPosition && collectionMode === 'auto') window.scrollTo({ top: 0, behavior: 'auto' });

    if (!skipLargeWarning) {
      const proceed = await confirmLargeCollectionIfNeeded(handle);
      if (!proceed) {
        stopLocal({ clearMarker: false });
        return;
      }
    }

    // 手動モードは受動的な通信監視だけ。ユーザーが普通にスクロールし、
    // 終わったらポップアップから明示的に「収集を完了」を押す。
    if (collectionMode === 'auto') scheduleTick(1200);
  }

  async function startOrNavigate(handle, options = {}) {
    if (uiSettingsReady) await uiSettingsReady;
    const target = parseTarget();
    activeHandle = handle;
    setSessionMarker(handle);
    // 新しいジョブだけ動画ページから始める。写真ページでの429再開は現在の段階を保持。
    if (!options.automatic && options.forceReload && options.collectionMode !== 'manual') {
      clearSplitStage();
    }
    const stage = getSplitStage();
    // A paused job can resume between the two pages. The stored stage, not the
    // page the user currently happens to be viewing, is authoritative.
    const desiredPhase = options.collectionMode !== 'manual' && uiSettings.xSplitMedia
      ? (stage?.phase === 'photos' ? 'photos' : 'videos') : null;
    const wrongPhase = desiredPhase === 'photos' ? !currentRouteIsPhoto()
      : desiredPhase === 'videos' ? currentRouteIsPhoto() : false;
    if (!target || target.handle.toLowerCase() !== handle.toLowerCase() || !target.isMediaPage || wrongPhase) {
      if (desiredPhase && !stage) saveSplitStage('videos');
      location.href = `https://x.com/${encodeURIComponent(handle)}/media` +
        (desiredPhase === 'photos' ? '?filter=photo' : '');
      return;
    }

    if (options.forceReload && !options.automatic) {
      location.reload();
      return;
    }
    await startCollecting(handle, {
      resetPosition: !options.automatic,
      skipLargeWarning: !!options.skipLargeWarning || !!options.automatic,
      mode: options.collectionMode,
      baselinePostId: options.deltaBaselinePostId
    });
  }

  async function handleRateLimit(resumeAt, { simulated = false } = {}) {
    if (!running || !activeHandle) return { ok: false, error: '現在収集中ではありません' };
    const handle = activeHandle;
    const collectionId = activeCollectionId;
    stopLocal();
    const result = await chrome.runtime.sendMessage({
      type: 'SMZ_COLLECTION_RATE_LIMIT',
      platform: 'x',
      handle,
      collectionId,
      resumeAt: resumeAt || null,
      simulated
    });
    if (!result?.ok || result.state?.status !== 'rate_limited') {
      return { ok: false, error: result?.error || '収集状態が変更されたため疑似429を適用しませんでした' };
    }
    return { ok: true };
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.source !== POST_SOURCE) return;
    if (event.data.type === 'SMZ_X_PROFILE_LAYOUT') {
      splitLayout = event.data.split === true;
      return;
    }
    if (!activeHandle) return;

    if (event.data.type === 'SMZ_X_REQUEST_START') {
      noteRequestStart(event.data.requestId);
      return;
    }

    if (event.data.type === 'SMZ_X_REQUEST_END') {
      if (running && Number(event.data.status) >= 200 && Number(event.data.status) < 300 &&
          /(Media|Video|Photo|SearchTimeline|UserTweets)/i.test(String(event.data.requestUrl || ''))) successfulPageResponses++;
      noteRequestEnd(event.data.requestId);
      return;
    }

    if (event.data.type === 'SMZ_X_MEDIA_BATCH') {
      if (!running) return;
      const items = Array.isArray(event.data.items) ? event.data.items : [];
      if (!items.length) return;
      successfulPageResponses = Math.max(1, successfulPageResponses);
      pendingMediaWrites++;
      try {
        const result = await chrome.runtime.sendMessage({
          type: 'SMZ_ADD_MEDIA',
          platform: 'x',
          handle: activeHandle,
          collectionId: activeCollectionId,
          items,
          requestUrl: event.data.requestUrl || ''
        });
        if (result?.ok && result.addedCount > 0) {
          lastNewMediaAt = Date.now();
          reportPhase(null);
        }
        if (result?.ok && deltaBaselinePostId && result.boundaryReached) {
          deltaBoundaryReached = true;
          reportPhase('final_check');
        }
      } catch {} finally {
        pendingMediaWrites = Math.max(0, pendingMediaWrites - 1);
        if (deltaBoundaryReached && (collectionMode === 'manual' ? splitLayout !== true : (!uiSettings.xSplitMedia || splitLayout === false))) scheduleDeltaCompletion();
      }
      return;
    }

    if (event.data.type === 'SMZ_X_RATE_LIMIT') {
      await handleRateLimit(event.data.resumeAt || null);
      return;
    }

    if (event.data.type === 'SMZ_X_AUTH_ERROR') {
      stopLocal();
      await chrome.runtime.sendMessage({
        type: 'SMZ_COLLECTION_ERROR',
        platform: 'x',
        handle: activeHandle,
        collectionId: activeCollectionId,
        error: `Xの認証に失敗しました（HTTP ${event.data.status}）。Xへログインしているか確認してください。`
      });
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (message.type === 'SMZ_START_COLLECTION') {
        stopLocal({ clearMarker: false });
        activeHandle = message.handle;
        activeCollectionId = message.collectionId || null;
        await startOrNavigate(message.handle, {
          forceReload: message.forceReload !== false,
          collectionMode: message.collectionMode,
          deltaBaselinePostId: message.deltaBaselinePostId,
          automatic: false
        });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'SMZ_RESUME_COLLECTION') {
        stopLocal({ clearMarker: false });
        activeHandle = message.handle;
        activeCollectionId = message.collectionId || null;
        await startOrNavigate(message.handle, {
          forceReload: false,
          collectionMode: message.collectionMode,
          deltaBaselinePostId: message.deltaBaselinePostId,
          automatic: !!message.automatic,
          skipLargeWarning: !!message.skipLargeWarning
        });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'SMZ_FINISH_MANUAL_CAPTURE') {
        const current = parseTarget();
        if (!running || collectionMode !== 'manual' || !current?.isMediaPage ||
            current.handle.toLowerCase() !== String(message.handle || '').toLowerCase() ||
            activeCollectionId !== message.collectionId) {
          sendResponse({ ok: false, error: '対象の手動収集は現在実行中ではありません' });
          return;
        }
        // 読み込んだレスポンスを保存し終えるまで待つ。通信が継続中なら
        // 強制的に打ち切らず、ユーザーへ数秒後の再操作をお願いする。
        const deadline = Date.now() + 8000;
        while (running && Date.now() < deadline) {
          const quietFor = lastRelevantResponseAt ? Date.now() - lastRelevantResponseAt : 1500;
          if (inflightRequests.size === 0 && pendingMediaWrites === 0 && quietFor >= 1200) {
            stopLocal();
            sendResponse({ ok: true });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        sendResponse({ ok: false, error: 'Xの読み込みが続いています。完了するまで待ってから再度押してください。' });
        return;
      }

      if (message.type === 'SMZ_DEBUG_SIMULATE_429') {
        const current = parseTarget();
        if (!running || !current?.isMediaPage ||
            current.handle.toLowerCase() !== String(message.handle || '').toLowerCase() ||
            activeHandle?.toLowerCase() !== current.handle.toLowerCase() ||
            !activeCollectionId || activeCollectionId !== message.collectionId) {
          sendResponse({ ok: false, error: '対象タブが現在の収集ジョブと一致しません' });
          return;
        }
        sendResponse(await handleRateLimit(message.resumeAt, { simulated: true }));
        return;
      }

      if (message.type === 'SMZ_STOP_COLLECTION') {
        if (activeHandle && message.handle && activeHandle.toLowerCase() !== String(message.handle).toLowerCase()) {
          sendResponse({ ok: false, error: '別の収集ジョブが実行中です' });
          return;
        }
        stopLocal();
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'SMZ_GET_TARGET') {
        sendResponse({ ok: true, target: parseTarget() });
        return;
      }
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  // ページ遷移/再読み込み後に、background側で収集中なら自動継続する。
  (async () => {
    const target = parseTarget();
    if (!target?.isMediaPage) return;
    const result = await chrome.runtime.sendMessage({
      type: 'SMZ_GET_COLLECTION',
      platform: 'x',
      handle: target.handle
    });
    if (result?.state?.status === 'collecting' && result.isCollectionTab !== false) {
      activeCollectionId = result.state.collectionId || null;
      activeHandle = target.handle;
      const continuePhotos = getSplitStage()?.phase === 'photos';
      await startCollecting(target.handle, {
        resetPosition: true,
        skipLargeWarning: continuePhotos,
        mode: result.state.collectionMode,
        baselinePostId: result.state.deltaBaselinePostId
      });
    }
  })().catch(() => {});
})();
