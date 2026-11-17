'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function harness(){
 const data={};let handler,offscreenHandler,removed,failSet=false;
 const base='chrome-extension://trace-test/';
 const storage={get:async key=>{
  if(key===null)return structuredClone(data);
  return {[key]:structuredClone(data[key])};
 },set:async values=>{if(failSet)throw Error('storage failed');Object.assign(data,structuredClone(values));},
 remove:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])delete data[k];},clear:async()=>{for(const k of Object.keys(data))delete data[k];}};
 const send=(message,url=base+'debug/directory-log.html',tabId)=>new Promise(resolve=>handler(message,{id:'trace-test',url,tab:tabId?{id:tabId}:undefined},resolve));
 const chrome={runtime:{id:'trace-test',getURL:p=>base+p,getManifest:()=>({version:'1.3.10'}),onMessage:{addListener:fn=>{handler=fn;}},
  sendMessage:message=>new Promise(resolve=>{
    if(message.target==='offscreen')offscreenHandler(message,{id:'trace-test',url:base+'background.js'},resolve);
    else handler(message,{id:'trace-test',url:base+'background.js'},resolve);
  })},storage:{local:storage},
  alarms:{clear:async()=>true,clearAll:async()=>true,onAlarm:{addListener(){}}},
  tabs:{query:async()=>[],onActivated:{addListener(){}},onUpdated:{addListener(){}},onRemoved:{addListener:fn=>{removed=fn;}}},
  windows:{onFocusChanged:{addListener(){}}},offscreen:{hasDocument:async()=>true},
  action:{setIcon:async()=>{},setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setBadgeTextColor:async()=>{},setTitle:async()=>{}},
  downloads:{onDeterminingFilename:{addListener(){}}}
 };
 const background=vm.createContext({chrome,URL,console:{...console,error(){}},setTimeout,clearTimeout,structuredClone});
 background.importScripts=(...files)=>{for(const file of files)vm.runInContext(read(file),background);};
 vm.runInContext(read('background.js'),background);
 const offscreenChrome={...chrome,runtime:{...chrome.runtime,onMessage:{addListener:fn=>{offscreenHandler=fn;}},
  sendMessage:message=>send(message,base+'archive/offscreen.html',91)}};
 const offscreen=vm.createContext({chrome:offscreenChrome,URL,console,setTimeout,clearTimeout,Blob,Response,CompressionStream,
  TextEncoder,TextDecoder,DataView,Uint8Array,Uint32Array,SMZFileSystem:{clearAllHandles:async()=>{}},location:{pathname:'/archive/offscreen.html'}});
 vm.runInContext(read('debug/trace-core.js')+'\n'+read('debug/trace-client.js')+'\n'+read('backup/schema.js')+'\n'+read('archive/offscreen.js'),offscreen);
 await delay(10);
 return {send,background,offscreen,base,removed:tabId=>removed(tabId),failStorage:value=>{failSet=value;}};
}
test('trace endpoints reject website access and restrict log viewing to viewer',async()=>{
 const h=await harness();
 assert.equal((await h.send({type:'SMZ_TRACE_GET'},'https://x.com/demo')).ok,false);
 assert.equal((await h.send({type:'SMZ_TRACE_GET'},h.base+'popup/popup.html')).ok,false);
 assert.equal((await h.send({type:'SMZ_TRACE_GET'})).ok,true);
});
test('reset renews the existing offscreen trace context',async()=>{
 const h=await harness();
 assert.equal((await h.send({type:'SMZ_BACKUP_RESET_ALL'},h.base+'options/options.html')).ok,true);
 await delay(5);
 h.offscreen.SMZDirectoryTrace.emit('writer.after-reset',{directoryKey:'NEW_KEY'});
 await delay(5);
 const result=await h.send({type:'SMZ_TRACE_GET'});
 assert(result.log.entries.some(e=>e.event==='writer.after-reset'),'same offscreen must be able to log after reset');
});
test('late pre-reset selection event cannot repopulate the tab-close tracker',async()=>{
 const h=await harness();const birth=Date.now()-1000;
 assert.equal((await h.send({type:'SMZ_BACKUP_RESET_ALL'},h.base+'options/options.html')).ok,true);
 await delay(5);
 await h.send({type:'SMZ_TRACE_EVENT',record:{event:'selection.visibility',at:Date.now(),contextStartedAt:birth,contextId:'OLD_CONTEXT',seq:3,
  fields:{directoryKey:'OLD_PRIVATE_KEY',traceId:'OLD_TRACE'}}},h.base+'archive/directory.html',77);
 await delay(5);h.removed(77);await delay(5);
 const result=await h.send({type:'SMZ_TRACE_GET'});
 assert(!JSON.stringify(result.log).includes('OLD_PRIVATE_KEY'));
});
test('viewer receives log-clear failure instead of a false success',async()=>{
 const h=await harness();h.failStorage(true);
 assert.equal((await h.send({type:'SMZ_TRACE_CLEAR'})).ok,false);
});

