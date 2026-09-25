'use strict';
// ネットワークにアクセスせず、Xの新旧UI切替とページ間チェックポイントを検証。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const backupCtx = vm.createContext({URL});
vm.runInContext(read('backup/schema.js'), backupCtx);
assert.equal(backupCtx.SMZBackup.safeSettings({}).xSplitMedia, true);
assert.equal(backupCtx.SMZBackup.safeSettings({}).xRevertProfileTabs, false);
assert.equal(backupCtx.SMZBackup.safeSettings({xSplitMedia:false,xRevertProfileTabs:true}).xSplitMedia,false);
assert.match(read('options/options.html'), /id="xSplitMedia" checked/);
assert.doesNotMatch(read('options/options.html'), /id="xRevertProfileTabs" checked/);
console.log('PASS X UI preferences: split ON, revert OFF, allowlisted full-backup settings');

// XのReact featureSwitchesを使うオプションが、他のフラグを壊さないことを確認。
const callbacks = {};
const messages = [];
const switches = {isTrue(flag) { return flag === 'responsive_web_profile_redesign_enabled'; }};
const first = {'__reactProps$test':{children:{props:{children:{props:{contextProviderProps:{featureSwitches:switches}}}}}}};
const window = {fetch:async()=>({status:200,ok:true}),addEventListener(name,cb){ callbacks[name]=cb; },postMessage(msg){messages.push(msg);}};
const fakeDocument = {getElementById(id) { return id==='react-root' ? {firstElementChild:first} : null; }};
let layoutPoll;
vm.runInNewContext(read('providers/x/main-hook.js'), {window,document:fakeDocument,
  sessionStorage:{getItem(){return null;}},URL,console,
  setInterval(fn){layoutPoll=fn;return 1;},clearInterval(){},setTimeout(){}},
  {filename:'main-hook.js'});
callbacks.message({source:window,data:{source:'simple-marugoto-zip',type:'SMZ_X_UI_SETTINGS',revertProfileTabs:false}});
assert.equal(switches.isTrue('responsive_web_profile_redesign_enabled'),true);
callbacks.message({source:window,data:{source:'simple-marugoto-zip',type:'SMZ_X_UI_SETTINGS',revertProfileTabs:true}});
layoutPoll();
assert.equal(switches.isTrue('responsive_web_profile_redesign_enabled'),false);
assert.equal(switches.isTrue('some_other_flag'),false);
assert(messages.some(m=>m.type==='SMZ_X_PROFILE_LAYOUT' && m.split===false));
// The initial feature flag message may precede content-script installation.
// SMZ_X_CONTROL is the explicit second chance to report the unchanged layout.
messages.length=0;
callbacks.message({source:window,data:{source:'simple-marugoto-zip',type:'SMZ_X_CONTROL',enabled:true,handle:'demo'}});
assert(messages.some(m=>m.type==='SMZ_X_PROFILE_LAYOUT' && m.split===false));
console.log('PASS X UI flags: old profile view optional, other flags untouched, layout reported');

