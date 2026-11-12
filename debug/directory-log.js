'use strict';
(() => {
  const $=id=>document.getElementById(id);
  let latest=null;
  function row(parent,values){
    const tr=document.createElement('tr');
    for(const value of values){const td=document.createElement('td');td.textContent=String(value??'');tr.append(td);}
    parent.append(tr);
  }
  async function refresh(){
    const response=await chrome.runtime.sendMessage({type:'SMZ_TRACE_GET'});
    if(response?.ok!==true)throw Error(response?.error||'ログを取得できませんでした');
    latest={exportedAt:new Date().toISOString(),version:response.version,extensionId:response.extensionId,
      current:response.current||[],log:response.log||{entries:[]}};
    $('json').value=JSON.stringify(latest,null,2);
    $('current').textContent='';$('events').textContent='';
    const aliases=new Map();
    for(const entry of latest.log.entries||[]){const f=entry.fields||{};if(f.directoryKey&&f.label)aliases.set(f.directoryKey,f.label);}
    const folder=(name,key)=>[name||'未設定',aliases.get(key)||'',key||'キーなし'].filter(Boolean).join('\n');
    for(const state of latest.current)row($('current'),[
      `${state.platform||''} / ${state.account||''}`,folder(state.archiveName,state.archiveKey),
      folder(state.preferredName,state.preferredKey),`${state.status||''} / ${state.pauseReason||''}\n保存済みZIP: ${state.savedZipCount||0} / 次の位置: ${state.nextItemIndex||0}`]);
    for(const entry of [...(latest.log.entries||[])].reverse().slice(0,100)){
      const f=entry.fields||{};
      row($('events'),[new Date(entry.at).toLocaleString('ja-JP',{hour12:false}),
        `${entry.context}\n${entry.contextId} #${entry.seq}`,entry.event,
        folder(f.directoryName||f.archiveName||f.preferredName,f.directoryKey||f.archiveKey||f.preferredKey),
        JSON.stringify(f)]);
    }
    $('status').textContent=`v${latest.version} / 拡張ID: ${latest.extensionId}\n${latest.log.entries?.length||0}件。最新の保存設定は上表、過去の状態は下の記録で比較できます。${latest.log.unavailable?' ログ保存領域へ接続できません。':''}`;
  }
  const showError=error=>{$('status').textContent=error.message||String(error);};
  $('refresh').addEventListener('click',()=>refresh().catch(showError));
  $('clear').addEventListener('click',async()=>{
    try{const result=await chrome.runtime.sendMessage({type:'SMZ_TRACE_CLEAR'});if(result?.ok!==true)throw Error(result?.error||'消去できませんでした');await refresh();}catch(error){showError(error);}
  });
  $('export').addEventListener('click',()=>{
    if(!latest)return;
    const url=URL.createObjectURL(new Blob([JSON.stringify(latest,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=`smz-directory-log-${Date.now()}.json`;a.click();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  });
  void refresh().catch(showError);
})();
