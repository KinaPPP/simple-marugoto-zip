'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const clone = value => value === undefined ? undefined : structuredClone(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const plain = value => JSON.parse(JSON.stringify(value));

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

function makeHarness(mode, initialState = baseState()) {
  let state = clone(initialState);
  let handler = null;
  let failLast = true;
  let stopAfterFailure = true;
  let stopIssued = false;
  let nextDownloadId = 0;
  const blobs = [];
  const outputs = [];

  const URLMock = makeURLMock(blob => {
    blobs.push(blob);
    return `blob:mock-${blobs.length}`;
  });

  const fsMock = {
    async openWritableFile(key, filename) {
      const chunks = [];
      return {
        filename, directoryName:'test',
        writable: {
          async write(data){ chunks.push(Buffer.from(data)); },
          async close(){ outputs.push({filename, blob:new Blob([Buffer.concat(chunks)])}); },
          async abort(){}
        },
        async remove(){}
      };
    }
  };

  const fetch = async url => {
    if (failLast && String(url).includes('/1300.jpg')) {
      return {ok:false,status:500,headers:{get(){return 'text/plain';}},arrayBuffer:async()=>new ArrayBuffer(0)};
    }
    return {
      ok:true,status:200,
      headers:{get(name){return String(name).toLowerCase()==='content-type'?'image/jpeg':null;}},
      arrayBuffer:async()=>Uint8Array.of(1,2,3).buffer
    };
  };

  function issueStop() {
    let response = null;
    handler({target:'offscreen',type:'SMZ_OFFSCREEN_STOP_ARCHIVE',platform:'x',handle:'demo',jobId:'zip-1'}, {}, r => { response = r; });
    assert.equal(response?.ok, true, 'the normal extension stop message must be accepted');
    stopIssued = true;
  }

  const chrome = {runtime:{
    onMessage:{addListener(fn){ handler = fn; }},
    async sendMessage(msg) {
      if (msg.type === 'SMZ_ARCHIVE_GET_STATE') return {ok:true,state:clone(state),previous:null};
      if (msg.type === 'SMZ_ARCHIVE_PATCH') {
        state.archive = {...state.archive,...clone(msg.patch)};
        if (stopAfterFailure && !stopIssued && msg.patch?.failedItems > 0 && msg.patch?.processedItems === 301 && msg.patch?.status === 'archiving' && !Object.prototype.hasOwnProperty.call(msg.patch, 'nextItemIndex')) {
          issueStop();
        }
        return {ok:true,state:clone(state)};
      }
      if (msg.type === 'SMZ_DOWNLOAD_BLOB') return {ok:true,downloadId:++nextDownloadId};
      if (msg.type === 'SMZ_CHECK_DOWNLOAD') return {ok:true,state:'complete'};
      throw new Error(`unexpected message: ${msg.type}`);
    }
  }};

  const globals = {
    chrome, URL:URLMock, console, fetch, Blob, Response, CompressionStream,
    TextEncoder, TextDecoder, DataView, Uint8Array, Uint32Array, setTimeout, clearTimeout
  };
  if (mode === 'directory') globals.SMZFileSystem = fsMock;
  const c = vm.createContext(globals);
  vm.runInContext(read('backup/schema.js') + '\n' + read('archive/offscreen.js'), c);

  async function start({fail = true, stop = true} = {}) {
    failLast = fail;
    stopAfterFailure = stop;
    stopIssued = false;
    let startResponse = null;
    handler({
      target:'offscreen',type:'SMZ_OFFSCREEN_START_ARCHIVE',platform:'x',handle:'demo',jobId:'zip-1',
      selection:{images:true,videos:false},mediaKind:'images',splitMode:'auto',
      saveMode:mode,saveDirectoryKey:mode==='directory'?'test':null,saveDirectoryName:mode==='directory'?'test':null
    }, {}, r => { startResponse = r; });
    assert.equal(startResponse?.ok, true);
    for (let i=0; i<2000; i++) {
      let status = null;
      handler({target:'offscreen',type:'SMZ_OFFSCREEN_GET_STATUS'}, {}, r => { status = r; });
      if (!status?.active && ['archive_complete','archive_error','archive_paused'].includes(state.archive.status)) break;
      await sleep(5);
    }
    return clone(state);
  }

  return {
    start,
    state:()=>clone(state),
    blobs,
    outputs,
    latestBlob:()=> mode === 'directory' ? outputs.at(-1)?.blob : blobs.at(-1)
  };
}

