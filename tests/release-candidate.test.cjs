'use strict';
// v1.0.0: Xへのアクセスなしで初期値・UI・300ファイル/300 MB・旧ジョブ互換性を検証。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = (part) => fs.readFileSync(path.join(root, part), 'utf8');
const clone = (v) => structuredClone(v);
const manifest = JSON.parse(read('manifest.json'));
const popup = read('popup/popup.html');
const options = read('options/options.html');
const popupCode = read('popup/popup.js');
assert.equal(manifest.version, '1.0.0');
assert.match(popup, /name="collectionMode"[^>]*value="manual" checked/);
assert.doesNotMatch(popup, /name="collectionMode"[^>]*value="auto" checked/);
assert.doesNotMatch(popup, /name="split"[^>]*value="10files"/);
assert.match(popup, /300 MBまたは300ファイル/);
assert.doesNotMatch(options, /id="diagnosticDetails"|id="refreshSessionsBtn"|疑似429テスト/);
assert.match(popupCode, /collectionMode:\s*'manual'/);
assert.doesNotMatch(popupCode, /\['auto','500mb','1gb','10files','500files'\]/);
const backupVm = vm.createContext({URL, console});
vm.runInContext(read('backup/schema.js'), backupVm);
assert.equal(backupVm.SMZBackup.safeSettings(null).collectionMode, 'manual');
assert.equal(backupVm.SMZBackup.safeSettings({collectionMode:'auto'}).collectionMode,'auto');
assert.equal(backupVm.SMZBackup.safeSettings({collectionMode:'manual'}).collectionMode,'manual');
console.log('PASS release UI: v1.0.0, new user manual, existing auto retained, no debug/10-file choices');

