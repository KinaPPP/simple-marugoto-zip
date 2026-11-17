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
      current:response.current||[],xMedia:response.xMedia||[],log:response.log||{entries:[]}};
    $('json').value=JSON.stringify(latest,null,2);
    $('current').textContent='';$('events').textContent='';
    $('xPosts').textContent='';
    let xCount=0,truncated=false;
    for(const account of latest.xMedia){
      truncated ||= account.postsTruncated===true;
      for(const post of account.posts||[]){
        xCount++;
        row($('xPosts'),[`${account.account}\n${post.postId}`,post.expectedCount??'直近ログなし',
          `${post.collectedCount}（画像${post.imageCount}／動画${post.videoCount}）`,post.mediaIndices||'なし',
          post.savedCount===null?'記録なし':`${post.savedCount}\n${post.savedMediaIndices||'なし'}`]);
      }
    }
    $('xStatus').textContent=xCount?`${xCount}投稿を表示。${truncated?'100投稿を超えたアカウントは一部を省略しています。':''}通信件数は直近400件のログから集計、収集済み件数は現在の保存データから集計しています。`:'該当する投稿がまだありません。20枚投稿が含まれるアカウントを収集してから更新してください。';
    const capture=latest.log.entries||[];
    $('xStatus').textContent+=` / 起動記録: 収集側 ${capture.filter(e=>e.event==='x.capture.content_ready').length}件、通信監視側 ${capture.filter(e=>e.event==='x.capture.hook_ready').length}件、通信応答 ${capture.filter(e=>e.event==='x.capture.response').length}件（直近ログ内）`;
    const aliases=new Map();
    for(const entry of latest.log.entries||[]){const f=entry.fields||{};if(f.directoryKey&&f.label)aliases.set(f.directoryKey,f.label);}
    const folder=(name,key)=>[name||'未設定',aliases.get(key)||'',key||'キーなし'].filter(Boolean).join('\n');
    for(const state of latest.current)row($('current'),[
      `${state.platform||''} / ${state.account||''}`,folder(state.archiveName,state.archiveKey),
      folder(state.preferredName,state.preferredKey),`${state.collectionStatus||''} / ${state.status||''} / ${state.pauseReason||''}\n収集: ${state.count??'不明'}（画像${state.imageCount??'不明'}／動画${state.videoCount??'不明'}）\n保存済みZIP: ${state.savedZipCount||0} / 次の位置: ${state.nextItemIndex||0}`]);
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
