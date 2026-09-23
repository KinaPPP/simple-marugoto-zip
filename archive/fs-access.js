(() => {
  const DB_NAME = 'simple-marugoto-zip';
  const DB_VERSION = 1;
  const STORE_NAME = 'file-handles';
  const handleCache = new Map();
  const writableGranted = new Set();

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDBを開けませんでした'));
    });
  }

  async function getHandle(key) {
    if (handleCache.has(key)) return handleCache.get(key);
    const db = await openDb();
    try {
      const handle = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error('保存先情報を読み込めませんでした'));
      });
      if (handle) handleCache.set(key, handle);
      return handle;
    } finally {
      db.close();
    }
  }

  async function setHandle(key, handle) {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(handle, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('保存先情報を保存できませんでした'));
        tx.onabort = () => reject(tx.error || new Error('保存先情報の保存が中断されました'));
      });
      handleCache.set(key, handle);
      writableGranted.add(key);
    } finally {
      db.close();
    }
  }

  async function removeHandle(key) {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('保存先情報を削除できませんでした'));
      });
      handleCache.delete(key);
      writableGranted.delete(key);
    } finally {
      db.close();
    }
  }

  // 全体初期化専用。保存したフォルダのハンドルも残さない。
  // 実ファイルやOS側のフォルダそのものには触れない。
  async function clearAllHandles() {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('保存先情報を初期化できませんでした'));
        tx.onabort = () => reject(tx.error || new Error('保存先情報の初期化が中断されました'));
      });
      handleCache.clear();
      writableGranted.clear();
    } finally {
      db.close();
    }
  }

  async function queryWritePermission(handle) {
    if (!handle?.queryPermission) return false;
    try {
      return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
    } catch {
      return false;
    }
  }

  async function ensureWritableDirectory(key, requestIfNeeded = false) {
    const handle = await getHandle(key);
    if (!handle) {
      const error = new Error('保存先フォルダ情報が見つかりません');
      error.code = 'SAVE_DIRECTORY_MISSING';
      throw error;
    }

    // 同一実行中は一度確認したハンドルを使い回す。
    // IndexedDBから毎ZIPごとに復元してqueryPermission()すると、
    // Chrome側で一時的にprompt扱いへ戻る場合があるため。
    if (writableGranted.has(key)) return handle;

    if (await queryWritePermission(handle)) {
      writableGranted.add(key);
      return handle;
    }

    if (requestIfNeeded && handle.requestPermission) {
      try {
        const status = await handle.requestPermission({ mode: 'readwrite' });
        if (status === 'granted') {
          writableGranted.add(key);
          return handle;
        }
      } catch {}
    }

    const error = new Error('保存先フォルダへの書き込み権限がありません');
    error.code = 'SAVE_PERMISSION_REQUIRED';
    throw error;
  }

  async function requireWritableDirectory(key) {
    return ensureWritableDirectory(key, false);
  }

  async function pickDirectory(key) {
    if (!('showDirectoryPicker' in window)) {
      const error = new Error('File System Access API is not supported');
      error.code = 'NOT_SUPPORTED';
      throw error;
    }
    const handle = await window.showDirectoryPicker({
      id: 'simple-marugoto-zip-save-folder',
      mode: 'readwrite',
      startIn: 'downloads'
    });
    await setHandle(key, handle);
    return handle;
  }

  async function uniqueFileName(directoryHandle, filename) {
    const dot = filename.lastIndexOf('.');
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    let candidate = filename;
    for (let i = 0; i < 1000; i++) {
      try {
        await directoryHandle.getFileHandle(candidate);
        candidate = `${base} (${i + 1})${ext}`;
      } catch (error) {
        if (error?.name === 'NotFoundError') return candidate;
        throw error;
      }
    }
    return `${base}_${Date.now()}${ext}`;
  }

  function normalizePermissionError(error, key) {
    if (['NotAllowedError', 'SecurityError'].includes(error?.name)) {
      writableGranted.delete(key);
      const wrapped = new Error('保存先フォルダへの書き込み権限がありません');
      wrapped.code = 'SAVE_PERMISSION_REQUIRED';
      return wrapped;
    }
    return error;
  }

  async function writeBlob(key, filename, blob) {
    const handle = await requireWritableDirectory(key);
    let actualName = filename;
    let writable = null;
    try {
      actualName = await uniqueFileName(handle, filename);
      const fileHandle = await handle.getFileHandle(actualName, { create: true });
      writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      try { await writable?.abort(); } catch {}
      try { await handle.removeEntry(actualName); } catch {}
      throw normalizePermissionError(error, key);
    }
    return { filename: actualName, directoryName: handle.name || '' };
  }

  // 大きなZIP向け。ZIP全体をBlobとしてメモリへ保持せず、
  // File System Access APIのWritableStreamへ順次書き込む。
  async function openWritableFile(key, filename) {
    const handle = await requireWritableDirectory(key);
    try {
      const actualName = await uniqueFileName(handle, filename);
      const fileHandle = await handle.getFileHandle(actualName, { create: true });
      const writable = await fileHandle.createWritable();
      return {
        writable,
        filename: actualName,
        directoryName: handle.name || '',
        async remove() {
          try { await handle.removeEntry(actualName); } catch {}
        }
      };
    } catch (error) {
      throw normalizePermissionError(error, key);
    }
  }

  globalThis.SMZFileSystem = {
    getHandle,
    setHandle,
    removeHandle,
    clearAllHandles,
    queryWritePermission,
    ensureWritableDirectory,
    pickDirectory,
    writeBlob,
    openWritableFile
  };
})();
