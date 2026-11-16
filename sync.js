/* ============================================================
   나만의 서재 — 기기 간 동기화
   GitHub Contents API로 저장소의 books.json을 읽고 씁니다.
   토큰과 설정은 이 브라우저(localStorage)에만 두고, 서재 데이터나
   저장소에는 절대 담지 않습니다.
   ============================================================ */
(function (root) {
  'use strict';

  var C = root.Shelf;
  var CFG_KEY = 'reading-app:sync';
  var API = 'https://api.github.com';
  var DEFAULT_REPO = '323wendy/my-library';
  var FILE = 'books.json';
  var PUSH_DELAY = 900;     /* 연달아 고칠 때 커밋이 쏟아지지 않게 잠깐 모읍니다 */
  var POLL_MS = 45000;      /* 다른 기기의 변경을 확인하는 주기 */

  var hooks = null;
  var st = {
    token: '',
    repo: DEFAULT_REPO,
    branch: 'main',
    phase: 'off',           /* off | syncing | synced | error */
    message: '',
    lastSyncAt: '',
    sha: null,
    remoteFingerprint: '',
    firstSyncDone: false,
    syncing: null,
    pushTimer: null,
    pollTimer: null,
    lastError: null,
    windowBound: false,
    lastPullAt: 0
  };

  /* ---------------- 설정(토큰·저장소) ---------------- */

  function readCfg() {
    try {
      var d = JSON.parse(root.localStorage.getItem(CFG_KEY) || 'null') || {};
      if (typeof d.token === 'string') st.token = d.token;
      if (typeof d.repo === 'string' && d.repo) st.repo = d.repo;
      if (typeof d.lastSyncAt === 'string') st.lastSyncAt = d.lastSyncAt;
    } catch (e) { /* noop */ }
    return cfg();
  }

  function writeCfg() {
    try {
      root.localStorage.setItem(CFG_KEY, JSON.stringify({
        token: st.token,
        repo: st.repo,
        lastSyncAt: st.lastSyncAt
      }));
    } catch (e) { /* noop */ }
  }

  function cfg() {
    return { token: st.token, repo: st.repo };
  }

  function normalizeRepo(name) {
    return String(name || '')
      .trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/^\/+|\/+$/g, '');
  }

  /* ---------------- 상태 알림 ---------------- */

  function getStatus() {
    return {
      connected: !!st.token,
      repo: st.repo,
      phase: st.phase,
      message: st.message,
      lastSyncAt: st.lastSyncAt,
      error: st.lastError ? String(st.lastError.message || '') : ''
    };
  }

  function emit() {
    if (hooks && typeof hooks.onStatus === 'function') {
      try { hooks.onStatus(getStatus()); } catch (e) { /* noop */ }
    }
  }

  function setPhase(phase, message) {
    st.phase = phase;
    st.message = message || '';
    emit();
  }

  /* ---------------- 통신 ---------------- */

  function messageFor(status, data) {
    var api = (data && data.message) || '';
    if (status === 401) return '토큰이 올바르지 않거나 만료됐어요. 새 토큰을 만들어 다시 넣어 주세요.';
    if (status === 403) {
      if (/rate limit/i.test(api)) return 'GitHub 요청 한도를 넘었어요. 잠시 뒤 자동으로 다시 시도할게요.';
      return '이 토큰으로는 저장소에 쓸 수 없어요. 토큰 권한(repo)을 확인해 주세요.';
    }
    if (status === 404) return '저장소를 찾지 못했어요. 저장소 이름과 토큰 권한을 확인해 주세요.';
    if (status === 409) return '다른 기기에서 방금 저장했어요. 최신 내용과 합쳐 다시 시도할게요.';
    if (status === 422) return '저장소 파일 상태가 바뀌었어요. 최신 내용을 다시 확인할게요.';
    if (status >= 500) return 'GitHub가 잠시 응답하지 않아요. 조금 뒤 다시 시도할게요.';
    return api || '동기화하지 못했어요. 인터넷 연결을 확인해 주세요.';
  }

  function request(method, url, body) {
    var target = /^https?:\/\//.test(url) ? url : API + url;
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
    return fetch(target, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error(messageFor(res.status, data));
          err.status = res.status;
          err.data = data;
          err.rateLeft = res.headers.get('x-ratelimit-remaining');
          throw err;
        }
        return data;
      });
    }, function () {
      var netErr = new Error('인터넷에 연결하지 못했어요. 연결을 확인한 뒤 자동으로 다시 시도할게요.');
      netErr.status = 0;
      throw netErr;
    });
  }

  function repoPath() {
    return '/repos/' + st.repo;
  }

  function filePath() {
    return repoPath() + '/contents/' + FILE;
  }

  function checkRepo() {
    return request('GET', repoPath() + '?_=' + Date.now()).then(function (repo) {
      repo = repo || {};
      if (repo.default_branch) st.branch = repo.default_branch;
      var perms = repo.permissions || {};
      return {
        fullName: repo.full_name || st.repo,
        branch: st.branch,
        canPush: perms.push !== false,
        isPrivate: !!repo.private
      };
    });
  }

  /* 저장소의 books.json을 읽어 옵니다. 파일이 없으면 sha 없이 돌려줍니다. */
  function getRemote() {
    var url = filePath() + '?ref=' + encodeURIComponent(st.branch) + '&_=' + Date.now();
    return request('GET', url).then(function (data) {
      var text = '';
      if (data && data.content) {
        try { text = C.base64ToUtf8(data.content); } catch (e) { text = ''; }
      }
      var books = [];
      if (text) {
        try {
          var parsed = JSON.parse(text);
          var list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.books) ? parsed.books : []);
          books = list.map(C.normalizeBook).filter(Boolean);
        } catch (e) { books = []; }
      }
      return { books: books, sha: (data && data.sha) || null, text: text };
    }, function (err) {
      if (err.status === 404) return { books: [], sha: null, text: '', missing: true };
      throw err;
    });
  }

  function putRemote(text, sha, message) {
    var body = {
      message: message,
      content: C.utf8ToBase64(text),
      branch: st.branch
    };
    if (sha) body.sha = sha;
    return request('PUT', filePath(), body);
  }

  function commitMessage(count, reason) {
    if (reason === 'local') return '서재 업데이트 (' + count + '권)';
    if (reason === 'connect') return '나만의 서재 동기화 시작 (' + count + '권)';
    return '서재 동기화 (' + count + '권)';
  }

  function uniqueIds(list) {
    var seen = {};
    var out = [];
    (list || []).forEach(function (id) {
      if (!id || seen[id]) return;
      seen[id] = true;
      out.push(id);
    });
    return out;
  }

  /* ---------------- 본체 ---------------- */

  function localSnapshot() {
    var local = hooks && typeof hooks.getLocal === 'function' ? hooks.getLocal() : null;
    return local || { books: [], deleted: [], seenRemote: [] };
  }

  function applyLocal(books, deleted, opts) {
    if (hooks && typeof hooks.applyLibrary === 'function') {
      hooks.applyLibrary(books, Object.assign({ deleted: deleted || [] }, opts || {}));
    }
  }

  /* 방금 저장한 내용을 화면에 반영합니다.
     저장하는 사이에 사용자가 또 고쳤으면 그 변경을 덮어쓰지 않고 남겨 둡니다. */
  function applyAfterPush(saved, deleted) {
    var local = localSnapshot();
    var parked = C.mergeForSync(local.books, saved, local.deleted, []);
    var same = C.booksFingerprint(parked.books) === C.booksFingerprint(saved);
    applyLocal(parked.books, uniqueIds((deleted || []).concat(parked.removed || [])), { compact: same });
    if (!same) schedulePush(1200);
    return { same: same, books: parked.books };
  }

  function succeed(count, pushed) {
    st.lastError = null;
    st.firstSyncDone = true;
    st.lastSyncAt = new Date().toISOString();
    writeCfg();
    setPhase('synced', pushed ? (count + '권을 GitHub에 저장했어요.') : (count + '권이 최신 상태예요.'));
    return { ok: true, pushed: !!pushed, count: count, books: count, sha: st.sha };
  }

  function failWith(err) {
    st.lastError = err;
    var phase = 'error';
    setPhase(phase, err && err.message ? err.message : '동기화하지 못했어요.');
  }

  /* 원격 최신본을 받아 이 기기 서재와 합치고, 다르면 올립니다. */
  function syncNow(reason) {
    if (!st.token) {
      setPhase('off', '');
      return Promise.resolve({ ok: false, reason: 'no-token' });
    }
    if (st.syncing) return st.syncing;
    setPhase('syncing', '최신 서재를 확인하고 있어요.');
    st.syncing = runSync(reason || 'manual').then(function (r) {
      st.syncing = null;
      return r;
    }, function (e) {
      st.syncing = null;
      failWith(e);
      return { ok: false, error: e };
    });
    return st.syncing;
  }

  function runSync(reason) {
    return getRemote().then(function (remote) {
      if (!remote.missing) return remote;
      /* 파일이 없는 것인지, 저장소에 못 들어가는 것인지 확인합니다. */
      return checkRepo().then(function () { return remote; });
    }).then(function (remote) {
      st.sha = remote.sha || null;
      st.remoteFingerprint = C.booksFingerprint(remote.books);
      st.lastPullAt = Date.now();

      var local = localSnapshot();
      var merged = C.mergeForSync(local.books, remote.books, local.deleted, local.seenRemote);
      var deleted = uniqueIds((local.deleted || []).concat(merged.removed || []));

      /* 먼저 화면에 반영하고(로컬 수정은 그대로 남겨 두고)… */
      applyLocal(merged.books, deleted);
      var fingerprint = C.booksFingerprint(merged.books);

      /* …원격과 같으면 올리지 않습니다. */
      if (st.sha && fingerprint === st.remoteFingerprint) {
        applyAfterPush(merged.books, deleted);
        return succeed(merged.books.length, false);
      }
      return upload(merged.books, st.sha, 1, deleted, reason);
    });
  }

  function upload(books, sha, retries, deleted, reason) {
    var text = C.repoPayload(books);
    return putRemote(text, sha, commitMessage(books.length, reason)).then(function (res) {
      st.sha = (res && res.content && res.content.sha) || st.sha;
      st.remoteFingerprint = C.booksFingerprint(books);
      st.lastPullAt = Date.now();
      var applied = applyAfterPush(books, deleted);
      return succeed(applied.books.length, true);
    }, function (err) {
      /* 동시 편집 충돌: 최신 원격을 다시 받아 합친 뒤 한 번만 더 시도합니다. */
      if (err.status === 409 && retries > 0) {
        return getRemote().then(function (remote) {
          st.sha = remote.sha || null;
          var local = localSnapshot();
          var merged = C.mergeForSync(local.books, remote.books, local.deleted, local.seenRemote);
          var nextDeleted = uniqueIds((local.deleted || []).concat(merged.removed || []));
          applyLocal(merged.books, nextDeleted);
          return upload(merged.books, st.sha, retries - 1, nextDeleted, reason);
        });
      }
      /* sha 없이 덮어쓰려다 거절된 경우(파일이 이미 있음): 최신본을 받아 다시 합칩니다. */
      if (err.status === 422 && retries > 0) {
        return syncNow('retry');
      }
      throw err;
    });
  }

  /* 이 기기의 변경만 올립니다(대개 요청 한 번). */
  function pushLocal() {
    if (!st.token) return Promise.resolve({ ok: false, reason: 'no-token' });
    if (st.syncing) {
      schedulePush(1500);
      return Promise.resolve({ ok: false, reason: 'busy' });
    }
    var local = localSnapshot();
    var fingerprint = C.booksFingerprint(local.books);
    if (st.sha && fingerprint === st.remoteFingerprint) {
      return Promise.resolve({ ok: true, pushed: false, count: local.books.length });
    }
    setPhase('syncing', '이 기기의 변경을 저장하고 있어요.');
    st.syncing = upload(local.books, st.sha, 1, local.deleted, 'local').then(function (r) {
      st.syncing = null;
      return r;
    }, function (e) {
      st.syncing = null;
      failWith(e);
      return { ok: false, error: e };
    });
    return st.syncing;
  }

  function schedulePush(delay) {
    clearTimeout(st.pushTimer);
    st.pushTimer = setTimeout(function () {
      st.pushTimer = null;
      if (!st.firstSyncDone) { syncNow('local-first'); return; }
      pushLocal();
    }, delay || PUSH_DELAY);
  }

  /* 서재가 바뀔 때마다 app.js가 부릅니다. */
  function notifyLocalChange() {
    if (!st.token) {
      if (st.phase !== 'off') setPhase('off', '');
      return;
    }
    schedulePush();
  }

  /* ---------------- 연결 / 해제 ---------------- */

  function connect(opts) {
    opts = opts || {};
    var token = String(opts.token || '').trim();
    var repo = normalizeRepo(opts.repo) || st.repo || DEFAULT_REPO;
    if (token) st.token = token;
    st.repo = repo;
    if (!st.token) return Promise.resolve({ ok: false, message: '토큰을 먼저 넣어 주세요.' });

    st.firstSyncDone = false;
    writeCfg();
    setPhase('syncing', '연결을 확인하고 있어요.');
    return checkRepo().then(function (info) {
      if (!info.canPush) {
        var err = new Error('이 토큰으로는 저장소에 쓸 수 없어요. 토큰 권한(repo)을 확인해 주세요.');
        err.status = 403;
        throw err;
      }
      return syncNow('connect');
    }).then(function (r) {
      if (!r || !r.ok) {
        return { ok: false, message: (r && r.error && r.error.message) || st.message || '동기화하지 못했어요.' };
      }
      bindWindowEvents();
      startPolling();
      return { ok: true, pushed: !!r.pushed, count: r.books, repo: st.repo };
    }, function (err) {
      failWith(err);
      return { ok: false, message: err && err.message ? err.message : '동기화하지 못했어요.' };
    });
  }

  function disconnect() {
    st.token = '';
    st.sha = null;
    st.remoteFingerprint = '';
    st.firstSyncDone = false;
    st.lastError = null;
    clearTimeout(st.pushTimer);
    st.pushTimer = null;
    stopPolling();
    writeCfg();
    setPhase('off', '');
    return getStatus();
  }

  /* ---------------- 자동 동기화 ---------------- */

  function startPolling() {
    if (st.pollTimer || !st.token) return;
    st.pollTimer = setInterval(function () {
      if (root.document && root.document.hidden) return;
      if (st.syncing) return;
      syncNow('poll');
    }, POLL_MS);
  }

  function stopPolling() {
    if (st.pollTimer) clearInterval(st.pollTimer);
    st.pollTimer = null;
  }

  function bindWindowEvents() {
    if (st.windowBound) return;
    st.windowBound = true;
    var doc = root.document;
    if (doc) {
      doc.addEventListener('visibilitychange', function () {
        if (doc.hidden || !st.token) return;
        /* 방금 맞춘 상태면 건너뜁니다. */
        if (Date.now() - st.lastPullAt < 5000) return;
        syncNow('visible');
      });
    }
    root.addEventListener('online', function () {
      if (st.token) syncNow('online');
    });
  }

  function start() {
    readCfg();
    if (!st.token) {
      setPhase('off', '');
      return;
    }
    bindWindowEvents();
    syncNow('start');
    startPolling();
  }

  root.ShelfSync = {
    DEFAULT_REPO: DEFAULT_REPO,
    readCfg: readCfg,
    config: cfg,
    getStatus: getStatus,
    hasToken: function () { return !!st.token; },
    init: function (h) { hooks = h || null; readCfg(); emit(); },
    start: start,
    syncNow: syncNow,
    connect: connect,
    disconnect: disconnect,
    notifyLocalChange: notifyLocalChange,
    schedulePush: schedulePush,
    stopPolling: stopPolling
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
