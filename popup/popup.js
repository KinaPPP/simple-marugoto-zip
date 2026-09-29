const SETTINGS_KEY = 'smz_user_settings_v1';
const DEFAULT_SETTINGS = Object.freeze({
  includeImages: true,
  includeVideos: true,
  splitMode: 'auto',
  downloadLimit: '5',
  collectionMode: 'manual',
  xSplitMedia: true,
  xRevertProfileTabs: false
});

const RESERVED = new Set([
  'home','explore','search','notifications','messages','i','settings','compose','login','logout','signup','tos','privacy','jobs','intent','share','hashtag','account','download','about'
]);

const els = {
  optionsBtn: document.getElementById('optionsBtn'),
  targetHandle: document.getElementById('targetHandle'),
  targetHint: document.getElementById('targetHint'),
  collectionModeRow: document.getElementById('collectionModeRow'),
  collectBtn: document.getElementById('collectBtn'),
  stopCollectBtn: document.getElementById('stopCollectBtn'),
  statusPanel: document.getElementById('statusPanel'),
  statusTitle: document.getElementById('statusTitle'),
  statusDetail: document.getElementById('statusDetail'),
  statusPercent: document.getElementById('statusPercent'),
  progressTrack: document.getElementById('progressTrack'),
  progressBar: document.getElementById('progressBar'),
  resumeRow: document.getElementById('resumeRow'),
  restartBtn: document.getElementById('restartBtn'),
  newOnlyBtn: document.getElementById('newOnlyBtn'),
  confirmRow: document.getElementById('confirmRow'),
  confirmCancelBtn: document.getElementById('confirmCancelBtn'),
  confirmActionBtn: document.getElementById('confirmActionBtn'),
  imageCount: document.getElementById('imageCount'),
  videoCount: document.getElementById('videoCount'),
  includeImages: document.getElementById('includeImages'),
  includeVideos: document.getElementById('includeVideos'),
  zipBtn: document.getElementById('zipBtn'),
  stopZipBtn: document.getElementById('stopZipBtn'),
  mediaHint: document.getElementById('mediaHint'),
  notice: document.getElementById('notice')
};

let activeTab = null;
let target = null;
let state = null;
let pollTimer = null;
let settingsReady = false;
let xUiSettings = { xSplitMedia: true, xRevertProfileTabs: false };
let pendingConfirmation = null;
let preferredCollectionMode = 'manual';
let manualFinishBusy = false;
let manualFinishFeedback = '';
let noticeUntil = 0;
let archiveStopPending = false;

function getCurrentSettings() {
  return {
    includeImages: !!els.includeImages.checked,
    includeVideos: !!els.includeVideos.checked,
    splitMode: document.querySelector('input[name="split"]:checked')?.value || DEFAULT_SETTINGS.splitMode,
    downloadLimit: document.querySelector('input[name="downloadLimit"]:checked')?.value || DEFAULT_SETTINGS.downloadLimit,
    collectionMode: preferredCollectionMode,
    ...xUiSettings
  };
}

function applySettings(settings) {
  const value = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  preferredCollectionMode = value.collectionMode === 'manual' ? 'manual' : 'auto';
  xUiSettings = { xSplitMedia: value.xSplitMedia !== false, xRevertProfileTabs: value.xRevertProfileTabs === true };
  els.includeImages.checked = value.includeImages !== false;
  els.includeVideos.checked = value.includeVideos !== false;

  const split = ['auto','500mb','1gb','500files'].includes(value.splitMode) ? value.splitMode : DEFAULT_SETTINGS.splitMode;
  const splitInput = document.querySelector(`input[name="split"][value="${split}"]`);
  if (splitInput) splitInput.checked = true;

  const downloadLimit = value.downloadLimit === 'all' ? 'all' : '5';
  const limitInput = document.querySelector(`input[name="downloadLimit"][value="${downloadLimit}"]`);
  if (limitInput) limitInput.checked = true;
}

async function loadSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  applySettings(result?.[SETTINGS_KEY]);
  settingsReady = true;
}

async function saveSettings() {
  if (!settingsReady) return;
  await chrome.storage.local.set({ [SETTINGS_KEY]: getCurrentSettings() });
}

function parseTarget(urlString) {
  try {
    const url = new URL(urlString);
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean);
    if (['bsky.app','www.bsky.app'].includes(host)) {
      if (parts[0] !== 'profile') return null;
      const actor = decodeURIComponent(parts[1] || '').replace(/^@/, '').toLowerCase();
      if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(actor) &&
          !/^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.:%_-]+)$/i.test(actor)) return null;
      return { platform:'bluesky', handle:actor, apiReady:false, pds:null };
    }
    if (['threads.com','www.threads.com','threads.net','www.threads.net'].includes(host)) {
      const handle = decodeURIComponent(parts[0] || '').replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9_](?:[a-z0-9._]{0,28}[a-z0-9_])?$/.test(handle) || handle.includes('..')) return null;
      return { platform:'threads', handle, apiReady:false };
    }
    if (!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(host)) return null;
    const handle = parts[0]?.replace(/^@/, '');
    if (!handle || RESERVED.has(handle.toLowerCase())) return null;
    return { platform:'x', handle };
  } catch { return null; }
}

