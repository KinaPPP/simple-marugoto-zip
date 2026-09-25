'use strict';
// Blueskyの公開APIとAT Protocolの公開Blobのみを使用。認証情報を送らない。
// DOMのメディアタブ表示と無関係に投稿レコード上の本人添付メディアだけを収集。
(() => {
  const APPVIEW = 'https://public.api.bsky.app';
  const MAX_PAGE = 100;
  const HANDLE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i;
  const DID = /^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.:%_-]+)$/i;
  const CID = /^[a-zA-Z0-9]{20,150}$/;
  function validActor(actor) { return typeof actor === 'string' && (HANDLE.test(actor) || DID.test(actor)); }
  function rkey(uri) {
    const match = /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/([^/?#]+)$/.exec(String(uri || ''));
    return match && /^[a-zA-Z0-9._~-]{1,80}$/.test(match[1]) ? match[1] : null;
  }
  function cidFrom(blob) {
    const value = blob?.ref?.$link || blob?.ref?.toString?.() || null;
    return CID.test(String(value || '')) ? String(value) : null;
  }
  function httpsUrl(host, path, params) {
    const url = new URL(path, host);
    for (const [key, value] of Object.entries(params || {})) if (value !== undefined && value !== null) url.searchParams.set(key, value);
    return url.toString();
  }
  async function json(url, fetcher = fetch) {
    const response = await fetcher(url, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) {
      const error = new Error(`Bluesky API: HTTP ${response.status}`);
      error.status = response.status;
      const retry = Number(response.headers?.get('retry-after'));
      if (Number.isFinite(retry) && retry > 0) error.retryAfter = retry;
      throw error;
    }
    return response.json();
  }
  async function profile(actor, fetcher = fetch) {
    if (!validActor(actor)) throw new Error('Blueskyのアカウント名を確認できません');
    const data = await json(httpsUrl(APPVIEW, '/xrpc/app.bsky.actor.getProfile', { actor }), fetcher);
    if (!DID.test(String(data.did || '')) || !HANDLE.test(String(data.handle || ''))) {
      throw new Error('Blueskyのアカウント情報を取得できません');
    }
    return { did: data.did, handle: data.handle.toLowerCase() };
  }
  function didDocumentUrl(did) {
    if (did.startsWith('did:plc:')) return `https://plc.directory/${encodeURIComponent(did)}`;
    if (did.startsWith('did:web:')) {
      const parts = did.slice(8).split(':').map(decodeURIComponent);
      if (!parts.length || !/^[a-z0-9.-]+$/i.test(parts[0]) || parts[0] === 'localhost') throw new Error('DID Webが不正です');
      return `https://${parts[0]}/${parts.length === 1 ? '.well-known/' : parts.slice(1).map(encodeURIComponent).join('/') + '/'}did.json`;
    }
    throw new Error('未対応のDIDです');
  }
  function allowedPds(urlString) {
    try {
      const u = new URL(urlString);
      if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return null;
      // Public DID documents must not turn the extension into a proxy for local-network hosts.
      if (!/^[a-z0-9.-]+$/i.test(u.hostname) || u.hostname === 'localhost' ||
          /\.(?:local|localhost|internal|test|invalid)$/.test(u.hostname)) return null;
      if (/^(?:0|10|127|169\.254|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./.test(u.hostname)) return null;
      return `${u.origin}`;
    } catch { return null; }
  }
  async function resolvePds(did, fetcher = fetch) {
    const doc = await json(didDocumentUrl(did), fetcher);
    const service = (doc.service || []).find(s => s.type === 'AtprotoPersonalDataServer' || s.id === '#atproto_pds');
    const endpoint = allowedPds(service?.serviceEndpoint);
    if (!endpoint) throw new Error('BlueskyのPDSを特定できません');
    return endpoint;
  }
  function blobUrl(pds, did, cid) {
    if (!allowedPds(pds) || !DID.test(did) || !CID.test(cid)) return null;
    return httpsUrl(pds, '/xrpc/com.atproto.sync.getBlob', { did, cid });
  }
  async function page(did, cursor, fetcher = fetch) {
    if (!DID.test(did)) throw new Error('投稿者のDIDが不正です');
    const params = { actor: did, filter: 'posts_with_media', limit: String(MAX_PAGE), includePins: 'false' };
    if (cursor) params.cursor = cursor;
    const result = await json(httpsUrl(APPVIEW, '/xrpc/app.bsky.feed.getAuthorFeed', params), fetcher);
    if (!Array.isArray(result.feed)) throw new Error('Bluesky APIの応答形式が変わりました');
    return { feed: result.feed, cursor: typeof result.cursor === 'string' ? result.cursor : null };
  }
  function extract(entry, did, pds) {
    const post = entry?.post;
    // リポストや他人の引用元・リンクカードのメディアは含めない。
    if (!post || post.author?.did !== did || !post.uri || !post.record) return null;
    const postId = rkey(post.uri);
    if (!postId) return null;
    const embed = post.record.embed;
    if (!embed) return { postId, items: [] };
    const recordMedia = embed.$type === 'app.bsky.embed.recordWithMedia' ? embed.media : embed;
    const postedAt = post.record.createdAt || post.indexedAt || null;
    const items = [];
    if (recordMedia?.$type === 'app.bsky.embed.images') {
      const views = post.embed?.$type === 'app.bsky.embed.recordWithMedia#view' ? post.embed.media?.images : post.embed?.images;
      (recordMedia.images || []).slice(0, 10).forEach((img, i) => {
        const cid = cidFrom(img.image);
        const url = blobUrl(pds, did, cid);
        if (!url) return;
        const fallback = views?.[i]?.fullsize;
        const fallbackUrls = typeof fallback === 'string' && /^https:\/\/cdn\.bsky\.app\//.test(fallback) ? [fallback] : [];
        const ext = String(img.image?.mimeType || '').split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
        items.push({ platform: 'bluesky', key: `${postId}_${i+1}`, postId, mediaIndex: i+1,
          type: 'image', url, fallbackUrls, extension: ext, postedAt, cid });
      });
    } else if (recordMedia?.$type === 'app.bsky.embed.video') {
      const cid = cidFrom(recordMedia.video);
      const url = blobUrl(pds, did, cid);
      if (url) {
        const ext = String(recordMedia.video?.mimeType || 'video/mp4').split('/')[1] || 'mp4';
        items.push({ platform: 'bluesky', key: `${postId}_1`, postId, mediaIndex: 1,
          type: 'video', url, fallbackUrls: [], extension: ext, postedAt, cid });
      }
    }
    return { postId, items };
  }
  globalThis.SMZBluesky = Object.freeze({ profile, resolvePds, page, extract, validActor, rkey, allowedPds, blobUrl });
})();
