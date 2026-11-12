'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const key = 'archive-directory:cache-test';

// Separate popup/offscreen realms sharing only the persisted handle store.
function harness() {
  const records = new Map();
  const indexedDB = { open() {
    const request = {};
    queueMicrotask(() => {
      request.result = { close() {}, transaction() {
        const tx = { objectStore() { return {
          get(k) { const r = {}; queueMicrotask(() => { r.result = records.get(k); r.onsuccess(); }); return r; },
          put(v, k) { records.set(k, v); queueMicrotask(() => tx.oncomplete()); },
          delete(k) { records.delete(k); queueMicrotask(() => tx.oncomplete()); }
        }; } };
        return tx;
      } };
      request.onsuccess();
    });
    return request;
  } };
  let handler;
  let state;
  const patches = [];
  const chrome = { runtime: {
    onMessage: { addListener(fn) { handler = fn; } },
    async sendMessage(message) {
      if (message.type === 'SMZ_ARCHIVE_GET_STATE') return { ok: true, state: structuredClone(state) };
      if (message.type === 'SMZ_ARCHIVE_PATCH') {
        patches.push(structuredClone(message.patch));
        Object.assign(state.archive, message.patch);
        return { ok: true, state: structuredClone(state) };
      }
      throw Error(message.type);
    }
  } };
  function realm(offscreen) {
    const context = vm.createContext({ indexedDB, window: {}, chrome, console,
      Blob, Response, CompressionStream, TextEncoder, TextDecoder, DataView,
      Uint8Array, Uint32Array, URL, setTimeout, clearTimeout,
      fetch: async () => ({ ok: true, headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer }) });
    vm.runInContext(read('archive/fs-access.js'), context);
    if (offscreen) vm.runInContext(read('backup/schema.js') + '\n' + read('archive/offscreen.js'), context);
    return context.SMZFileSystem;
  }
  const popup = realm(false);
  const offscreen = realm(true);
  const send = message => new Promise(resolve => {
    const accepted = handler({ target: 'offscreen', ...message }, {}, resolve);
    if (!accepted) resolve(undefined);
  });
  function resetState() {
    state = { platform: 'x', handle: 'demo', collectionId: 'cache-test', status: 'complete',
      items: [{ key: '1_1', postId: '1', mediaIndex: 1, type: 'image', url: 'https://pbs.twimg.com/media/test.jpg' }],
      counts: { total: 1, images: 1, videos: 0 },
      archive: { nextItemIndex: 0, nextZipNumber: 1, savedZipCount: 0, progress: 0, failedItems: 0, failures: [] } };
    patches.length = 0;
  }
  async function run() {
    resetState();
    const response = await send({ type: 'SMZ_OFFSCREEN_START_ARCHIVE', handle: 'demo',
      selection: { images: true, videos: false }, saveMode: 'directory', saveDirectoryKey: key, splitMode: 'auto' });
    assert.equal(response.ok, true);
    for (let i = 0; i < 500; i++) {
      if (!(await send({ type: 'SMZ_OFFSCREEN_GET_STATUS' })).active) return state.archive;
      await new Promise(r => setTimeout(r, 2));
    }
    throw Error('archive timeout');
  }
  return { popup, offscreen, send, run, patches };
}

function directory(name, { permission = 'granted', failure = null } = {}) {
  const files = new Map();
  let queries = 0;
  return { name, files, get queries() { return queries; },
    async queryPermission() { queries++; return permission; },
    async removeEntry(n) { files.delete(n); },
    async getFileHandle(n, options) {
      if (!options?.create && !files.has(n)) throw Object.assign(Error('missing'), { name: 'NotFoundError' });
      return {
        async getFile() {
          if (failure === 'unreadable') throw Error('cannot verify');
          if (!files.has(n)) throw Object.assign(Error('missing'), { name: 'NotFoundError' });
          return new Blob([files.get(n)]);
        },
        async createWritable() {
          const chunks = [];
          return {
            async write(data) { if (failure === 'write') throw Error('write failed'); chunks.push(Buffer.from(data instanceof Blob ? await data.arrayBuffer() : data)); },
            async close() {
              if (failure === 'close') throw Error('close failed');
              if (failure !== 'missing') files.set(n, failure === 'truncated' ? Buffer.from([0]) : Buffer.concat(chunks));
            },
            async abort() {}
          };
        }
      };
    }
  };
}

