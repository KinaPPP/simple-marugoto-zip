if (!globalThis.SMZBackup) importScripts('backup/schema.js');
if (!globalThis.SMZBluesky && typeof importScripts === 'function') importScripts('providers/bluesky/api.js');
if (!globalThis.SMZThreads && typeof importScripts === 'function') importScripts('providers/threads/api.js');
const COLLECTION_PREFIX = 'smz_collection_';
const PREVIOUS_COLLECTION_PREFIX = 'smz_previous_collection_';
const RESUME_ALARM_PREFIX = 'smz_resume_';
const collectionQueues = new Map();
const blueskyJobs = new Map();
const threadsJobs = new Map();
let archiveStartQueue = Promise.resolve();
const THREADS_AUTH_KEY = 'smz_threads_auth_v1'; // excluded from ALL backup formats
const THREADS_ALARM = 'smz_threads_token_refresh';
const API_COLLECTION_WATCHDOG_ALARM = 'smz_api_collection_watchdog';
let apiRecoveryPromise = Promise.resolve();
let fullResetInProgress = false;

// Blob URLの仮ファイル名(UUID)に負けないよう、拡張自身のZIPだけ
// onDeterminingFilenameでも明示的に保存名を提案する。
// 他の拡張が同イベントを使う環境では downloads.download() の filename が
// 無視されることがあるため、その回避策も兼ねる。
const pendingDownloadNames = new Map();

const TOOLBAR_ICONS = {
  blue: {
    16: 'icons/icon16.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png'
  },
  green: {
    16: 'icons/icon16-green.png',
    48: 'icons/icon48-green.png',
    128: 'icons/icon128-green.png'
  }
};

const TOOLBAR_COLORS = {
  blue: '#4a8ce0',
  green: '#28a745',
  yellow: '#d99b16',
  red: '#dc2626',
  gray: '#777777'
};

let lastToolbarState = { icon: null, badge: null, badgeColor: null, title: null };
let toolbarUpdateQueue = Promise.resolve();

function toolbarSnapshot(state) {
  if (!state) return null;
  return {
    handle: state.handle || '',
    platform: state.platform || 'x',
    status: state.status || null,
    collectionMode: state.collectionMode || 'auto',
    collectionPhase: state.collectionPhase || null,
    rateLimitSimulated: state.rateLimitSimulated === true,
    pauseReason: state.pauseReason || null,
    resumeAt: Number(state.resumeAt || 0),
    updatedAt: Number(state.updatedAt || 0),
    counts: { total: Number(state.counts?.total || 0) },
    archive: state.archive ? {
      status: state.archive.status || null,
      progress: Number(state.archive.progress || 0),
      processedItems: Number(state.archive.processedItems || 0),
      totalSelected: Number(state.archive.totalSelected || 0),
      savedZipCount: Number(state.archive.savedZipCount || 0),
      saveDirectoryName: state.archive.saveDirectoryName || null,
      completionAcknowledged: state.archive.completionAcknowledged !== false,
      updatedAt: Number(state.archive.updatedAt || 0),
      lastError: state.archive.lastError || null
    } : null
  };
}

function scheduleToolbarState(state) {
  const snapshot = toolbarSnapshot(state);
  toolbarUpdateQueue = toolbarUpdateQueue
    .catch(() => {})
    .then(() => applyToolbarState(snapshot));
  return toolbarUpdateQueue;
}

function formatToolbarCount(value) {
  return Number(value || 0).toLocaleString('ja-JP');
}

async function applyToolbarState(state) {
  const archive = state?.archive || null;
  let icon = 'blue';
  let badge = '';
  let badgeColor = TOOLBAR_COLORS.blue;
  let title = 'シンプルまるごとZIP';

  if (archive?.status === 'archiving') {
    icon = 'green';
    const rawPercent = Math.max(0, Math.min(99, Math.round((archive.progress || 0) * 100)));
    const titleBucket = Math.min(90, Math.floor(rawPercent / 10) * 10);
    // バッジは1%単位で更新。%記号は付けず、2桁までにして小さいアイコンでも見切れにくくする。
    badge = String(rawPercent);
    badgeColor = TOOLBAR_COLORS.green;
    if (Number(archive.totalSelected || 0) > 0) {
      title = `シンプルまるごとZIP\nZIP保存中 ${titleBucket}%台\n${formatToolbarCount(archive.processedItems)} / ${formatToolbarCount(archive.totalSelected)}ファイル`;
    } else {
      title = 'シンプルまるごとZIP\nZIP保存を開始しています…';
    }
  } else if (archive?.status === 'archive_complete' && archive.completionAcknowledged === false) {
    // 完了通知は一瞬で消さず、ユーザーがポップアップを開いて確認するまで保持する。
    // 100の3桁表示は避け、完了だけチェックマークで知らせる。
    icon = 'green';
    badge = '✓';
    badgeColor = TOOLBAR_COLORS.green;
    const zipCount = Number(archive.savedZipCount || 0);
    const savedTo = archive.saveDirectoryName ? `\n保存先: ${archive.saveDirectoryName}` : '';
    title = `シンプルまるごとZIP\nZIP保存完了\n${formatToolbarCount(archive.processedItems)}ファイル / ${formatToolbarCount(zipCount)}個のZIP${savedTo}`;
  } else if (state?.status === 'awaiting_confirmation') {
    badge = '確';
    badgeColor = TOOLBAR_COLORS.yellow;
    title = `シンプルまるごとZIP\n大量件数の確認待ち @${state.handle || ''}\nクリックして確認`;
  } else if (state?.status === 'rate_limited' || (['bluesky','threads'].includes(state?.platform) && state?.status === 'paused' && state?.pauseReason === 'rate_limit')) {
    badge = '待';
    badgeColor = TOOLBAR_COLORS.yellow;
    title = state.rateLimitSimulated
      ? `シンプルまるごとZIP\n疑似429テストで待機中（Xからの実際の429ではありません）\n@${state.handle || ''}`
      : `シンプルまるごとZIP\n${state.platform === 'bluesky' ? 'Bluesky' : state.platform === 'threads' ? 'Threads' : 'X'}のアクセス制限により停止中\n@${state.handle || ''}${['bluesky','threads'].includes(state.platform) ? '\n時間を置いて手動で再開' : ''}`;
  } else if (state?.status === 'collecting') {
    badge = '収';
    badgeColor = TOOLBAR_COLORS.blue;
    title = state.platform === 'threads' ? `シンプルまるごとZIP\nThreads API収集中 @${state.handle || ''}\n${formatToolbarCount(state.counts?.total)}件取得` : state.platform === 'bluesky' ? `シンプルまるごとZIP\nBluesky API収集中 @${state.handle || ''}\n${formatToolbarCount(state.counts?.total)}件取得` : state.collectionMode === 'manual'
      ? `シンプルまるごとZIP\n手動スクロールで収集中 @${state.handle || ''}\nXの /media をスクロール。完了はポップアップで操作`
      : `シンプルまるごとZIP\n${state.collectionPhase === 'final_check' ? '収集の最終確認中' : 'メディア収集中'} @${state.handle || ''}\n詳細はクリックして確認`;
  } else if (archive?.status === 'archive_error') {
    badge = '!';
    badgeColor = TOOLBAR_COLORS.red;
    title = `シンプルまるごとZIP\nZIP保存エラー\n${archive.lastError || '詳細はポップアップで確認してください'}`;
  }

  if (icon !== lastToolbarState.icon) {
    await chrome.action.setIcon({ path: TOOLBAR_ICONS[icon] });
    lastToolbarState.icon = icon;
  }
  if (badge !== lastToolbarState.badge) {
    await chrome.action.setBadgeText({ text: badge });
    lastToolbarState.badge = badge;
  }
  if (badge && badgeColor !== lastToolbarState.badgeColor) {
    await chrome.action.setBadgeBackgroundColor({ color: badgeColor });
    try { await chrome.action.setBadgeTextColor({ color: '#ffffff' }); } catch {}
    lastToolbarState.badgeColor = badgeColor;
  }
  if (!badge) lastToolbarState.badgeColor = null;
  if (title !== lastToolbarState.title) {
    await chrome.action.setTitle({ title });
    lastToolbarState.title = title;
  }

}

async function getOffscreenRuntimeStatus() {
  try {
    if (!chrome.offscreen?.hasDocument || !await chrome.offscreen.hasDocument()) return { active: false, handle: null };
    const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'SMZ_OFFSCREEN_GET_STATUS' });
    return result && typeof result === 'object' ? result : { active: false, handle: null };
  } catch {
    return { active: false, handle: null };
  }
}

async function reconcileStaleArchiveStates() {
  const runtime = await getOffscreenRuntimeStatus();
  const all = await chrome.storage.local.get(null);
  const updates = {};
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(COLLECTION_PREFIX) || !value || typeof value !== 'object') continue;

    // 旧β版で0件選択のまま保存を始めた場合の永続エラーを取り除く。
    // 保存済みZIPのチェックポイントがあれば破棄せず、単に一時停止へ戻す。
    if (value.archive?.status === 'archive_error' &&
        value.archive?.lastError === '選択されたメディアがありません') {
      if (Number(value.archive.savedZipCount || 0) > 0) {
        value.archive = { ...value.archive, status: 'archive_paused', pauseReason: 'empty_selection',
          lastError: null, currentFileCount: 0, updatedAt: Date.now() };
      } else {
        value.archive = null;
      }
      value.updatedAt = Date.now();
      updates[key] = value;
      continue;
    }

    // v0.0.7以前に USER_CANCELED が archive_error として残ったデータを安全な一時停止へ移行する。
    if (value.archive?.status === 'archive_error' && /USER_CANCELED|USER_CANCELLED/i.test(String(value.archive?.lastError || ''))) {
      value.archive = {
        ...value.archive,
        status: 'archive_paused',
        pauseReason: 'user_cancelled',
        lastError: null,
        updatedAt: Date.now()
      };
      value.updatedAt = Date.now();
      updates[key] = value;
      continue;
    }

    // API収集(Bluesky/Threads)はページ単位のチェックポイントから別処理で自動復旧する。
    // ここで paused にすると、Service Worker再起動直後の復旧対象を失うため変更しない。
    if (value.archive?.status !== 'archiving') continue;
    const sameActiveJob = runtime.active && (runtime.platform || 'x') === (value.platform || 'x') && normalizeHandle(runtime.handle) === normalizeHandle(value.handle);
    if (sameActiveJob) continue;
    value.archive = {
      ...value.archive,
      status: 'archive_paused',
      pauseReason: 'runtime_interrupted',
      lastError: null,
      updatedAt: Date.now()
    };
    value.updatedAt = Date.now();
    updates[key] = value;
  }
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
}

async function restoreToolbarState() {
  await reconcileStaleArchiveStates();
  const all = await chrome.storage.local.get(null);
  const states = Object.entries(all)
    .filter(([key, value]) => key.startsWith(COLLECTION_PREFIX) && value && typeof value === 'object')
    .map(([, value]) => value);

  let activeTab = null;
  try {
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {}
  const activeHandle = xHandleFromUrl(activeTab?.url || '') || blueskyHandleFromUrl(activeTab?.url || '');
  const confirmationMatchesActivePage = (state) => {
    if (state?.status !== 'awaiting_confirmation') return false;
    // 黄色い「確」は、現在表示しているXアカウントが確認対象と一致する時だけ表示する。
    // 同じアカウントを別タブで開いた場合でも確認できるが、別アカウントへは持ち込まない。
    return !!activeHandle && activeHandle === normalizeHandle(state.handle);
  };

  const priority = (state) => {
    if (state?.archive?.status === 'archiving') return 110;
    if (state?.status === 'rate_limited' || (state?.platform === 'bluesky' && state?.status === 'paused' && state?.pauseReason === 'rate_limit')) return 105;
    if (state?.status === 'collecting') return 100;
    if (state?.archive?.status === 'archive_complete' && state.archive.completionAcknowledged === false) return 95;
    if (state?.status === 'awaiting_confirmation') return confirmationMatchesActivePage(state) ? 85 : 0;
    // 過去のエラーや確認済みの完了状態は待機中ツールバーへ持ち越さない。
    return 0;
  };

  states.sort((a, b) => {
    const diff = priority(b) - priority(a);
    if (diff) return diff;
    return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
  });

  const selected = states.find((state) => priority(state) > 0) || null;
  await scheduleToolbarState(selected);
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const wanted = pendingDownloadNames.get(item.url) || pendingDownloadNames.get(item.finalUrl);
  if (wanted) {
    pendingDownloadNames.delete(item.url);
    if (item.finalUrl) pendingDownloadNames.delete(item.finalUrl);
    suggest({ filename: wanted, conflictAction: 'uniquify' });
    return;
  }
  suggest();
});

function normalizeHandle(handle) {
  return String(handle || '').replace(/^@/, '').trim().toLowerCase();
}

