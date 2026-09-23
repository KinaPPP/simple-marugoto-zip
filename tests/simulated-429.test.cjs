'use strict';

// node tests/simulated-429.test.cjs
// Chrome APIをモックしたオフライン回帰テスト。Xにも他の外部サイトにも接続しない。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function createBackgroundHarness() {
  const collections = {
    smz_collection_x_demo: {
      schemaVersion: 2,
      collectionId: 'demo-job-1', platform: 'x', handle: 'demo', status: 'collecting',
      collectionTabId: 11,
      counts: { images: 1, videos: 1, total: 2 },
      items: [
        { key: '2100_1', postId: '2100', mediaIndex: 1, type: 'image' },
        { key: '2090_1', postId: '2090', mediaIndex: 1, type: 'video' }
      ],
      newestPostId: '2100', oldestPostId: '2090',
      rateLimitSimulated: false, updatedAt: Date.now(), archive: null
    }
  };
  const tabs = [{ id: 11, url: 'https://x.com/demo/media', active: false }];
  const alarms = new Map();
  const tabMessages = [];
  const badgeHistory = [];
  let messageListener;
  let alarmListener;
  const options = { url: 'chrome-extension://test-id/options/options.html' };
  const tabSender = () => ({ tab: clone(tabs[0] || { id: 11, url: 'https://x.com/demo/media' }) });
  const storage = {
    async get(key) {
      if (key === null) return clone(collections);
      if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, clone(collections[k])]));
      return { [key]: clone(collections[key]) };
    },
    async set(changes) { Object.assign(collections, clone(changes)); },
    async remove(key) { for (const k of Array.isArray(key) ? key : [key]) delete collections[k]; }
  };
  const chrome = {
    storage: { local: storage },
    runtime: {
      getURL(pathname) { return `chrome-extension://test-id/${pathname}`; },
      onMessage: { addListener(listener) { messageListener = listener; } },
      async sendMessage() { throw new Error('unexpected background runtime.sendMessage'); }
    },
    tabs: {
      async query() { return clone(tabs); },
      async get(tabId) {
        const tab = tabs.find((item) => item.id === tabId);
        if (!tab) throw new Error('No tab');
        return clone(tab);
      },
      async sendMessage(tabId, msg) {
        tabMessages.push(clone(msg));
        if (msg.type === 'SMZ_DEBUG_SIMULATE_429') {
          const result = await dispatch({
            type: 'SMZ_COLLECTION_RATE_LIMIT', handle: msg.handle,
            collectionId: msg.collectionId, resumeAt: msg.resumeAt, simulated: true
          }, tabSender());
          return { ok: result.ok && result.state?.status === 'rate_limited', error: result.error };
        }
        return { ok: true };
      },
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} }
    },
    action: {
      async setIcon() {},
      async setBadgeText({ text }) { badgeHistory.push(text); },
      async setBadgeBackgroundColor() {},
      async setBadgeTextColor() {},
      async setTitle() {}
    },
    alarms: {
      onAlarm: { addListener(listener) { alarmListener = listener; } },
      async clear(name) { alarms.delete(name); return true; },
      async create(name, info) { alarms.set(name, clone(info)); }
    },
    windows: { onFocusChanged: { addListener() {} } },
    offscreen: { async hasDocument() { return false; } },
    downloads: { onDeterminingFilename: { addListener() {} } },
    scripting: { async executeScript() {} }
  };
  async function dispatch(message, sender = options) {
    return await new Promise((resolve) => {
      const accepted = messageListener(clone(message), clone(sender), resolve);
      assert.equal(accepted, true, 'background listener should respond asynchronously');
    });
  }
  // 拒否パターンもテストするため、想定内のconsole.errorだけ画面に出さない。
  vm.runInNewContext(read('backup/schema.js') + '\n' + read('background.js'), { chrome, URL, console: { ...console, error() {} }, setTimeout, clearTimeout }, { filename: 'background.js' });
  return { collections, tabs, alarms, badgeHistory, tabMessages, options, dispatch, alarm: (name) => alarmListener({ name }) };
}

