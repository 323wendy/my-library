/* ============================================================
   나만의 기록 — 기기 간 동기화
   GitHub Contents API로 저장소의 books.json · videos.json ·
   webtoons.json을 각각 읽고 씁니다. 한 기록 종류를 저장해도
   다른 파일은 건드리지 않습니다.
   토큰과 설정은 이 브라우저(localStorage)에만 두고, 기록 데이터나
   저장소에는 절대 담지 않습니다.
   ============================================================ */
(function (root) {
  'use strict';

  var C = root.Shelf;
  var CFG_KEY = 'reading-app:sync';
  var API = 'https://api.github.com';
  var DEFAULT_REPO = '323wendy/my-library';
  var PUSH_DELAY = 900;     /* 연달아 고칠 때 커밋이 쏟아지지 않게 잠깐 모읍니다 */
  var POLL_MS = 45000;      /* 다른 기기의 변경을 확인하는 주기 */

  /* 비밀 보관함(secret)은 암호화된 별도 파일(secret-webtoons.json)을 쓰므로
     이 동기화가 절대 건드리지 않습니다(평문이 공개 저장소로 나가지 않게). */
  function syncedCollections() {
    return C.COLLECTIONS.filter(function (c) { return !c.secret; });
  }

  var hooks = null;
  var st = {
    token: '',
    repo: DEFAULT_REPO,
    branch: 'main',
    phase: 'off',           /* off | syncing | synced | error */
    message: '',
    lastSyncAt: '',
    files: {},              /* id → { sha, fingerprint, firstSyncDone } */
    pushTimers: {},
    syncing: null,
    pollTimer: null,
    lastError: null,
    windowBound: false,
    lastPullAt: 0,
    counts: {}              /* id → 마지막으로 확인한 기록 수 */
  };

  function coll(id) { return C.collection(id); }

  function fileState(id) {
    if (!st.files[id]) st.files[id] = { sha: null, fingerprint: '', firstSyncDone: false };
    return st.files[id];
  }

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

  function summaryText() {
    var parts = [];
    syncedCollections().forEach(function (c) {
      var n = st.counts[c.id];
      if (typeof n === 'number') parts.push(c.label + ' ' + n + c.unit);
    });
    return parts.join(' · ');
  }

  function getStatus() {
    return {
      connected: !!st.token,
      repo: st.repo,
      phase: st.phase,
      message: st.message,
      lastSyncAt: st.lastSyncAt,
      error: st.lastError ? String(st.lastError.message || '') : '',
      counts: Object.assign({}, st.counts)
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

  function filePath(file) {
    return repoPath() + '/contents/' + file;
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

  /* 저장소의 JSON 파일을 읽어 옵니다. 파일이 없으면 sha 없이 돌려줍니다. */
  function getRemote(id) {
    var c = coll(id);
    var url = filePath(c.file) + '?ref=' + encodeURIComponent(st.branch) + '&_=' + Date.now();
    return request('GET', url).then(function (data) {
      var text = '';
      if (data && data.content) {
        try { text = C.base64ToUtf8(data.content); } catch (e) { text = ''; }
      }
      var items = [];
      if (text) {
        try {
          var parsed = JSON.parse(text);
          items = C.normalizeList(C.listFromPayload(parsed, c), c);
        } catch (e) { items = []; }
      }
      return { items: items, books: items, sha: (data && data.sha) || null, text: text };
    }, function (err) {
      if (err.status === 404) return { items: [], books: [], sha: null, text: '', missing: true };
      throw err;
    });
  }

  function putRemote(id, text, sha, message) {
    var c = coll(id);
    var body = {
      message: message,
      content: C.utf8ToBase64(text),
      branch: st.branch
    };
    if (sha) body.sha = sha;
    return request('PUT', filePath(c.file), body);
  }

  function commitMessage(id, count, reason) {
    var c = coll(id);
    var what = c.label + ' 기록';
    if (reason === 'connect') return '나만의 기록 동기화 시작 · ' + what + ' (' + count + c.unit + ')';
    if (reason === 'local') return what + ' 업데이트 (' + count + c.unit + ')';
    return what + ' 동기화 (' + count + c.unit + ')';
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

  function localSnapshot(id) {
    var local = hooks && typeof hooks.getLocal === 'function' ? hooks.getLocal(id) : null;
    return local || { items: [], books: [], deleted: [], seenRemote: [] };
  }

  function applyLocal(id, items, deleted, opts) {
    if (hooks && typeof hooks.applyItems === 'function') {
      hooks.applyItems(id, items, Object.assign({ deleted: deleted || [] }, opts || {}));
    }
  }

  /* 방금 저장한 내용을 화면에 반영합니다.
     저장하는 사이에 사용자가 또 고쳤으면 그 변경을 덮어쓰지 않고 남겨 둡니다. */
  function applyAfterPush(id, saved, deleted) {
    var local = localSnapshot(id);
    var parked = C.mergeForSync(local.items || local.books, saved, local.deleted, []);
    var same = C.itemsFingerprint(parked.items, id) === C.itemsFingerprint(saved, id);
    applyLocal(id, parked.items, uniqueIds((deleted || []).concat(parked.removed || [])), { compact: same });
    if (!same) schedulePush(id, 1200);
    return { same: same, items: parked.items };
  }

  function succeed(id, count, pushed) {
    var fs = fileState(id);
    st.lastError = null;
    fs.firstSyncDone = true;
    st.lastSyncAt = new Date().toISOString();
    st.counts[id] = count;
    writeCfg();
    var c = coll(id);
    var text = summaryText();
    setPhase('synced', pushed
      ? (c.label + ' ' + count + c.unit + '을 GitHub에 저장했어요.' + (text ? ' (' + text + ')' : ''))
      : (text ? text + ' 모두 최신이에요.' : '최신 상태예요.'));
    return { ok: true, pushed: !!pushed, count: count, items: count, books: count, collection: id, sha: fs.sha };
  }

  function failWith(err) {
    st.lastError = err;
    setPhase('error', err && err.message ? err.message : '동기화하지 못했어요.');
  }

  /* 한 기록 종류: 원격 최신본을 받아 이 기기와 합치고, 다르면 올립니다. */
  function runSyncFile(id, reason) {
    var fs = fileState(id);
    return getRemote(id).then(function (remote) {
      if (!remote.missing) return remote;
      /* 파일이 없는 것인지, 저장소에 못 들어가는 것인지 확인합니다. */
      return checkRepo().then(function () { return remote; });
    }).then(function (remote) {
      fs.sha = remote.sha || null;
      fs.fingerprint = C.itemsFingerprint(remote.items, id);

      var local = localSnapshot(id);
      var merged = C.mergeForSync(local.items || local.books, remote.items, local.deleted, local.seenRemote);
      var deleted = uniqueIds((local.deleted || []).concat(merged.removed || []));

      /* 먼저 화면에 반영하고(로컬 수정은 그대로 남겨 두고)… */
      applyLocal(id, merged.items, deleted);
      st.lastPullAt = Date.now();
      var fingerprint = C.itemsFingerprint(merged.items, id);

      /* …원격과 같으면 올리지 않습니다. */
      if (fs.sha && fingerprint === fs.fingerprint) {
        applyAfterPush(id, merged.items, deleted);
        return succeed(id, merged.items.length, false);
      }
      return upload(id, merged.items, fs.sha, 1, deleted, reason);
    });
  }

  function upload(id, items, sha, retries, deleted, reason) {
    var fs = fileState(id);
    var text = C.payloadFor(coll(id), items);
    return putRemote(id, text, sha, commitMessage(id, items.length, reason)).then(function (res) {
      fs.sha = (res && res.content && res.content.sha) || fs.sha;
      fs.fingerprint = C.itemsFingerprint(items, id);
      st.lastPullAt = Date.now();
      var applied = applyAfterPush(id, items, deleted);
      return succeed(id, applied.items.length, true);
    }, function (err) {
      /* 동시 편집 충돌: 최신 원격을 다시 받아 합친 뒤 한 번만 더 시도합니다. */
      if (err.status === 409 && retries > 0) {
        return getRemote(id).then(function (remote) {
          fs.sha = remote.sha || null;
          var local = localSnapshot(id);
          var merged = C.mergeForSync(local.items || local.books, remote.items, local.deleted, local.seenRemote);
          var nextDeleted = uniqueIds((local.deleted || []).concat(merged.removed || []));
          applyLocal(id, merged.items, nextDeleted);
          return upload(id, merged.items, fs.sha, retries - 1, nextDeleted, reason);
        });
      }
      /* sha 없이 덮어쓰려다 거절된 경우(파일이 이미 있음): 최신본을 받아 다시 합칩니다. */
      if (err.status === 422 && retries > 0) {
        return runSyncFile(id, 'retry');
      }
      throw err;
    });
  }

  /* 이 기기의 변경만 올립니다(대개 요청 한 번). */
  function pushFile(id) {
    var fs = fileState(id);
    if (!st.token) return Promise.resolve({ ok: false, reason: 'no-token' });
    if (st.syncing) {
      schedulePush(id, 1500);
      return Promise.resolve({ ok: false, reason: 'busy' });
    }
    var local = localSnapshot(id);
    var items = local.items || local.books;
    var fingerprint = C.itemsFingerprint(items, id);
    if (fs.sha && fingerprint === fs.fingerprint) {
      st.counts[id] = items.length;
      return Promise.resolve({ ok: true, pushed: false, count: items.length, collection: id });
    }
    setPhase('syncing', coll(id).label + ' 기록을 저장하고 있어요.');
    st.syncing = upload(id, items, fs.sha, 1, local.deleted, 'local').then(function (r) {
      st.syncing = null;
      return r;
    }, function (e) {
      st.syncing = null;
      failWith(e);
      return { ok: false, error: e };
    });
    return st.syncing;
  }

  /* 세 파일을 차례로 맞춥니다(요청이 몰리지 않게 순서대로). */
  function syncAll(reason) {
    if (!st.token) {
      setPhase('off', '');
      return Promise.resolve({ ok: false, reason: 'no-token' });
    }
    if (st.syncing) return st.syncing;
    setPhase('syncing', '최신 기록을 확인하고 있어요.');
    var pushed = 0;
    var chain = Promise.resolve();
    syncedCollections().forEach(function (c) {
      chain = chain.then(function () {
        return runSyncFile(c.id, reason || 'manual');
      }).then(function (r) {
        if (r && r.pushed) pushed++;
        return r;
      });
    });
    st.syncing = chain.then(function () {
      st.syncing = null;
      var text = summaryText();
      if (st.phase !== 'error') {
        setPhase('synced', text
          ? (text + (pushed ? ' — GitHub에 저장했어요.' : ' · 모두 최신이에요.'))
          : '동기화됐어요.');
      }
      return { ok: st.phase !== 'error', pushed: pushed > 0, counts: Object.assign({}, st.counts) };
    }, function (e) {
      st.syncing = null;
      failWith(e);
      return { ok: false, error: e };
    });
    return st.syncing;
  }

  function schedulePush(id, delay) {
    if (!id) { syncedCollections().forEach(function (c) { schedulePush(c.id, delay); }); return; }
    if (id === 'secret') return;   /* 비밀 보관함은 ShelfSecret이 따로 저장합니다. */
    clearTimeout(st.pushTimers[id]);
    st.pushTimers[id] = setTimeout(function () {
      st.pushTimers[id] = null;
      if (!fileState(id).firstSyncDone) { syncAll('local-first'); return; }
      pushFile(id);
    }, delay || PUSH_DELAY);
  }

  /* 기록이 바뀔 때마다 app.js가 부릅니다. 바뀐 기록 종류만 올립니다. */
  function notifyLocalChange(id) {
    if (id === 'secret') return;   /* 비밀 보관함은 ShelfSecret이 따로 저장합니다. */
    if (!st.token) {
      if (st.phase !== 'off') setPhase('off', '');
      return;
    }
    if (id) {
      /* 처음 연결하기 전에는 어느 파일이 최신인지 모르므로 전체를 한 번 맞춥니다. */
      if (!fileState(id).firstSyncDone) { schedulePush(id); return; }
      schedulePush(id);
      return;
    }
    schedulePush(null);
  }

  /* ---------------- 연결 / 해제 ---------------- */

  function connect(opts) {
    opts = opts || {};
    var token = String(opts.token || '').trim();
    var repo = normalizeRepo(opts.repo) || st.repo || DEFAULT_REPO;
    if (token) st.token = token;
    st.repo = repo;
    if (!st.token) return Promise.resolve({ ok: false, message: '토큰을 먼저 넣어 주세요.' });

    syncedCollections().forEach(function (c) {
      var fs = fileState(c.id);
      fs.firstSyncDone = false;
      fs.sha = null;
      fs.fingerprint = '';
    });
    writeCfg();
    setPhase('syncing', '연결을 확인하고 있어요.');
    return checkRepo().then(function (info) {
      if (!info.canPush) {
        var err = new Error('이 토큰으로는 저장소에 쓸 수 없어요. 토큰 권한(repo)을 확인해 주세요.');
        err.status = 403;
        throw err;
      }
      return syncAll('connect');
    }).then(function (r) {
      if (!r || !r.ok) {
        return { ok: false, message: (r && r.error && r.error.message) || st.message || '동기화하지 못했어요.' };
      }
      bindWindowEvents();
      startPolling();
      return { ok: true, pushed: !!r.pushed, counts: r.counts, repo: st.repo };
    }, function (err) {
      failWith(err);
      return { ok: false, message: err && err.message ? err.message : '동기화하지 못했어요.' };
    });
  }

  function disconnect() {
    st.token = '';
    st.lastError = null;
    syncedCollections().forEach(function (c) {
      var fs = fileState(c.id);
      fs.sha = null;
      fs.fingerprint = '';
      fs.firstSyncDone = false;
      clearTimeout(st.pushTimers[c.id]);
      st.pushTimers[c.id] = null;
    });
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
      syncAll('poll');
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
        syncAll('visible');
      });
    }
    root.addEventListener('online', function () {
      if (st.token) syncAll('online');
    });
  }

  function start() {
    readCfg();
    if (!st.token) {
      setPhase('off', '');
      return;
    }
    bindWindowEvents();
    syncAll('start');
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
    syncNow: syncAll,
    connect: connect,
    disconnect: disconnect,
    notifyLocalChange: notifyLocalChange,
    schedulePush: schedulePush,
    push: pushFile,
    stopPolling: stopPolling
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
