'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = part => fs.readFileSync(path.join(root, part), 'utf8');
const clone = value => value === undefined ? undefined : structuredClone(value);

const currentKey = 'smz_collection_x_demo';
const previousKey = 'smz_previous_collection_x_demo';
const oldDirKey = 'archive-directory:123_demo';
const store = {
  [currentKey]: {
    platform:'x', handle:'demo', status:'complete', collectionId:'123_demo', updatedAt:10,
    items:[{key:'200_1',type:'image'}], counts:{images:1,videos:0,total:1},
    preferredSaveDirectoryKey:oldDirKey, preferredSaveDirectoryName:'old-folder',
    archive:{status:'archive_complete',saveDirectoryKey:oldDirKey,saveDirectoryName:'old-folder',nextItemIndex:1,savedZipCount:1,failedItems:0,progress:1,updatedAt:9}
  },
  [previousKey]: {
    platform:'x', handle:'demo', status:'complete', collectionId:'older', updatedAt:5,
    items:[{key:'100_1',type:'image'}], counts:{images:1,videos:0,total:1},
    preferredSaveDirectoryKey:oldDirKey, preferredSaveDirectoryName:'old-folder',
    archive:{status:'archive_complete',saveDirectoryKey:oldDirKey,saveDirectoryName:'old-folder',nextItemIndex:1,savedZipCount:1,failedItems:1,progress:1,updatedAt:4}
  }
};

let runtimeHandler;
let offscreenExists = false;
let invalidationResult = {ok:true};
let invalidations = 0;
let preparationResult = {ok:true,name:'tab-folder'};
let failStorage = false;
const chrome = {
  runtime:{
    getURL: part => `chrome-extension://smz-test/${part}`,
    onMessage:{addListener(fn){runtimeHandler=fn;}},
    async sendMessage(message){
      if (message.type === 'SMZ_OFFSCREEN_PREPARE_DIRECTORY') return preparationResult;
      if (message.type === 'SMZ_OFFSCREEN_INVALIDATE_DIRECTORY') {
        assert.equal(message.key,oldDirKey);
        invalidations++;
        assert.equal(store[currentKey].archive.saveDirectoryName,'old-folder','display must not change before invalidation acknowledgement');
        return invalidationResult;
      }
      return {active:false};
    }
  },
  storage:{local:{
    async get(key){
      if (key===null) return clone(store);
      if (typeof key==='string') return {[key]:clone(store[key])};
      const out={}; for (const k of key||[]) out[k]=clone(store[k]); return out;
    },
    async set(values){if(failStorage) throw Error('storage failed'); Object.assign(store,clone(values));},
    async remove(keys){for(const k of (Array.isArray(keys)?keys:[keys])) delete store[k];},
    async clear(){for(const k of Object.keys(store)) delete store[k];}
  }},
  alarms:{async clear(){return true;},async clearAll(){return true;},onAlarm:{addListener(){}}},
  tabs:{async query(){return [];},onActivated:{addListener(){}},onUpdated:{addListener(){}},async get(){return null;}},
  windows:{onFocusChanged:{addListener(){}}},
  offscreen:{async hasDocument(){return offscreenExists;}},
  action:{async setIcon(){},async setBadgeText(){},async setBadgeBackgroundColor(){},async setBadgeTextColor(){},async setTitle(){}},
  downloads:{onDeterminingFilename:{addListener(){}},async search(){return [];}}
};

const sandbox = {chrome,URL,console:{...console,error(){}},setTimeout,clearTimeout};
vm.runInNewContext(read('backup/schema.js')+'\n'+read('background.js'), sandbox);

function send(message, url='chrome-extension://smz-test/popup/popup.html') {
  return new Promise(resolve => runtimeHandler(message,{url},resolve));
}

