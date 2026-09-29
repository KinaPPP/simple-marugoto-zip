'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const clone = v => v === undefined ? undefined : structuredClone(v);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

async function send(receiver, type, data={}, options=false) {
  return await new Promise(resolve => receiver({type, ...data}, {url:`chrome-extension://mock/${options?'options/options.html':'popup/popup.html'}`}, resolve));
}

function item(platform, id, type='image') {
  const host = platform === 'threads' ? 'https://scontent.cdninstagram.com' : platform === 'bluesky' ? 'https://cdn.bsky.app' : 'https://pbs.twimg.com';
  const url = platform === 'threads' ? `${host}/${id}.jpg?oh=SAFE` : platform === 'bluesky' ? `${host}/img/feed_fullsize/plain/did:plc:abcdefghijklmnopqrstuvwx/bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@jpeg` : `${host}/media/${id}.jpg?name=orig`;
  return {platform, key:`${id}_1`, postId:String(id), mediaIndex:1, type, url, fallbackUrls:[], extension:type==='video'?'mp4':'jpg', postedAt:'2026-09-29T00:00:00Z'};
}

function completeState(platform) {
  const ids = platform === 'bluesky' ? ['post300','post200'] : platform === 'threads' ? ['18030000000000000','18020000000000000'] : ['300','200'];
  const items = ids.map(id => item(platform,id));
  return {
    platform, handle: platform === 'bluesky' ? 'demo.example' : 'demo', status:'complete', collectionId:'job-1',
    items, counts:{images:2,videos:0,total:2}, newestPostId:ids[0], oldestPostId:ids[1],
    completedAt:2000, updatedAt:2000, savedKinds:{images:true,videos:true},
    archive:{status:'archive_complete', collectionId:'job-1', collectionCompletedAt:1000,
      selection:{images:true,videos:false}, splitMode:'auto', mediaKind:'images', itemKeys:[`${ids[1]}_1`],
      nextItemIndex:1, processedItems:1, totalSelected:1, nextZipNumber:2, savedZipCount:1, completedAt:1500}
  };
}

async function testDeltaStartRejectsItemsAddedAfterArchive() {
  const store = {};
  const {chrome} = chromeBase(store);
  const c = vm.createContext({chrome,SMZThreads:{validId:id=>/^\d{5,30}$/.test(String(id))},URL,console:{...console,error(){}},fetch:async()=>{throw new Error('unused');},setTimeout,clearTimeout,AbortController});
  vm.runInContext(read('backup/schema.js')+'\n'+read('background.js'), c);
  await sleep(5);
  for (const platform of ['x','bluesky','threads']) {
    const state = completeState(platform);
    assert.equal(c.canStartNewOnlyCheck(state), false, `${platform}: current media added after the completed archive must block a new-only check`);
    state.archive.itemKeys.push(state.items[0].key);
    state.archive.totalSelected = 2;
    state.archive.nextItemIndex = 2;
    state.archive.processedItems = 2;
    state.archive.collectionCompletedAt = state.completedAt;
    assert.equal(c.canStartNewOnlyCheck(state), true, `${platform}: after all current media are covered, new-only check should be allowed`);
  }
}

function loadBackup() {
  const c = vm.createContext({URL,console});
  vm.runInContext(read('backup/schema.js'), c);
  return c.SMZBackup;
}

function legacyXState() {
  return {
    platform:'x',handle:'demo',status:'complete',collectionId:'job-1',collectionMode:'auto',schemaVersion:3,
    items:[item('x','300'),item('x','200')],counts:{images:2,videos:0,total:2},newestPostId:'300',oldestPostId:'200',
    completedAt:2000,updatedAt:2000,savedKinds:{images:true,videos:false},
    archive:{status:'archive_paused',collectionId:'job-1',selection:{images:true,videos:false},splitMode:'auto',mediaKind:'images',
      nextItemIndex:1,nextZipNumber:2,savedZipCount:1,processedItems:1,totalSelected:1,currentZipNumber:2,startedAt:1000,updatedAt:1000}
  };
}

