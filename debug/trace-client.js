(() => {
  const core=globalThis.SMZDirectoryTraceCore;
  if(!core)return;
  const id=()=>globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let contextId=id(),contextStartedAt=Date.now();let seq=0,scope={};
  const context=String(globalThis.location?.pathname||'background').split('/').filter(Boolean).pop()||'background';
  const seen=new Map();
  function emit(event,fields={}){
    try{
      const record={event,at:Date.now(),context,contextId,contextStartedAt,seq:++seq,fields:core.fields({...scope,...fields})};
      if(globalThis.SMZDirectoryTraceStore)void SMZDirectoryTraceStore.append(record,'background');
      else {
        const sent=chrome.runtime.sendMessage({type:'SMZ_TRACE_EVENT',record});
        sent?.catch?.(()=>{});
      }
    }catch{}
  }
  function changed(event,key,fields){
    const signature=JSON.stringify(core.fields(fields));
    const token=event+':'+key;
    if(seen.get(token)===signature)return;
    seen.set(token,signature);if(seen.size>200)seen.delete(seen.keys().next().value);
    emit(event,fields);
  }
  function failure(event,error,fields={}){emit(event,{...fields,errorName:error?.name||'Error',errorMessage:String(error?.message||error)});}
  globalThis.SMZDirectoryTrace={emit,changed,failure,id,snapshot:core.snapshot,
    setScope:fields=>{scope=core.fields(fields||{});},
    renewContext:()=>{contextId=id();contextStartedAt=Date.now();seq=0;scope={};seen.clear();}};
  emit('context.started',{version:chrome.runtime.getManifest?.().version||'unknown',
    tabVisible:typeof document!=='undefined'?document.visibilityState==='visible':false});
})();
