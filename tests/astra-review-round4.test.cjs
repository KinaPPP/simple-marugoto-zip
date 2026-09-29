'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const clone = value => value === undefined ? undefined : structuredClone(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function item(n) {
  return {
    platform: 'x',
    key: `${n}_1`,
    postId: String(n),
    mediaIndex: 1,
    type: 'image',
    url: `https://pbs.twimg.com/media/${n}.jpg?name=orig`,
    fallbackUrls: [],
    extension: 'jpg',
    postedAt: '2026-09-29T00:00:00.000Z'
  };
}

function baseState() {
  const items = Array.from({length: 301}, (_, i) => item(1000 + i));
  return {
    platform: 'x', handle: 'demo', status: 'complete', collectionId: 'collect-1',
    startedAt: 1, completedAt: 2, updatedAt: 2, items,
    counts: {images: items.length, videos: 0, total: items.length},
    savedKinds: {images: false, videos: false}, savedItemKeys: [],
    archive: {
      status: 'archiving', collectionId: 'collect-1', collectionCompletedAt: 2, jobId: 'zip-1',
      selection: {images: true, videos: false}, splitMode: 'auto', mediaKind: 'images',
      itemKeys: items.map(x => x.key), nextItemIndex: 0, nextZipNumber: 1, savedZipCount: 0,
      processedItems: 0, failedItems: 0, totalSelected: items.length, currentZipNumber: 1,
      currentFileCount: 0, progress: 0, startedAt: 3, failures: []
    }
  };
}

function makeFetch() {
  return async url => {
    if (String(url).includes('/1300.jpg')) {
      return {ok: false, status: 500, headers: {get(){ return 'text/plain'; }}, arrayBuffer: async()=>new ArrayBuffer(0)};
    }
    return {
      ok: true, status: 200,
      headers: {get(name){ return String(name).toLowerCase() === 'content-type' ? 'image/jpeg' : null; }},
      arrayBuffer: async () => Uint8Array.of(1,2,3).buffer
    };
  };
}

function makeURLMock(onBlob) {
  return class URLMock extends URL {
    static createObjectURL(blob) { return onBlob(blob); }
    static revokeObjectURL() {}
  };
}

async function parseCheckpoint(blob) {
  const c = vm.createContext({
    Blob, Response, DecompressionStream, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView,
    URL, console
  });
  vm.runInContext(read('backup/schema.js') + '\n' + read('backup/zip-reader.js'), c);
  const metadata = await c.SMZZipReader.accountJsonFromZip(blob);
  return metadata.accounts[0].current;
}

async function runDownloadScenario({cancelSecond = false} = {}) {
  let state = baseState();
  let handler = null;
  const blobs = [];
  let nextDownloadId = 0;
  const URLMock = makeURLMock(blob => {
    blobs.push(blob);
    return `blob:mock-${blobs.length}`;
  });
  const chrome = {runtime:{
    onMessage:{addListener(fn){ handler = fn; }},
    async sendMessage(msg) {
      if (msg.type === 'SMZ_ARCHIVE_GET_STATE') return {ok:true,state:clone(state),previous:null};
      if (msg.type === 'SMZ_ARCHIVE_PATCH') {
        state.archive = {...state.archive,...clone(msg.patch)};
        return {ok:true,state:clone(state)};
      }
      if (msg.type === 'SMZ_DOWNLOAD_BLOB') {
        nextDownloadId++;
        if (cancelSecond && nextDownloadId === 2) return {ok:false,error:'USER_CANCELED'};
        return {ok:true,downloadId:nextDownloadId};
      }
      if (msg.type === 'SMZ_CHECK_DOWNLOAD') return {ok:true,state:'complete'};
      throw new Error(`unexpected message: ${msg.type}`);
    }
  }};
  const c = vm.createContext({
    chrome, URL:URLMock, console, fetch:makeFetch(), Blob, Response, CompressionStream, TextEncoder, TextDecoder,
    DataView, Uint8Array, Uint32Array, setTimeout, clearTimeout
  });
  vm.runInContext(read('backup/schema.js') + '\n' + read('archive/offscreen.js'), c);
  let startResponse = null;
  handler({target:'offscreen',type:'SMZ_OFFSCREEN_START_ARCHIVE',platform:'x',handle:'demo',jobId:'zip-1',
    selection:{images:true,videos:false},mediaKind:'images',splitMode:'auto',saveMode:'downloads'}, {}, r => { startResponse = r; });
  assert.equal(startResponse?.ok, true);
  for (let i=0; i<1000 && !['archive_complete','archive_error','archive_paused'].includes(state.archive.status); i++) await sleep(5);
  return {state, blobs};
}