function xHandleFromUrl(urlString) {
  try {
    const url = new URL(urlString || '');
    const host = url.hostname.toLowerCase();
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host)) return null;
    const part = url.pathname.split('/').filter(Boolean)[0];
    if (!part) return null;
    const reserved = new Set(['home','explore','search','notifications','messages','i','settings','compose','login','logout','signup','tos','privacy','jobs','intent','share','hashtag','account','download','about']);
    const handle = normalizeHandle(part);
    return handle && !reserved.has(handle) ? handle : null;
  } catch {
    return null;
  }
}

function blueskyHandleFromUrl(urlString) {
  try {
    const u = new URL(urlString || '');
    if (!['bsky.app', 'www.bsky.app'].includes(u.hostname.toLowerCase())) return null;
    const match = /^\/profile\/([^/?#]+)/.exec(u.pathname);
    const actor = match ? decodeURIComponent(match[1]).replace(/^@/, '').toLowerCase() : null;
    return SMZBluesky.validActor(actor) ? actor : null;
  } catch { return null; }
}

function archiveMediaKind(selection) {
  const images = selection?.images !== false;
  const videos = selection?.videos !== false;
  if (images && videos) return 'media';
  if (images) return 'images';
  if (videos) return 'videos';
  return 'media';
}

function selectedArchiveItemKeys(state, selection) {
  return (Array.isArray(state?.items) ? state.items : [])
    .filter(item => (item.type === 'image' && selection?.images) || (item.type === 'video' && selection?.videos))
    .map(item => item.key)
    .filter(key => typeof key === 'string' && key);
}

function markAddedItemsUnsaved(state, addedItems) {
  if (!state || !Array.isArray(addedItems) || !addedItems.length) return;
  const hasImage = addedItems.some(item => item?.type === 'image');
  const hasVideo = addedItems.some(item => item?.type === 'video');
  if (!hasImage && !hasVideo) return;
  state.savedKinds = { ...(state.savedKinds || {}) };
  if (hasImage) state.savedKinds.images = false;
  if (hasVideo) state.savedKinds.videos = false;
  if (state.deltaMode) {
    state.deltaSavedKinds = { ...(state.deltaSavedKinds || {}) };
    if (hasImage) state.deltaSavedKinds.images = false;
    if (hasVideo) state.deltaSavedKinds.videos = false;
  }
}

function archiveCoversCurrentCollection(state) {
  if (!state || !archiveReachedEnd(state)) return false;
  const archive = state.archive;
  const collectionCompletedAt = Number(state.completedAt || 0);
  const archivedCollectionCompletedAt = Number(archive?.collectionCompletedAt || 0);
  // A collection completed again after the archive snapshot: media may have been added.
  if (collectionCompletedAt && archivedCollectionCompletedAt && collectionCompletedAt !== archivedCollectionCompletedAt) return false;

  const selectedKeys = selectedArchiveItemKeys(state, archive?.selection || {});
  if (Array.isArray(archive?.itemKeys)) {
    const frozen = new Set(archive.itemKeys.filter(key => typeof key === 'string' && key));
    if (!selectedKeys.every(key => frozen.has(key))) return false;
  } else if (Number(archive?.totalSelected || 0) !== selectedKeys.length) {
    // Legacy checkpoints without itemKeys are trustworthy only when the selected count
    // still exactly matches the completed archive. Never guess an old array order.
    return false;
  }
  return true;
}

function migrateTrustedLegacySavedItemKeys(state) {
  if (!state || Array.isArray(state.savedItemKeys)) return false;
  const archive = state.archive;
  if (!archiveReachedEnd(state) || !Array.isArray(archive?.itemKeys) || !archive.itemKeys.length) return false;

  // Older states may know exactly which keys a completed ZIP job processed even though
  // savedItemKeys did not exist yet. Preserve only those explicit keys; never infer keys
  // from savedKinds or from the current items order. This keeps legacy kind-by-kind saves
  // usable without reviving the old index/order ambiguity.
  const validCurrentKeys = new Set((Array.isArray(state.items) ? state.items : [])
    .map(item => item?.key)
    .filter(key => typeof key === 'string' && key));
  const processed = Math.max(0, Math.min(
    Number(archive.nextItemIndex ?? archive.processedItems ?? 0),
    Number(archive.totalSelected || 0),
    archive.itemKeys.length
  ));
  const migrated = [];
  const seen = new Set();
  for (const key of archive.itemKeys.slice(0, processed)) {
    if (typeof key !== 'string' || !key || !validCurrentKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    migrated.push(key);
  }
  if (!migrated.length) return false;
  state.savedItemKeys = migrated;
  return true;
}

function allCurrentMediaArchived(state) {
  const items = Array.isArray(state?.items) ? state.items : [];
  if (!items.length) return false;
  // v1.3.1+ records exact keys processed by finalized ZIP jobs, including failed fetches.
  // Once this field exists, it is authoritative across image/video jobs.
  if (Array.isArray(state.savedItemKeys)) {
    const saved = new Set(state.savedItemKeys.filter(key => typeof key === 'string' && key));
    return items.every(item => item?.key && saved.has(item.key));
  }

  // Legacy compatibility: only accept the old savedKinds booleans if the latest archive
  // still describes the same completed collection. This rejects the dangerous case where
  // collection resumed and added media after the old ZIP had completed.
  if (!archiveCoversCurrentCollection(state)) return false;
  const saved = effectiveSavedKinds(state, state.deltaMode ? 'deltaSavedKinds' : 'savedKinds');
  return (!state.counts?.images || saved.images === true) &&
    (!state.counts?.videos || saved.videos === true);
}

function withArchiveStartLock(fn) {
  const next = archiveStartQueue.catch(() => {}).then(fn);
  archiveStartQueue = next.catch(() => {});
  return next;
}

function collectionKey(platform, handle) {
  return `${COLLECTION_PREFIX}${platform}_${normalizeHandle(handle)}`;
}

function previousCollectionKey(platform, handle) {
  return `${PREVIOUS_COLLECTION_PREFIX}${platform}_${normalizeHandle(handle)}`;
}

function validPostId(value, platform = 'x') {
  return platform === 'bluesky' ? /^[a-zA-Z0-9._~-]{1,80}$/.test(String(value || '')) : platform === 'threads' ? SMZThreads.validId(value) : /^\d+$/.test(String(value || ''));
}

// XのSnowflake IDはNumberで正確に扱えないため、整数文字列として比較する。
function compareNumericPostIds(a, b) {
  const aa = String(a).replace(/^0+/, '') || '0';
  const bb = String(b).replace(/^0+/, '') || '0';
  return aa.length === bb.length ? (aa > bb ? 1 : aa < bb ? -1 : 0) : (aa.length > bb.length ? 1 : -1);
}

function archiveReachedEnd(state) {
  const archive = state?.archive;
  if (archive?.status !== 'archive_complete') return false;
  const total = Number(archive.totalSelected || 0);
  const next = Number(archive.nextItemIndex ?? archive.processedItems ?? 0);
  return total >= 0 && next >= total;
}

function effectiveSavedKinds(state, field) {
  const saved = { ...(state?.[field] || {}) };
  // archive_complete は「全項目の保存処理を最後まで試行した」状態。取得失敗が残っても
  // 失敗件数を別表示したまま、選択済み種別は次回差分へ進める。
  if (archiveReachedEnd(state)) {
    if (state.archive?.selection?.images) saved.images = true;
    if (state.archive?.selection?.videos) saved.videos = true;
  }
  return saved;
}

function deltaKindsSaved(state) {
  if (!state?.deltaMode || !state.deltaVerified) return false;
  const saved = effectiveSavedKinds(state, 'deltaSavedKinds');
  return (!state.counts?.images || saved.images === true) &&
    (!state.counts?.videos || saved.videos === true);
}

function canStartNewOnlyCheck(state) {
  if (!state || state.status !== 'complete' || !validPostId(state.newestPostId, state.platform)) return false;
  if (state.archive?.status !== 'archive_complete') return false;
  if (state.deltaMode && state.deltaVerified !== true) return false;
  // A new-only baseline may only advance after every media item currently known to this
  // snapshot has gone through a finalized ZIP job. This is key-based, not index/count-only.
  return allCurrentMediaArchived(state);
}

async function getCollection(platform, handle) {
  const key = collectionKey(platform, handle);
  const data = await chrome.storage.local.get(key);
  let state = data[key] || null;
  // v1.3.0初期テスト版の差分状態には累計の基準件数が無い。前回状態が残っている
  // 間に一度だけ補完しておくと、以後の差分ZIPは最新1個だけで累計を復元できる。
  if (state?.deltaMode === true && !SMZBackup.cumulativeCounts(state)) {
    const prevKey = previousCollectionKey(platform, handle);
    const previous = (await chrome.storage.local.get(prevKey))[prevKey] || null;
    const baselineCounts = SMZBackup.cumulativeCounts(previous);
    if (baselineCounts) {
      state = { ...state, deltaBaselineCounts: baselineCounts };
      await chrome.storage.local.set({ [key]: state });
    }
  }
  return state;
}

async function setCollection(state) {
  const key = collectionKey(state.platform, state.handle);
  await chrome.storage.local.set({ [key]: state });
  // 大量件数の確認待ちは現在表示中のアカウントにだけ「確」を出すため、
  // アクティブタブを見てからツールバーを復元する。その他の進行状態は即時反映する。
  if (state?.status === 'awaiting_confirmation') void restoreToolbarState();
  else void scheduleToolbarState(state);
  return state;
}


async function acknowledgeArchiveCompletions() {
  const all = await chrome.storage.local.get(null);
  const updates = {};
  const acknowledgedAt = Date.now();

  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(COLLECTION_PREFIX) || !value || typeof value !== 'object') continue;
    if (value.archive?.status !== 'archive_complete' || value.archive?.completionAcknowledged !== false) continue;

    updates[key] = {
      ...value,
      archive: {
        ...value.archive,
        completionAcknowledged: true,
        completionAcknowledgedAt: acknowledgedAt
      }
    };
  }

  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  return Object.keys(updates).length;
}

function withCollectionLock(platform, handle, fn) {
  const key = collectionKey(platform, handle);
  const previous = collectionQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const state = await getCollection(platform, handle);
      return fn(state);
    });
  const wrapped = next.finally(() => {
    if (collectionQueues.get(key) === wrapped) collectionQueues.delete(key);
  });
  collectionQueues.set(key, wrapped);
  return next;
}

function comparePostIdsDesc(a, b) {
  try {
    const aa = BigInt(a.postId);
    const bb = BigInt(b.postId);
    if (aa === bb) return (a.mediaIndex || 0) - (b.mediaIndex || 0);
    return aa > bb ? -1 : 1;
  } catch {
    return String(b.postId).localeCompare(String(a.postId));
  }
}

function makeCollectionId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function makeNewCollection(handle) {
  const now = Date.now();
  return {
    schemaVersion: 4,
    collectionId: makeCollectionId(),
    collectionMode: 'manual',
    collectionPhase: null,
    platform: 'x',
    handle: normalizeHandle(handle),
    status: 'collecting',
    pauseReason: null,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    resumeAt: null,
    rateLimitSimulated: false,
    counts: { images: 0, videos: 0, total: 0 },
    items: [],
    newestPostId: null,
    oldestPostId: null,
    displayMediaCount: null,
    largeWarningConfirmed: false,
    confirmationTabId: null,
    collectionTabId: null,
    lastError: null,
    archive: null
  };
}

function makeDeltaCollection(previous, tabId, mode) {
  const next = makeNewCollection(previous.handle);
  next.collectionTabId = tabId;
  next.collectionMode = mode === 'manual' ? 'manual' : 'auto';
  next.deltaMode = true;
  next.deltaBaselinePostId = String(previous.newestPostId);
  next.deltaBaselineCollectedAt = previous.completedAt || previous.updatedAt || null;
  const baselineCounts = SMZBackup.cumulativeCounts(previous);
  if (baselineCounts) next.deltaBaselineCounts = baselineCounts;
  next.deltaBoundaryReached = false;
  next.deltaOlderPostIds = [];
  next.deltaVerified = false;
  next.deltaSavedKinds = { images: false, videos: false };
  // ZIPを保存したアカウントでは、次の差分も同じフォルダを可能なら再利用する。
  next.preferredSaveDirectoryKey = previous.archive?.saveDirectoryKey || previous.preferredSaveDirectoryKey || null;
  next.preferredSaveDirectoryName = previous.archive?.saveDirectoryName || previous.preferredSaveDirectoryName || null;
  next.largeWarningConfirmed = true; // 差分チェック時は総メディア件数の警告を繰り返さない。
  return next;
}

