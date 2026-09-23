'use strict';
// node tests/backup-restore.test.cjs -- ネットワークなしでZIPストリームとJSON移行を検証。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const clone = (v) => structuredClone(v);
const ids = Array.from({length: 12}, (_, i) => String(2100000000000000000n - BigInt(i)));
const items = ids.map((postId, index) => ({
  key: `${postId}_1`, platform: 'x', handle: 'demo', postId, mediaIndex: 1,
  type: 'image', url: `https://pbs.twimg.com/media/${postId}.jpg?format=jpg&name=orig&secret=SHOULD_NOT_LEAK`,
  fallbackUrls: [], extension: 'jpg'
}));
const initial = () => ({ platform: 'x', handle: 'demo', status: 'complete', collectionId: 'abc1',
  schemaVersion: 4, startedAt: Date.now() - 2000, completedAt: Date.now(), updatedAt: Date.now(),
  collectionMode: 'manual', items: clone(items), counts: {images:12,videos:0,total:12},
  newestPostId: ids[0], oldestPostId: ids.at(-1), accessToken: 'DONT_EXPORT_ME',
  archive: { status:'archiving', collectionId:'abc1', selection:{images:true,videos:false},
    splitMode:'10files', mediaKind:'images', nextItemIndex:0, nextZipNumber:1, savedZipCount:0,
    processedItems:0, failedItems:0, totalSelected:12, startedAt:Date.now(), saveMode:'directory',
    saveDirectoryKey:'archive-directory:abc1', saveDirectoryName:'X Backup', password:'NOT_EXPORTED' }
});
const schemaContext = vm.createContext({URL, console});
vm.runInContext(read('backup/schema.js'), schemaContext);
const backup = schemaContext.SMZBackup;
assert(backup);
const full = backup.fullEnvelope({smz_collection_x_demo: initial(), smz_user_settings_v1:{includeImages:false, includeVideos:true, splitMode:'1gb', downloadLimit:'all', collectionMode:'manual', apiKey:'SECRET'}, smz_api_key:'SECRET'});
const fullText = JSON.stringify(full);
assert(!fullText.includes('SECRET') && !fullText.includes('SHOULD_NOT_LEAK') && !fullText.includes('DONT_EXPORT_ME'));
assert.equal(full.accounts.length, 1);
assert.equal(full.settings.splitMode, '1gb');
assert.equal(full.accounts[0].current.archive.saveDirectoryKey, null);
assert.equal(full.accounts[0].current.archive.saveDirectoryName, null);
assert.equal(full.accounts[0].current.preferredSaveDirectoryName, null);
assert.equal(full.accounts[0].current.items.length, 12);
assert.equal(backup.parseJson(fullText).accounts[0].current.items.length, 12);
console.log('PASS allowlist: 12 media, saved preferences, no unknown storage/API/token/cookie/query secrets');

async function testZip() {
  let state = initial();
  const zipOutputs = [];
  let handler;
  const fsMock = {
    async openWritableFile(_directory, filename) {
      const parts = [];
      return {filename, directoryName:'X Backup', writable:{
        async write(buf) { parts.push(Buffer.from(buf)); },
        async close() { zipOutputs.push({name:filename,buffer:Buffer.concat(parts)}); },
        async abort() {}
      }, async remove() {} };
    }
  };
  const chrome = {runtime:{onMessage:{addListener(fn){handler=fn;}},async sendMessage(msg){
    if (msg.type === 'SMZ_ARCHIVE_GET_STATE') return {ok:true,state:clone(state),previous:null};
    if (msg.type === 'SMZ_ARCHIVE_PATCH') {
      state.archive = {...state.archive,...clone(msg.patch),updatedAt:Date.now()};
      if (msg.patch.status === 'archive_complete') state.savedKinds = {images:true,videos:false};
      return {ok:true,state:clone(state)};
    }
    throw Error('unexpected runtime message '+msg.type);
  }}};
  const sandbox = vm.createContext({chrome,URL,console,SMZFileSystem:fsMock,fetch:async()=>({ok:true,
    headers:{get(){return 'image/jpeg';}}, async arrayBuffer(){return Uint8Array.from([10,20,30,40]).buffer;}}),
    Blob,Response,CompressionStream,TextEncoder,TextDecoder,DataView,Uint8Array,Uint32Array,
    setTimeout,clearTimeout});
  vm.runInContext(read('backup/schema.js')+'\n'+read('archive/offscreen.js'),sandbox);
  const signal = handler({target:'offscreen',type:'SMZ_OFFSCREEN_START_ARCHIVE',handle:'demo',platform:'x',
    selection:{images:true,videos:false},mediaKind:'images',splitMode:'10files',saveMode:'directory',
    saveDirectoryKey:'abc1',runLimit:null},{},()=>{});
  for(let i=0;i<2000 && state.archive.status !== 'archive_complete'; i++) await new Promise(r=>setTimeout(r,5));
  assert.equal(state.archive.status, 'archive_complete', `status=${state.archive.status}`);
  assert.equal(zipOutputs.length,2);
  assert.match(zipOutputs[0].name,/_images_001\.zip$/);
  assert.match(zipOutputs[1].name,/_images_002\.zip$/);
  const zipContext=vm.createContext({Blob,Response,DecompressionStream,TextDecoder,TextEncoder,Uint8Array,Uint32Array,DataView,URL,console});
  vm.runInContext(read('backup/schema.js')+'\n'+read('backup/zip-reader.js'),zipContext);
  const checkpoints=[];
  let firstZipData = null;
  for(const {buffer,name} of zipOutputs) {
    const parsed = await zipContext.SMZZipReader.accountJsonFromZip(new Blob([buffer]));
    assert.equal(parsed.accounts.length,1);
    assert(!buffer.toString('utf8').includes('SHOULD_NOT_LEAK'));
    assert(!JSON.stringify(parsed).includes('DONT_EXPORT_ME'));
    checkpoints.push(parsed.accounts[0].current);
    if (!firstZipData) firstZipData = parsed;
  }
  assert.equal(checkpoints[0].archive.status,'archive_paused');
  assert.equal(checkpoints[0].archive.nextItemIndex,10);
  assert.equal(checkpoints[0].archive.nextZipNumber,2);
  assert.equal(checkpoints[0].savedKinds.images,false);
  assert.equal(checkpoints[1].archive.status,'archive_complete');
  assert.equal(checkpoints[1].archive.nextItemIndex,12);
  assert.equal(checkpoints[1].archive.nextZipNumber,3);
  assert.equal(checkpoints[1].savedKinds.images,true);
  const out=path.join('/mnt/data','smz21_zip_checkpoint_test');
  fs.mkdirSync(out,{recursive:true});
  for(const {name,buffer} of zipOutputs) fs.writeFileSync(path.join(out,name),buffer);
  console.log('PASS streaming ZIP: 10+2 media, all chunks include metadata, 001 resumes at 11th, 002 complete, deflate/store reader, CRC');
  console.log('TEST_ZIPS='+out);
  return firstZipData;
}

