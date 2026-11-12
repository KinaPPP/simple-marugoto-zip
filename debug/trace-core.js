(() => {
  const strings=new Set(['directoryKey','directoryName','preferredKey','preferredName','archiveKey','archiveName',
    'platform','account','collectionId','jobId','traceId','phase','permission','permissionMode','errorName','errorMessage',
    'oldKey','newKey','filename','label','expectedKey','cacheState','status','pauseReason','version','reason','source',
    'referenceName','referenceKind','kind','nameCodePoints']);
  const numbers=new Set(['savedZipCount','nextItemIndex','nextZipNumber','expectedBytes','actualBytes','count','millis','tabId']);
  const flags=new Set(['sameEntry','hadCached','cachedGranted','found','ok','fromCache','tabVisible','focused','namesMatch','suspiciousName']);
  function redact(value,max=500){
    return String(value).replace(/\\(["'])/g,'$1').replace(/\\\//g,'/').replace(/([\"']?(?:access_?token|refresh_?token|token|authorization|set-cookie|cookie|password|secret)[\"']?\s*[:=]\s*)([\"'])(.*?)\2/gi,'$1[REDACTED]')
      .replace(/https?:\/\/[^\s]+/gi,'[URL]')
      .replace(/\b(?:authorization|set-cookie|cookie)\s*[:=][^\r\n]*/gi,'[REDACTED]')
      .replace(/Bearer\s+[^\s]+/gi,'Bearer [REDACTED]')
      .replace(/(?:access_?token|refresh_?token|token|authorization|cookie|password|secret)\s*[:=]\s*[^\s;,]+/gi,'[REDACTED]')
      .slice(0,max);
  }
  function fields(input={}){
    const result={};
    for(const [key,value] of Object.entries(input)){
      if(strings.has(key) && (typeof value==='string'||value===null)) result[key]=value===null?null:redact(value,key==='label'?120:500);
      else if(numbers.has(key)&&typeof value==='number'&&Number.isFinite(value))result[key]=value;
      else if(flags.has(key)&&typeof value==='boolean')result[key]=value;
    }
    return result;
  }
  function snapshot(state){
    const a=state?.archive||{};
    return fields({platform:state?.platform||null,account:state?.handle||null,collectionId:state?.collectionId||null,
      preferredKey:state?.preferredSaveDirectoryKey||null,preferredName:state?.preferredSaveDirectoryName||null,
      archiveKey:a.saveDirectoryKey||null,archiveName:a.saveDirectoryName||null,status:a.status||null,
      pauseReason:a.pauseReason||null,nextItemIndex:Number(a.nextItemIndex||0),savedZipCount:Number(a.savedZipCount||0),
      jobId:a.jobId||null,errorMessage:a.lastError||null});
  }
  function record(input,source){
    if(!input||typeof input.event!=='string'||typeof input.at!=='number'||!Number.isFinite(input.at))return null;
    return {at:input.at,contextStartedAt:Number.isFinite(input.contextStartedAt)?input.contextStartedAt:input.at,receivedAt:Date.now(),event:redact(input.event,100),context:redact(source||input.context||'unknown',60),
      contextId:redact(input.contextId||'unknown',80),seq:Number.isFinite(input.seq)?input.seq:0,fields:fields(input.fields)};
  }
  globalThis.SMZDirectoryTraceCore={fields,snapshot,record,redact};
})();
