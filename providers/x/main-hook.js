(() => {
  if (window.__SMZ_X_HOOK_INSTALLED__) return;
  window.__SMZ_X_HOOK_INSTALLED__ = true;

  let enabled = false;
  let targetHandle = '';
  let requestSequence = 0;
  const seenPayloadMedia = new Set();
  const firstPayloadMediaCounts = new Map();
  const DIAGNOSTIC_POST_IDS=['2121977622796353698','2121951663368159350'];
  const DIAGNOSTIC_ASSET_IDS=['HXLHJ4JaQAA4Meo','HXLHLWRaAAAhEEY','HXLHNUQbkAAh-Pu','HXLHPJ-aYAAggMZ','HXLHRVbbUAAwYC5','HXLHTJebQAAou5D','HXLHU8ZaAAAxz5w','HXLHWs4aMAAq8iF'];
  const earlyCaptureDiagnostics=[];
  function reportCapture(diagnostic) {
    try {
      const value={version:'1.3.16',...diagnostic};
      if(!receiverReady){earlyCaptureDiagnostics.push(value);if(earlyCaptureDiagnostics.length>30)earlyCaptureDiagnostics.shift();}
      else post('SMZ_X_CAPTURE_DIAGNOSTIC',{diagnostic:value});
    } catch {}
  }
  // /media の初期レスポンスがcontent scriptの起動より早く届いても落とさない。
  // 登録完了のACKまで保持する。確認待ちや一時停止は受信準備完了と区別する。
  let receiverReady = false;
  const pendingBatches = new Map();
  let collectionId = '';
  let batchSequence = 0;
  let scopeGeneration = 0;
  const earlyDiagnostics = [];
  const MAX_PENDING_BATCHES = 120;

  try {
    const pendingHandle = sessionStorage.getItem('smz_x_collect_handle');
    if (pendingHandle) {
      enabled = true;
      targetHandle = pendingHandle.replace(/^@/, '').toLowerCase();
      collectionId = sessionStorage.getItem('smz_x_collect_id') || '';
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

  function clearCapture() {
    scopeGeneration++;
    seenPayloadMedia.clear();
    firstPayloadMediaCounts.clear();
    pendingBatches.clear();
    earlyDiagnostics.length = 0;
    earlyCaptureDiagnostics.length = 0;
  }

  function queueBatch(items, requestUrl) {
    if (!items.length) return;
    if (pendingBatches.size >= MAX_PENDING_BATCHES) {
      // 未登録データを押し出して正常完了させない。停止して再走査を促す。
      enabled = false;
      seenPayloadMedia.clear();
      firstPayloadMediaCounts.clear();
      post('SMZ_X_CAPTURE_ERROR', { collectionId, error: '収集データの登録待ちが上限に達しました。停止位置から再収集してください。' });
      return;
    }
    const batchId = `xbatch_${++batchSequence}`;
    const batch = { batchId, collectionId, handle: targetHandle, items, requestUrl };
    pendingBatches.set(batchId, batch);
    if (receiverReady) post('SMZ_X_MEDIA_BATCH', batch);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== POST_SOURCE) return;
    if (event.data.type === 'SMZ_X_UI_SETTINGS') {
      revertProfileTabs = event.data.revertProfileTabs === true;
      inspectProfileLayout(true);
      return;
    }
    if (event.data.type === 'SMZ_X_BATCH_ACK') {
      const batch = pendingBatches.get(event.data.batchId);
      if (batch && event.data.collectionId === batch.collectionId) pendingBatches.delete(event.data.batchId);
      return;
    }
    if (event.data.type === 'SMZ_X_CONTROL') {
      const nextHandle = String(event.data.handle || '').replace(/^@/, '').toLowerCase();
      const nextId = String(event.data.collectionId || '');
      if (targetHandle !== nextHandle || (nextId && collectionId && collectionId !== nextId)) clearCapture();
      targetHandle = nextHandle;
      // v1.3.15以前のタブにはhandleだけの再開マーカーが残る。
      // 同じ対象の初回データを引き継ぐ際、ACKにも確定したジョブIDを使う。
      if (!collectionId && nextId) {
        for (const batch of pendingBatches.values()) batch.collectionId = nextId;
      }
      collectionId = nextId || collectionId;
      if (!event.data.enabled) {
        receiverReady = false;
        enabled = event.data.preservePending === true;
        if (!enabled) clearCapture();
      } else {
        enabled = true;
        receiverReady = event.data.deliveryReady !== false;
        if (!receiverReady) return;
        reportCapture({phase:'hook_ready'});
        for(const diagnostic of earlyCaptureDiagnostics){try{post('SMZ_X_CAPTURE_DIAGNOSTIC',{diagnostic});}catch{}}
        earlyCaptureDiagnostics.length=0;
        for (const diagnostic of earlyDiagnostics) {try {post('SMZ_X_MEDIA_DIAGNOSTIC',{diagnostic});} catch {}}
        earlyDiagnostics.length = 0;
        for (const batch of pendingBatches.values()) post('SMZ_X_MEDIA_BATCH', batch);
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
    reportCapture({phase:'request'});
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

  function extractFromTweet(tweet, operation, capture) {
    const legacy = tweet?.legacy;
    if (!legacy || typeof legacy !== 'object') return [];
    const postId = String(legacy.id_str || tweet.rest_id || '');
    if (!/^\d+$/.test(postId)) return [];
    if (legacy.retweeted_status_id_str) {if(capture&&DIAGNOSTIC_POST_IDS.includes(postId))capture.targetReasons.add('retweet');return [];}

    const author = authorHandle(tweet);
    if (targetHandle && author && author !== targetHandle) {if(capture){capture.authorRejectedCount++;if(DIAGNOSTIC_POST_IDS.includes(postId))capture.targetReasons.add('author_mismatch');}return [];}
    if (targetHandle && !author) {if(capture){capture.authorRejectedCount++;if(DIAGNOSTIC_POST_IDS.includes(postId))capture.targetReasons.add('missing_author');}return [];}

    const media = legacy?.extended_entities?.media;
    if (!Array.isArray(media) || !media.length) return [];

    const payloadKey = `${postId}:${targetHandle}`;
    if (!firstPayloadMediaCounts.has(payloadKey)) firstPayloadMediaCounts.set(payloadKey,media.length);

    const postedAt = postedAtFromId(postId, legacy);
    const items = [];

    for (let i = 0; i < media.length; i++) {
      const entity = media[i] || {};
      const mediaIndex = i + 1;
      const seenKey = `${payloadKey}:${mediaIndex}`;
      if (seenPayloadMedia.has(seenKey)) continue;

      if (entity.video_info?.variants?.length) {
        const mp4 = entity.video_info.variants
          .filter((variant) => variant?.url && (!variant.content_type || variant.content_type === 'video/mp4'))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        if (!mp4?.url) continue;
        seenPayloadMedia.add(seenKey);
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
      seenPayloadMedia.add(seenKey);
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

    if (!items.length && capture) capture.duplicateCount++;
    reportMediaDiagnostic(postId,media.length,firstPayloadMediaCounts.get(payloadKey),items,items.length?'extracted':'duplicate_post',undefined,operation);
    return items;
  }

  // 診断は数値と投稿IDだけ。失敗しても本来の収集を中断しない。
  function reportMediaDiagnostic(postId,receivedCount,firstMediaCount,items,phase,reason,operation) {
    if (receivedCount<=4 && firstMediaCount<=4) return;
    try {
      const diagnostic={postId,phase,reason,operation,receivedCount,firstMediaCount,
        extractedCount:items.length,imageCount:items.filter(item=>item.type==='image').length,
        videoCount:items.filter(item=>item.type==='video').length,ignoredCount:receivedCount-items.length};
      if (!receiverReady) {
        earlyDiagnostics.push(diagnostic);if(earlyDiagnostics.length>100)earlyDiagnostics.shift();
      } else post('SMZ_X_MEDIA_DIAGNOSTIC',{diagnostic});
    } catch {}
  }

  function extractMedia(root, requestUrl, httpStatus = 200) {
    const op=String(requestUrl||'').split('?')[0].split('/').pop();
    const operation=['UserMedia','UserTweets','TweetDetail','TweetResultByRestId','SearchTimeline'].includes(op)?op:'Other';
    const capture={phase:'response',operation,httpStatus,reason:'parsed',objectsSeen:0,tweetCandidates:0,noLegacyCount:0,noMediaCount:0,authorRejectedCount:0,duplicateCount:0,extractedCount:0,targetReasons:new Set()};
    const matchedPosts=new Set(),matchedAssets=new Set(),shapes=new Set();
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
      // 抽出対象外のオブジェクトも観察する。値や本文はログへ渡さない。
      try {
      const objectId=String(value.rest_id||value.id_str||'');
      if(objectId && (value.core?.user_results || value.author || /Tweet/.test(String(value.__typename||'')) || DIAGNOSTIC_POST_IDS.includes(objectId))) {
        capture.tweetCandidates++;
        if(!value.legacy)capture.noLegacyCount++;
        else if(!Array.isArray(value.legacy?.extended_entities?.media))capture.noMediaCount++;
        if(DIAGNOSTIC_POST_IDS.includes(objectId)) {
          if(!value.legacy)capture.targetReasons.add('no_legacy');
          else if(!Array.isArray(value.legacy?.extended_entities?.media))capture.targetReasons.add('no_media');
        }
        if(DIAGNOSTIC_POST_IDS.includes(objectId) || (capture.noLegacyCount>0&&shapes.size<3)) {
          shapes.add(Object.keys(value).filter(k=>/^[A-Za-z_][A-Za-z0-9_]{0,49}$/.test(k)).slice(0,20).join(','));
        }
      }
      for(const child of Object.values(value))if(typeof child==='string') {
        for(const id of DIAGNOSTIC_POST_IDS)if(child.includes(id))matchedPosts.add(id);
        for(const id of DIAGNOSTIC_ASSET_IDS)if(child.includes(id))matchedAssets.add(id);
      }
      } catch {}

      for (const field of ['mediaDetails','media_details']) {
        if (Array.isArray(value[field]) && value[field].length>4) {
          const candidateId=String(value.rest_id||value.id_str||'');
          reportMediaDiagnostic(/^\d{1,24}$/.test(candidateId)?candidateId:null,value[field].length,0,[],'alternate_shape',field,operation);
        }
      }

      if (value.legacy?.extended_entities?.media && (value.rest_id || value.legacy?.id_str)) {
        items.push(...extractFromTweet(value,operation,capture));
      }

      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) stack.push(value[i]);
      } else {
        for (const child of Object.values(value)) {
          if (child && typeof child === 'object') stack.push(child);
        }
      }
    }

    reportCapture({...capture,objectsSeen:inspected,extractedCount:items.length,targetPostCount:matchedPosts.size,targetAssetCount:matchedAssets.size,
      targetPostIds:[...matchedPosts].join(','),targetAssetIds:[...matchedAssets].join(','),targetReasons:[...capture.targetReasons].join(','),shapeKeys:[...shapes].slice(0,3).join(';').slice(0,500)});
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

  async function inspectFetchResponse(response, requestUrl, requestId, generation) {
    try {
      if (!enabled || generation !== scopeGeneration) return;
      if (!response.ok) reportCapture({phase:'response',httpStatus:Number(response.status)||0,reason:'http_error'});
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
        if (!enabled || generation !== scopeGeneration) return;
        const items = extractMedia(data,requestUrl,response.status);
        queueBatch(items, requestUrl);
      } catch {reportCapture({phase:'response',httpStatus:Number(response.status)||0,reason:'parse_error'});}
    } finally {
      if (generation === scopeGeneration) endRelevantRequest(requestId, requestUrl, response?.status || 0);
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const requestId = enabled && isRelevantUrl(requestUrl) ? beginRelevantRequest(requestUrl) : null;
    const generation = scopeGeneration;

    try {
      const response = await originalFetch.apply(this, args);
      if (requestId) {
        // X本体へレスポンスはすぐ返しつつ、複製したレスポンスの解析完了まで
        // 収集側には「処理中」と伝えて次スクロールを急がせない。
        void inspectFetchResponse(response.clone(), requestUrl || response.url, requestId, generation);
      }
      return response;
    } catch (error) {
      if(requestId)reportCapture({phase:'response',httpStatus:0,reason:'network_error'});
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
      const generation = scopeGeneration;

      if (requestId) {
        this.addEventListener('loadend', () => {
          try {
            if (!enabled || generation !== scopeGeneration) return;
            if(this.status<200||this.status>=300)reportCapture({phase:'response',httpStatus:Number(this.status)||0,reason:'http_error'});
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
              const items = extractMedia(data,requestUrl,this.status);
              queueBatch(items, requestUrl);
            } catch {reportCapture({phase:'response',httpStatus:Number(this.status)||0,reason:'parse_error'});}
          } finally {
            if (generation === scopeGeneration) endRelevantRequest(requestId, requestUrl, this.status || 0);
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