async function testBackground() {
  const env = createBackgroundHarness();
  await tick();
  const { dispatch, collections, options, tabMessages, tabs, alarms } = env;

  let result = await dispatch({ type: 'SMZ_DEBUG_LIST_COLLECTING' }, { url: 'https://x.com/demo/media' });
  assert.equal(result.ok, false, 'other origins cannot list the debug controls');
  result = await dispatch({ type: 'SMZ_DEBUG_LIST_COLLECTING' });
  assert.equal(result.ok, true);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].tabId, 11);
  assert.equal(result.sessions[0].count, 2);

  const request = { type: 'SMZ_DEBUG_INJECT_429', handle: 'demo', collectionId: 'demo-job-1', tabId: 11 };
  result = await dispatch(request, { url: 'https://x.com/demo/media' });
  assert.equal(result.ok, false, 'other origins cannot inject synthetic rate limits');
  result = await dispatch({ ...request, collectionId: 'stale-job' });
  assert.equal(result.ok, false, 'stale collection IDs must be rejected');
  assert.equal(tabMessages.length, 0, 'invalid requests must not reach content');

  const start = Date.now();
  result = await dispatch(request);
  assert.equal(result.ok, true);
  let state = collections.smz_collection_x_demo;
  assert.equal(state.status, 'rate_limited');
  assert.equal(state.pauseReason, 'rate_limit');
  assert.equal(state.rateLimitSimulated, true);
  assert.equal(state.items.length, 2, 'cached media survive synthetic 429');
  assert.equal(state.counts.total, 2);
  assert.ok(state.resumeAt >= start + 85_000 && state.resumeAt <= Date.now() + 95_000);
  assert.equal(alarms.has('smz_resume_x_demo'), true);
  assert.equal(tabMessages.at(-1).type, 'SMZ_DEBUG_SIMULATE_429');
  await tick();
  assert.equal(env.badgeHistory.at(-1), '待', 'test wait should show the normal rate-limit badge');

  result = await dispatch(request);
  assert.equal(result.ok, false, 'repeated injections while waiting are blocked');

  await env.alarm('smz_resume_x_demo');
  state = collections.smz_collection_x_demo;
  assert.equal(state.status, 'collecting', 'normal alarm handler resumes the paused collection');
  assert.equal(state.rateLimitSimulated, false);
  assert.equal(state.items.length, 2);
  assert.equal(tabMessages.at(-1).type, 'SMZ_RESUME_COLLECTION');
  assert.equal(tabMessages.at(-1).collectionId, 'demo-job-1');

  result = await dispatch({ type: 'SMZ_ADD_MEDIA', handle: 'demo', collectionId: 'demo-job-1', items: [
    { key: '2100_1', postId: '2100', mediaIndex: 1, type: 'image' },
    { key: '2080_1', postId: '2080', mediaIndex: 1, type: 'image' }
  ] }, { tab: clone(tabs[0]) });
  assert.equal(result.ok, true);
  assert.equal(result.addedCount, 1, 'resuming deduplicates the old media');
  assert.equal(collections.smz_collection_x_demo.counts.total, 3);
  assert.equal(collections.smz_collection_x_demo.oldestPostId, '2080');

  result = await dispatch({ type: 'SMZ_COLLECTION_RATE_LIMIT', handle: 'demo', collectionId: 'demo-job-1' }, { tab: clone(tabs[0]) });
  assert.equal(result.ok, true);
  assert.equal(result.state.rateLimitSimulated, false, 'a real 429 is never shown as simulated');
  assert.ok(result.state.resumeAt >= Date.now() + 14 * 60_000, 'real 429 retains longer wait');

  result = await dispatch({ type: 'SMZ_STOP_COLLECTION', handle: 'demo', tabId: 11 });
  assert.equal(result.ok, true);
  assert.equal(collections.smz_collection_x_demo.status, 'paused');
  assert.equal(collections.smz_collection_x_demo.counts.total, 3);
  assert.equal(alarms.has('smz_resume_x_demo'), false, 'manual stop clears the restart alarm');

  result = await dispatch({ type: 'SMZ_START_COLLECTION', handle: 'demo', tabId: 11, restart: false });
  assert.equal(result.ok, true);
  assert.equal(collections.smz_collection_x_demo.status, 'collecting');
  result = await dispatch(request);
  assert.equal(result.ok, true);
  tabs.length = 0;
  await env.alarm('smz_resume_x_demo');
  assert.equal(collections.smz_collection_x_demo.status, 'paused', 'missing X tab means no automatic scrolling');
  assert.equal(collections.smz_collection_x_demo.pauseReason, 'resume_ready');
  assert.equal(collections.smz_collection_x_demo.items.length, 3);
  console.log('PASS background: options-only injection, stale-job guard, 90s wait, state preservation, badge, alarm resume, deduplication, real 429, manual stop, missing-tab pause');
}

