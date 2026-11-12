'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
function setup(fail=false){
 const data={};
 const c=vm.createContext({Date,JSON,console,setTimeout,clearTimeout,
  chrome:{storage:{local:{get:async k=>structuredClone({[k]:data[k]}),set:async v=>{if(fail)throw Error('storage failure');Object.assign(data,structuredClone(v));}}}}
 });
 vm.runInContext(read('debug/trace-core.js')+'\n'+read('debug/trace-store.js'),c);
 return {c,data,store:c.SMZDirectoryTraceStore,core:c.SMZDirectoryTraceCore};
}
test('trace allowlist excludes credentials and media data',async()=>{
 const {store}=setup();
 await store.append({event:'directory.chosen',at:Date.now(),context:'selection',contextId:'c',seq:1,
  fields:{directoryKey:'archive-directory:change-a',directoryName:'写真集',label:'D:\\test',token:'secret',items:[{url:'private'}],
   errorMessage:'Bearer ABC access_token=XYZ https://example.test/?secret=ABC'}});
 const log=await store.get();const text=JSON.stringify(log);
 assert.equal(log.entries[0].fields.label,'D:\\test');
 for(const secret of ['ABC','XYZ','private','example.test'])assert(!text.includes(secret));
 assert(!Object.hasOwn(log.entries[0].fields,'token'));
});
test('concurrent trace writes are serialized and bounded',async()=>{
 const {store}=setup();
 await Promise.all(Array.from({length:425},(_,i)=>store.append({event:'test',at:Date.now(),seq:i,contextId:'c',fields:{count:i}})));
 const {entries}=await store.get();assert.equal(entries.length,400);
 assert.equal(entries[0].fields.count,25);assert.equal(entries.at(-1).fields.count,424);
});
test('clear/reset drops delayed pre-reset events, even after store restart',async()=>{
 const {store,c}=setup();const old=Date.now()-100;
 await store.append({event:'old',at:old,contextId:'c',seq:1});
 await store.suspendForReset();await store.resumeAfterReset(true);
 await store.append({event:'late',at:old,contextId:'c',seq:2});
 assert.equal((await store.get()).entries.length,0);
 vm.runInContext(read('debug/trace-store.js'),c);
 await c.SMZDirectoryTraceStore.append({event:'late-again',at:old,contextId:'c',seq:3});
 assert.equal((await c.SMZDirectoryTraceStore.get()).entries.length,0);
});
test('trace storage failure never rejects business-side logger',async()=>{
 const {store}=setup(true);
 await assert.doesNotReject(store.append({event:'failure',at:Date.now(),contextId:'c',seq:1}));
 await assert.doesNotReject(store.clear());
});
test('trace snapshot captures both saved directory fields, not collection contents',()=>{
 const {core}=setup();
 const snapshot=core.snapshot({platform:'x',collectionId:'123',preferredSaveDirectoryKey:'B',preferredSaveDirectoryName:'G test',
  items:[{secret:'NO'}],archive:{saveDirectoryKey:'A',saveDirectoryName:'D test',pauseReason:'save_permission',nextItemIndex:5}});
 assert.equal(snapshot.archiveKey,'A');assert.equal(snapshot.preferredKey,'B');
 assert(!JSON.stringify(snapshot).includes('NO'));
});
test('trace client is fire-and-forget when message delivery fails',async()=>{
 const c=vm.createContext({Date,JSON,Math,console,
  chrome:{runtime:{getManifest:()=>({version:'test'}),sendMessage:()=>Promise.reject(Error('no worker'))}},
  location:{pathname:'/popup/popup.html'}
 });
 vm.runInContext(read('debug/trace-core.js')+'\n'+read('debug/trace-client.js'),c);
 assert.equal(c.SMZDirectoryTrace.emit('example',{directoryName:'test'}),undefined);
 await new Promise(r=>setTimeout(r,0));
});
test('filesystem trace records original failure phase without extra I/O',async()=>{
 const events=[];let reads=0,writes=0,queries=0;
 const dir={name:'test',queryPermission:async()=>{queries++;return 'granted';},
  getFileHandle:async(name,options)=>{
   reads++;if(!options?.create)throw Object.assign(Error('not found'),{name:'NotFoundError'});
   return {createWritable:async()=>({write:async()=>{writes++;throw Object.assign(Error('revoked'),{name:'NotAllowedError'});},abort:async()=>{}})};
  }};
 const c=vm.createContext({Date,console,window:{},indexedDB:{open(){const r={};queueMicrotask(()=>{
  r.result={close(){},transaction(){return {objectStore(){return {get(){const q={};queueMicrotask(()=>{q.result=dir;q.onsuccess();});return q;}};}};}};r.onsuccess();});return r;}},
  SMZDirectoryTrace:{emit:(event,fields)=>events.push({event,fields}),failure:(event,error,fields)=>events.push({event,errorName:error.name,...fields})}
 });
 vm.runInContext(read('archive/fs-access.js'),c);
 const output=await c.SMZFileSystem.openWritableFile('key','001.zip');
 await assert.rejects(output.writable.write(new Uint8Array([1])),{name:'NotAllowedError'});
 assert.equal(events.find(e=>e.event==='fs.write.failed').phase,'write');
 assert.equal(events.find(e=>e.event==='fs.write.failed').errorName,'NotAllowedError');
 assert.equal(reads,2);assert.equal(writes,1);assert.equal(queries,1);
});
test('normal ZIP/JSON backup excludes diagnostic log records',()=>{
 const c=vm.createContext({URL,console});vm.runInContext(read('backup/schema.js'),c);
 const backup=c.SMZBackup.fullEnvelope({smz_directory_trace_v1:{entries:[{label:'PRIVATE_FOLDER_SENTINEL'}]}});
 assert(!JSON.stringify(backup).includes('PRIVATE_FOLDER_SENTINEL'));
});
test('JSON and escaped credential values are redacted',()=>{
 const {core}=setup();
 for(const text of [JSON.stringify({access_token:'TOKEN_A',cookie:'COOKIE_A'}),
  JSON.stringify({nested:JSON.stringify({access_token:'TOKEN_A',cookie:'COOKIE_A'})}),
  String.raw`failure https:\/\/example.test\/?secret=URL_SECRET`]){
  const redacted=core.fields({errorMessage:text}).errorMessage;
  for(const value of ['TOKEN_A','COOKIE_A','URL_SECRET','example.test'])assert(!redacted.includes(value),redacted);
 }
});
test('failed user-requested log clear returns failure and retains records',async()=>{
 const {store,data}=setup(true);
 data.smz_directory_trace_v1={entries:[{event:'existing'}],since:0};
 const result=await store.clear();
 assert.equal(result.ok,false);
 assert.equal((await store.get()).entries.length,1);
});
test('events from a pre-reset page are dropped even with new event timestamps',async()=>{
 const {store}=setup();const birth=Date.now()-1000;
 await store.suspendForReset();await new Promise(r=>setTimeout(r,5));await store.resumeAfterReset(true);
 await new Promise(r=>setTimeout(r,5));
 await store.append({event:'stale-page',at:Date.now(),contextStartedAt:birth,contextId:'old',seq:1});
 assert.equal((await store.get()).entries.length,0);
 await store.append({event:'fresh-page',at:Date.now()+1,contextStartedAt:Date.now(),contextId:'new',seq:1});
 assert.equal((await store.get()).entries.length,1);
});
