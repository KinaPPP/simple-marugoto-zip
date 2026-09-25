'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=rel=>fs.readFileSync(path.join(__dirname,'..',rel),'utf8');
const did='did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const cid='bafkrei'+'a'.repeat(50);
const pds='https://morel.us-east.host.bsky.network';
const clone=x=>structuredClone(x);
(async()=>{
  const items=[{platform:'bluesky',key:'3mybbbbbbb_1',postId:'3mybbbbbbb',mediaIndex:1,type:'image',
      url:`${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${cid}`,
      fallbackUrls:[`https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}@jpeg`],extension:'jpg'},
    {platform:'bluesky',key:'3myaaaaaaa_1',postId:'3myaaaaaaa',mediaIndex:1,type:'video',
      url:`${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${cid}`,
      fallbackUrls:[],extension:'mp4'}];
  let state={platform:'bluesky',handle:'artist.bsky.social',did,pds,collectionId:'bluesky-zip-1',
    status:'complete',collectionMode:'api',startedAt:Date.now(),completedAt:Date.now(),items,
    newestPostId:items[0].postId,oldestPostId:items[1].postId,counts:{images:1,videos:1,total:2},
    archive:{status:'archiving',collectionId:'bluesky-zip-1',selection:{images:true,videos:true},
      splitMode:'auto',mediaKind:'media',nextItemIndex:0,nextZipNumber:1,savedZipCount:0,
      startedAt:Date.now(),saveMode:'directory',saveDirectoryKey:'test',saveDirectoryName:'test'}};
  const outputs=[];
  const fsMock={async openWritableFile(k,filename){const chunks=[];return {filename,directoryName:'test',writable:{
    async write(data){chunks.push(Buffer.from(data))},async close(){outputs.push({filename,bytes:Buffer.concat(chunks)})},async abort(){}},async remove(){}}}};
  let handler;
  const chrome={runtime:{onMessage:{addListener:f=>handler=f},async sendMessage(msg){
    if(msg.type==='SMZ_ARCHIVE_GET_STATE')return {ok:true,state:clone(state),previous:null};
    if(msg.type==='SMZ_ARCHIVE_PATCH'){state.archive={...state.archive,...clone(msg.patch)};return {ok:true,state:clone(state)}}
    throw Error('unexpected '+msg.type);
  }}};
  const fetch=async url=>({ok:true,headers:{get:()=> url.includes('cid=') ? 'application/octet-stream' : 'image/jpeg'},
    arrayBuffer:async()=>Uint8Array.from(url.includes('cid=') ? [9,8,7,6,5,4] : [1,2,3]).buffer});
  const context=vm.createContext({chrome,SMZFileSystem:fsMock,URL,console,fetch,
    Blob,Response,CompressionStream,TextEncoder,TextDecoder,DataView,Uint8Array,Uint32Array,setTimeout,clearTimeout});
  vm.runInContext(read('backup/schema.js')+'\n'+read('archive/offscreen.js'),context);
  handler({target:'offscreen',type:'SMZ_OFFSCREEN_START_ARCHIVE',platform:'bluesky',handle:state.handle,
    selection:{images:true,videos:true},mediaKind:'media',splitMode:'auto',
    saveMode:'directory',saveDirectoryKey:'test'},{},()=>{});
  for(let i=0;i<500&&!['archive_complete','archive_error'].includes(state.archive.status);i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(state.archive.status,'archive_complete',state.archive.lastError);
  assert.equal(outputs.length,1);
  assert.match(outputs[0].filename,/^bsky_artist\.bsky\.social_\d{8}_\d{6}_media_001\.zip$/);
  const zip=new Blob([outputs[0].bytes]);
  const zipContext=vm.createContext({Blob,Response,DecompressionStream,TextEncoder,TextDecoder,Uint8Array,Uint32Array,DataView,URL,console});
  vm.runInContext(read('backup/schema.js')+'\n'+read('backup/zip-reader.js'),zipContext);
  const metadata=await zipContext.SMZZipReader.accountJsonFromZip(zip);
  assert.equal(metadata.accounts[0].current.platform,'bluesky');
  assert.equal(metadata.accounts[0].current.items.length,2);
  assert.equal(metadata.accounts[0].current.archive.nextItemIndex,2);
  const central=outputs[0].bytes.toString('latin1');
  assert(central.includes('bsky_artist.bsky.social/images/3mybbbbbbb_1.jpg'));
  assert(central.includes('bsky_artist.bsky.social/videos/3myaaaaaaa_1.mp4'));
  assert(central.includes('bsky_artist.bsky.social/backup-state.json'));
  assert(!central.includes('Bearer '));
  console.log('PASS Bluesky ZIP: original media bytes, images/videos folders, bsky file name, embedded per-account checkpoint and importer');
})().catch(e=>{console.error(e);process.exitCode=1});
