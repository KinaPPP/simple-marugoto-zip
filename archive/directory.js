'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const platform = params.get('platform');
  const handle = params.get('handle');
  const expectedKey = params.get('expectedKey') || null;
  let changing = false;
  let traceId = null;
  let phase = 'initial';
  let lastSelectedKey = null;
  function report(text, error = false) {
    $('result').textContent = text;
    $('result').className = error ? 'error' : '';
  }
  $('target').textContent = `${platform || ''} / @${handle || ''}`;
  async function init() {
    if (!['x','bluesky','threads'].includes(platform) || !handle || !params.has('expectedKey') || (expectedKey !== null && !/^archive-directory:[a-zA-Z0-9._-]{1,100}$/.test(expectedKey))) {
      throw new Error('対象を確認できません。拡張の画面の「変更」から開き直してください');
    }
    const response = await chrome.runtime.sendMessage({type:'SMZ_GET_COLLECTION', platform, handle});
    if (!response?.ok || !response.state) throw new Error(response?.error || '収集状態を取得できませんでした');
    const state = response.state;
    globalThis.SMZDirectoryTrace?.emit('selection.state.loaded', globalThis.SMZDirectoryTrace.snapshot(state));
    const currentKey = state.archive?.saveDirectoryKey || state.preferredSaveDirectoryKey || null;
    if (currentKey !== expectedKey) throw new Error('保存先が変更されています。拡張の画面から開き直してください');
    $('current').textContent = `現在の保存先: ${state.archive?.saveDirectoryName || state.preferredSaveDirectoryName || '未選択'}`;
    if (state.archive?.status === 'archiving') throw new Error('ZIP保存中は変更できません。保存を停止してから開き直してください');
    $('choose').disabled = false;
  }
  $('choose').addEventListener('click', async () => {
    if (changing) return;
    changing = true;
    traceId = globalThis.SMZDirectoryTrace?.id();
    const label = String($('traceLabel')?.value || '').slice(0,120);
    globalThis.SMZDirectoryTrace?.setScope({traceId,platform,account:handle});
    phase = 'picker';
    globalThis.SMZDirectoryTrace?.emit('selection.picker.before', {expectedKey,label,tabVisible:document.visibilityState==='visible',focused:typeof document.hasFocus==='function'?document.hasFocus():false});
    $('choose').disabled = true;
    let candidateKey = null;
    let commitAttempted = false;
    let rejected = false;
    let committed = false;
    try {
      // ユーザー操作の直後に呼ぶ。拡張の画面は許可画面へフォーカスが移ると閉じ得る。
      const picked = await window.showDirectoryPicker({
        id:'simple-marugoto-zip-save-folder', mode:'readwrite', startIn:'downloads'
      });
      // 現在使用中のキーを上書きしない。ZIP開始との競合時も旧保存先を維持。
      candidateKey = `archive-directory:change-${crypto.randomUUID()}`;
      lastSelectedKey = candidateKey;
      globalThis.SMZDirectoryTrace?.emit('selection.picker.returned', {directoryKey:candidateKey,directoryName:picked.name,...SMZFileSystem.directoryDetails?.(picked),label});
      phase = 'persist-candidate';
      await SMZFileSystem.setHandle(candidateKey, picked);
      await SMZFileSystem.diagnoseDirectoryIdentity?.(candidateKey,picked,'selection.after-store');
      commitAttempted = true;
      phase = 'commit';
      const response = await chrome.runtime.sendMessage({
        type:'SMZ_COMMIT_SAVE_DIRECTORY', platform, handle, traceId,
        saveDirectoryKey:expectedKey, candidateKey
      });
      rejected = response?.ok === false;
      globalThis.SMZDirectoryTrace?.emit('selection.commit.result', {ok:response?.ok===true,directoryKey:candidateKey,directoryName:response?.saveDirectoryName||null,errorMessage:response?.error||null});
      if (response?.ok === true) globalThis.SMZDirectoryTrace?.emit('selection.writer.nameComparison', {
        directoryKey:candidateKey,referenceName:picked.name,directoryName:response.saveDirectoryName,
        namesMatch:picked.name===response.saveDirectoryName
      });
      if (response?.ok !== true) throw new Error(response?.error || '変更結果を確認できませんでした。拡張の画面を開き直して保存先を確認してください');
      committed = true;
      await SMZFileSystem.diagnoseDirectoryIdentity?.(candidateKey,picked,'selection.after-commit');
      $('current').textContent = `現在の保存先: ${response.saveDirectoryName}`;
      report(`保存先を「${response.saveDirectoryName}」に変更しました。次のZIPから使用します。\n拡張機能の小窓を開き直してZIP保存を開始・再開してください。\n「サイトアクセス時は常に許可」を選んでいない場合は、連続するZIP保存がすべて終わるまでこのタブを閉じないでください。`);
      return;
    } catch (error) {
      globalThis.SMZDirectoryTrace?.failure('selection.failed', error, {phase,directoryKey:candidateKey,expectedKey});
      // 応答が失われても確定済みの可能性があるため、その候補ハンドルは消さない。
      if (candidateKey && (!commitAttempted || rejected)) {
        try { await SMZFileSystem.removeHandle(candidateKey); } catch {}
      }
      const interrupted = error?.name === 'AbortError';
      report(interrupted
        ? `フォルダ選択が中断されました（キャンセルまたはChrome側の拒否）。詳細: ${error.name}: ${error.message || '詳細なし'}`
        : error?.message || '保存先を変更できませんでした', !interrupted);
    } finally {
      changing = false;
      // 成功後は旧expectedKeyでの再確定を防ぎ、拡張の画面から開き直してもらう。
      $('choose').disabled = committed;
      globalThis.SMZDirectoryTrace?.setScope({});
    }
  });
  void init().catch(error => {globalThis.SMZDirectoryTrace?.failure('selection.init.failed',error,{phase:'initial'});report(error.message, true);});
  document.addEventListener?.('visibilitychange',()=>globalThis.SMZDirectoryTrace?.emit('selection.visibility',{traceId,directoryKey:lastSelectedKey,tabVisible:document.visibilityState==='visible'}));
  window.addEventListener?.('pagehide',()=>globalThis.SMZDirectoryTrace?.emit('selection.pagehide',{expectedKey,directoryKey:lastSelectedKey,traceId}));
})();
