'use strict';
// node tests/options-reset.test.cjs -- 全体初期化の権限チェック・処理中ガード・保存先消去
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = (pathPart) => fs.readFileSync(path.join(root, pathPart), 'utf8');
const clone = (value) => structuredClone(value);
const baseCollection = {platform:'x',handle:'sample',status:'complete',
  items:[],counts:{images:0,videos:0,total:0},updatedAt:1,archive:{status:'archive_complete'}};
const settings = {includeImages:true,includeVideos:true,splitMode:'10files',downloadLimit:'all'};
const store = {
  smz_collection_x_sample:clone(baseCollection),
  smz_previous_collection_x_sample:clone(baseCollection),
  smz_user_settings_v1:clone(settings),
  smz_custom_extension_value:'only within this extension'
};
let runtimeHandler;
let activeOffscreen = false;
let failHandleClear = false;
let handleClearCount = 0;
let alarmsCleared = 0;
let storageCleared = 0;
const icons = [];
const chrome = {
  runtime:{
    getURL:(part)=>`chrome-extension://smz-test/${part}`,
    onMessage:{addListener(fn){ runtimeHandler=fn; }},
    async sendMessage(msg){
      if (msg.type === 'SMZ_OFFSCREEN_GET_STATUS') return {active:activeOffscreen,handle:activeOffscreen?'sample':null};
      if (msg.type === 'SMZ_OFFSCREEN_CLEAR_HANDLES') {
        handleClearCount++;
        return failHandleClear ? {ok:false,error:'IndexedDB error'} : {ok:true};
      }
      return {ok:true};
    }
  },
  storage:{local:{
    async get(key){
      if (key===null) return clone(store);
      if (typeof key==='string') return {[key]:clone(store[key])};
      const result={}; for(const k of key||[])result[k]=clone(store[k]);return result;
    },
    async set(values){Object.assign(store,clone(values));},
    async remove(keys){for(const k of Array.isArray(keys)?keys:[keys])delete store[k];},
    async clear(){storageCleared++; for(const k of Object.keys(store))delete store[k];}
  }},
  alarms:{async clear(){return true;},async clearAll(){alarmsCleared++;return true;},onAlarm:{addListener(){}}},
  tabs:{async query(){return [];},onActivated:{addListener(){}},onUpdated:{addListener(){}}},
  windows:{onFocusChanged:{addListener(){}}},
  offscreen:{async hasDocument(){return true;}},
  action:{async setIcon({path}){icons.push(path);},async setBadgeText(){},async setBadgeBackgroundColor(){},async setBadgeTextColor(){},async setTitle(){}},
  downloads:{onDeterminingFilename:{addListener(){}}}
};
const sandbox = {chrome,URL,console:{...console,error(){}},setTimeout,clearTimeout};
vm.runInNewContext(read('backup/schema.js')+'\n'+read('background.js'),sandbox);
const send = (type,url='chrome-extension://smz-test/options/options.html') => new Promise(resolve => runtimeHandler({type},{url},resolve));
(async()=>{
  await new Promise(resolve=>setTimeout(resolve,20));
  let r=await send('SMZ_BACKUP_RESET_ALL','https://x.com/');
  assert.equal(r.ok,false,'Only options may request a full reset');
  assert(store.smz_collection_x_sample);
  store.smz_collection_x_sample.status='collecting';
  r=await send('SMZ_BACKUP_RESET_ALL');
  assert.equal(r.ok,false,'Cannot reset during collection');
  assert(store.smz_collection_x_sample);
  store.smz_collection_x_sample.status='complete';
  store.smz_collection_x_sample.archive.status='archiving';
  r=await send('SMZ_BACKUP_RESET_ALL');
  assert.equal(r.ok,false,'Cannot reset during ZIP creation');
  store.smz_collection_x_sample.archive.status='archive_complete';
  activeOffscreen=true;
  r=await send('SMZ_BACKUP_RESET_ALL');
  assert.equal(r.ok,false,'Offscreen active job blocks reset even if storage is stale');
  activeOffscreen=false;
  failHandleClear=true;
  r=await send('SMZ_BACKUP_RESET_ALL');
  assert.equal(r.ok,false,'Do not delete collection data when removing saved directory handles fails');
  assert(store.smz_collection_x_sample);
  assert.equal(storageCleared,0);
  failHandleClear=false;
  r=await send('SMZ_BACKUP_RESET_ALL');
  assert.equal(r.ok,true,r.error);
  assert.equal(Object.keys(store).length,0);
  assert.equal(storageCleared,1);
  assert.equal(alarmsCleared,1);
  assert.equal(handleClearCount,2);
  assert(icons.some(path => path[16] === 'icons/icon16.png'),'Toolbar returns to normal icon');
  console.log('PASS full reset: options-only access, collecting/ZIP/offscreen guard, IndexedDB-failure safety, alarm/local-storage clear and idle toolbar');
  console.log('PASS reset scope: all extension-managed keys wiped; only mock extension storage touched (not OS ZIP/JSON files)');
})().catch(error=>{console.error(error);process.exitCode=1;});
