'use strict';

// ZIP/JSONを置くだけで安全な追加。上書きや全体削除だけを明示的に確認する。
(() => {
  const $ = (id) => document.getElementById(id);
  const exportBtn = $('exportBackupBtn');
  const input = $('backupFileInput');
  const drop = $('backupDropZone');
  const resultEl = $('importResult');
  const feedbackEl = $('importFeedback');
  const replaceAccountsBtn = $('replaceAccountsBtn');
  const replaceAllBtn = $('replaceAllBtn');
  const confirmBox = $('importConfirmBox');
  const applyImportBtn = $('applyImportBtn');
  const resetBtn = $('resetAllBtn');
  const resetConfirm = $('resetConfirmBox');
  let pending = null;
  let pendingOverwrite = null;
  let busy = false;

  function report(element, text, error = false) {
    element.textContent = text || '';
    element.classList.toggle('error', error);
  }
  function setBusy(value) {
    busy = value;
    for (const el of [exportBtn, input, replaceAccountsBtn, replaceAllBtn,
      applyImportBtn, resetBtn, $('applyResetBtn')]) el.disabled = value;
    drop.setAttribute('aria-disabled', String(value));
  }
  function hideOverwrite() {
    pendingOverwrite = null;
    confirmBox.hidden = true;
  }
  function startOverwrite(mode) {
    if (!pending || busy) return;
    pendingOverwrite = mode;
    $('importConfirmText').textContent = mode === 'replace-all'
      ? 'すべてのアカウントと共通設定を、このJSONの内容で置き換えますか？'
      : '同じアカウントの現在の収集・ZIP進捗を、読み込んだ状態に置き換えますか？';
    confirmBox.hidden = false;
  }

  exportBtn.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    report($('exportFeedback'), 'JSONを作成中…');
    try {
      const response = await chrome.runtime.sendMessage({type:'SMZ_BACKUP_EXPORT'});
      if (!response?.ok) throw new Error(response?.error || 'エクスポートできませんでした');
      const blob = new Blob([JSON.stringify(response.data, null, 2)], {type:'application/json'});
      const date = new Date();
      const pad = (n) => String(n).padStart(2,'0');
      const stamp = `${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `simple-marugoto-zip-all-state_${stamp}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      report($('exportFeedback'), `${response.data.accounts.length}アカウントのJSONを保存しました。`);
    } catch (error) { report($('exportFeedback'), error.message || String(error), true); }
    finally { setBusy(false); }
  });

  function renderAccounts(backup) {
    const accounts = $('importAccounts');
    accounts.replaceChildren();
    for (const entry of backup.accounts) {
      const row = document.createElement('div');
      row.className = 'account-row';
      const name = document.createElement('strong');
      name.textContent = `@${entry.current.handle}`;
      const detail = document.createElement('small');
      detail.textContent = `${Number(entry.current.counts.total || 0).toLocaleString('ja-JP')}件 / ${entry.current.archive?.status === 'archive_complete' ? 'ZIP保存完了' : '収集・ZIP状態あり'}`;
      row.append(name,detail);
      accounts.append(row);
    }
  }

  async function importFile(file) {
    if (!file || busy) return;
    pending = null;
    resultEl.hidden = true;
    hideOverwrite();
    setBusy(true);
    report(feedbackEl, '読み込み中…');
    try {
      if (file.size > 4.5 * 1024 * 1024 * 1024) throw new Error('ZIPのサイズが大きすぎます');
      const ext = file.name.toLowerCase().split('.').at(-1);
      let backup;
      if (ext === 'zip') backup = await SMZZipReader.accountJsonFromZip(file);
      else if (ext === 'json') {
        if (file.size > 128 * 1024 * 1024) throw new Error('JSONのサイズが大きすぎます');
        backup = SMZBackup.parseJson(await file.text());
      } else throw new Error('ZIPまたはJSONを選択してください');

      // デフォルトは既存アカウントを一切変更せず、新規分だけを自動追加。
      const response = await chrome.runtime.sendMessage({
        type:'SMZ_BACKUP_IMPORT', data:backup, mode:'merge'
      });
      if (!response?.ok) throw new Error(response?.error || '復元できませんでした');
      pending = backup;
      const added = Number(response.imported || 0);
      const kept = Number(response.skipped || 0);
      $('importResultText').textContent = added || kept
        ? `${added}件追加${kept ? `・${kept}件は登録済み` : ''}`
        : '読み込みました（対象のアカウントはありません）';
      $('importSourceText').textContent = file.name;
      replaceAccountsBtn.hidden = kept === 0;
      replaceAllBtn.hidden = backup.format !== SMZBackup.FULL_FORMAT;
      renderAccounts(backup);
      $('importAdvanced').open = false;
      const warning = $('importWarning');
      warning.hidden = !(backup.source?.zipNumber > 1);
      if (!warning.hidden) warning.textContent = `分割ZIPの${backup.source.zipNumber}番目から復元しました。以前のZIPファイルの有無は確認していません。`;
      resultEl.hidden = false;
      report(feedbackEl, '復元しました！');
    } catch (error) {
      report(feedbackEl, error.message || String(error), true);
    } finally {
      input.value = '';
      setBusy(false);
    }
  }

  drop.addEventListener('click', () => { if (!busy) input.click(); });
  drop.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && !busy) {
      event.preventDefault(); input.click();
    }
  });
  input.addEventListener('change', () => void importFile(input.files?.[0]));
  document.addEventListener('dragover', (event) => {
    if ([...event.dataTransfer?.types || []].includes('Files')) {
      event.preventDefault();
      drop.classList.add('dragover');
    }
  });
  document.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) drop.classList.remove('dragover');
  });
  document.addEventListener('drop', (event) => {
    if ([...event.dataTransfer?.types || []].includes('Files')) {
      event.preventDefault();
      drop.classList.remove('dragover');
      void importFile(event.dataTransfer?.files?.[0]);
    }
  });
  replaceAccountsBtn.addEventListener('click', () => startOverwrite('replace-accounts'));
  replaceAllBtn.addEventListener('click', () => startOverwrite('replace-all'));
  $('cancelImportBtn').addEventListener('click', hideOverwrite);
  applyImportBtn.addEventListener('click', async () => {
    if (!pending || !pendingOverwrite || busy) return;
    const mode = pendingOverwrite;
    setBusy(true);
    report(feedbackEl, '復元中…');
    try {
      const response = await chrome.runtime.sendMessage({type:'SMZ_BACKUP_IMPORT',data:pending,mode});
      if (!response?.ok) throw new Error(response?.error || '上書きできませんでした');
      $('importResultText').textContent = `${response.imported}アカウントを置き換えました`;
      replaceAccountsBtn.hidden = true;
      report(feedbackEl, '上書きしました！');
      hideOverwrite();
    } catch (error) { report(feedbackEl, error.message || String(error), true); }
    finally { setBusy(false); }
  });

  resetBtn.addEventListener('click', () => {
    if (busy) return;
    resetConfirm.hidden = false;
    report($('resetFeedback'), '');
  });
  $('cancelResetBtn').addEventListener('click', () => { resetConfirm.hidden = true; });
  $('applyResetBtn').addEventListener('click', async () => {
    if (busy || resetConfirm.hidden) return;
    setBusy(true);
    report($('resetFeedback'), '初期化中…');
    try {
      const response = await chrome.runtime.sendMessage({type:'SMZ_BACKUP_RESET_ALL'});
      if (!response?.ok) throw new Error(response?.error || '初期化できませんでした');
      pending = null;
      hideOverwrite();
      resultEl.hidden = true;
      resetConfirm.hidden = true;
      report($('exportFeedback'), '');
      report(feedbackEl, '');
      report($('resetFeedback'), 'シンプルまるごとZIPのデータを初期化しました。');
    } catch (error) { report($('resetFeedback'), error.message || String(error), true); }
    finally { setBusy(false); }
  });
})();