async function testContent() {
  const windowListeners = new Map();
  const runtimeMessages = [];
  const hookControls = [];
  const storage = new Map();
  let contentListener;
  const window = {
    scrollY: 0, innerHeight: 800,
    scrollTo() {},
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(listener);
    },
    postMessage(msg) { if (msg.type === 'SMZ_X_CONTROL') hookControls.push(msg); }
  };
  const chrome = {
    runtime: {
      onMessage: { addListener(listener) { contentListener = listener; } },
      async sendMessage(message) {
        runtimeMessages.push(clone(message));
        if (message.type === 'SMZ_GET_COLLECTION') return { ok: true, state: { status: 'collecting', collectionId: 'job-content' } };
        if (message.type === 'SMZ_COLLECTION_MEDIA_COUNT') return { ok: true, needConfirmation: false };
        if (message.type === 'SMZ_COLLECTION_RATE_LIMIT') return { ok: true, state: { status: 'rate_limited' } };
        return { ok: true, addedCount: 1 };
      }
    }
  };
  const location = { hostname: 'x.com', pathname: '/demo/media' };
  const document = { body: { innerText: '200件の画像と動画', scrollHeight: 4000 }, documentElement: { scrollHeight: 4000 } };
  const sessionStorage = {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, value) { storage.set(key, value); },
    removeItem(key) { storage.delete(key); }
  };
  vm.runInNewContext(read('providers/x/content.js'), {
    window, chrome, location, document, sessionStorage, console,
    setTimeout() { return 1; }, clearTimeout() {}
  }, { filename: 'providers/x/content.js' });
  await tick(); await tick();
  assert.equal(hookControls.at(-1)?.enabled, true, 'initial collection arms the passive hook');

  async function dispatch(message) {
    return await new Promise((resolve) => {
      assert.equal(contentListener(clone(message), {}, resolve), true);
    });
  }
  let result = await dispatch({ type: 'SMZ_DEBUG_SIMULATE_429', handle: 'demo', collectionId: 'wrong-id', resumeAt: Date.now() + 90_000 });
  assert.equal(result.ok, false);
  assert.equal(runtimeMessages.filter((m) => m.type === 'SMZ_COLLECTION_RATE_LIMIT').length, 0);

  result = await dispatch({ type: 'SMZ_DEBUG_SIMULATE_429', handle: 'demo', collectionId: 'job-content', resumeAt: Date.now() + 90_000 });
  assert.equal(result.ok, true);
  let rateMessages = runtimeMessages.filter((m) => m.type === 'SMZ_COLLECTION_RATE_LIMIT');
  assert.equal(rateMessages.length, 1);
  assert.equal(rateMessages[0].simulated, true);
  assert.equal(rateMessages[0].collectionId, 'job-content');
  assert.equal(hookControls.at(-1).enabled, false, 'simulated 429 stops active scrolling/hook');

  // 停止後の遅延バッチは次の収集開始まで追加しない。
  for (const listener of windowListeners.get('message')) {
    await listener({ source: window, data: { source: 'simple-marugoto-zip', type: 'SMZ_X_MEDIA_BATCH', items: [{ key: 'late' }] } });
  }
  assert.equal(runtimeMessages.some((m) => m.type === 'SMZ_ADD_MEDIA'), false);

  result = await dispatch({ type: 'SMZ_RESUME_COLLECTION', handle: 'demo', collectionId: 'job-content', automatic: true });
  assert.equal(result.ok, true);
  for (const listener of windowListeners.get('message')) {
    await listener({ source: window, data: { source: 'simple-marugoto-zip', type: 'SMZ_X_RATE_LIMIT', resumeAt: null } });
  }
  rateMessages = runtimeMessages.filter((m) => m.type === 'SMZ_COLLECTION_RATE_LIMIT');
  assert.equal(rateMessages.length, 2);
  assert.equal(rateMessages[1].simulated, false, 'real X 429 uses the same stop/wait path without the test marker');
  assert.equal(hookControls.at(-1).enabled, false);
  console.log('PASS content: only matching live collection accepts synthetic event; no HTTP calls; stop, preserve message ID, drop late batch, reuse real 429 path');
}

