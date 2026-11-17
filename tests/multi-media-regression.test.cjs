'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', pds = 'https://morel.us-east.host.bsky.network';
const cid = i => 'bafkrei' + 'a'.repeat(48) + String(i).padStart(2, '0');
function bskyEntry(embed) {
  return {post:{author:{did}, uri:`at://${did}/app.bsky.feed.post/3n2asatc3hc2z`, record:{embed}}};
}
function bsky() { const c=vm.createContext({URL}); vm.runInContext(read('providers/bluesky/api.js'),c); return c.SMZBluesky; }
const gallery = count => ({$type:'app.bsky.embed.gallery',items:Array.from({length:count},(_,i)=>({
  $type:'app.bsky.embed.gallery#image', image:{ref:{$link:cid(i)},mimeType:'image/jpeg'}
}))});
test('Bluesky gallery retains all 10 and 20 original images in record order',()=>{
  const api=bsky();
  for(const count of [10,20]) {
    const result=api.extract(bskyEntry(gallery(count)),did,pds);
    assert.equal(result.items.length,count);
    assert.equal(result.items.at(-1).mediaIndex,count);
    assert.equal(new URL(result.items.at(-1).url).searchParams.get('cid'),cid(count-1));
  }
});
test('Bluesky quoted gallery only collects the outer post attachments; unknown items cannot silently complete',()=>{
  const api=bsky();
  const wrapped={$type:'app.bsky.embed.recordWithMedia',record:{$type:'app.bsky.embed.record',record:{uri:'at://quote'}},media:gallery(10)};
  assert.equal(api.extract(bskyEntry(wrapped),did,pds).items.length,10);
  const bad=gallery(10);bad.items[6]={$type:'app.bsky.embed.gallery#unknown',url:'https://private.invalid/'};
  assert.throws(()=>api.extract(bskyEntry(bad),did,pds),/ギャラリー/);
});
function tweet(count, postId='2121034947280753090') {
  return {rest_id:postId,core:{user_results:{result:{legacy:{screen_name:'demo'}}}},legacy:{id_str:postId,
    extended_entities:{media:Array.from({length:count},(_,i)=>({id_str:String(100+i),type:'photo',media_url_https:`https://pbs.twimg.com/media/sample_${i}.jpg`}))}}};
}
function hook({legacyMarker=false}={}) {
  let data; const events=[],listeners=[];
  const w={addEventListener:(name,fn)=>listeners.push(fn),postMessage:m=>events.push(m),
    fetch:async()=>({ok:true,status:200,clone:()=>({ok:true,status:200,json:async()=>data})})};
  const storage=new Map([['smz_x_collect_handle','demo'],['smz_x_collect_id','job-1']]);
  if(legacyMarker)storage.delete('smz_x_collect_id');
  vm.runInNewContext(read('providers/x/main-hook.js'),{window:w,URL,console,sessionStorage:{getItem:k=>storage.get(k)||null}});
  const control=(enabled, extra={})=>listeners.forEach(fn=>fn({source:w,data:{source:'simple-marugoto-zip',type:'SMZ_X_CONTROL',enabled,handle:'demo',collectionId:'job-1',...extra}}));
  return {events,control,ack(batch){listeners.forEach(fn=>fn({source:w,data:{source:'simple-marugoto-zip',type:'SMZ_X_BATCH_ACK',batchId:batch.batchId,collectionId:batch.collectionId}}));},
    async receive(t){data={data:{tweet_results:{result:t}}};await w.fetch('https://x.com/i/api/graphql/test/UserMedia');await settle();},
    async defer(t){let resolve;data=new Promise(r=>resolve=r);await w.fetch('https://x.com/i/api/graphql/test/UserMedia');
      return ()=>resolve({data:{tweet_results:{result:t}}});}};
}
test('X adds images 5..20 from an expanded response without resending images 1..4',async()=>{
  const h=hook();h.control(true);await h.receive(tweet(4));await h.receive(tweet(20));
  const batches=h.events.filter(e=>e.type==='SMZ_X_MEDIA_BATCH');
  assert.equal(batches.length,2);assert.equal(batches[1].items.length,16);
  assert.equal(batches[1].items[0].mediaIndex,5);
  assert.equal(new Set(batches.flatMap(b=>b.items.map(i=>i.key))).size,20);
});
test('X retains initial data through confirmation and clears it only after an accepted ACK',async()=>{
  const h=hook();await h.receive(tweet(8));
  h.control(true,{deliveryReady:false});
  h.control(false,{preservePending:true});
  h.control(true);
  let batches=h.events.filter(e=>e.type==='SMZ_X_MEDIA_BATCH');assert(batches.length>0);
  const batch=batches.at(-1);assert.equal(batch.items.length,8);assert(batch.batchId);
  let before=batches.length;h.control(true);
  batches=h.events.filter(e=>e.type==='SMZ_X_MEDIA_BATCH');assert.equal(batches.length,before+1,'unacknowledged data must be replayable');
  h.ack({...batch,collectionId:'stale-job'});h.control(true);
  assert.equal(h.events.filter(e=>e.type==='SMZ_X_MEDIA_BATCH').length,before+2,'stale ACK cannot erase pending data');
  h.ack(batch);before=h.events.length;h.control(true);
  assert(!h.events.slice(before).some(e=>e.type==='SMZ_X_MEDIA_BATCH'),'committed batch must not replay');
});
test('X never replays one collection into another collection',async()=>{
  const h=hook();await h.receive(tweet(8));const before=h.events.length;
  h.control(true,{collectionId:'job-2'});
  assert(!h.events.slice(before).some(e=>e.type==='SMZ_X_MEDIA_BATCH'));
  await h.receive(tweet(8));const batch=h.events.filter(e=>e.type==='SMZ_X_MEDIA_BATCH').at(-1);
  assert.equal(batch.collectionId,'job-2');assert.equal(batch.items.length,8);
});
test('X discards an old request whose JSON finishes after switching collection jobs',async()=>{
  const h=hook();h.control(true);const finish=await h.defer(tweet(8));
  h.control(true,{collectionId:'job-2'});finish();await settle();
  assert(!h.events.some(e=>e.type==='SMZ_X_MEDIA_BATCH'));
});
test('X adopts an old handle-only marker into the confirmed collection identity so its ACK can clear the batch',async()=>{
  const h=hook({legacyMarker:true});await h.receive(tweet(8));h.control(true);
  const batch=h.events.find(e=>e.type==='SMZ_X_MEDIA_BATCH');assert.equal(batch.collectionId,'job-1');h.ack(batch);
  const before=h.events.length;h.control(true);assert(!h.events.slice(before).some(e=>e.type==='SMZ_X_MEDIA_BATCH'));
});
test('X MAIN/content bridge preserves the first page across the real confirmation/resume sequence',async()=>{
  const listeners=[],events=[];let runtimeListener, stateStatus='collecting', writes=0;
  const storage=new Map([['smz_x_collect_handle','demo'],['smz_x_collect_id','job-1']]);
  const w={addEventListener:(n,f)=>listeners.push(f),postMessage:m=>{events.push(m);queueMicrotask(()=>listeners.forEach(f=>Promise.resolve(f({source:w,data:m})).catch(()=>{})));},
    fetch:async()=>({ok:true,status:200,clone:()=>({ok:true,status:200,json:async()=>({result:tweet(8)})})}),scrollTo(){},scrollY:0,innerHeight:800};
  const chrome={runtime:{onMessage:{addListener:f=>runtimeListener=f},sendMessage:async m=>{
    if(m.type==='SMZ_GET_COLLECTION')return {state:{collectionId:'job-1',status:stateStatus,collectionMode:'manual'},isCollectionTab:true};
    if(m.type==='SMZ_COLLECTION_MEDIA_COUNT'){
      stateStatus='awaiting_confirmation';await w.fetch('https://x.com/i/api/graphql/test/UserMedia');await settle();
      return {ok:true,needConfirmation:true};
    }
    if(m.type==='SMZ_ADD_MEDIA'){if(stateStatus!=='collecting')return {ok:true,accepted:false,addedCount:0};writes+=m.items.length;return {ok:true,accepted:true,addedCount:m.items.length};}
    return {ok:true};
  }},storage:{local:{get:async()=>({})}}};
  const common={window:w,URL,console,chrome,sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    document:{body:{innerText:'2000件の画像と動画'},documentElement:{scrollHeight:900},getElementById:()=>null},
    location:{hostname:'x.com',pathname:'/demo/media',search:'',reload(){}},setTimeout:()=>1,clearTimeout(){}};
  vm.runInNewContext(read('providers/x/main-hook.js'),common);
  vm.runInNewContext(read('providers/x/content.js'),common);
  for(let i=0;i<12;i++)await settle();assert.equal(stateStatus,'awaiting_confirmation');assert.equal(writes,0);
  stateStatus='collecting';
  const resumed=await new Promise(resolve=>runtimeListener({type:'SMZ_RESUME_COLLECTION',handle:'demo',collectionId:'job-1',collectionMode:'manual',skipLargeWarning:true},{},resolve));
  assert.equal(resumed.ok,true);for(let i=0;i<12;i++)await settle();
  assert.equal(writes,8);assert(events.some(e=>e.type==='SMZ_X_BATCH_ACK'));
  w.postMessage({source:'simple-marugoto-zip',type:'SMZ_X_CONTROL',enabled:true,handle:'demo',collectionId:'job-1'});
  await settle();assert.equal(writes,8,'ACK prevents another registration after readiness repeats');
});
test('Threads follows carousel child cursors using a constructed API URL without copying a token-bearing next URL',async()=>{
  const c=vm.createContext({URL});vm.runInContext(read('providers/threads/api.js'),c);
  const child=i=>({id:String(18000000000000000n+BigInt(i)),media_type:'IMAGE',media_url:`https://scontent.cdninstagram.com/image_${i}.jpg`});
  const calls=[];
  const result=await c.SMZThreads.extract({id:'18011111111111111',media_type:'CAROUSEL_ALBUM',children:{data:Array.from({length:4},(_,i)=>child(i)),
    paging:{next:'https://graph.threads.net/v1.0/18011111111111111/children?after=NEXT&access_token=DO_NOT_COPY',cursors:{after:'NEXT'}}}},'TEST_TOKEN',async(url,options)=>{
      calls.push({url,options});return {ok:true,json:async()=>({data:Array.from({length:6},(_,i)=>child(i+4))})};
    });
  assert.equal(result.items.length,10);assert.equal(calls.length,1);
  assert.equal(new URL(calls[0].url).pathname,'/v1.0/18011111111111111/children');
  assert.equal(new URL(calls[0].url).searchParams.get('after'),'NEXT');
  assert(!calls[0].url.includes('access_token'));assert(!calls[0].url.includes('DO_NOT_COPY'));
  assert.equal(calls[0].options.headers.Authorization,'Bearer TEST_TOKEN');
});
test('Threads rejects untrusted child pagination and repeated cursors instead of returning a partial successful album',async()=>{
  const c=vm.createContext({URL});vm.runInContext(read('providers/threads/api.js'),c);
  const child={id:'18000000000000001',media_type:'IMAGE',media_url:'https://scontent.cdninstagram.com/image.jpg'};
  let calls=0;
  await assert.rejects(c.SMZThreads.extract({id:'18011111111111111',media_type:'CAROUSEL_ALBUM',children:{data:[child],paging:{next:'https://attacker.invalid/?after=NEXT'}}},'TEST_TOKEN',async()=>{calls++;}),/ページ位置/);
  assert.equal(calls,0);
  const paging={next:'https://graph.threads.net/children?after=NEXT',cursors:{after:'NEXT'}};
  await assert.rejects(c.SMZThreads.extract({id:'18011111111111111',media_type:'CAROUSEL_ALBUM',children:{data:[child],paging}},'TEST_TOKEN',async()=>{
    calls++;return jsonResponse({data:[{...child,id:'18000000000000002'}],paging});
  }),/繰り返/);
  assert.equal(calls,1);
});
function background(initial, fetcher=async()=>{throw new Error('Unexpected network request');}) {
  const store=structuredClone(initial); let receiver;const tabMessages=[];
  const chrome={runtime:{getURL:p=>'chrome-extension://mock/'+p,onMessage:{addListener:f=>receiver=f},sendMessage:async()=>({ok:true,active:false})},
    storage:{local:{get:async k=>k===null?structuredClone(store):typeof k==='string'?{[k]:structuredClone(store[k])}:Object.fromEntries(k.map(key=>[key,structuredClone(store[key])])),
      set:async o=>Object.assign(store,structuredClone(o)),remove:async ks=>[].concat(ks).forEach(k=>delete store[k])}},
    tabs:{get:async id=>({id,url:'https://x.com/demo/media'}),query:async()=>[],sendMessage:async(id,m)=>{tabMessages.push(m);return {ok:true};},onActivated:{addListener(){}},onUpdated:{addListener(){}}},
    scripting:{executeScript:async()=>{}},windows:{onFocusChanged:{addListener(){}}},
    permissions:{contains:async()=>true},
    alarms:{clear:async()=>true,create:async()=>{},onAlarm:{addListener(){}}},downloads:{onDeterminingFilename:{addListener(){}}},
    offscreen:{hasDocument:async()=>true},action:{setIcon:async()=>{},setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setBadgeTextColor:async()=>{},setTitle:async()=>{}}};
  const c=vm.createContext({chrome,URL,console:{...console,error(){}},fetch:fetcher,setTimeout,clearTimeout,AbortController});
  vm.runInContext(read('backup/schema.js')+'\n'+read('providers/bluesky/api.js')+'\n'+read('providers/threads/api.js')+'\n'+read('background.js'),c);
  return {store,tabMessages,c,send:(m,tab=false)=>new Promise(resolve=>receiver(m,tab?{tab:{id:11,url:'https://x.com/demo/media'}}:{url:'chrome-extension://mock/popup/popup.html'},resolve))};
}
function checkpoint(){const items=Array.from({length:4},(_,i)=>({platform:'x',key:`2100_${i+1}`,postId:'2100',mediaIndex:i+1,type:'image',url:`https://pbs.twimg.com/media/a${i}?format=jpg&name=orig`,extension:'jpg'}));
 return {platform:'x',handle:'demo',collectionId:'old-job',collectionMode:'manual',status:'complete',newestPostId:'2100',oldestPostId:'2100',
  counts:{images:4,videos:0,total:4},items,savedItemKeys:items.map(i=>i.key),archive:{status:'archive_complete',selection:{images:true,videos:true},totalSelected:4,nextItemIndex:4,savedZipCount:1,failedItems:0}};}