async function finishCollectionState(current, { endOfFeed = false, manual = false } = {}) {
  current.status = 'complete';
  current.collectionPhase = null;
  current.pauseReason = null;
  current.resumeAt = null;
  current.completedAt = Date.now();
  current.updatedAt = Date.now();
  current.items.sort(current.platform === 'threads' ? (a,b) => (Date.parse(b.postedAt || '') || 0) - (Date.parse(a.postedAt || '') || 0) || (a.postId === b.postId ? a.mediaIndex-b.mediaIndex : compareNumericPostIds(b.postId,a.postId)) : current.platform === 'bluesky' ? (a,b) => a.postId === b.postId ? a.mediaIndex-b.mediaIndex : a.postId>b.postId ? -1 : 1 : comparePostIdsDesc);
  current.newestPostId = current.items[0]?.postId || null;
  current.oldestPostId = current.items.at(-1)?.postId || null;
  if (current.deltaMode) {
    current.deltaVerified = current.deltaBoundaryReached === true || endOfFeed === true;
    current.deltaEndReason = current.deltaBoundaryReached ? 'previous_boundary' :
      endOfFeed ? 'end_of_feed' : manual ? 'manual_unverified' : 'unknown';
  }
  if (current.deltaMode && current.deltaVerified && current.counts.total === 0) {
    const key = previousCollectionKey(current.platform, current.handle);
    const saved = await chrome.storage.local.get(key);
    const previous = saved[key];
    if (previous && previous.status === 'complete') {
      previous.lastNewCheckAt = current.completedAt;
      previous.lastNewCheckResult = 0;
      previous.lastNewCheckVerified = true;
      previous.updatedAt = current.updatedAt;
      await chrome.storage.local.set({ [collectionKey(previous.platform, previous.handle)]: previous });
      await chrome.storage.local.remove(key);
      void restoreToolbarState();
      return previous;
    }
    // 前回の収集状態が消えている場合は、空の差分を成功扱いしない。
    current.status = 'paused';
    current.pauseReason = 'previous_missing';
    current.lastError = '前回の収集状態が見つかりません。新規分チェックの結果を確定できません';
  }
  await setCollection(current);
  return current;
}

function isNoReceiverError(error) {
  const message = String(error?.message || error || '');
  return message.includes('Receiving end does not exist') ||
    message.includes('Could not establish connection');
}

function isSupportedXUrl(url) {
  try {
    const parsed = new URL(url || '');
    return ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function injectXBridge(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedXUrl(tab?.url)) {
    throw new Error('現在のタブはXのページではありません');
  }

  // main-hook.js はXページ本体のfetch/XHRを監視するため MAIN worldへ。
  // content.js は拡張APIとページ本体を橋渡しするため通常のISOLATED worldへ。
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['providers/x/main-hook.js'],
    world: 'MAIN'
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['providers/x/content.js']
  });
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!isNoReceiverError(error)) {
      throw new Error(`Xページへ接続できませんでした: ${error.message}`);
    }

    // 拡張機能の読み込み/更新前から開いていたXタブには宣言型content scriptが
    // 入っていないことがある。その場合だけ自動注入して1回再試行する。
    try {
      await injectXBridge(tabId);
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (retryError) {
      throw new Error(`Xページへ接続できませんでした: ${retryError.message}`);
    }
  }
}

async function ensureOffscreenDocument() {
  const url = 'archive/offscreen.html';
  if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url,
      reasons: ['BLOBS'],
      justification: '大量メディアをZIP Blobへまとめてダウンロードするため'
    });
  } catch (error) {
    if (!String(error.message || '').includes('Only a single offscreen')) throw error;
  }
}

async function startResumeAlarm(state) {
  const name = `${RESUME_ALARM_PREFIX}${state.platform}_${state.handle}`;
  await chrome.alarms.clear(name);
  if (state.resumeAt) {
    await chrome.alarms.create(name, { when: Math.max(Date.now() + 1000, state.resumeAt) });
  }
}

async function clearResumeAlarm(platform, handle) {
  await chrome.alarms.clear(`${RESUME_ALARM_PREFIX}${platform}_${normalizeHandle(handle)}`);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === THREADS_ALARM) { await refreshThreadsAuth().catch(() => {}); return; }
  if (alarm.name === API_COLLECTION_WATCHDOG_ALARM) {
    apiRecoveryPromise = recoverApiCollections().catch(() => 0);
    await apiRecoveryPromise;
    return;
  }
  if (!alarm.name.startsWith(RESUME_ALARM_PREFIX)) return;
  const rest = alarm.name.slice(RESUME_ALARM_PREFIX.length);
  const sep = rest.indexOf('_');
  if (sep < 0) return;
  const platform = rest.slice(0, sep);
  const handle = rest.slice(sep + 1);
  if (platform !== 'x') return;

  const state = await getCollection(platform, handle);
  if (!state || state.status !== 'rate_limited') return;

  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  const target = tabs.find((tab) => {
    try {
      const u = new URL(tab.url || '');
      const part = u.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
      return part === handle && u.pathname.toLowerCase().includes('/media');
    } catch {
      return false;
    }
  });

  if (target?.id) {
    state.status = 'collecting';
    state.collectionPhase = null;
    state.pauseReason = null;
    state.resumeAt = null;
    state.rateLimitSimulated = false;
    state.collectionTabId = target.id;
    state.updatedAt = Date.now();
    await setCollection(state);
    try {
      const result = await sendToTab(target.id, { type: 'SMZ_RESUME_COLLECTION', handle, collectionId: state.collectionId,
        collectionMode: state.collectionMode || 'auto', deltaBaselinePostId: state.deltaBaselinePostId || null, automatic: true });
      // Xのエラー画面などでcontent側が再開を受け付けなかった場合は、収集中と誤表示しない。
      if (!result?.ok) throw new Error(result?.error || 'Xの画面から自動再開できませんでした');
    } catch (error) {
      state.status = 'paused';
      state.pauseReason = 'resume_ready';
      state.resumeAt = null;
      state.lastError = error.message;
      state.updatedAt = Date.now();
      await setCollection(state);
    }
  } else {
    state.status = 'paused';
    state.pauseReason = 'resume_ready';
    state.resumeAt = null;
    state.updatedAt = Date.now();
    await setCollection(state);
  }
});


// Blueskyはスクロールを使わず、公開APIのcursorでページングする。
// ページごとに永続化し、手動停止やService Workerの中断後も同じcursorから再開可能。
function bskyNewCollection(profile, pds) {
  const state = makeNewCollection(profile.handle);
  state.platform = 'bluesky';
  state.did = profile.did;
  state.pds = pds;
  state.collectionMode = 'api';
  state.resumeCursor = null;
  state.pagesFetched = 0;
  state.scannedPosts = 0;
  state.largeWarningConfirmed = true;
  return state;
}

async function runBlueskyCollection(handle, job) {
  const key = collectionKey('bluesky', handle);
  let cursor = job.cursor || null;
  const fetcher = (url, options) => fetch(url, { ...options, signal: job.abort.signal });
  try {
    for (let n = 0; n < 10000; n++) {
      if (job.stopped) return;
      const page = await SMZBluesky.page(job.did, cursor, fetcher);
      if (job.stopped) return;
      let boundaryReached = false;
      const collected = [];
      let scanned = 0;
      for (const entry of page.feed) {
        const post = SMZBluesky.extract(entry, job.did, job.pds);
        if (!post) continue;
        scanned++;
        if (job.baseline && post.postId <= job.baseline) {
          boundaryReached = true;
          break;
        }
        collected.push(...post.items);
      }
      const nextCursor = page.cursor && page.cursor !== cursor ? page.cursor : null;
      const endOfFeed = !nextCursor || page.feed.length === 0;
      const state = await withCollectionLock('bluesky', handle, async (current) => {
        if (!current || current.collectionId !== job.collectionId || current.status !== 'collecting' || job.stopped) return null;
        const existing = new Set(current.items.map(v => v.key));
        const addedItems = [];
        for (const item of collected) {
          if (existing.has(item.key)) continue;
          existing.add(item.key);
          current.items.push(item);
          addedItems.push(item);
          if (item.type === 'image') current.counts.images++;
          else current.counts.videos++;
        }
        markAddedItemsUnsaved(current, addedItems);
        current.counts.total = current.counts.images + current.counts.videos;
        current.items.sort((a,b) => a.postId === b.postId ? a.mediaIndex-b.mediaIndex : a.postId>b.postId ? -1 : 1);
        current.newestPostId = current.items[0]?.postId || null;
        current.oldestPostId = current.items.at(-1)?.postId || null;
        current.pagesFetched = Number(current.pagesFetched || 0) + 1;
        current.scannedPosts = Number(current.scannedPosts || 0) + scanned;
        current.resumeCursor = nextCursor;
        if (current.deltaMode) current.deltaBoundaryReached = boundaryReached;
        current.updatedAt = Date.now();
        if (boundaryReached || endOfFeed) {
          return finishCollectionState(current, { endOfFeed, manual: false });
        }
        await setCollection(current);
        return current;
      });
      if (!state || state.status !== 'collecting' || boundaryReached || endOfFeed) return;
      cursor = nextCursor;
      // APIレート制限を迂回しない。通常収集でもページ間に一定の休止を置く。
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new Error('ページ数の安全上限に達しました。ここまでの収集は保持しています');
  } catch (error) {
    if (job.stopped || error?.name === 'AbortError') return;
    await withCollectionLock('bluesky', handle, async current => {
      if (!current || current.collectionId !== job.collectionId || current.status !== 'collecting') return;
      current.status = 'paused';
      current.pauseReason = error?.status === 429 ? 'rate_limit' : 'error';
      current.lastError = error?.status === 429 ? 'Bluesky APIから429を受けました。時間を置いて手動で再開してください' : String(error.message || error);
      current.resumeAt = error?.status === 429 ? Date.now() + Math.max(15*60*1000, (error.retryAfter || 0)*1000) : null;
      current.updatedAt = Date.now();
      await setCollection(current);
    });
  } finally {
    if (blueskyJobs.get(key) === job) blueskyJobs.delete(key);
    void updateApiCollectionWatchdog().catch(() => {});
  }
}

// Threads access tokens remain in chrome.storage.local only, outside every exported backup.
async function getThreadsAuth() {
  const stored = await chrome.storage.local.get(THREADS_AUTH_KEY);
  return stored?.[THREADS_AUTH_KEY] || null;
}
function threadsAuthStatus(auth) {
  return auth ? { connected: true, username: auth.username, expiresAt: auth.expiresAt || null,
    expiryEstimated: auth.expiryEstimated === true, autoRenew: auth.autoRenew !== false,
    lastRefreshAt: auth.lastRefreshAt || null, lastError: auth.lastError || null } :
    { connected: false, autoRenew: true };
}
async function scheduleThreadsRenewal() {
  if (typeof chrome.alarms?.create !== 'function') return;
  await chrome.alarms.create(THREADS_ALARM, { periodInMinutes: 24 * 60 });
}
async function refreshThreadsAuth(force = false) {
  const auth = await getThreadsAuth();
  if (!auth?.token) throw new Error('Threadsの長期トークンを登録してください');
  if (!force && auth.autoRenew === false) return threadsAuthStatus(auth);
  const remaining = Number(auth.expiresAt || 0) - Date.now();
  // A pasted token may already be weeks old. A 60-day estimate measured from
  // registration is NOT its actual expiry. After 24h, obtain an authoritative
  // expires_in via one automatic refresh; then use the normal 30-day threshold.
  const needsFirstRefresh = auth.expiryEstimated === true &&
    Date.now() - Number(auth.issuedAt || 0) >= 24 * 60 * 60 * 1000;
  if (!force && !needsFirstRefresh && remaining > 30 * 24 * 60 * 60 * 1000) return threadsAuthStatus(auth);
  if (!force && Number(auth.lastRefreshAttempt || 0) > Date.now() - 24 * 60 * 60 * 1000) return threadsAuthStatus(auth);
  auth.lastRefreshAttempt = Date.now();
  // A long-lived Threads user token refresh needs no client_secret.
  // Never copy the outgoing token into exception messages or app logs.
  try {
    const refreshed = await SMZThreads.refresh(auth.token);
    if (typeof refreshed.access_token !== 'string' || !refreshed.access_token ||
        !Number.isFinite(Number(refreshed.expires_in)) || Number(refreshed.expires_in) <= 0) {
      throw new Error('Threadsの更新応答を確認できません');
    }
    auth.token = refreshed.access_token;
    auth.expiresAt = Date.now() + Number(refreshed.expires_in) * 1000;
    auth.expiryEstimated = false;
    auth.lastRefreshAt = Date.now();
    auth.lastError = null;
  } catch (error) {
    auth.lastError = error?.status ? `Threads更新: HTTP ${error.status}` : '更新できませんでした。長期トークンの有効期限と接続状態を確認してください';
    await chrome.storage.local.set({ [THREADS_AUTH_KEY]: auth });
    throw new Error(auth.lastError);
  }
  await chrome.storage.local.set({ [THREADS_AUTH_KEY]: auth });
  return threadsAuthStatus(auth);
}
void getThreadsAuth().then(auth => { if (auth?.autoRenew !== false && auth?.token) return scheduleThreadsRenewal(); }).catch(() => {});

function threadNewCollection(profile, authUserId = null) {
  const state = makeNewCollection(profile.handle);
  state.platform = 'threads';
  state.collectionMode = 'api';
  state.ownProfile = profile.own === true;
  state.authUserId = authUserId ? String(authUserId) : null;
  state.resumeCursor = null;
  state.pagesFetched = 0;
  state.scannedPosts = 0;
  state.largeWarningConfirmed = true;
  return state;
}
async function runThreadsCollection(handle, job) {
  const key = collectionKey('threads', handle);
  let cursor = job.cursor || null;
  const fetcher = (url, options) => fetch(url, { ...options, signal: job.abort.signal });
  let previousPostIds = null;
  if (job.baseline) {
    const previousKey = previousCollectionKey('threads', handle);
    const previous = (await chrome.storage.local.get(previousKey))[previousKey] || null;
    if (previous?.items?.length) previousPostIds = new Set(previous.items.map(item => String(item.postId)));
  }
  try {
    for (let n = 0; n < 10000; n++) {
      if (job.stopped) return;
      // Do not retain tokens in the collection state, backup or offscreen ZIP job.
      const auth = await getThreadsAuth();
      if (!auth?.token) throw new Error('Threadsの認証情報がなくなりました。設定画面から再接続してください');
      if (job.authUserId && String(auth.userId || '') !== String(job.authUserId)) {
        throw new Error('Threadsの接続アカウントが変更されたため収集を停止しました');
      }
      const page = await SMZThreads.page({ handle, own: job.own }, cursor, auth.token, fetcher);
      if (job.stopped) return;
      let boundaryReached = false;
      const collected = [];
      let scanned = 0;
      for (const post of page.data) {
        if (!SMZThreads.validId(post?.id)) continue;
        scanned++;
        // Threads media IDs aren't guaranteed to be Snowflakes. The latest prior post can be
        // deleted, so accept any post already present in the previous snapshot as the boundary.
        const postId = String(post.id);
        if (job.baseline && (postId === job.baseline || previousPostIds?.has(postId))) { boundaryReached = true; break; }
        const extracted = await SMZThreads.extract(post, auth.token, fetcher);
        if (extracted) collected.push(...extracted.items);
      }
      const nextCursor = page.cursor && page.cursor !== cursor ? page.cursor : null;
      const endOfFeed = !nextCursor || page.data.length === 0;
      const state = await withCollectionLock('threads', handle, async current => {
        if (!current || current.collectionId !== job.collectionId || current.status !== 'collecting' || job.stopped) return null;
        const keys = new Set(current.items.map(item => item.key));
        const addedItems = [];
        for (const item of collected) {
          if (keys.has(item.key)) continue;
          keys.add(item.key); current.items.push(item); addedItems.push(item);
          if (item.type === 'image') current.counts.images++;
          else current.counts.videos++;
        }
        markAddedItemsUnsaved(current, addedItems);
        current.counts.total = current.counts.images + current.counts.videos;
        current.items.sort((a,b) => (Date.parse(b.postedAt || '') || 0) - (Date.parse(a.postedAt || '') || 0) ||
          (a.postId === b.postId ? a.mediaIndex-b.mediaIndex : compareNumericPostIds(b.postId,a.postId)));
        current.newestPostId = current.items[0]?.postId || null;
        current.oldestPostId = current.items.at(-1)?.postId || null;
        current.pagesFetched = Number(current.pagesFetched || 0) + 1;
        current.scannedPosts = Number(current.scannedPosts || 0) + scanned;
        current.resumeCursor = nextCursor;
        if (current.deltaMode) current.deltaBoundaryReached = boundaryReached;
        current.updatedAt = Date.now();
        if (current.deltaMode && endOfFeed && !boundaryReached) {
          current.status = 'paused';
          current.pauseReason = 'delta_boundary_missing';
          current.deltaVerified = false;
          current.lastError = '前回の保存済み投稿との境界を確認できませんでした。前回の状態へ戻すか、進捗をリセットして再収集してください';
          current.resumeCursor = null;
          await setCollection(current);
          return current;
        }
        if (boundaryReached || endOfFeed) return finishCollectionState(current, { endOfFeed, manual: false });
        await setCollection(current);
        return current;
      });
      if (!state || state.status !== 'collecting' || boundaryReached || endOfFeed) return;
      cursor = nextCursor;
      // Threads初期実装の1秒待機を短縮。429時は既存の停止・再開処理を優先する。
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error('ページ数の安全上限に達しました。収集済み情報は維持しています');
  } catch (error) {
    if (job.stopped || error?.name === 'AbortError') return;
    await withCollectionLock('threads', handle, async current => {
      if (!current || current.collectionId !== job.collectionId || current.status !== 'collecting') return;
      current.status = 'paused';
      current.pauseReason = error?.status === 429 ? 'rate_limit' : error?.status === 401 || error?.status === 403 ? 'auth' : 'error';
      current.lastError = error?.status === 429 ? 'Threads APIから429を受けました。時間を置いて手動で再開してください' :
        // Provider errors are sanitized. Don't persist API URLs, scopes or credentials.
        String(error?.message || 'Threadsの収集を続けられません').slice(0, 240);
      current.resumeAt = error?.status === 429 ? Date.now() + Math.max(15*60*1000, Number(error.retryAfter || 0)*1000) : null;
      current.updatedAt = Date.now();
      await setCollection(current);
    });
  } finally {
    if (threadsJobs.get(key) === job) threadsJobs.delete(key);
    void updateApiCollectionWatchdog().catch(() => {});
  }
}


async function scheduleApiCollectionWatchdog() {
  if (typeof chrome.alarms?.create !== 'function') return;
  // MV3のService Workerが破棄されても、遅くとも次の監視時にページ単位の
  // チェックポイントからAPI収集を再開する。頻繁なポーリングはしない。
  await chrome.alarms.create(API_COLLECTION_WATCHDOG_ALARM, { periodInMinutes: 1 });
}

async function apiCollectionStatesRunning() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).some(([key, value]) =>
    key.startsWith(COLLECTION_PREFIX) &&
    ['bluesky', 'threads'].includes(value?.platform) &&
    value?.status === 'collecting' &&
    value?.archive?.status !== 'archiving');
}

