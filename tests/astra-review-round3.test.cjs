'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const clone = v => v === undefined ? undefined : structuredClone(v);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function item(id, type='image') {
  const base = type === 'video' ? 'https://video.twimg.com/ext_tw_video' : 'https://pbs.twimg.com/media';
  return {
    platform:'x', key:`${id}_1`, postId:String(id), mediaIndex:1, type,
    url:type === 'video' ? `${base}/${id}/pu/vid/1280x720/demo.mp4` : `${base}/${id}.jpg?name=orig`,
    fallbackUrls:[], extension:type === 'video' ? 'mp4' : 'jpg', postedAt:'2026-09-29T00:00:00Z'
  };
}

function chromeBase(store, runtimeSend = async () => ({ok:true})) {
  let receiver = null;
  const chrome = {
    runtime: {
      getURL: p => `chrome-extension://mock/${p}`,
      onMessage: { addListener(fn){ receiver = fn; } },
      sendMessage: runtimeSend
    },
    storage: { local: {
      async get(key) {
        if (key === null) return clone(store);
        if (typeof key === 'string') return { [key]: clone(store[key]) };
        const out = {}; for (const k of key || []) out[k] = clone(store[k]); return out;
      },
      async set(obj){ Object.assign(store, clone(obj)); },
      async remove(keys){ for (const k of [].concat(keys || [])) delete store[k]; },
      async clear(){ for (const k of Object.keys(store)) delete store[k]; }
    }},
    alarms: { onAlarm:{addListener(){}}, async create(){}, async clear(){return true;} },
    permissions: { async contains(){return true;}, async request(){return true;} },
    tabs: { async query(){return [];}, async get(){return null;}, async sendMessage(){return {ok:true};}, onActivated:{addListener(){}}, onUpdated:{addListener(){}} },
    windows: { onFocusChanged:{addListener(){}} },
    offscreen: { async hasDocument(){return true;}, async createDocument(){} },
    downloads: { onDeterminingFilename:{addListener(){}} },
    action: { async setIcon(){}, async setBadgeText(){}, async setBadgeBackgroundColor(){}, async setBadgeTextColor(){}, async setTitle(){} }
  };
  return { chrome, getReceiver: () => receiver };
}

async function send(receiver, type, data={}) {
  return await new Promise(resolve => receiver({type, ...data}, {url:'chrome-extension://mock/popup/popup.html'}, resolve));
}

async function testCheckpointPersistsCurrentSavedKeys() {
  const chrome = { runtime:{ onMessage:{addListener(){}}, async sendMessage(){ return {ok:true}; } } };
  const c = vm.createContext({
    chrome, URL, console, Blob, Response, TextEncoder, TextDecoder, DataView, Uint8Array, Uint32Array,
    CompressionStream: undefined, setTimeout, clearTimeout,
    fetch:async()=>{throw new Error('unused');}
  });
  vm.runInContext(read('backup/schema.js')+'\n'+read('archive/offscreen.js'), c);

  const oldItem = item('200');
  const newItem = item('300');
  const state = {
    platform:'x', handle:'demo', status:'complete', collectionId:'job-1', items:[newItem, oldItem],
    counts:{images:2,videos:0,total:2}, completedAt:2000, updatedAt:2000,
    savedKinds:{images:true,videos:false}, savedItemKeys:[oldItem.key]
  };
  const archive = {
    status:'archiving', collectionId:'job-1', collectionCompletedAt:2000, jobId:'ZIP-2',
    selection:{images:true,videos:false}, splitMode:'auto', mediaKind:'images',
    itemKeys:[oldItem.key,newItem.key], nextItemIndex:1, processedItems:1, totalSelected:2,
    nextZipNumber:2, savedZipCount:1, startedAt:1000
  };
  const job = {platform:'x',handle:'demo',selection:{images:true,videos:false},mediaKind:'images'};

  const finalFile = await c.checkpointFile(state, null, archive, job, 2, 2, 0, [], 2);
  const finalPayload = JSON.parse(new TextDecoder().decode(finalFile.data));
  assert.deepEqual(new Set(finalPayload.account.savedItemKeys), new Set([oldItem.key,newItem.key]),
    'the final ZIP checkpoint must include the keys finalized by the current archive job');

  const partialState = {...state, savedItemKeys:[]};
  const partialFile = await c.checkpointFile(partialState, null, archive, job, 1, 1, 0, [], 2);
  const partialPayload = JSON.parse(new TextDecoder().decode(partialFile.data));
  assert.deepEqual(partialPayload.account.savedItemKeys, [oldItem.key],
    'an intermediate split checkpoint must include only the processed prefix, not later media');
}

