(() => {
  const KEY='smz_directory_trace_v1';
  let queue=Promise.resolve(),generation=0,suspended=false,cutoff=0;
  const storage=chrome.storage.local;
  function enqueue(fn){const task=queue.catch(()=>{}).then(fn);queue=task.catch(()=>{});return task;}
  async function load(){
    const data=(await storage.get(KEY))[KEY];
    return {since:Number(data?.since||0),resetSince:Number(data?.resetSince||0),entries:Array.isArray(data?.entries)?data.entries.slice(-400):[]};
  }
  function append(raw,source){
    const record=SMZDirectoryTraceCore.record(raw,source);
    if(!record||suspended||record.at<=cutoff)return Promise.resolve(false);
    const ticket=generation;
    return enqueue(async()=>{
      if(suspended||ticket!==generation)return false;
      const data=await load();
      if(suspended||ticket!==generation||record.at<=Math.max(cutoff,data.since)||record.contextStartedAt<data.resetSince)return false;
      data.entries.push(record);data.entries=data.entries.slice(-400);
      await storage.set({[KEY]:data});
      return true;
    }).catch(()=>false);
  }
  async function get(){await queue;try{return await load();}catch{return {since:cutoff,entries:[],unavailable:true};}}
  function clear(){
    generation++;cutoff=Date.now();
    return enqueue(async()=>{const old=await load();await storage.set({[KEY]:{since:cutoff,resetSince:old.resetSince,entries:[]}});})
      .then(()=>({ok:true})).catch(()=>({ok:false,error:'診断ログを消去できませんでした。保存領域への書き込みに失敗しました。'}));
  }
  async function suspendForReset(){suspended=true;generation++;cutoff=Date.now();await queue;}
  async function resumeAfterReset(cleared){
    cutoff=Date.now();
    await enqueue(async()=>{
      const old=cleared?{entries:[],resetSince:cutoff}:await load();
      await storage.set({[KEY]:{since:cutoff,resetSince:old.resetSince,entries:old.entries}});
    }).catch(()=>{});
    suspended=false;
  }
  globalThis.SMZDirectoryTraceStore={append,get,clear,suspendForReset,resumeAfterReset};
})();