async function testLegacyBackupDoesNotInventFrozenOrder() {
  const SMZBackup = loadBackup();
  const old = legacyXState();
  const full = SMZBackup.fullEnvelope({smz_collection_x_demo:old});
  const exported = full.accounts[0].current;
  assert.equal(Array.isArray(exported.archive.itemKeys), false, 'full backup must not invent archive itemKeys when the old checkpoint never stored them');

  const imported = SMZBackup.normalizeImport({format:'simple-marugoto-zip-account-state',version:1,source:{zipNumber:1,mediaKind:'images'},account:old,previous:null});
  assert.equal(Array.isArray(imported.accounts[0].current.archive.itemKeys), false, 'direct old backup import must preserve unknown archive order as unknown');
}

async function testBoundaryMissingBlocksArchiveAndCanRollback() {
  const previous = {
    platform:'threads',handle:'demo',status:'complete',collectionId:'prev',ownProfile:true,authUserId:'UID_A',
    items:[item('threads','18020000000000000')],counts:{images:1,videos:0,total:1},newestPostId:'18020000000000000',oldestPostId:'18020000000000000',completedAt:1000,updatedAt:1000,
    savedKinds:{images:true,videos:true},archive:{status:'archive_complete',collectionId:'prev',selection:{images:true,videos:true},splitMode:'auto',mediaKind:'media',itemKeys:['18020000000000000_1'],nextItemIndex:1,processedItems:1,totalSelected:1,nextZipNumber:2,savedZipCount:1,completedAt:1200}
  };
  const current = {
    platform:'threads',handle:'demo',status:'paused',pauseReason:'delta_boundary_missing',deltaMode:true,deltaVerified:false,deltaBoundaryReached:false,
    deltaBaselinePostId:'18030000000000000',deltaBaselineCounts:{images:2,videos:0,total:2},collectionId:'delta',ownProfile:true,authUserId:'UID_A',
    items:[item('threads','18020000000000000')],counts:{images:1,videos:0,total:1},newestPostId:'18020000000000000',oldestPostId:'18020000000000000',completedAt:null,updatedAt:2000,
    archive:{status:'archive_complete',collectionId:'delta',selection:{images:true,videos:true},splitMode:'auto',mediaKind:'media',itemKeys:['18020000000000000_1'],nextItemIndex:1,processedItems:1,totalSelected:1,nextZipNumber:2,savedZipCount:1,completedAt:2100}
  };
  const store={
    smz_threads_auth_v1:{token:'TOKEN_A',username:'demo',userId:'UID_A',autoRenew:true,expiresAt:Date.now()+1e9},
    smz_collection_threads_demo:clone(current),
    smz_previous_collection_threads_demo:clone(previous)
  };
  const runtimeSend=async msg=>{
    if(msg.target==='offscreen' && msg.type==='SMZ_OFFSCREEN_GET_STATUS') return {active:false};
    if(msg.target==='offscreen' && msg.type==='SMZ_OFFSCREEN_START_ARCHIVE') return {ok:true,jobId:msg.jobId};
    return {ok:true};
  };
  const {chrome,getReceiver}=chromeBase(store,runtimeSend);
  const SMZThreads={validId(){return true;},async refresh(){throw new Error('unused');}};
  const c=vm.createContext({chrome,SMZThreads,URL,console:{...console,error(){}},fetch:async()=>{throw new Error('unused');},setTimeout,clearTimeout,AbortController});
  vm.runInContext(read('backup/schema.js')+'\n'+read('background.js'),c);
  await sleep(10);

  const start=await send(getReceiver(),'SMZ_START_ARCHIVE',{platform:'threads',handle:'demo',selection:{images:true,videos:true},splitMode:'auto',runLimit:null,saveMode:'downloads'});
  assert.equal(start.ok,false,'unverified delta_boundary_missing candidates must not be archivable as normal delta media');

  const rollback=await send(getReceiver(),'SMZ_THREADS_CANCEL_DELTA',{handle:'demo'});
  assert.equal(rollback.ok,true,'delta_boundary_missing must always retain a path back to the previous snapshot, even if an old buggy build already saved a candidate ZIP');
  assert.equal(store.smz_collection_threads_demo.collectionId,'prev');
  assert.equal(store.smz_previous_collection_threads_demo,undefined);
}

