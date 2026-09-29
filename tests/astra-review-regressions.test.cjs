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
    tabs: { async query(){return [];}, async get(){return null;}, onActivated:{addListener(){}}, onUpdated:{addListener(){}} },
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

async function testArchiveStableOrder() {
  const fetches = [];
  const state = {
    platform:'x', handle:'demo', status:'paused', collectionMode:'auto', collectionId:'job-1',
    items:[
      {platform:'x',handle:'demo',key:'300_1',postId:'300',mediaIndex:1,type:'image',url:'https://pbs.twimg.com/media/300.jpg?name=orig',fallbackUrls:[],extension:'jpg'},
      {platform:'x',handle:'demo',key:'200_1',postId:'200',mediaIndex:1,type:'image',url:'https://pbs.twimg.com/media/200.jpg?name=orig',fallbackUrls:[],extension:'jpg'}
    ],
    counts:{images:2,videos:0,total:2}, newestPostId:'300', oldestPostId:'200', completedAt:Date.now(),
    archive:{status:'archive_paused',collectionId:'job-1',selection:{images:true,videos:false},splitMode:'auto',mediaKind:'images',
      itemKeys:['200_1','300_1'],nextItemIndex:1,nextZipNumber:2,savedZipCount:1,processedItems:1,totalSelected:2,
      currentZipNumber:2,startedAt:Date.now(),saveMode:'directory',saveDirectoryKey:'test',saveDirectoryName:'test'}
  };
  const outputs=[];
  const fsMock={async openWritableFile(_key, filename){
    const chunks=[];
    return {filename,directoryName:'test',writable:{async write(d){chunks.push(Buffer.from(d));},async close(){outputs.push(filename);},async abort(){}},async remove(){}};
  }};
  let handler;
  const chrome={runtime:{onMessage:{addListener(fn){handler=fn;}},async sendMessage(msg){
    if(msg.type==='SMZ_ARCHIVE_GET_STATE') return {ok:true,state:clone(state),previous:null};
    if(msg.type==='SMZ_ARCHIVE_PATCH'){state.archive={...state.archive,...clone(msg.patch)};return {ok:true,state:clone(state)};}
    throw new Error('unexpected '+msg.type);
  }}};
  const c=vm.createContext({chrome,SMZFileSystem:fsMock,URL,console,fetch:async url=>{
    fetches.push(String(url));
    return {ok:true,headers:{get:()=> 'image/jpeg'},arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer};
  },Blob,Response,CompressionStream,TextEncoder,TextDecoder,DataView,Uint8Array,Uint32Array,setTimeout,clearTimeout});
  vm.runInContext(read('backup/schema.js')+'\n'+read('archive/offscreen.js'),c);
  handler({target:'offscreen',type:'SMZ_OFFSCREEN_START_ARCHIVE',platform:'x',handle:'demo',selection:{images:true,videos:false},mediaKind:'images',splitMode:'auto',saveMode:'directory',saveDirectoryKey:'test'}, {}, ()=>{});
  for(let i=0;i<200 && state.archive.status!=='archive_complete';i++) await sleep(5);
  assert.equal(state.archive.status,'archive_complete');
  assert.equal(fetches.length,1,'resume should process exactly the one unsaved item');
  assert.match(fetches[0],/300\.jpg/,'resume must follow the frozen archive item order, not the re-sorted collection array');
}