async function splitTest(total, fileBytes, scaledMB, expectedIndexes) {
  const items = Array.from({length:total},(_,i)=>({
    platform:'x',handle:'demo', key:`${2100000000000000000n-BigInt(i)}_1`,
    postId:String(2100000000000000000n-BigInt(i)), mediaIndex:1, type:'image',
    url:`https://pbs.twimg.com/media/${i}.jpg?name=orig`,fallbackUrls:[],extension:'jpg'
  }));
  let state = {platform:'x',handle:'demo',status:'complete',collectionMode:'manual',collectionId:'rc24',
    items,counts:{images:total,videos:0,total},newestPostId:items[0].postId,
    oldestPostId:items.at(-1).postId,completedAt:Date.now(),
    archive:{status:'archiving',collectionId:'rc24',selection:{images:true,videos:false},
      splitMode:'auto',mediaKind:'images',nextItemIndex:0,nextZipNumber:1,savedZipCount:0,
      startedAt:Date.now(),saveMode:'directory',saveDirectoryKey:'test',saveDirectoryName:'test'}};
  const outputs = [];
  const fsMock = {async openWritableFile(_key, filename) {
    const chunks = [];
    return {filename,directoryName:'test',writable:{
      async write(data){chunks.push(Buffer.from(data));},
      async close(){outputs.push({filename, buffer:Buffer.concat(chunks)});},async abort(){}},
      async remove(){}};
  }};
  let messageHandler;
  const chrome = {runtime:{onMessage:{addListener(fn){messageHandler=fn;}},
    async sendMessage(msg){
      if(msg.type==='SMZ_ARCHIVE_GET_STATE')return {ok:true,state:clone(state),previous:null};
      if(msg.type==='SMZ_ARCHIVE_PATCH'){
        state.archive={...state.archive,...clone(msg.patch)};
        return {ok:true,state:clone(state)};
      }
      throw new Error('unexpected '+msg.type);
    }}};
  const vmContext = vm.createContext({chrome,SMZFileSystem:fsMock,URL,console,
    fetch: async()=>({ok:true,headers:{get:()=> 'image/jpeg'},
      arrayBuffer:async()=>new Uint8Array(fileBytes).buffer}),
    Blob,Response,CompressionStream,TextEncoder,TextDecoder,DataView,Uint8Array,Uint32Array,
    setTimeout,clearTimeout});
  const offscreen = read('archive/offscreen.js').replace(
    'const MB = 1024 * 1024;', scaledMB ? 'const MB = 1;' : 'const MB = 1024 * 1024;');
  vm.runInContext(read('backup/schema.js')+'\n'+offscreen,vmContext);
  const limit = vm.runInContext('LIMITS.auto',vmContext);
  assert.equal(limit.bytes,scaledMB?300:300*1024*1024);
  assert.equal(limit.files,300);
  messageHandler({target:'offscreen',type:'SMZ_OFFSCREEN_START_ARCHIVE',handle:'demo',
    platform:'x',selection:{images:true,videos:false},mediaKind:'images',splitMode:'auto',
    saveMode:'directory',saveDirectoryKey:'test',runLimit:null},{},()=>{});
  for(let i=0;i<2000 && !['archive_complete','archive_error'].includes(state.archive.status);i++)
    await new Promise(r=>setTimeout(r,5));
  assert.equal(state.archive.status,'archive_complete',state.archive.lastError);
  assert.equal(outputs.length,expectedIndexes.length);
  const zipVm=vm.createContext({Blob,Response,DecompressionStream,TextEncoder,TextDecoder,
    Uint8Array,Uint32Array,DataView,URL,console});
  vm.runInContext(read('backup/schema.js')+'\n'+read('backup/zip-reader.js'),zipVm);
  const positions=[];
  for (const zip of outputs) {
    const parsed=await zipVm.SMZZipReader.accountJsonFromZip(new Blob([zip.buffer]));
    positions.push(parsed.accounts[0].current.archive.nextItemIndex);
  }
  assert.deepEqual(positions,expectedIndexes);
  assert.deepEqual(outputs.map(o=>o.filename.match(/_(\d{3})\.zip$/)[1]),
    expectedIndexes.map((_,i)=>String(i+1).padStart(3,'0')));
}
async function legacyTest() {
  let handler;
  const store={smz_collection_x_demo:{platform:'x',handle:'demo',status:'complete',
    collectionId:'old-run',counts:{total:12,images:12,videos:0},
    archive:{status:'archive_paused',collectionId:'old-run',selection:{images:true,videos:false},
      splitMode:'10files',mediaKind:'images',nextItemIndex:10,nextZipNumber:2}}};
  const offscreenMessages=[];
  const chrome={runtime:{getURL:p=>`chrome-extension://mock/${p}`,
    onMessage:{addListener(fn){handler=fn;}},async sendMessage(msg){
      if(msg.target==='offscreen')offscreenMessages.push(msg);
      return {ok:true};}},
    storage:{local:{async get(key){
      if(key===null)return clone(store);
      if(typeof key==='string')return {[key]:clone(store[key])};
      const result={};for(const k of key)result[k]=clone(store[k]);return result;
    },async set(obj){Object.assign(store,clone(obj));},async remove(keys){for(const k of [].concat(keys))delete store[k];}}},
    tabs:{async query(){return []},onActivated:{addListener(){}},onUpdated:{addListener(){}}},
    windows:{onFocusChanged:{addListener(){}}},offscreen:{async hasDocument(){return true}},
    alarms:{onAlarm:{addListener(){}},async clear(){return true}},
    downloads:{onDeterminingFilename:{addListener(){}}},
    action:{async setIcon(){},async setBadgeText(){},async setBadgeBackgroundColor(){},
      async setBadgeTextColor(){},async setTitle(){}}};
  vm.runInNewContext(read('backup/schema.js')+'\n'+read('background.js'),
    {chrome,URL,console:{...console,error(){}},setTimeout,clearTimeout});
  const send=()=>new Promise(resolve=>handler({type:'SMZ_START_ARCHIVE',handle:'demo',
    selection:{images:true,videos:false},splitMode:'auto',runLimit:null,saveMode:'directory'},
    {url:'chrome-extension://mock/popup/popup.html'},resolve));
  let result=await send();
  assert(result.ok, result.error);
  assert.equal(offscreenMessages.at(-1).splitMode,'10files');
  assert.equal(store.smz_collection_x_demo.archive.nextItemIndex,10);
  store.smz_collection_x_demo.archive.status='archive_complete';
  result=await send();
  assert(result.ok,result.error);
  assert.equal(offscreenMessages.at(-1).splitMode,'auto');
  assert.equal(store.smz_collection_x_demo.archive.nextItemIndex,0);
}
(async()=>{
  await splitTest(301,4,false,[300,301]);
  console.log('PASS auto 300-file split: 300+1 items, per-ZIP checkpoints and sequence');
  await splitTest(2,180,true,[1,2]);
  console.log('PASS auto 300-MB boundary (scaled bytes): second file split, per-ZIP checkpoints');
  await legacyTest();
  console.log('PASS migration: paused v0.0.23 10-file job resumes, completed job uses new auto');
  console.log('PASS v1.0.0 release offline suite');
})().catch(e=>{console.error(e);process.exitCode=1});