async function testBackgroundImport(firstZipData) {
  const store = {};
  let handler;
  const chrome={runtime:{getURL(s){return 'chrome-extension://test/'+s;},onMessage:{addListener(fn){handler=fn;}},async sendMessage(){return {active:false};}},
    storage:{local:{async get(k){if (k===null)return clone(store);return {[k]:clone(store[k])};},async set(v){Object.assign(store,clone(v));},async remove(keys){for(const k of Array.isArray(keys)?keys:[keys])delete store[k];}}},
    tabs:{async query(){return [];},onActivated:{addListener(){}},onUpdated:{addListener(){}}},windows:{onFocusChanged:{addListener(){}}},
    action:{async setIcon(){},async setBadgeText(){},async setBadgeBackgroundColor(){},async setBadgeTextColor(){},async setTitle(){}},
    downloads:{onDeterminingFilename:{addListener(){}}},alarms:{onAlarm:{addListener(){}},async clear(){}},offscreen:{async hasDocument(){return false;}}};
  vm.runInNewContext(read('backup/schema.js')+'\n'+read('background.js'),{chrome,URL,console: {...console,error(){}},setTimeout,clearTimeout});
  async function send(msg,url='chrome-extension://test/options/options.html') {return new Promise(r=>handler(msg,{url},r));}
  const before = await send({type:'SMZ_BACKUP_LIST'},'https://x.com/demo');
  assert.equal(before.ok,false,'website cannot obtain the backup list');
  const imported=await send({type:'SMZ_BACKUP_IMPORT',data:full,mode:'merge'});
  assert.equal(imported.ok,true,imported.error);assert.equal(imported.imported,1);
  assert.equal(store.smz_collection_x_demo.items.length,12);
  assert.equal(store.smz_collection_x_demo.archive.saveDirectoryKey,null);
  const skipped=await send({type:'SMZ_BACKUP_IMPORT',data:full,mode:'merge'});
  assert.equal(skipped.skipped,1);
  const exported=await send({type:'SMZ_BACKUP_EXPORT'});
  assert.equal(exported.ok,true,exported.error);
  assert.equal(exported.data.accounts.length,1);
  assert(!JSON.stringify(exported.data).includes('SECRET'));
  const individual = await send({type:'SMZ_BACKUP_IMPORT',data:firstZipData,mode:'replace-accounts'});
  assert.equal(individual.ok,true,individual.error);
  assert.equal(store.smz_collection_x_demo.archive.status,'archive_paused');
  assert.equal(store.smz_collection_x_demo.archive.nextItemIndex,10);
  assert.equal(store.smz_collection_x_demo.archive.saveDirectoryKey,null);
  const replaced=await send({type:'SMZ_BACKUP_IMPORT',data:full,mode:'replace-all'});
  assert.equal(replaced.ok,true,replaced.error);
  assert.equal(store.smz_user_settings_v1.splitMode,'1gb');
  console.log('PASS background import/export: fresh PC, skip collision, full replace, options-only access, no credential export');
}
(async()=>{const first=await testZip();await testBackgroundImport(first);console.log('PASS v0.0.21 backup/offline tests');})().catch(err=>{console.error(err);process.exitCode=1;});
