'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8');
function hook({brokenLog=false,early=false}={}){
 const messages=[],listeners={};let data;
 const w={addEventListener:(n,cb)=>listeners[n]=cb,postMessage:m=>{if(brokenLog&&['SMZ_X_MEDIA_DIAGNOSTIC','SMZ_X_CAPTURE_DIAGNOSTIC'].includes(m.type))throw Error('log unavailable');messages.push(m);},
  fetch:async()=>({ok:true,status:200,clone(){return {ok:true,status:200,json:async()=>data};}})};
 class XHR {open(){} addEventListener(name,cb){this.callback=cb;} send(){this.callback();}}
 w.XMLHttpRequest=XHR;
 const c=vm.createContext({window:w,URL,sessionStorage:{getItem:()=>early?'demo':null},console});
 vm.runInContext(read('providers/x/main-hook.js'),c);
 const ready=()=>listeners.message({source:w,data:{source:'simple-marugoto-zip',type:'SMZ_X_CONTROL',enabled:true,handle:'demo'}});
 if(!early)ready();
 return {messages,ready,async receive(tweet){const start=messages.length;data={data:{entries:[{tweet_results:{result:tweet}}]}};await w.fetch('https://x.com/i/api/graphql/test/UserMedia');await new Promise(r=>setImmediate(r));return messages.slice(start);},
 receiveXHR(tweet){const start=messages.length,xhr=new w.XMLHttpRequest();xhr.status=200;xhr.responseType='json';xhr.response={data:{tweet_results:{result:tweet}}};xhr.open('GET','https://x.com/i/api/graphql/test/UserMedia');xhr.send();return messages.slice(start);}};
}
const id='2121034947280753090';
function tweet(count,{mixed=false,broken=false}={}){return {rest_id:id,core:{user_results:{result:{legacy:{screen_name:'demo'}}}},legacy:{id_str:id,extended_entities:{media:Array.from({length:count},(_,i)=>broken&&i===19?{}:mixed&&i%2?{type:'video',video_info:{variants:[{content_type:'video/mp4',url:`https://video.twimg.com/test_${i}.mp4`,bitrate:10}]}}:{type:'photo',media_url_https:`https://pbs.twimg.com/media/test_${i}.jpg`})}}};}
test('20 images are collected unchanged and all diagnostic counts survive the log allowlist',async()=>{
 const h=hook(),events=await h.receive(tweet(20));const batch=events.find(x=>x.type==='SMZ_X_MEDIA_BATCH');assert.equal(batch.items.length,20);
 const diag=events.find(x=>x.type==='SMZ_X_MEDIA_DIAGNOSTIC').diagnostic;
 assert.equal(diag.receivedCount,20);assert.equal(diag.extractedCount,20);assert.equal(diag.imageCount,20);assert.equal(diag.ignoredCount,0);
 assert.equal(diag.operation,'UserMedia');
 const c=vm.createContext({Date});vm.runInContext(read('debug/trace-core.js'),c);
 assert.equal(c.SMZDirectoryTraceCore.fields(diag).postId,id);assert.equal(c.SMZDirectoryTraceCore.fields(diag).receivedCount,20);
});
test('4 then 20 reports and collects the sixteen additional media',async()=>{
 const h=hook();await h.receive(tweet(4));const events=await h.receive(tweet(20));
 assert.equal(events.find(x=>x.type==='SMZ_X_MEDIA_BATCH').items.length,16);
 const d=events.find(x=>x.type==='SMZ_X_MEDIA_DIAGNOSTIC').diagnostic;
 assert.equal(d.phase,'extracted');assert.equal(d.firstMediaCount,4);assert.equal(d.receivedCount,20);assert.equal(d.extractedCount,16);assert.equal(d.ignoredCount,4);
});
test('mixed media and missing URLs have distinct diagnostic counts',async()=>{
 const events=await hook().receive(tweet(20,{mixed:true,broken:true}));
 const d=events.find(x=>x.type==='SMZ_X_MEDIA_DIAGNOSTIC').diagnostic;
 assert.equal(d.imageCount,10);assert.equal(d.videoCount,9);assert.equal(d.ignoredCount,1);
});
test('diagnostic delivery failure cannot prevent 20-image extraction',async()=>{
 const events=await hook({brokenLog:true}).receive(tweet(20));assert.equal(events.find(x=>x.type==='SMZ_X_MEDIA_BATCH').items.length,20);
});
test('alternate media array is observed without pretending it was collected',async()=>{
 const events=await hook().receive({rest_id:id,mediaDetails:Array.from({length:20},()=>({url:'PRIVATE_URL'}))});
 const d=events.find(x=>x.type==='SMZ_X_MEDIA_DIAGNOSTIC').diagnostic;
 assert.equal(d.phase,'alternate_shape');assert.equal(d.receivedCount,20);assert(!events.some(x=>x.type==='SMZ_X_MEDIA_BATCH'));
 assert(!JSON.stringify(d).includes('PRIVATE_URL'));
});
function moduleContext(){const c=vm.createContext({});vm.runInContext(read('debug/x-media.js'),c);return c.SMZXMediaDebug;}
test('page diagnostics are strictly allowlisted and reject invalid counts and IDs',()=>{
 const api=moduleContext();const good={postId:id,phase:'extracted',receivedCount:20,firstMediaCount:20,extractedCount:20,imageCount:20,videoCount:0,ignoredCount:0};
 const d=api.normalize({...good,url:'PRIVATE_URL',token:'PRIVATE_TOKEN',text:'PRIVATE_TEXT'});
 assert.equal(d.postId,id);assert(!JSON.stringify(d).includes('PRIVATE_'));
 assert.equal(api.normalize({...good,receivedCount:-1}),null);assert.equal(api.normalize({...good,postId:'https://private.test'}),null);
 assert.equal(api.normalize({...good,extractedCount:21}),null);
});
test('summary includes a partial four-item post flagged by diagnostics and exact saved indices',()=>{
 const api=moduleContext();const items=Array.from({length:4},(_,i)=>({key:`${id}_${i+1}`,postId:id,mediaIndex:i+1,type:'image',url:'PRIVATE_URL'}));
 const result=api.summarize({platform:'x',handle:'demo',items,savedItemKeys:[`${id}_1`,`${id}_2`]},new Set([id]));
 assert.equal(result.posts.length,1);assert.equal(result.posts[0].collectedCount,4);assert.equal(result.posts[0].savedCount,2);
 assert.equal(result.posts[0].mediaIndices,'1,2,3,4');assert(!JSON.stringify(result).includes('PRIVATE_URL'));
});
test('XHR path also reports all 20 items',()=>{
 const events=hook().receiveXHR(tweet(20));assert.equal(events.find(x=>x.type==='SMZ_X_MEDIA_BATCH').items.length,20);
 assert.equal(events.find(x=>x.type==='SMZ_X_MEDIA_DIAGNOSTIC').diagnostic.receivedCount,20);
});
test('initial response diagnostics are replayed when content-script becomes ready',async()=>{
 const h=hook({early:true});const first=await h.receive(tweet(20));assert(!first.some(x=>x.type==='SMZ_X_MEDIA_DIAGNOSTIC'));
 h.ready();const reports=h.messages.filter(x=>x.type==='SMZ_X_MEDIA_DIAGNOSTIC');assert.equal(reports.length,1);assert.equal(reports[0].diagnostic.extractedCount,20);
});
test('persisted diagnostics exclude unrelated previously collected twenty-item posts',()=>{
 const api=moduleContext(),other='2121034947280753099';
 const items=[id,other].flatMap(postId=>Array.from({length:20},(_,i)=>({postId,mediaIndex:i+1,key:`${postId}_${i+1}`,type:'image'})));
 const rows=api.persisted({platform:'x',handle:'demo',items},items.slice(20),items.slice(20));
 assert.equal(rows.length,1);assert.equal(rows[0].postId,other);assert.equal(rows[0].collectedCount,20);assert.equal(rows[0].addedCount,20);
});
test('viewer includes per-post X summary in the exported JSON and visible rows',async()=>{
 const elements={};
 const node=()=>({textContent:'',value:'',children:[],handlers:{},append(x){this.children.push(x);},addEventListener(n,fn){this.handlers[n]=fn;}});
 const document={getElementById:id=>elements[id]||(elements[id]=node()),createElement:()=>node()};
 const response={ok:true,version:'1.3.14',extensionId:'test',current:[],log:{entries:[]},xMedia:[{account:'demo',posts:[{postId:id,expectedCount:20,collectedCount:20,imageCount:20,videoCount:0,mediaIndices:'1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20',savedCount:20,savedMediaIndices:'1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20'}]}]};
 const c=vm.createContext({document,Date,JSON,chrome:{runtime:{sendMessage:async()=>response}}});
 vm.runInContext(read('debug/directory-log.js'),c);await new Promise(r=>setImmediate(r));
 assert.equal(JSON.parse(elements.json.value).xMedia[0].posts[0].savedCount,20);
 assert.equal(elements.xPosts.children.length,1);assert(elements.xPosts.children[0].children[0].textContent.includes(id));
});
test('capture startup and empty responses remain visible without five-item media arrays',async()=>{
 const h=hook();assert(h.messages.some(e=>e.type==='SMZ_X_CAPTURE_DIAGNOSTIC'&&e.diagnostic.phase==='hook_ready'&&e.diagnostic.version==='1.3.16'));
 const events=await h.receive({});assert(events.some(e=>e.type==='SMZ_X_CAPTURE_DIAGNOSTIC'&&e.diagnostic.phase==='request'));
 const capture=events.find(e=>e.type==='SMZ_X_CAPTURE_DIAGNOSTIC'&&e.diagnostic.phase==='response').diagnostic;
 assert.equal(capture.extractedCount,0);assert.equal(capture.targetPostCount,0);assert.equal(capture.reason,'parsed');
});
test('target tweet and asset are found before the unsupported legacy shape is discarded',async()=>{
 const events=await hook().receive({rest_id:'2121977622796353698',__typename:'Tweet',pictures:[{url:'https://pbs.twimg.com/media/HXLHJ4JaQAA4Meo?format=jpg',text:'PRIVATE_POST_TEXT'}]});
 assert(!events.some(e=>e.type==='SMZ_X_MEDIA_BATCH'));
 const capture=events.find(e=>e.type==='SMZ_X_CAPTURE_DIAGNOSTIC'&&e.diagnostic.phase==='response').diagnostic;
 assert.equal(capture.targetPostCount,1);assert.equal(capture.targetAssetCount,1);assert.equal(capture.noLegacyCount,1);assert.equal(capture.extractedCount,0);
 assert(capture.shapeKeys.includes('pictures'));assert(!JSON.stringify(capture).includes('PRIVATE_POST_TEXT'));assert(!JSON.stringify(capture).includes('https:'));
});
test('capture normalization only retains known target markers and numeric counters',()=>{
 const api=moduleContext();const value=api.normalizeCapture({phase:'response',version:'1.3.15',objectsSeen:5,targetPostIds:'2121977622796353698,SECRET',targetAssetIds:'HXLHJ4JaQAA4Meo,SECRET',shapeKeys:'rest_id,pictures',token:'SECRET',url:'SECRET'});
 assert.equal(value.targetPostIds,'2121977622796353698');assert.equal(value.targetAssetIds,'HXLHJ4JaQAA4Meo');assert(!JSON.stringify(value).includes('SECRET'));
 assert.equal(api.normalizeCapture({phase:'response',objectsSeen:-1}),null);
});