test('repair scan keeps the previous snapshot and adds only missing media, including below the newest post boundary',async()=>{
  const previous=checkpoint(),h=background({smz_collection_x_demo:previous});await settle();
  let result=await h.send({type:'SMZ_START_COLLECTION',handle:'demo',tabId:11,collectionMode:'manual',rescan:true});
  assert.equal(result.ok,true,result.error);assert.equal(result.state.repairMode,true);
  assert.equal(result.state.counts.total,0);assert.equal(h.store.smz_previous_collection_x_demo.items.length,4);
  assert.equal(h.tabMessages.at(-1).deltaBaselinePostId,null);
  const collectionId=result.state.collectionId;
  const items=[...previous.items,{...previous.items[0],key:'2100_5',mediaIndex:5},{...previous.items[0],postId:'2000',key:'2000_1'}];
  result=await h.send({type:'SMZ_ADD_MEDIA',handle:'demo',collectionId,items,requestUrl:'https://x.com/i/api/graphql/test/UserMedia'},true);
  assert.equal(result.accepted,true);assert.equal(result.addedCount,2);
  assert.deepEqual(h.store.smz_collection_x_demo.items.map(i=>i.key),['2100_5','2000_1']);
  const safe=h.c.SMZBackup.safeCollection(h.store.smz_collection_x_demo);
  assert.equal(safe.repairMode,true);assert.equal(safe.knownMediaKeys.length,4);
  result=await h.send({type:'SMZ_FINISH_MANUAL_COLLECTION',handle:'demo',collectionId,tabId:11});
  assert.equal(result.ok,true,result.error);assert.equal(result.state.deltaVerified,true);
  assert.equal(result.state.newestPostId,'2100','repairing older posts cannot move the next delta boundary backwards');
});
test('X rejected writes do not acknowledge persistence; repairs cannot start while ZIP is running',async()=>{
  const previous=checkpoint(),h=background({smz_collection_x_demo:previous});await settle();
  let result=await h.send({type:'SMZ_ADD_MEDIA',handle:'demo',collectionId:'old-job',items:previous.items},true);
  assert.equal(result.accepted,false);
  h.store.smz_collection_x_demo.archive.status='archiving';
  result=await h.send({type:'SMZ_START_COLLECTION',handle:'demo',tabId:11,rescan:true});
  assert.equal(result.ok,false);assert.equal(h.store.smz_collection_x_demo.collectionId,'old-job');
});
const jsonResponse=value=>({ok:true,status:200,headers:{get:()=>null},json:async()=>structuredClone(value)});
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await settle();}throw Error('collection did not settle');}
function bskyFetch(url){
  const u=new URL(url);
  if(u.pathname.endsWith('getProfile'))return Promise.resolve(jsonResponse({did,handle:'demo.bsky.social'}));
  if(u.hostname==='plc.directory')return Promise.resolve(jsonResponse({service:[{type:'AtprotoPersonalDataServer',serviceEndpoint:pds}]}));
  if(u.pathname.endsWith('getAuthorFeed'))return Promise.resolve(jsonResponse({feed:[bskyEntry(gallery(10))]}));
  throw Error('Unexpected endpoint');
}
function bskyCheckpoint(count=4){
  const items=bsky().extract(bskyEntry(gallery(10)),did,pds).items.slice(0,count);
  return {...checkpoint(),platform:'bluesky',handle:'demo.bsky.social',did,pds,collectionMode:'api',items,
    counts:{images:count,videos:0,total:count},newestPostId:items[0]?.postId||null,savedItemKeys:items.map(i=>i.key),
    archive:count?{status:'archive_complete',selection:{images:true,videos:true},totalSelected:count,nextItemIndex:count,savedZipCount:1}:null};
}
test('Bluesky repair retrieves gallery images 5..10, survives worker restart and can roll back before saving',async()=>{
  const key='smz_collection_bluesky_demo.bsky.social',h=background({[key]:bskyCheckpoint()},bskyFetch);await settle();
  let r=await h.send({type:'SMZ_BSKY_START_COLLECTION',handle:'demo.bsky.social',rescan:true});assert.equal(r.ok,true,r.error);
  await until(()=>h.store[key].status==='complete');
  assert.equal(h.store[key].counts.total,6);assert.equal(h.store[key].items[0].mediaIndex,5);assert.equal(h.store[key].deltaVerified,true);
  const restored=h.c.SMZBackup.safeCollection(h.store[key]);restored.status='collecting';restored.resumeCursor='SECOND';
  const recovered=background({...h.store,[key]:restored},bskyFetch);
  await until(()=>recovered.store[key].status==='complete');assert.equal(recovered.store[key].counts.total,6);
  r=await recovered.send({type:'SMZ_BSKY_CANCEL_DELTA',handle:'demo.bsky.social'});
  assert.equal(r.ok,true,r.error);assert.equal(recovered.store[key].counts.total,4);
});
test('Bluesky can repair a formerly empty completed collection without requiring an impossible zero-file ZIP',async()=>{
  const key='smz_collection_bluesky_demo.bsky.social',h=background({[key]:bskyCheckpoint(0)},bskyFetch);await settle();
  const r=await h.send({type:'SMZ_BSKY_START_COLLECTION',handle:'demo.bsky.social',rescan:true});assert.equal(r.ok,true,r.error);
  await until(()=>h.store[key].status==='complete');assert.equal(h.store[key].counts.total,10);
});
test('Threads repair gathers all child pages below the previous boundary and excludes four previously saved children',async()=>{
  const id='18011111111111111',child=i=>({id:String(18000000000000000n+BigInt(i)),media_type:'IMAGE',media_url:`https://scontent.cdninstagram.com/image_${i}.jpg`});
  const post={id,username:'demo',timestamp:'2026-11-16T00:00:00Z',media_type:'CAROUSEL_ALBUM',children:{data:Array.from({length:4},(_,i)=>child(i)),
    paging:{next:`https://graph.threads.net/v1.0/${id}/children?after=SECOND&access_token=SECRET`,cursors:{after:'SECOND'}}}};
  const initial=checkpoint();initial.platform='threads';initial.ownProfile=true;
  initial.items=initial.items.map((i,n)=>({...i,platform:'threads',postId:id,key:`${id}_${n+1}`,url:child(n).media_url}));initial.savedItemKeys=initial.items.map(i=>i.key);initial.newestPostId=id;
  const key='smz_collection_threads_demo',h=background({[key]:initial,smz_threads_auth_v1:{token:'TEST_TOKEN',username:'demo',userId:'178900',autoRenew:false}},async(url)=>{
    if(new URL(url).pathname.endsWith('/me/threads'))return jsonResponse({data:[post]});
    if(new URL(url).pathname.endsWith('/children'))return jsonResponse({data:Array.from({length:6},(_,i)=>child(i+4))});
    throw Error('Unexpected endpoint');
  });await settle();
  const r=await h.send({type:'SMZ_THREADS_START_COLLECTION',handle:'demo',rescan:true});assert.equal(r.ok,true,r.error);
  await until(()=>h.store[key].status!=='collecting');assert.equal(h.store[key].status,'complete',h.store[key].lastError);
  assert.equal(h.store[key].counts.total,6);assert.equal(h.store[key].items.at(-1).mediaIndex,10);
});
test('two simultaneous repair requests cannot replace each other or overwrite the original snapshot',async()=>{
  const h=background({smz_collection_x_demo:checkpoint()});await settle();
  const results=await Promise.all([1,2].map(()=>h.send({type:'SMZ_START_COLLECTION',handle:'demo',tabId:11,collectionMode:'manual',rescan:true})));
  assert.equal(results.filter(r=>r.ok).length,1);assert.equal(h.store.smz_previous_collection_x_demo.collectionId,'old-job');
});
test('a zero-addition manual repair restores the previous checkpoint while retaining inherited media keys',async()=>{
  const previous=checkpoint(),older={...checkpoint(),items:[{...previous.items[0],key:'2000_1',postId:'2000'}]};
  const h=background({smz_collection_x_demo:previous,smz_previous_collection_x_demo:older});await settle();
  let r=await h.send({type:'SMZ_START_COLLECTION',handle:'demo',tabId:11,collectionMode:'manual',rescan:true});assert.equal(r.ok,true,r.error);
  r=await h.send({type:'SMZ_FINISH_MANUAL_COLLECTION',handle:'demo',tabId:11,collectionId:r.state.collectionId});
  assert.equal(r.ok,true,r.error);assert.equal(r.state.collectionId,'old-job');assert.equal(r.state.counts.total,4);
  assert.equal(r.state.lastCheckWasRepair,true);assert(r.state.knownMediaKeys.includes('2000_1'));
});
