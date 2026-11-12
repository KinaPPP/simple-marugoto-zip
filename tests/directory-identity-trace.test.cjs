'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function setup(restored){
  const events=[];let queries=0,opens=0;
  const c=vm.createContext({console,window:{},indexedDB:{open(){opens++;const r={};queueMicrotask(()=>{
    r.result={close(){},transaction(){return {objectStore(){return {get(){const q={};queueMicrotask(()=>{q.result=restored;q.onsuccess();});return q;}};}};}};r.onsuccess();});return r;}},
    SMZDirectoryTrace:{emit:(event,fields)=>events.push({event,fields}),failure:(event,error,fields)=>events.push({event,fields,errorName:error.name})}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../archive/fs-access.js'),'utf8'),c);
  return {api:c.SMZFileSystem,events,get opens(){return opens;}};
}
test('fresh IDB identity check distinguishes same-name folders without changing cached handle',async()=>{
  const restored={name:'test',kind:'directory'};
  const s=setup(restored);
  const live={name:'test',kind:'directory',isSameEntry:async h=>{assert.equal(h,restored);return false;}};
  const result=await s.api.diagnoseDirectoryIdentity('key',live,'selection.after-store');
  assert.equal(result.sameEntry,false);assert.equal(result.namesMatch,true);
  assert.equal(result.phase,'selection.after-store');assert.equal(s.opens,1);
  assert.equal(s.events.at(-1).event,'fs.directory.identityProbe');
});
test('slash name is flagged with Unicode code point and live/restored names',async()=>{
  const s=setup({name:'\\',kind:'directory'});
  const result=await s.api.diagnoseDirectoryIdentity('key',{name:'_test',kind:'directory',isSameEntry:async()=>true},'selection.after-commit');
  assert.equal(result.sameEntry,true);assert.equal(result.namesMatch,false);
  assert.equal(result.referenceName,'_test');assert.equal(result.directoryName,'\\');
  assert.equal(result.nameCodePoints,'U+005C');assert.equal(result.suspiciousName,true);
});
test('diagnostic failure does not reject or invent a same-entry result',async()=>{
  const s=setup({name:'test',kind:'directory'});
  const result=await s.api.diagnoseDirectoryIdentity('key',{name:'test',isSameEntry:async()=>{throw Object.assign(Error('revoked'),{name:'NotAllowedError'});}},'probe');
  assert.equal(result,null);
  assert(s.events.some(e=>e.event==='fs.directory.identityProbeFailed'&&e.errorName==='NotAllowedError'));
});
test('identity diagnostic never prompts, traverses or writes to selected directory',async()=>{
  const forbidden=()=>{throw Error('unexpected directory I/O');};
  const restored={name:'_test',kind:'directory',getFileHandle:forbidden,queryPermission:forbidden,requestPermission:forbidden};
  const s=setup(restored);
  const live={...restored,isSameEntry:async()=>true};
  assert.equal((await s.api.diagnoseDirectoryIdentity('key',live,'probe')).sameEntry,true);
});
test('missing handle is recorded without asserting identity',async()=>{
  const s=setup(null);
  const result=await s.api.diagnoseDirectoryIdentity('key',{name:'test'},'probe');
  assert.equal(result.found,false);assert.equal(result.namesMatch,false);
  assert.equal(Object.hasOwn(result,'sameEntry'),false);
});
test('yen glyph and backslash remain distinguishable in persisted trace fields',()=>{
  const c=vm.createContext({Date});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../debug/trace-core.js'),'utf8'),c);
  const {api}=setup(null);
  for(const [name,code] of [['\\','U+005C'],['¥','U+00A5'],['￥','U+FFE5']]){
    const details=api.directoryDetails({name,kind:'directory'});
    const fields=c.SMZDirectoryTraceCore.fields({...details,referenceName:'_test',referenceKind:'directory',namesMatch:false});
    assert.equal(fields.nameCodePoints,code);assert.equal(fields.suspiciousName,true);
    assert.equal(fields.referenceName,'_test');assert.equal(fields.namesMatch,false);
  }
});