async function testArchiveStartExtendsFrozenOrder() {
  const store={smz_collection_x_demo:{platform:'x',handle:'demo',status:'paused',collectionId:'job-1',items:[
    {platform:'x',handle:'demo',key:'300_1',postId:'300',mediaIndex:1,type:'image',url:'https://pbs.twimg.com/media/300.jpg?name=orig',fallbackUrls:[],extension:'jpg'},
    {platform:'x',handle:'demo',key:'200_1',postId:'200',mediaIndex:1,type:'image',url:'https://pbs.twimg.com/media/200.jpg?name=orig',fallbackUrls:[],extension:'jpg'}
  ],counts:{images:2,videos:0,total:2},newestPostId:'300',oldestPostId:'200',archive:{status:'archive_paused',collectionId:'job-1',jobId:'OLD_JOB',itemKeys:['200_1'],selection:{images:true,videos:false},splitMode:'auto',mediaKind:'images',nextItemIndex:1,nextZipNumber:2,savedZipCount:1,totalSelected:1,startedAt:Date.now()}}};
  const runtimeSend=async msg=>{
    if(msg.target==='offscreen' && msg.type==='SMZ_OFFSCREEN_GET_STATUS')return {active:false};
    if(msg.target==='offscreen' && msg.type==='SMZ_OFFSCREEN_START_ARCHIVE')return {ok:true,jobId:msg.jobId};
    return {ok:true};
  };
  const {chrome,getReceiver}=chromeBase(store,runtimeSend);
  const c=vm.createContext({chrome,URL,console:{...console,error(){}},fetch:async()=>{throw new Error('unused');},setTimeout,clearTimeout,AbortController});
  vm.runInContext(read('backup/schema.js')+'\n'+read('background.js'),c);
  await sleep(10);
  const r=await send(getReceiver(),'SMZ_START_ARCHIVE',{platform:'x',handle:'demo',selection:{images:true,videos:false},splitMode:'auto',runLimit:null,saveMode:'downloads'});
  assert(r.ok,r.error);
  assert.deepEqual(store.smz_collection_x_demo.archive.itemKeys,['200_1','300_1'],'new items must append to the frozen archive order');
  assert.equal(store.smz_collection_x_demo.archive.nextItemIndex,1,'resume position must continue after the already processed key');
}

async function testThreadsTokenSwitchRejected() {
  const store={smz_threads_auth_v1:{token:'TOKEN_A',username:'alice',userId:'UID_A',autoRenew:true,expiresAt:Date.now()+1e9}};
  const {chrome,getReceiver}=chromeBase(store);
  const SMZThreads={
    async me(token){ return token==='TOKEN_B'?{handle:'bob',id:'UID_B'}:{handle:'alice',id:'UID_A'}; },
    async refresh(){throw new Error('unused');}, validId(){return true;}
  };
  const c=vm.createContext({chrome,SMZThreads,URL,console:{...console,error(){}},fetch:async()=>{throw new Error('unused');},setTimeout,clearTimeout,AbortController});
  vm.runInContext(read('backup/schema.js')+'\n'+read('background.js'),c);
  await sleep(10);
  store.smz_collection_threads_alice={platform:'threads',handle:'alice',status:'collecting',collectionId:'collect-a',ownProfile:true,authUserId:'UID_A',items:[],counts:{images:0,videos:0,total:0},archive:null};
  const r=await send(getReceiver(),'SMZ_THREADS_CONNECT',{token:'TOKEN_B',autoRenew:true},true);
  assert.equal(r.ok,false,'switching to another Threads user while collecting must be rejected');
  assert.equal(store.smz_threads_auth_v1.userId,'UID_A','active auth must remain unchanged');
}


async function testThreadsRecoveryAuthMismatchPauses() {
  const store={
    smz_threads_auth_v1:{token:'TOKEN_B',username:'bob',userId:'UID_B',autoRenew:true,expiresAt:Date.now()+1e9},
    smz_collection_threads_alice:{platform:'threads',handle:'alice',status:'collecting',collectionId:'collect-a',ownProfile:true,authUserId:'UID_A',resumeCursor:'CUR',items:[],counts:{images:0,videos:0,total:0}}
  };
  let pageCalled=false;
  const {chrome}=chromeBase(store);
  const SMZThreads={async page(){pageCalled=true;throw new Error('must not fetch');},validId(){return true;},async refresh(){throw new Error('unused');}};
  const c=vm.createContext({chrome,SMZThreads,URL,console:{...console,error(){}},fetch:async()=>{throw new Error('unused');},setTimeout,clearTimeout,AbortController});
  vm.runInContext(read('backup/schema.js')+'\n'+read('background.js'),c);
  for(let i=0;i<100 && store.smz_collection_threads_alice.status==='collecting';i++)await sleep(5);
  assert.equal(store.smz_collection_threads_alice.status,'paused');
  assert.equal(store.smz_collection_threads_alice.pauseReason,'auth','worker recovery must refuse a mismatched auth user');
  assert.equal(pageCalled,false,'mismatched auth must be detected before any Threads page fetch');
}