(async()=>{
  await new Promise(r=>setTimeout(r,20));

  let result = await send({type:'SMZ_CHANGE_SAVE_DIRECTORY',platform:'x',handle:'demo',saveDirectoryKey:oldDirKey,saveDirectoryName:'new-folder'}, 'https://x.com/demo/media');
  assert.equal(result.ok,false,'only the popup may change the directory state');
  assert.equal(store[currentKey].archive.saveDirectoryName,'old-folder');

  store[currentKey].archive.status='archiving';
  result = await send({type:'SMZ_CHANGE_SAVE_DIRECTORY',platform:'x',handle:'demo',saveDirectoryKey:oldDirKey,saveDirectoryName:'new-folder'});
  assert.equal(result.ok,false,'directory changes are rejected while ZIP creation is active');
  assert.equal(store[currentKey].archive.saveDirectoryName,'old-folder');

  store[currentKey].archive.status='archive_complete';
  offscreenExists = true;
  for (const response of [undefined, {ok:false,error:'ZIP保存中は保存先フォルダを変更できません'}]) {
    invalidationResult = response;
    result = await send({type:'SMZ_CHANGE_SAVE_DIRECTORY',platform:'x',handle:'demo',saveDirectoryKey:oldDirKey,saveDirectoryName:'new-folder'});
    assert.equal(result.ok,false,'missing/negative acknowledgement must not report success');
    assert.equal(store[currentKey].archive.saveDirectoryName,'old-folder');
    assert.equal(store[previousKey].archive.saveDirectoryName,'old-folder');
  }
  invalidationResult = {ok:true};
  const beforeCurrent = clone(store[currentKey]);
  const beforePrevious = clone(store[previousKey]);
  result = await send({type:'SMZ_CHANGE_SAVE_DIRECTORY',platform:'x',handle:'demo',saveDirectoryKey:oldDirKey,saveDirectoryName:'new-folder'});
  assert.equal(result.ok,true,result.error);
  assert.equal(invalidations,3);
  assert.equal(store[currentKey].archive.saveDirectoryName,'new-folder');
  assert.equal(store[currentKey].preferredSaveDirectoryName,'new-folder');
  assert.equal(store[previousKey].archive.saveDirectoryName,'new-folder','delta rollback snapshot must retain the newly selected folder');
  assert.equal(store[previousKey].preferredSaveDirectoryName,'new-folder');
  assert.equal(store[currentKey].archive.nextItemIndex,beforeCurrent.archive.nextItemIndex);
  assert.equal(store[currentKey].archive.savedZipCount,beforeCurrent.archive.savedZipCount);
  assert.equal(store[currentKey].archive.failedItems,beforeCurrent.archive.failedItems);
  assert.equal(store[previousKey].archive.failedItems,beforePrevious.archive.failedItems,'changing folders must not alter historical ZIP progress');

  result = await send({type:'SMZ_CHANGE_SAVE_DIRECTORY',platform:'x',handle:'demo',saveDirectoryKey:'archive-directory:wrong',saveDirectoryName:'other'});
  assert.equal(result.ok,false,'stale/mismatched directory keys must be rejected');
  assert.equal(store[currentKey].archive.saveDirectoryName,'new-folder');

  const popup = read('popup/popup.js');
  const css = read('popup/popup.css');
  const html = read('popup/popup.html');
  assert.match(popup,/function changeSaveDirectory\(\)/);
  assert.match(popup,/chrome\.tabs\.create/);
  assert.doesNotMatch(popup,/window\.showDirectoryPicker\(|fs\.pickDirectory\(/);
  assert.match(popup,/\[変更\]/);
  assert.match(popup,/button\.title = '次のZIPから保存先フォルダを変更'/,'hover guidance remains on the change control');
  assert.match(popup,/function setStatusFeedback\(/);
  assert.match(read('archive/directory.js'),/SMZ_COMMIT_SAVE_DIRECTORY/);
  assert.match(popup,/applyStatusFeedback\(\)/,'save-directory operation results must be rendered in the status detail area');
  const changeHandler = popup.match(/async function changeSaveDirectory\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(changeHandler,/setNotice\(/,'save-directory success/cancel/error must not use the floating notice');
  assert.match(css,/\.save-dir-change/);
  assert.match(css,/status-feedback-error/);
  assert.match(html,/v1\.3\.15/);

  const tabUrl = 'chrome-extension://smz-test/archive/directory.html?platform=x&handle=demo';
  const commit = {type:'SMZ_COMMIT_SAVE_DIRECTORY',platform:'x',handle:'demo',saveDirectoryKey:oldDirKey,candidateKey:'archive-directory:change-candidate'};
  const beforeCommit = clone(store);
  result = await send(commit,'https://x.com/demo');
  assert.equal(result.ok,false,'web pages cannot commit a candidate');
  result = await send(commit);
  assert.equal(result.ok,false,'popup cannot commit a candidate directly');
  store[currentKey].archive.status='archiving';
  result = await send(commit,tabUrl);
  assert.equal(result.ok,false);
  store[currentKey].archive.status='archive_complete';
  for (const response of [undefined, {ok:false,error:'active offscreen job'}]) {
    preparationResult = response;
    result = await send(commit,tabUrl);
    assert.equal(result.ok,false);
    assert.deepEqual(store,beforeCommit);
  }
  preparationResult = {ok:true,name:'tab-folder'};
  failStorage = true;
  result = await send(commit,tabUrl);
  failStorage = false;
  assert.equal(result.ok,false);
  assert.deepEqual(store,beforeCommit,'failed persistence must leave both snapshots unchanged');
  result = await send(commit,tabUrl);
  assert.equal(result.ok,true,result.error);
  assert.equal(result.saveDirectoryName,'tab-folder','directory name is read from the actual persisted handle');
  for (const k of [currentKey,previousKey]) {
    assert.equal(store[k].archive.saveDirectoryKey,commit.candidateKey);
    assert.equal(store[k].preferredSaveDirectoryKey,commit.candidateKey);
    assert.equal(store[k].archive.nextItemIndex,beforeCommit[k].archive.nextItemIndex);
    assert.equal(store[k].archive.savedZipCount,beforeCommit[k].archive.savedZipCount);
  }
  result = await send({...commit,candidateKey:'archive-directory:change-stale'},tabUrl);
  assert.equal(result.ok,false,'an older tab cannot overwrite a newer directory choice');
  const afterCommit = clone(store);
  result = await send({type:'SMZ_START_ARCHIVE',platform:'x',handle:'demo',selection:{images:true,videos:false},
    expectedSaveDirectoryKey:oldDirKey,saveDirectoryKey:oldDirKey,saveMode:'directory'});
  assert.equal(result.ok,false,'stale ZIP resume must not overwrite the committed directory');
  assert.match(result.error,/保存先が変更/);
  assert.deepEqual(store,afterCommit,'stale resume must not change destination or progress');

  store[currentKey].archive.status='archive_paused';
  store[currentKey].archive.pauseReason='save_permission';
  store[currentKey].archive.lastError='old permission error';
  const recoveryProgress=store[currentKey].archive.nextItemIndex;
  result=await send({...commit,saveDirectoryKey:commit.candidateKey,candidateKey:'archive-directory:change-recovered'},tabUrl);
  assert.equal(result.ok,true,result.error);
  assert.equal(store[currentKey].archive.pauseReason,null,'verified selection must clear the reselect instruction');
  assert.equal(store[currentKey].archive.lastError,null);
  assert.equal(store[currentKey].archive.nextItemIndex,recoveryProgress);

  // First selection after a fresh collection or backup restore has no existing directory key.
  const initial = clone(store[currentKey]);
  delete initial.archive;
  delete initial.preferredSaveDirectoryKey;
  delete initial.preferredSaveDirectoryName;
  store[currentKey] = initial;
  delete store[previousKey];
  result = await send({...commit,saveDirectoryKey:null,candidateKey:'archive-directory:change-first'},tabUrl);
  assert.equal(result.ok,true,result.error);
  assert.equal(store[currentKey].preferredSaveDirectoryKey,'archive-directory:change-first');
  assert.equal(store[currentKey].archive,undefined,'initial folder selection must not create a ZIP job or progress');

  console.log('PASS save destination change: popup-only, active-ZIP guard, current/previous state sync, no progress reset, stale-key guard');
  console.log('PASS popup integration: hover guidance remains; operation results use the in-panel status detail instead of floating notice');
  console.log('PASS staged tab commit: trusted sender, active guard, permission acknowledgement, storage failure, both snapshots, no progress reset and stale-choice guard');
})().catch(error=>{console.error(error);process.exitCode=1;});
