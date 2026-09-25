let activeJob = null;
let cancelRequested = false;

const MB = 1024 * 1024;
const LIMITS = {
  auto: { bytes: 300 * MB, files: 300 },
  '500mb': { bytes: 500 * MB, files: Infinity },
  '1gb': { bytes: 1024 * MB, files: Infinity },
  // v0.0.23以前の進行中ジョブを再開するための互換値。UIからは選択不可。
  '10files': { bytes: Infinity, files: 10 },
  '500files': { bytes: Infinity, files: 500 }
};

function runtimeMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function safeName(value, fallback = 'media') {
  const result = String(value || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return result || fallback;
}


function archiveTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  const d = Number.isFinite(date.getTime()) ? date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function mediaKindFromSelection(selection) {
  const images = selection?.images !== false;
  const videos = selection?.videos !== false;
  if (images && videos) return 'media';
  if (images) return 'images';
  if (videos) return 'videos';
  return 'media';
}

function archiveRoot(job) { return safeName(job.platform === 'bluesky' ? `bsky_${job.handle}` : job.handle); }

function archiveFilename(handle, startedAt, mediaKind, zipNumber, platform = 'x') {
  return `${safeName(platform === 'bluesky' ? `bsky_${handle}` : handle)}_${archiveTimestamp(startedAt)}_${mediaKind || 'media'}_${String(zipNumber).padStart(3, '0')}.zip`;
}

function mimeExtension(contentType, fallback) {
  const mime = String(contentType || '').split(';')[0].toLowerCase();
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm'
  };
  return map[mime] || String(fallback || '').replace(/^\./, '') || 'bin';
}