async function runDirectoryScenario({failSecondFinalize = false} = {}) {
  let state = baseState();
  let handler = null;
  const outputs = [];
  let opened = 0;
  const fsMock = {
    async openWritableFile(key, filename) {
      opened++;
      const thisOpen = opened;
      const chunks = [];
      return {
        filename, directoryName:'test',
        writable: {
          async write(data){ chunks.push(Buffer.from(data)); },
          async close(){
            if (failSecondFinalize && thisOpen === 2) throw new Error('disk full');
            outputs.push({filename, blob:new Blob([Buffer.concat(chunks)])});
          },
          async abort(){}
        },
        async remove(){}
      };
    }
  };
  const chrome = {runtime:{
    onMessage:{addListener(fn){ handler = fn; }},
    async sendMessage(msg) {
      if (msg.type === 'SMZ_ARCHIVE_GET_STATE') return {ok:true,state:clone(state),previous:null};
      if (msg.type === 'SMZ_ARCHIVE_PATCH') {
        state.archive = {...state.archive,...clone(msg.patch)};
        return {ok:true,state:clone(state)};
      }
      throw new Error(`unexpected message: ${msg.type}`);
    }
  }};
  const c = vm.createContext({
    chrome, SMZFileSystem:fsMock, URL, console, fetch:makeFetch(), Blob, Response, CompressionStream,
    TextEncoder, TextDecoder, DataView, Uint8Array, Uint32Array, setTimeout, clearTimeout
  });
  vm.runInContext(read('backup/schema.js') + '\n' + read('archive/offscreen.js'), c);
  let startResponse = null;
  handler({target:'offscreen',type:'SMZ_OFFSCREEN_START_ARCHIVE',platform:'x',handle:'demo',jobId:'zip-1',
    selection:{images:true,videos:false},mediaKind:'images',splitMode:'auto',saveMode:'directory',
    saveDirectoryKey:'test',saveDirectoryName:'test'}, {}, r => { startResponse = r; });
  assert.equal(startResponse?.ok, true);
  for (let i=0; i<1000 && !['archive_complete','archive_error','archive_paused'].includes(state.archive.status); i++) await sleep(5);
  return {state, outputs};
}

async function assertFinalCheckpoint(state, blobsOrOutputs, getBlob) {
  assert.equal(state.archive.status, 'archive_complete');
  assert.equal(state.archive.nextItemIndex, 301);
  assert.equal(state.archive.failedItems, 1);
  assert.equal(state.archive.savedZipCount, 2, 'metadata-only final checkpoint must count as the second ZIP');
  assert.equal(blobsOrOutputs.length, 2, 'a checkpoint-only terminal ZIP must be written after the 300-media ZIP');
  const restored = await parseCheckpoint(getBlob(blobsOrOutputs[1]));
  assert.equal(restored.archive.status, 'archive_complete');
  assert.equal(restored.archive.nextItemIndex, 301);
  assert.equal(restored.archive.failedItems, 1);
  assert.equal(restored.archive.savedZipCount, 2);
  assert.equal(restored.savedItemKeys.length, 301);
}

async function testDownloadsWritesMetadataOnlyFinalZip() {
  const {state,blobs} = await runDownloadScenario();
  await assertFinalCheckpoint(state, blobs, x => x);
}

async function testDirectoryWritesMetadataOnlyFinalZip() {
  const {state,outputs} = await runDirectoryScenario();
  await assertFinalCheckpoint(state, outputs, x => x.blob);
}

async function testCancelledTerminalCheckpointDoesNotCommitProgress() {
  const {state,blobs} = await runDownloadScenario({cancelSecond:true});
  assert.equal(blobs.length, 2, 'the terminal checkpoint save must at least be attempted');
  assert.equal(state.archive.status, 'archive_paused');
  assert.equal(state.archive.pauseReason, 'user_cancelled');
  assert.equal(state.archive.nextItemIndex, 300, 'unsaved terminal progress must roll back to the prior ZIP checkpoint');
  assert.equal(state.archive.processedItems, 300);
  assert.equal(state.archive.failedItems, 0, 'failure history from an unsaved terminal checkpoint must not be committed');
  assert.equal(state.archive.savedZipCount, 1);
}

async function testDirectoryTerminalCheckpointFailureDoesNotCommitProgress() {
  const {state,outputs} = await runDirectoryScenario({failSecondFinalize:true});
  assert.equal(outputs.length, 1, 'failed terminal checkpoint ZIP must not be counted as saved');
  assert.equal(state.archive.status, 'archive_error');
  assert.equal(state.archive.nextItemIndex, 300);
  assert.equal(state.archive.processedItems, 300);
  assert.equal(state.archive.failedItems, 0);
  assert.equal(state.archive.savedZipCount, 1);
}

(async()=>{
  const tests = [
    ['P2 downloads metadata-only terminal checkpoint', testDownloadsWritesMetadataOnlyFinalZip],
    ['P2 directory metadata-only terminal checkpoint', testDirectoryWritesMetadataOnlyFinalZip],
    ['P2 cancelled terminal checkpoint rolls back', testCancelledTerminalCheckpointDoesNotCommitProgress],
    ['P2 failed directory terminal checkpoint rolls back', testDirectoryTerminalCheckpointFailureDoesNotCommitProgress]
  ];
  const filter = String(process.env.SMZ_TEST_FILTER || '').trim().toLowerCase();
  const selected = filter ? tests.filter(([name]) => name.toLowerCase().includes(filter)) : tests;
  if (!selected.length) throw new Error(`No round4 regression test matched filter: ${filter}`);
  for (const [name,fn] of selected) { await fn(); console.log('PASS', name); }
})().catch(error => { console.error(error); process.exitCode = 1; });
