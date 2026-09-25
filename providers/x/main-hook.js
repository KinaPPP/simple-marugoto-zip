(() => {
  if (window.__SMZ_X_HOOK_INSTALLED__) return;
  window.__SMZ_X_HOOK_INSTALLED__ = true;

  let enabled = false;
  let targetHandle = '';
  let requestSequence = 0;
  const seenPayloadTweets = new Set();
  // /media の初期レスポンスがcontent scriptの起動より早く届いても落とさない。
  // 受信側の準備完了まで直近のバッチだけ一時保持してから一度だけ再送する。
  let receiverReady = false;
  const earlyBatches = [];
  const MAX_EARLY_BATCHES = 12;

  try {
    const pendingHandle = sessionStorage.getItem('smz_x_collect_handle');
    if (pendingHandle) {
      enabled = true;
      targetHandle = pendingHandle.replace(/^@/, '').toLowerCase();
    }
  } catch {}

  const POST_SOURCE = 'simple-marugoto-zip';
  // X本体の機能フラグを利用する旧UI互換オプション（初期値OFF）。
  // Reactの内部構造はXが変更する可能性がある。取得できなければ何も変更せず、
  // 新UIの収集処理へ任せる。Control Panel等との併用時も既存関数をチェーンする。
  let revertProfileTabs = false;
  let lastReportedSplit = null;
  function inspectProfileLayout(forceReport = false) {
    if (typeof document === 'undefined') return;
    const root = document.getElementById('react-root');
    const first = root?.firstElementChild;
    if (!first) return;
    const propsKey = Object.keys(first).find((key) => key.startsWith('__reactProps'));
    const props = propsKey ? first[propsKey]?.children?.props?.children?.props : null;
    const switches = props?.contextProviderProps?.featureSwitches;
    if (typeof switches?.isTrue !== 'function') return;
    if (revertProfileTabs && switches.isTrue.__smzProfileOverride !== true) {
      const original = switches.isTrue;
      const wrapper = function (flag, ...args) {
        if (flag === 'responsive_web_profile_redesign_enabled') return false;
        return original.call(this, flag, ...args);
      };
      wrapper.__smzProfileOverride = true;
      switches.isTrue = wrapper;
    }
    let split;
    try { split = switches.isTrue('responsive_web_profile_redesign_enabled') === true; }
    catch { return; }
    // MAIN world can see the React flag before the isolated content script
    // installs its listener. Re-send the current layout when collection starts
    // rather than relying exclusively on the first, possibly lost message.
    if (forceReport || split !== lastReportedSplit) {
      lastReportedSplit = split;
      window.postMessage({ source: 'simple-marugoto-zip', type: 'SMZ_X_PROFILE_LAYOUT', split }, '*');
    }
  }
  // XのReactツリー構築を待つ。設定がOFFならUIの観察のみで、副作用はない。
  if (typeof setInterval === 'function') {
    const profileCheck = setInterval(inspectProfileLayout, 500);
    setTimeout(() => clearInterval(profileCheck), 30000);
  }

  function post(type, payload = {}) {
    window.postMessage({ source: POST_SOURCE, type, ...payload }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== POST_SOURCE) return;
    if (event.data.type === 'SMZ_X_UI_SETTINGS') {
      revertProfileTabs = event.data.revertProfileTabs === true;
      inspectProfileLayout(true);
      return;
    }
    if (event.data.type === 'SMZ_X_CONTROL') {
      enabled = !!event.data.enabled;
      targetHandle = String(event.data.handle || '').replace(/^@/, '').toLowerCase();
      if (!enabled) {
        receiverReady = false;
        seenPayloadTweets.clear();
        earlyBatches.length = 0;
      } else {
        receiverReady = true;
        for (const batch of earlyBatches) post('SMZ_X_MEDIA_BATCH', batch);
        earlyBatches.length = 0;
      }
      inspectProfileLayout(true);
    }
  });

  function isRelevantUrl(url) {
    if (!url) return false;
    // 新UIでGraphQLのoperation名が変わってもメディア投稿を見落とさない。
    // 収集対象ユーザーの認証・メディア検査はextractFromTweet側で別途行う。
    return /\/i\/api\/graphql\//.test(url);
  }

  function beginRelevantRequest(requestUrl) {
    const requestId = `xreq_${Date.now()}_${++requestSequence}`;
    post('SMZ_X_REQUEST_START', { requestId, requestUrl });
    return requestId;
  }

  function endRelevantRequest(requestId, requestUrl, status = 0) {
    if (!requestId) return;
    post('SMZ_X_REQUEST_END', {
      requestId,
      requestUrl,
      status: Number(status) || 0
    });
  }

  function normalizeExtension(value) {
    const ext = String(value || '').toLowerCase().replace(/^\./, '');
    if (ext === 'jpeg') return 'jpg';
    if (/^[a-z0-9]{2,5}$/.test(ext)) return ext;
    return 'jpg';
  }

  function buildImageVariants(rawUrl) {
    try {
      const url = new URL(rawUrl);
      let format = url.searchParams.get('format');
      if (!format) {
        const match = url.pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
        if (match) {
          format = match[1];
          url.pathname = url.pathname.slice(0, -match[0].length);
        }
      }
      format = normalizeExtension(format || 'jpg');
      url.searchParams.set('format', format);

      const variants = [];
      for (const name of ['orig', '4096x4096', 'large']) {
        const candidate = new URL(url.toString());
        candidate.searchParams.set('name', name);
        variants.push(candidate.toString());
      }
      return { url: variants[0], fallbackUrls: variants.slice(1), extension: format };
    } catch {
      return { url: rawUrl, fallbackUrls: [], extension: normalizeExtension(rawUrl.split('.').pop()) };
    }
  }

  function authorHandle(tweet) {
    const user = tweet?.author || tweet?.core?.user_results?.result || tweet?.user;
    if (!user || typeof user !== 'object') return '';
    return String(
      user?.core?.screen_name ||
      user?.legacy?.screen_name ||
      user?.screen_name ||
      ''
    ).toLowerCase();
  }

  function postedAtFromId(postId, legacy) {
    if (legacy?.created_at) {
      const parsed = Date.parse(legacy.created_at);
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
    try {
      const ms = Number((BigInt(postId) >> 22n) + 1288834974657n);
      return new Date(ms).toISOString();
    } catch {
      return null;
    }
  }

  function extractFromTweet(tweet) {
    const legacy = tweet?.legacy;
    if (!legacy || typeof legacy !== 'object') return [];
    const postId = String(legacy.id_str || tweet.rest_id || '');
    if (!/^\d+$/.test(postId)) return [];
    if (legacy.retweeted_status_id_str) return [];

    const author = authorHandle(tweet);
    if (targetHandle && author && author !== targetHandle) return [];
    if (targetHandle && !author) return [];

    const media = legacy?.extended_entities?.media;
    if (!Array.isArray(media) || !media.length) return [];

    const payloadKey = `${postId}:${targetHandle}`;
    if (seenPayloadTweets.has(payloadKey)) return [];
    seenPayloadTweets.add(payloadKey);

    const postedAt = postedAtFromId(postId, legacy);
    const items = [];

    for (let i = 0; i < media.length; i++) {
      const entity = media[i] || {};
      const mediaIndex = i + 1;

      if (entity.video_info?.variants?.length) {
        const mp4 = entity.video_info.variants
          .filter((variant) => variant?.url && (!variant.content_type || variant.content_type === 'video/mp4'))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        if (!mp4?.url) continue;
        items.push({
          key: `${postId}_${mediaIndex}`,
          platform: 'x',
          handle: targetHandle,
          postId,
          postedAt,
          mediaIndex,
          type: 'video',
          sourceType: entity.type || 'video',
          url: mp4.url,
          fallbackUrls: [],
          extension: 'mp4',
          width: entity.original_info?.width || null,
          height: entity.original_info?.height || null,
          bitrate: mp4.bitrate || 0
        });
        continue;
      }

      const rawImage = entity.media_url_https || entity.media_url;
      if (!rawImage) continue;
      const image = buildImageVariants(rawImage);
      items.push({
        key: `${postId}_${mediaIndex}`,
        platform: 'x',
        handle: targetHandle,
        postId,
        postedAt,
        mediaIndex,
        type: 'image',
        sourceType: entity.type || 'photo',
        url: image.url,
        fallbackUrls: image.fallbackUrls,
        extension: image.extension,
        width: entity.original_info?.width || null,
        height: entity.original_info?.height || null
      });
    }

    return items;
  }

  function extractMedia(root) {
    const items = [];
    const stack = [root];
    const visited = new Set();
    let inspected = 0;
    const MAX_OBJECTS = 120000;

    while (stack.length && inspected < MAX_OBJECTS) {
      const value = stack.pop();
      if (!value || typeof value !== 'object') continue;
      if (visited.has(value)) continue;
      visited.add(value);
      inspected++;

      if (value.legacy?.extended_entities?.media && (value.rest_id || value.legacy?.id_str)) {
        items.push(...extractFromTweet(value));
      }

      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) stack.push(value[i]);
      } else {
        for (const child of Object.values(value)) {
          if (child && typeof child === 'object') stack.push(child);
        }
      }
    }

    return items;
  }

  function rateLimitResumeAt(headers) {
    try {
      const retryAfter = Number(headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) return Date.now() + retryAfter * 1000;
      const reset = Number(headers.get('x-rate-limit-reset'));
      if (Number.isFinite(reset) && reset > 0) return reset * 1000;
    } catch {}
    return null;
  }

  async function inspectFetchResponse(response, requestUrl, requestId) {
    try {
      if (!enabled) return;
      if (response.status === 429) {
        post('SMZ_X_RATE_LIMIT', { resumeAt: rateLimitResumeAt(response.headers), requestUrl });
        return;
      }
      if (response.status === 401 || response.status === 403) {
        post('SMZ_X_AUTH_ERROR', { status: response.status, requestUrl });
        return;
      }
      if (!response.ok) return;
      try {
        const data = await response.json();
        const items = extractMedia(data);
        if (items.length) {
          const batch = { items, requestUrl };
          if (!receiverReady) {
            earlyBatches.push(batch);
            if (earlyBatches.length > MAX_EARLY_BATCHES) earlyBatches.shift();
          }
          post('SMZ_X_MEDIA_BATCH', batch);
        }
      } catch {}
    } finally {
      endRelevantRequest(requestId, requestUrl, response?.status || 0);
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const requestId = enabled && isRelevantUrl(requestUrl) ? beginRelevantRequest(requestUrl) : null;

    try {
      const response = await originalFetch.apply(this, args);
      if (requestId) {
        // X本体へレスポンスはすぐ返しつつ、複製したレスポンスの解析完了まで
        // 収集側には「処理中」と伝えて次スクロールを急がせない。
        void inspectFetchResponse(response.clone(), requestUrl || response.url, requestId);
      }
      return response;
    } catch (error) {
      if (requestId) endRelevantRequest(requestId, requestUrl, 0);
      throw error;
    }
  };

  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR) {
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function (method, url, ...rest) {
      this.__smzUrl = String(url || '');
      return originalOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.send = function (...args) {
      const requestUrl = this.__smzUrl || '';
      const requestId = enabled && isRelevantUrl(requestUrl) ? beginRelevantRequest(requestUrl) : null;

      if (requestId) {
        this.addEventListener('loadend', () => {
          try {
            if (!enabled) return;
            if (this.status === 429) {
              post('SMZ_X_RATE_LIMIT', { resumeAt: null, requestUrl });
              return;
            }
            if (this.status === 401 || this.status === 403) {
              post('SMZ_X_AUTH_ERROR', { status: this.status, requestUrl });
              return;
            }
            if (this.status < 200 || this.status >= 300) return;
            try {
              const data = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
              const items = extractMedia(data);
              if (items.length) {
                const batch = { items, requestUrl };
                if (!receiverReady) {
                  earlyBatches.push(batch);
                  if (earlyBatches.length > MAX_EARLY_BATCHES) earlyBatches.shift();
                }
                post('SMZ_X_MEDIA_BATCH', batch);
              }
            } catch {}
          } finally {
            endRelevantRequest(requestId, requestUrl, this.status || 0);
          }
        }, { once: true });
      }

      try {
        return originalSend.apply(this, args);
      } catch (error) {
        if (requestId) endRelevantRequest(requestId, requestUrl, 0);
        throw error;
      }
    };
  }
})();