async function fetchMedia(item) {
  const urls = [item.url, ...(item.fallbackUrls || [])].filter(Boolean);
  let lastError = null;
  for (const url of urls) {
    if (cancelRequested) throw new Error('cancelled');
    try {
      const response = await fetch(url, { cache: 'no-store', credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // 一部PDSは、取得失敗時に200でHTML/JSONのエラー本文を返す可能性がある。
      // 画像・動画のファイル名でエラーページを保存しないよう、BlueskyのBlobのみ検査する。
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (item.platform === 'bluesky' && /^(?:text\/html|application\/(?:json|problem\+json))\b/.test(contentType)) {
        throw new Error(`メディアではない応答 (${contentType})`);
      }
      const buffer = await response.arrayBuffer();
      return {
        data: new Uint8Array(buffer),
        extension: mimeExtension(response.headers.get('content-type'), item.extension)
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('download_failed');
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function setU16(view, offset, value) { view.setUint16(offset, value, true); }
function setU32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

function dosDateTime(value) {
  const date = value ? new Date(value) : new Date();
  const valid = Number.isFinite(date.getTime()) ? date : new Date();
  const year = Math.max(1980, valid.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((valid.getMonth() + 1) << 5) | valid.getDate(),
    time: (valid.getHours() << 11) | (valid.getMinutes() << 5) | (valid.getSeconds() >> 1)
  };
}

function buildZipBlob(files) {
  const enc = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const checksum = file.checksum == null ? crc32(file.data) : file.checksum;
    const size = file.data.length;
    const uncompressedSize = file.uncompressedSize ?? size;
    const method = file.method || 0;
    const stamp = dosDateTime(file.postedAt);

    const localView = new DataView(new ArrayBuffer(30 + nameBytes.length));
    setU32(localView, 0, 0x04034b50);
    setU16(localView, 4, 20);
    setU16(localView, 6, 0x0800);
    setU16(localView, 8, method);
    setU16(localView, 10, stamp.time);
    setU16(localView, 12, stamp.date);
    setU32(localView, 14, checksum);
    setU32(localView, 18, size);
    setU32(localView, 22, uncompressedSize);
    setU16(localView, 26, nameBytes.length);
    setU16(localView, 28, 0);
    new Uint8Array(localView.buffer, 30).set(nameBytes);
    const localBytes = new Uint8Array(localView.buffer);
    localParts.push(localBytes, file.data);

    const centralView = new DataView(new ArrayBuffer(46 + nameBytes.length));
    setU32(centralView, 0, 0x02014b50);
    setU16(centralView, 4, 0x031E);
    setU16(centralView, 6, 20);
    setU16(centralView, 8, 0x0800);
    setU16(centralView, 10, method);
    setU16(centralView, 12, stamp.time);
    setU16(centralView, 14, stamp.date);
    setU32(centralView, 16, checksum);
    setU32(centralView, 20, size);
    setU32(centralView, 24, uncompressedSize);
    setU16(centralView, 28, nameBytes.length);
    setU16(centralView, 30, 0);
    setU16(centralView, 32, 0);
    setU16(centralView, 34, 0);
    setU16(centralView, 36, 0);
    setU32(centralView, 38, 0);
    setU32(centralView, 42, offset);
    new Uint8Array(centralView.buffer, 46).set(nameBytes);
    centralParts.push(new Uint8Array(centralView.buffer));

    offset += localBytes.length + size;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  setU32(eocd, 0, 0x06054b50);
  setU16(eocd, 4, 0);
  setU16(eocd, 6, 0);
  setU16(eocd, 8, files.length);
  setU16(eocd, 10, files.length);
  setU32(eocd, 12, centralSize);
  setU32(eocd, 16, centralOffset);
  setU16(eocd, 20, 0);

  return new Blob([...localParts, ...centralParts, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
}


const ZIP32_MAX = 0xFFFFFFFF;
// ZIP64はまだ実装していないため、ファイル数指定でも約3.75GBを安全上限として分割する。
const ZIP32_SAFE_BYTES = 0xF0000000;

function makeZipLocalHeader(nameBytes, checksum, size, stamp, method = 0, uncompressedSize = size) {
  const view = new DataView(new ArrayBuffer(30 + nameBytes.length));
  setU32(view, 0, 0x04034b50);
  setU16(view, 4, 20);
  setU16(view, 6, 0x0800);
  setU16(view, 8, method);
  setU16(view, 10, stamp.time);
  setU16(view, 12, stamp.date);
  setU32(view, 14, checksum);
  setU32(view, 18, size);
  setU32(view, 22, uncompressedSize);
  setU16(view, 26, nameBytes.length);
  setU16(view, 28, 0);
  new Uint8Array(view.buffer, 30).set(nameBytes);
  return new Uint8Array(view.buffer);
}

function makeZipCentralHeader(nameBytes, checksum, size, stamp, offset, method = 0, uncompressedSize = size) {
  const view = new DataView(new ArrayBuffer(46 + nameBytes.length));
  setU32(view, 0, 0x02014b50);
  setU16(view, 4, 0x031E);
  setU16(view, 6, 20);
  setU16(view, 8, 0x0800);
  setU16(view, 10, method);
  setU16(view, 12, stamp.time);
  setU16(view, 14, stamp.date);
  setU32(view, 16, checksum);
  setU32(view, 20, size);
  setU32(view, 24, uncompressedSize);
  setU16(view, 28, nameBytes.length);
  setU16(view, 30, 0);
  setU16(view, 32, 0);
  setU16(view, 34, 0);
  setU16(view, 36, 0);
  setU32(view, 38, 0);
  setU32(view, 42, offset);
  new Uint8Array(view.buffer, 46).set(nameBytes);
  return new Uint8Array(view.buffer);
}

async function createDirectZipWriter(directoryKey, filename) {
  if (!globalThis.SMZFileSystem?.openWritableFile) {
    throw new Error('保存先へストリーミング書き込みできません');
  }

  const opened = await SMZFileSystem.openWritableFile(directoryKey, filename);
  const writable = opened.writable;
  const enc = new TextEncoder();
  const centralParts = [];
  let offset = 0;
  let fileCount = 0;
  let closed = false;

  async function cleanup() {
    if (closed) return;
    closed = true;
    try { await writable.abort(); } catch {}
    try { await opened.remove(); } catch {}
  }

  return {
    filename: opened.filename || filename,
    directoryName: opened.directoryName || '',
    get fileCount() { return fileCount; },
    get bytesWritten() { return offset; },

    async add(file) {
      const nameBytes = enc.encode(file.name);
      const size = file.data.length;
      if (size > ZIP32_MAX) throw new Error('4GBを超える単一ファイルは現在のZIP形式では保存できません');
      const checksum = file.checksum == null ? crc32(file.data) : file.checksum;
      const method = file.method || 0;
      const uncompressedSize = file.uncompressedSize ?? size;
      const stamp = dosDateTime(file.postedAt);
      const local = makeZipLocalHeader(nameBytes, checksum, size, stamp, method, uncompressedSize);
      if (offset + local.length + size > ZIP32_MAX) {
        const error = new Error('ZIPが4GB上限を超えるため分割が必要です');
        error.code = 'ZIP32_LIMIT';
        throw error;
      }
      const central = makeZipCentralHeader(nameBytes, checksum, size, stamp, offset, method, uncompressedSize);
      await writable.write(local);
      await writable.write(file.data);
      centralParts.push(central);
      offset += local.length + size;
      fileCount++;
    },

    async finalize() {
      try {
        const centralOffset = offset;
        let centralSize = 0;
        for (const part of centralParts) {
          await writable.write(part);
          centralSize += part.length;
        }
        if (centralOffset > ZIP32_MAX || centralSize > ZIP32_MAX || centralOffset + centralSize + 22 > ZIP32_MAX) {
          throw new Error('ZIPが4GB上限を超えました');
        }
        const eocd = new DataView(new ArrayBuffer(22));
        setU32(eocd, 0, 0x06054b50);
        setU16(eocd, 4, 0);
        setU16(eocd, 6, 0);
        setU16(eocd, 8, fileCount);
        setU16(eocd, 10, fileCount);
        setU32(eocd, 12, centralSize);
        setU32(eocd, 16, centralOffset);
        setU16(eocd, 20, 0);
        await writable.write(new Uint8Array(eocd.buffer));
        await writable.close();
        closed = true;
        return {
          filename: opened.filename || filename,
          bytes: centralOffset + centralSize + 22,
          saveMode: 'directory'
        };
      } catch (error) {
        await cleanup();
        throw error;
      }
    },

    async abort() {
      await cleanup();
    }
  };
}

// ZIPが1つ正常に閉じられた直後の復元位置を、当該ZIP自身へ含める。
// 複数ZIPの途中のものを復元しても「全件保存済み」と誤認させない。
async function checkpointFile(state, previous, archive, job, endIndex, zipNumber, failedItems, failures, totalSelected) {
  const isFinal = endIndex >= totalSelected;
  const noFailures = !failedItems;
  const checkpointArchive = {
    ...archive,
    status: isFinal ? 'archive_complete' : 'archive_paused',
    pauseReason: isFinal ? null : 'imported',
    nextItemIndex: endIndex,
    nextZipNumber: zipNumber + 1,
    savedZipCount: Number(archive.savedZipCount || 0) + 1,
    processedItems: endIndex,
    totalSelected,
    failedItems,
    failures,
    progress: totalSelected ? endIndex / totalSelected : 1,
    currentZipNumber: zipNumber + 1,
    currentFileCount: 0,
    completedAt: isFinal ? Date.now() : null,
    completionAcknowledged: true
  };
  const checkpoint = { ...state, archive: checkpointArchive };
  if (isFinal && noFailures) {
    checkpoint.savedKinds = { ...(state.savedKinds || {}) };
    checkpoint.deltaSavedKinds = { ...(state.deltaSavedKinds || {}) };
    if (job.selection?.images) { checkpoint.savedKinds.images = true; if (state.deltaMode) checkpoint.deltaSavedKinds.images = true; }
    if (job.selection?.videos) { checkpoint.savedKinds.videos = true; if (state.deltaMode) checkpoint.deltaSavedKinds.videos = true; }
  }
  const payload = SMZBackup.accountEnvelope(checkpoint, previous, { zipNumber, mediaKind: job.mediaKind });
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  let compressed = raw;
  let method = 0;
  if (typeof CompressionStream === 'function') {
    try {
      const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const zipped = new Uint8Array(await new Response(stream).arrayBuffer());
      if (zipped.length < raw.length) { compressed = zipped; method = 8; }
    } catch { /* 古いChromeでは無圧縮で格納 */ }
  }
  return { name: `${archiveRoot(job)}/backup-state.json`, data: compressed,
    uncompressedSize: raw.length, checksum: crc32(raw), method, postedAt: Date.now() };
}

async function runArchiveDirectory(job, state, previous, archive, items, limits, index, zipNumber, failedItems, failures, runLimit) {
  let runDownloaded = 0;
  let pending = null;
  const configuredByteLimit = Number.isFinite(limits.bytes) ? limits.bytes : Infinity;
  const effectiveByteLimit = Math.min(configuredByteLimit, ZIP32_SAFE_BYTES);

  while (index < items.length && runDownloaded < runLimit) {
    if (cancelRequested) {
      await patchArchive(job.handle, { status: 'archive_paused', lastError: null });
      return;
    }

    const chunkStartIndex = index;
    let chunkCount = 0;
    let chunkBytes = 0;
    let consumedIndex = index;
    let writer = null;
    const filename = archiveFilename(job.handle, archive.startedAt || state.archive?.startedAt || Date.now(), job.mediaKind || archive.mediaKind || mediaKindFromSelection(job.selection), zipNumber, job.platform);

    try {
      while (index < items.length && runDownloaded < runLimit) {
        if (cancelRequested) break;

        const item = items[index];
        let fetched;
        if (pending && pending.index === index) {
          fetched = pending.fetched;
          pending = null;
        } else {
          try {
            fetched = await fetchMedia(item);
          } catch (error) {
            if (error.message === 'cancelled') break;
            failedItems++;
            failures.push({ key: item.key, error: String(error.message || error) });
            if (failures.length > 100) failures.shift();
            index++;
            consumedIndex = index;
            await patchArchive(job.handle, {
              status: 'archiving',
              processedItems: index,
              failedItems,
              failures,
              currentZipNumber: zipNumber,
              currentFileCount: chunkCount,
              batchSaved: runDownloaded,
              progress: index / items.length
            });
            continue;
          }
        }

        const wouldExceedSize = chunkCount > 0 && (chunkBytes + fetched.data.length > effectiveByteLimit);
        const wouldExceedCount = chunkCount > 0 && (chunkCount + 1 > limits.files);
        if (wouldExceedSize || wouldExceedCount) {
          // 次のZIPで同じファイルを再ダウンロードしないよう、1件だけメモリに保持する。
          pending = { index, fetched };
          break;
        }

        if (!writer) writer = await createDirectZipWriter(job.saveDirectoryKey, filename);
        const folder = item.type === 'video' ? 'videos' : 'images';
        const ext = fetched.extension || item.extension || (item.type === 'video' ? 'mp4' : 'jpg');
        await writer.add({
          name: `${archiveRoot(job)}/${folder}/${item.postId}_${item.mediaIndex}.${ext}`,
          data: fetched.data,
          postedAt: item.postedAt
        });
        chunkBytes += fetched.data.length;
        chunkCount++;
        index++;
        consumedIndex = index;
        runDownloaded++;

        await patchArchive(job.handle, {
          status: 'archiving',
          processedItems: index,
          failedItems,
          failures,
          currentZipNumber: zipNumber,
          currentFileCount: chunkCount,
          batchSaved: runDownloaded,
          progress: index / items.length
        });

        if (chunkBytes >= effectiveByteLimit || chunkCount >= limits.files) break;
      }

      if (cancelRequested) {
        if (writer) await writer.abort();
        await patchArchive(job.handle, {
          status: 'archive_paused',
          nextItemIndex: chunkStartIndex,
          currentZipNumber: zipNumber,
          currentFileCount: 0,
          lastError: null
        });
        return;
      }

      if (!writer || !chunkCount) {
        if (consumedIndex > chunkStartIndex) {
          await patchArchive(job.handle, {
            nextItemIndex: consumedIndex,
            processedItems: consumedIndex,
            failedItems,
            failures,
            progress: consumedIndex / items.length
          });
          continue;
        }
        throw new Error('ZIPへ追加できるファイルがありません');
      }

      await patchArchive(job.handle, {
        status: 'archiving',
        currentZipNumber: zipNumber,
        currentFileCount: chunkCount,
        lastError: null
      });

      await writer.add(await checkpointFile(state, previous, archive, job, consumedIndex,
        zipNumber, failedItems, failures, items.length));
      await writer.finalize();
      writer = null;

      state = await patchArchive(job.handle, {
        status: 'archiving',
        nextItemIndex: consumedIndex,
        nextZipNumber: zipNumber + 1,
        savedZipCount: (archive.savedZipCount || 0) + 1,
        processedItems: consumedIndex,
        failedItems,
        failures,
        currentZipNumber: zipNumber + 1,
        currentFileCount: 0,
        batchSaved: runDownloaded,
        progress: consumedIndex / items.length
      });
      archive = state.archive || archive;
      zipNumber++;
    } catch (error) {
      if (writer) await writer.abort();
      throw error;
    }
  }

  if (index < items.length && runDownloaded >= runLimit) {
    await patchArchive(job.handle, {
      status: 'archive_paused',
      pauseReason: 'batch_limit',
      nextItemIndex: index,
      processedItems: index,
      batchSaved: runDownloaded,
      currentFileCount: 0,
      progress: index / items.length,
      lastError: null
    });
    return;
  }

  await patchArchive(job.handle, {
    status: 'archive_complete',
    nextItemIndex: items.length,
    processedItems: items.length,
    failedItems,
    failures,
    currentFileCount: 0,
    progress: 1,
    completedAt: Date.now(),
    lastError: null
  });
}

async function waitForDownload(downloadId) {
  // 保存開始済みのZIPは途中で壊さない。中止要求が来ても、このZIPだけは完了を待つ。
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const result = await runtimeMessage({ type: 'SMZ_CHECK_DOWNLOAD', downloadId });
    if (!result?.ok) throw new Error(result?.error || 'ダウンロード状態を確認できません');
    if (result.state === 'complete') return result;
    if (result.state === 'interrupted' || result.state === 'missing') throw new Error(result.error || 'ZIPの保存が中断されました');
  }
}

function selectedItems(state, selection) {
  return (state.items || []).filter((item) =>
    (item.type === 'image' && selection.images) || (item.type === 'video' && selection.videos)
  );
}

async function patchArchive(handle, patch) {
  const result = await runtimeMessage({
    type: 'SMZ_ARCHIVE_PATCH',
    platform: activeJob?.platform || 'x',
    handle,
    patch
  });
  if (!result?.ok) throw new Error(result?.error || '進捗保存に失敗しました');
  return result.state;
}

async function saveChunk(handle, startedAt, mediaKind, zipNumber, files, job) {
  const blob = buildZipBlob(files);
  const filename = archiveFilename(handle, startedAt, mediaKind, zipNumber, job.platform);

  if (job.saveMode === 'directory' && job.saveDirectoryKey && globalThis.SMZFileSystem) {
    try {
      const saved = await SMZFileSystem.writeBlob(job.saveDirectoryKey, filename, blob);
      return { filename: saved.filename || filename, bytes: blob.size, saveMode: 'directory' };
    } catch (error) {
      if (['SAVE_PERMISSION_REQUIRED', 'SAVE_DIRECTORY_MISSING'].includes(error?.code)) {
        const wrapped = new Error(error.message || '保存先フォルダへのアクセス権がありません');
        wrapped.code = error.code;
        throw wrapped;
      }
      throw error;
    }
  }

  const blobUrl = URL.createObjectURL(blob);
  try {
    const started = await runtimeMessage({ type: 'SMZ_DOWNLOAD_BLOB', url: blobUrl, filename });
    if (!started?.ok) throw new Error(started?.error || 'ZIPダウンロードを開始できません');
    await waitForDownload(started.downloadId);
    return { filename, bytes: blob.size, saveMode: 'downloads' };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function runArchive(job) {
  cancelRequested = false;
  activeJob = job;

  const stateResult = await runtimeMessage({ type: 'SMZ_ARCHIVE_GET_STATE', platform: job.platform || 'x', handle: job.handle });
  if (!stateResult?.ok || !stateResult.state) throw new Error(stateResult?.error || '収集データを読み込めません');
  let state = stateResult.state;
  const previous = stateResult.previous || null;
  let archive = state.archive || {};
  const items = selectedItems(state, job.selection);
  const limits = LIMITS[job.splitMode] || LIMITS.auto;
  let index = Math.min(archive.nextItemIndex || 0, items.length);
  let zipNumber = Math.max(1, archive.nextZipNumber || 1);
  let failedItems = archive.failedItems || 0;
  const failures = Array.isArray(archive.failures) ? archive.failures.slice(-100) : [];
  const runLimit = Number(job.runLimit) === 5 ? 5 : Infinity;
  let runDownloaded = 0;

  if (!items.length) throw new Error('選択されたメディアがありません');

  await patchArchive(job.handle, {
    status: 'archiving',
    totalSelected: items.length,
    currentZipNumber: zipNumber,
    processedItems: index,
    progress: items.length ? index / items.length : 0,
    runLimit: Number.isFinite(runLimit) ? runLimit : null,
    pauseReason: null,
    batchSaved: 0,
    lastError: null
  });

  // File System Access APIで保存先フォルダを選んだ場合は、ZIPをディスクへ直接
  // ストリーミング書き込みする。500件級でも全ファイルをメモリへ抱え込まない。
  if (job.saveMode === 'directory' && job.saveDirectoryKey && globalThis.SMZFileSystem?.openWritableFile) {
    return runArchiveDirectory(job, state, previous, archive, items, limits, index, zipNumber, failedItems, failures, runLimit);
  }

  while (index < items.length && runDownloaded < runLimit) {
    if (cancelRequested) {
      await patchArchive(job.handle, { status: 'archive_paused', lastError: null });
      return;
    }

    const chunk = [];
    let chunkBytes = 0;
    const chunkStartIndex = index;
    let consumedIndex = index;

    while (index < items.length && runDownloaded < runLimit) {
      if (cancelRequested) break;
      const item = items[index];
      let fetched;
      try {
        fetched = await fetchMedia(item);
      } catch (error) {
        if (error.message === 'cancelled') break;
        failedItems++;
        failures.push({ key: item.key, error: String(error.message || error) });
        if (failures.length > 100) failures.shift();
        index++;
        consumedIndex = index;
        await patchArchive(job.handle, {
          status: 'archiving',
          processedItems: index,
          failedItems,
          failures,
          currentZipNumber: zipNumber,
          currentFileCount: chunk.length,
          progress: index / items.length
        });
        continue;
      }

      const wouldExceedSize = chunk.length > 0 && (chunkBytes + fetched.data.length > limits.bytes);
      const wouldExceedCount = chunk.length > 0 && (chunk.length + 1 > limits.files);
      if (wouldExceedSize || wouldExceedCount) break;

      const folder = item.type === 'video' ? 'videos' : 'images';
      const ext = fetched.extension || item.extension || (item.type === 'video' ? 'mp4' : 'jpg');
      chunk.push({
        name: `${archiveRoot(job)}/${folder}/${item.postId}_${item.mediaIndex}.${ext}`,
        data: fetched.data,
        postedAt: item.postedAt
      });
      chunkBytes += fetched.data.length;
      index++;
      consumedIndex = index;
      runDownloaded++;

      await patchArchive(job.handle, {
        status: 'archiving',
        processedItems: index,
        failedItems,
        failures,
        currentZipNumber: zipNumber,
        currentFileCount: chunk.length,
        batchSaved: runDownloaded,
        progress: index / items.length
      });

      if (chunkBytes >= limits.bytes || chunk.length >= limits.files) break;
    }

    if (cancelRequested) {
      await patchArchive(job.handle, {
        status: 'archive_paused',
        nextItemIndex: chunkStartIndex,
        currentZipNumber: zipNumber,
        currentFileCount: 0,
        lastError: null
      });
      return;
    }

    if (!chunk.length) {
      // 取得失敗だけで進んだ区間。次回同じ失敗で詰まらないよう進捗は保存する。
      if (consumedIndex > chunkStartIndex) {
        await patchArchive(job.handle, {
          nextItemIndex: consumedIndex,
          processedItems: consumedIndex,
          failedItems,
          failures,
          progress: consumedIndex / items.length
        });
        continue;
      }
      throw new Error('ZIPへ追加できるファイルがありません');
    }

    await patchArchive(job.handle, {
      status: 'archiving',
      currentZipNumber: zipNumber,
      currentFileCount: chunk.length,
      lastError: null
    });

    chunk.push(await checkpointFile(state, previous, archive, job, consumedIndex,
      zipNumber, failedItems, failures, items.length));
    await saveChunk(job.handle, archive.startedAt || state.archive?.startedAt || Date.now(), job.mediaKind || archive.mediaKind || mediaKindFromSelection(job.selection), zipNumber, chunk, job);

    state = await patchArchive(job.handle, {
      status: 'archiving',
      nextItemIndex: consumedIndex,
      nextZipNumber: zipNumber + 1,
      savedZipCount: (archive.savedZipCount || 0) + 1,
      processedItems: consumedIndex,
      failedItems,
      failures,
      currentZipNumber: zipNumber + 1,
      currentFileCount: 0,
      batchSaved: runDownloaded,
      progress: consumedIndex / items.length
    });
    archive = state.archive || archive;
    zipNumber++;
  }

  if (index < items.length && runDownloaded >= runLimit) {
    await patchArchive(job.handle, {
      status: 'archive_paused',
      pauseReason: 'batch_limit',
      nextItemIndex: index,
      processedItems: index,
      batchSaved: runDownloaded,
      currentFileCount: 0,
      progress: index / items.length,
      lastError: null
    });
    return;
  }

  await patchArchive(job.handle, {
    status: 'archive_complete',
    nextItemIndex: items.length,
    processedItems: items.length,
    failedItems,
    failures,
    currentFileCount: 0,
    progress: 1,
    completedAt: Date.now(),
    lastError: null
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return;

  if (message.type === 'SMZ_OFFSCREEN_GET_STATUS') {
    sendResponse({ active: !!activeJob, handle: activeJob?.handle || null, platform: activeJob?.platform || null });
    return true;
  }

  if (message.type === 'SMZ_OFFSCREEN_CLEAR_HANDLES') {
    if (activeJob) {
      sendResponse({ ok: false, error: 'ZIP保存中は初期化できません' });
      return true;
    }
    Promise.resolve().then(() => SMZFileSystem.clearAllHandles())
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'SMZ_OFFSCREEN_STOP_ARCHIVE') {
    cancelRequested = true;
    return;
  }

  if (message.type === 'SMZ_OFFSCREEN_START_ARCHIVE') {
    if (activeJob) return;
    const job = {
      platform: message.platform || 'x',
      handle: message.handle,
      selection: message.selection,
      mediaKind: message.mediaKind || mediaKindFromSelection(message.selection),
      splitMode: message.splitMode,
      runLimit: message.runLimit,
      saveMode: message.saveMode || 'downloads',
      saveDirectoryKey: message.saveDirectoryKey || null,
      saveDirectoryName: message.saveDirectoryName || null
    };
    runArchive(job)
      .catch(async (error) => {
        const messageText = String(error?.message || error || '');
        if (messageText === 'cancelled') return;
        const userCancelled = /USER_CANCELED|USER_CANCELLED/i.test(messageText);
        const savePermission = ['SAVE_PERMISSION_REQUIRED', 'SAVE_DIRECTORY_MISSING'].includes(error?.code);
        try {
          if (userCancelled) {
            await patchArchive(job.handle, {
              status: 'archive_paused',
              pauseReason: 'user_cancelled',
              lastError: null
            });
          } else if (savePermission) {
            await patchArchive(job.handle, {
              status: 'archive_paused',
              pauseReason: 'save_permission',
              lastError: messageText
            });
          } else {
            await patchArchive(job.handle, { status: 'archive_error', lastError: messageText });
          }
        } catch {}
      })
      .finally(() => {
        activeJob = null;
        cancelRequested = false;
      });
  }
});