function fmtCount(value) { return Number(value || 0).toLocaleString('ja-JP'); }
function cumulativeCountsForState(value) {
  if (!value?.counts) return null;
  const current = {
    images: Number(value.counts.images || 0),
    videos: Number(value.counts.videos || 0),
    total: Number(value.counts.total || 0)
  };
  if (!value.deltaMode) return current;
  const base = value.deltaBaselineCounts;
  if (!base || !Number.isFinite(Number(base.total))) return null;
  return {
    images: Number(base.images || 0) + current.images,
    videos: Number(base.videos || 0) + current.videos,
    total: Number(base.total || 0) + current.total
  };
}
function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ja-JP', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

function archiveTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  const d = Number.isFinite(date.getTime()) ? date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function mediaKindFromSelection(selection) {
  const images = selection?.images !== false;
  const videos = selection?.videos !== false;
  if (images && videos) return 'media';
  if (images) return 'images';
  if (videos) return 'videos';
  return 'media';
}

function currentMediaKind() {
  return mediaKindFromSelection({ images: els.includeImages.checked, videos: els.includeVideos.checked });
}

function archiveFilename(handle, archive, zipNumber) {
  const safeHandle = String(target?.platform === 'bluesky' ? `bsky_${handle}` : target?.platform === 'threads' ? `threads_${handle}` : handle || 'media').replace(/[\/:*?"<>|]/g, '').replace(/^@/, '') || 'media';
  const kind = archive?.mediaKind || mediaKindFromSelection(archive?.selection);
  return `${safeHandle}_${archiveTimestamp(archive?.startedAt)}_${kind}_${String(zipNumber || 1).padStart(3, '0')}.zip`;
}

function saveDirectoryKey() {
  return `archive-directory:${state?.collectionId || target?.handle || 'default'}`;
}

async function prepareSaveDestination() {
  const fs = globalThis.SMZFileSystem;
  if (!fs || !('showDirectoryPicker' in window)) {
    return { saveMode: 'downloads', saveDirectoryKey: null, saveDirectoryName: null };
  }

  const existingKey = state?.archive?.saveDirectoryKey || state?.preferredSaveDirectoryKey || null;
  const mustRepick = state?.archive?.pauseReason === 'save_permission';

  // 既に同じ収集作業で選択済みなら、ZIP保存ボタンというユーザー操作中に
  // 書き込み権限を確認し、必要ならここで再許可を求める。
  // offscreen側では分割ZIPごとに権限プロンプトを発生させない。
  if (existingKey && !mustRepick) {
    try {
      const handle = await fs.ensureWritableDirectory(existingKey, true);
      return {
        saveMode: 'directory',
        saveDirectoryKey: existingKey,
        saveDirectoryName: handle?.name || state?.archive?.saveDirectoryName || state?.preferredSaveDirectoryName || null
      };
    } catch (error) {
      if (!['SAVE_PERMISSION_REQUIRED', 'SAVE_DIRECTORY_MISSING'].includes(error?.code)) throw error;
      // 権限を復旧できない場合のみ、下のフォルダ選択へフォールバック。
    }
  }

  const key = existingKey || saveDirectoryKey();
  try {
    // 初回だけユーザー操作の直後にフォルダを選択。以後の分割ZIPは同じフォルダへ自動保存する。
    const handle = await fs.pickDirectory(key);
    return {
      saveMode: 'directory',
      saveDirectoryKey: key,
      saveDirectoryName: handle?.name || null
    };
  } catch (error) {
    if (error?.name === 'AbortError') return { cancelled: true };
    // File System Access APIが使えない環境では、従来のChromeダウンロードへフォールバック。
    console.warn('[Simple Marugoto ZIP] directory picker fallback:', error);
    return { saveMode: 'downloads', saveDirectoryKey: null, saveDirectoryName: null, fallback: true };
  }
}


function setNotice(message, error = false) {
  if (!message && Date.now() < noticeUntil) return;
  if (!message) {
    noticeUntil = 0;
    els.notice.className = 'notice hidden';
    els.statusPanel.classList.remove('has-notice');
    els.notice.textContent = '';
    return;
  }
  noticeUntil = Date.now() + 6000;
  els.notice.className = `notice${error ? ' error' : ''}`;
  els.statusPanel.classList.add('has-notice');
  els.notice.textContent = message;
}

function setProgress(mode, percent = 0) {
  if (mode === 'none') {
    els.progressTrack.className = 'progress-track hidden';
    els.progressBar.style.width = '0%';
    els.statusPercent.textContent = '';
    return;
  }
  if (mode === 'indeterminate') {
    els.progressTrack.className = 'progress-track indeterminate';
    els.statusPercent.textContent = '';
    return;
  }
  els.progressTrack.className = 'progress-track';
  const p = Math.max(0, Math.min(100, percent));
  els.progressBar.style.width = `${p}%`;
  els.statusPercent.textContent = `${Math.round(p)}%`;
}

function archiveIsRunning() {
  return state?.archive?.status === 'archiving';
}

function archiveReachedEndForDelta() {
  const archive = state?.archive;
  if (archive?.status !== 'archive_complete') return false;
  const total = Number(archive.totalSelected || 0);
  const next = Number(archive.nextItemIndex ?? archive.processedItems ?? 0);
  return total >= 0 && next >= total;
}

function effectiveSavedKindsForDelta(field) {
  const saved = { ...(state?.[field] || {}) };
  if (archiveReachedEndForDelta()) {
    if (state.archive?.selection?.images) saved.images = true;
    if (state.archive?.selection?.videos) saved.videos = true;
  }
  return saved;
}

function canCheckNewMedia() {
  if (state?.status !== 'complete' || !(['bluesky','threads'].includes(target?.platform) ? target?.platform === 'threads' ? /^\d{5,30}$/ : /^[a-zA-Z0-9._~-]{1,80}$/ : /^\d+$/).test(String(state.newestPostId || ''))) return false;
  if (state.archive?.status !== 'archive_complete') return false;
  if (state.deltaMode) {
    if (!state.deltaVerified) return false;
    const saved = effectiveSavedKindsForDelta('deltaSavedKinds');
    return (!state.counts?.images || saved.images === true) &&
      (!state.counts?.videos || saved.videos === true);
  }
  // 旧版には savedKinds が無い場合がある。その場合は従来互換で許可する。
  if (!state.savedKinds || typeof state.savedKinds !== 'object') return true;
  const saved = effectiveSavedKindsForDelta('savedKinds');
  return (!state.counts?.images || saved.images === true) &&
    (!state.counts?.videos || saved.videos === true);
}

function setArchiveUiLock(locked) {
  els.includeImages.disabled = locked;
  els.includeVideos.disabled = locked;
  els.restartBtn.disabled = locked;
  document.querySelectorAll('input[name="split"], input[name="downloadLimit"]').forEach((input) => {
    input.disabled = locked;
  });
  els.collectBtn.title = locked ? 'ZIP保存中は収集操作できません' : '';
  els.stopCollectBtn.title = locked ? 'ZIP保存中は収集操作できません' : '';
}

function render() {
  const supported = !!target;
  els.targetHandle.textContent = supported ? `@${target.handle}` : '—';
  const isBsky = target?.platform === 'bluesky';
  const isThreads = target?.platform === 'threads';
  const isApi = isBsky || isThreads;
  document.querySelector('.subtitle').textContent = isBsky ? 'Bluesky メディア一括保存' : isThreads ? 'Threads メディア一括保存' : 'X メディア一括保存';
  els.targetHint.textContent = 'X／Bluesky／Threadsのプロフィールを開いてください';
  els.targetHint.classList.toggle('hidden', supported);
  els.collectionModeRow.classList.toggle('hidden', !supported || isApi);

  els.imageCount.textContent = fmtCount(state?.counts?.images);
  els.videoCount.textContent = fmtCount(state?.counts?.videos);
  const selectedMediaCount = (els.includeImages.checked ? Number(state?.counts?.images || 0) : 0)
    + (els.includeVideos.checked ? Number(state?.counts?.videos || 0) : 0);
  const emptySelection = !!state && ['paused','complete'].includes(state.status) && selectedMediaCount === 0;
  els.mediaHint.textContent = emptySelection
    ? '選択したメディアは0件です。画像・動画のチェックを変更してください。'
    : '画像は原寸を優先。動画にはアニメーションGIFを含みます。';
  els.mediaHint.classList.toggle('empty-selection', emptySelection);

  const archivingNow = archiveIsRunning();
  const collectionComplete = state?.status === 'complete';
  const largeConfirmation = state?.status === 'awaiting_confirmation';
  const resetConfirmation = pendingConfirmation === 'reset';
  const confirmationActive = largeConfirmation || resetConfirmation;
  const manualCollecting = state?.status === 'collecting' && state?.collectionMode === 'manual';
  const deltaCollecting = state?.status === 'collecting' && state?.deltaMode === true;
  const modeLocked = archivingNow || confirmationActive || ['collecting', 'rate_limited'].includes(state?.status);
  const shownMode = modeLocked ? (state?.collectionMode || preferredCollectionMode) : preferredCollectionMode;
  document.querySelectorAll('input[name="collectionMode"]').forEach((input) => {
    input.checked = input.value === shownMode;
    input.disabled = modeLocked;
  });
  els.collectBtn.disabled = archivingNow || confirmationActive || !supported || (isApi && (!target.apiReady || (state?.resumeAt > Date.now() && state?.pauseReason === 'rate_limit'))) || collectionComplete || state?.status === 'rate_limited' || manualFinishBusy || (state?.status === 'collecting' && (!manualCollecting || deltaCollecting || !state?.counts?.total));
  els.stopCollectBtn.disabled = archivingNow || confirmationActive || !(state?.status === 'collecting' || state?.status === 'rate_limited');
  setArchiveUiLock(archivingNow);
  els.resumeRow.classList.add('hidden');
  els.newOnlyBtn.classList.add('hidden');
  els.newOnlyBtn.disabled = true;
  els.restartBtn.textContent = state?.deltaMode && !Number(state.archive?.savedZipCount || 0) ? '前回に戻す' : '進捗をリセット';
  els.confirmRow.classList.add('hidden');
  els.confirmActionBtn.classList.remove('danger');
  els.confirmActionBtn.classList.add('primary');
  els.statusPanel.classList.remove('archive-error');
  setNotice('');

  if (confirmationActive) {
    els.statusPanel.title = '';
    els.zipBtn.disabled = true;
    els.stopZipBtn.disabled = true;
    els.confirmRow.classList.remove('hidden');
    setProgress('none');

    if (resetConfirmation && state?.deltaMode && !Number(state.archive?.savedZipCount || 0)) {
      els.statusTitle.textContent = '前回の収集状態に戻しますか？';
      els.statusDetail.textContent = '今回の差分チェック結果は破棄します。前回の収集結果とZIP情報は維持されます。';
      els.confirmCancelBtn.textContent = 'やめる';
      els.confirmActionBtn.textContent = '前回に戻す';
    } else if (resetConfirmation) {
      els.statusTitle.textContent = '収集進捗をリセットしますか？';
      els.statusDetail.textContent = '収集状態とZIP進捗を削除します。保存済みのZIPファイルは削除されません。';
      els.confirmCancelBtn.textContent = 'やめる';
      els.confirmActionBtn.textContent = 'リセット';
      els.confirmActionBtn.classList.remove('primary');
      els.confirmActionBtn.classList.add('danger');
    } else {
      els.statusTitle.textContent = `約${fmtCount(state?.displayMediaCount)}件のメディアがあります`;
      els.statusDetail.textContent = '収集に長時間かかる場合があります。このまま収集を開始しますか？';
      els.confirmCancelBtn.textContent = 'キャンセル';
      els.confirmActionBtn.textContent = '続ける';
    }
    return;
  }

  if (!supported) {
    els.statusTitle.textContent = '対象ユーザーを確認できません';
    els.statusDetail.textContent = 'X・Bluesky・Threadsで保存したいユーザーのプロフィールを開いてください。';
    setProgress('none');
    els.collectBtn.textContent = 'メディアを収集';
  } else if (!state) {
    els.statusTitle.textContent = isApi && !target.apiReady ? (target.apiError ? 'APIに接続できません' : `${isThreads ? 'Threads' : 'Bluesky'}のアカウントを確認中…`) : '準備完了';
    els.statusDetail.textContent = isApi ? (target.apiError || (isThreads ? '認証済みAPIで投稿メディアを取得します。スクロール不要です。' : '公開APIで画像と動画をまとめて取得します。スクロール不要です。')) : preferredCollectionMode === 'manual'
      ? '開始後はXの /media を自分でスクロールして収集します。'
      : '「メディアを収集」を押すと /media を順番に確認します。';
    setProgress('none');
    els.collectBtn.textContent = 'メディアを収集';
  } else {
    const total = state.counts?.total || 0;
    const cumulative = cumulativeCountsForState(state);
    const cumulativeLabel = state.deltaMode && cumulative ? ` / 累計 ${fmtCount(cumulative.total)}件` : '';
    const expected = Number(state.displayMediaCount || 0);
    const detailBase = state.deltaMode
      ? `新規 ${fmtCount(total)}件${cumulativeLabel} / 前回の投稿まで確認中`
      : expected > 0 && !isApi
      ? `${fmtCount(total)}件検出 / X表示 約${fmtCount(expected)}件`
      : `${fmtCount(total)}件検出`;
    els.statusPanel.title = `開始: ${fmtTime(state.startedAt)}\n最終処理: ${fmtTime(state.updatedAt)}\n最新Post ID: ${state.newestPostId || '—'}\n最古Post ID: ${state.oldestPostId || '—'}\n${state.deltaMode ? `前回の境界: ${state.deltaBaselinePostId}\n` : ''}今回: ${fmtCount(total)}件${state.deltaMode && cumulative ? `\n累計: ${fmtCount(cumulative.total)}件` : ''}`;

    if (state.status === 'collecting') {
      if (isApi) {
        const service = isThreads ? 'Threads' : 'Bluesky';
        els.statusTitle.textContent = state.deltaMode ? `${service}の新規分を確認中…` : `${service} APIから収集中…`;
        const scanned = Number(state.scannedPosts || 0);
        els.statusDetail.textContent = `${detailBase}${scanned ? ` / ${fmtCount(scanned)}投稿確認` : ''} / ${fmtCount(state.pagesFetched || 0)}ページ取得。画面を閉じても収集を続けます`;
        setProgress('indeterminate');
        els.collectBtn.textContent = 'メディアを収集中';
      } else if (manualCollecting) {
        els.statusTitle.textContent = state.deltaMode ? '手動で新規分を確認中' : '手動スクロールで収集中';
        els.statusDetail.textContent = manualFinishFeedback || (state.deltaMode
          ? `前回の投稿までスクロールすると自動終了 / 新規 ${fmtCount(total)}件。途中保存は「停止」`
          : `Xの /media を下へスクロール。終わったら青い「収集を完了」 / ${detailBase}`);
        setProgress('indeterminate');
        els.collectBtn.textContent = state.deltaMode ? '新規分を収集中' : manualFinishBusy ? '読込終了を確認中…' : '収集を完了';
      } else {
        els.statusTitle.textContent = state.collectionPhase === 'final_check'
          ? (state.deltaMode ? '前回位置の確認中…' : '収集の最終確認中…')
          : (state.deltaMode ? '新規分をチェック中…' : '収集中…');
        els.statusDetail.textContent = state.collectionPhase === 'final_check'
          ? `追加のメディアと通信を確認中。終了後にZIP保存できます / ${detailBase}`
          : state.deltaMode ? `前回の投稿位置に到達したら自動終了 / ${detailBase}` : `Xのメディアページを確認中 / ${detailBase}`;
        setProgress('indeterminate');
        els.collectBtn.textContent = 'メディアを収集中';
      }
    } else if (state.status === 'rate_limited') {
      els.statusTitle.textContent = state.rateLimitSimulated ? '疑似429テスト：一時停止中' : 'Xのアクセス制限により一時停止中';
      const waitLabel = state.resumeAt ? `${fmtTime(state.resumeAt)}ごろ待機解除予定` : '再開待機中';
      // ステータス欄は2行固定。青ボタンが必要になる条件を省略しない。
      els.statusDetail.textContent = state.rateLimitSimulated
        ? `${waitLabel}。疑似429（実際の429ではありません）。`
        : `${waitLabel}。Xタブで再開を試み、動かなければ青ボタンから操作。`;
      setProgress('none');
      els.collectBtn.textContent = '待機中';
    } else if (state.status === 'paused') {
      const largeCancelled = state.pauseReason === 'large_cancelled';
      const resumeReady = state.pauseReason === 'resume_ready';
      els.statusTitle.textContent = isApi && state.pauseReason === 'rate_limit' ? `${isThreads ? 'Threads' : 'Bluesky'}のアクセス制限で停止しました` : state.pauseReason === 'previous_missing'
        ? '前回の収集状態を復元できません'
        : largeCancelled
        ? '大規模アカウントの収集を開始しませんでした'
        : resumeReady
          ? (state.rateLimitSimulated ? '疑似429テスト：手動再開待ち' : '待機時間が終了しました')
          : '前回の作業があります';
      const reason = ['error','auth'].includes(state.pauseReason) ? ` / ${state.lastError || 'エラーで停止'}` : '';
      els.statusDetail.textContent = isApi && state.pauseReason === 'rate_limit' ? `${detailBase} / ${fmtTime(state.resumeAt)}以降に手動で再開してください` : state.pauseReason === 'previous_missing'
        ? state.lastError
        : largeCancelled
        ? `X表示 約${fmtCount(state.displayMediaCount)}件 / 大きな青ボタンから再度開始できます`
        : resumeReady
          ? `${detailBase} / Xのメディアページを開き「収集を再開」を押してください`
          : `@${state.handle} / ${detailBase}${reason}${total ? ' / ここまでをZIP保存できます' : ''}`;
      setProgress('none');
      els.resumeRow.classList.remove('hidden');
      els.collectBtn.textContent = '収集を再開';
    } else if (state.status === 'complete' || state.status === 'archive_complete' || state.status === 'archive_paused' || state.status === 'archive_error') {
      els.statusTitle.textContent = state.lastNewCheckResult === 0 ? '新規メディアはありません' :
        state.archive?.status === 'archive_complete' ? 'ZIP保存完了' : state.deltaMode ? '新規分の収集完了' : '収集完了';
      els.statusDetail.textContent = state.lastNewCheckResult === 0
        ? `前回の収集・ZIP情報はそのままです / 最終確認 ${fmtTime(state.lastNewCheckAt)}`
        : state.deltaMode && cumulative
          ? `今回 ${fmtCount(total)}件（画像 ${fmtCount(state.counts?.images)} / 動画 ${fmtCount(state.counts?.videos)}） / 累計 ${fmtCount(cumulative.total)}件`
          : `画像 ${fmtCount(state.counts?.images)}件 / 動画 ${fmtCount(state.counts?.videos)}件${state.deltaMode ? '（新規のみ）' : ''}`;
      setProgress('none');
      els.collectBtn.textContent = '収集完了';
      els.resumeRow.classList.remove('hidden');
      els.newOnlyBtn.classList.remove('hidden');
      els.newOnlyBtn.disabled = archivingNow || !canCheckNewMedia();
      if (state.deltaMode && !canCheckNewMedia()) {
        els.newOnlyBtn.title = '次のチェック前に、今回の新規画像・動画をすべてZIP保存してください';
      } else {
        els.newOnlyBtn.title = '前回の収集位置までを確認し、新しく追加されたメディアだけを取得';
      }
    }
  }

  const archive = state?.archive;
  if (isApi && target.apiError && archive?.status !== 'archiving') {
    els.statusTitle.textContent = `${isThreads ? 'Threads' : 'Bluesky'}の操作を確認してください`;
    els.statusDetail.textContent = target.apiError;
  }
  if (archiveStopPending && archive?.status !== 'archiving') archiveStopPending = false;
  if (archiveStopPending && archive?.status === 'archiving') {
    els.resumeRow.classList.add('hidden');
    const p = Math.round((archive.progress || 0) * 100);
    els.statusTitle.textContent = 'ZIP保存を停止しています…';
    els.statusDetail.textContent = '作成途中のZIPを削除しています。完了後、最後に保存済みのZIPから再開できます。';
    setProgress('determinate', p);
    els.zipBtn.textContent = '停止処理中…';
  } else if (archive?.status === 'archiving') {
    els.resumeRow.classList.add('hidden');
    const p = Math.round((archive.progress || 0) * 100);
    els.statusTitle.textContent = 'ZIPを作成中…';
    els.statusDetail.textContent = `${archiveFilename(state.handle, archive, archive.currentZipNumber || 1)} / ${fmtCount(archive.processedItems)} / ${fmtCount(archive.totalSelected)}ファイル`;
    setProgress('determinate', p);
    els.zipBtn.textContent = 'ZIP作成中…';
  } else if (archive?.status === 'archive_paused') {
    const debugStop = archive.pauseReason === 'batch_limit';
    const userCancelled = archive.pauseReason === 'user_cancelled';
    const runtimeInterrupted = archive.pauseReason === 'runtime_interrupted';
    const savePermission = archive.pauseReason === 'save_permission';
    els.statusTitle.textContent = debugStop
      ? '5ファイルの保存が完了しました'
      : userCancelled
        ? 'ZIP保存をキャンセルしました'
        : savePermission
          ? '保存先フォルダを再選択してください'
          : runtimeInterrupted
            ? 'ZIP処理が中断されました'
            : 'ZIP作成を中断しました';
    const nextPosition = Math.min((archive.nextItemIndex || archive.processedItems || 0) + 1, archive.totalSelected || 0);
    els.statusDetail.textContent = debugStop
      ? `${fmtCount(archive.processedItems)} / ${fmtCount(archive.totalSelected)}件まで処理済み。次回は${fmtCount(nextPosition)}件目から保存します。`
      : userCancelled
        ? '保存ダイアログがキャンセルされました。同じZIPから安全に再開できます。'
        : savePermission
          ? '「ZIP保存を再開」を押すと保存先フォルダをもう一度選択できます。'
          : runtimeInterrupted
            ? '前回のZIP処理は終了していません。続きから再開できます。'
            : `${fmtCount(archive.processedItems)} / ${fmtCount(archive.totalSelected)}ファイル処理済み。次のZIPから再開できます。`;
    setProgress('determinate', (archive.progress || 0) * 100);
    els.zipBtn.textContent = 'ZIP保存を再開';
  } else if (archive?.status === 'archive_error' && !/^選択されたメディアがありません$/.test(archive.lastError || '')) {
    els.statusTitle.textContent = 'ZIP作成エラー';
    els.statusDetail.textContent = archive.lastError || 'ZIP作成中にエラーが発生しました';
    setProgress('determinate', (archive.progress || 0) * 100);
    els.zipBtn.textContent = 'ZIP保存を再開';
    els.statusPanel.classList.add('archive-error');
  } else if (archive?.status === 'archive_complete') {
    els.statusTitle.textContent = state?.lastNewCheckResult === 0 ? '新規メディアはありません' : 'ZIP保存完了';
    const savedTo = archive.saveDirectoryName ? ` / 保存先: ${archive.saveDirectoryName}` : '';
    const cumulative = cumulativeCountsForState(state);
    els.statusDetail.textContent = state?.lastNewCheckResult === 0
      ? `前回のZIPを維持 / 保存先: ${archive.saveDirectoryName || '前回の保存先'}`
      : state?.deltaMode && cumulative
        ? `今回 ${fmtCount(archive.processedItems)}件を処理 / 累計 ${fmtCount(cumulative.total)}件 / ${fmtCount(archive.savedZipCount)}個のZIPを保存${archive.failedItems ? ` / 取得失敗 ${fmtCount(archive.failedItems)}件` : ''}${savedTo}`
        : `${fmtCount(archive.processedItems)}件を処理 / ${fmtCount(archive.savedZipCount)}個のZIPを保存${archive.failedItems ? ` / 取得失敗 ${fmtCount(archive.failedItems)}件` : ''}${savedTo}`;
    setProgress('determinate', 100);
    const selectedNow = (els.includeImages.checked ? Number(state?.counts?.images || 0) : 0) + (els.includeVideos.checked ? Number(state?.counts?.videos || 0) : 0);
    const sameSelection = currentMediaKind() === (archive.mediaKind || mediaKindFromSelection(archive.selection));
    els.zipBtn.textContent = !sameSelection
      ? '新規にZIPで保存'
      : selectedNow > Number(archive.totalSelected || 0)
        ? '新規分をZIPで保存'
        : '保存済み';
  } else {
    els.zipBtn.textContent = 'ZIPで保存';
  }

  const hasCollectedMedia = (state?.counts?.total || 0) > 0;
  const collectionCanZip = ['paused', 'complete'].includes(state?.status);
  const canZip = supported && state && hasCollectedMedia && collectionCanZip;
  const selectedNow = (els.includeImages.checked ? Number(state?.counts?.images || 0) : 0) + (els.includeVideos.checked ? Number(state?.counts?.videos || 0) : 0);
  const sameSelectionAsArchive = currentMediaKind() === (state?.archive?.mediaKind || mediaKindFromSelection(state?.archive?.selection));
  const nothingNewAfterComplete = state?.archive?.status === 'archive_complete' && sameSelectionAsArchive && selectedNow <= Number(state.archive.totalSelected || 0);
  els.zipBtn.disabled = !canZip || !selectedNow || archiveIsRunning() || nothingNewAfterComplete;
  els.stopZipBtn.disabled = !archiveIsRunning() || archiveStopPending;
}

async function refresh() {
  if (!target) {
    state = null;
    render();
    return;
  }
  const result = await chrome.runtime.sendMessage({ type:'SMZ_GET_COLLECTION', platform:target.platform, handle:target.handle });
  state = result?.state || null;
  render();
}

async function bskyPermissionReady() {
  if (target?.platform !== 'bluesky' || !target.pds) return false;
  const origin = `${target.pds}/*`;
  try {
    if (await chrome.permissions.contains({ origins:[origin] })) return true;
    // 利用者が青ボタンを押した時だけ、投稿者のPDSという単一originの許可を確認する。
    const granted = await chrome.permissions.request({ origins:[origin] });
    if (!granted) {
      target.apiError = '元の画像・動画を取得するにはPDSへのアクセス許可が必要です';
      render();
    }
    return granted;
  } catch (error) {
    target.apiError = `PDSへのアクセス許可を確認できません：${String(error.message || error)}`;
    render();
    return false;
  }
}

async function threadsMediaPermissionReady() {
  if (target?.platform !== 'threads') return true;
  const urls = (state?.items || []).filter(item => item.type === 'image' ? els.includeImages.checked : els.includeVideos.checked).map(item => item.url);
  if (urls.some(url => !url)) { setNotice('ThreadsのメディアURLがありません。再収集してからZIP保存してください', true); return false; }
  const origins = [...new Set(urls.map(url => {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || !/(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(u.hostname)) return null;
      return `${u.origin}/*`;
    } catch { return null; }
  }))];
  if (origins.includes(null) || origins.length > 20) { setNotice('Threadsの配信先が不明です。URLを再取得してください', true); return false; }
  try {
    const pending = [];
    for (const origin of origins) if (!await chrome.permissions.contains({origins:[origin]})) pending.push(origin);
    if (pending.length && !await chrome.permissions.request({origins:pending})) {
      setNotice('Threadsの画像・動画配信先へのアクセス許可が必要です',true);
      return false;
    }
    return true;
  } catch { setNotice('Threadsの配信先へのアクセス許可を確認できません',true); return false; }
}

async function beginCollection(restart) {
  manualFinishFeedback = '';
  if (['bluesky','threads'].includes(target?.platform)) {
    if (!target.apiReady || (target.platform === 'bluesky' && !await bskyPermissionReady())) return;
    const result = await chrome.runtime.sendMessage({
      type:target.platform === 'threads' ? 'SMZ_THREADS_START_COLLECTION' : 'SMZ_BSKY_START_COLLECTION', handle:target.handle, restart
    });
    if (!result?.ok) { target.apiError = result?.error || `${target.platform === 'threads' ? 'Threads' : 'Bluesky'}から収集できませんでした`; }
    else { state = result.state; target.apiError = null; }
    render();
    return;
  }
  setNotice('');
  const result = await chrome.runtime.sendMessage({
    type:'SMZ_START_COLLECTION',
    platform:'x', handle:target.handle, tabId:activeTab.id, restart,
    collectionMode: preferredCollectionMode,
    forceReload: preferredCollectionMode !== 'manual' || state?.status !== 'paused'
  });
  if (!result?.ok) setNotice(result?.error || '収集を開始できませんでした', true);
  else state = result.state;
  render();
}

async function checkNewMedia() {
  if (!target || !activeTab || !canCheckNewMedia()) return;
  setNotice('');
  els.newOnlyBtn.disabled = true;
  if (target.platform === 'bluesky' && !await bskyPermissionReady()) return;
  const result = await chrome.runtime.sendMessage(['bluesky','threads'].includes(target.platform) ? {
    type:target.platform === 'threads' ? 'SMZ_THREADS_START_COLLECTION' : 'SMZ_BSKY_START_COLLECTION', handle:target.handle, newOnly:true
  } : {
    type: 'SMZ_START_COLLECTION', platform: 'x', handle: target.handle,
    tabId: activeTab.id, newOnly: true, collectionMode: preferredCollectionMode,
    forceReload: true
  });
  if (result?.ok) state = result.state;
  render();
  if (!result?.ok) {
    const message = result?.error || '新規分の確認を開始できませんでした';
    const isSafetyGuide = message === '差分確認前に前回のZIP保存を完了してください' ||
      message === '差分チェック前に前回のZIP保存を完了してください';
    setNotice(message, !isSafetyGuide);
  }
}

els.newOnlyBtn.addEventListener('click', checkNewMedia);

els.optionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
els.collectBtn.addEventListener('click', async () => {
  if (!target) return;
  if (!['bluesky','threads'].includes(target?.platform) && state?.status === 'collecting' && state.collectionMode === 'manual') {
    if (manualFinishBusy) return;
    manualFinishBusy = true;
    manualFinishFeedback = '';
    render();
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'SMZ_FINISH_MANUAL_COLLECTION', platform: 'x', handle: target.handle,
        collectionId: state.collectionId, tabId: state.collectionTabId || activeTab?.id
      });
      if (!result?.ok) manualFinishFeedback = result?.error || '手動収集を完了できませんでした';
    } catch (error) {
      manualFinishFeedback = error?.message || '手動収集を完了できませんでした';
    } finally {
      manualFinishBusy = false;
      await refresh();
    }
    return;
  }
  if (state?.status === 'paused') {
    await beginCollection(false);
    return;
  }
  await beginCollection(!state);
});
els.stopCollectBtn.addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage(['bluesky','threads'].includes(target?.platform) ? { type:target.platform === 'threads' ? 'SMZ_THREADS_STOP_COLLECTION' : 'SMZ_BSKY_STOP_COLLECTION',handle:target.handle } : { type:'SMZ_STOP_COLLECTION', platform:'x', handle:target.handle, tabId:activeTab.id });
  if (!result?.ok) setNotice(result?.error || '停止できませんでした', true);
  await refresh();
});
els.restartBtn.addEventListener('click', () => {
  if (!state || archiveIsRunning()) return;
  pendingConfirmation = 'reset';
  render();
});

