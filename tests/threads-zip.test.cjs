'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const clone=x=>structuredClone(x);
(async()=>{
  const img='https://scontent.cdninstagram.com/v/t51.2885/img1.jpg?oh=SIGNED&oe=FUTURE';
  const vid='https://scontent.fbcdn.net/v/t50.2886/video1.mp4?oh=SIGNED&oe=FUTURE';
  const items=[
    {key:'18011111111111111_1',platform:'threads',postId:'18011111111111111',mediaIndex:1,type:'image',url:img,fallbackUrls:[],extension:'jpg',postedAt:'2026-09-27T10:00:00.000Z'},
    {key:'18022222222222222_1',platform:'threads',postId:'18022222222222222',mediaIndex:1,type:'video',url:vid,fallbackUrls:[],extension:'mp4',postedAt:'2026-09-26T10:00:00.000Z'}];
  let state={platform:'threads',handle:'artist.demo',ownProfile:false,collectionId:'threads-zip-1',status:'complete',collectionMode:'api',
    access_token:'MUST_NEVER_EXPORT',startedAt:Date.now(),completedAt:Date.now(),items,
    newestPostId:items[0].postId,oldestPostId:items[1].postId,counts:{images:1,videos:1,total:2},
    archive:{status:'archiving',collectionId:'threads-zip-1',selection:{images:true,videos:true},splitMode:'auto',mediaKind:'media',
      nextItemIndex:0,nextZipNumber:1,savedZipCount:0,startedAt:Date.now(),saveMode:'directory',saveDirectoryKey:'test',saveDirectoryName:'test'}};
  const outputs=[];const fsMock={async openWritableFile(k,filename){const chunks=[];return {filename,directoryName:'test',writable:{
    async write(data){chunks.push(Buffer.from(data))},async close(){outputs.push({filename,bytes:Buffer.concat(chunks)})},async abort(){}},async remove(){}}}};
  let handler;const chrome={runtime:{onMessage:{addListener:f=>handler=f},async sendMessage(msg){
    if(msg.type==='SMZ_ARCHIVE_GET_STATE')return {ok:true,state:clone(state),previous:null};
    if(msg.type==='SMZ_ARCHIVE_PATCH'){state.archive={...state.archive,...clone(msg.patch)};return {ok:true,state:clone(state)}}
    throw Error('unexpected '+msg.type);}}};
  const fetch=async (url,options)=>{assert(!String(options?.headers?.Authorization||'').includes('MUST_NEVER_EXPORT'));
    return {ok:true,status:200,headers:{get:()=>url.includes('.jpg')?'image/jpeg':'video/mp4'},
      arrayBuffer:async()=>Uint8Array.from(url.includes('.jpg')?[1,2,3,4]:[9,8,7,6,5]).buffer};};
  const context=vm.createContext({chrome,SMZFileSystem:fsMock,URL,console,fetch,Blob,Response,CompressionStream,
    TextEncoder,TextDecoder,DataView,Uint8Array,Uint32Array,setTimeout,clearTimeout});
  vm.runInContext(read('backup/schema.js')+'\n'+read('archive/offscreen.js'),context);
  handler({target:'offscreen',type:'SMZ_OFFSCREEN_START_ARCHIVE',platform:'threads',handle:state.handle,
    selection:{images:true,videos:true},mediaKind:'media',splitMode:'auto',saveMode:'directory',saveDirectoryKey:'test'},{},()=>{});
  for(let i=0;i<500&&!['archive_complete','archive_error'].includes(state.archive.status);i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(state.archive.status,'archive_complete',state.archive.lastError);
  assert.equal(outputs.length,1);assert.match(outputs[0].filename,/^threads_artist\.demo_\d{8}_\d{6}_media_001\.zip$/);
  const zip=new Blob([outputs[0].bytes]);const zipContext=vm.createContext({Blob,Response,DecompressionStream,TextEncoder,
    TextDecoder,Uint8Array,Uint32Array,DataView,URL,console});
  vm.runInContext(read('backup/schema.js')+'\n'+read('backup/zip-reader.js'),zipContext);
  const metadata=await zipContext.SMZZipReader.accountJsonFromZip(zip);
  assert.equal(metadata.accounts[0].current.platform,'threads');assert.equal(metadata.accounts[0].current.items.length,2);
  assert.equal(metadata.accounts[0].current.archive.nextItemIndex,2);
  const central=outputs[0].bytes.toString('latin1');
  assert(central.includes('threads_artist.demo/images/18011111111111111_1.jpg'));
  assert(central.includes('threads_artist.demo/videos/18022222222222222_1.mp4'));
  assert(central.includes('threads_artist.demo/backup-state.json'));
  assert(!central.includes('MUST_NEVER_EXPORT'));
  console.log('PASS Threads ZIP: signed CDN image/video bytes, per-type folders, ZIP name, embedded resumable checkpoint, secret exclusion');
})().catch(e=>{console.error(e);process.exitCode=1});
