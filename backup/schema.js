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
  const itemFields = ['postedAt', 'extension', 'sourceType', 'cid', 'mediaId'];
  const stateStringFields = ['collectionId', 'collectionMode', 'status', 'pauseReason', 'collectionPhase',
    'newestPostId', 'oldestPostId', 'deltaBaselinePostId', 'deltaEndReason', 'resumeCursor'];
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
  function safeCounts(v) {
    if (!plain(v)) return null;
    const images = positiveInt(v.images, -1);
    const videos = positiveInt(v.videos, -1);
    const total = positiveInt(v.total, -1);
    if (images < 0 || videos < 0 || total < 0 || images + videos !== total) return null;
    return { images, videos, total };
  }
  // 差分ZIPは「今回分」だけをitemsに持つ。deltaBaselineCountsに前回までの累計を
  // 持たせることで、最新の差分ZIP 1個だけでも累計件数を復元できる。
  function cumulativeCounts(state) {
    if (!plain(state)) return null;
    const current = safeCounts(state.counts);
    if (!current) return null;
    if (state.deltaMode === true) {
      const base = safeCounts(state.deltaBaselineCounts);
      if (!base) return null;
      return { images: base.images + current.images, videos: base.videos + current.videos, total: base.total + current.total };
    }
    return current;
  }
  function backfillDeltaBaseline(current, previous) {
    if (!current?.deltaMode || safeCounts(current.deltaBaselineCounts)) return current;
    const base = cumulativeCounts(previous);
    if (base) current.deltaBaselineCounts = base;
    return current;
  }
  function safePdsOrigin(input) {
    if (typeof input !== 'string' || input.length > 255) return null;
    try {
      const u = new URL(input);
      if (u.protocol !== 'https:' || u.username || u.password || u.port || u.pathname !== '/' || u.search || u.hash) return null;
      if (!/^[a-z0-9.-]+$/i.test(u.hostname) || u.hostname === 'localhost' ||
          /\.(?:local|localhost|internal|test|invalid)$/.test(u.hostname) ||
          /^(?:0|10|127|169\.254|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./.test(u.hostname)) return null;
      return u.origin;
    } catch { return null; }
  }
  function safeMediaUrl(input, platform = 'x') {
    if (typeof input !== 'string' || input.length > 4096) return null;
    try {
      const url = new URL(input);
      if (url.protocol !== 'https:' || url.username || url.password) return null;
      if (platform === 'threads') {
        if (!/(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(url.hostname.toLowerCase())) return null;
        if (url.port || [...url.searchParams.keys()].some(k => /(?:access.?token|authorization|client.?secret|app.?secret|api.?key|password)/i.test(k))) return null;
        return url.toString(); // CDN signatures are temporary media URLs, never OAuth tokens.
      }
      if (platform === 'bluesky') {
        if (url.hostname.toLowerCase() === 'cdn.bsky.app' && /^\/img\//.test(url.pathname)) {
          return `${url.origin}${url.pathname}`;
        }
        if (url.pathname !== '/xrpc/com.atproto.sync.getBlob' || url.searchParams.size !== 2) return null;
        if (!safePdsOrigin(url.origin) || !/^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.:%_-]+)$/i.test(String(url.searchParams.get('did') || '')) ||
            !/^[a-zA-Z0-9]{20,150}$/.test(String(url.searchParams.get('cid') || ''))) return null;
        const clean = new URL(`${url.origin}${url.pathname}`);
        clean.searchParams.set('did', url.searchParams.get('did'));
        clean.searchParams.set('cid', url.searchParams.get('cid'));
        return clean.toString();
      }
      if (!['pbs.twimg.com','video.twimg.com'].includes(url.hostname.toLowerCase())) return null;
      // 認証付きURLや予期せぬパラメータをバックアップへ持ち込まない。
      const safe = new URL(`${url.origin}${url.pathname}`);
      for (const key of ['format', 'name', 'tag']) {
        const v = url.searchParams.get(key);
        if (v !== null && v.length <= 64 && (key === 'tag' ? /^\d{1,10}$/.test(v) : key === 'format' ? /^(jpg|jpeg|png|webp|avif|gif)$/i.test(v) : /^(orig|large|medium|small|4096x4096|900x900|360x360|240x240)$/i.test(v))) safe.searchParams.set(key, v);
      }
      return safe.toString();
    } catch { return null; }
  }
  function safeItem(v, platform = 'x') {
    if (!plain(v) || (platform === 'x'
      ? !/^\d{1,24}$/.test(String(v.postId || ''))
      : platform === 'threads' ? !/^\d{5,30}$/.test(String(v.postId || '')) : !/^[a-zA-Z0-9._~-]{1,80}$/.test(String(v.postId || '')))) return null;
    const mediaIndex = positiveInt(v.mediaIndex);
    if (mediaIndex < 1 || mediaIndex > 200) return null;
    const type = v.type === 'video' ? 'video' : v.type === 'image' ? 'image' : null;
    if (!type) return null;
    const obj = {
      key: `${v.postId}_${mediaIndex}`, platform, postId: String(v.postId), mediaIndex, type,
      url: safeMediaUrl(v.url, platform) || '',
      fallbackUrls: (Array.isArray(v.fallbackUrls) ? v.fallbackUrls : []).slice(0, 10).map(url => safeMediaUrl(url, platform)).filter(Boolean)
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
    if (!plain(v) || !['x','bluesky','threads'].includes(v.platform)) throw new Error('未対応のアカウント状態です');
    const platform = v.platform;
    const handle = str(v.handle, 253)?.replace(/^@/, '').toLowerCase();
    if (!handle || (platform === 'x' ? !/^[a-z0-9_]{1,30}$/.test(handle) : platform === 'threads' ? !/^[a-z0-9_](?:[a-z0-9._]{0,28}[a-z0-9_])?$/.test(handle) || handle.includes('..') :
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(handle))) throw new Error('アカウント名が不正です');
    if (platform === 'bluesky' && !/^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.:%_-]+)$/i.test(String(v.did || ''))) {
      throw new Error('BlueskyのDIDが不正です');
    }
    if (!Array.isArray(v.items) || v.items.length > MAX_ITEMS) throw new Error('収集件数が上限を超えています');
    const items = v.items.map(item => safeItem(item, platform));
    if (items.some((item) => !item)) throw new Error('メディア情報の形式が不正です');
    if (new Set(items.map((item) => item.key)).size !== items.length) throw new Error('同じメディアが状態ファイル内で重複しています');
    const out = { platform, handle, items, counts: {
      images: items.filter((x) => x.type === 'image').length,
      videos: items.filter((x) => x.type === 'video').length,
      total: items.length
    } };
    if (platform === 'threads') out.ownProfile = v.ownProfile === true;
    if (platform === 'bluesky') { out.did = v.did; out.pds = safePdsOrigin(v.pds); }
    for (const f of stateStringFields) { const s = str(v[f], 300); if (s !== null) out[f] = s; }
    for (const f of stateNumFields) { const n = num(v[f]); if (n !== null) out[f] = n; }
    for (const f of ['deltaMode','deltaBoundaryReached','deltaVerified','lastNewCheckVerified']) {
      if (typeof v[f] === 'boolean') out[f] = v[f];
    }
    out.deltaOlderPostIds = (Array.isArray(v.deltaOlderPostIds) ? v.deltaOlderPostIds : [])
      .filter((id) => platform === 'x' ? /^\d{1,24}$/.test(String(id)) : platform === 'threads' ? /^\d{5,30}$/.test(String(id)) : /^[a-zA-Z0-9._~-]{1,80}$/.test(String(id))).slice(0, 6).map(String);
    for (const f of ['deltaSavedKinds','savedKinds']) {
      out[f] = { images: v[f]?.images === true, videos: v[f]?.videos === true };
    }
    const baselineCounts = safeCounts(v.deltaBaselineCounts);
    if (baselineCounts) out.deltaBaselineCounts = baselineCounts;
    out.archive = safeArchive(v.archive);
    if (out.archive?.status === 'archive_complete' &&
        Number(out.archive.nextItemIndex || 0) < Number(out.archive.totalSelected || 0)) {
      out.archive.status = 'archive_paused';
      out.archive.pauseReason = 'imported_incomplete';
    }
    // v1.3.0初期テスト版は、最終ZIPに取得失敗が1件でもあると safeCollection() が
    // archive_complete を imported_incomplete へ誤変換していた。全件処理済み・完了時刻ありなら
    // 旧ZIPも完了状態へ戻し、復元直後に不要な「ZIP保存を再開」を出さない。
    if (out.archive?.status === 'archive_paused' && out.archive.pauseReason === 'imported_incomplete' &&
        Number(out.archive.totalSelected || 0) > 0 &&
        Number(out.archive.nextItemIndex || 0) >= Number(out.archive.totalSelected || 0) &&
        Number(out.archive.completedAt || 0) > 0) {
      out.archive.status = 'archive_complete';
      out.archive.pauseReason = null;
    }
    // 取得失敗は完了ステータスと併存できる。失敗項目は failures / failedItems で通知する。
    // archive_complete かつ末尾まで処理済みなら、失敗件数が残っていても選択した種別は
    // 「保存処理完了」として扱う。これにより1件の取得失敗で次回差分が永久に塞がれない。
    if (out.archive?.status === 'archive_complete' &&
        Number(out.archive.nextItemIndex ?? out.archive.processedItems ?? 0) >= Number(out.archive.totalSelected || 0)) {
      const sel = out.archive.selection || {};
      if (sel.images) out.savedKinds.images = true;
      if (sel.videos) out.savedKinds.videos = true;
    }
    out.collectionMode = ['bluesky','threads'].includes(platform) ? 'api' : out.collectionMode === 'manual' ? 'manual' : 'auto';
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
      collectionMode: v?.collectionMode === 'auto' ? 'auto' : 'manual',
      xSplitMedia: v?.xSplitMedia !== false,
      xRevertProfileTabs: v?.xRevertProfileTabs === true
    };
  }
  function accountEnvelope(current, previous = null, source = {}) {
    const safePrevious = previous ? safeCollection(previous) : null;
    const safeCurrent = backfillDeltaBaseline(safeCollection(current), safePrevious);
    return {
      format: ACCOUNT_FORMAT, version: VERSION, exportedAt: new Date().toISOString(),
      source: { zipNumber: positiveInt(source.zipNumber), mediaKind: ['media','images','videos'].includes(source.mediaKind) ? source.mediaKind : null },
      account: safeCurrent, previous: safePrevious
    };
  }
  function fullEnvelope(storage) {
    const keys = Object.keys(storage || {});
    const handles = new Set();
    for (const key of keys) {
      const found = /^smz_(?:previous_)?collection_(x|bluesky|threads)_(.+)$/.exec(key);
      if (found) handles.add(`${found[1]}_${found[2]}`);
    }
    if (handles.size > MAX_ACCOUNTS) throw new Error('アカウント数が上限を超えています');
    const accounts = [];
    for (const key of [...handles].sort()) {
      const sep = key.indexOf('_');
      const platform = key.slice(0,sep); const handle = key.slice(sep+1);
      const current = storage[`smz_collection_${platform}_${handle}`] || null;
      const previous = storage[`smz_previous_collection_${platform}_${handle}`] || null;
      if (!current) continue;
      const safePrevious = previous ? safeCollection(previous) : null;
      accounts.push({ current: backfillDeltaBaseline(safeCollection(current), safePrevious), previous: safePrevious });
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
      let current = safeCollection(item.current);
      const previous = item.previous ? safeCollection(item.previous) : null;
      if (previous && (previous.handle !== current.handle || previous.platform !== current.platform)) throw new Error('前回データのアカウントが一致しません');
      current = backfillDeltaBaseline(current, previous);
      return { format: ACCOUNT_FORMAT, version: VERSION,
        source: { zipNumber: positiveInt(input.source?.zipNumber),
          mediaKind: ['media','images','videos'].includes(input.source?.mediaKind) ? input.source.mediaKind : null },
        accounts: [{ current, previous }], settings: null, exportedAt: str(input.exportedAt, 50) };
    }
    if (input.format !== FULL_FORMAT || !Array.isArray(input.accounts) || input.accounts.length > MAX_ACCOUNTS) {
      throw new Error('シンプルまるごとZIPのバックアップではありません');
    }
    const accounts = input.accounts.map((entry) => {
      let current = safeCollection(entry.current);
      const previous = entry.previous ? safeCollection(entry.previous) : null;
      if (previous && (previous.handle !== current.handle || previous.platform !== current.platform)) throw new Error('前回データのアカウントが一致しません');
      current = backfillDeltaBaseline(current, previous);
      return { current, previous };
    });
    if (new Set(accounts.map((v) => `${v.current.platform}:${v.current.handle}`)).size !== accounts.length) throw new Error('同じアカウントが重複しています');
    return { format: FULL_FORMAT, version: VERSION, accounts, partial: input.partial === true,
      settings: input.partial === true ? null : safeSettings(input.settings), exportedAt: str(input.exportedAt, 50) };
  }
  function parseJson(text) {
    if (typeof text !== 'string' || text.length > MAX_JSON_CHARS) throw new Error('JSONファイルが大きすぎます');
    return normalizeImport(JSON.parse(text));
  }
  globalThis.SMZBackup = Object.freeze({ ACCOUNT_FORMAT, FULL_FORMAT, VERSION, safeCollection, cumulativeCounts,
    safeSettings, accountEnvelope, fullEnvelope, normalizeImport, parseJson });
})();