els.confirmCancelBtn.addEventListener('click', async () => {
  if (pendingConfirmation === 'reset') {
    pendingConfirmation = null;
    render();
    return;
  }

  if (state?.status === 'awaiting_confirmation' && target) {
    const result = await chrome.runtime.sendMessage({
      type:'SMZ_COLLECTION_LARGE_CANCELLED',
      platform:'x',
      handle:target.handle,
      tabId:activeTab?.id
    });
    if (!result?.ok) setNotice(result?.error || '収集をキャンセルできませんでした', true);
    await refresh();
  }
});

els.confirmActionBtn.addEventListener('click', async () => {
  if (pendingConfirmation === 'reset') {
    const returnToPrevious = state?.deltaMode && !Number(state.archive?.savedZipCount || 0);
    const directoryKey = state?.archive?.saveDirectoryKey || state?.preferredSaveDirectoryKey || null;
    const result = await chrome.runtime.sendMessage({
      type: returnToPrevious ? (target?.platform === 'bluesky' ? 'SMZ_BSKY_CANCEL_DELTA' : target?.platform === 'threads' ? 'SMZ_THREADS_CANCEL_DELTA' : 'SMZ_CANCEL_DELTA') : 'SMZ_RESET_COLLECTION', platform:target?.platform || 'x', handle:target.handle
    });
    pendingConfirmation = null;
    if (!result?.ok) {
      setNotice(result?.error || '操作できませんでした', true);
    } else if (!returnToPrevious && directoryKey && globalThis.SMZFileSystem) {
      try { await SMZFileSystem.removeHandle(directoryKey); } catch {}
    }
    await refresh();
    return;
  }

  if (state?.status === 'awaiting_confirmation' && target) {
    const result = await chrome.runtime.sendMessage({
      type:'SMZ_COLLECTION_LARGE_CONFIRMED',
      platform:'x',
      handle:target.handle,
      tabId:activeTab?.id
    });
    if (!result?.ok) setNotice(result?.error || '収集を開始できませんでした', true);
    await refresh();
  }
});