async function testStopRollsBackUnpersistedFailureDownloads() {
  const h = makeHarness('downloads');
  let state = await h.start({fail:true,stop:true});
  assert.equal(state.archive.status, 'archive_paused');
  assert.equal(state.archive.nextItemIndex, 300);
  assert.equal(state.archive.processedItems, 300);
  assert.equal(state.archive.failedItems, 0, 'stop must discard failure history that was never checkpointed');
  assert.deepEqual(state.archive.failures, []);

  state = await h.start({fail:false,stop:false});
  assert.equal(state.archive.status, 'archive_complete');
  assert.equal(state.archive.failedItems, 0, 'a successful retry must not retain the abandoned failure');
  const checkpoint = await parseCheckpoint(h.latestBlob());
  assert.equal(checkpoint.archive.failedItems, 0);
  assert.deepEqual(plain(checkpoint.archive.failures), []);
}

async function testStopRollsBackUnpersistedFailureDirectory() {
  const h = makeHarness('directory');
  let state = await h.start({fail:true,stop:true});
  assert.equal(state.archive.status, 'archive_paused');
  assert.equal(state.archive.nextItemIndex, 300);
  assert.equal(state.archive.failedItems, 0);
  assert.deepEqual(state.archive.failures, []);

  state = await h.start({fail:false,stop:false});
  assert.equal(state.archive.status, 'archive_complete');
  assert.equal(state.archive.failedItems, 0);
  const checkpoint = await parseCheckpoint(h.latestBlob());
  assert.equal(checkpoint.archive.failedItems, 0);
  assert.deepEqual(plain(checkpoint.archive.failures), []);
}

async function testRepeatedStopDoesNotDuplicateFailure() {
  const h = makeHarness('downloads');
  let state = await h.start({fail:true,stop:true});
  assert.equal(state.archive.failedItems, 0);
  state = await h.start({fail:true,stop:true});
  assert.equal(state.archive.status, 'archive_paused');
  assert.equal(state.archive.nextItemIndex, 300);
  assert.equal(state.archive.failedItems, 0, 'repeated abandoned retries must not accumulate the same failure');
  assert.deepEqual(state.archive.failures, []);
  state = await h.start({fail:false,stop:false});
  assert.equal(state.archive.status, 'archive_complete');
  assert.equal(state.archive.failedItems, 0);
}

async function testCommittedFailureIsPreserved() {
  const initial = baseState();
  initial.archive.nextItemIndex = 300;
  initial.archive.processedItems = 300;
  initial.archive.nextZipNumber = 2;
  initial.archive.savedZipCount = 1;
  initial.archive.currentZipNumber = 2;
  initial.archive.failedItems = 1;
  initial.archive.failures = [{key:'1100_1',error:'previous committed failure'}];
  initial.archive.progress = 300 / 301;

  const h = makeHarness('directory', initial);
  let state = await h.start({fail:true,stop:true});
  assert.equal(state.archive.status, 'archive_paused');
  assert.equal(state.archive.nextItemIndex, 300);
  assert.equal(state.archive.failedItems, 1, 'rollback must preserve failures already committed by an earlier ZIP');
  assert.deepEqual(state.archive.failures, [{key:'1100_1',error:'previous committed failure'}]);

  state = await h.start({fail:false,stop:false});
  assert.equal(state.archive.status, 'archive_complete');
  assert.equal(state.archive.failedItems, 1);
  assert.deepEqual(state.archive.failures, [{key:'1100_1',error:'previous committed failure'}]);
  const checkpoint = await parseCheckpoint(h.latestBlob());
  assert.equal(checkpoint.archive.failedItems, 1);
  assert.equal(checkpoint.archive.failures.length, 1);
  assert.equal(checkpoint.archive.failures[0].key, '1100_1');
}

(async()=>{
  const tests = [
    ['P2 stop rollback downloads', testStopRollsBackUnpersistedFailureDownloads],
    ['P2 stop rollback directory', testStopRollsBackUnpersistedFailureDirectory],
    ['P2 repeated stop does not duplicate failure', testRepeatedStopDoesNotDuplicateFailure],
    ['P2 committed failure survives stop rollback', testCommittedFailureIsPreserved]
  ];
  for (const [name,fn] of tests) { await fn(); console.log('PASS', name); }
})().catch(error => { console.error(error); process.exitCode = 1; });