async function testExactSavedKeysAcrossSeparateKinds() {
  const image = item('x','300','image');
  const video = item('x','200','video');
  const store={smz_collection_x_demo:{
    platform:'x',handle:'demo',status:'complete',collectionId:'job-1',items:[image,video],counts:{images:1,videos:1,total:2},
    newestPostId:'300',oldestPostId:'200',completedAt:2000,updatedAt:2000,savedKinds:{images:false,videos:false},savedItemKeys:[],
    archive:{status:'archiving',collectionId:'job-1',collectionCompletedAt:2000,jobId:'IMG',selection:{images:true,videos:false},splitMode:'auto',mediaKind:'images',itemKeys:[image.key],nextItemIndex:0,processedItems:0,totalSelected:1,nextZipNumber:1,savedZipCount:0}
  }};
  const {chrome,getReceiver}=chromeBase(store);
  const c=vm.createContext({chrome,SMZThreads:{validId:id=>/^\d{5,30}$/.test(String(id))},URL,console:{...console,error(){}},fetch:async()=>{throw new Error('unused');},setTimeout,clearTimeout,AbortController});
  vm.runInContext(read('backup/schema.js')+'\n'+read('background.js'),c);
  await sleep(10);
  let r=await send(getReceiver(),'SMZ_ARCHIVE_PATCH',{platform:'x',handle:'demo',patch:{status:'archive_complete',nextItemIndex:1,processedItems:1,totalSelected:1,savedZipCount:1,completedAt:2100}});
  assert(r.ok,r.error);
  assert.deepEqual(store.smz_collection_x_demo.savedItemKeys,[image.key]);
  assert.equal(c.canStartNewOnlyCheck(store.smz_collection_x_demo),false,'saving only images must not authorize delta while a video is unsaved');

  store.smz_collection_x_demo.archive={status:'archiving',collectionId:'job-1',collectionCompletedAt:2000,jobId:'VID',selection:{images:false,videos:true},splitMode:'auto',mediaKind:'videos',itemKeys:[video.key],nextItemIndex:0,processedItems:0,totalSelected:1,nextZipNumber:1,savedZipCount:0};
  r=await send(getReceiver(),'SMZ_ARCHIVE_PATCH',{platform:'x',handle:'demo',patch:{status:'archive_complete',nextItemIndex:1,processedItems:1,totalSelected:1,savedZipCount:1,completedAt:2200}});
  assert(r.ok,r.error);
  assert.deepEqual(new Set(store.smz_collection_x_demo.savedItemKeys),new Set([image.key,video.key]));
  assert.equal(c.canStartNewOnlyCheck(store.smz_collection_x_demo),true,'after both exact keys are finalized, delta should be allowed');
}

async function testBoundaryMissingUiGuardsExist() {
  const popup=read('popup/popup.js');
  assert.match(popup,/function isDeltaBoundaryMissing/);
  assert.match(popup,/els\.zipBtn\.disabled = boundaryMissingDelta \|\|/,'boundary-missing UI must disable normal ZIP save');
  assert.match(popup,/今回候補 .*未確定/,'boundary-missing UI must label candidate counts as unconfirmed');
  assert.match(popup,/canReturnToPreviousDelta\(state\)/,'boundary-missing UI must preserve previous-snapshot rollback');
}

(async()=>{
  const tests=[
    ['P1 block delta when newly collected items are not archived',testDeltaStartRejectsItemsAddedAfterArchive],
    ['P1 legacy backup keeps unknown archive order unknown',testLegacyBackupDoesNotInventFrozenOrder],
    ['P2 boundary-missing delta blocks ZIP and remains reversible',testBoundaryMissingBlocksArchiveAndCanRollback],
    ['P1 exact saved keys across separate image/video jobs',testExactSavedKeysAcrossSeparateKinds],
    ['P2 boundary-missing popup guards',testBoundaryMissingUiGuardsExist]
  ];
  const filter=String(process.env.SMZ_TEST_FILTER||'').trim().toLowerCase();
  const selected=filter?tests.filter(([name])=>name.toLowerCase().includes(filter)):tests;
  if(!selected.length) throw new Error('No test matched '+filter);
  for(const [name,fn] of selected){ await fn(); console.log('PASS',name); }
})().catch(e=>{console.error(e);process.exitCode=1;});