async function testManualBackground() {
  const env = createBackgroundHarness();
  await tick();
  const { dispatch, collections, tabs, tabMessages, alarm } = env;
  const sender = { tab: { id: 11, url: 'https://x.com/demo/media' } };
  let response = await dispatch({
    type: 'SMZ_START_COLLECTION', handle: 'demo', tabId: 11, collectionMode: 'manual',
    restart: false, forceReload: false
  });
  assert.equal(response.ok, true);
  assert.equal(collections.smz_collection_x_demo.collectionMode, 'manual');
  assert.equal(tabMessages.at(-1).collectionMode, 'manual');
  assert.equal(tabMessages.at(-1).forceReload, false);
  response = await dispatch({ type: 'SMZ_GET_COLLECTION', handle: 'demo' }, sender);
  assert.equal(response.isCollectionTab, true);
  tabs.push({ id: 12, url: 'https://x.com/demo/media' });
  response = await dispatch({ type: 'SMZ_GET_COLLECTION', handle: 'demo' }, { tab: tabs[1] });
  assert.equal(response.isCollectionTab, false, 'other tab cannot auto-arm the same collection');

  const add = (collectionId, senderTab = sender) => dispatch({
    type: 'SMZ_ADD_MEDIA', handle: 'demo', collectionId,
    items: [
      { key: '2100_1', postId: '2100', mediaIndex: 1, type: 'image' },
      { key: '2080_1', postId: '2080', mediaIndex: 1, type: 'image' }
    ]
  }, senderTab);
  response = await add('expired-job');
  assert.equal(response.addedCount, 0, 'stale batches must be rejected');
  response = await add('demo-job-1', { tab: tabs[1] });
  assert.equal(response.addedCount, 0, 'other tab batches must be rejected');
  response = await add('demo-job-1');
  assert.equal(response.addedCount, 1, 'manual capture should deduplicate');
  assert.equal(collections.smz_collection_x_demo.counts.total, 3);

  response = await dispatch({ type: 'SMZ_COLLECTION_PHASE', handle: 'demo',
    collectionId: 'demo-job-1', phase: 'final_check' }, sender);
  assert.equal(response.state, null, 'manual mode must not enter automatic final check');
  response = await dispatch({ type: 'SMZ_COLLECTION_COMPLETE', handle: 'demo', collectionId: 'demo-job-1' }, sender);
  assert.equal(response.state, null, 'auto-complete cannot end a manual session');

  response = await dispatch({ type: 'SMZ_DEBUG_INJECT_429', handle: 'demo', collectionId: 'demo-job-1', tabId: 11 });
  assert.equal(response.ok, true);
  await alarm('smz_resume_x_demo');
  assert.equal(tabMessages.at(-1).collectionMode, 'manual', '429 recovery must restore passive manual capture');
  assert.equal(collections.smz_collection_x_demo.collectionMode, 'manual');

  response = await dispatch({ type: 'SMZ_FINISH_MANUAL_COLLECTION', handle: 'demo',
    collectionId: 'wrong', tabId: 11 });
  assert.equal(response.ok, false);
  response = await dispatch({ type: 'SMZ_FINISH_MANUAL_COLLECTION', handle: 'demo',
    collectionId: 'demo-job-1', tabId: 12 });
  assert.equal(response.ok, false);
  response = await dispatch({ type: 'SMZ_FINISH_MANUAL_COLLECTION', handle: 'demo',
    collectionId: 'demo-job-1', tabId: 11 });
  assert.equal(response.ok, true);
  assert.equal(tabMessages.at(-1).type, 'SMZ_FINISH_MANUAL_CAPTURE');
  assert.equal(collections.smz_collection_x_demo.status, 'complete');
  assert.equal(collections.smz_collection_x_demo.counts.total, 3);
  response = await add('demo-job-1');
  assert.equal(response.addedCount, 0, 'late batch after manual finish is ignored');
  console.log('PASS manual background: mode persistence, other-tab protection, deduplication, 429 manual recovery, explicit finish, late-batch rejection');
}

