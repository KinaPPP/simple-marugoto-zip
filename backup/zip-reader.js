'use strict';
// ZIPの末尾にある中央ディレクトリから backup-state.json だけを読み取る。
// 1GBのZIP全体をFileReaderへ展開しない。ZIP64/暗号化ZIPは非対応。
(() => {
  const enc = new TextDecoder('utf-8', { fatal: true });
  const MAX_COMPRESSED = 64 * 1024 * 1024;
  const MAX_UNCOMPRESSED = 128 * 1024 * 1024;
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); crcTable[i] = c >>> 0; }
  function crc32(bytes) { let c = 0xFFFFFFFF; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function assertRange(file, from, count) { if (!Number.isSafeInteger(from) || !Number.isSafeInteger(count) || from < 0 || count < 0 || from + count > file.size) throw new Error('ZIPの構造が壊れています'); }
  async function readBytes(file, from, count) { assertRange(file, from, count); return new Uint8Array(await file.slice(from, from + count).arrayBuffer()); }
  async function accountJsonFromZip(file) {
    if (!file || file.size < 22) throw new Error('ZIPファイルが空、または壊れています');
    const tailStart = Math.max(0, file.size - 65557);
    const tail = await readBytes(file, tailStart, file.size - tailStart);
    let end = -1;
    for (let pos = tail.length - 22; pos >= 0; pos--) {
      if (tail[pos] === 0x50 && tail[pos + 1] === 0x4b && tail[pos + 2] === 0x05 && tail[pos + 3] === 0x06) {
        const view = new DataView(tail.buffer, tail.byteOffset + pos);
        if (pos + 22 + view.getUint16(20, true) === tail.length) { end = pos; break; }
      }
    }
    if (end < 0) throw new Error('ZIPの終端情報が見つかりません');
    const footer = new DataView(tail.buffer, tail.byteOffset + end);
    const entries = footer.getUint16(10, true);
    const directorySize = footer.getUint32(12, true);
    const directoryOffset = footer.getUint32(16, true);
    if (entries === 65535 || directorySize === 0xFFFFFFFF || directoryOffset === 0xFFFFFFFF) throw new Error('ZIP64形式には未対応です');
    if (directorySize > 16 * 1024 * 1024) throw new Error('ZIPのファイル一覧が大きすぎます');
    const central = await readBytes(file, directoryOffset, directorySize);
    let at = 0;
    let chosen = null;
    let readCount = 0;
    while (at < central.length) {
      if (at + 46 > central.length) throw new Error('ZIP内のファイル一覧が壊れています');
      const view = new DataView(central.buffer, central.byteOffset + at);
      if (view.getUint32(0, true) !== 0x02014b50) throw new Error('ZIP内のファイル一覧が壊れています');
      const flags = view.getUint16(8, true);
      const method = view.getUint16(10, true);
      const crc = view.getUint32(16, true);
      const compressed = view.getUint32(20, true);
      const uncompressed = view.getUint32(24, true);
      const nameLength = view.getUint16(28, true);
      const extraLength = view.getUint16(30, true);
      const commentLength = view.getUint16(32, true);
      const localOffset = view.getUint32(42, true);
      const entryLength = 46 + nameLength + extraLength + commentLength;
      if (at + entryLength > central.length) throw new Error('ZIP内のファイル名が壊れています');
      const name = enc.decode(central.subarray(at + 46, at + 46 + nameLength));
      if (/^[a-z0-9_.-]{1,253}\/backup-state\.json$/.test(name)) {
        if (chosen) throw new Error('ZIP内に状態ファイルが複数あります');
        if (flags & 1 || ![0, 8].includes(method)) throw new Error('暗号化・未対応の圧縮形式です');
        if (compressed > MAX_COMPRESSED || uncompressed > MAX_UNCOMPRESSED) throw new Error('状態ファイルが大きすぎます');
        chosen = { name, method, crc, compressed, uncompressed, localOffset };
      }
      at += entryLength;
      readCount++;
      if (readCount > 65535) throw new Error('ZIPの項目数が多すぎます');
    }
    if (!chosen) throw new Error('このZIPには backup-state.json がありません（v0.0.21以降のZIPを指定してください）');
    const header = await readBytes(file, chosen.localOffset, 30);
    const local = new DataView(header.buffer);
    if (local.getUint32(0, true) !== 0x04034b50 || local.getUint16(8, true) !== chosen.method) throw new Error('ZIP内部ヘッダーが一致しません');
    const nameLength = local.getUint16(26, true);
    const extraLength = local.getUint16(28, true);
    const filename = enc.decode(await readBytes(file, chosen.localOffset + 30, nameLength));
    if (filename !== chosen.name) throw new Error('ZIP内の状態ファイル名が一致しません');
    const compressed = await readBytes(file, chosen.localOffset + 30 + nameLength + extraLength, chosen.compressed);
    let plain = compressed;
    if (chosen.method === 8) {
      if (typeof DecompressionStream !== 'function') throw new Error('このChromeはZIP内状態ファイルの展開に対応していません');
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const reader = stream.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > MAX_UNCOMPRESSED) throw new Error('状態ファイルの展開サイズが上限を超えています');
          chunks.push(value);
        }
      } catch (error) { try { await reader.cancel(); } catch {} throw error; }
      plain = new Uint8Array(total);
      let pos = 0;
      for (const chunk of chunks) { plain.set(chunk, pos); pos += chunk.length; }
    }
    if (plain.length !== chosen.uncompressed || crc32(plain) !== chosen.crc) throw new Error('ZIP内の状態ファイルのCRCが一致しません');
    return SMZBackup.parseJson(enc.decode(plain));
  }
  globalThis.SMZZipReader = Object.freeze({ accountJsonFromZip });
})();