async function startArchive() {
  const split = document.querySelector('input[name="split"]:checked')?.value || 'auto';
  const limitValue = document.querySelector('input[name="downloadLimit"]:checked')?.value || '5';
  const runLimit = limitValue === '5' ? 5 : null;

  const selectedCount = (els.includeImages.checked ? Number(state?.counts?.images || 0) : 0)
    + (els.includeVideos.checked ? Number(state?.counts?.videos || 0) : 0);
  if (!selectedCount) {
    render(); // 権限や保存先を要求する前に、画面内の案内だけ更新する。
    return;
  }
  if (target?.platform === 'bluesky' && !await bskyPermissionReady()) return;
  if (target?.platform === 'threads' && !await threadsMediaPermissionReady()) return;
  const destination = await prepareSaveDestination();
  if (destination.cancelled) {
    setNotice('保存先フォルダの選択をキャンセルしました。');
    return;
  }
  if (destination.fallback) {
    setNotice('フォルダ直接保存を利用できないため、Chrome標準のダウンロード方式で保存します。');
  }

  const result = await chrome.runtime.sendMessage({
    type:'SMZ_START_ARCHIVE',
    platform:target.platform,
    handle:target.handle,
    selection:{ images:els.includeImages.checked, videos:els.includeVideos.checked },
    splitMode:split,
    runLimit,
    saveMode: destination.saveMode,
    saveDirectoryKey: destination.saveDirectoryKey,
    saveDirectoryName: destination.saveDirectoryName
  });
  if (!result?.ok) setNotice(result?.error || 'ZIP作成を開始できませんでした', true);
  await refresh();
}