async function testManualContent() {
  const windowListeners = new Map();
  const runtimeMessages = [];
  const hookControls = [];
  const pendingTimers = [];
  const storage = new Map();
  let listener;
  let scrolls = 0;
  const window = {
    scrollY: 0, innerHeight: 800,
    scrollTo() { scrolls++; },
    addEventListener(type, callback) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(callback);
    },
    postMessage(message) { if (message.type === 'SMZ_X_CONTROL') hookControls.push(message); }
  };
  const chrome = { runtime: {
    onMessage: { addListener(callback) { listener = callback; } },
    async sendMessage(message) {
      runtimeMessages.push(clone(message));
      if (message.type === 'SMZ_GET_COLLECTION') return { ok: true, isCollectionTab: true,
        state: { status: 'collecting', collectionId: 'manual-job', collectionMode: 'manual' } };
      if (message.type === 'SMZ_COLLECTION_MEDIA_COUNT') return { ok: true, needConfirmation: false };
      if (message.type === 'SMZ_COLLECTION_RATE_LIMIT') return { ok: true, state: { status: 'rate_limited' } };
      return { ok: true, addedCount: 1 };
    }
  } };
  const location = { hostname: 'x.com', pathname: '/demo/media' };
  const document = { body: { innerText: '200件の画像と動画', scrollHeight: 4000 },
    documentElement: { scrollHeight: 4000 } };
  const sessionStorage = {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, value) { storage.set(key, value); },
    removeItem(key) { storage.delete(key); }
  };
  vm.runInNewContext(read('providers/x/content.js'), {
    window, chrome, location, document, sessionStorage, console,
    setTimeout(callback) { pendingTimers.push(callback); return pendingTimers.length; },
    clearTimeout() {}
  }, { filename: 'providers/x/content.js' });
  await tick(); await tick();
  assert.equal(hookControls.at(-1)?.enabled, true);
  assert.equal(scrolls, 0, 'manual mode must never call window.scrollTo');
  assert.equal(pendingTimers.length, 0, 'manual mode must not schedule auto-scrolling');
  const fire = async (type, extra = {}) => {
    for (const callback of windowListeners.get('message')) {
      await callback({ source: window, data: { source: 'simple-marugoto-zip', type, ...extra } });
    }
  };
  const dispatch = async (message) => new Promise((resolve) => {
    assert.equal(listener(clone(message), {}, resolve), true);
  });
  await fire('SMZ_X_MEDIA_BATCH', { items: [{ key: '2000_1', postId: '2000', type: 'image' }] });
  assert.equal(runtimeMessages.filter((m) => m.type === 'SMZ_ADD_MEDIA').length, 1);
  assert.equal(runtimeMessages.at(-1).collectionId, 'manual-job');
  let response = await dispatch({ type: 'SMZ_FINISH_MANUAL_CAPTURE', handle: 'demo', collectionId: 'manual-job' });
  assert.equal(response.ok, true);
  assert.equal(hookControls.at(-1).enabled, false);
  await fire('SMZ_X_MEDIA_BATCH', { items: [{ key: 'late' }] });
  assert.equal(runtimeMessages.filter((m) => m.type === 'SMZ_ADD_MEDIA').length, 1);

  response = await dispatch({ type: 'SMZ_RESUME_COLLECTION', handle: 'demo',
    collectionId: 'manual-job', collectionMode: 'manual', automatic: true });
  assert.equal(response.ok, true);
  assert.equal(scrolls, 0, 'automatic recovery must not switch manual mode to automatic scrolling');
  assert.equal(pendingTimers.length, 0, 'manual recovery must not schedule scrolling');
  response = await dispatch({ type: 'SMZ_DEBUG_SIMULATE_429', handle: 'demo',
    collectionId: 'manual-job', resumeAt: Date.now() + 90_000 });
  assert.equal(response.ok, true);
  assert.equal(hookControls.at(-1).enabled, false);
  console.log('PASS manual content: passive capture, no scrolling/timers, explicit finish, late-batch rejection, manual resume and synthetic 429');
}