async function testArchiveBusyRejectedAndStatePreserved() {
  const store={smz_collection_x_b:{platform:'x',handle:'b',status:'complete',collectionId:'b1',items:[
    {platform:'x',handle:'b',key:'20_1',postId:'20',mediaIndex:1,type:'image',url:'https://pbs.twimg.com/media/b.jpg?name=orig',fallbackUrls:[],extension:'jpg'}
  ],counts:{images:1,videos:0,total:1},newestPostId:'20',oldestPostId:'20',completedAt:Date.now(),savedKinds:{images:false,videos:false}}};
  const runtimeSend=async msg=>{
    if(msg.target==='offscreen' && msg.type==='SMZ_OFFSCREEN_START_ARCHIVE') return {ok:false,error:'別のZIP保存が進行中です'};
    if(msg.target==='offscreen' && msg.type==='SMZ_OFFSCREEN_GET_STATUS') return {active:true,platform:'x',handle:'a',jobId:'A'};
    return {ok:true};
  };
  const {chrome,getReceiver}=chromeBase(store,runtimeSend);
  const c=vm.createContext({chrome,URL,console:{...console,error(){}},fetch:async()=>{throw new Error('unused');},setTimeout,clearTimeout,AbortController});
  vm.runInContext(read('backup/schema.js')+'\n'+read('background.js'),c);
  await sleep(10);
  const r=await send(getReceiver(),'SMZ_START_ARCHIVE',{platform:'x',handle:'b',selection:{images:true,videos:false},splitMode:'auto',runLimit:null,saveMode:'downloads'});
  assert.equal(r.ok,false,'a second archive must be rejected if offscreen already has an active job');
  assert.notEqual(store.smz_collection_x_b.archive?.status,'archiving','rejected archive must not leave B in archiving state');
}


async function testOffscreenStopIsJobScoped() {
  let handler;
  let resolveFetch;
  const state={platform:'x',handle:'a',status:'complete',collectionId:'a1',items:[
    {platform:'x',handle:'a',key:'10_1',postId:'10',mediaIndex:1,type:'image',url:'https://pbs.twimg.com/media/a.jpg?name=orig',fallbackUrls:[],extension:'jpg'}
  ],counts:{images:1,videos:0,total:1},archive:{status:'archiving',collectionId:'a1',jobId:'JOB_A',itemKeys:['10_1'],selection:{images:true,videos:false},splitMode:'auto',mediaKind:'images',nextItemIndex:0,nextZipNumber:1,savedZipCount:0,totalSelected:1,startedAt:Date.now(),saveMode:'directory',saveDirectoryKey:'test'}};
  const fsMock={async openWritableFile(_key,filename){return {filename,directoryName:'test',writable:{async write(){},async close(){},async abort(){}},async remove(){}};}};
  const chrome={runtime:{onMessage:{addListener(fn){handler=fn;}},async sendMessage(msg){
    if(msg.type==='SMZ_ARCHIVE_GET_STATE')return {ok:true,state:clone(state),previous:null};
    if(msg.type==='SMZ_ARCHIVE_PATCH'){state.archive={...state.archive,...clone(msg.patch)};return {ok:true,state:clone(state)};}
    throw new Error('unexpected '+msg.type);
  }}};
  const c=vm.createContext({chrome,SMZFileSystem:fsMock,URL,console,fetch:async()=>await new Promise(resolve=>{resolveFetch=()=>resolve({ok:true,headers:{get:()=> 'image/jpeg'},arrayBuffer:async()=>new Uint8Array([1]).buffer});}),Blob,Response,CompressionStream,TextEncoder,TextDecoder,DataView,Uint8Array,Uint32Array,setTimeout,clearTimeout});
  vm.runInContext(read('backup/schema.js')+'\n'+read('archive/offscreen.js'),c);
  const call=(msg)=>new Promise(resolve=>{let done=false;handler(msg,{},r=>{done=true;resolve(r)});setTimeout(()=>{if(!done)resolve(undefined)},50)});
  let r=await call({target:'offscreen',type:'SMZ_OFFSCREEN_START_ARCHIVE',platform:'x',handle:'a',jobId:'JOB_A',selection:{images:true,videos:false},mediaKind:'images',splitMode:'auto',saveMode:'directory',saveDirectoryKey:'test'});
  assert.equal(r?.ok,true,'offscreen start must acknowledge the reserved job');
  r=await call({target:'offscreen',type:'SMZ_OFFSCREEN_STOP_ARCHIVE',platform:'x',handle:'b',jobId:'JOB_B'});
  assert.equal(r?.ok,false,'B must not be able to stop A');
  const status=await call({target:'offscreen',type:'SMZ_OFFSCREEN_GET_STATUS'});
  assert.equal(status?.jobId,'JOB_A');
  r=await call({target:'offscreen',type:'SMZ_OFFSCREEN_STOP_ARCHIVE',platform:'x',handle:'a',jobId:'JOB_A'});
  assert.equal(r?.ok,true,'the matching job must be stoppable');
  if(resolveFetch) resolveFetch();
  await sleep(20);
}