test('popup replacement invalidates offscreen handle AND permission, A → B → C → A', async () => {
  const h = harness();
  const dirs = [directory('A'), directory('B'), directory('C')];
  await h.popup.setHandle(key, dirs[0]);
  await h.offscreen.ensureWritableDirectory(key);
  for (const [i, dir] of [dirs[1], dirs[2], dirs[0]].entries()) {
    await h.popup.setHandle(key, dir);
    const ack = await h.send({ type: 'SMZ_OFFSCREEN_INVALIDATE_DIRECTORY', key });
    assert.equal(ack?.ok, true, 'offscreen must acknowledge cache invalidation');
    const saved = await h.offscreen.writeBlob(key, `${i}.zip`, new Blob(['zip']));
    assert.equal(saved.directoryName, dir.name);
    assert.equal(dir.files.get(`${i}.zip`).toString(), 'zip');
  }
  assert.equal(dirs[0].queries, 2, 'return to A must recheck permission');
  const denied = directory('denied', { permission: 'denied' });
  await h.popup.setHandle(key, denied);
  await h.send({ type: 'SMZ_OFFSCREEN_INVALIDATE_DIRECTORY', key });
  await assert.rejects(h.offscreen.writeBlob(key, 'denied.zip', new Blob(['zip'])), { code: 'SAVE_PERMISSION_REQUIRED' });
  assert.equal(denied.files.size, 0);
});

test('next archive reloads IDB even after a missed invalidation/rollback', async () => {
  const h = harness();
  const a = directory('A'), b = directory('B');
  await h.popup.setHandle(key, a);
  await h.offscreen.ensureWritableDirectory(key);
  await h.popup.setHandle(key, b);
  assert.equal((await h.run()).status, 'archive_complete');
  assert.equal(a.files.size, 0, 'old cached folder must not receive the ZIP');
  assert.equal(b.files.size, 1);
});

for (const failure of ['write', 'close', 'missing', 'truncated', 'unreadable']) {
  test(`streaming ${failure}: no committed progress or false completion`, async () => {
    const h = harness();
    const dir = directory('broken', { failure });
    await h.popup.setHandle(key, dir);
    const archive = await h.run();
    assert.equal(archive.status, 'archive_error');
    assert.equal(archive.nextItemIndex, 0);
    assert.equal(archive.nextZipNumber, 1);
    assert.equal(archive.savedZipCount, 0);
    assert.equal(archive.processedItems, 0);
    assert.equal(archive.progress, 0);
    assert.equal(archive.batchSaved, 0);
    assert(!h.patches.some(p => p.status === 'archive_complete' || p.savedZipCount > 0));
    assert.equal(dir.files.size, 0, 'failed output is removed');
  });
}

test('blob save also rejects a silent missing/truncated output', async () => {
  for (const failure of ['missing', 'truncated', 'unreadable']) {
    const h = harness();
    await h.popup.setHandle(key, directory('broken', { failure }));
    await assert.rejects(h.offscreen.writeBlob(key, 'blob.zip', new Blob(['ZIP bytes'])));
  }
});

test('invalidation is rejected while archiving and for malformed keys', async () => {
  const h = harness();
  assert.equal((await h.send({ type: 'SMZ_OFFSCREEN_INVALIDATE_DIRECTORY', key: 'invalid' }))?.ok, false);
  await h.popup.setHandle(key, directory('A'));
  await h.send({ type: 'SMZ_OFFSCREEN_START_ARCHIVE', handle: 'demo', selection: { images: true }, saveMode: 'directory', saveDirectoryKey: key });
  assert.equal((await h.send({ type: 'SMZ_OFFSCREEN_INVALIDATE_DIRECTORY', key }))?.ok, false);
  // This deliberately uninitialised job exits asynchronously without touching files.
});

