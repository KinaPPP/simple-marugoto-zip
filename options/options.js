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
  let pendingSelectedAccounts = null;
  let pendingName = '';
  let busy = false;

  // 従来の全体JSONと同じ明示的な設定キーに保存する。認証情報は扱わない。
  const X_SETTINGS_KEY = 'smz_user_settings_v1';
  const OPTIONS_TAB_KEY = 'smz_options_active_tab_v1';

  function activateOptionsTab(name, { persist = true } = {}) {
    const tab = ['services','backup','data'].includes(name) ? name : 'services';
    document.querySelectorAll('[data-tab]').forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
      const active = panel.dataset.tabPanel === tab;
      panel.hidden = !active;
      panel.classList.toggle('is-active', active);
    });
    if (persist) void chrome.storage.local.set({ [OPTIONS_TAB_KEY]: tab });
    if (tab === 'data') {
      void loadAccountsInto($('managedAccounts')).catch((error) => report($('manageFeedback'), error.message, true));
    }
  }
  async function initOptionsTabs() {
    const saved = await chrome.storage.local.get(OPTIONS_TAB_KEY);
    activateOptionsTab(saved?.[OPTIONS_TAB_KEY] || 'services', { persist: false });
  }
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => activateOptionsTab(button.dataset.tab));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
      const tabs = [...document.querySelectorAll('[data-tab]')];
      const index = tabs.indexOf(button);
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(index + delta + tabs.length) % tabs.length];
      event.preventDefault();
      activateOptionsTab(next.dataset.tab);
      next.focus();
    });
  });
  void initOptionsTabs();
  const xSplitCheckbox = $('xSplitMedia');
  const xRevertCheckbox = $('xRevertProfileTabs');
  const xFeedback = $('xOptionsFeedback');
  async function loadXUiSettings() {
    const storage = await chrome.storage.local.get(X_SETTINGS_KEY);
    xSplitCheckbox.checked = storage[X_SETTINGS_KEY]?.xSplitMedia !== false;
    xRevertCheckbox.checked = storage[X_SETTINGS_KEY]?.xRevertProfileTabs === true;
  }
  async function saveXUiSettings() {
    const saved = await chrome.storage.local.get(X_SETTINGS_KEY);
    await chrome.storage.local.set({ [X_SETTINGS_KEY]: {
      ...(saved[X_SETTINGS_KEY] || {}),
      xSplitMedia: xSplitCheckbox.checked,
      xRevertProfileTabs: xRevertCheckbox.checked
    } });
    report(xFeedback, '保存しました。Xのタブを再読み込みすると反映されます。');
  }
  void loadXUiSettings().catch((error) => report(xFeedback, error.message, true));
  xSplitCheckbox.addEventListener('change', () => void saveXUiSettings().catch((error) => report(xFeedback, error.message, true)));
  xRevertCheckbox.addEventListener('change', () => void saveXUiSettings().catch((error) => report(xFeedback, error.message, true)));


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
      const scope = $('exportScope').value;
      const selectedAccounts = scope === 'choose' ? [...document.querySelectorAll('#exportAccountChooser input:checked')].map(i => i.value) : null;
      if (scope === 'choose' && !selectedAccounts.length) throw new Error('保存するアカウントを選択してください');
      const response = await chrome.runtime.sendMessage({type:'SMZ_BACKUP_EXPORT',
        platform:scope === 'choose' ? 'all' : scope, ...(selectedAccounts ? {selectedAccounts} : {})});
      if (!response?.ok) throw new Error(response?.error || 'エクスポートできませんでした');
      if (!response.data.accounts.length) throw new Error('対象アカウントの保存情報がありません');
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
      name.textContent = `${entry.current.platform === 'bluesky' ? 'Bluesky' : entry.current.platform === 'threads' ? 'Threads' : 'X'} @${entry.current.handle}`;
      const detail = document.createElement('small');
      const cumulative = SMZBackup.cumulativeCounts(entry.current);
      const currentCount = Number(entry.current.counts?.total || 0);
      const countLabel = entry.current.deltaMode && cumulative
        ? `今回 ${currentCount.toLocaleString('ja-JP')}件 / 累計 ${Number(cumulative.total || 0).toLocaleString('ja-JP')}件`
        : `${currentCount.toLocaleString('ja-JP')}件`;
      detail.textContent = `${countLabel} / ${entry.current.archive?.status === 'archive_complete' ? 'ZIP保存完了' : '収集・ZIP状態あり'}`;
      if ($('importScope').value === 'choose') {
        const choice = document.createElement('label');
        choice.className = 'account-row-choice';
        const input = document.createElement('input');
        input.type = 'checkbox'; input.checked = true;
        input.value = `${entry.current.platform}:${entry.current.handle}`;
        choice.append(input, name,detail); row.append(choice);
      } else row.append(name,detail);
      accounts.append(row);
    }
  }

  async function importFile(file) {
    if (!file || busy) return;
    pending = null; pendingSelectedAccounts = null; pendingName = '';
    $('importSelectedBtn').hidden = true;
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

      // Default remains one-step, non-destructive merge. Advanced mode previews selections BEFORE modifying storage.
      const scope = $('importScope').value;
      const selectedAccounts = scope === 'all' || scope === 'choose' ? null :
        backup.accounts.filter(entry => entry.current.platform === scope).map(entry => `${entry.current.platform}:${entry.current.handle}`);
      if (scope !== 'all' && scope !== 'choose' && !selectedAccounts.length) throw new Error('指定したSNSのアカウントが含まれていません');
      if (scope === 'choose') {
        pending = backup; pendingSelectedAccounts = null; pendingName = file.name;
        $('importSourceText').textContent = file.name;
        $('importResultText').textContent = '復元するアカウントを選択してください';
        $('importAdvanced').open = true;
        renderAccounts(backup);
        $('importSelectedBtn').hidden = false;
        replaceAllBtn.hidden = true;
        replaceAccountsBtn.hidden = true;
        resultEl.hidden = false;
        report(feedbackEl, '選択後に「選択したアカウントを復元」を押してください。');
        return;
      }
      const response = await chrome.runtime.sendMessage({
        type:'SMZ_BACKUP_IMPORT', data:backup, mode:'merge', ...(selectedAccounts ? {selectedAccounts} : {})
      });
      if (!response?.ok) throw new Error(response?.error || '復元できませんでした');
      pending = backup;
      pendingSelectedAccounts = selectedAccounts;
      const added = Number(response.imported || 0);
      const kept = Number(response.skipped || 0);
      $('importResultText').textContent = added || kept
        ? `${added}件追加${kept ? `・${kept}件は登録済み` : ''}`
        : '読み込みました（対象のアカウントはありません）';
      $('importSourceText').textContent = file.name;
      replaceAccountsBtn.hidden = kept === 0;
      replaceAllBtn.hidden = backup.format !== SMZBackup.FULL_FORMAT || backup.partial || $('importScope').value !== 'all';
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

  $('importSelectedBtn').addEventListener('click', async () => {
    if (!pending || busy) return;
    const selectedAccounts = [...document.querySelectorAll('#importAccounts input:checked')].map(i => i.value);
    if (!selectedAccounts.length) { report(feedbackEl, '復元するアカウントを選択してください', true); return; }
    setBusy(true);
    try {
      const response = await chrome.runtime.sendMessage({type:'SMZ_BACKUP_IMPORT',data:pending,mode:'merge',selectedAccounts});
      if (!response?.ok) throw new Error(response?.error || '復元できませんでした');
      pendingSelectedAccounts = selectedAccounts;
      $('importSelectedBtn').hidden = true;
      $('importResultText').textContent = `${response.imported}件追加${response.skipped ? ` / ${response.skipped}件は登録済み` : ''}`;
      replaceAccountsBtn.hidden = !response.skipped;
      replaceAllBtn.hidden = true;
      report(feedbackEl, '選択したアカウントを読み込みました。');
    } catch (error) { report(feedbackEl, error.message || String(error), true); }
    finally { setBusy(false); }
  });

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
      const response = await chrome.runtime.sendMessage({type:'SMZ_BACKUP_IMPORT',data:pending,mode,
        ...(pendingSelectedAccounts ? {selectedAccounts:pendingSelectedAccounts} : {})});
      if (!response?.ok) throw new Error(response?.error || '上書きできませんでした');
      $('importResultText').textContent = `${response.imported}アカウントを置き換えました`;
      $('importSelectedBtn').hidden = true;
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
      pending = null; pendingSelectedAccounts = null;
      $('importSelectedBtn').hidden = true;
      hideOverwrite();
      resultEl.hidden = true;
      resetConfirm.hidden = true;
      report($('exportFeedback'), '');
      report(feedbackEl, '');
      report($('resetFeedback'), 'シンプルまるごとZIPのデータを初期化しました。');
    } catch (error) { report($('resetFeedback'), error.message || String(error), true); }
    finally { setBusy(false); }
  });

  function fmtExpires(auth) {
    if (!auth.connected) return '未接続';
    const exp = Number(auth.expiresAt || 0);
    if (!exp) return '期限は未確認です';
    const days = Math.max(0, Math.ceil((exp-Date.now())/86400000));
    return `期限：${new Date(exp).toLocaleDateString('ja-JP')} / 残り約${days}日${auth.expiryEstimated ? '（長期トークンの場合の推定値）' : ''}`;
  }
  let threadsBusy = false;
  async function showThreadsStatus() {
    const response = await chrome.runtime.sendMessage({type:'SMZ_THREADS_AUTH_STATUS'});
    if (!response?.ok) throw new Error(response?.error || 'Threadsの接続状態を確認できません');
    const auth = response.auth;
    $('threadsAuthBadge').className = `badge${auth.connected ? ' connected' : ''}`;
    $('threadsAuthBadge').textContent = auth.connected ? '接続済み' : '未接続';
    $('threadsAuthUsername').textContent = auth.username ? `@${auth.username}` : '';
    $('threadsExpiry').textContent = fmtExpires(auth) + (auth.lastError ? ` / ${auth.lastError}` : '');
    $('threadsAutoRenew').checked = auth.autoRenew !== false;
    $('threadsAutoRenew').disabled = !auth.connected || threadsBusy;
    $('threadsRefreshBtn').disabled = !auth.connected || threadsBusy;
    $('threadsDisconnectBtn').disabled = !auth.connected || threadsBusy;
    $('threadsConnectBtn').disabled = threadsBusy;
    $('threadsTokenInput').placeholder = auth.connected ? '＊＊＊＊＊＊＊＊（保存済み）' : '取得した長期トークンを貼り付け';
  }
  function setThreadsBusy(value) {
    threadsBusy = value;
    for (const id of ['threadsConnectBtn','threadsRefreshBtn','threadsDisconnectBtn','threadsAutoRenew']) $(id).disabled = value;
  }
  async function threadsAction(type, extra = {}) {
    setThreadsBusy(true);
    report($('threadsAuthFeedback'), '処理中…');
    try {
      const response = await chrome.runtime.sendMessage({type,...extra});
      if (!response?.ok) throw new Error(response?.error || 'Threadsの操作が失敗しました');
      if (type === 'SMZ_THREADS_CONNECT') $('threadsTokenInput').value = '';
      report($('threadsAuthFeedback'), type === 'SMZ_THREADS_CONNECT' ? '接続しました。' :
        type === 'SMZ_THREADS_REFRESH_AUTH' ? 'トークンを更新しました。' : type === 'SMZ_THREADS_DISCONNECT' ? 'トークンを削除しました。' : '設定を保存しました。');
      await showThreadsStatus();
    } catch (error) { report($('threadsAuthFeedback'), error.message || String(error), true); }
    finally { setThreadsBusy(false); await showThreadsStatus().catch(()=>{}); }
  }
  $('threadsConnectBtn').addEventListener('click', () => {
    const token = $('threadsTokenInput').value.trim();
    if (!token) { report($('threadsAuthFeedback'), '長期トークンを入力してください',true); return; }
    void threadsAction('SMZ_THREADS_CONNECT',{token,autoRenew:$('threadsAutoRenew').checked});
  });
  $('threadsRefreshBtn').addEventListener('click', () => void threadsAction('SMZ_THREADS_REFRESH_AUTH'));
  $('threadsAutoRenew').addEventListener('change', () => void threadsAction('SMZ_THREADS_SET_AUTORENEW',{enabled:$('threadsAutoRenew').checked}));
  $('threadsDisconnectBtn').addEventListener('click', () => { $('threadsDisconnectConfirm').hidden = false; });
  $('threadsDisconnectCancel').addEventListener('click', () => { $('threadsDisconnectConfirm').hidden = true; });
  $('threadsDisconnectApply').addEventListener('click', async () => {
    await threadsAction('SMZ_THREADS_DISCONNECT');
    $('threadsDisconnectConfirm').hidden = true;
  });
  void showThreadsStatus().catch(error => report($('threadsAuthFeedback'),error.message,true));

  async function loadAccountsInto(container, {defaultChecked = false} = {}) {
    const response = await chrome.runtime.sendMessage({type:'SMZ_BACKUP_LIST'});
    if (!response?.ok) throw new Error(response?.error || 'アカウント一覧を取得できません');
    container.replaceChildren();
    for (const account of response.accounts.sort((a,b) => (a.platform+a.handle).localeCompare(b.platform+b.handle))) {
      const row = document.createElement('label'); row.className = 'account-row account-row-choice';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = defaultChecked;
      checkbox.value = `${account.platform}:${account.handle}`;
      const caption = document.createElement('span');
      const label = account.platform === 'bluesky' ? 'Bluesky' : account.platform === 'threads' ? 'Threads' : 'X';
      caption.textContent = `${label} @${account.handle}（${Number(account.count||0).toLocaleString('ja-JP')}件）`;
      row.append(checkbox,caption); container.append(row);
    }
    if (!response.accounts.length) container.textContent = '保存中のアカウントはありません';
  }
  $('exportScope').addEventListener('change', () => {
    const custom = $('exportScope').value === 'choose';
    $('exportAccountChooser').hidden = !custom;
    if (custom) void loadAccountsInto($('exportAccountChooser'),{defaultChecked:true}).catch(error => report($('exportFeedback'),error.message,true));
  });
  $('refreshAccountListBtn').addEventListener('click', () => void loadAccountsInto($('managedAccounts'))
    .catch(error => report($('manageFeedback'),error.message,true)));
  let deleteTargets = null;
  $('deleteSelectedAccountsBtn').addEventListener('click', () => {
    deleteTargets = [...document.querySelectorAll('#managedAccounts input:checked')].map(input => input.value);
    if (!deleteTargets.length) { report($('manageFeedback'),'削除するアカウントを選択してください',true); return; }
    $('deleteSelectedConfirmText').textContent = `${deleteTargets.length}アカウントの収集・ZIP進捗を削除しますか？`;
    $('deleteSelectedConfirm').hidden = false;
  });
  $('cancelDeleteSelectedBtn').addEventListener('click', () => { deleteTargets = null; $('deleteSelectedConfirm').hidden = true; });
  $('applyDeleteSelectedBtn').addEventListener('click', async () => {
    if (!deleteTargets || busy) return;
    setBusy(true);
    try {
      const response = await chrome.runtime.sendMessage({type:'SMZ_BACKUP_DELETE_SELECTED',accounts:deleteTargets});
      if (!response?.ok) throw new Error(response?.error || '削除できませんでした');
      report($('manageFeedback'), `${response.deleted}アカウントの保存状態を削除しました。`);
      deleteTargets = null; $('deleteSelectedConfirm').hidden = true;
      await loadAccountsInto($('managedAccounts'));
    } catch (error) { report($('manageFeedback'),error.message || String(error),true); }
    finally { setBusy(false); }
  });

})();