async function testThreadsDeletedBaselineUsesKnownPreviousPost() {
  const OLD1='18020000000000000', OLD2='18010000000000000';
  const item=id=>({platform:'threads',key:`${id}_1`,postId:id,mediaIndex:1,type:'image',url:'https://scontent.cdninstagram.com/a.jpg?oh=S',fallbackUrls:[],extension:'jpg',postedAt:id===OLD1?'2026-09-28T00:00:00Z':'2026-09-27T00:00:00Z'});
  const store={
    smz_threads_auth_v1:{token:'TOKEN_A',username:'alice',userId:'UID_A',autoRenew:true,expiresAt:Date.now()+1e9},
    smz_collection_threads_alice:{platform:'threads',handle:'alice',status:'complete',collectionId:'base1',ownProfile:true,authUserId:'UID_A',items:[item(OLD1),item(OLD2)],counts:{images:2,videos:0,total:2},newestPostId:OLD1,oldestPostId:OLD2,completedAt:Date.now()-1000,savedKinds:{images:true,videos:true},archive:{status:'archive_complete',collectionId:'base1',selection:{images:true,videos:true},splitMode:'auto',mediaKind:'media',nextItemIndex:2,processedItems:2,totalSelected:2,nextZipNumber:2,savedZipCount:1,completedAt:Date.now()-500}}
  };
  const {chrome,getReceiver}=chromeBase(store);
  const SMZThreads={
    async profile(){return {handle:'alice',id:'TARGET_A',own:true};},
    async page(){return {data:[{id:OLD2}],cursor:null};},
    validId(id){return /^\d{5,30}$/.test(String(id));},
    async extract(post){return {items:[item(String(post.id))]};},
    async refresh(){throw new Error('unused');}
  };
  const c=vm.createContext({chrome,SMZThreads,URL,console:{...console,error(){}},fetch:async()=>{throw new Error('unused');},setTimeout,clearTimeout,AbortController});
  vm.runInContext(read('backup/schema.js')+'\n'+read('background.js'),c);
  await sleep(10);
  const r=await send(getReceiver(),'SMZ_THREADS_START_COLLECTION',{handle:'alice',newOnly:true});
  assert(r.ok,r.error);
  for(let i=0;i<100;i++){
    const s=store.smz_collection_threads_alice;
    if(s?.lastNewCheckResult===0 || (s?.deltaMode && ['complete','paused'].includes(s.status))) break;
    await sleep(10);
  }
  const final=store.smz_collection_threads_alice;
  assert.equal(final.lastNewCheckResult,0,'deleted baseline should fall back to another known previous post and confirm zero new media');
  assert.equal(final.counts.total,2,'previous media must not be re-added to cumulative counts');
  assert.notEqual(final.deltaMode,true,'zero-new delta should restore the previous snapshot');
}

(async()=>{
  const tests=[
    ['P1 archive stable order',testArchiveStableOrder],
    ['P1 archive order extension',testArchiveStartExtendsFrozenOrder],
    ['P1 Threads auth switch',testThreadsTokenSwitchRejected],
    ['P1 Threads recovery auth binding',testThreadsRecoveryAuthMismatchPauses],
    ['P2 archive exclusivity',testArchiveBusyRejectedAndStatePreserved],
    ['P2 archive stop scoping',testOffscreenStopIsJobScoped],
    ['P2 Threads deleted delta baseline',testThreadsDeletedBaselineUsesKnownPreviousPost]
  ];
  const filter=String(process.env.SMZ_TEST_FILTER || '').trim().toLowerCase();
  const selected=filter ? tests.filter(([name])=>name.toLowerCase().includes(filter)) : tests;
  if(!selected.length) throw new Error(`No regression test matched filter: ${filter}`);
  for(const [name,fn] of selected){ await fn(); console.log('PASS',name); }
})().catch(e=>{console.error(e);process.exitCode=1;});
