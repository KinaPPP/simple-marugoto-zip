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
const chrome = {
  runtime:{
    getURL: part => `chrome-extension://smz-test/${part}`,
    onMessage:{addListener(fn){runtimeHandler=fn;}},
    async sendMessage(){return {active:false};}
  },
  storage:{local:{
    async get(key){
      if (key===null) return clone(store);
      if (typeof key==='string') return {[key]:clone(store[key])};
      const out={}; for (const k of key||[]) out[k]=clone(store[k]); return out;
    },
    async set(values){Object.assign(store,clone(values));},
    async remove(keys){for(const k of (Array.isArray(keys)?keys:[keys])) delete store[k];},
    async clear(){for(const k of Object.keys(store)) delete store[k];}
  }},
  alarms:{async clear(){return true;},async clearAll(){return true;},onAlarm:{addListener(){}}},
  tabs:{async query(){return [];},onActivated:{addListener(){}},onUpdated:{addListener(){}},async get(){return null;}},
  windows:{onFocusChanged:{addListener(){}}},
  offscreen:{async hasDocument(){return false;}},
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
  const beforeCurrent = clone(store[currentKey]);
  const beforePrevious = clone(store[previousKey]);
  result = await send({type:'SMZ_CHANGE_SAVE_DIRECTORY',platform:'x',handle:'demo',saveDirectoryKey:oldDirKey,saveDirectoryName:'new-folder'});
  assert.equal(result.ok,true,result.error);
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
  assert.match(popup,/fs\.pickDirectory\(directory\.key\)/,'folder picker must overwrite the existing handle key rather than resetting progress');
  assert.match(popup,/SMZ_CHANGE_SAVE_DIRECTORY/);
  assert.match(popup,/\[変更\]/);
  assert.match(popup,/button\.title = '次のZIPから保存先フォルダを変更'/,'hover guidance remains on the change control');
  assert.match(popup,/function setStatusFeedback\(/);
  assert.match(popup,/setStatusFeedback\(`保存先を「\$\{name\}」に変更しました。次のZIPから使用します。`\)/);
  assert.match(popup,/setStatusFeedback\('保存先フォルダの変更をキャンセルしました。'\)/);
  assert.match(popup,/applyStatusFeedback\(\)/,'save-directory operation results must be rendered in the status detail area');
  const changeHandler = popup.match(/async function changeSaveDirectory\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(changeHandler,/setNotice\(/,'save-directory success/cancel/error must not use the floating notice');
  assert.match(css,/\.save-dir-change/);
  assert.match(css,/status-feedback-error/);
  assert.match(html,/v1\.3\.2/);

  console.log('PASS save destination change: popup-only, active-ZIP guard, current/previous state sync, no progress reset, stale-key guard');
  console.log('PASS popup integration: hover guidance remains; operation results use the in-panel status detail instead of floating notice');
})().catch(error=>{console.error(error);process.exitCode=1;});
