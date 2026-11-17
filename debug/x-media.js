(() => {
  const validId = value => typeof value === 'string' && /^\d{1,24}$/.test(value);
  const countFields = ['receivedCount','firstMediaCount','extractedCount','imageCount','videoCount','ignoredCount'];
  function normalize(raw) {
    if (!raw || typeof raw !== 'object' || !['extracted','duplicate_post','alternate_shape'].includes(raw.phase)) return null;
    if (!validId(raw.postId) && !(raw.phase === 'alternate_shape' && raw.postId === null)) return null;
    const operations=['UserMedia','UserTweets','TweetDetail','TweetResultByRestId','SearchTimeline','Other'];
    const result = {postId:raw.postId,phase:raw.phase,operation:operations.includes(raw.operation)?raw.operation:'Other'};
    for (const field of countFields) {
      const value = raw[field];
      if (!Number.isSafeInteger(value) || value < 0 || value > 1000) return null;
      result[field] = value;
    }
    if (result.extractedCount !== result.imageCount + result.videoCount ||
        result.receivedCount !== result.extractedCount + result.ignoredCount ||
        (result.phase !== 'extracted' && result.extractedCount !== 0)) return null;
    if (result.phase === 'alternate_shape') {
      if (!['mediaDetails','media_details'].includes(raw.reason)) return null;
      result.reason = raw.reason;
    }
    return result;
  }
  function summarize(state, wanted = new Set()) {
    if (state?.platform !== 'x') return null;
    const items = Array.isArray(state.items) ? state.items : [];
    const counts = new Map();
    for (const item of items) if (validId(item?.postId)) counts.set(item.postId,(counts.get(item.postId)||0)+1);
    const rows = new Map();let matchingPosts=0;
    const candidates=[...counts.keys()].filter(id=>wanted.has(id)).concat([...counts.keys()].filter(id=>counts.get(id)>4&&!wanted.has(id)));
    for (const postId of candidates) {
      matchingPosts++;
      if (rows.size >= 100) continue;
      rows.set(postId,{postId,collectedCount:0,imageCount:0,videoCount:0,indices:new Set(),savedIndices:new Set(),
        expectedCount:typeof wanted.get === 'function' ? wanted.get(postId) ?? null : null});
    }
    const saved = Array.isArray(state.savedItemKeys) ? new Set(state.savedItemKeys) : null;
    for (const item of items) {
      const row=rows.get(item?.postId);if(!row)continue;
      row.collectedCount++;if(item.type==='image')row.imageCount++;if(item.type==='video')row.videoCount++;
      if (Number.isSafeInteger(item.mediaIndex) && item.mediaIndex>=1 && item.mediaIndex<=200) {
        row.indices.add(item.mediaIndex);
        if(saved?.has(`${row.postId}_${item.mediaIndex}`))row.savedIndices.add(item.mediaIndex);
      }
    }
    const list=set=>[...set].sort((a,b)=>a-b).join(',');
    return {account:String(state.handle||'').slice(0,50),collectionId:String(state.collectionId||'').slice(0,100),
      matchingPosts,postsTruncated:matchingPosts>100,posts:[...rows.values()].map(row=>({
        postId:row.postId,expectedCount:row.expectedCount,collectedCount:row.collectedCount,imageCount:row.imageCount,videoCount:row.videoCount,
        mediaIndices:list(row.indices),savedCount:saved?row.savedIndices.size:null,savedMediaIndices:saved?list(row.savedIndices):null
      }))};
  }
  function persisted(state,incoming,added) {
    const counts=new Map();
    for(const item of incoming)if(validId(item?.postId))counts.set(item.postId,(counts.get(item.postId)||0)+1);
    const wanted=new Map([...counts].filter(([,count])=>count>4));if(!wanted.size)return [];
    const addedCounts=new Map();for(const item of added)addedCounts.set(item.postId,(addedCounts.get(item.postId)||0)+1);
    const relevant={...state,items:state.items.filter(item=>wanted.has(item?.postId))};
    return summarize(relevant,wanted).posts.map(row=>({...row,receivedCount:wanted.get(row.postId),addedCount:addedCounts.get(row.postId)||0}));
  }
  function normalizeCapture(raw) {
    if(!raw||!['hook_ready','content_ready','request','response'].includes(raw.phase))return null;
    const result={phase:raw.phase};
    if(typeof raw.version==='string'&&/^\d+\.\d+\.\d+$/.test(raw.version)&&raw.version.length<20)result.version=raw.version;
    if(['UserMedia','UserTweets','TweetDetail','TweetResultByRestId','SearchTimeline','Other'].includes(raw.operation))result.operation=raw.operation;
    if(['parsed','parse_error','http_error','network_error'].includes(raw.reason))result.reason=raw.reason;
    for(const key of ['objectsSeen','tweetCandidates','noLegacyCount','noMediaCount','authorRejectedCount','duplicateCount','extractedCount','targetPostCount','targetAssetCount','httpStatus']) {
      if(raw[key]!==undefined){if(!Number.isSafeInteger(raw[key])||raw[key]<0||raw[key]>200000)return null;result[key]=raw[key];}
    }
    for(const [key,allowed] of [['targetPostIds',['2121977622796353698','2121951663368159350']],['targetAssetIds',['HXLHJ4JaQAA4Meo','HXLHLWRaAAAhEEY','HXLHNUQbkAAh-Pu','HXLHPJ-aYAAggMZ','HXLHRVbbUAAwYC5','HXLHTJebQAAou5D','HXLHU8ZaAAAxz5w','HXLHWs4aMAAq8iF']]]) {
      if(typeof raw[key]==='string')result[key]=raw[key].split(',').filter(id=>allowed.includes(id)).slice(0,allowed.length).join(',');
    }
    if(typeof raw.shapeKeys==='string'&&/^[A-Za-z0-9_,;]*$/.test(raw.shapeKeys))result.shapeKeys=raw.shapeKeys.slice(0,500);
    if(typeof raw.targetReasons==='string')result.targetReasons=raw.targetReasons.split(',').filter(v=>['no_legacy','no_media','retweet','author_mismatch','missing_author','duplicate_post'].includes(v)).slice(0,6).join(',');
    return result;
  }
  globalThis.SMZXMediaDebug={normalize,summarize,persisted,normalizeCapture};
})();
