(() => {
  const DB_NAME = 'simple-marugoto-zip';
  const DB_VERSION = 1;
  const STORE_NAME = 'file-handles';
  const handleCache = new Map();
  const writableGranted = new Set();

  function directoryDetails(handle) {
    const name = typeof handle?.name === 'string' ? handle.name : '';
    return {directoryName:name,kind:handle?.kind || null,
      nameCodePoints:Array.from(name).slice(0,255).map(c=>'U+'+c.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')).join(' '),
      suspiciousName:!name || /^[\\/\u00a5\uffe5]+$/.test(name)};
  }

  // 診断専用。キャッシュを変更せずIDBから別のコピーを取得して比較する。
  // フォルダの列挙、試し書き、権限の照会・要求は行わない。
  async function diagnoseDirectoryIdentity(key, reference, phase) {
    let db;
    try {
      db = await openDb();
      const restored = await new Promise((resolve,reject)=>{
        const tx=db.transaction(STORE_NAME,'readonly');
        const req=tx.objectStore(STORE_NAME).get(key);
        req.onsuccess=()=>resolve(req.result || null);
        req.onerror=()=>reject(req.error || new Error('診断用の保存先再読込に失敗しました'));
      });
      const result={directoryKey:key,phase,...directoryDetails(restored),referenceName:reference?.name || null,
        referenceKind:reference?.kind || null,found:!!restored,namesMatch:!!reference && !!restored && reference.name===restored.name};
      if (reference && restored && typeof reference.isSameEntry==='function') result.sameEntry=await reference.isSameEntry(restored);
      globalThis.SMZDirectoryTrace?.emit('fs.directory.identityProbe',result);
      return result;
    } catch(error) {
      globalThis.SMZDirectoryTrace?.failure('fs.directory.identityProbeFailed',error,{directoryKey:key,phase,...directoryDetails(reference)});
      return null;
    } finally {db?.close();}
  }

  // 別コンテキストで同じIDBキーが更新されたら、ハンドルと権限を一緒に破棄。
  // IDBのハンドル自体は削除せず、次の利用時に読み直す。
  function invalidateDirectory(key) {
    handleCache.delete(key);
    writableGranted.delete(key);
  }

  async function verifySavedFile(fileHandle, expectedBytes, details = {}) {
    let file;
    try { file = await fileHandle.getFile(); }
    catch (error) { globalThis.SMZDirectoryTrace?.failure('fs.verify.failed',error,{...details,phase:'getFile'}); throw error; }
    globalThis.SMZDirectoryTrace?.emit('fs.verify.result',{...details,expectedBytes,actualBytes:file.size,ok:file.size===expectedBytes});
    if (file.size !== expectedBytes) {
      const error = new Error('ZIPの保存サイズを確認できませんでした。進捗を進めずに停止しました');
      error.code = 'SAVE_VERIFICATION_FAILED';
      throw error;
    }
  }

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
    if (handleCache.has(key)) {
      const cached = handleCache.get(key);
      globalThis.SMZDirectoryTrace?.emit('fs.handle.cache',{directoryKey:key,directoryName:cached.name,cachedGranted:writableGranted.has(key)});
      return cached;
    }
    const db = await openDb();
    try {
      const handle = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error('保存先情報を読み込めませんでした'));
      });
      if (handle) handleCache.set(key, handle);
      globalThis.SMZDirectoryTrace?.emit('fs.handle.idb',{directoryKey:key,...directoryDetails(handle),found:!!handle});
      return handle;
    } catch (error) {
      globalThis.SMZDirectoryTrace?.failure('fs.handle.loadFailed',error,{directoryKey:key});
      throw error;
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
      globalThis.SMZDirectoryTrace?.emit('fs.handle.stored',{directoryKey:key,directoryName:handle.name,cachedGranted:true});
    } finally {
      db.close();
    }
  }

  async function reloadDirectory(key) {
    const previous = handleCache.get(key);
    const wasGranted = writableGranted.has(key);
    invalidateDirectory(key);
    const restored = await getHandle(key);
    globalThis.SMZDirectoryTrace?.emit('fs.handle.reload',{directoryKey:key,directoryName:restored?.name||null,hadCached:!!previous,cachedGranted:wasGranted});
    // IDBは毎回読み直す。実体が同じ場合だけ確認済みの生きたハンドルを維持する。
    // 名前一致では別ドライブの同名フォルダを判別できないため使わない。
    if (previous && restored && wasGranted && typeof previous.isSameEntry === 'function') {
      try {
        const sameEntry = await previous.isSameEntry(restored);
        globalThis.SMZDirectoryTrace?.emit('fs.handle.identity',{directoryKey:key,...directoryDetails(restored),referenceName:previous.name,referenceKind:previous.kind||null,namesMatch:previous.name===restored.name,sameEntry});
        if (sameEntry) {
          handleCache.set(key, previous);
          writableGranted.add(key);
          return previous;
        }
      } catch (error) { globalThis.SMZDirectoryTrace?.failure('fs.handle.identityFailed',error,{directoryKey:key}); }
    }
    return restored;
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
      const permission = await handle.queryPermission({ mode: 'readwrite' });
      globalThis.SMZDirectoryTrace?.emit('fs.permission.query',{directoryName:handle.name,permissionMode:'readwrite',permission});
      return permission === 'granted';
    } catch (error) {
      globalThis.SMZDirectoryTrace?.failure('fs.permission.queryFailed',error,{directoryName:handle.name});
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
    if (writableGranted.has(key)) {
      globalThis.SMZDirectoryTrace?.emit('fs.permission.cached',{directoryKey:key,directoryName:handle.name,cachedGranted:true});
      return handle;
    }

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
    globalThis.SMZDirectoryTrace?.failure('fs.permission.required',error,{directoryKey:key,directoryName:handle.name});
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
    globalThis.SMZDirectoryTrace?.failure('fs.operation.failed',error,{directoryKey:key});
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
      await verifySavedFile(fileHandle, blob.size,{directoryKey:key,directoryName:handle.name,filename:actualName});
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
    const details = {directoryKey:key,...directoryDetails(handle),filename};
    let phase = 'filename';
    try {
      globalThis.SMZDirectoryTrace?.emit('fs.open.begin',details);
      const actualName = await uniqueFileName(handle, filename);
      details.filename = actualName;
      phase = 'getFileHandle-create';
      const fileHandle = await handle.getFileHandle(actualName, { create: true });
      phase = 'createWritable';
      const writable = await fileHandle.createWritable();
      globalThis.SMZDirectoryTrace?.emit('fs.open.ready',details);
      let writeStarted = false;
      const tracedWritable = {
        async write(data) {
          if (!writeStarted) {writeStarted=true;globalThis.SMZDirectoryTrace?.emit('fs.write.begin',details);}
          try {return await writable.write(data);}
          catch(error){globalThis.SMZDirectoryTrace?.failure('fs.write.failed',error,{...details,phase:'write'});throw error;}
        },
        async close() {
          globalThis.SMZDirectoryTrace?.emit('fs.close.begin',details);
          try {const result=await writable.close();globalThis.SMZDirectoryTrace?.emit('fs.close.completed',details);return result;}
          catch(error){globalThis.SMZDirectoryTrace?.failure('fs.close.failed',error,{...details,phase:'close'});throw error;}
        },
        async abort() {
          try {return await writable.abort();}
          catch(error){globalThis.SMZDirectoryTrace?.failure('fs.abort.failed',error,details);throw error;}
        }
      };
      return {
        writable:tracedWritable,
        filename: actualName,
        directoryName: handle.name || '',
        async verify(expectedBytes) {
          await verifySavedFile(fileHandle, expectedBytes,details);
        },
        async remove() {
          try { await handle.removeEntry(actualName); } catch {}
        }
      };
    } catch (error) {
      globalThis.SMZDirectoryTrace?.failure('fs.open.failed',error,{...details,phase});
      throw normalizePermissionError(error, key);
    }
  }

  globalThis.SMZFileSystem = {
    directoryDetails,
    diagnoseDirectoryIdentity,
    getHandle,
    invalidateDirectory,
    reloadDirectory,
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