test('settings version comes from the running manifest', () => {
  const html = read('options/options.html');
  assert.match(html, /id="extensionVersion"/);
  assert.doesNotMatch(html, /v1\.3\.1/);
  const startup = read('options/options.js').split("  const exportBtn =")[0] + '\n})();';
  for (const version of ['1.3.3', '9.8.7']) {
    const element = {};
    vm.runInNewContext(startup, {
      document: { getElementById: id => id === 'extensionVersion' ? element : null },
      chrome: { runtime: { getManifest: () => ({ version }) } }
    });
    assert.equal(element.textContent, `v${version}`);
  }
});

test('popup active guard does not start directory selection', async () => {
  const source = read('popup/popup.js').match(/async function changeSaveDirectory\(\) \{[\s\S]*?\n\}/)[0];
  let opened = false;
  const context = vm.createContext({canChangeSaveDirectory: () => false,
    chrome:{tabs:{create:async()=>{opened=true;}}}});
  vm.runInContext(source,context);
  await context.changeSaveDirectory();
  assert.equal(opened,false);
});

test('offscreen checks staged handle permission and name without touching old handle', async () => {
  const h = harness();
  const candidateKey = 'archive-directory:change-permission-test';
  const a = directory('A'), b = directory('B');
  await h.popup.setHandle(key,a);
  await h.offscreen.ensureWritableDirectory(key);
  await h.popup.setHandle(candidateKey,b);
  const prepared = await h.send({type:'SMZ_OFFSCREEN_PREPARE_DIRECTORY',key:candidateKey});
  assert.equal(prepared.ok,true);
  assert.equal(prepared.name,'B');
  assert.equal((await h.offscreen.getHandle(key)).name,'A');
  assert.equal(b.files.size,0);
  await h.popup.setHandle(candidateKey,directory('denied',{permission:'denied'}));
  assert.equal((await h.send({type:'SMZ_OFFSCREEN_PREPARE_DIRECTORY',key:candidateKey})).ok,false);
  assert.equal((await h.send({type:'SMZ_OFFSCREEN_PREPARE_DIRECTORY',key:'invalid'})).ok,false);
  await h.send({type:'SMZ_OFFSCREEN_START_ARCHIVE',handle:'demo',selection:{images:true},saveMode:'directory',saveDirectoryKey:key});
  assert.equal((await h.send({type:'SMZ_OFFSCREEN_PREPARE_DIRECTORY',key:candidateKey})).ok,false,'actual offscreen activity must reject a directory commit');
});

test('IDB reload retains confirmed capability only for the same actual directory',async()=>{
  const h=harness();
  const original=directory('test');
  original.isSameEntry=async other=>other.entryId==='G-test';
  await h.offscreen.setHandle(key,original);
  const restored=directory('test',{permission:'prompt'});restored.entryId='G-test';
  await h.popup.setHandle(key,restored);
  await h.offscreen.reloadDirectory(key);
  assert.equal((await h.run()).status,'archive_complete','ZIP start must retain the matched live capability too');
  assert.equal(original.files.size,1,'use the verified live capability after reading matching IDB entry');
  assert.equal(restored.queries,0);
  const different=directory('test',{permission:'denied'});different.entryId='D-test';
  await h.popup.setHandle(key,different);
  await h.offscreen.reloadDirectory(key);
  await assert.rejects(h.offscreen.writeBlob(key,'wrong.zip',new Blob(['data'])),{code:'SAVE_PERMISSION_REQUIRED'});
  assert.equal(original.files.size,1,'same name on another drive must not reuse old authorization');
  assert.equal(different.files.size,0);
});

test('cached permission never bypasses actual filesystem denial',async()=>{
  const h=harness();
  const original=directory('test');
  original.isSameEntry=async()=>true;
  original.getFileHandle=async()=>{throw Object.assign(Error('access revoked'),{name:'NotAllowedError'});};
  await h.offscreen.setHandle(key,original);
  await h.popup.setHandle(key,directory('test',{permission:'prompt'}));
  const archive=await h.run();
  assert.equal(archive.status,'archive_paused');
  assert.equal(archive.pauseReason,'save_permission');
  assert.equal(archive.savedZipCount,0);
  assert.equal(archive.nextItemIndex,0);
  assert.equal(original.files.size,0);
});