test('X diagnostic endpoint accepts only the active source tab and strips page secrets',async()=>{
 const h=await harness();const id='2121034947280753090';
 await h.background.chrome.storage.local.set({smz_collection_x_demo:{platform:'x',handle:'demo',status:'collecting',collectionId:'x-job',collectionTabId:77,items:[],counts:{images:0,videos:0,total:0}}});
 const msg={type:'SMZ_X_MEDIA_DIAGNOSTIC',handle:'demo',collectionId:'x-job',diagnostic:{postId:id,phase:'extracted',receivedCount:20,firstMediaCount:20,extractedCount:20,imageCount:20,videoCount:0,ignoredCount:0,token:'SECRET_TOKEN',url:'SECRET_URL'}};
 assert.equal((await h.send(msg,h.base+'popup/popup.html',77)).ok,false);
 assert.equal((await h.send(msg,'https://x.com/demo/media',78)).discarded,true);
 assert.equal((await h.send({...msg,collectionId:'stale'},'https://x.com/demo/media',77)).discarded,true);
 assert.equal((await h.send(msg,'https://x.com/other/media',77)).ok,false);
 assert.equal((await h.send(msg,'https://x.com/demo/media',77)).ok,true);
 const log=(await h.send({type:'SMZ_TRACE_GET'})).log;
 const event=log.entries.find(e=>e.event==='x.media.response');assert.equal(event.fields.receivedCount,20);assert.equal(event.fields.postId,id);
 assert(!JSON.stringify(log).includes('SECRET_'));
});

test('20 received items are persisted before diagnostics report collection and saved-key counts',async()=>{
 const h=await harness(),id='2121034947280753090';
 await h.background.chrome.storage.local.set({smz_collection_x_demo:{platform:'x',handle:'demo',status:'collecting',collectionId:'x-job',collectionTabId:77,items:[],counts:{images:0,videos:0,total:0}}});
 const items=Array.from({length:20},(_,i)=>({key:`${id}_${i+1}`,postId:id,mediaIndex:i+1,type:'image',url:`https://pbs.twimg.com/media/PRIVATE_${i}.jpg`}));
 const result=await h.send({type:'SMZ_ADD_MEDIA',handle:'demo',collectionId:'x-job',items},'https://x.com/demo/media',77);
 assert.equal(result.addedCount,20);
 await h.background.chrome.storage.local.set({smz_collection_x_demo:{...result.state,savedItemKeys:items.map(i=>i.key)}});
 const exported=await h.send({type:'SMZ_TRACE_GET'});
 assert.equal(exported.xMedia[0].posts[0].collectedCount,20);assert.equal(exported.xMedia[0].posts[0].savedCount,20);
 assert.equal(exported.log.entries.find(e=>e.event==='x.media.persisted').fields.addedCount,20);
 assert(!JSON.stringify(exported).includes('PRIVATE_'));
});
