'use strict';
// v1: 明示的な許可リストで必要な収集状態だけを書き出す。
// 新しいProviderの認証設定、Cookie、任意のストレージキーは自動的に含まれない。
(() => {
  const ACCOUNT_FORMAT = 'simple-marugoto-zip-account-state';
  const FULL_FORMAT = 'simple-marugoto-zip-full-backup';
  const VERSION = 1;
  const MAX_ITEMS = 120000;
  const MAX_ACCOUNTS = 1000;
  const MAX_JSON_CHARS = 128 * 1024 * 1024;
  const itemFields = ['postedAt', 'extension', 'sourceType'];
  const stateStringFields = ['collectionId', 'collectionMode', 'status', 'pauseReason', 'collectionPhase',
    'newestPostId', 'oldestPostId', 'deltaBaselinePostId', 'deltaEndReason'];
  const stateNumFields = ['schemaVersion', 'startedAt', 'updatedAt', 'completedAt', 'displayMediaCount',
    'deltaBaselineCollectedAt', 'lastNewCheckAt', 'lastNewCheckResult'];
  const archiveStringFields = ['status','splitMode','mediaKind','saveMode',
    'collectionId','pauseReason'];
  const archiveNumFields = ['runLimit','collectionCompletedAt','nextItemIndex','nextZipNumber',
    'savedZipCount','processedItems','failedItems','totalSelected','currentZipNumber',
    'startedAt','updatedAt','completedAt'];
  function plain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function str(v, len = 300) { return typeof v === 'string' ? v.slice(0, len) : null; }
  function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
  function positiveInt(v, fallback = 0) {
    return Number.isSafeInteger(v) && v >= 0 ? v : fallback;
  }
  function safeMediaUrl(input) {
    if (typeof input !== 'string' || input.length > 4096) return null;
    try {
      const url = new URL(input);
      if (url.protocol !== 'https:' || !['pbs.twimg.com','video.twimg.com'].includes(url.hostname.toLowerCase())) return null;
      // 認証付きURLや予期せぬパラメータをバックアップへ持ち込まない。
      const safe = new URL(`${url.origin}${url.pathname}`);
      for (const key of ['format', 'name', 'tag']) {
        const v = url.searchParams.get(key);
        if (v !== null && v.length <= 64 && (key === 'tag' ? /^\d{1,10}$/.test(v) : key === 'format' ? /^(jpg|jpeg|png|webp|avif|gif)$/i.test(v) : /^(orig|large|medium|small|4096x4096|900x900|360x360|240x240)$/i.test(v))) safe.searchParams.set(key, v);
      }
      return safe.toString();
    } catch { return null; }
  }
  function safeItem(v) {
    if (!plain(v) || !/^\d{1,24}$/.test(String(v.postId || ''))) return null;
    const mediaIndex = positiveInt(v.mediaIndex);
    if (mediaIndex < 1 || mediaIndex > 200) return null;
    const type = v.type === 'video' ? 'video' : v.type === 'image' ? 'image' : null;
    if (!type) return null;
    const obj = {
      key: `${v.postId}_${mediaIndex}`, platform: 'x', postId: String(v.postId), mediaIndex, type,
      url: safeMediaUrl(v.url) || '',
      fallbackUrls: (Array.isArray(v.fallbackUrls) ? v.fallbackUrls : []).slice(0, 10).map(safeMediaUrl).filter(Boolean)
    };
    for (const f of itemFields) { const s = str(v[f], 100); if (s !== null) obj[f] = s; }
    for (const f of ['width','height','bitrate']) { const n = num(v[f]); if (n !== null) obj[f] = n; }
    return obj;
  }
  function safeArchive(v) {
    if (!plain(v)) return null;
    const out = {};
    for (const f of archiveStringFields) { const s = str(v[f], 300); if (s !== null) out[f] = s; }
    for (const f of archiveNumFields) { const n = num(v[f]); if (n !== null) out[f] = n; }
    out.selection = { images: v.selection?.images === true, videos: v.selection?.videos === true };
    out.failures = (Array.isArray(v.failures) ? v.failures : []).slice(-100)
      .filter(plain).map((x) => ({ key: str(x.key, 80) || '', error: '取得に失敗' }));
    out.completionAcknowledged = v.completionAcknowledged !== false;
    // 保存先の名前もプライバシー上持ち出さない。別PCでは必ず再選択する。
    out.saveDirectoryKey = null;
    if (out.status === 'archiving' || out.status === 'archive_error') {
      out.status = 'archive_paused';
      out.pauseReason = 'imported';
    }
    out.currentFileCount = 0;
    out.progress = out.totalSelected ? Math.min(1, out.nextItemIndex / out.totalSelected) : 0;
    return out;
  }
  function safeCollection(v) {
    if (!plain(v) || v.platform !== 'x') throw new Error('未対応のアカウント状態です');
    const handle = str(v.handle, 50)?.replace(/^@/, '').toLowerCase();
    if (!handle || !/^[a-z0-9_]{1,30}$/.test(handle)) throw new Error('アカウント名が不正です');
    if (!Array.isArray(v.items) || v.items.length > MAX_ITEMS) throw new Error('収集件数が上限を超えています');
    const items = v.items.map(safeItem);
    if (items.some((item) => !item)) throw new Error('メディア情報の形式が不正です');
    if (new Set(items.map((item) => item.key)).size !== items.length) throw new Error('同じメディアが状態ファイル内で重複しています');
    const out = { platform: 'x', handle, items, counts: {
      images: items.filter((x) => x.type === 'image').length,
      videos: items.filter((x) => x.type === 'video').length,
      total: items.length
    } };
    for (const f of stateStringFields) { const s = str(v[f], 300); if (s !== null) out[f] = s; }
    for (const f of stateNumFields) { const n = num(v[f]); if (n !== null) out[f] = n; }
    for (const f of ['deltaMode','deltaBoundaryReached','deltaVerified','lastNewCheckVerified']) {
      if (typeof v[f] === 'boolean') out[f] = v[f];
    }
    out.deltaOlderPostIds = (Array.isArray(v.deltaOlderPostIds) ? v.deltaOlderPostIds : [])
      .filter((id) => /^\d{1,24}$/.test(String(id))).slice(0, 6).map(String);
    for (const f of ['deltaSavedKinds','savedKinds']) {
      out[f] = { images: v[f]?.images === true, videos: v[f]?.videos === true };
    }
    out.archive = safeArchive(v.archive);
    if (out.archive?.status === 'archive_complete' &&
        (Number(out.archive.failedItems || 0) > 0 ||
          Number(out.archive.nextItemIndex || 0) < Number(out.archive.totalSelected || 0))) {
      out.archive.status = 'archive_paused';
      out.archive.pauseReason = 'imported_incomplete';
    }
    // 過去データが両方保存済みと分かる場合のみ復元候補として補完する。
    if (!v.savedKinds && out.archive?.status === 'archive_complete' && !out.archive.failedItems) {
      const sel = out.archive.selection;
      if (Number(out.archive.nextItemIndex) >= Number(out.archive.totalSelected)) {
        if (sel.images) out.savedKinds.images = true;
        if (sel.videos) out.savedKinds.videos = true;
      }
    }
    out.collectionMode = out.collectionMode === 'manual' ? 'manual' : 'auto';
    out.status = out.status === 'complete' ? 'complete' : 'paused';
    out.pauseReason = out.status === 'paused' ? 'imported' : null;
    out.collectionPhase = null;
    out.collectionTabId = null;
    out.confirmationTabId = null;
    out.rateLimitSimulated = false;
    out.resumeAt = null;
    out.largeWarningConfirmed = v.largeWarningConfirmed === true;
    out.preferredSaveDirectoryKey = null;
    out.preferredSaveDirectoryName = null;
    out.lastError = null;
    // 引き継いだメディアがURL許可リスト外なら、再取得が必要なことを示す。
    out.mediaUrlsMissing = items.some((item) => !item.url);
    if (out.archive) {
      out.archive.saveDirectoryKey = null;
      out.archive.saveDirectoryName = null;
      out.archive.completionAcknowledged = true;
    }
    return out;
  }
  function safeSettings(v) {
    return {
      includeImages: v?.includeImages !== false,
      includeVideos: v?.includeVideos !== false,
      splitMode: ['auto','500mb','1gb','10files','500files'].includes(v?.splitMode) ? v.splitMode : 'auto',
      downloadLimit: v?.downloadLimit === 'all' ? 'all' : '5',
      // 新規環境・モード未指定の古い設定は現在の初期値「手動」に揃える。
      // 明示的に「自動」を選んだユーザーの保存設定は変更しない。
      collectionMode: v?.collectionMode === 'auto' ? 'auto' : 'manual'
    };
  }
  function accountEnvelope(current, previous = null, source = {}) {
    return {
      format: ACCOUNT_FORMAT, version: VERSION, exportedAt: new Date().toISOString(),
      source: { zipNumber: positiveInt(source.zipNumber), mediaKind: ['media','images','videos'].includes(source.mediaKind) ? source.mediaKind : null },
      account: safeCollection(current), previous: previous ? safeCollection(previous) : null
    };
  }
  function fullEnvelope(storage) {
    const keys = Object.keys(storage || {});
    const handles = new Set();
    for (const key of keys) {
      const found = /^smz_(?:previous_)?collection_x_([a-z0-9_]{1,30})$/.exec(key);
      if (found) handles.add(found[1]);
    }
    if (handles.size > MAX_ACCOUNTS) throw new Error('アカウント数が上限を超えています');
    const accounts = [];
    for (const handle of [...handles].sort()) {
      const current = storage[`smz_collection_x_${handle}`] || null;
      const previous = storage[`smz_previous_collection_x_${handle}`] || null;
      if (!current) continue;
      accounts.push({ current: safeCollection(current), previous: previous ? safeCollection(previous) : null });
    }
    return { format: FULL_FORMAT, version: VERSION, exportedAt: new Date().toISOString(),
      settings: safeSettings(storage?.smz_user_settings_v1), accounts };
  }
  function normalizeImport(input) {
    if (!plain(input) || input.version !== VERSION) throw new Error('対応していないバックアップ形式・バージョンです');
    if (input.format === ACCOUNT_FORMAT) {
      // 設定画面が事前解析した正規化済みデータも、背景側で再検証する。
      const item = input.account ? { current: input.account, previous: input.previous } :
        Array.isArray(input.accounts) && input.accounts.length === 1 ? input.accounts[0] : null;
      if (!item) throw new Error('アカウント別ZIPの形式が不正です');
      const current = safeCollection(item.current);
      const previous = item.previous ? safeCollection(item.previous) : null;
      if (previous && previous.handle !== current.handle) throw new Error('前回データのアカウントが一致しません');
      return { format: ACCOUNT_FORMAT, version: VERSION,
        source: { zipNumber: positiveInt(input.source?.zipNumber),
          mediaKind: ['media','images','videos'].includes(input.source?.mediaKind) ? input.source.mediaKind : null },
        accounts: [{ current, previous }], settings: null, exportedAt: str(input.exportedAt, 50) };
    }
    if (input.format !== FULL_FORMAT || !Array.isArray(input.accounts) || input.accounts.length > MAX_ACCOUNTS) {
      throw new Error('シンプルまるごとZIPのバックアップではありません');
    }
    const accounts = input.accounts.map((entry) => {
      const current = safeCollection(entry.current);
      const previous = entry.previous ? safeCollection(entry.previous) : null;
      if (previous && previous.handle !== current.handle) throw new Error('前回データのアカウントが一致しません');
      return { current, previous };
    });
    if (new Set(accounts.map((v) => v.current.handle)).size !== accounts.length) throw new Error('同じアカウントが重複しています');
    return { format: FULL_FORMAT, version: VERSION, accounts,
      settings: safeSettings(input.settings), exportedAt: str(input.exportedAt, 50) };
  }
  function parseJson(text) {
    if (typeof text !== 'string' || text.length > MAX_JSON_CHARS) throw new Error('JSONファイルが大きすぎます');
    return normalizeImport(JSON.parse(text));
  }
  globalThis.SMZBackup = Object.freeze({ ACCOUNT_FORMAT, FULL_FORMAT, VERSION, safeCollection,
    safeSettings, accountEnvelope, fullEnvelope, normalizeImport, parseJson });
})();