async function updateApiCollectionWatchdog() {
  if (await apiCollectionStatesRunning()) await scheduleApiCollectionWatchdog();
  else if (typeof chrome.alarms?.clear === 'function') await chrome.alarms.clear(API_COLLECTION_WATCHDOG_ALARM);
}

async function recoverApiCollections() {
  const all = await chrome.storage.local.get(null);
  let recovered = 0;

  for (const [storedKey, state] of Object.entries(all)) {
    if (!storedKey.startsWith(COLLECTION_PREFIX) || !state || typeof state !== 'object') continue;
    if (state.status !== 'collecting' || state.archive?.status === 'archiving') continue;
    if (!['bluesky', 'threads'].includes(state.platform)) continue;

    const handle = normalizeHandle(state.handle);
    if (!handle || !state.collectionId || storedKey !== collectionKey(state.platform, handle)) continue;

    if (state.platform === 'threads') {
      if (threadsJobs.has(storedKey)) continue;
      const auth = await getThreadsAuth();
      const boundAuthUserId = state.authUserId || auth?.userId || null;
      if (!auth?.token || (state.authUserId && String(auth?.userId || '') !== String(state.authUserId))) {
        await withCollectionLock('threads', handle, async current => {
          if (!current || current.collectionId !== state.collectionId || current.status !== 'collecting') return current;
          current.status = 'paused';
          current.pauseReason = 'auth';
          current.lastError = !auth?.token ? 'Threadsの認証情報がありません。設定画面から再接続してください' :
            'Threadsの接続アカウントが変更されているため自動再開しませんでした';
          current.updatedAt = Date.now();
          await setCollection(current);
          return current;
        });
        continue;
      }
      if (!state.authUserId && boundAuthUserId) {
        state.authUserId = String(boundAuthUserId);
        await chrome.storage.local.set({ [storedKey]: state });
      }
      const job = {
        own: state.ownProfile === true,
        authUserId: boundAuthUserId ? String(boundAuthUserId) : null,
        collectionId: state.collectionId,
        baseline: state.deltaMode ? state.deltaBaselinePostId : null,
        cursor: state.resumeCursor || null,
        stopped: false,
        abort: new AbortController()
      };
      // Mapへ先に登録する。復旧直後にポップアップが開いても二重起動しない。
      threadsJobs.set(storedKey, job);
      recovered++;
      void runThreadsCollection(handle, job);
      continue;
    }

    if (blueskyJobs.has(storedKey)) continue;
    if (!state.did || !state.pds) {
      await withCollectionLock('bluesky', handle, async current => {
        if (!current || current.collectionId !== state.collectionId || current.status !== 'collecting') return current;
        current.status = 'paused';
        current.pauseReason = 'error';
        current.lastError = 'Service Worker再起動後のBluesky収集情報を復元できませんでした';
        current.updatedAt = Date.now();
        await setCollection(current);
        return current;
      });
      continue;
    }
    const job = {
      did: state.did,
      pds: state.pds,
      collectionId: state.collectionId,
      baseline: state.deltaMode ? state.deltaBaselinePostId : null,
      cursor: state.resumeCursor || null,
      stopped: false,
      abort: new AbortController()
    };
    blueskyJobs.set(storedKey, job);
    recovered++;
    void runBlueskyCollection(handle, job);
  }

  await updateApiCollectionWatchdog();
  return recovered;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return false;

  (async () => {
    // 全体初期化と新しい保存/収集の競合を防ぐ。
    if (fullResetInProgress && !['SMZ_SYNC_TOOLBAR', 'SMZ_BACKUP_RESET_ALL'].includes(message.type)) {
      throw new Error('データを初期化しています。完了後に操作してください');
    }
    switch (message.type) {
      case 'SMZ_SYNC_TOOLBAR': {
        await restoreToolbarState();
        sendResponse({ ok: true });
        break;
      }

      case 'SMZ_ACK_ARCHIVE_COMPLETE': {
        const acknowledged = await acknowledgeArchiveCompletions();
        await restoreToolbarState();
        sendResponse({ ok: true, acknowledged });
        break;
      }

      case 'SMZ_DEBUG_LIST_COLLECTING': {
        // 開発用診断は拡張自身の設定ページからのみ利用する。
        if (sender.url !== chrome.runtime.getURL('options/options.html')) throw new Error('設定画面から実行してください');
        const all = await chrome.storage.local.get(null);
        const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
        const sessions = Object.entries(all)
          .filter(([key, value]) => key.startsWith(COLLECTION_PREFIX) && value?.platform === 'x' && value?.status === 'collecting')
          .map(([, state]) => {
            const matchingTabs = tabs.filter((tab) => xHandleFromUrl(tab.url) === normalizeHandle(state.handle) &&
              /^\/(?:[^/]+)\/media(?:\/|$)/i.test(new URL(tab.url).pathname));
            const matchingTab = matchingTabs.find((tab) => tab.id === Number(state.collectionTabId)) || matchingTabs[0];
            return {
              handle: state.handle,
              collectionId: state.collectionId,
              count: Number(state.counts?.total || 0),
              tabId: matchingTab?.id || null
            };
          });
        sendResponse({ ok: true, sessions });
        break;
      }

      case 'SMZ_DEBUG_INJECT_429': {
        if (sender.url !== chrome.runtime.getURL('options/options.html')) throw new Error('設定画面から実行してください');
        const handle = normalizeHandle(message.handle);
        const state = await getCollection('x', handle);
        if (!state || state.status !== 'collecting' || !state.collectionId || state.collectionId !== message.collectionId) {
          throw new Error('対象の収集が終了・変更されています。状態を更新してください');
        }
        const tabId = Number(message.tabId);
        if (!Number.isSafeInteger(tabId) || tabId <= 0) throw new Error('対象タブを確認できません');
        const tab = await chrome.tabs.get(tabId);
        if (xHandleFromUrl(tab?.url) !== handle || !/^\/(?:[^/]+)\/media(?:\/|$)/i.test(new URL(tab.url).pathname)) {
          throw new Error('対象のXメディアタブを確認できません');
        }
        // Xのレスポンスや通信には一切手を加えず、収集中のcontent scriptへ
        // テスト用イベントだけ送る。通常429と同じ状態遷移へ合流する。
        const result = await sendToTab(tabId, {
          type: 'SMZ_DEBUG_SIMULATE_429',
          handle,
          collectionId: state.collectionId,
          resumeAt: Date.now() + 90 * 1000
        });
        if (!result?.ok) throw new Error(result?.error || '対象タブは現在収集中ではありません');
        sendResponse({ ok: true, state: await getCollection('x', handle) });
        break;
      }

      case 'SMZ_THREADS_AUTH_STATUS': {
        sendResponse({ ok: true, auth: threadsAuthStatus(await getThreadsAuth()) });
        break;
      }
      case 'SMZ_THREADS_CONNECT': {
        if (sender.url !== chrome.runtime.getURL('options/options.html')) throw new Error('設定画面から実行してください');
        const token = String(message.token || '').trim();
        if (!/^[-A-Za-z0-9_.|]+$/.test(token) || token.length > 4096) throw new Error('トークンの形式を確認してください');
        const profile = await SMZThreads.me(token);
        await apiRecoveryPromise.catch(() => {});
        const previousAuth = await getThreadsAuth();
        const all = await chrome.storage.local.get(null);
        const threadsCollecting = Object.entries(all).some(([key, value]) =>
          key.startsWith(COLLECTION_PREFIX) && value?.platform === 'threads' && value?.status === 'collecting');
        if (threadsCollecting && (!previousAuth?.userId || String(previousAuth.userId) !== String(profile.id))) {
          throw new Error('Threads収集中は別アカウントのトークンへ変更できません。収集を停止してから変更してください');
        }
        const auth = { token, username: profile.handle, userId: profile.id, autoRenew: message.autoRenew !== false,
          issuedAt: Date.now(), expiresAt: Date.now() + 60*24*60*60*1000,
          expiryEstimated: true, lastRefreshAt: null, lastRefreshAttempt: null, lastError: null };
        await chrome.storage.local.set({ [THREADS_AUTH_KEY]: auth });
        if (auth.autoRenew) await scheduleThreadsRenewal();
        sendResponse({ ok: true, auth: threadsAuthStatus(auth) });
        break;
      }
      case 'SMZ_THREADS_SET_AUTORENEW': {
        if (sender.url !== chrome.runtime.getURL('options/options.html')) throw new Error('設定画面から実行してください');
        const auth = await getThreadsAuth();
        if (!auth) throw new Error('Threadsを接続してください');
        auth.autoRenew = message.enabled === true;
        await chrome.storage.local.set({ [THREADS_AUTH_KEY]: auth });
        if (auth.autoRenew) await scheduleThreadsRenewal();
        else await chrome.alarms.clear(THREADS_ALARM);
        sendResponse({ ok: true, auth: threadsAuthStatus(auth) });
        break;
      }
      case 'SMZ_THREADS_REFRESH_AUTH': {
        if (sender.url !== chrome.runtime.getURL('options/options.html')) throw new Error('設定画面から実行してください');
        sendResponse({ ok: true, auth: await refreshThreadsAuth(true) });
        break;
      }
      case 'SMZ_THREADS_DISCONNECT': {
        if (sender.url !== chrome.runtime.getURL('options/options.html')) throw new Error('設定画面から実行してください');
        await apiRecoveryPromise.catch(() => {});
        const all = await chrome.storage.local.get(null);
        if (threadsJobs.size || Object.entries(all).some(([key, value]) =>
            key.startsWith(COLLECTION_PREFIX) && value?.platform === 'threads' && value?.status === 'collecting')) {
          throw new Error('Threads収集を停止してからトークンを削除してください');
        }
        await chrome.storage.local.remove(THREADS_AUTH_KEY);
        await chrome.alarms.clear(THREADS_ALARM);
        sendResponse({ ok: true, auth: threadsAuthStatus(null) });
        break;
      }
      case 'SMZ_THREADS_GET_PROFILE': {
        const auth = await getThreadsAuth();
        if (!auth?.token) throw new Error('設定画面からThreadsの長期トークンを登録してください');
        const profile = await SMZThreads.profile(normalizeHandle(message.actor), auth.token, {handle: auth.username});
        sendResponse({ ok: true, profile });
        break;
      }
      case 'SMZ_THREADS_START_COLLECTION': {
        await apiRecoveryPromise.catch(() => {});
        const auth = await getThreadsAuth();
        if (!auth?.token) throw new Error('設定画面からThreadsに接続してください');
        const actor = normalizeHandle(message.handle);
        const profile = await SMZThreads.profile(actor, auth.token, {handle: auth.username});
        const key = collectionKey('threads', profile.handle);
        if (threadsJobs.has(key)) throw new Error('Threadsの収集がまだ進行中です');
        await acknowledgeArchiveCompletions();
        let state = await getCollection('threads', profile.handle);
        if (state?.archive?.status === 'archiving') throw new Error('ZIP保存中です');
        // Service Worker再起動後の collecting は recoverApiCollections() が
        // 保存済みcursorから復旧する。ここでpausedへ書き換えない。
        if (state?.status === 'collecting') throw new Error('Threadsの収集がまだ進行中です');
        if (state?.resumeAt && state.pauseReason === 'rate_limit' && state.resumeAt > Date.now()) {
          throw new Error('Threads APIのアクセス制限が終了するまで待ってください');
        }
        if (message.newOnly) {
          if (!canStartNewOnlyCheck(state)) throw new Error('差分確認前に前回のZIP保存を完了してください');
          const previous = state;
          state = threadNewCollection(profile, auth.userId);
          state.deltaMode = true;
          state.deltaBaselinePostId = previous.newestPostId;
          state.deltaBaselineCollectedAt = previous.completedAt || previous.updatedAt || null;
          const baselineCounts = SMZBackup.cumulativeCounts(previous);
          if (baselineCounts) state.deltaBaselineCounts = baselineCounts;
          state.deltaBoundaryReached = false;
          state.deltaVerified = false;
          state.deltaSavedKinds = { images:false, videos:false };
          state.preferredSaveDirectoryKey = previous.archive?.saveDirectoryKey || previous.preferredSaveDirectoryKey || null;
          state.preferredSaveDirectoryName = previous.archive?.saveDirectoryName || previous.preferredSaveDirectoryName || null;
          await chrome.storage.local.set({ [previousCollectionKey('threads',profile.handle)]: previous });
        } else if (message.restart || !state) {
          state = threadNewCollection(profile, auth.userId);
        } else if (state.status === 'complete') {
          throw new Error('収集済みです。新規分のチェックか進捗リセットを選んでください');
        } else {
          if (state.authUserId && String(state.authUserId) !== String(auth.userId || '')) {
            throw new Error('この収集状態は別のThreads接続アカウントで開始されています。元のアカウントへ戻すか進捗をリセットしてください');
          }
          state.status = 'collecting'; state.pauseReason = null; state.resumeAt = null; state.lastError = null;
          state.ownProfile = profile.own; state.updatedAt = Date.now();
        }
        state.authUserId = auth.userId ? String(auth.userId) : null;
        state.collectionMode = 'api';
        const job = { own: profile.own, authUserId: state.authUserId, collectionId: state.collectionId,
          baseline: state.deltaMode ? state.deltaBaselinePostId : null,
          cursor: state.resumeCursor || null, stopped:false, abort:new AbortController() };
        threadsJobs.set(key, job);
        await setCollection(state);
        await scheduleApiCollectionWatchdog();
        void runThreadsCollection(profile.handle, job);
        sendResponse({ ok: true, state });
        break;
      }
      case 'SMZ_THREADS_STOP_COLLECTION': {
        const handle = normalizeHandle(message.handle);
        const job = threadsJobs.get(collectionKey('threads',handle));
        if (job) { job.stopped = true; job.abort.abort(); }
        const state = await withCollectionLock('threads',handle,async current => {
          if (!current || current.status !== 'collecting') return current;
          current.status = 'paused'; current.pauseReason = 'manual'; current.updatedAt = Date.now();
          await setCollection(current); return current;
        });
        sendResponse({ ok:true, state });
        break;
      }
      case 'SMZ_THREADS_CANCEL_DELTA': {
        const handle = normalizeHandle(message.handle);
        const key = previousCollectionKey('threads',handle);
        const previous = (await chrome.storage.local.get(key))[key];
        const state = await getCollection('threads',handle);
        const boundaryMissing = state?.pauseReason === 'delta_boundary_missing' && state?.deltaVerified !== true;
        if (!previous || !state?.deltaMode || !['paused','complete'].includes(state.status) ||
            state.archive?.status === 'archiving' || (!boundaryMissing && Number(state.archive?.savedZipCount || 0) > 0)) {
          throw new Error('前回の状態へ戻せません');
        }
        await chrome.storage.local.set({ [collectionKey('threads',handle)]:previous });
        await chrome.storage.local.remove(key);
        await restoreToolbarState();
        sendResponse({ ok:true, state:previous });
        break;
      }

      case 'SMZ_BSKY_GET_PROFILE': {
        const profile = await SMZBluesky.profile(normalizeHandle(message.actor));
        const pds = await SMZBluesky.resolvePds(profile.did);
        sendResponse({ ok: true, profile, pds });
        break;
      }

      case 'SMZ_BSKY_START_COLLECTION': {
        await apiRecoveryPromise.catch(() => {});
        const actor = normalizeHandle(message.handle);
        const profile = await SMZBluesky.profile(actor);
        const pds = await SMZBluesky.resolvePds(profile.did);
        const key = collectionKey('bluesky', profile.handle);
        if (blueskyJobs.has(key)) throw new Error('Blueskyの収集がまだ進行中です');
        if (!await chrome.permissions.contains({ origins: [`${pds}/*`] })) {
          throw new Error('元データを取得するPDSへのアクセスが許可されていません。もう一度ポップアップを開いてください');
        }
        await acknowledgeArchiveCompletions();
        let state = await getCollection('bluesky', profile.handle);
        if (state?.status === 'collecting' || state?.archive?.status === 'archiving') {
          throw new Error('処理中のため開始できません');
        }
        if (state?.resumeAt && state.pauseReason === 'rate_limit' && state.resumeAt > Date.now()) {
          throw new Error('APIのアクセス制限が終了するまで待ってください');
        }
        if (message.newOnly) {
          if (!canStartNewOnlyCheck(state)) throw new Error('差分チェック前に前回のZIP保存を完了してください');
          const previous = state;
          state = bskyNewCollection(profile, pds);
          state.deltaMode = true;
          state.deltaBaselinePostId = previous.newestPostId;
          state.deltaBaselineCollectedAt = previous.completedAt || previous.updatedAt || null;
          const baselineCounts = SMZBackup.cumulativeCounts(previous);
          if (baselineCounts) state.deltaBaselineCounts = baselineCounts;
          state.deltaBoundaryReached = false;
          state.deltaVerified = false;
          state.deltaSavedKinds = { images: false, videos: false };
          state.preferredSaveDirectoryKey = previous.archive?.saveDirectoryKey || previous.preferredSaveDirectoryKey || null;
          state.preferredSaveDirectoryName = previous.archive?.saveDirectoryName || previous.preferredSaveDirectoryName || null;
          await chrome.storage.local.set({ [previousCollectionKey('bluesky', profile.handle)]: previous });
        } else if (message.restart || !state) {
          state = bskyNewCollection(profile, pds);
        } else if (state.status === 'complete') {
          throw new Error('収集済みです。新規分のチェックか進捗リセットを選んでください');
        } else {
          state.status = 'collecting';
          state.pauseReason = null;
          state.resumeAt = null;
          state.lastError = null;
          state.did = profile.did;
          state.pds = pds;
          state.updatedAt = Date.now();
        }
        state.collectionMode = 'api';
        const job = { did: profile.did, pds, collectionId: state.collectionId,
          baseline: state.deltaMode ? state.deltaBaselinePostId : null,
          cursor: state.resumeCursor || null, stopped: false, abort: new AbortController() };
        blueskyJobs.set(key, job);
        await setCollection(state);
        await scheduleApiCollectionWatchdog();
        // 収集はポップアップを閉じてもService Worker上で続く。1ページごとに進捗保存。
        void runBlueskyCollection(profile.handle, job);
        sendResponse({ ok: true, state });
        break;
      }

      case 'SMZ_BSKY_STOP_COLLECTION': {
        const handle = normalizeHandle(message.handle);
        const key = collectionKey('bluesky', handle);
        const job = blueskyJobs.get(key);
        if (job) { job.stopped = true; job.abort.abort(); }
        const state = await withCollectionLock('bluesky', handle, async current => {
          if (!current || current.status !== 'collecting') return current;
          current.status = 'paused'; current.pauseReason = 'manual'; current.updatedAt = Date.now();
          await setCollection(current);
          return current;
        });
        sendResponse({ ok: true, state });
        break;
      }

      case 'SMZ_BSKY_CANCEL_DELTA': {
        const handle = normalizeHandle(message.handle);
        const key = previousCollectionKey('bluesky', handle);
        const saved = await chrome.storage.local.get(key);
        const previous = saved[key];
        const state = await getCollection('bluesky', handle);
        if (!state?.deltaMode || !['paused','complete'].includes(state.status) ||
            state.archive?.status === 'archiving' || Number(state.archive?.savedZipCount || 0) > 0 || !previous) {
          throw new Error('前回の状態へ戻せません');
        }
        await chrome.storage.local.set({ [collectionKey('bluesky', handle)]: previous });
        await chrome.storage.local.remove(key);
        await restoreToolbarState();
        sendResponse({ ok: true, state: previous });
        break;
      }

      case 'SMZ_GET_COLLECTION': {
        if (['bluesky','threads'].includes(message.platform)) await apiRecoveryPromise.catch(() => {});
        const state = await getCollection(message.platform || 'x', message.handle);
        sendResponse({ ok: true, state, isCollectionTab: !sender.tab?.id || !state?.collectionTabId || sender.tab.id === state.collectionTabId });
        break;
      }

      case 'SMZ_START_COLLECTION': {
        const handle = normalizeHandle(message.handle);
        if (!handle || !message.tabId) throw new Error('対象ユーザーまたはタブを確認できません');

        // 新しい処理を始めた時点で、以前のZIP完了通知は確認済みとして片付ける。
        await acknowledgeArchiveCompletions();
        let state = await getCollection('x', handle);
        if (message.newOnly) {
          if (!canStartNewOnlyCheck(state)) {
            throw new Error('差分チェックには収集完了済みの前回データが必要です。新規メディアを先にZIP保存してください');
          }
          const previous = state;
          state = makeDeltaCollection(previous, message.tabId, message.collectionMode);
          // チェック中や「新規なし」の場合も元の収集・ZIP情報を失わないよう、別キーに保持する。
          await chrome.storage.local.set({
            [previousCollectionKey('x', handle)]: previous,
            [collectionKey('x', handle)]: state
          });
          void scheduleToolbarState(state);
        } else if (message.restart || !state) state = makeNewCollection(handle);
        else {
          if (!state.collectionId) state.collectionId = makeCollectionId();
          state.schemaVersion = Math.max(Number(state.schemaVersion) || 1, 4);
          // v0.0.9以前から既に収集済みの作業は、アップデート後に大量件数警告を再表示しない。
          if (state.largeWarningConfirmed == null && Number(state.counts?.total || 0) > 0) {
            state.largeWarningConfirmed = true;
          }
          state.status = 'collecting';
          state.collectionPhase = null;
          state.pauseReason = null;
          state.resumeAt = null;
          state.rateLimitSimulated = false;
          state.lastError = null;
          state.updatedAt = Date.now();
        }
        state.collectionMode = message.collectionMode === 'manual' ? 'manual' : 'auto';
        state.collectionTabId = message.tabId;
        await clearResumeAlarm('x', handle);
        await setCollection(state);
        try {
          await sendToTab(message.tabId, {
            type: 'SMZ_START_COLLECTION',
            handle,
            collectionId: state.collectionId,
            collectionMode: state.collectionMode,
            deltaBaselinePostId: state.deltaMode ? state.deltaBaselinePostId : null,
            restart: !!message.restart,
            forceReload: message.forceReload !== false
          });
        } catch (error) {
          if (message.newOnly) {
            // 接続できなければ前回収集データを戻し、差分開始失敗で既存ZIP情報を隠さない。
            const key = previousCollectionKey('x', handle);
            const saved = await chrome.storage.local.get(key);
            if (saved[key]) {
              await chrome.storage.local.set({ [collectionKey('x', handle)]: saved[key] });
              await chrome.storage.local.remove(key);
              void restoreToolbarState();
            }
          }
          throw error;
        }
        sendResponse({ ok: true, state });
        break;
      }

      case 'SMZ_CANCEL_DELTA': {
        const handle = normalizeHandle(message.handle);
        const previousKey = previousCollectionKey('x', handle);
        const restored = await withCollectionLock('x', handle, async (current) => {
          if (!current?.deltaMode || !['paused', 'complete'].includes(current.status)) {
            throw new Error('前回に戻せるのは停止中または完了済みの差分収集だけです');
          }
          if (current.archive?.status === 'archiving' || Number(current.archive?.savedZipCount || 0) > 0) {
            throw new Error('今回のZIP保存が始まっています。差分を破棄することはできません');
          }
          const old = (await chrome.storage.local.get(previousKey))[previousKey];
          if (!old || old.status !== 'complete') throw new Error('前回の収集状態を復元できません');
          await chrome.storage.local.set({ [collectionKey('x', handle)]: old });
          await chrome.storage.local.remove(previousKey);
          void restoreToolbarState();
          return old;
        });
        await clearResumeAlarm('x', handle);
        sendResponse({ ok: true, state: restored });
        break;
      }

      case 'SMZ_STOP_COLLECTION': {
        const handle = normalizeHandle(message.handle);
        const state = await withCollectionLock('x', handle, async (current) => {
          if (!current) return null;
          current.status = 'paused';
          current.collectionPhase = null;
          current.pauseReason = 'manual';
          current.resumeAt = null;
          current.rateLimitSimulated = false;
          current.updatedAt = Date.now();
          await setCollection(current);
          return current;
        });
        await clearResumeAlarm('x', handle);
        const tabToStop = state?.collectionTabId || message.tabId;
        if (tabToStop) {
          try { await sendToTab(tabToStop, { type: 'SMZ_STOP_COLLECTION', handle }); } catch {}
        }
        sendResponse({ ok: true, state });
        break;
      }

      case 'SMZ_ADD_MEDIA': {
        const handle = normalizeHandle(message.handle);
        const items = Array.isArray(message.items) ? message.items : [];
        const result = await withCollectionLock('x', handle, async (state) => {
          // 停止・完了後や別タブ/別ジョブから遅れて届いたレスポンスを加算しない。
          if (!state || state.status !== 'collecting' ||
              (state.collectionId && message.collectionId !== state.collectionId) ||
              (sender.tab?.id && state.collectionTabId && sender.tab.id !== state.collectionTabId)) {
            return { state, addedCount: 0 };
          }
          const existing = new Set(state.items.map((item) => item.key));
          const relevantBoundaryBatch = state.deltaMode && /(?:\/|\b)UserMedia(?:\b|\/)/i.test(String(message.requestUrl || ''));
          const olderIds = new Set(state.deltaOlderPostIds || []);
          const priorOlderCount = olderIds.size;
          let addedCount = 0;
          const addedItems = [];
          for (const item of items) {
            if (state.deltaMode) {
              if (!validPostId(item?.postId)) continue;
              const relative = compareNumericPostIds(item.postId, state.deltaBaselinePostId);
              if (relative <= 0) {
                if (relevantBoundaryBatch) {
                  if (relative === 0) state.deltaBoundaryReached = true;
                  olderIds.add(String(item.postId));
                }
                // 既知の境界より古いメディアを、新しい差分ZIPに混ぜない。
                continue;
              }
            }
            if (!item?.key || existing.has(item.key)) continue;
            state.items.push(item);
            existing.add(item.key);
            addedItems.push(item);
            addedCount++;
            if (item.type === 'image') state.counts.images++;
            else if (item.type === 'video') state.counts.videos++;
          }
          markAddedItemsUnsaved(state, addedItems);
          state.counts.total = state.counts.images + state.counts.videos;
          if (state.deltaMode && relevantBoundaryBatch) {
            state.deltaOlderPostIds = [...olderIds].slice(0, 6);
            // 固定・引用などで古い1件が混ざっただけでは早期終了しない。
            if (olderIds.size >= 3) state.deltaBoundaryReached = true;
          }
          if (addedCount || (state.deltaMode && (state.deltaBoundaryReached || olderIds.size !== priorOlderCount))) {
            state.items.sort(comparePostIdsDesc);
            state.newestPostId = state.items[0]?.postId || null;
            state.oldestPostId = state.items[state.items.length - 1]?.postId || null;
            state.updatedAt = Date.now();
            await setCollection(state);
          }
          return { state, addedCount, boundaryReached: state.deltaMode && state.deltaBoundaryReached === true };
        });
        sendResponse({ ok: true, ...result });
        break;
      }

      case 'SMZ_COLLECTION_COMPLETE': {
        const handle = normalizeHandle(message.handle);
        const state = await withCollectionLock('x', handle, async (current) => {
          if (!current || current.status !== 'collecting' || (current.collectionMode === 'manual' && !current.deltaMode) ||
              (current.collectionId && message.collectionId !== current.collectionId) ||
              (sender.tab?.id && current.collectionTabId && sender.tab.id !== current.collectionTabId)) return null;
          if (current.deltaMode && !current.deltaBoundaryReached && !(current.collectionMode === 'auto' && message.endOfFeed === true)) {
            return null; // 手動の差分チェックは既知の境界が見えるまで自動確定しない。
          }
          return finishCollectionState(current, { endOfFeed: message.endOfFeed === true });
        });
        await clearResumeAlarm('x', handle);
        sendResponse({ ok: true, state });
        break;
      }

      case 'SMZ_FINISH_MANUAL_COLLECTION': {
        const handle = normalizeHandle(message.handle);
        const current = await getCollection('x', handle);
        const tabId = Number(message.tabId);
        if (!current || current.status !== 'collecting' || current.collectionMode !== 'manual' ||
            current.collectionId !== message.collectionId || !Number.isSafeInteger(tabId) ||
            tabId !== current.collectionTabId) {
          throw new Error('手動収集の対象タブまたは処理状態が一致しません');
        }
        if (current.deltaMode && !current.deltaBoundaryReached) {
          throw new Error('前回の投稿位置にまだ到達していません。続きをスクロールするか「停止」で一時保存してください');
        }
        if (Number(current.counts?.total || 0) < 1 && !(current.deltaMode && current.deltaBoundaryReached)) {
          throw new Error('まだメディアがありません。Xの /media を下へスクロールしてください');
        }
        const tab = await chrome.tabs.get(tabId);
        if (xHandleFromUrl(tab?.url) !== handle || new URL(tab.url).pathname.split('/')[2]?.toLowerCase() !== 'media') {
          throw new Error('対象ユーザーのメディアタブを確認できません');
        }
        // 先に受動監視を止める。未完了の通信結果をZIP対象に追加しない。
        const stopped = await sendToTab(tabId, { type: 'SMZ_FINISH_MANUAL_CAPTURE', handle, collectionId: current.collectionId });
        if (!stopped?.ok) throw new Error('Xタブの監視を停止できませんでした');
        const state = await withCollectionLock('x', handle, async (state) => {
          if (!state || state.status !== 'collecting' || state.collectionMode !== 'manual' ||
              state.collectionId !== message.collectionId) return null;
          return finishCollectionState(state, { manual: true });
        });
        if (!state) throw new Error('手動収集の状態が変わりました。更新してください');
        sendResponse({ ok: true, state });
        break;
      }

      case 'SMZ_COLLECTION_PHASE': {
        const handle = normalizeHandle(message.handle);
        const phase = message.phase === 'final_check' ? 'final_check' : null;
        const state = await withCollectionLock('x', handle, async (current) => {
          if (!current || current.status !== 'collecting' || current.collectionMode === 'manual' ||
              current.collectionId !== message.collectionId ||
              (sender.tab?.id && current.collectionTabId && sender.tab.id !== current.collectionTabId)) return null;
          if (current.collectionPhase !== phase) {
            current.collectionPhase = phase;
            current.updatedAt = Date.now();
            await setCollection(current);
          }
          return current;
        });
        sendResponse({ ok: true, state });
        break;
      }

      case 'SMZ_COLLECTION_MEDIA_COUNT': {
        const handle = normalizeHandle(message.handle);
        const mediaCount = Number(message.mediaCount);
        const state = await withCollectionLock('x', handle, async (current) => {
          if (!current || current.status !== 'collecting' ||
              (sender.tab?.id && current.collectionTabId && sender.tab.id !== current.collectionTabId)) return null;
          if (Number.isFinite(mediaCount) && mediaCount >= 0) current.displayMediaCount = Math.round(mediaCount);
          const needConfirmation = !current.deltaMode && Number(current.displayMediaCount || 0) >= 1000 && !current.largeWarningConfirmed;
          if (needConfirmation) {
            current.status = 'awaiting_confirmation';
            current.pauseReason = 'large_warning';
            current.resumeAt = null;
            current.confirmationTabId = sender.tab?.id || current.confirmationTabId || null;
            current.collectionTabId = sender.tab?.id || current.collectionTabId || null;
          }
          current.updatedAt = Date.now();
          await setCollection(current);
          return current;
        });
        sendResponse({
          ok: true,
          state,
          needConfirmation: !!state && state.status === 'awaiting_confirmation'
        });
        break;
      }

      case 'SMZ_COLLECTION_LARGE_CONFIRMED': {
        const handle = normalizeHandle(message.handle);
        const state = await withCollectionLock('x', handle, async (current) => {
          if (!current || current.status !== 'awaiting_confirmation') return null;
          current.largeWarningConfirmed = true;
          current.collectionTabId = message.tabId || current.collectionTabId;
          current.status = 'collecting';
          current.pauseReason = null;
          current.resumeAt = null;
          current.lastError = null;
          current.confirmationTabId = null;
          current.updatedAt = Date.now();
          await setCollection(current);
          return current;
        });
        if (state && message.tabId) {
          await sendToTab(message.tabId, {
            type: 'SMZ_RESUME_COLLECTION',
            handle,
            collectionId: state.collectionId,
            collectionMode: state.collectionMode || 'auto',
            deltaBaselinePostId: state.deltaBaselinePostId || null,
            automatic: false,
            skipLargeWarning: true
          });
        }
        sendResponse({ ok: true, state });
        break;
      }

      case 'SMZ_COLLECTION_LARGE_CANCELLED': {
        const handle = normalizeHandle(message.handle);
        const state = await withCollectionLock('x', handle, async (current) => {
          if (!current || current.status !== 'awaiting_confirmation') return null;
          current.status = 'paused';
          current.collectionPhase = null;
          current.pauseReason = 'large_cancelled';
          current.resumeAt = null;
          // 警告確認中にXが先読みしたメディアが入っていても、キャンセル時は収集開始前の状態へ戻す。
          current.items = [];
          current.counts = { images: 0, videos: 0, total: 0 };
          current.newestPostId = null;
          current.oldestPostId = null;
          current.archive = null;
          current.confirmationTabId = null;
          current.updatedAt = Date.now();
          await setCollection(current);
          return current;
        });
        if (message.tabId) {
          try { await sendToTab(message.tabId, { type: 'SMZ_STOP_COLLECTION', handle }); } catch {}
        }
        sendResponse({ ok: true, state });
        break;
      }

      case 'SMZ_COLLECTION_RATE_LIMIT': {
        const handle = normalizeHandle(message.handle);
        const now = Date.now();
        const fallbackWait = 15 * 60 * 1000;
        const simulated = message.simulated === true && !!sender.tab?.id;
        const resumeAt = Number(message.resumeAt) > now ? Number(message.resumeAt) : now + fallbackWait;
        const state = await withCollectionLock('x', handle, async (current) => {
          // 遅延したイベントが完了・中止済みや別の収集ジョブを上書きしないようにする。
          if (!current || current.status !== 'collecting') return null;
          if (message.collectionId && current.collectionId !== message.collectionId) return null;
          if (sender.tab && xHandleFromUrl(sender.tab.url) !== handle) return null;
          if (sender.tab && current.collectionTabId && sender.tab.id !== current.collectionTabId) return null;
          current.status = 'rate_limited';
          current.collectionPhase = null;
          current.pauseReason = 'rate_limit';
          current.resumeAt = resumeAt;
          current.rateLimitSimulated = simulated;
          current.lastError = simulated ? '疑似429テストで一時停止しました（実際のXの429ではありません）'
            : 'Xのアクセス制限（429）を検知しました';
          current.updatedAt = now;
          await setCollection(current);
          return current;
        });
        if (state) await startResumeAlarm(state);
        sendResponse({ ok: true, state });
        break;
      }

      case 'SMZ_COLLECTION_ERROR': {
        const handle = normalizeHandle(message.handle);
        const state = await withCollectionLock('x', handle, async (current) => {
          if (!current || current.status !== 'collecting' ||
              (current.collectionId && message.collectionId !== current.collectionId) ||
              (sender.tab?.id && current.collectionTabId && sender.tab.id !== current.collectionTabId)) return null;
          current.status = 'paused';
          current.collectionPhase = null;
          current.pauseReason = 'error';
          current.lastError = String(message.error || '不明なエラー');
          current.updatedAt = Date.now();
          await setCollection(current);
          return current;
        });
        sendResponse({ ok: true, state });
        break;
      }

      case 'SMZ_RESET_COLLECTION': {
        const handle = normalizeHandle(message.handle);
        const current = await getCollection(message.platform || 'x', handle);
        if (current?.archive?.status === 'archiving' || current?.status === 'collecting' || current?.status === 'rate_limited') {
          throw new Error('処理中は進捗をリセットできません');
        }
        await chrome.alarms.clear(`${RESUME_ALARM_PREFIX}${message.platform || 'x'}_${handle}`);
        await chrome.storage.local.remove([
          collectionKey(message.platform || 'x', handle),
          previousCollectionKey(message.platform || 'x', handle)
        ]);
        await restoreToolbarState();
        sendResponse({ ok: true });
        break;
      }

      case 'SMZ_START_ARCHIVE': {
        const startedState = await withArchiveStartLock(async () => {
          const handle = normalizeHandle(message.handle);
          const platform = ['x','bluesky','threads'].includes(message.platform) ? message.platform : 'x';
          const state = await getCollection(platform, handle);
          const collectionCanArchive = state && ['paused', 'complete'].includes(state.status);
          if (!state || !collectionCanArchive) {
            throw new Error('メディアを収集中はZIP保存できません。収集を停止するか完了まで待ってください');
          }
          if (state.deltaMode && state.deltaVerified !== true && state.pauseReason === 'delta_boundary_missing') {
            throw new Error('前回の保存済み投稿との境界を確認できないため、この候補はZIP保存できません。前回の状態へ戻してください');
          }
          if (!(state.counts?.total > 0)) throw new Error('保存できるメディアがまだありません');
          const selection = {
            images: message.selection?.images !== false,
            videos: message.selection?.videos !== false
          };
          if (!selection.images && !selection.videos) throw new Error('画像または動画を選択してください');
          const selectedKeys = selectedArchiveItemKeys(state, selection);
          const selectedCount = Array.isArray(state.items) ? selectedKeys.length :
            ((selection.images ? Number(state.counts?.images || 0) : 0) + (selection.videos ? Number(state.counts?.videos || 0) : 0));
          if (!selectedCount) throw new Error('選択されたメディアがありません。画像・動画のチェックを変更してください');

          await ensureOffscreenDocument();
          const offscreenStatus = await chrome.runtime.sendMessage({ target:'offscreen', type:'SMZ_OFFSCREEN_GET_STATUS' });
          if (offscreenStatus?.active) {
            throw new Error(`別のZIP保存が進行中です${offscreenStatus.handle ? `（@${offscreenStatus.handle}）` : ''}`);
          }

          // 次のZIP処理を開始したら、以前の完了通知は自動的に解除する。
          await acknowledgeArchiveCompletions();
          if (!state.collectionId) {
            state.collectionId = makeCollectionId();
            state.schemaVersion = Math.max(Number(state.schemaVersion) || 1, 2);
          }
          let splitMode = ['auto', '500mb', '1gb', '500files'].includes(message.splitMode) ? message.splitMode : 'auto';
          const runLimit = Number(message.runLimit) === 5 ? 5 : null;
          const mediaKind = archiveMediaKind(selection);

          // v0.0.23以前に10ファイル分割で停止した作業だけは、更新後に表示される
          // 「自動」を押してもそのまま続きを保存できるよう、既存ジョブを優先する。
          if (splitMode === 'auto' && state.archive?.splitMode === '10files' &&
              state.archive.status === 'archive_paused' &&
              state.archive.collectionId === state.collectionId &&
              state.archive.selection?.images === selection.images &&
              state.archive.selection?.videos === selection.videos &&
              (state.archive.mediaKind || archiveMediaKind(state.archive.selection)) === mediaKind) {
            splitMode = '10files';
          }

          // v1.3.0以前はnextItemIndexだけで再開していたため、収集再開後の並べ替えで
          // 新しい先頭項目を飛ばす可能性があった。itemKeysが無い進行済み旧ジョブは
          // 安全側で新規ジョブとして再保存し、以後はジョブ内の順序を固定する。
          const hasFrozenOrder = Array.isArray(state.archive?.itemKeys) || Number(state.archive?.nextItemIndex || 0) === 0 || !Array.isArray(state.items);
          const sameJob = state.archive && hasFrozenOrder &&
            state.archive.collectionId === state.collectionId &&
            state.archive.selection?.images === selection.images &&
            state.archive.selection?.videos === selection.videos &&
            state.archive.splitMode === splitMode &&
            (state.archive.mediaKind || archiveMediaKind(state.archive.selection)) === mediaKind;

          // First v1.3.1+ archive after an older kind-by-kind save: carry forward only
          // explicit keys from a completed legacy archive before that archive object is replaced.
          // Unknown legacy order (no itemKeys) deliberately remains unknown and will be re-saved.
          migrateTrustedLegacySavedItemKeys(state);

          const priorArchive = state.archive ? JSON.parse(JSON.stringify(state.archive)) : null;
          if (!sameJob) {
            state.archive = {
              status: 'archiving',
              selection,
              splitMode,
              mediaKind,
              runLimit,
              saveMode: message.saveMode === 'directory' ? 'directory' : 'downloads',
              saveDirectoryKey: message.saveDirectoryKey || null,
              saveDirectoryName: message.saveDirectoryName || null,
              collectionId: state.collectionId,
              collectionCompletedAt: state.completedAt,
              jobId: makeCollectionId(),
              itemKeys: selectedKeys,
              nextItemIndex: 0,
              nextZipNumber: 1,
              savedZipCount: 0,
              processedItems: 0,
              failedItems: 0,
              totalSelected: selectedCount,
              currentZipNumber: 1,
              currentFileCount: 0,
              progress: 0,
              startedAt: Date.now(),
              updatedAt: Date.now(),
              completedAt: null,
              completionAcknowledged: true,
              completionAcknowledgedAt: null,
              lastError: null,
              failures: []
            };
          } else {
            const frozen = Array.isArray(state.archive.itemKeys) ? state.archive.itemKeys.slice() : [];
            const seen = new Set(frozen);
            for (const key of selectedKeys) if (!seen.has(key)) { seen.add(key); frozen.push(key); }
            if (selectedKeys.length || Array.isArray(state.archive.itemKeys)) state.archive.itemKeys = frozen;
            state.archive.jobId = state.archive.jobId || makeCollectionId();
            state.archive.status = 'archiving';
            state.archive.runLimit = runLimit;
            state.archive.mediaKind = mediaKind;
            state.archive.saveMode = message.saveMode === 'directory' ? 'directory' : (state.archive.saveMode || 'downloads');
            state.archive.saveDirectoryKey = message.saveDirectoryKey || state.archive.saveDirectoryKey || null;
            state.archive.saveDirectoryName = message.saveDirectoryName || state.archive.saveDirectoryName || null;
            state.archive.collectionId = state.collectionId;
            state.archive.collectionCompletedAt = state.completedAt;
            if (selectedKeys.length) state.archive.totalSelected = frozen.length;
            state.archive.completedAt = null;
            state.archive.completionAcknowledged = true;
            state.archive.completionAcknowledgedAt = null;
            state.archive.pauseReason = null;
            state.archive.updatedAt = Date.now();
            state.archive.lastError = null;
          }

          // 収集状態（paused / complete）はZIP処理と独立して保持する。
          await setCollection(state);
          const startResult = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'SMZ_OFFSCREEN_START_ARCHIVE',
            platform,
            handle,
            jobId: state.archive.jobId,
            selection,
            splitMode,
            mediaKind,
            runLimit,
            saveMode: state.archive?.saveMode || 'downloads',
            saveDirectoryKey: state.archive?.saveDirectoryKey || null,
            saveDirectoryName: state.archive?.saveDirectoryName || null
          });
          if (!startResult?.ok) {
            if (priorArchive) state.archive = priorArchive;
            else delete state.archive;
            await setCollection(state);
            throw new Error(startResult?.error || 'ZIP保存を開始できませんでした');
          }
          return state;
        });
        sendResponse({ ok: true, state: startedState });
        break;
      }

      case 'SMZ_STOP_ARCHIVE': {
        const platform = ['x','bluesky','threads'].includes(message.platform) ? message.platform : 'x';
        const handle = normalizeHandle(message.handle);
        const state = handle ? await getCollection(platform, handle) : null;
        const jobId = String(message.jobId || state?.archive?.jobId || '');
        if (!handle || !jobId) throw new Error('停止するZIP保存ジョブを確認できません');
        const stopped = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'SMZ_OFFSCREEN_STOP_ARCHIVE', platform, handle, jobId });
        if (!stopped?.ok) throw new Error(stopped?.error || 'ZIP保存を停止できませんでした');
        sendResponse({ ok: true });
        break;
      }

      case 'SMZ_ARCHIVE_GET_STATE': {
        const current = await getCollection(message.platform || 'x', message.handle);
        const previous = (await chrome.storage.local.get(previousCollectionKey(message.platform || 'x', message.handle)))[previousCollectionKey(message.platform || 'x', message.handle)] || null;
        sendResponse({ ok: true, state: current, previous });
        break;
      }

      case 'SMZ_ARCHIVE_PATCH': {
        const handle = normalizeHandle(message.handle);
        const state = await withCollectionLock(message.platform || 'x', handle, async (current) => {
          if (!current) return null;
          const patch = { ...(message.patch || {}) };
          if (patch.status === 'archive_complete') {
            patch.completionAcknowledged = false;
            patch.completionAcknowledgedAt = null;
          } else if (patch.status === 'archiving') {
            patch.completionAcknowledged = true;
            patch.completionAcknowledgedAt = null;
          }
          current.archive = { ...(current.archive || {}), ...patch, updatedAt: Date.now() };
          if (patch.status === 'archive_complete' &&
              Number(current.archive.nextItemIndex ?? current.archive.processedItems ?? 0) >= Number(current.archive.totalSelected || 0)) {
            const kinds = { ...(current.savedKinds || {}) };
            if (current.archive.selection?.images) kinds.images = true;
            if (current.archive.selection?.videos) kinds.videos = true;
            current.savedKinds = kinds;
            if (current.deltaMode) current.deltaSavedKinds = { ...(current.deltaSavedKinds || {}),
              ...(current.archive.selection?.images ? { images: true } : {}),
              ...(current.archive.selection?.videos ? { videos: true } : {}) };
            const processedKeys = Array.isArray(current.archive.itemKeys)
              ? current.archive.itemKeys
              : selectedArchiveItemKeys(current, current.archive.selection || {});
            const savedKeys = new Set(Array.isArray(current.savedItemKeys) ? current.savedItemKeys : []);
            for (const key of processedKeys) if (typeof key === 'string' && key) savedKeys.add(key);
            current.savedItemKeys = [...savedKeys];
          }
          await setCollection(current);
          return current;
        });
        sendResponse({ ok: true, state });
        break;
      }

      case 'SMZ_BACKUP_EXPORT': {
        if (sender.url !== chrome.runtime.getURL('options/options.html')) throw new Error('設定画面から実行してください');
        const all = await chrome.storage.local.get(null);
        if (Object.entries(all).some(([key, value]) => key.startsWith(COLLECTION_PREFIX) &&
            ['collecting', 'rate_limited', 'awaiting_confirmation'].includes(value?.status) ||
            key.startsWith(COLLECTION_PREFIX) && value?.archive?.status === 'archiving')) {
          throw new Error('収集またはZIP処理中です。安全なバックアップのため、終了または停止後に書き出してください');
        }
        const data = SMZBackup.fullEnvelope(all);
        if (message.platform && message.platform !== 'all') {
          if (!['x','bluesky','threads'].includes(message.platform)) throw new Error('選択したSNSが不正です');
          data.accounts = data.accounts.filter(entry => entry.current.platform === message.platform);
          data.partial = true; data.settings = null;
        }
        if (Array.isArray(message.selectedAccounts)) {
          const selected = new Set(message.selectedAccounts.filter(v => typeof v === 'string' && v.length < 300));
          data.accounts = data.accounts.filter(entry => selected.has(`${entry.current.platform}:${entry.current.handle}`));
          data.partial = true; data.settings = null;
        }
        sendResponse({ ok: true, data });
        break;
      }

      case 'SMZ_BACKUP_LIST': {
        if (sender.url !== chrome.runtime.getURL('options/options.html')) throw new Error('設定画面から実行してください');
        const all = await chrome.storage.local.get(null);
        sendResponse({ ok: true, accounts: Object.entries(all)
          .filter(([key, value]) => key.startsWith(COLLECTION_PREFIX) && value?.handle)
          .map(([, value]) => {
            let cumulative = SMZBackup.cumulativeCounts(value);
            if (!cumulative && value?.deltaMode === true) {
              const previous = all[previousCollectionKey(value.platform || 'x', value.handle)] || null;
              const base = SMZBackup.cumulativeCounts(previous);
              if (base) cumulative = {
                images: base.images + Number(value.counts?.images || 0),
                videos: base.videos + Number(value.counts?.videos || 0),
                total: base.total + Number(value.counts?.total || 0)
              };
            }
            return { handle: value.handle, platform: value.platform || 'x', updatedAt: value.updatedAt || 0,
              count: Number(cumulative?.total ?? value.counts?.total ?? 0), currentCount: Number(value.counts?.total || 0),
              deltaMode: value.deltaMode === true, status: value.status };
          }) });
        break;
      }

      case 'SMZ_BACKUP_IMPORT': {
        if (sender.url !== chrome.runtime.getURL('options/options.html')) throw new Error('設定画面から実行してください');
        const backup = SMZBackup.normalizeImport(message.data);
        const mode = ['merge','replace-accounts','replace-all'].includes(message.mode) ? message.mode : 'merge';
        if (mode === 'replace-all' && (backup.format !== SMZBackup.FULL_FORMAT || backup.partial || Array.isArray(message.selectedAccounts))) {
          throw new Error('全体置換には拡張全体のJSONバックアップが必要です');
        }
        const all = await chrome.storage.local.get(null);
        const selectedAccounts = Array.isArray(message.selectedAccounts)
          ? new Set(message.selectedAccounts.filter(v => typeof v === 'string' && v.length < 300)) : null;
        const processing = (value) => ['collecting','rate_limited','awaiting_confirmation'].includes(value?.status) || value?.archive?.status === 'archiving';
        if (mode === 'replace-all') {
          // 全体置換はすべての収集状態を削除するため、従来どおり全アカウント停止が必要。
          if (Object.entries(all).some(([key, value]) => key.startsWith(COLLECTION_PREFIX) && processing(value))) {
            throw new Error('全体置換は収集やZIP保存がすべて終わってから実行してください');
          }
        } else if (mode === 'replace-accounts') {
          // アカウント置換は実際に上書きする対象だけをロックする。
          // 別SNS・別アカウントの収集中でも、安全に独立した状態を復元できる。
          for (const item of backup.accounts) {
            const id = `${item.current.platform}:${item.current.handle}`;
            if (selectedAccounts && !selectedAccounts.has(id)) continue;
            const current = all[collectionKey(item.current.platform, item.current.handle)];
            if (processing(current)) {
              throw new Error(`${item.current.platform === 'threads' ? 'Threads' : item.current.platform === 'bluesky' ? 'Bluesky' : 'X'} @${item.current.handle} は処理中のため上書きできません`);
            }
          }
        }
        // mergeは既存アカウントを上書きしないため、別アカウントの処理中でも安全。
        const patch = {};
        const remove = [];
        let imported = 0;
        let skipped = 0;
        if (mode === 'replace-all') {
          for (const key of Object.keys(all)) {
            if (key.startsWith(COLLECTION_PREFIX) || key.startsWith(PREVIOUS_COLLECTION_PREFIX)) remove.push(key);
          }
        }
        for (const item of backup.accounts) {
          if (selectedAccounts && !selectedAccounts.has(`${item.current.platform}:${item.current.handle}`)) continue;
          const handle = item.current.handle;
          const platform = item.current.platform || 'x';
          const key = collectionKey(platform, handle);
          const prev = previousCollectionKey(platform, handle);
          if (all[key] && mode === 'merge') { skipped++; continue; }
          // 復元後は古いタブID・保存先ハンドルを引き継がず、明示操作で再開。
          patch[key] = item.current;
          if (item.previous) patch[prev] = item.previous;
          else if (mode === 'replace-accounts' && all[prev]) remove.push(prev);
          imported++;
        }
        if (mode === 'replace-all') patch.smz_user_settings_v1 = backup.settings;
        else if (backup.settings && !all.smz_user_settings_v1) patch.smz_user_settings_v1 = backup.settings;
        // 先に新データを保存する。途中でChromeが終了しても、既存情報が
        // 消えただけの状態にならない順序にする。
        if (Object.keys(patch).length) await chrome.storage.local.set(patch);
        const staleKeys = [...new Set(remove)].filter((key) => !(key in patch));
        if (staleKeys.length) await chrome.storage.local.remove(staleKeys);
        await restoreToolbarState();
        sendResponse({ ok: true, imported, skipped });
        break;
      }

      case 'SMZ_BACKUP_DELETE_SELECTED': {
        if (sender.url !== chrome.runtime.getURL('options/options.html')) throw new Error('設定画面から実行してください');
        if (!Array.isArray(message.accounts) || !message.accounts.length || message.accounts.length > 1000) {
          throw new Error('削除するアカウントを選択してください');
        }
        const all = await chrome.storage.local.get(null);
        const keys = [];
        const directoryKeys = new Set();
        for (const id of new Set(message.accounts)) {
          if (typeof id !== 'string' || id.length > 300) throw new Error('対象の形式が不正です');
          const sep = id.indexOf(':');
          const platform = id.slice(0,sep), handle = id.slice(sep+1);
          if (!['x','bluesky','threads'].includes(platform) || !handle || !/^[a-z0-9._-]{1,253}$/.test(handle)) throw new Error('対象が不正です');
          const currentKey = collectionKey(platform,handle), previousKey = previousCollectionKey(platform,handle);
          const current = all[currentKey];
          if (!current) continue;
          if (current.handle !== handle || (current.platform || 'x') !== platform) throw new Error('削除対象の状態が一致しません');
          if (['collecting','rate_limited','awaiting_confirmation'].includes(current.status) || current.archive?.status === 'archiving') {
            throw new Error('収集またはZIP保存中のアカウントは削除できません');
          }
          for (const state of [current,all[previousKey]]) {
            for (const k of [state?.archive?.saveDirectoryKey,state?.preferredSaveDirectoryKey]) {
              if (typeof k === 'string' && /^archive-directory:[a-zA-Z0-9._-]{1,100}$/.test(k)) directoryKeys.add(k);
            }
          }
          keys.push(currentKey,previousKey);
        }
        if (!keys.length) { sendResponse({ok:true, deleted:0}); break; }
        if ((await getOffscreenRuntimeStatus()).active) throw new Error('ZIP保存を停止してから削除してください');
        if (directoryKeys.size) {
          await ensureOffscreenDocument();
          const cleared = await chrome.runtime.sendMessage({target:'offscreen',type:'SMZ_OFFSCREEN_REMOVE_HANDLES',keys:[...directoryKeys]});
          if (!cleared?.ok) throw new Error(cleared?.error || '保存先情報を削除できませんでした');
        }
        await chrome.storage.local.remove(keys);
        await restoreToolbarState();
        sendResponse({ok:true, deleted:keys.length/2});
        break;
      }

      case 'SMZ_BACKUP_RESET_ALL': {
        if (sender.url !== chrome.runtime.getURL('options/options.html')) throw new Error('設定画面から実行してください');
        if (fullResetInProgress) throw new Error('初期化処理が進行中です');
        fullResetInProgress = true;
        try {
          const all = await chrome.storage.local.get(null);
          const processing = Object.entries(all).some(([key, value]) => key.startsWith(COLLECTION_PREFIX) &&
            (['collecting', 'rate_limited', 'awaiting_confirmation'].includes(value?.status) ||
             value?.archive?.status === 'archiving'));
          if (processing || (await getOffscreenRuntimeStatus()).active) {
            throw new Error('収集またはZIP保存を停止してから初期化してください');
          }

          // IndexedDB の保存先ハンドルを先に消去。失敗時は収集情報を残してやり直せる。
          await ensureOffscreenDocument();
          const cleared = await chrome.runtime.sendMessage({
            target: 'offscreen', type: 'SMZ_OFFSCREEN_CLEAR_HANDLES'
          });
          if (!cleared?.ok) throw new Error(cleared?.error || '保存先情報の初期化に失敗しました');

          // この拡張専用のchrome.storage.localのみ。Chrome本体のログイン情報、
          // OSのZIP/JSON、ブラウザのダウンロード履歴には一切触れない。
          await chrome.alarms.clearAll();
          await chrome.storage.local.clear();
          pendingDownloadNames.clear();
          collectionQueues.clear();
          await restoreToolbarState();
          sendResponse({ ok: true });
        } finally {
          fullResetInProgress = false;
        }
        break;
      }

      case 'SMZ_DOWNLOAD_BLOB': {
        const desiredName = String(message.filename || '').trim();
        if (desiredName) pendingDownloadNames.set(message.url, desiredName);
        try {
          const id = await chrome.downloads.download({
            url: message.url,
            filename: desiredName || undefined,
            saveAs: false,
            conflictAction: 'uniquify'
          });
          sendResponse({ ok: true, downloadId: id });
        } catch (error) {
          pendingDownloadNames.delete(message.url);
          throw error;
        }
        break;
      }

      case 'SMZ_CHECK_DOWNLOAD': {
        const results = await chrome.downloads.search({ id: Number(message.downloadId) });
        const item = results[0] || null;
        sendResponse({
          ok: true,
          state: item?.state || 'missing',
          error: item?.error || null,
          filename: item?.filename || null
        });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'unknown_message' });
    }
  })().catch((error) => {
    console.error('[Simple Marugoto ZIP]', error);
    sendResponse({ ok: false, error: error.message || String(error) });
  });

  return true;
});


// 「大量件数の確認待ち」は現在表示しているアカウント/タブにだけ黄色い「確」を出す。
// タブ移動やURL変更時にツールバーを再評価する。
chrome.tabs.onActivated.addListener(() => {
  restoreToolbarState().catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    restoreToolbarState().catch(() => {});
  }
});
chrome.windows.onFocusChanged.addListener(() => {
  restoreToolbarState().catch(() => {});
});

// Service Worker再起動後はBluesky/ThreadsのAPI収集を、最後に保存できた
// ページcursorから復旧する。cursorはメディア本体と同じstorage書き込みで進めるため、
// 再取得が起きても重複排除でき、未保存ページを飛ばさない。
apiRecoveryPromise = recoverApiCollections().catch(() => 0);
void apiRecoveryPromise.finally(() => restoreToolbarState().catch(() => {}));
