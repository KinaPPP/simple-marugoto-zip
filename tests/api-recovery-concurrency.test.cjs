'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const clone = v => v === undefined ? undefined : structuredClone(v);

const THREAD_A = '18011111111111111';
const THREAD_B = '18022222222222222';
const THREAD_IMG = 'https://scontent.cdninstagram.com/v/t51.2885-15/a.jpg?oh=SIGNED&oe=FUTURE';
const DID = 'did:plc:abcdefghijklmnopqrstuvwx';

function baseChrome(store, hooks = {}) {
  let receiver = null;
  let alarmHandler = null;
  const alarms = [];
  const chrome = {
    runtime: {
      getURL: p => `chrome-extension://mock/${p}`,
      onMessage: { addListener(fn) { receiver = fn; } },
      async sendMessage(msg) {
        if (msg?.target === 'offscreen' && msg?.type === 'SMZ_OFFSCREEN_GET_STATUS') return {active:false};
        return {ok:true};
      }
    },
    storage: { local: {
      async get(key) {
        if (key === null) return clone(store);
        if (typeof key === 'string') return {[key]: clone(store[key])};
        if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, clone(store[k])]));
        return clone(store);
      },
      async set(obj) { Object.assign(store, clone(obj)); },
      async remove(keys) { for (const key of [].concat(keys)) delete store[key]; },
      async clear() { for (const key of Object.keys(store)) delete store[key]; }
    }},
    alarms: {
      onAlarm: { addListener(fn) { alarmHandler = fn; } },
      async create(name, info) { alarms.push({name, info: clone(info)}); },
      async clear() { return true; }, async clearAll() { return true; }
    },
    permissions: { async contains() { return true; } },
    tabs: { async query() { return []; }, onActivated:{addListener(){}}, onUpdated:{addListener(){}} },
    windows: { onFocusChanged:{addListener(){}} },
    offscreen: { async hasDocument() { return false; }, async createDocument() {} },
    downloads: { onDeterminingFilename:{addListener(){}}, async download(){return 1;}, async search(){return [];} },
    action: { async setIcon(){}, async setBadgeText(){}, async setBadgeBackgroundColor(){}, async setBadgeTextColor(){}, async setTitle(){} }
  };
  return { chrome, getReceiver: () => receiver, getAlarmHandler: () => alarmHandler, alarms };
}

function loadBackground(store, fetchImpl) {
  const env = baseChrome(store);
  const context = vm.createContext({
    URL, console:{...console,error(){}}, fetch:fetchImpl, chrome:env.chrome,
    setTimeout, clearTimeout, AbortController, structuredClone
  });
  vm.runInContext(read('backup/schema.js') + '\n' + read('providers/bluesky/api.js') + '\n' +
    read('providers/threads/api.js') + '\n' + read('background.js'), context);
  const send = (type, data={}, options=false) => new Promise(resolve => {
    env.getReceiver()({type, ...data}, {url:`chrome-extension://mock/${options ? 'options/options.html' : 'popup/popup.html'}`}, resolve);
  });
  return {...env, context, send};
}

async function waitFor(predicate, label='condition') {
  for (let i=0; i<300; i++) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function threadsCheckpoint(cursor='NEXT_CURSOR') {
  return {
    platform:'threads', handle:'demo.user', ownProfile:true, collectionId:'restart-threads-1',
    collectionMode:'api', status:'collecting', pauseReason:null, startedAt:Date.now()-1000,
    updatedAt:Date.now()-500, completedAt:null, resumeAt:null, pagesFetched:1, scannedPosts:1,
    resumeCursor:cursor, counts:{images:1,videos:0,total:1},
    items:[{platform:'threads', key:`${THREAD_A}_1`, postId:THREAD_A, mediaIndex:1, type:'image',
      url:THREAD_IMG, fallbackUrls:[], extension:'jpg', postedAt:'2026-09-28T00:00:00.000Z'}],
    newestPostId:THREAD_A, oldestPostId:THREAD_A, archive:null
  };
}

async function testThreadsWorkerRecovery() {
  const store = {
    smz_threads_auth_v1:{token:'LONG_TOKEN', username:'demo.user', userId:'1789', autoRenew:true,
      issuedAt:Date.now(), expiresAt:Date.now()+50*86400000},
    'smz_collection_threads_demo.user': threadsCheckpoint()
  };
  const pageUrls = [];
  const fetchImpl = async (input, options={}) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/me/threads')) {
      pageUrls.push(url.toString());
      assert.equal(url.searchParams.get('after'), 'NEXT_CURSOR', 'restart must continue from persisted cursor');
      assert.equal(options.headers?.Authorization, 'Bearer LONG_TOKEN');
      return {ok:true,status:200,headers:{get:()=>null},json:async()=>({
        data:[{id:THREAD_B,media_type:'IMAGE',media_url:THREAD_IMG,timestamp:'2026-09-27T00:00:00+0000'}], paging:{}
      })};
    }
    throw new Error('unexpected fetch '+url);
  };
  const env = loadBackground(store, fetchImpl);
  await waitFor(() => store['smz_collection_threads_demo.user']?.status === 'complete', 'Threads auto recovery');
  const state = store['smz_collection_threads_demo.user'];
  assert.equal(state.counts.total, 2);
  assert.equal(new Set(state.items.map(x=>x.key)).size, 2, 'recovery must not duplicate items');
  assert.equal(state.resumeCursor, null);
  assert.equal(state.pagesFetched, 2);
  assert.equal(state.pauseReason, null);
  assert.equal(pageUrls.length, 1);
  assert(env.alarms.some(a => a.name === 'smz_api_collection_watchdog'), 'API watchdog must be scheduled');
  console.log('PASS API recovery: Threads Service Worker restart resumes persisted cursor and completes without gaps/duplicates');
}

