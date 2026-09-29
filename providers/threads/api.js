'use strict';
// Threads Graph API provider. Never persist, return or follow paging.next: it may contain access_token.
(() => {
  const ROOT = 'https://graph.threads.net';
  const API = ROOT + '/v1.0';
  const FIELDS = 'id,media_type,media_url,thumbnail_url,children,timestamp,permalink,username';
  const HANDLE = /^[a-z0-9_](?:[a-z0-9._]{0,28}[a-z0-9_])?$/i;
  const ID = /^\d{5,30}$/;
  function validHandle(value) { return typeof value === 'string' && HANDLE.test(value) && !value.includes('..'); }
  function validId(value) { return ID.test(String(value || '')); }
  function mediaUrl(input) {
    try {
      if (typeof input !== 'string' || input.length > 4096) return null;
      const url = new URL(input);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
      if (!/(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(url.hostname.toLowerCase())) return null;
      // OAuth credentials must never be imported from an API response as media URLs.
      if ([...url.searchParams.keys()].some(k => /(?:access.?token|authorization|client.?secret|app.?secret|api.?key|password)/i.test(k))) return null;
      return url.toString();
    } catch { return null; }
  }
  async function requestAt(base, path, params, token, fetcher = fetch) {
    if (!token || typeof token !== 'string') throw new Error('Threadsに接続してください');
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(params || {})) if (value != null) url.searchParams.set(key, String(value));
    const response = await fetcher(url.toString(), {
      method: 'GET', credentials: 'omit', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      // Meta error bodies may contain sensitive request identifiers or echoed URL/token.
      const error = new Error(response.status === 401 || response.status === 403
        ? 'Threadsの認証・閲覧権限を確認してください'
        : `Threads API HTTP ${response.status}`);
      error.status = response.status;
      const retry = response.headers?.get('retry-after');
      if (retry) {
        const seconds = Number(retry);
        error.retryAfter = Number.isFinite(seconds) ? Math.max(0, seconds) : Math.max(0, (Date.parse(retry) - Date.now()) / 1000 || 0);
      }
      throw error;
    }
    const json = await response.json();
    if (!json || typeof json !== 'object' || json.error) throw new Error('Threads APIの応答を確認できません');
    return json;
  }
  async function request(path, params, token, fetcher = fetch) {
    return requestAt(API, path, params, token, fetcher);
  }
  async function refresh(token, fetcher = fetch) {
    if (!token || typeof token !== 'string') throw new Error('Threadsに接続してください');
    // Metaの更新エンドポイントはAPIルート直下。既存Crosspostで実機確認済みの形式に合わせ、
    // 長期トークンはaccess_tokenクエリとして渡す（client_secretは不要）。
    const url = new URL(ROOT + '/refresh_access_token');
    url.searchParams.set('grant_type', 'th_refresh_token');
    url.searchParams.set('access_token', token);
    const response = await fetcher(url.toString(), { method: 'GET', credentials: 'omit', cache: 'no-store' });
    if (!response.ok) {
      const error = new Error(response.status === 401 || response.status === 403
        ? 'Threadsの認証・閲覧権限を確認してください'
        : `Threads API HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const json = await response.json();
    if (!json || typeof json !== 'object' || json.error) throw new Error('Threads APIの更新応答を確認できません');
    return json;
  }
  async function me(token, fetcher = fetch) {
    const data = await request('/me', { fields: 'id,username' }, token, fetcher);
    if (!validId(data.id) || !validHandle(data.username)) throw new Error('Threadsの本人情報を確認できません');
    return { id: String(data.id), handle: data.username.toLowerCase() };
  }
  async function profile(handle, token, ownProfile = null, fetcher = fetch) {
    if (!validHandle(handle)) throw new Error('Threadsのユーザー名が不正です');
    if (ownProfile?.handle === handle.toLowerCase()) return { handle: ownProfile.handle, own: true };
    const data = await request('/profile_lookup', { username: handle }, token, fetcher);
    if (!validHandle(data.username)) throw new Error('公開プロフィールを取得できません（アプリ審査または対象アカウントの制限を確認してください）');
    return { handle: data.username.toLowerCase(), own: false };
  }
  async function page(profileInfo, cursor, token, fetcher = fetch) {
    if (!validHandle(profileInfo?.handle)) throw new Error('Threadsの対象アカウントを確認できません');
    if (cursor && (typeof cursor !== 'string' || cursor.length > 2048)) throw new Error('Threadsのページ位置が不正です');
    const path = profileInfo.own ? '/me/threads' : '/profile_posts';
    const params = { fields: FIELDS, limit: 50 };
    if (!profileInfo.own) params.username = profileInfo.handle;
    if (cursor) params.after = cursor;
    const response = await request(path, params, token, fetcher);
    if (!Array.isArray(response.data)) throw new Error('Threadsの投稿一覧の形式が変わりました');
    let nextCursor = typeof response.paging?.cursors?.after === 'string' ? response.paging.cursors.after : null;
    // Some API revisions only expose next URL. Read the cursor only; never follow/copy the URL.
    if (!nextCursor && response.paging?.next) {
      try { const next = new URL(response.paging.next); if (next.hostname === 'graph.threads.net') nextCursor = next.searchParams.get('after'); } catch {}
    }
    if (!response.paging?.next) nextCursor = null;
    if (nextCursor && nextCursor.length > 2048) throw new Error('Threadsのページ位置が長すぎます');
    return { data: response.data, cursor: nextCursor };
  }
  async function child(id, token, fetcher = fetch) {
    if (!validId(id)) throw new Error('ThreadsのカルーセルIDが不正です');
    return request('/' + id, { fields: 'id,media_type,media_url,thumbnail_url' }, token, fetcher);
  }
  async function extract(post, token, fetcher = fetch) {
    if (!validId(post?.id)) return null;
    const postId = String(post.id);
    if (post.media_type === 'REPOST_FACADE') return null;
    const postedAt = Number.isFinite(Date.parse(post.timestamp)) ? new Date(post.timestamp).toISOString() : null;
    const items = [];
    const make = (source, index) => {
      if (!['IMAGE','VIDEO'].includes(source?.media_type)) return;
      const url = mediaUrl(source.media_url);
      if (!url) throw new Error(`Threads投稿 ${postId} のメディアURLが無効です。取得できる投稿で再試行してください`);
      const type = source.media_type === 'VIDEO' ? 'video' : 'image';
      const ext = (() => { try { return /\.(png|webp|avif|gif)(?:$|\?)/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() || (type === 'video' ? 'mp4' : 'jpg'); } catch { return type === 'video' ? 'mp4' : 'jpg'; } })();
      items.push({ key: `${postId}_${index}`, platform: 'threads', postId, mediaIndex: index,
        type, url, fallbackUrls: [], postedAt, extension: ext, sourceType: source.media_type,
        mediaId: validId(source.id) ? String(source.id) : null });
    };
    if (post.media_type === 'CAROUSEL_ALBUM') {
      const children = Array.isArray(post.children) ? post.children : post.children?.data;
      if (!Array.isArray(children) || children.length < 1 || children.length > 20) {
        throw new Error(`Threads投稿 ${postId} のカルーセル情報を取得できません`);
      }
      for (const [i, raw] of children.entries()) {
        const c = typeof raw === 'string' ? { id: raw } : raw;
        if (!validId(c?.id)) throw new Error(`Threads投稿 ${postId} の子投稿IDが不正です`);
        const detail = c?.media_url && c?.media_type ? c : await child(c.id, token, fetcher);
        make(detail, i + 1);
      }
    } else if (post.media_type === 'IMAGE' || post.media_type === 'VIDEO') make(post, 1);
    return { postId, items };
  }
  globalThis.SMZThreads = Object.freeze({ validHandle, validId, mediaUrl, me, profile, page, child, extract, request, refresh });
})();