els.zipBtn.addEventListener('click', startArchive);
els.stopZipBtn.addEventListener('click', async () => {
  if (!archiveIsRunning() || archiveStopPending) return;
  archiveStopPending = true;
  noticeUntil = 0;
  setNotice('');
  render();
  const result = await chrome.runtime.sendMessage({ type:'SMZ_STOP_ARCHIVE' });
  if (!result?.ok) {
    archiveStopPending = false;
    setNotice(result?.error || 'ZIP保存を停止できませんでした', true);
  }
  await refresh();
});
document.querySelectorAll('input[name="collectionMode"]').forEach((input) => {
  input.addEventListener('change', async () => {
    if (input.disabled) return;
    preferredCollectionMode = input.value === 'manual' ? 'manual' : 'auto';
    await saveSettings();
    render();
  });
});

els.includeImages.addEventListener('change', async () => {
  noticeUntil = 0; setNotice('');
  await saveSettings();
  render();
});
els.includeVideos.addEventListener('change', async () => {
  noticeUntil = 0; setNotice('');
  await saveSettings();
  render();
});
document.querySelectorAll('input[name="split"], input[name="downloadLimit"]').forEach((input) => {
  input.addEventListener('change', async () => {
    await saveSettings();
    render();
  });
});

(async () => {
  [activeTab] = await chrome.tabs.query({ active:true, currentWindow:true });
  target = parseTarget(activeTab?.url || '');
  await loadSettings();
  if (['bluesky','threads'].includes(target?.platform)) {
    const result = await chrome.runtime.sendMessage({ type:target.platform === 'threads' ? 'SMZ_THREADS_GET_PROFILE' : 'SMZ_BSKY_GET_PROFILE',actor:target.handle });
    if (result?.ok) { target.handle = result.profile.handle; target.did = result.profile.did; target.pds = result.pds; target.apiReady = true; }
    else target.apiError = result?.error || `${target.platform === 'threads' ? 'Threads' : 'Bluesky'}のプロフィールを取得できません`;
  }
  // 緑の完了チェックは、ユーザーが拡張アイコンを押してポップアップを開いた時点で確認済みにする。
  // ZIP完了そのものの状態は残るので、対象アカウントでは引き続き「ZIP保存完了」を確認できる。
  try { await chrome.runtime.sendMessage({ type:'SMZ_ACK_ARCHIVE_COMPLETE' }); } catch {}
  try { await chrome.runtime.sendMessage({ type:'SMZ_SYNC_TOOLBAR' }); } catch {}
  render();
  await refresh();
  pollTimer = setInterval(refresh, 800);
})();

window.addEventListener('unload', () => {
  if (pollTimer) clearInterval(pollTimer);
});
