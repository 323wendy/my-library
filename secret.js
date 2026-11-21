/* ============================================================
   나만의 기록 — 비밀 보관함 (웹툰·웹소설 탭의 작은 장식으로 들어갑니다)

   · 숫자 4자리 비밀번호(PIN)를 넣어야 열립니다.
   · 내용은 Web Crypto(PBKDF2 + AES-GCM)로 암호화해서
     저장소의 secret-webtoons.json 에만 올립니다.
     → 저장소가 공개여도 제목·감상·문구는 알아볼 수 없습니다.
   · 비밀번호와 암호 열쇠는 이 기기 메모리에만 있고, 어디에도 저장하지 않습니다.
     (오프라인용으로는 암호문만 브라우저에 남겨 둡니다.)
   ============================================================ */
(function (root) {
  'use strict';

  var C = root.Shelf;
  var FILE = 'secret-webtoons.json';
  var CFG_KEY = 'reading-app:sync';          /* 앱 동기화 설정(같은 토큰·저장소) */
  var BLOB_KEY = 'reading-app:secret:blob';  /* 암호문 캐시(평문 아님) */
  var API = 'https://api.github.com';
  var BRANCH = 'main';
  var ITER = 210000;                         /* PBKDF2 반복 횟수 */
  var PIN_LEN = 4;
  var PUSH_DELAY = 800;
  var POLL_MS = 45000;

  var hooks = {};
  var st = {
    unlocked: false,
    key: null,          /* CryptoKey (메모리에만) */
    salt: '',           /* 현재 열쇠의 salt(base64) */
    iter: ITER,
    blob: null,         /* 마지막으로 연/저장한 암호문 객체 */
    items: [],
    sha: null,
    dirty: false,
    busy: false,
    token: '',
    repo: '323wendy/my-library',
    phase: 'locked',    /* locked | busy | saving | saved | local | error */
    message: '',
    lastSavedAt: '',
    pushTimer: null,
    pollTimer: null
  };

  var pinUI = { mode: 'unlock', step: '', buf: '', first: '', busy: false };
  var els = {};

  /* ---------------- 작은 도우미 ---------------- */

  function $(id) { return document.getElementById(id); }

  function subtle() {
    return (root.crypto && root.crypto.subtle) ? root.crypto.subtle : null;
  }

  function randomBytes(n) {
    var a = new Uint8Array(n);
    root.crypto.getRandomValues(a);
    return a;
  }

  function toB64(bytes) {
    var arr = new Uint8Array(bytes);
    var bin = '';
    for (var i = 0; i < arr.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
    }
    return root.btoa(bin);
  }

  function fromB64(text) {
    var bin = root.atob(String(text || ''));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function enc(text) { return new TextEncoder().encode(String(text)); }
  function dec(bytes) { return new TextDecoder('utf-8').decode(new Uint8Array(bytes)); }

  function readCfg() {
    try {
      var d = JSON.parse(root.localStorage.getItem(CFG_KEY) || 'null') || {};
      if (typeof d.token === 'string') st.token = d.token;
      if (typeof d.repo === 'string' && d.repo) st.repo = d.repo;
    } catch (e) { /* noop */ }
  }

  /* ---------------- 암호화 ---------------- */

  function deriveKey(pin, saltBytes, iter) {
    var s = subtle();
    return s.importKey('raw', enc(pin), 'PBKDF2', false, ['deriveKey']).then(function (base) {
      return s.deriveKey(
        { name: 'PBKDF2', salt: saltBytes, iterations: iter || ITER, hash: 'SHA-256' },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    });
  }

  /* 파일에 담을 내용(평문) — 다른 기록 파일과 같은 모양 */
  function payloadOf(items) {
    var c = C.collection('secret');
    var list = C.sortItems(items || [], c).map(function (b) { return C.serializeForRepo(b, c); });
    return {
      app: '나만의 기록',
      version: 1,
      secret: true,
      updatedAt: new Date().toISOString(),
      count: list.length,
      items: list
    };
  }

  function encryptPayload(key, saltB64, payload) {
    var iv = randomBytes(12);
    return subtle().encrypt({ name: 'AES-GCM', iv: iv }, key, enc(JSON.stringify(payload)))
      .then(function (buf) {
        return {
          v: 1,
          alg: 'AES-GCM',
          kdf: 'PBKDF2-SHA256',
          iter: ITER,
          salt: saltB64,
          iv: toB64(iv),
          data: toB64(buf)
        };
      });
  }

  function decryptPayload(blob, key) {
    return subtle().decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.data))
      .then(function (buf) { return JSON.parse(dec(buf)); });
  }

  function itemsOfPayload(payload) {
    var c = C.collection('secret');
    var raw = [];
    if (Array.isArray(payload)) raw = payload;
    else if (payload && Array.isArray(payload.items)) raw = payload.items;
    else if (payload && Array.isArray(payload.data)) raw = payload.data;
    return C.normalizeList(raw, c);
  }

  /* 암호문을 PIN으로 열어 봅니다(열쇠는 st에 보관). */
  function openBlob(blob, pin) {
    if (!blob || !blob.salt || !blob.iv || !blob.data) {
      return Promise.reject(new Error('암호문 형식이 아니에요.'));
    }
    var iter = Number(blob.iter) || ITER;
    return deriveKey(pin, fromB64(blob.salt), iter).then(function (key) {
      return decryptPayload(blob, key).then(function (payload) {
        st.key = key;
        st.salt = blob.salt;
        st.iter = iter;
        st.blob = blob;
        return itemsOfPayload(payload);
      });
    });
  }

  /* ---------------- 브라우저에 남기는 암호문(오프라인용) ---------------- */

  function writeCache(blob, text) {
    try {
      root.localStorage.setItem(BLOB_KEY, JSON.stringify({
        savedAt: new Date().toISOString(),
        text: text || JSON.stringify(blob)
      }));
    } catch (e) { /* noop */ }
  }

  /* 동기화(토큰) 없이 이 기기에만 저장한 변경이 있는지 표시해 둡니다.
     나중에 동기화를 연결하면 그 변경을 저장소 쪽 보관함과 합칩니다. */
  var PENDING_KEY = 'reading-app:secret:pending';

  function setPending(on) {
    try {
      if (on) root.localStorage.setItem(PENDING_KEY, '1');
      else root.localStorage.removeItem(PENDING_KEY);
    } catch (e) { /* noop */ }
  }

  function isPending() {
    try { return root.localStorage.getItem(PENDING_KEY) === '1'; } catch (e) { return false; }
  }

  function readCache() {
    try {
      var d = JSON.parse(root.localStorage.getItem(BLOB_KEY) || 'null');
      if (!d || !d.text) return null;
      return { blob: JSON.parse(d.text), savedAt: d.savedAt || '' };
    } catch (e) { return null; }
  }

  /* ---------------- GitHub (앱 동기화와 같은 저장소·토큰) ---------------- */

  function request(method, url, body) {
    var headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (st.token) headers['Authorization'] = 'Bearer ' + st.token;
    var opts = { method: method, headers: headers, mode: 'cors', cache: 'no-store', credentials: 'omit' };
    if (body) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(API + url, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error(friendlyError(res.status, data));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    }, function () {
      var netErr = new Error('인터넷에 연결하지 못했어요.');
      netErr.status = 0;
      throw netErr;
    });
  }

  function friendlyError(status, data) {
    var api = (data && data.message) || '';
    if (status === 401) return '동기화 토큰이 만료됐어요. 보관함은 이 기기에만 저장돼요.';
    if (status === 403) return /rate limit/i.test(api) ? 'GitHub 요청 한도를 넘었어요. 잠시 뒤 다시 저장할게요.' : '이 토큰으로는 저장소에 쓸 수 없어요.';
    if (status === 404) return '저장소를 찾지 못했어요.';
    if (status === 409 || status === 422) return '다른 기기에서 먼저 저장했어요.';
    if (status >= 500) return 'GitHub가 잠시 응답하지 않아요.';
    return api || '저장하지 못했어요.';
  }

  function getRemote() {
    var url = '/repos/' + st.repo + '/contents/' + FILE + '?ref=' + encodeURIComponent(BRANCH) + '&_=' + Date.now();
    return request('GET', url).then(function (data) {
      var text = '';
      if (data && data.content) {
        try { text = C.base64ToUtf8(data.content); } catch (e) { text = ''; }
      }
      var blob = null;
      if (text) { try { blob = JSON.parse(text); } catch (e) { blob = null; } }
      return { blob: blob, sha: (data && data.sha) || null };
    }, function (err) {
      if (err.status === 404) return { blob: null, sha: null, missing: true };
      throw err;
    });
  }

  /* 동기화를 아직 연결하지 않은 기기에서도, 공개된 암호문(서비스 화면의 같은 파일)을
     받아 비밀번호를 확인할 수 있게 합니다. (읽기는 공개, 쓰기는 토큰이 있을 때만) */
  function getSiteBlob() {
    if (!root.location || !/^https?:$/.test(root.location.protocol)) return Promise.resolve(null);
    return fetch(FILE + '?t=' + Date.now(), { cache: 'no-store' }).then(function (res) {
      if (!res || !res.ok) return null;
      return res.text().then(function (text) {
        try {
          var blob = JSON.parse(text);
          return (blob && blob.salt && blob.iv && blob.data) ? blob : null;
        } catch (e) { return null; }
      });
    }, function () { return null; });
  }

  function putRemote(text, sha) {
    var body = {
      message: '비밀 보관함 암호화 저장',
      content: C.utf8ToBase64(text),
      branch: BRANCH
    };
    if (sha) body.sha = sha;
    return request('PUT', '/repos/' + st.repo + '/contents/' + FILE, body);
  }

  /* ---------------- 상태 표시 ---------------- */

  function phaseText() {
    var t = '';
    var time = st.lastSavedAt ? hm(st.lastSavedAt) : '';
    if (st.phase === 'saving') t = '저장 중…';
    else if (st.phase === 'busy') t = '확인 중…';
    else if (st.phase === 'error') t = st.message || '저장하지 못했어요';
    else if (st.phase === 'local') t = '이 기기에만 저장됨';
    else if (st.phase === 'saved') {
      if (time) t = (st.token ? '저장됨' : '이 기기에만 저장됨') + ' · ' + time;
      else t = st.token ? '최신 상태' : '동기화 안 됨 · 이 기기에서만';
    }
    return t;
  }

  function hm(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var h = d.getHours();
    var m = ('0' + d.getMinutes()).slice(-2);
    var ap = h < 12 ? '오전' : '오후';
    var hh = h % 12; if (!hh) hh = 12;
    return ap + ' ' + hh + ':' + m;
  }

  function status() {
    return { phase: st.phase, text: phaseText(), tone: st.phase === 'error' ? 'error' : '' };
  }

  function setPhase(phase, message) {
    st.phase = phase;
    st.message = message || '';
    emit();
  }

  function emit() {
    if (typeof hooks.onStatus === 'function') {
      try { hooks.onStatus(status()); } catch (e) { /* noop */ }
    }
    renderSettingsStatus();
  }

  function toast(msg) {
    if (typeof hooks.toast === 'function') { try { hooks.toast(msg); } catch (e) { /* noop */ } }
  }

  /* ---------------- 열기 / 잠그기 ---------------- */

  function unlock(pin) {
    if (st.busy) return Promise.resolve({ ok: false });
    readCfg();
    st.busy = true;
    setPhase('busy', '');
    pinUI.busy = true;
    renderPin();

    var cached = readCache();
    var remoteP = st.token
      ? getRemote().then(function (r) { return r; }, function () { return null; })
      : getSiteBlob().then(function (blob) {
        return blob ? { blob: blob, sha: null, site: true } : null;
      }, function () { return null; });

    return remoteP.then(function (remote) {
      var remoteBlob = remote && remote.blob ? remote.blob : null;
      var remoteSha = remote && remote.sha ? remote.sha : null;

      if (remoteBlob) {
        return openBlob(remoteBlob, pin).then(function (items) {
          st.sha = remoteSha;
          return mergePendingItems(items).then(function (merged) {
            st.items = merged.items;
            st.dirty = merged.changed;
            return ready(st.items);
          });
        }, function (err) {
          /* 이 기기에서만 비밀번호를 바꿔 둔 경우 등: 이 기기 암호문으로 한 번 더 열어 봅니다. */
          if (cached && cached.blob && cached.blob.salt !== remoteBlob.salt) {
            return openBlob(cached.blob, pin).then(function (items) {
              st.sha = remoteSha;
              st.items = items;
              st.dirty = true;
              return ready(items);
            });
          }
          throw err;
        });
      }

      /* 원격에 아직 암호문이 없음 → 이 기기에 남긴 암호문으로 시도 */
      if (cached && cached.blob) {
        return openBlob(cached.blob, pin).then(function (items) {
          st.sha = remoteSha;
          st.items = items;
          st.dirty = !remote || !!remote.missing;   /* 원격에 파일이 없으면 곧 올립니다 */
          return ready(items);
        });
      }

      /* 아직 아무것도 없음 → 빈 보관함을 이 PIN으로 시작 */
      var salt = toB64(randomBytes(16));
      return deriveKey(pin, fromB64(salt), ITER).then(function (key) {
        st.key = key;
        st.salt = salt;
        st.iter = ITER;
        st.blob = null;
        st.items = [];
        st.sha = remoteSha;
        return ready([]);
      });
    }).then(function (r) {
      st.busy = false;
      pinUI.busy = false;
      return r;
    }, function () {
      st.busy = false;
      pinUI.busy = false;
      setPhase(st.unlocked ? 'saved' : 'locked', '');
      return { ok: false, message: '비밀번호가 맞지 않아요.' };
    });
  }

  function ready(items) {
    st.unlocked = true;
    setPhase('saved', '');
    startPolling();
    if (typeof hooks.onUnlocked === 'function') hooks.onUnlocked(st.items);
    if (st.dirty) schedulePush(400);
    return { ok: true, items: items };
  }

  /* 동기화 없이 이 기기에만 저장해 둔 작품이 있으면 저장소 쪽 목록과 합칩니다(같은 id는 최신 우선). */
  function mergePendingItems(remoteItems) {
    if (!isPending() || !st.key) return Promise.resolve({ items: remoteItems, changed: false });
    var cached = readCache();
    if (!cached || !cached.blob || cached.blob.salt !== st.salt) return Promise.resolve({ items: remoteItems, changed: false });
    return decryptPayload(cached.blob, st.key).then(function (payload) {
      var localItems = itemsOfPayload(payload);
      var merged = mergeById(localItems, remoteItems);
      var coll = C.collection('secret');
      var changed = C.itemsFingerprint(merged, coll) !== C.itemsFingerprint(remoteItems, coll);
      return { items: C.sortItems(merged, coll), changed: changed };
    }, function () { return { items: remoteItems, changed: false }; });
  }

  function clearSecret() {
    st.unlocked = false;
    st.key = null;
    st.salt = '';
    st.blob = null;
    st.items = [];
    st.sha = null;
    st.dirty = false;
    st.lastSavedAt = '';
    stopPolling();
    setPhase('locked', '');
  }

  /* 잠그기: 저장하지 않은 변경이 있으면 먼저 암호화해 저장한 뒤 메모리에서 지웁니다. */
  function lock() {
    clearTimeout(st.pushTimer);
    st.pushTimer = null;
    var job = null;
    if (st.unlocked && st.key && st.dirty) {
      var key = st.key, salt = st.salt, sha = st.sha, items = st.items.slice();
      job = encryptPayload(key, salt, payloadOf(items)).then(function (blob) {
        var text = JSON.stringify(blob, null, 2) + '\n';
        writeCache(blob, text);
        if (!st.token) { setPending(true); return null; }
        return putRemote(text, sha).then(function () { setPending(false); }).catch(function () { return null; });
      }).catch(function () { return null; });
    }
    clearSecret();
    return job;
  }

  /* ---------------- 저장 ---------------- */

  function onLocalChange(items) {
    if (!st.unlocked) return;
    st.items = items || [];
    st.dirty = true;
    schedulePush();
  }

  function schedulePush(delay) {
    clearTimeout(st.pushTimer);
    st.pushTimer = setTimeout(function () {
      st.pushTimer = null;
      save();
    }, typeof delay === 'number' ? delay : PUSH_DELAY);
  }

  function save() {
    if (!st.unlocked || !st.key) return Promise.resolve({ ok: false });
    st.dirty = false;
    setPhase('saving', '');
    var key = st.key, salt = st.salt;
    return encryptPayload(key, salt, payloadOf(st.items)).then(function (blob) {
      var text = JSON.stringify(blob, null, 2) + '\n';
      writeCache(blob, text);
      st.blob = blob;
      if (!st.token) {
        st.lastSavedAt = new Date().toISOString();
        setPending(true);
        setPhase('local', '');
        return { ok: true, local: true };
      }
      return putRemote(text, st.sha).then(function (res) {
        st.sha = (res && res.content && res.content.sha) || st.sha;
        st.lastSavedAt = new Date().toISOString();
        setPending(false);
        setPhase('saved', '');
        return { ok: true, sha: st.sha };
      }, function (err) {
        if (err.status === 409 || err.status === 422) return mergeAndSave(text);
        st.dirty = true;
        setPhase('error', err.message);
        return { ok: false, error: err };
      });
    }, function () {
      st.dirty = true;
      setPhase('error', '내용을 암호화하지 못했어요.');
      return { ok: false };
    });
  }

  /* 다른 기기에서 먼저 저장했을 때: 최신 암호문을 풀어 합친 뒤 다시 올립니다. */
  function mergeAndSave(myText) {
    return getRemote().then(function (r) {
      st.sha = r.sha || null;
      if (!r.blob || r.blob.salt !== st.salt) return putAgain(myText);
      return decryptPayload(r.blob, st.key).then(function (payload) {
        var remoteItems = itemsOfPayload(payload);
        st.items = mergeById(st.items, remoteItems);
        return encryptPayload(st.key, st.salt, payloadOf(st.items)).then(function (blob) {
          var text = JSON.stringify(blob, null, 2) + '\n';
          writeCache(blob, text);
          st.blob = blob;
          if (typeof hooks.onRemoteItems === 'function') hooks.onRemoteItems(st.items);
          return putAgain(text);
        });
      }, function () { return putAgain(myText); });
    }, function (err) {
      st.dirty = true;
      setPhase('error', err.message);
      return { ok: false, error: err };
    });
  }

  function putAgain(text) {
    return putRemote(text, st.sha).then(function (res) {
      st.sha = (res && res.content && res.content.sha) || st.sha;
      st.lastSavedAt = new Date().toISOString();
      setPending(false);
      setPhase('saved', '');
      return { ok: true, sha: st.sha };
    }, function (err) {
      st.dirty = true;
      setPhase('error', err.message);
      return { ok: false, error: err };
    });
  }

  function mergeById(local, remote) {
    var map = {};
    var order = [];
    (remote || []).forEach(function (b) {
      if (!b || !b.id) return;
      map[b.id] = b; order.push(b.id);
    });
    (local || []).forEach(function (b) {
      if (!b || !b.id) return;
      var known = map[b.id];
      if (!known) { map[b.id] = b; order.push(b.id); return; }
      if (C.timeOf(b) > C.timeOf(known)) map[b.id] = b;
    });
    return order.map(function (id) { return map[id]; });
  }

  /* ---------------- 다른 기기의 변경 확인 ---------------- */

  function startPolling() {
    if (st.pollTimer || !st.token) return;
    st.pollTimer = setInterval(function () {
      if (document.hidden) return;
      pollOnce();
    }, POLL_MS);
  }

  function stopPolling() {
    if (st.pollTimer) clearInterval(st.pollTimer);
    st.pollTimer = null;
  }

  function pollOnce() {
    if (!st.unlocked || !st.token || st.busy || st.dirty) return Promise.resolve();
    return getRemote().then(function (r) {
      if (!r.blob || !r.sha) return;
      if (r.sha === st.sha) return;
      if (r.blob.salt !== st.salt) return;   /* 다른 비밀번호로 바뀐 파일은 건드리지 않습니다 */
      return decryptPayload(r.blob, st.key).then(function (payload) {
        if (st.dirty) return;
        st.items = itemsOfPayload(payload);
        st.sha = r.sha;
        st.blob = r.blob;
        setPhase('saved', '');
        if (typeof hooks.onRemoteItems === 'function') hooks.onRemoteItems(st.items);
      }, function () { /* noop */ });
    }, function () { /* noop */ });
  }

  /* ---------------- 비밀번호 바꾸기 ---------------- */

  function changePin(newPin) {
    var items = st.items.slice();
    var salt = toB64(randomBytes(16));
    var newKey = null;
    setPhase('saving', '');
    return deriveKey(newPin, fromB64(salt), ITER).then(function (key) {
      newKey = key;
      return encryptPayload(key, salt, payloadOf(items));
    }).then(function (blob) {
      var text = JSON.stringify(blob, null, 2) + '\n';
      if (!st.token) {
        st.key = newKey; st.salt = salt; st.blob = blob;
        st.lastSavedAt = new Date().toISOString();
        writeCache(blob, text);
        setPending(true);
        setPhase('local', '');
        return { ok: true, local: true };
      }
      return putRemote(text, st.sha).then(function (res) {
        st.key = newKey; st.salt = salt; st.blob = blob;
        st.sha = (res && res.content && res.content.sha) || st.sha;
        st.lastSavedAt = new Date().toISOString();
        writeCache(blob, text);
        setPending(false);
        setPhase('saved', '');
        return { ok: true };
      });
    }, function (err) {
      setPhase('error', err && err.message ? err.message : '비밀번호를 바꾸지 못했어요.');
      return { ok: false, message: '비밀번호를 바꾸지 못했어요.' };
    });
  }

  /* 이 비밀번호가 지금 보관함의 열쇠인지 확인합니다. */
  function checkCurrentPin(pin) {
    if (!st.key || !st.blob) return Promise.resolve(true);   /* 아직 저장 전이면 확인할 것이 없습니다 */
    var blob = st.blob;
    return deriveKey(pin, fromB64(blob.salt), Number(blob.iter) || ITER).then(function (key) {
      return decryptPayload(blob, key).then(function () { return true; }, function () { return false; });
    }, function () { return false; });
  }

  /* ---------------- PIN 화면 ---------------- */

  function showModal(node) {
    if (!node || !node.hidden) return;
    node.hidden = false;
    document.body.classList.add('modal-open');
  }

  function hideModal(node) {
    if (!node) return;
    node.hidden = true;
    if (!document.querySelector('.modal:not([hidden])')) document.body.classList.remove('modal-open');
  }

  function openPin(mode) {
    if (!subtle()) {
      toast('이 브라우저에서는 암호화를 쓸 수 없어요. 크롬이나 사파리 최신 버전에서 열어 주세요.');
      return;
    }
    if (st.unlocked) return;
    pinUI = { mode: mode || 'unlock', step: '', buf: '', first: '', busy: false };
    renderPin();
    showModal(els.pinModal);
  }

  function closePin() {
    hideModal(els.pinModal);
    pinUI = { mode: 'unlock', step: '', buf: '', first: '', busy: false };
  }

  function pinCopy() {
    if (pinUI.mode === 'change') {
      if (pinUI.step === 'current') return { title: '🔐 비밀번호 바꾸기', lead: '지금 쓰는 비밀번호를 넣어 주세요.', foot: '' };
      if (pinUI.step === 'new') return { title: '🔐 새 비밀번호', lead: '새로 쓸 숫자 4자리를 정해 주세요.', foot: '정한 비밀번호는 어디에도 저장되지 않아요. 잊지 않게 기억해 주세요.' };
      return { title: '🔐 한 번 더', lead: '새 비밀번호를 한 번 더 넣어 주세요.', foot: '' };
    }
    return {
      title: '🔐 비밀 보관함',
      lead: '숫자 4자리 비밀번호를 넣어 주세요.',
      foot: '보관함 내용은 비밀번호로 암호화되어 저장돼요.'
    };
  }

  function renderPin() {
    if (!els.pinModal) return;
    var c = pinCopy();
    els.pinTitle.textContent = c.title;
    els.pinLead.textContent = c.lead;
    els.pinFoot.textContent = c.foot;
    els.pinFoot.hidden = !c.foot;
    var dots = '';
    for (var i = 0; i < PIN_LEN; i++) dots += '<i class="' + (i < pinUI.buf.length ? 'on' : '') + '"></i>';
    els.pinDots.innerHTML = dots;
    els.pinDots.setAttribute('data-busy', pinUI.busy ? '1' : '');
    els.pinError.textContent = '';
    els.pinError.hidden = true;
    setPadEnabled(!pinUI.busy);
  }

  function el_pad() {
    if (!els.pinPad) return [];
    return Array.prototype.slice.call(els.pinPad.querySelectorAll('button'));
  }

  function setPadEnabled(on) {
    el_pad().forEach(function (b) { b.disabled = !on; });
  }

  function pinError(message) {
    if (!els.pinError) return;
    pinUI.busy = false;
    pinUI.buf = '';
    setPadEnabled(true);
    renderPinDots();
    els.pinError.textContent = message;
    els.pinError.hidden = false;
    els.pinDots.classList.remove('shake');
    void els.pinDots.offsetWidth;
    els.pinDots.classList.add('shake');
  }

  function pressKey(key) {
    if (pinUI.busy) return;
    if (key === 'del') {
      pinUI.buf = pinUI.buf.slice(0, -1);
      renderPinDots();
      return;
    }
    if (!/^[0-9]$/.test(key)) return;
    if (pinUI.buf.length >= PIN_LEN) return;
    pinUI.buf += key;
    renderPinDots();
    if (pinUI.buf.length === PIN_LEN) submitPin();
  }

  function renderPinDots() {
    if (!els.pinDots) return;
    var dots = '';
    for (var i = 0; i < PIN_LEN; i++) dots += '<i class="' + (i < pinUI.buf.length ? 'on' : '') + '"></i>';
    els.pinDots.innerHTML = dots;
    if (els.pinError) { els.pinError.textContent = ''; els.pinError.hidden = true; }
  }

  function submitPin() {
    var pin = pinUI.buf;

    if (pinUI.mode === 'change') {
      if (pinUI.step === 'current') {
        pinUI.busy = true;
        renderPin();
        checkCurrentPin(pin).then(function (ok) {
          pinUI.busy = false;
          if (!ok) { pinError('지금 비밀번호가 맞지 않아요.'); return; }
          pinUI.step = 'new';
          pinUI.buf = '';
          renderPin();
        }, function () { pinUI.busy = false; pinError('확인하지 못했어요.'); });
        return;
      }
      if (pinUI.step === 'new') {
        pinUI.first = pin;
        pinUI.step = 'confirm';
        pinUI.buf = '';
        renderPin();
        return;
      }
      /* confirm */
      if (pin !== pinUI.first) {
        pinUI.first = '';
        pinUI.step = 'new';
        pinError('두 번 넣은 비밀번호가 달라요. 처음부터 다시 넣어 주세요.');
        return;
      }
      pinUI.busy = true;
      renderPin();
      var job;
      try { job = changePin(pin); } catch (e) { job = Promise.resolve({ ok: false }); }
      job.then(function (r) {
        pinUI.busy = false;
        if (!r || !r.ok) { pinError('비밀번호를 바꾸지 못했어요.'); return; }
        closePin();
        toast('비밀번호를 바꿨어요.');
        emit();
      }, function () { pinUI.busy = false; pinError('비밀번호를 바꾸지 못했어요.'); });
      return;
    }

    /* unlock */
    pinUI.busy = true;
    renderPin();
    els.pinLead.textContent = '확인하고 있어요…';
    var job;
    try { job = unlock(pin); } catch (e) { job = Promise.resolve({ ok: false }); }
    job.then(function (r) {
      pinUI.busy = false;
      if (r && r.ok) {
        closePin();
        toast('보관함을 열었어요.');
        return;
      }
      els.pinLead.textContent = pinCopy().lead;
      renderPin();
      pinError((r && r.message) || '비밀번호가 맞지 않아요.');
    }, function () {
      pinUI.busy = false;
      els.pinLead.textContent = pinCopy().lead;
      renderPin();
      pinError('확인하지 못했어요. 잠시 뒤 다시 해주세요.');
    });
  }

  /* ---------------- 설정 ---------------- */

  function openSettings() {
    if (!st.unlocked) return;
    renderSettingsStatus();
    showModal(els.settingsModal);
  }

  function renderSettingsStatus() {
    if (!els.settingsStatus) return;
    var parts = [];
    parts.push(st.token ? ('☁️ GitHub 저장소와 맞춰요 · ' + st.repo) : '☁️ 동기화 미연결 — 이 기기에만 저장돼요');
    var t = phaseText();
    if (t) parts.push(t);
    els.settingsStatus.textContent = parts.join('\n');
  }

  /* ---------------- 시작 ---------------- */

  function init(h) {
    hooks = h || {};
    els = {
      pinModal: $('pin-modal'),
      pinTitle: $('pin-title'),
      pinLead: $('pin-lead'),
      pinDots: $('pin-dots'),
      pinError: $('pin-error'),
      pinPad: $('pin-pad'),
      pinFoot: $('pin-foot'),
      pinClose: $('pin-close'),
      settingsModal: $('secret-settings-modal'),
      settingsStatus: $('secret-settings-status')
    };

    if (els.pinPad) {
      els.pinPad.addEventListener('click', function (e) {
        var b = e.target.closest('[data-key]');
        if (b) pressKey(b.getAttribute('data-key'));
      });
    }
    if (els.pinClose) els.pinClose.addEventListener('click', closePin);
    if (els.pinModal) {
      els.pinModal.addEventListener('click', function (e) {
        if (e.target === els.pinModal) closePin();
      });
    }
    document.addEventListener('keydown', function (e) {
      if (!els.pinModal || els.pinModal.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); closePin(); return; }
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); pressKey(e.key); return; }
      if (e.key === 'Backspace') { e.preventDefault(); pressKey('del'); }
    });

    var changeBtn = $('secret-change-pin');
    if (changeBtn) {
      changeBtn.addEventListener('click', function () {
        hideModal(els.settingsModal);
        pinUI = { mode: 'change', step: 'current', buf: '', first: '', busy: false };
        renderPin();
        showModal(els.pinModal);
      });
    }
    var saveNow = $('secret-save-now');
    if (saveNow) {
      saveNow.addEventListener('click', function () {
        clearTimeout(st.pushTimer);
        st.pushTimer = null;
        save().then(function (r) {
          if (r && r.ok) toast(r.local ? '이 기기에 저장했어요.' : 'GitHub에 저장했어요.');
          else toast('저장하지 못했어요. 잠시 뒤 다시 해볼게요.');
          renderSettingsStatus();
        });
      });
    }
    var closeBtn = $('secret-settings-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { hideModal(els.settingsModal); });
    if (els.settingsModal) {
      els.settingsModal.addEventListener('click', function (e) {
        if (e.target === els.settingsModal) hideModal(els.settingsModal);
      });
    }

    /* 앱이 동기화 설정을 바꾸면 토큰·저장소를 다시 읽습니다. */
    root.addEventListener('storage', function (e) {
      if (e && e.key === CFG_KEY) readCfg();
    });
  }

  root.ShelfSecret = {
    init: init,
    openPin: openPin,
    openSettings: openSettings,
    lock: lock,
    onLocalChange: onLocalChange,
    isUnlocked: function () { return st.unlocked; },
    status: status,
    changePin: changePin,
    _crypto: { deriveKey: deriveKey, encryptPayload: encryptPayload, decryptPayload: decryptPayload, fromB64: fromB64, toB64: toB64 }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
