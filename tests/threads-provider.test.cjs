'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');
const clone = o => o === undefined ? undefined : JSON.parse(JSON.stringify(o));
const media = 'https://scontent.cdninstagram.com/v/t51.2885-15/abcd.jpg?oh=SIGNED&oe=20261009';
const vid = 'https://scontent.fbcdn.net/v/t50.2886-16/xyz.mp4?oh=SIGNED';
const A = '18011111111111111', B='18022222222222222', C='18033333333333333', D='18044444444444444';
const mockPost = (id,type='IMAGE',time='2026-09-26T12:34:00+0000') => ({id,media_type:type,media_url:media,timestamp:time});
function providerTest(){
  const c=vm.createContext({URL,console,fetch:async()=>{throw Error('unexpected provider fetch')}});
  vm.runInContext(read('providers/threads/api.js'),c);
  const t=c.SMZThreads;
  assert.equal(t.validHandle('demo.user'),true);assert.equal(t.validHandle('a..b'),false);
  assert.equal(t.mediaUrl(media),media);assert.equal(t.mediaUrl('https://example.com/steal'),null);
  assert.equal(t.mediaUrl(media+'&access_token=SECRET'),null);
  assert.equal(t.mediaUrl('http://scontent.fbcdn.net/a.jpg'),null);
  const image=t.extract(mockPost(A),'FAKE');
  // async extraction always resolves through a promise.
  return Promise.resolve(image).then(async p=>{
    assert.equal(p.items[0].key,A+'_1');assert.equal(p.items[0].type,'image');
    const carousel={id:B,media_type:'CAROUSEL_ALBUM',timestamp:'2026-09-26T00:00:00+0000',children:{data:[{id:C},{id:D}]}};
    const calls=[];
    const fetcher=async(url,opts)=>{
      calls.push({url,opts});
      const id=new URL(url).pathname.split('/').at(-1);
      return {ok:true,json:async()=>({id,media_type:id===C?'IMAGE':'VIDEO',media_url:id===C?media:vid}),headers:{get:()=>null}};
    };
    const album=await t.extract(carousel,'FAKE',fetcher);
    assert.equal(album.items.length,2);assert.equal(album.items[1].type,'video');
    assert.deepEqual(Array.from(album.items,x=>x.key),[B+'_1',B+'_2']);
    assert.equal(calls[0].opts.headers.Authorization,'Bearer FAKE');
    assert.equal(await t.extract({id:A,media_type:'REPOST_FACADE'},'FAKE'),null);
    const paged=await t.page({handle:'demo.user',own:false},null,'FAKE',async(u,opts)=>({ok:true,json:async()=>({data:[mockPost(A)],paging:{cursors:{after:'CURSOR'},next:'https://graph.threads.net/v1.0/profile_posts?after=CURSOR&access_token=LEAK_SECRET'}})}));
    assert.equal(paged.cursor,'CURSOR');assert.doesNotMatch(JSON.stringify(paged),/LEAK_SECRET|access_token/);
    const own=await t.page({handle:'demo.user',own:true},null,'FAKE',async(u)=>{assert.match(u,/\/me\/threads/);return {ok:true,json:async()=>({data:[]})}});
    assert.equal(own.cursor,null);
    const refreshed=await t.refresh('FAKE',async(u,opts)=>{const url=new URL(u);assert.equal(url.pathname,'/refresh_access_token');assert.equal(url.searchParams.get('grant_type'),'th_refresh_token');assert.equal(url.searchParams.get('access_token'),'FAKE');assert.equal(opts.headers,undefined);return {ok:true,json:async()=>({access_token:'NEXT',expires_in:5184000}),headers:{get:()=>null}}});
    assert.equal(refreshed.access_token,'NEXT');
    await assert.rejects(()=>t.page({handle:'demo.user',own:false},null,'FAKE',async()=>({ok:false,status:429,headers:{get:()=> '120'}})),e=>e.status===429&&e.retryAfter===120);
    console.log('PASS Threads provider: signed CDN, carousel child lookup, repost ignore, private Bearer auth, paging.next secret isolation, 429');
  });
}
async function backgroundTest(){
  const store={};let receiver;let alarm;const calls=[];let mode='collect';let pageCount=0;
  const chrome={runtime:{getURL:p=>'chrome-extension://mock/'+p,onMessage:{addListener:f=>receiver=f},sendMessage:async()=>({ok:true})},
    storage:{local:{async get(k){if(k===null)return clone(store);if(typeof k==='string')return {[k]:clone(store[k])};const o={};for(const name of k)o[name]=clone(store[name]);return o},async set(o){Object.assign(store,clone(o));},async remove(k){for(const a of [].concat(k))delete store[a]},async clear(){for(const k of Object.keys(store))delete store[k]}}},
    alarms:{onAlarm:{addListener:f=>alarm=f},async create(){},async clear(){return true}},
    permissions:{async contains(){return true}},tabs:{async query(){return []},onActivated:{addListener(){}},onUpdated:{addListener(){}}},windows:{onFocusChanged:{addListener(){}}},offscreen:{async hasDocument(){return false}},
    downloads:{onDeterminingFilename:{addListener(){}}},action:{async setIcon(){},async setBadgeText(){},async setBadgeBackgroundColor(){},async setBadgeTextColor(){},async setTitle(){}}};
  const fetch=async (u,opts)=>{
    const url=new URL(u);const header=opts?.headers?.Authorization;
    calls.push({url:url.toString().replace(/access_token=[^&]+/,'access_token=REDACTED'),header});
    const response=body=>({ok:true,status:200,headers:{get:()=>null},json:async()=>clone(body)});
    if(url.pathname.endsWith('/refresh_access_token')) { assert.equal(url.pathname,'/refresh_access_token','refresh endpoint must not use /v1.0'); assert.match(url.searchParams.get('access_token')||'',/^LONG_TOKEN/); return response({access_token:'LONG_TOKEN_2',expires_in:5184000}); }
    if(!/^Bearer LONG_TOKEN/.test(header||''))throw Error('Missing Bearer');
    if(url.pathname.endsWith('/me'))return response({id:'17890123456789012',username:'demo.user'});
    if(url.pathname.endsWith('/profile_lookup'))return response({username:url.searchParams.get('username')});
    if(url.pathname.endsWith('/profile_posts')||url.pathname.endsWith('/me/threads')){
      if(mode==='429')return {ok:false,status:429,headers:{get:k=>k==='retry-after'?'90':null}};
      pageCount++;
      if(url.searchParams.has('after'))return response({data:[mockPost(B,'VIDEO','2026-09-25T00:00:00+0000')],paging:{}});
      return response({data:[mockPost(A),{id:C,media_type:'TEXT_POST',timestamp:'2026-09-25T00:00:00+0000'}],paging:{cursors:{after:'NEXT_CURSOR'},next:'https://graph.threads.net/v1.0/profile_posts?after=NEXT_CURSOR&access_token=EXPOSED_SECRET'}});
    }
    throw Error('unexpected fetch '+url);
  };
  const c=vm.createContext({URL,console:{...console,error(){}},fetch,chrome,setTimeout,clearTimeout,AbortController});
  vm.runInContext(read('backup/schema.js')+'\n'+read('providers/threads/api.js')+'\n'+read('background.js'),c);
  const send=(type,data={},options=false)=>new Promise(resolve=>receiver({type,...data},{url:'chrome-extension://mock/'+(options?'options/options.html':'popup/popup.html')},resolve));
  const wait=async predicate=>{for(let i=0;i<250;i++){if(predicate())return;await new Promise(r=>setTimeout(r,20))}throw Error('timeout')};
  let r=await send('SMZ_THREADS_CONNECT',{token:'LONG_TOKEN',autoRenew:true},true);assert(r.ok,r.error);assert.equal(r.auth.username,'demo.user');assert(!r.auth.token);
  r=await send('SMZ_THREADS_AUTH_STATUS');assert.equal(r.auth.connected,true);assert.doesNotMatch(JSON.stringify(r),/LONG_TOKEN/);
  r=await send('SMZ_THREADS_GET_PROFILE',{actor:'artist.demo'});assert(r.ok,r.error);assert.equal(r.profile.own,false);
  r=await send('SMZ_THREADS_START_COLLECTION',{handle:'artist.demo'});assert(r.ok,r.error);
  await wait(()=>store['smz_collection_threads_artist.demo']?.status==='complete');
  const base=store['smz_collection_threads_artist.demo'];
  assert.equal(base.counts.total,2);assert.equal(base.counts.images,1);assert.equal(base.counts.videos,1);
  assert.equal(base.resumeCursor,null);assert.equal(base.items[0].postId,A);
  assert.doesNotMatch(JSON.stringify(base),/LONG_TOKEN|EXPOSED_SECRET|access_token/);
  r=await send('SMZ_BACKUP_EXPORT',{platform:'threads'},true);
  assert(r.ok,r.error);assert.equal(r.data.partial,true);assert.equal(r.data.accounts.length,1);
  assert.doesNotMatch(JSON.stringify(r),/LONG_TOKEN|EXPOSED_SECRET|access_token/);
  const partial=clone(r.data);
  // An imported/pasted long-lived token may already be old. Revalidate its
  // real expiry promptly instead of trusting the new 60-day local estimate.
  store.smz_threads_auth_v1.issuedAt=Date.now()-2*24*60*60*1000;
  assert.equal(typeof alarm,'function');await alarm({name:'smz_threads_token_refresh'});
  assert.equal(store.smz_threads_auth_v1.token,'LONG_TOKEN_2');
  assert.equal(store.smz_threads_auth_v1.expiryEstimated,false);
  let refreshed=await send('SMZ_THREADS_REFRESH_AUTH',{},true);assert(refreshed.ok,refreshed.error);assert.equal(store.smz_threads_auth_v1.token,'LONG_TOKEN_2');
  assert(!refreshed.auth.token);
  // same auth token mock expects a prefix, so move back to the first test token.
  store.smz_threads_auth_v1.token='LONG_TOKEN';mode='429';
  r=await send('SMZ_THREADS_START_COLLECTION',{handle:'artist.demo',restart:true});assert(r.ok,r.error);
  await wait(()=>store['smz_collection_threads_artist.demo']?.pauseReason==='rate_limit');
  assert(store['smz_collection_threads_artist.demo'].resumeAt > Date.now()+14*60*1000);
  r=await send('SMZ_THREADS_START_COLLECTION',{handle:'artist.demo'});assert.equal(r.ok,false,'rate limit must not be bypassed');
  store['smz_collection_threads_artist.demo'].resumeAt=Date.now()-1;
  mode='collect';
  r=await send('SMZ_THREADS_START_COLLECTION',{handle:'artist.demo'});assert(r.ok,r.error);
  await wait(()=>store['smz_collection_threads_artist.demo']?.status==='complete');
  r=await send('SMZ_BACKUP_DELETE_SELECTED',{accounts:['threads:artist.demo']},true);assert(r.ok,r.error);assert.equal(r.deleted,1);assert.equal(store['smz_collection_threads_artist.demo'],undefined);
  assert.equal(store.smz_threads_auth_v1.username,'demo.user','account deletion must not delete auth');
  r=await send('SMZ_BACKUP_IMPORT',{data:partial,mode:'replace-all'},true);assert.equal(r.ok,false,'partial backup must never overwrite all data');
  r=await send('SMZ_BACKUP_IMPORT',{data:partial,mode:'merge',selectedAccounts:['threads:artist.demo']},true);assert(r.ok,r.error);assert.equal(r.imported,1);
  assert.equal(store['smz_collection_threads_artist.demo'].counts.total,2);
  console.log('PASS Threads background: local auth and manual refresh, two-page image/video, leak-free partial backup, 429 resume, selective deletion');
}
(async()=>{await providerTest();await backgroundTest()})().catch(e=>{console.error(e);process.exitCode=1});
