'use strict';
// node tests/delta-collection.test.cjs -- Xへアクセスしない差分収集の回帰テスト。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function media(postId, type = 'image', index = 1) {
  return { key: `${postId}_${index}`, postId: String(postId), type,
    mediaIndex: index, url: `https://pbs.twimg.com/media/${postId}.jpg`, extension: type === 'image' ? 'jpg' : 'mp4' };
}
function harness(initial) {
  const collections = { smz_collection_x_demo: clone(initial) };
  const tabs = [{ id: 11, url: 'https://x.com/demo/media', active: true }];
  const tabMessages = [];
  const alarms = new Map();
  let handler;
  const chrome = {
    storage: { local: {
      async get(key) { return key === null ? clone(collections) : { [key]: clone(collections[key]) }; },
      async set(patch) { Object.assign(collections, clone(patch)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete collections[key]; }
    } },
    runtime: { onMessage: { addListener(fn) { handler = fn; } },
      async sendMessage(message) { if (message.target === 'offscreen') return { ok: true }; throw Error(`unexpected ${message.type}`); } },
    tabs: { async query() { return clone(tabs); }, async get(id) { return clone(tabs.find((t) => t.id === id)); },
      async sendMessage(tabId, message) { tabMessages.push(clone(message)); return { ok: true }; },
      onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    action: { async setIcon() {}, async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setBadgeTextColor() {}, async setTitle() {} },
    alarms: { async clear(key) { alarms.delete(key); }, async create(key, value) { alarms.set(key, value); }, onAlarm: { addListener() {} } },
    downloads: { onDeterminingFilename: { addListener() {} } },
    scripting: { async executeScript() {} },
    windows: { onFocusChanged: { addListener() {} } },
    offscreen: { async hasDocument() { return true; }, async createDocument() {} }
  };
  vm.runInNewContext(read('backup/schema.js') + '\n' + read('background.js'), { chrome, URL, console: { ...console, error() {} }, setTimeout, clearTimeout }, { filename: 'background.js' });
  async function send(msg, sender = { url: 'chrome-extension://test/popup.html' }) {
    return new Promise((resolve) => assert.equal(handler(clone(msg), clone(sender), resolve), true));
  }
  const fromTab = { tab: { id: 11, url: 'https://x.com/demo/media' } };
  return { collections, tabMessages, tabs, send, fromTab };
}
const previous = {
  schemaVersion: 3, collectionId: 'old-full-job', platform: 'x', handle: 'demo',
  status: 'complete', collectionMode: 'auto', completedAt: Date.now() - 86400000,
  counts: { images: 2, videos: 1, total: 3 },
  items: [media('2100'), media('2090'), media('2080', 'video')],
  newestPostId: '2100', oldestPostId: '2080', updatedAt: Date.now() - 86400000,
  archive: { status: 'archive_complete', saveDirectoryKey: 'archive-directory:old-full-job',
    saveDirectoryName: 'X Backup', completionAcknowledged: true, savedZipCount: 1,
    totalSelected: 3, processedItems: 3, selection: { images: true, videos: true } }
};
async function testNewOnly() {
  const h = harness(previous);
  await tick();
  let r = await h.send({ type: 'SMZ_START_COLLECTION', handle: 'demo', tabId: 11, collectionMode: 'manual', newOnly: true, forceReload: true });
  assert.equal(r.ok, true, r.error);
  let state = h.collections.smz_collection_x_demo;
  const firstId = state.collectionId;
  assert.equal(state.status, 'collecting');
  assert.equal(state.deltaMode, true);
  assert.equal(state.deltaBaselinePostId, '2100');
  assert.equal(state.counts.total, 0);
  assert.equal(state.archive, null);
  assert.equal(state.preferredSaveDirectoryName, 'X Backup');
  assert.equal(h.collections.smz_previous_collection_x_demo.collectionId, 'old-full-job');
  assert.equal(h.collections.smz_previous_collection_x_demo.items.length, 3);
  assert.equal(h.tabMessages.at(-1).deltaBaselinePostId, '2100');

  r = await h.send({ type: 'SMZ_COLLECTION_MEDIA_COUNT', handle: 'demo', mediaCount: 37_000 }, h.fromTab);
  assert.equal(r.needConfirmation, false, 'new-only scan should not show the full-account warning');
  // SearchTimelineに載る古い投稿は境界判定に使わない。
  r = await h.send({ type: 'SMZ_ADD_MEDIA', handle: 'demo', collectionId: firstId,
    requestUrl: 'https://x.com/i/api/graphql/abc/SearchTimeline', items: [media('2050')] }, h.fromTab);
  assert.equal(r.addedCount, 0);
  assert.equal(r.boundaryReached, false);
  r = await h.send({ type: 'SMZ_ADD_MEDIA', handle: 'demo', collectionId: firstId,
    requestUrl: 'https://x.com/i/api/graphql/abc/UserMedia',
    items: [media('2200'), media('2200'), media('2100'), media('2090'), media('2200', 'video', 2)] }, h.fromTab);
  assert.equal(r.addedCount, 2, 'only previously unseen media above the checkpoint are retained');
  assert.equal(r.boundaryReached, true, 'exact previous ID reaches the boundary');
  assert.equal(h.collections.smz_collection_x_demo.counts.total, 2);
  assert.deepEqual(h.collections.smz_collection_x_demo.items.map((x) => x.postId), ['2200','2200']);
  r = await h.send({ type: 'SMZ_ADD_MEDIA', handle: 'demo', collectionId: firstId,
    requestUrl: 'https://x.com/i/api/graphql/abc/UserMedia', items: [media('2250')] },
    { tab: { id: 12, url: 'https://x.com/demo/media' } });
  assert.equal(r.addedCount, 0, 'another tab cannot contaminate the active delta');
  r = await h.send({ type: 'SMZ_COLLECTION_COMPLETE', handle: 'demo', collectionId: firstId, endOfFeed: false }, h.fromTab);
  assert.equal(r.state.status, 'complete');
  assert.equal(r.state.deltaVerified, true);
  assert.equal(r.state.deltaEndReason, 'previous_boundary');
  assert.equal(r.state.newestPostId, '2200');
  assert.equal(h.collections.smz_previous_collection_x_demo.items.length, 3);

  r = await h.send({ type: 'SMZ_START_COLLECTION', handle: 'demo', tabId: 11, collectionMode: 'auto', newOnly: true });
  assert.equal(r.ok, false, 'cannot discard a positive unsaved delta');
  // ダウンロード先は以前のアカウント用フォルダを再利用し、現在の差分だけZIPへ渡す。
  r = await h.send({ type: 'SMZ_START_ARCHIVE', handle: 'demo', selection: { images: true, videos: true },
    splitMode: '10files', runLimit: null, saveMode: 'directory',
    saveDirectoryKey: state.preferredSaveDirectoryKey, saveDirectoryName: state.preferredSaveDirectoryName });
  assert.equal(r.ok, true, r.error);
  assert.equal(h.collections.smz_collection_x_demo.archive.saveDirectoryName, 'X Backup');
  await h.send({ type: 'SMZ_ARCHIVE_PATCH', handle: 'demo', patch: { status: 'archive_complete',
    totalSelected: 2, nextItemIndex: 2, processedItems: 2, failedItems: 0 } });
  assert.equal(h.collections.smz_collection_x_demo.deltaSavedKinds.images, true);
  assert.equal(h.collections.smz_collection_x_demo.deltaSavedKinds.videos, true);
  r = await h.send({ type: 'SMZ_START_COLLECTION', handle: 'demo', tabId: 11, collectionMode: 'manual', newOnly: true });
  assert.equal(r.ok, true, r.error);
  state = h.collections.smz_collection_x_demo;
  assert.equal(state.deltaBaselinePostId, '2200');
  assert.equal(state.counts.total, 0);
  const secondId = state.collectionId;
  // 最新側に新規がない場合、前回のZIP情報を丸ごと復元する。
  r = await h.send({ type: 'SMZ_ADD_MEDIA', handle: 'demo', collectionId: secondId,
    requestUrl: 'https://x.com/i/api/graphql/abc/UserMedia', items: [media('2200'), media('2150')] }, h.fromTab);
  assert.equal(r.boundaryReached, true);
  r = await h.send({ type: 'SMZ_COLLECTION_COMPLETE', handle: 'demo', collectionId: secondId }, h.fromTab);
  assert.equal(r.state.status, 'complete');
  assert.equal(r.state.collectionId, firstId);
  assert.equal(r.state.counts.total, 2);
  assert.equal(r.state.lastNewCheckResult, 0);
  assert.equal(r.state.archive.status, 'archive_complete');
  assert.equal(h.collections.smz_previous_collection_x_demo, undefined);

  // 境界が削除されていても、Xのメディア欄末尾まで到達すれば完全チェックとみなす。
  r = await h.send({ type: 'SMZ_START_COLLECTION', handle: 'demo', tabId: 11, collectionMode: 'auto', newOnly: true });
  assert.equal(r.ok, true);
  const thirdId = r.state.collectionId;
  r = await h.send({ type: 'SMZ_ADD_MEDIA', handle: 'demo', collectionId: thirdId,
    requestUrl: 'https://x.com/i/api/graphql/abc/UserMedia', items: [media('2300'), media('2100')] }, h.fromTab);
  assert.equal(r.addedCount, 1);
  r = await h.send({ type: 'SMZ_COLLECTION_COMPLETE', handle: 'demo', collectionId: thirdId, endOfFeed: true }, h.fromTab);
  assert.equal(r.state.status, 'complete');
  assert.equal(r.state.deltaVerified, true);
  assert.equal(r.state.deltaEndReason, 'end_of_feed');
  assert.equal(r.state.items.length, 1);
  console.log('PASS delta background: legacy upgrade, separate checkpoint, new-only filter, per-account guard, UserMedia boundary, skip large warning, 0-new restore, ZIP folder reuse, no-unsaved-replace, end-of-feed fallback');
}

async function testPauseResumeAndNoNew() {
  const h = harness(previous);
  await tick();
  let r = await h.send({ type: 'SMZ_START_COLLECTION', handle: 'demo', tabId: 11, collectionMode: 'manual', newOnly: true });
  const id = r.state.collectionId;
  r = await h.send({ type: 'SMZ_ADD_MEDIA', handle: 'demo', collectionId: id,
    requestUrl: 'https://x.com/i/api/graphql/abc/UserMedia', items: [media('2200')] }, h.fromTab);
  assert.equal(r.addedCount, 1);
  r = await h.send({ type: 'SMZ_FINISH_MANUAL_COLLECTION', handle: 'demo', tabId: 11, collectionId: id });
  assert.equal(r.ok, false, 'manual delta cannot silently claim full coverage before checkpoint');
  await h.send({ type: 'SMZ_STOP_COLLECTION', handle: 'demo', tabId: 11 });
  assert.equal(h.collections.smz_collection_x_demo.status, 'paused');
  r = await h.send({ type: 'SMZ_START_COLLECTION', handle: 'demo', tabId: 11, collectionMode: 'manual', restart: false, forceReload: false });
  assert.equal(r.state.collectionId, id);
  assert.equal(r.state.counts.total, 1);
  assert.equal(h.tabMessages.at(-1).deltaBaselinePostId, '2100');
  r = await h.send({ type: 'SMZ_ADD_MEDIA', handle: 'demo', collectionId: id,
    requestUrl: 'https://x.com/i/api/graphql/abc/UserMedia', items: [media('2200'), media('2100')] }, h.fromTab);
  assert.equal(r.addedCount, 0);
  assert.equal(r.boundaryReached, true);
  r = await h.send({ type: 'SMZ_COLLECTION_COMPLETE', handle: 'demo', collectionId: id }, h.fromTab);
  assert.equal(r.state.status, 'complete');
  assert.equal(r.state.counts.total, 1);

  const empty = harness(previous);
  await tick();
  r = await empty.send({ type: 'SMZ_START_COLLECTION', handle: 'demo', tabId: 11, collectionMode: 'auto', newOnly: true });
  const emptyId = r.state.collectionId;
  r = await empty.send({ type: 'SMZ_ADD_MEDIA', handle: 'demo', collectionId: emptyId,
    requestUrl: 'https://x.com/i/api/graphql/abc/UserMedia', items: [media('2100')] }, empty.fromTab);
  assert.equal(r.boundaryReached, true);
  r = await empty.send({ type: 'SMZ_COLLECTION_COMPLETE', handle: 'demo', collectionId: emptyId }, empty.fromTab);
  assert.equal(r.state.collectionId, 'old-full-job');
  assert.equal(r.state.items.length, 3);
  assert.equal(r.state.lastNewCheckResult, 0);
  console.log('PASS delta pause/resume: no early manual completion, preserve partial items, avoid duplicate, restore unsaved previous state when no new');
}

async function testUnsavedGuardAndRollback() {
  const unarchived = harness({ ...previous, archive: null });
  await tick();
  let r = await unarchived.send({ type: 'SMZ_START_COLLECTION', handle: 'demo', tabId: 11, newOnly: true });
  assert.equal(r.ok, false, 'never replace a full collection whose ZIP has not been saved');
  assert.equal(unarchived.collections.smz_collection_x_demo.collectionId, 'old-full-job');

  const h = harness(previous);
  await tick();
  r = await h.send({ type: 'SMZ_START_COLLECTION', handle: 'demo', tabId: 11, collectionMode: 'manual', newOnly: true });
  const id = r.state.collectionId;
  await h.send({ type: 'SMZ_ADD_MEDIA', handle: 'demo', collectionId: id,
    requestUrl: 'https://x.com/i/api/graphql/abc/UserMedia', items: [media('2200')] }, h.fromTab);
  await h.send({ type: 'SMZ_STOP_COLLECTION', handle: 'demo', tabId: 11 });
  r = await h.send({ type: 'SMZ_CANCEL_DELTA', handle: 'demo' });
  assert.equal(r.ok, true);
  assert.equal(r.state.collectionId, 'old-full-job');
  assert.equal(r.state.archive.status, 'archive_complete');
  assert.equal(h.collections.smz_previous_collection_x_demo, undefined);
  assert.equal(h.collections.smz_collection_x_demo.counts.total, 3);
  console.log('PASS delta safety: block unsaved full collection; user can discard paused delta and recover previous ZIP state');
}

(async () => { await testNewOnly(); await testPauseResumeAndNoNew(); await testUnsavedGuardAndRollback();
  console.log('PASS v0.0.20 delta offline regression suite'); })()
  .catch((error) => { console.error(error); process.exitCode = 1; });

// 疑似レスポンスだけを用いてcontent.jsの受動手動モードが境界で自動終了することを確認。
async function testManualDeltaContent() {
  let clock = Date.now();
  class FakeDate extends Date { static now() { return clock; } }
  const timers = new Map();
  const windowHandlers = new Map();
  const sent = [];
  const hooks = [];
  let nextTimer = 1;
  let contentListener;
  let scrollCount = 0;
  const win = {
    scrollY: 0, innerHeight: 800, scrollTo() { scrollCount++; },
    addEventListener(type, fn) { if (!windowHandlers.has(type)) windowHandlers.set(type, []); windowHandlers.get(type).push(fn); },
    postMessage(message) { if (message.type === 'SMZ_X_CONTROL') hooks.push(message); }
  };
  const chrome = { runtime: {
    onMessage: { addListener(fn) { contentListener = fn; } },
    async sendMessage(message) {
      sent.push(clone(message));
      if (message.type === 'SMZ_GET_COLLECTION') return { ok: true, isCollectionTab: true,
        state: { status: 'collecting', collectionMode: 'manual', collectionId: 'delta-content-job', deltaBaselinePostId: '2100' } };
      if (message.type === 'SMZ_COLLECTION_MEDIA_COUNT') return { ok: true, needConfirmation: false };
      if (message.type === 'SMZ_ADD_MEDIA') return { ok: true, addedCount: 1, boundaryReached: true };
      return { ok: true };
    }
  } };
  const session = new Map();
  const env = { window: win, chrome, Date: FakeDate,
    location: { hostname: 'x.com', pathname: '/demo/media' },
    document: { body: { innerText: '200件の画像と動画', scrollHeight: 3000 }, documentElement: { scrollHeight: 3000 } },
    sessionStorage: { getItem(key) { return session.get(key) || null; }, setItem(key, v) { session.set(key, v); }, removeItem(key) { session.delete(key); } },
    console, setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, due: clock + ms }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(read('providers/x/content.js'), env, { filename: 'providers/x/content.js' });
  await tick(); await tick();
  assert.equal(hooks.at(-1).enabled, true);
  assert.equal(scrollCount, 0, 'manual delta never drives X scrolling');
  const fire = async (type, extra = {}) => {
    for (const fn of windowHandlers.get('message') || []) {
      await fn({ source: win, data: { source: 'simple-marugoto-zip', type, ...extra } });
    }
  };
  await fire('SMZ_X_REQUEST_START', { requestId: 'x1' });
  await fire('SMZ_X_MEDIA_BATCH', { requestUrl: 'https://x.com/i/api/graphql/abc/UserMedia',
    items: [media('2200'), media('2100')] });
  await fire('SMZ_X_REQUEST_END', { requestId: 'x1' });
  assert.equal(sent.filter((m) => m.type === 'SMZ_ADD_MEDIA').length, 1);
  assert.equal(sent.find((m) => m.type === 'SMZ_ADD_MEDIA').requestUrl.includes('UserMedia'), true);
  // レスポンスと書き込みが落ち着くまでは完了通知しない。
  assert.equal(sent.filter((m) => m.type === 'SMZ_COLLECTION_COMPLETE').length, 0);
  for (let i = 0; i < 6 && timers.size; i++) {
    const earliest = [...timers.entries()].sort((a,b) => a[1].due - b[1].due)[0];
    timers.delete(earliest[0]);
    clock = earliest[1].due + 1;
    await earliest[1].fn(); await tick();
  }
  assert.equal(sent.filter((m) => m.type === 'SMZ_COLLECTION_COMPLETE').length, 1);
  assert.equal(sent.find((m) => m.type === 'SMZ_COLLECTION_COMPLETE').endOfFeed, false);
  assert.equal(hooks.at(-1).enabled, false);
  assert.equal(scrollCount, 0);
  console.log('PASS delta content: manual mode only listens, passes UserMedia URL, awaits network settle, auto-finishes upon verified previous-post boundary');
}
testManualDeltaContent().catch((error) => { console.error(error); process.exitCode = 1; });
