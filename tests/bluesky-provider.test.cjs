'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const clone = o => structuredClone(o);
const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const cid = 'bafkrei' + 'a'.repeat(50);
const pds = 'https://morel.us-east.host.bsky.network';
const recordImage = id => ({post:{author:{did},uri:`at://${did}/app.bsky.feed.post/${id}`,
  record:{createdAt:'2026-09-24T11:20:00Z',embed:{$type:'app.bsky.embed.images',images:[{image:{ref:{$link:cid},mimeType:'image/jpeg'}}]}},
  embed:{$type:'app.bsky.embed.images#view',images:[{fullsize:`https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}@jpeg`}]}}});
const recordVideo = id => ({post:{author:{did},uri:`at://${did}/app.bsky.feed.post/${id}`,
  record:{createdAt:'2026-09-24T11:20:00Z',embed:{$type:'app.bsky.embed.video',video:{ref:{$link:cid},mimeType:'video/mp4'}}},
  embed:{$type:'app.bsky.embed.video#view',playlist:'https://video.bsky.app/watch/.../playlist.m3u8'}}});
function moduleTest(){
  const context = vm.createContext({ URL, console });
  vm.runInContext(read('providers/bluesky/api.js'),context);
  const b=context.SMZBluesky;
  assert.equal(b.validActor('artist.bsky.social'),true);
  assert.equal(b.validActor('localhost'),false);
  assert.equal(b.allowedPds('https://172.16.1.20'),null);
  assert.equal(b.allowedPds('https://169.254.1.2'),null);
  const image=b.extract(recordImage('3myaaaaaaa'),did,pds);
  assert.equal(image.items.length,1);
  assert.match(image.items[0].url,/getBlob/);
  assert.equal(image.items[0].fallbackUrls.length,1);
  assert.equal(b.extract(recordVideo('3mybbbbbbb'),did,pds).items[0].fallbackUrls.length,0);
  assert.equal(b.extract({...recordImage('3myccccccc'),post:{...recordImage('3myccccccc').post,author:{did:'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'}}},did,pds),null);
  const external=recordImage('3myddddddd'); external.post.record.embed={$type:'app.bsky.embed.external',external:{thumb:{ref:{$link:cid}}}};
  assert.deepEqual(b.extract(external,did,pds).items.length,0);
  console.log('PASS Bluesky: identify owner, image & original video Blob, ignore external card and other-account repost');
}
async function harness(){
  const store={};let receiver;let pageMode='first';let n=0;let toolbarBadge='';
  const sendResponse=[];
  const calls=[];
  const chrome={
    runtime:{getURL:p=>'chrome-extension://mock/'+p,onMessage:{addListener:f=>receiver=f},sendMessage:async m=>{ if(m.target==='offscreen'){sendResponse.push(m);return {ok:true}} throw Error('unexpected offscreen');}},
    storage:{local:{async get(k){if(k===null)return clone(store);if(typeof k==='string')return {[k]:clone(store[k])};const out={};for(const a of k)out[a]=clone(store[a]);return out;},
      async set(obj){Object.assign(store,clone(obj))},async remove(k){for(const key of [].concat(k))delete store[key];},async clear(){for(const k of Object.keys(store))delete store[k];}}},
    permissions:{async contains(){return true}},
    tabs:{async query(){return [{url:'https://bsky.app/profile/artist.bsky.social',id:3}]},onActivated:{addListener(){}},onUpdated:{addListener(){}}},
    windows:{onFocusChanged:{addListener(){}}},offscreen:{async hasDocument(){return false}},
    alarms:{onAlarm:{addListener(){}},async clear(){return true}},
    downloads:{onDeterminingFilename:{addListener(){}}},
    action:{async setIcon(){},async setBadgeText({text}){toolbarBadge=text},async setBadgeBackgroundColor(){},async setBadgeTextColor(){},async setTitle(){}}
  };
  const fetch=async (u,opts)=>{
    const url=new URL(u); calls.push(url.toString());
    let body;
    if(url.pathname.endsWith('.getProfile'))body={did,handle:'artist.bsky.social'};
    else if(url.host==='plc.directory')body={service:[{id:'#atproto_pds',type:'AtprotoPersonalDataServer',serviceEndpoint:pds}]};
    else if(url.pathname.endsWith('.getAuthorFeed')) {
      n++;
      if(pageMode==='429')return {ok:false,status:429,headers:{get:name=>name==='retry-after'?'120':null}};
      if(pageMode==='first')body=url.searchParams.has('cursor')?{feed:[recordImage('3myaaaaaaa')]}:
        {feed:[recordVideo('3myccccccc'),recordImage('3mybbbbbbb')],cursor:'next-page'};
      else if(pageMode==='delta')body={feed:[recordImage('3myddddddd'),recordVideo('3myccccccc'),recordImage('3mybbbbbbb')],cursor:'too-old'};
      else if(pageMode==='zero')body={feed:[recordImage('3myddddddd'),recordVideo('3myccccccc')]};
      else body={feed:[recordImage('3myfffffff')],cursor:'continue'};
    } else throw Error('unexpected '+u);
    return {ok:true,status:200,headers:{get:()=>null},json:async()=>clone(body)};
  };
  const context=vm.createContext({URL,console:{...console,error(){}},fetch,chrome,setTimeout,clearTimeout,AbortController});
  vm.runInContext(read('backup/schema.js')+'\n'+read('providers/bluesky/api.js')+'\n'+read('background.js'),context);
  const send=(type,data={})=>new Promise(resolve=>receiver({type,...data},{url:'chrome-extension://mock/popup/popup.html'},resolve));
  const wait=async pred=>{for(let i=0;i<100;i++){if(pred())return;await new Promise(r=>setTimeout(r,20))}throw Error('timed out')};
  await new Promise(r=>setTimeout(r,15));
  const profile=await send('SMZ_BSKY_GET_PROFILE',{actor:'artist.bsky.social'});
  assert(profile.ok,profile.error);assert.equal(profile.pds,pds);
  let response=await send('SMZ_BSKY_START_COLLECTION',{handle:'artist.bsky.social'});
  assert(response.ok,response.error);
  await wait(()=>store['smz_collection_bluesky_artist.bsky.social']?.status==='complete');
  const base=store['smz_collection_bluesky_artist.bsky.social'];
  assert.equal(base.counts.total,3);
  assert.deepEqual(base.items.map(i=>i.postId),['3myccccccc','3mybbbbbbb','3myaaaaaaa']);
  assert(calls.find(x=>x.includes('filter=posts_with_media')));
  assert(calls.find(x=>x.includes('includePins=false')));
  // Set complete archive to permit delta check.
  base.archive={status:'archive_complete',selection:{images:true,videos:true},collectionId:base.collectionId,failedItems:0,nextItemIndex:3,totalSelected:3};
  base.savedKinds={images:true,videos:true};store['smz_collection_bluesky_artist.bsky.social']=base;
  pageMode='delta';
  response=await send('SMZ_BSKY_START_COLLECTION',{handle:'artist.bsky.social',newOnly:true});
  assert(response.ok,response.error);
  await wait(()=>store['smz_collection_bluesky_artist.bsky.social']?.status==='complete' && store['smz_collection_bluesky_artist.bsky.social'].deltaMode);
  const delta=store['smz_collection_bluesky_artist.bsky.social'];
  assert.equal(delta.counts.total,1);
  assert.equal(delta.deltaVerified,true);
  assert.equal(delta.newestPostId,'3myddddddd');
  assert.equal(store['smz_previous_collection_bluesky_artist.bsky.social'].counts.total,3);
  response=await send('SMZ_BSKY_CANCEL_DELTA',{handle:'artist.bsky.social'});
  assert(response.ok,response.error);
  assert.equal(store['smz_collection_bluesky_artist.bsky.social'].counts.total,3);
  const exported=await new Promise(resolve=>receiver({type:'SMZ_BACKUP_EXPORT'},{url:'chrome-extension://mock/options/options.html'},resolve));assert(exported.ok,exported.error);
  assert.equal(exported.data.accounts.length,1);
  assert.equal(exported.data.accounts[0].current.platform,'bluesky');
  assert.doesNotMatch(JSON.stringify(exported.data),/accessToken|password|cookie/i);
  // No additions should restore previous collection after verified boundary.
  pageMode='zero';
  const original=store['smz_collection_bluesky_artist.bsky.social'];
  original.newestPostId='3myddddddd';original.archive={...original.archive,status:'archive_complete'};
  store['smz_collection_bluesky_artist.bsky.social']=original;
  response=await send('SMZ_BSKY_START_COLLECTION',{handle:'artist.bsky.social',newOnly:true});
  assert(response.ok,response.error);
  await wait(()=>store['smz_collection_bluesky_artist.bsky.social']?.lastNewCheckResult===0);
  assert.equal(store['smz_collection_bluesky_artist.bsky.social'].counts.total,3);
  console.log('PASS Bluesky background: public profile/PDS, 100-post cursor, 3 media collection, verified delta, rollback, zero-new restore');
  // Real API 429 response is handled conservatively, without auto-retry.
  pageMode='429';
  response=await send('SMZ_BSKY_START_COLLECTION',{handle:'artist.bsky.social',restart:true});
  assert(response.ok,response.error);
  await wait(()=>store['smz_collection_bluesky_artist.bsky.social']?.pauseReason==='rate_limit');
  const limited=store['smz_collection_bluesky_artist.bsky.social'];
  assert.equal(limited.status,'paused');
  assert(limited.resumeAt-Date.now()>14*60*1000,'429 must wait >=15 minutes');
  await wait(()=>toolbarBadge==='待');
  response=await send('SMZ_BSKY_START_COLLECTION',{handle:'artist.bsky.social'});
  assert.equal(response.ok,false,'API limit cannot be bypassed through manual resume');
  limited.resumeAt=Date.now()-1;
  store['smz_collection_bluesky_artist.bsky.social']=limited;
  pageMode='first';
  response=await send('SMZ_BSKY_START_COLLECTION',{handle:'artist.bsky.social'});
  assert.equal(response.ok,true,response.error);
  await wait(()=>store['smz_collection_bluesky_artist.bsky.social']?.status==='complete');
  assert.equal(store['smz_collection_bluesky_artist.bsky.social'].counts.total,3);
  console.log('PASS Bluesky 429: yellow wait badge, >=15-min pause, no premature retry, explicit successful resume');
  console.log('PASS Bluesky backup: full JSON export, PDS original URL allowlist, no auth information');
}
(async()=>{moduleTest();await harness();})().catch(e=>{console.error(e);process.exitCode=1});