async function testTrustedLegacyKindKeysMigrateBeforeNewKind() {
  const image = item('300','image');
  const video = item('200','video');
  const store = { smz_collection_x_demo: {
    platform:'x',handle:'demo',status:'complete',collectionId:'job-1',items:[image,video],
    counts:{images:1,videos:1,total:2},newestPostId:'300',oldestPostId:'200',completedAt:2000,updatedAt:2000,
    savedKinds:{images:true,videos:false},
    archive:{
      status:'archive_complete',collectionId:'job-1',collectionCompletedAt:2000,jobId:'OLD-IMG',
      selection:{images:true,videos:false},splitMode:'auto',mediaKind:'images',itemKeys:[image.key],
      nextItemIndex:1,processedItems:1,totalSelected:1,nextZipNumber:2,savedZipCount:1,completedAt:2100
    }
  }};
  const runtimeSend = async msg => {
    if (msg.target === 'offscreen' && msg.type === 'SMZ_OFFSCREEN_GET_STATUS') return {active:false};
    if (msg.target === 'offscreen' && msg.type === 'SMZ_OFFSCREEN_START_ARCHIVE') return {ok:true,jobId:msg.jobId};
    return {ok:true};
  };
  const {chrome,getReceiver} = chromeBase(store,runtimeSend);
  const c = vm.createContext({chrome,URL,console:{...console,error(){}},fetch:async()=>{throw new Error('unused');},setTimeout,clearTimeout,AbortController});
  vm.runInContext(read('backup/schema.js')+'\n'+read('background.js'),c);
  await sleep(10);

  let r = await send(getReceiver(),'SMZ_START_ARCHIVE',{
    platform:'x',handle:'demo',selection:{images:false,videos:true},splitMode:'auto',runLimit:null,saveMode:'downloads'
  });
  assert(r.ok,r.error);
  assert.deepEqual(store.smz_collection_x_demo.savedItemKeys,[image.key],
    'starting the first new-format archive should migrate trustworthy legacy completed keys before replacing the old archive');

  r = await send(getReceiver(),'SMZ_ARCHIVE_PATCH',{
    platform:'x',handle:'demo',patch:{status:'archive_complete',nextItemIndex:1,processedItems:1,totalSelected:1,savedZipCount:1,completedAt:2200}
  });
  assert(r.ok,r.error);
  assert.deepEqual(new Set(store.smz_collection_x_demo.savedItemKeys),new Set([image.key,video.key]),
    'after the new kind completes, migrated legacy keys and current keys must both remain authoritative');
  assert.equal(c.canStartNewOnlyCheck(store.smz_collection_x_demo),true,
    'after both kinds are covered, the migrated state should allow the next delta check');
}

async function testUnknownLegacyOrderIsNotInventedDuringMigration() {
  const image = item('300','image');
  const video = item('200','video');
  const store = { smz_collection_x_demo: {
    platform:'x',handle:'demo',status:'complete',collectionId:'job-1',items:[image,video],
    counts:{images:1,videos:1,total:2},completedAt:2000,updatedAt:2000,savedKinds:{images:true,videos:false},
    archive:{status:'archive_complete',collectionId:'job-1',collectionCompletedAt:2000,
      selection:{images:true,videos:false},splitMode:'auto',mediaKind:'images',
      nextItemIndex:1,processedItems:1,totalSelected:1,nextZipNumber:2,savedZipCount:1,completedAt:2100}
  }};
  const runtimeSend = async msg => {
    if (msg.target === 'offscreen' && msg.type === 'SMZ_OFFSCREEN_GET_STATUS') return {active:false};
    if (msg.target === 'offscreen' && msg.type === 'SMZ_OFFSCREEN_START_ARCHIVE') return {ok:true,jobId:msg.jobId};
    return {ok:true};
  };
  const {chrome,getReceiver} = chromeBase(store,runtimeSend);
  const c = vm.createContext({chrome,URL,console:{...console,error(){}},fetch:async()=>{throw new Error('unused');},setTimeout,clearTimeout,AbortController});
  vm.runInContext(read('backup/schema.js')+'\n'+read('background.js'),c);
  await sleep(10);

  let r = await send(getReceiver(),'SMZ_START_ARCHIVE',{
    platform:'x',handle:'demo',selection:{images:false,videos:true},splitMode:'auto',runLimit:null,saveMode:'downloads'
  });
  assert(r.ok,r.error);
  assert.equal(Array.isArray(store.smz_collection_x_demo.savedItemKeys),false,
    'legacy savedKinds without recorded itemKeys must not be converted into guessed exact keys');

  r = await send(getReceiver(),'SMZ_ARCHIVE_PATCH',{
    platform:'x',handle:'demo',patch:{status:'archive_complete',nextItemIndex:1,processedItems:1,totalSelected:1,savedZipCount:1,completedAt:2200}
  });
  assert(r.ok,r.error);
  assert.deepEqual(store.smz_collection_x_demo.savedItemKeys,[video.key],
    'only the newly verified job should become an exact saved key when legacy order is unknown');
  assert.equal(c.canStartNewOnlyCheck(store.smz_collection_x_demo),false,
    'the unknown legacy image history must remain conservatively unsaved until it is re-saved');
}

(async()=>{
  const tests=[
    ['P2 checkpoint persists current saved keys',testCheckpointPersistsCurrentSavedKeys],
    ['P2 trusted legacy kind keys migrate',testTrustedLegacyKindKeysMigrateBeforeNewKind],
    ['P2 unknown legacy order remains conservative',testUnknownLegacyOrderIsNotInventedDuringMigration]
  ];
  const filter=String(process.env.SMZ_TEST_FILTER || '').trim().toLowerCase();
  const selected=filter ? tests.filter(([name])=>name.toLowerCase().includes(filter)) : tests;
  if (!selected.length) throw new Error(`No round3 regression test matched filter: ${filter}`);
  for (const [name,fn] of selected) { await fn(); console.log('PASS',name); }
})().catch(e=>{ console.error(e); process.exitCode=1; });