async function testMainHookEarlyBatch() {
  const messages = [];
  const listeners = new Map();
  const window = {
    fetch: async () => ({
      status: 200, ok: true, url: 'https://x.com/i/api/graphql/test/UserMedia',
      clone() { return {
        status: 200, ok: true, headers: { get() { return null; } },
        async json() { return { result: {
          rest_id: '2100', core: { user_results: { result: { core: { screen_name: 'demo' } } } },
          legacy: { id_str: '2100', extended_entities: { media: [
            { media_url_https: 'https://pbs.twimg.com/media/abc.jpg', type: 'photo' }
          ] } }
        } }; }
      }; }
    }),
    addEventListener(type, callback) { listeners.set(type, callback); },
    postMessage(message) { messages.push(message); }
  };
  const sessionStorage = { getItem() { return 'demo'; } };
  vm.runInNewContext(read('providers/x/main-hook.js'), { window, sessionStorage, URL,
    console }, { filename: 'providers/x/main-hook.js' });
  await window.fetch('https://x.com/i/api/graphql/test/UserMedia');
  await tick(); await tick();
  assert.equal(messages.filter((msg) => msg.type === 'SMZ_X_MEDIA_BATCH').length, 1);
  listeners.get('message')({ source: window, data: {
    source: 'simple-marugoto-zip', type: 'SMZ_X_CONTROL', enabled: true, handle: 'demo'
  } });
  assert.equal(messages.filter((msg) => msg.type === 'SMZ_X_MEDIA_BATCH').length, 2,
    'media loaded before the content bridge was ready must be replayed');
  listeners.get('message')({ source: window, data: {
    source: 'simple-marugoto-zip', type: 'SMZ_X_CONTROL', enabled: false, handle: 'demo'
  } });
  listeners.get('message')({ source: window, data: {
    source: 'simple-marugoto-zip', type: 'SMZ_X_CONTROL', enabled: true, handle: 'demo'
  } });
  assert.equal(messages.filter((msg) => msg.type === 'SMZ_X_MEDIA_BATCH').length, 2,
    'already acknowledged early batches must not be replayed again');
  console.log('PASS X hook: early /media responses survive content bootstrap and are replayed exactly once');
}

(async () => {
  await testBackground();
  await testContent();
  await testManualBackground();
  await testManualContent();
  await testMainHookEarlyBatch();
  console.log('PASS v0.0.19 offline regression suite');
})().catch((error) => { console.error(error); process.exitCode = 1; });