function createPage(shared, {photo=false, split=true}={}) {
  const events=[]; const sent=[];
  const location={hostname:'x.com',pathname:'/demo/media',search:photo?'?filter=photo':'',href:'https://x.com/demo/media'};
  const window={scrollY:0,innerHeight:800,scrollTo(){},addEventListener(name,fn){if(name==='message')events.push(fn);},postMessage(){}};
  const document={body:{innerText:'200件の画像と動画',scrollHeight:2000},documentElement:{scrollHeight:2000}};
  const chrome={storage:{local:{async get(){return {smz_user_settings_v1:{xSplitMedia:true,xRevertProfileTabs:false}};}}},
    runtime:{onMessage:{addListener(fn){page.listener=fn;}},async sendMessage(msg){sent.push(msg);
      if (msg.type==='SMZ_GET_COLLECTION')return {ok:true,isCollectionTab:true,state:{status:'collecting',collectionMode:'auto',collectionId:'job1'}};
      if (msg.type==='SMZ_COLLECTION_MEDIA_COUNT')return {ok:true,needConfirmation:false};
      return {ok:true,addedCount:1};
    }}};
  const page={location,sent,events};
  const source=read('providers/x/content.js').replace(/\}\)\(\);\s*$/, 'globalThis.__test = {completeCollection};})();');
  const ctx=vm.createContext({window,document,chrome,location,sessionStorage:shared,console,URL,
    setTimeout(){return 1;},clearTimeout(){} });
  vm.runInContext(source,ctx,{filename:'content.js'});
  page.ctx=ctx;
  page.fire=async (type,payload={})=>{for(const fn of events)await fn({source:window,data:{source:'simple-marugoto-zip',type,...payload}});};
  page.ready=async()=>{for(let i=0;i<8;i++)await Promise.resolve();await page.fire('SMZ_X_PROFILE_LAYOUT',{split});};
  return page;
}
(async()=>{
  const store=new Map();
  const session={getItem(k){return store.get(k)||null;},setItem(k,v){store.set(k,v);},removeItem(k){store.delete(k);}};
  const video=createPage(session,{split:true});await video.ready();
  await video.fire('SMZ_X_MEDIA_BATCH',{items:[{key:'2110_1',postId:'2110',type:'video'}]});
  await video.ctx.__test.completeCollection({endOfFeed:true});
  assert.match(video.location.href,/\/demo\/media\?filter=photo$/);
  assert.equal(video.sent.some(m=>m.type==='SMZ_COLLECTION_COMPLETE'),false);
  assert.equal(JSON.parse(session.getItem('smz_x_split_collection_stage')).phase,'photos');

  const photoPage=createPage(session,{photo:true,split:true});await photoPage.ready();
  await photoPage.fire('SMZ_X_MEDIA_BATCH',{items:[{key:'2111_1',postId:'2111',type:'image'}]});
  await photoPage.ctx.__test.completeCollection({endOfFeed:true});
  assert.equal(photoPage.sent.filter(m=>m.type==='SMZ_COLLECTION_COMPLETE').length,1);
  assert.equal(store.has('smz_x_split_collection_stage'),false);
  console.log('PASS X split pages: video to photo same job, distinct media accepted, single final completion');

  const legacyStore=new Map();
  const legacySession={getItem(k){return legacyStore.get(k)||null;},setItem(k,v){legacyStore.set(k,v);},removeItem(k){legacyStore.delete(k);}};
  const legacy=createPage(legacySession,{split:false});await legacy.ready();
  await legacy.fire('SMZ_X_MEDIA_BATCH',{items:[{key:'2120_1',postId:'2120',type:'image'}]});
  await legacy.ctx.__test.completeCollection({endOfFeed:true});
  assert.equal(legacy.sent.filter(m=>m.type==='SMZ_COLLECTION_COMPLETE').length,1);
  assert(!legacy.location.href.includes('filter=photo'));
  console.log('PASS X legacy pages: existing single-pass path unchanged');

  // No video results must not cause a 0-item finish before the photo pass.
  const emptyStore=new Map();
  const emptySession={getItem(k){return emptyStore.get(k)||null;},setItem(k,v){emptyStore.set(k,v);},removeItem(k){emptyStore.delete(k);}};
  const emptyVideo=createPage(emptySession,{split:true}); await emptyVideo.ready();
  await emptyVideo.ctx.__test.completeCollection({endOfFeed:true});
  assert.match(emptyVideo.location.href,/filter=photo$/);
  assert.equal(emptyVideo.sent.some(m=>m.type==='SMZ_COLLECTION_COMPLETE'),false);
  const imagePage=createPage(emptySession,{photo:true,split:true}); await imagePage.ready();
  await imagePage.fire('SMZ_X_MEDIA_BATCH',{items:[{key:'2140_1',postId:'2140',type:'image'}]});
  await imagePage.ctx.__test.completeCollection({endOfFeed:true});
  assert.equal(imagePage.sent.filter(m=>m.type==='SMZ_COLLECTION_COMPLETE').length,1);
  console.log('PASS X new UI: empty videos still reaches photos before completing');

  // When resumed from a paused photo pass on /media, redirect back to photos
  // instead of prematurely treating the resumed video page as the final pass.
  const resumedStore=new Map([['smz_x_split_collection_stage',JSON.stringify({handle:'demo',collectionId:'job1',phase:'photos'})]]);
  const resumedSession={getItem(k){return resumedStore.get(k)||null;},setItem(k,v){resumedStore.set(k,v);},removeItem(k){resumedStore.delete(k);}};
  const wrongPage=createPage(resumedSession,{split:true}); await wrongPage.ready();
  await new Promise(resolve=>wrongPage.listener({type:'SMZ_RESUME_COLLECTION',handle:'demo',collectionId:'job1',collectionMode:'auto',automatic:true},null,()=>resolve()));
  assert.match(wrongPage.location.href,/filter=photo$/);
  assert.equal(JSON.parse(resumedSession.getItem('smz_x_split_collection_stage')).phase,'photos');
  console.log('PASS X split resume: paused photo pass restores correct page');
})().catch(e=>{console.error(e);process.exitCode=1;});
