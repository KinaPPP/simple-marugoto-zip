'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');const read=n=>fs.readFileSync(path.join(root,n),'utf8');
const did='did:plc:3arwdesrvwphhadfixb24dcb',pds='https://morel.us-east.host.bsky.network';
const images=Array.from({length:10},(_,i)=>({$type:'app.bsky.embed.gallery#image',alt:'',image:{ref:{$link:'bafkrei'+'a'.repeat(48)+String(i)},mimeType:'image/jpeg'}}));
const context=vm.createContext({URL,console,fetch:async()=>{throw Error('Unexpected real request');}});vm.runInContext(read('providers/bluesky/api.js')+'\n'+read('providers/threads/api.js'),context);
function entry(embed){return {post:{uri:`at://${did}/app.bsky.feed.post/3n2asatc3hc2z`,author:{did},record:{createdAt:'2026-11-14T05:46:00Z',embed}}};}
async function pack(platform,items){
 const handle=platform==='bluesky'?'artist.bsky.social':platform==='threads'?'artist.demo':'demo';
 let state={platform,handle,did,pds,ownProfile:true,collectionId:'multi-test',status:'complete',collectionMode:'api',items,
  counts:{images:items.filter(x=>x.type==='image').length,videos:items.filter(x=>x.type==='video').length,total:items.length},
  completedAt:Date.now(),archive:{status:'archiving',collectionId:'multi-test',selection:{images:true,videos:true},splitMode:'auto',mediaKind:'media',
   nextItemIndex:0,nextZipNumber:1,savedZipCount:0,startedAt:Date.now(),saveMode:'directory',saveDirectoryKey:'test',saveDirectoryName:'test'}};
 const outputs=[];let handler;
 const chrome={runtime:{onMessage:{addListener:fn=>handler=fn},sendMessage:async m=>{
  if(m.type==='SMZ_ARCHIVE_GET_STATE')return {ok:true,state:structuredClone(state),previous:null};
  if(m.type==='SMZ_ARCHIVE_PATCH'){state.archive={...state.archive,...structuredClone(m.patch)};return {ok:true,state:structuredClone(state)};}
  throw Error(m.type);
 }}};
 const fileSystem={openWritableFile:async(key,filename)=>{const chunks=[];return {filename,directoryName:'test',writable:{
  write:async data=>chunks.push(Buffer.from(data)),close:async()=>outputs.push({filename,bytes:Buffer.concat(chunks)}),abort:async()=>{}},remove:async()=>{},verify:async bytes=>assert.equal(Buffer.concat(chunks).length,bytes)};}};
 const worker=vm.createContext({chrome,SMZFileSystem:fileSystem,URL,console,Blob,Response,CompressionStream,TextEncoder,TextDecoder,DataView,Uint8Array,Uint32Array,setTimeout,clearTimeout,
  fetch:async()=>({ok:true,status:200,headers:{get:()=> 'image/jpeg'},arrayBuffer:async()=>new Uint8Array([1,2,3,4]).buffer})});
 vm.runInContext(read('backup/schema.js')+'\n'+read('archive/offscreen.js'),worker);
 for(let run=0;run<Math.ceil(items.length/5);run++){
  state.archive.status='archiving';
  handler({target:'offscreen',type:'SMZ_OFFSCREEN_START_ARCHIVE',platform,handle,selection:{images:true,videos:true},mediaKind:'media',splitMode:'auto',saveMode:'directory',saveDirectoryKey:'test',runLimit:5},{},()=>{});
  for(let i=0;i<500&&!['archive_complete','archive_error','archive_paused'].includes(state.archive.status);i++)await new Promise(r=>setTimeout(r,5));
  assert.notEqual(state.archive.status,'archive_error',state.archive.lastError);assert.equal(state.archive.nextItemIndex,(run+1)*5);
  await new Promise(r=>setTimeout(r,10));
 }
 assert.equal(outputs.length,Math.ceil(items.length/5));assert.equal(state.archive.status,'archive_complete');
 const reader=vm.createContext({URL,console,Blob,Response,DecompressionStream,TextEncoder,TextDecoder,DataView,Uint8Array,Uint32Array});
 vm.runInContext(read('backup/schema.js')+'\n'+read('backup/zip-reader.js'),reader);
 const metadata=await reader.SMZZipReader.accountJsonFromZip(new Blob([outputs.at(-1).bytes]));
 assert.equal(metadata.accounts[0].current.items.length,items.length);assert.equal(metadata.accounts[0].current.archive.nextItemIndex,items.length);assert.equal(metadata.accounts[0].current.savedItemKeys.length,items.length);
 // Read central-directory entries and compare the actual stored bytes, not only names.
 const extracted=[];
 for(const output of outputs){
  const bytes=output.bytes;
  for(let pos=0;pos+46<=bytes.length;pos++){
   if(bytes.readUInt32LE(pos)!==0x02014b50)continue;
   const method=bytes.readUInt16LE(pos+10),size=bytes.readUInt32LE(pos+20),nameLen=bytes.readUInt16LE(pos+28),extraLen=bytes.readUInt16LE(pos+30),commentLen=bytes.readUInt16LE(pos+32),offset=bytes.readUInt32LE(pos+42);
   const name=bytes.subarray(pos+46,pos+46+nameLen).toString('utf8');
   const dataStart=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);
   const raw=bytes.subarray(dataStart,dataStart+size);
   const data=method===8?require('node:zlib').inflateRawSync(raw):raw;
   if(name.includes('/images/')){assert.deepEqual(data,Buffer.from([1,2,3,4]));extracted.push(name);}
   pos+=45+nameLen+extraLen+commentLen;
  }
 }
 assert.equal(extracted.length,items.length);assert.equal(new Set(extracted).size,items.length);
 const all=outputs.map(x=>x.bytes.toString('latin1')).join('');
 for(const item of items)assert(all.includes(`/images/${item.postId}_${item.mediaIndex}.jpg`));
 console.log(`PASS ${platform}: ${items.length} items -> ${outputs.length} ZIP files; exact file count, filenames, bytes and resumable metadata retained (mock image bytes)`);
}
(async()=>{
 const legacy=context.SMZBluesky.extract(entry({$type:'app.bsky.embed.images',images}),did,pds);
 assert.equal(legacy.items.length,10);console.log('PASS Bluesky legacy image embed: ten image records extracted');
 const gallery=context.SMZBluesky.extract(entry({$type:'app.bsky.embed.gallery',items:images}),did,pds);
 assert.equal(gallery.items.length,10);console.log('PASS Bluesky gallery: ten records extracted');
 await pack('bluesky',gallery.items);
 const children=Array.from({length:10},(_,i)=>({id:String(18000000000000001n+BigInt(i)),media_type:'IMAGE',media_url:`https://scontent.cdninstagram.com/test_${i}.jpg`}));
 const album=await context.SMZThreads.extract({id:'18011111111111111',media_type:'CAROUSEL_ALBUM',timestamp:'2026-11-16T11:40:00Z',children:{data:children}},'FAKE_TEST_TOKEN');
 assert.equal(album.items.length,10);assert.equal(album.items.at(-1).mediaIndex,10);console.log('PASS Threads: ten embedded carousel children extracted');
 let calls=0;
 const lookup=await context.SMZThreads.extract({id:'18022222222222222',media_type:'CAROUSEL_ALBUM',children:{data:children.map(c=>({id:c.id}))}},'FAKE_TEST_TOKEN',async url=>{
  calls++;const id=new URL(url).pathname.split('/').at(-1);return {ok:true,json:async()=>children.find(c=>c.id===id)};
 });assert.equal(lookup.items.length,10);assert.equal(calls,10);console.log('PASS Threads: ten child-detail lookups also retain all ten items');
 await pack('threads',album.items);
 const messages=[],listeners={};
 const media=Array.from({length:20},(_,i)=>({type:'photo',media_url_https:`https://pbs.twimg.com/media/test_${i}.jpg`}));
 const post={rest_id:'2121034947280753090',core:{user_results:{result:{legacy:{screen_name:'demo'}}}},legacy:{extended_entities:{media}}};
 const window={addEventListener:(n,fn)=>listeners[n]=fn,postMessage:m=>messages.push(m),fetch:async()=>({ok:true,status:200,clone:()=>({ok:true,status:200,json:async()=>({result:post})})})};
 vm.runInNewContext(read('providers/x/main-hook.js'),{window,URL,console,sessionStorage:{getItem:()=>null}});
 listeners.message({source:window,data:{source:'simple-marugoto-zip',type:'SMZ_X_CONTROL',enabled:true,handle:'demo'}});
 await window.fetch('https://x.com/i/api/graphql/test/UserMedia');await new Promise(r=>setImmediate(r));
 await pack('x',messages.find(m=>m.type==='SMZ_X_MEDIA_BATCH').items);
})().catch(e=>{console.error(e);process.exitCode=1;});