async function testBlueskyWorkerRecovery() {
  const store = {
    'smz_collection_bluesky_artist.example': {
      platform:'bluesky', handle:'artist.example', did:DID, pds:'https://pds.example.com',
      collectionId:'restart-bsky-1', collectionMode:'api', status:'collecting', pauseReason:null,
      startedAt:Date.now()-1000, updatedAt:Date.now()-500, completedAt:null, resumeAt:null,
      pagesFetched:3, scannedPosts:20, resumeCursor:'BSKY_CURSOR', counts:{images:0,videos:0,total:0},
      items:[], newestPostId:null, oldestPostId:null, archive:null
    }
  };
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/xrpc/app.bsky.feed.getAuthorFeed')) {
      assert.equal(url.searchParams.get('cursor'),'BSKY_CURSOR');
      return {ok:true,status:200,headers:{get:()=>null},json:async()=>({feed:[]})};
    }
    throw new Error('unexpected fetch '+url);
  };
  loadBackground(store, fetchImpl);
  await waitFor(() => store['smz_collection_bluesky_artist.example']?.status === 'complete', 'Bluesky auto recovery');
  const state = store['smz_collection_bluesky_artist.example'];
  assert.equal(state.pauseReason, null);
  assert.equal(state.pagesFetched, 4);
  console.log('PASS API recovery: Bluesky uses the same restart-safe persisted cursor path');
}

function blueskyBackup() {
  return {
    format:'simple-marugoto-zip-account-state', version:1, exportedAt:new Date().toISOString(),
    source:{zipNumber:1,mediaKind:'media'},
    account:{
      platform:'bluesky', handle:'backup.example', did:DID, pds:'https://pds.example.com',
      collectionId:'backup-bsky-1', collectionMode:'api', status:'complete', startedAt:Date.now()-1000,
      updatedAt:Date.now(), completedAt:Date.now(), items:[], counts:{images:0,videos:0,total:0},
      newestPostId:null, oldestPostId:null, archive:null
    }, previous:null
  };
}

async function testScopedImportWhileOtherApiRuns() {
  const store = {
    smz_threads_auth_v1:{token:'LONG_TOKEN', username:'demo.user', userId:'1789', autoRenew:true,
      issuedAt:Date.now(), expiresAt:Date.now()+50*86400000},
    'smz_collection_threads_demo.user': threadsCheckpoint('HOLD_CURSOR')
  };
  // Keep Threads in-flight so import tests truly run while another SNS is collecting.
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/me/threads')) return new Promise(()=>{});
    throw new Error('unexpected fetch '+url);
  };
  const env = loadBackground(store, fetchImpl);
  await waitFor(() => env.alarms.some(a => a.name === 'smz_api_collection_watchdog'), 'watchdog schedule');

  let r = await env.send('SMZ_BACKUP_IMPORT', {data:blueskyBackup(), mode:'merge'}, true);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.imported, 1, 'unrelated Bluesky backup should import while Threads is collecting');
  assert.equal(store['smz_collection_threads_demo.user'].status, 'collecting');
  assert.equal(store['smz_collection_bluesky_backup.example'].status, 'complete');

  r = await env.send('SMZ_BACKUP_IMPORT', {data:blueskyBackup(), mode:'replace-accounts'}, true);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.imported, 1, 'replace-accounts should only lock its actual target');

  const threadBackup = {
    format:'simple-marugoto-zip-account-state', version:1, exportedAt:new Date().toISOString(), source:{zipNumber:1,mediaKind:'media'},
    account:threadsCheckpoint(null), previous:null
  };
  r = await env.send('SMZ_BACKUP_IMPORT', {data:threadBackup, mode:'replace-accounts'}, true);
  assert.equal(r.ok, false, 'the actively collecting target itself must remain protected');
  assert.match(r.error, /Threads @demo\.user.*処理中/);

  const full = {
    format:'simple-marugoto-zip-full-backup', version:1, exportedAt:new Date().toISOString(),
    settings:{includeImages:true,includeVideos:true,splitMode:'auto',downloadLimit:'all',collectionMode:'manual'},
    accounts:[{current:blueskyBackup().account, previous:null}]
  };
  r = await env.send('SMZ_BACKUP_IMPORT', {data:full, mode:'replace-all'}, true);
  assert.equal(r.ok, false, 'replace-all still must stop every active collection');
  assert.match(r.error, /全体置換.*すべて終わってから/);
  console.log('PASS scoped restore lock: unrelated SNS restore is allowed; active target and replace-all remain protected');
}

(async()=>{
  await testThreadsWorkerRecovery();
  await testBlueskyWorkerRecovery();
  await testScopedImportWhileOtherApiRuns();
})().catch(err => { console.error(err); process.exitCode = 1; });
