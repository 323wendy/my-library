/* ============================================================
   나만의 기록 — 화면 동작
   독서 / 영상 / 웹툰·웹소설 세 가지 기록을 같은 방식으로 보여 주고,
   JSON 파일 + localStorage 병합, 등록·수정·삭제, 문구, 통계,
   데이터 복사·불러오기, 기기 간 동기화, PWA 등록을 맡습니다.
   ============================================================ */
(function () {
  'use strict';

  var C = window.Shelf;
  var COLLECTIONS = C.COLLECTIONS;
  var LS_KEY = 'reading-app:v1';
  var SNAP_PREFIX = 'reading-app:v1:snapshot';

  var state = {
    current: 'books',
    view: 'list',          /* list | stats */
    remote: {},
    remoteLoaded: {},
    store: {},
    items: {},
    query: '',
    filter: 'all',
    statusFilter: 'all',
    editingId: null,
    detailId: null,
    detailColl: null,
    formKind: '',
    formStatus: 'done',
    formCustom: false,
    lookup: { busy: false, items: [], message: '', tone: '' },
    quoteDraft: '',
    quotePage: '',
    quoteEditingId: null,
    lookupDesc: '',
    lookupQuery: ''
  };

  var el = {};
  var openStack = [];
  var confirmResolve = null;
  var toastTimer = null;
  var lookupTimer = null;
  /* 자동 검색이 채워 둔 값 — 다른 후보를 고르면 앞 후보의 값이 남지 않도록 기억합니다. */
  var lastAuto = { creator: '', platform: '', link: '', memo: '' };
  var swReloading = false;
  var syncApplying = false;

  /* ---------------- 기록 종류 도우미 ---------------- */

  var lockingSecret = false;

  function coll(id) { return C.collection(id || state.current); }
  function current() { return coll(state.current); }
  function itemsOf(id) { return state.items[id || state.current] || []; }
  function storeOf(id) { return state.store[id || state.current]; }
  function kindOf(id) { return state.store[id || state.current] || {}; }

  /* ---------------- 저장소 ---------------- */

  function emptyStore() {
    return { edits: {}, added: [], deleted: [], seenRemote: [], hideSampleNote: false };
  }

  function normalizeStore(d) {
    d = d || {};
    return {
      edits: (d.edits && typeof d.edits === 'object') ? d.edits : {},
      added: Array.isArray(d.added) ? d.added : [],
      deleted: Array.isArray(d.deleted) ? d.deleted.filter(Boolean) : [],
      seenRemote: Array.isArray(d.seenRemote) ? d.seenRemote.filter(Boolean) : [],
      hideSampleNote: !!d.hideSampleNote
    };
  }

  function loadStores() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { raw = null; }
    /* 예전(책만 있던) 저장소는 books 자리로 옮겨 읽습니다. */
    var legacy = raw && (raw.edits || raw.added || raw.deleted) ? raw : null;
    var out = {};
    COLLECTIONS.forEach(function (c) {
      /* 비밀 보관함은 이 브라우저 저장소에 평문으로 남기지 않습니다(열었을 때만 메모리에). */
      if (c.secret) { out[c.id] = emptyStore(); return; }
      var s = raw && raw[c.id] ? raw[c.id] : (c.id === 'books' ? legacy : null);
      out[c.id] = normalizeStore(s);
    });
    return out;
  }

  function saveStores() {
    try {
      var keep = {};
      COLLECTIONS.forEach(function (c) { if (!c.secret) keep[c.id] = state.store[c.id]; });
      localStorage.setItem(LS_KEY, JSON.stringify(keep));
    } catch (e) {
      toast('이 브라우저에는 저장이 안 돼요. 통계 탭에서 데이터를 복사해 두세요.');
    }
  }

  function notifyChange(id) {
    if (syncApplying) return;
    if (id === 'secret') {
      /* 비밀 보관함은 암호화해서 ShelfSecret이 따로 저장합니다. */
      var sc = C.collection('secret');
      var list = C.mergeLibrary(state.remote.secret || [], state.store.secret, sc);
      if (window.ShelfSecret) window.ShelfSecret.onLocalChange(list);
      return;
    }
    if (window.ShelfSync) window.ShelfSync.notifyLocalChange(id);
  }

  /* 마지막으로 보던 기록을 하나 더 남겨 둡니다(인터넷이 끊겨도 비어 보이지 않게). */
  function saveSnapshot() {
    COLLECTIONS.forEach(function (c) {
      if (c.secret) return;   /* 비밀 보관함은 암호화 파일에만 남깁니다. */
      try {
        localStorage.setItem(SNAP_PREFIX + ':' + c.id, JSON.stringify({
          savedAt: new Date().toISOString(),
          items: state.items[c.id] || []
        }));
      } catch (e) { /* noop */ }
    });
  }

  function loadSnapshot(id) {
    if (id === 'secret') return null;
    var keys = [SNAP_PREFIX + ':' + id];
    if (id === 'books') keys.push(SNAP_PREFIX);   /* 예전 한 개짜리 스냅샷 */
    for (var i = 0; i < keys.length; i++) {
      try {
        var d = JSON.parse(localStorage.getItem(keys[i]) || 'null');
        if (!d) continue;
        var list = d.items || d.books;
        if (!Array.isArray(list)) continue;
        var items = list.map(function (b) { return C.normalizeItem(b, coll(id)); }).filter(Boolean);
        if (items.length) return items;
      } catch (e) { /* noop */ }
    }
    return null;
  }

  /* ---------------- 도우미 ---------------- */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function hashHue(text) {
    var h = 0;
    for (var i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
    return h;
  }

  function findItem(id) {
    var list = itemsOf();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function findIn(collId, id) {
    var list = itemsOf(collId);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 2600);
  }

  function safeLink(url) {
    var u = String(url || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
    return /^https?:\/\//i.test(u) ? u : '';
  }

  /* ---------------- 모달 ---------------- */

  function openModal(node) {
    if (openStack.indexOf(node) >= 0) return;
    node.hidden = false;
    openStack.push(node);
    document.body.classList.add('modal-open');
  }

  function closeModal(node) {
    node.hidden = true;
    var i = openStack.indexOf(node);
    if (i >= 0) openStack.splice(i, 1);
    if (!openStack.length) document.body.classList.remove('modal-open');
  }

  function closeTop() {
    var node = openStack[openStack.length - 1];
    if (node) closeModal(node);
  }

  function confirmDialog(opts) {
    el.confirmTitle.textContent = opts.title || '확인';
    el.confirmMessage.textContent = opts.message || '';
    el.confirmOk.textContent = opts.okText || '확인';
    el.confirmOk.className = opts.danger === false ? 'btn-primary' : 'btn-danger';
    openModal(el.confirmModal);
    return new Promise(function (resolve) { confirmResolve = resolve; });
  }

  function settleConfirm(ok) {
    closeModal(el.confirmModal);
    var resolve = confirmResolve;
    confirmResolve = null;
    if (resolve) resolve(ok);
  }

  /* ---------------- 데이터 합치기 ---------------- */

  var WEBTOON_KINDS = ['웹툰', '웹소설'];

  /* 웹툰·웹소설은 이제 따로 된 칸에서 봅니다. 독서 목록에는 남기지 않습니다. */
  function keepInCollection(item, c) {
    if (c.id === 'books' && WEBTOON_KINDS.indexOf(item.kind) >= 0) return false;
    return true;
  }

  function mergeAll() {
    COLLECTIONS.forEach(function (c) {
      var list = C.mergeLibrary(state.remote[c.id] || [], state.store[c.id], c);
      state.items[c.id] = list.filter(function (b) { return keepInCollection(b, c); });
    });
  }

  function refresh() {
    mergeAll();
    renderSummary();
    renderChips();
    renderGrid();
    renderStats();
    renderSampleNote();
    saveSnapshot();
  }

  /* ---------------- 렌더 ---------------- */

  function renderSummary() {
    var c = current();
    var list = itemsOf();
    var starred = 0;
    list.forEach(function (b) { if (C.itemRating(b) > 0) starred++; });
    /* 좁은 화면에서도 '⭐ 2'와 '개'가 갈라지지 않도록 두 조각으로 나눠 넣습니다。 */
    el.summary.innerHTML = '<span class="sum-part">' + esc(c.emoji + ' ' + c.label + ' · 총 ' + list.length + c.unit) + '</span>'
      + '<span class="sum-stars' + (starred ? ' on' : '') + '">⭐ ' + starred + esc(c.unit) + '</span>';
  }

  /* ---------------- 별점 (노란 별 0~3개) ---------------- */

  function ratingFilter(n) { return 'rating:' + n; }
  function isRatingFilter(v) { return typeof v === 'string' && v.indexOf('rating:') === 0; }
  function ratingOfFilter(v) { return Number(String(v).split(':')[1]) || 0; }

  /* 별 3개를 그립니다. onlyFilled면 채운 별만 남깁니다. */
  function starRowHTML(n, onlyFilled) {
    n = Math.max(0, Math.min(C.RATING_MAX, Number(n) || 0));
    if (onlyFilled && !n) return '';
    var html = '';
    for (var i = 1; i <= C.RATING_MAX; i++) {
      if (onlyFilled && i > n) break;
      html += '<svg class="star' + (i <= n ? ' on' : '') + '" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-star"></use></svg>';
    }
    return '<span class="star-row" aria-hidden="true">' + html + '</span>';
  }

  /* 누를 수 있는 별 3개 + '없음'. 같은 별을 한 번 더 누르면 0개가 됩니다. */
  function ratingButtonsHTML(rating) {
    rating = Math.max(0, Math.min(C.RATING_MAX, Number(rating) || 0));
    var html = '';
    for (var i = 1; i <= C.RATING_MAX; i++) {
      html += '<button type="button" class="star-btn' + (i <= rating ? ' on' : '') + '" data-act="rate" data-rate="' + i + '"'
        + ' aria-pressed="' + (i <= rating) + '" aria-label="별 ' + i + '개 주기">'
        + '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-star"></use></svg></button>';
    }
    html += '<button type="button" class="rate-clear' + (rating ? '' : ' is-on') + '" data-act="rate" data-rate="0"'
      + ' aria-pressed="' + (rating === 0) + '" aria-label="별점 없음">없음</button>';
    return html;
  }

  function renderChips() {
    var c = current();
    var counts = {};
    var rated = { 1: 0, 2: 0, 3: 0 };
    itemsOf().forEach(function (b) {
      var k = b.kind || c.defaultKind;
      counts[k] = (counts[k] || 0) + 1;
      var r = C.itemRating(b);
      if (r > 0) rated[r]++;
    });
    var kinds = Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || a.localeCompare(b, 'ko');
    });

    if (state.filter !== 'all' && !isRatingFilter(state.filter) && kinds.indexOf(state.filter) < 0) {
      state.filter = 'all';
    }

    var html = '<button type="button" class="chip' + (state.filter === 'all' ? ' is-active' : '') + '" data-filter="all">전체</button>';
    [3, 2, 1].forEach(function (n) {
      var on = state.filter === ratingFilter(n);
      var stars = '';
      for (var i = 0; i < n; i++) stars += '★';
      html += '<button type="button" class="chip stars' + (on ? ' is-active' : '') + '" data-filter="' + ratingFilter(n) + '"'
        + ' aria-pressed="' + on + '" aria-label="별 ' + n + '개 준 기록만 보기">'
        + '<span class="chip-stars" aria-hidden="true">' + stars + '</span>'
        + '<span class="chip-num">' + rated[n] + '</span></button>';
    });
    var tints = ['rose', 'apricot', 'lavender', 'sage'];
    kinds.forEach(function (k, i) {
      html += '<button type="button" class="chip tint-' + tints[i % tints.length] + (state.filter === k ? ' is-active' : '') + '" data-filter="' + esc(k) + '">' + esc(k) + '</button>';
    });
    el.chips.innerHTML = html;
    renderStatusFilterChips();
  }

  function renderStatusFilterChips() {
    var c = current();
    var counts = { done: 0, stopped: 0, active: 0 };
    itemsOf().forEach(function (b) { counts[C.normalizeStatus(b.status)]++; });

    var keys = ['all'].concat(C.STATUS_LIST);
    if (state.statusFilter !== 'all' && C.STATUS_LIST.indexOf(state.statusFilter) < 0) {
      state.statusFilter = 'all';
    }

    var html = keys.map(function (k) {
      var label = k === 'all' ? '전체' : C.statusLabel(c, k);
      var count = k === 'all' ? itemsOf().length : counts[k];
      return '<button type="button" class="chip sm' + (state.statusFilter === k ? ' is-active' : '') + '"'
        + ' data-status-filter="' + esc(k) + '" aria-pressed="' + (state.statusFilter === k) + '">'
        + esc(label) + ' <span class="chip-num">' + count + '</span></button>';
    }).join('');

    el.statusChips.innerHTML = html;
  }

  function visibleItems() {
    var c = current();
    var q = state.query.trim().toLowerCase();
    var list = itemsOf().filter(function (b) {
      if (isRatingFilter(state.filter)) {
        if (C.itemRating(b) !== ratingOfFilter(state.filter)) return false;
      } else if (state.filter !== 'all' && (b.kind || c.defaultKind) !== state.filter) {
        return false;
      }
      if (state.statusFilter !== 'all' && C.normalizeStatus(b.status) !== state.statusFilter) return false;
      if (!q) return true;
      return haystack(b, c).indexOf(q) >= 0;
    });
    return C.sortItems(list, c);
  }

  /* 제목·저자·한 줄 평·분류와 함께 저장한 문구 내용으로도 검색합니다. */
  function haystack(b, c) {
    var parts = [b.title, b.creator || '', b.memo || '', b.kind || '', b.platform || '', C.statusLabel(c, C.normalizeStatus(b.status))];
    if (b.startDate) parts.push(b.startDate);
    if (b.endDate) parts.push(b.endDate);
    (b.quotes || []).forEach(function (quote) {
      parts.push(quote.text || '');
      if (quote.page) parts.push('p.' + quote.page);
    });
    return parts.join(' ').toLowerCase();
  }

  var FALLBACK_TINTS = ['rose', 'sage', 'lavender', 'butter', 'apricot'];

  function fallbackHTML(b) {
    var c = current();
    var tint = FALLBACK_TINTS[hashHue(b.title) % FALLBACK_TINTS.length];
    return '<span class="cover-fallback fb-' + tint + '">'
      + '<span class="fb-frame" aria-hidden="true"></span>'
      + '<span class="fb-emoji" aria-hidden="true">' + c.emoji + '</span>'
      + '<span class="fb-title">' + esc(b.title) + '</span>'
      + '<span class="fb-rule" aria-hidden="true"></span>'
      + (b.creator ? '<span class="fb-author">' + esc(b.creator) + '</span>' : '')
      + '</span>';
  }

  function coverBadgeHTML(b) {
    var c = current();
    var status = C.normalizeStatus(b.status);
    if (status === C.STATUS.STOPPED) return '<span class="cover-badge stopped">' + esc(C.statusLabel(c, 'stopped')) + '</span>';
    if (status === C.STATUS.ACTIVE) return '<span class="cover-badge reading">' + esc(C.statusLabel(c, 'active')) + '</span>';
    return '';
  }

  function cardHTML(b) {
    var img = b.cover ? '<img src="' + esc(b.cover) + '" alt="" loading="lazy" decoding="async">' : '';
    var rating = C.itemRating(b);
    return '<article class="card">'
      + '<div class="cover" data-act="open" data-id="' + esc(b.id) + '" role="button" tabindex="0" aria-label="' + esc(b.title) + ' 상세 보기">'
      + fallbackHTML(b)
      + img
      + coverBadgeHTML(b)
      + '<button type="button" class="card-stars' + (rating ? ' on' : '') + '" data-act="stars" data-id="' + esc(b.id) + '"'
      + ' aria-pressed="' + (rating > 0) + '" aria-label="' + esc(b.title) + ' 별점 ' + (rating ? rating + '개' : '없음') + ', 누르면 별점이 바뀝니다">'
      + starRowHTML(rating)
      + '</button>'
      + '</div>'
      + '<h3 class="card-title" data-act="open" data-id="' + esc(b.id) + '">' + esc(b.title) + '</h3>'
      + '<p class="card-author">' + esc(b.creator || '') + '</p>'
      + '</article>';
  }

  function attachImageFallback(img) {
    if (!img) return;
    if (img.complete && img.naturalWidth === 0) img.classList.add('err');
    img.addEventListener('error', function () { img.classList.add('err'); }, { once: true });
  }

  function renderGrid() {
    var c = current();
    var list = visibleItems();
    el.grid.innerHTML = list.map(cardHTML).join('');
    el.grid.className = 'grid tint-' + c.tint;

    Array.prototype.forEach.call(el.grid.querySelectorAll('img'), attachImageFallback);

    var isEmpty = list.length === 0;
    el.empty.hidden = !isEmpty;
    if (isEmpty) {
      if (!itemsOf().length) {
        el.emptyEmoji.textContent = c.empty.emoji;
        el.emptyText.textContent = c.empty.text;
        el.emptyAdd.textContent = c.label + ' 첫 기록 남기기';
      } else if (state.query.trim()) {
        el.emptyEmoji.textContent = '🔎';
        el.emptyText.textContent = '“' + state.query.trim() + '”에 맞는 ' + c.itemWord + '이 없어요.';
        el.emptyAdd.textContent = c.label + ' 기록 남기기';
      } else if (isRatingFilter(state.filter)) {
        el.emptyEmoji.textContent = '⭐';
        el.emptyText.textContent = '별 ' + ratingOfFilter(state.filter) + '개 준 ' + c.itemWord + '이 아직 없어요.';
        el.emptyAdd.textContent = c.label + ' 기록 남기기';
      } else {
        el.emptyEmoji.textContent = '🔎';
        el.emptyText.textContent = '이 분류에는 아직 ' + c.itemWord + '이 없어요.';
        el.emptyAdd.textContent = c.label + ' 기록 남기기';
      }
    }
  }

  function renderSampleNote() {
    var samples = itemsOf().filter(function (b) { return b.sample; });
    var busy = state.query.trim().length > 0 || state.filter !== 'all';
    var show = samples.length > 0 && !storeOf().hideSampleNote && !busy;
    el.sampleNote.hidden = !show;
    if (show) {
      el.sampleNoteText.innerHTML = '미리 넣어둔 샘플 기록이 <b>' + samples.length + '</b>개 있어요. 지우고 내 기록을 채워보세요.';
    }
  }

  function barRows(rows, emptyText, withPercent) {
    var c = current();
    if (!rows.length) return '<p class="bars-empty">' + esc(emptyText) + '</p>';
    var max = 0;
    rows.forEach(function (r) { if (r.count > max) max = r.count; });
    return rows.map(function (r) {
      var width = max ? Math.round((r.count / max) * 100) : 0;
      var label = withPercent ? r.label + ' (' + r.pct + '%)' : r.label;
      return '<div class="bar-row' + (withPercent ? ' cat' : '') + '">'
        + '<span class="bar-label">' + esc(label) + '</span>'
        + '<span class="bar-track"><span class="bar-fill" style="width:' + width + '%"></span></span>'
        + '<span class="bar-value">' + r.count + esc(c.unit) + '</span>'
        + '</div>';
    }).join('');
  }

  function renderStats() {
    var c = current();
    var s = C.computeStats(itemsOf(), c, new Date());
    el.statsHead.textContent = c.emoji + ' ' + c.label + ' 통계';
    el.statTotalLabel.textContent = c.stats.done;
    el.statYearLabel.textContent = c.stats.year;
    el.statTotal.textContent = s.total + c.unit;
    el.statYear.textContent = s.thisYear + c.unit;
    el.statStar.textContent = s.starred + c.unit;
    el.statStarLabel.textContent = '⭐ 별 준 ' + c.itemWord;
    el.statStarCard.title = '★★★ ' + s.ratingCounts[3] + c.unit + ' · ★★ ' + s.ratingCounts[2] + c.unit + ' · ★ ' + s.ratingCounts[1] + c.unit;
    el.panelYearTitle.textContent = (c.id === 'books' ? '연도별 완독 통계 🏆' : '연도별 본 기록 🏆');
    el.panelKindTitle.textContent = c.kindLabel + '별 분포 🏷️';
    el.barsYear.innerHTML = barRows(s.years, '아직 완료한 기록이 없어요.', false);
    el.barsMonth.innerHTML = barRows(s.months, '끝난 날짜가 있는 기록이 없어요.', false);
    el.barsKind.innerHTML = barRows(s.kinds, '등록된 기록이 없어요.', true);

    var bits = [];
    if (s.stopped) bits.push(C.statusLabel(c, 'stopped') + ' ' + s.stopped + c.unit);
    if (s.active) bits.push(C.statusLabel(c, 'active') + ' ' + s.active + c.unit);
    el.statNote.textContent = bits.length ? bits.join(' · ') + ' (통계에는 넣지 않았어요)' : '';
    el.statNote.hidden = bits.length === 0;
    el.dataNote.textContent = c.label + ' 기록을 JSON으로 복사하거나, 복사해 둔 기록을 불러옵니다.';
  }

  /* 상세 화면 날짜·상태 칩: "2026-09-10 ~ 2026-09-17 완독" / "2026-09-10 ~ 중단" */
  function statusLabel(c, status) { return C.statusLabel(c, status); }

  function statusChipText(b, c) {
    var start = b.startDate || '';
    var end = b.endDate || '';
    var range = '';
    if (start && end) range = start + ' ~ ' + end;
    else if (end) range = end;
    else if (start) range = start + ' ~';

    var status = C.normalizeStatus(b.status);
    if (!range) return status === C.STATUS.DONE ? '' : statusLabel(c, status);
    return range + ' ' + statusLabel(c, status);
  }

  function statusChipClass(b) {
    var status = C.normalizeStatus(b.status);
    if (status === C.STATUS.STOPPED) return ' stopped';
    if (status === C.STATUS.ACTIVE) return ' reading';
    return '';
  }

  /* ---------------- 화면 전환 ---------------- */

  function setView(view) {
    state.view = view;
    var isList = view === 'list';
    el.viewList.hidden = !isList;
    el.viewStats.hidden = isList;
    el.searchBox.hidden = !isList;
    el.btnView.textContent = isList ? '📊 통계' : '📚 목록';
    el.btnView.setAttribute('aria-pressed', String(!isList));
    if (!isList) renderStats();
    window.scrollTo(0, 0);
  }

  function setCollection(id, internal) {
    if (!id || !C.collection(id)) return;
    /* 비밀 보관함에서 다른 탭으로 옮기면 바로 잠깁니다. */
    if (!internal && state.current === 'secret' && id !== 'secret') { lockSecret(); return; }
    state.current = id;
    state.query = '';
    state.filter = 'all';
    state.statusFilter = 'all';
    el.search.value = '';
    el.searchClear.hidden = true;
    el.search.placeholder = current().searchPlaceholder;
    el.search.setAttribute('aria-label', current().searchPlaceholder);

    Array.prototype.forEach.call(el.collectionTabs.querySelectorAll('[data-collection]'), function (btn) {
      var on = btn.getAttribute('data-collection') === id;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', String(on));
    });
    el.app.setAttribute('data-collection', id);
    renderSummary();
    renderChips();
    renderGrid();
    renderStats();
    renderSampleNote();
    setView('list');
    updateSecretChrome();
    window.scrollTo(0, 0);
  }

  /* ---------------- 비밀 보관함 ---------------- */

  /* 비밀 보관함 모드에서는 탭 줄을 감추고 "잠그기" 줄을 보여 줍니다. */
  function updateSecretChrome() {
    var on = state.current === 'secret';
    if (el.collectionTabs) el.collectionTabs.hidden = on;
    if (el.secretBar) el.secretBar.hidden = !on;
    if (on) renderSecretStatus(el.secretState);
  }

  function normalizeSecretItems(items) {
    var c = C.collection('secret');
    return (items || []).map(function (b) { return C.normalizeItem(b, c); }).filter(Boolean);
  }

  /* 비밀번호를 맞히면 보관함 내용을 들여놓고 보관함 화면으로 갑니다. */
  function enterSecret(items) {
    state.store.secret = emptyStore();
    state.remote.secret = normalizeSecretItems(items);
    state.remoteLoaded.secret = true;
    mergeAll();
    setCollection('secret', true);
  }

  /* 다른 기기에서 바뀐 내용을 받았을 때(보관함을 열어 둔 채로). */
  function applySecretItems(items) {
    state.remote.secret = normalizeSecretItems(items);
    state.remoteLoaded.secret = true;
    if (state.current !== 'secret') return;
    refresh();
    if (state.detailId && state.detailColl === 'secret') {
      var b = findIn('secret', state.detailId);
      if (b) renderDetail(b);
      else { closeModal(el.detailModal); state.detailId = null; }
    }
  }

  /* 잠그기 — 암호 열쇠와 내용을 메모리에서 지우고 웹툰·웹소설 탭으로 돌아갑니다. */
  function lockSecret(opts) {
    if (lockingSecret) return;
    lockingSecret = true;
    var was = state.current === 'secret';
    try {
      state.store.secret = emptyStore();
      state.remote.secret = [];
      state.remoteLoaded.secret = false;
      state.items.secret = [];
      if (window.ShelfSecret) window.ShelfSecret.lock();
      if (was) setCollection('webtoons', true);
      else renderSummary();
    } finally {
      lockingSecret = false;
    }
    if (was && !(opts && opts.silent)) toast('보관함을 잠갔어요.');
  }

  function renderSecretStatus(s) {
    if (!el.secretState) return;
    s = s || (window.ShelfSecret ? window.ShelfSecret.status() : null);
    el.secretState.textContent = (s && s.text) || '';
    el.secretState.setAttribute('data-tone', (s && s.tone) || '');
  }

  /* ---------------- 상세 ---------------- */

  function openDetail(id) {
    var b = findItem(id);
    if (!b) return;
    state.detailId = id;
    state.detailColl = state.current;
    state.quoteDraft = '';
    state.quotePage = '';
    state.quoteEditingId = null;
    renderDetail(b);
    openModal(el.detailModal);
    el.detailBody.scrollTop = 0;
  }

  function renderDetail(b) {
    var c = coll(state.detailColl || state.current);
    var img = b.cover ? '<img src="' + esc(b.cover) + '" alt="">' : '';
    var scrollTop = el.detailBody.scrollTop;
    var link = c.link ? safeLink(b.link) : '';
    var creator = b.creator || (c.id === 'books' ? '저자 미상' : '');
    el.detailHeading.textContent = c.emoji + ' ' + c.label + ' 상세';

    el.detailBody.innerHTML =
      '<div class="detail-cover tint-' + c.tint + '">'
      + fallbackHTMLFor(b, c)
      + img
      + (C.itemRating(b) ? '<span class="cover-stars" aria-hidden="true">' + starRowHTML(C.itemRating(b), true) + '</span>' : '')
      + '</div>'
      + '<h2 class="detail-title">' + esc(b.title) + '</h2>'
      + '<p class="detail-author">' + esc(creator || ' ') + '</p>'
      + '<div class="detail-chips">'
      + '<span class="chip-static kind tint-' + c.tint + '">' + esc(b.kind || c.defaultKind) + '</span>'
      + (b.platform ? '<span class="chip-static">' + esc(b.platform) + '</span>' : '')
      + (statusChipText(b, c) ? '<span class="chip-static status' + statusChipClass(b) + '">' + esc(statusChipText(b, c)) + '</span>' : '')
      + '</div>'
      + '<div class="rating-control" role="group" aria-label="별점">'
      + '<span class="rating-label">별점</span>'
      + '<span class="rating-stars">' + ratingButtonsHTML(C.itemRating(b)) + '</span>'
      + '</div>'
      + (b.memo ? '<p class="detail-memo">' + esc(b.memo) + '</p>' : '')
      + (link ? '<a class="detail-link" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">🔗 링크 열기</a>' : '')
      + quotesHTML(b, c);

    attachImageFallback(el.detailBody.querySelector('img'));
    el.detailBody.scrollTop = scrollTop;
  }

  /* 상세 화면의 기본 표지는 그 기록 종류 이모지를 씁니다. */
  function fallbackHTMLFor(b, c) {
    var tint = FALLBACK_TINTS[hashHue(b.title) % FALLBACK_TINTS.length];
    return '<span class="cover-fallback fb-' + tint + '">'
      + '<span class="fb-frame" aria-hidden="true"></span>'
      + '<span class="fb-emoji" aria-hidden="true">' + c.emoji + '</span>'
      + '<span class="fb-title">' + esc(b.title) + '</span>'
      + '<span class="fb-rule" aria-hidden="true"></span>'
      + (b.creator ? '<span class="fb-author">' + esc(b.creator) + '</span>' : '')
      + '</span>';
  }

  /* ---------------- 문구 ---------------- */

  function dateLabel(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '';
    return m[1] + '.' + m[2] + '.' + m[3];
  }

  function findQuote(item, qid) {
    var list = (item && item.quotes) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === qid) return list[i];
    }
    return null;
  }

  function quotesHTML(b, c) {
    return '<section class="quotes" id="quotes-section" aria-label="' + esc(c.quotesLabel) + '">'
      + quotesInner(b, c) + '</section>';
  }

  function quotesInner(b, c) {
    var quotes = b.quotes || [];
    var editingId = state.quoteEditingId;
    if (editingId && !findQuote(b, editingId)) {
      editingId = null;
      state.quoteEditingId = null;
    }
    var editing = !!editingId;

    var html = '<div class="quotes-head">'
      + '<h3>💬 ' + esc(c.quotesLabel) + '</h3>'
      + (quotes.length ? '<span class="quotes-count">' + quotes.length + '개</span>' : '')
      + '</div>';

    html += '<div class="quote-form' + (editing ? ' is-editing' : '') + '">'
      + (editing ? '<p class="quote-form-note">고칠 내용을 적고 <b>수정 완료</b>를 눌러주세요.</p>' : '')
      + '<textarea class="input quote-input" id="quote-text" rows="2" maxlength="1000"'
      + ' placeholder="' + esc(c.quotePlaceholder) + '" aria-label="문구 내용">' + esc(state.quoteDraft) + '</textarea>'
      + '<div class="quote-form-row">'
      + (c.quotePage
        ? '<input class="input quote-page" id="quote-page" type="text" inputmode="numeric" maxlength="12" placeholder="페이지 (선택)" aria-label="페이지 번호 (선택)" autocomplete="off" value="' + esc(state.quotePage) + '">'
        : '')
      + '<button type="button" class="quote-save" data-act="quote-save">' + (editing ? '수정 완료' : '+ 저장') + '</button>'
      + (editing ? '<button type="button" class="quote-cancel" data-act="quote-cancel">취소</button>' : '')
      + '</div>'
      + '</div>';

    if (!quotes.length) {
      html += '<p class="quotes-empty">아직 저장한 ' + esc(c.quotePage ? '문구' : '기록') + '이 없어요. 기억에 남는 한 줄을 남겨보세요.</p>';
      return html;
    }

    html += '<ul class="quote-list">';
    quotes.slice().reverse().forEach(function (q) {
      var tags = '';
      if (q.page) tags += '<span class="quote-page-tag">p.' + esc(q.page) + '</span>';
      var d = dateLabel(q.createdAt);
      if (d) tags += '<span class="quote-date">' + d + '</span>';
      html += '<li class="quote-card' + (q.id === editingId ? ' is-editing' : '') + '">'
        + '<p class="quote-text">' + esc(q.text) + '</p>'
        + '<div class="quote-meta">'
        + '<span class="quote-tags">' + tags + '</span>'
        + '<span class="quote-actions">'
        + '<button type="button" class="quote-act" data-act="quote-edit" data-qid="' + esc(q.id) + '" aria-label="이 문구 수정">수정</button>'
        + '<button type="button" class="quote-act danger" data-act="quote-delete" data-qid="' + esc(q.id) + '" aria-label="이 문구 삭제">삭제</button>'
        + '</span>'
        + '</div>'
        + '</li>';
    });
    html += '</ul>';
    return html;
  }

  function renderQuotesSection() {
    var host = el.detailBody.querySelector('#quotes-section');
    var b = state.detailId ? findIn(state.detailColl, state.detailId) : null;
    if (!host || !b) return;
    host.innerHTML = quotesInner(b, coll(state.detailColl));
  }

  function readQuoteInput() {
    var t = el.detailBody.querySelector('#quote-text');
    var p = el.detailBody.querySelector('#quote-page');
    return { text: t ? String(t.value).trim() : '', page: p ? p.value : '' };
  }

  function commitQuotes(item, quotes, message, keepDraft) {
    upsertLocal(Object.assign({}, item, { quotes: quotes }));
    if (!keepDraft) {
      state.quoteDraft = '';
      state.quotePage = '';
      state.quoteEditingId = null;
    }
    refresh();
    if (state.detailId === item.id) renderQuotesSection();
    if (message) toast(message);
  }

  function saveQuote() {
    var b = state.detailId ? findIn(state.detailColl, state.detailId) : null;
    if (!b) return;
    var c = coll(state.detailColl);

    var input = readQuoteInput();
    if (!input.text) {
      toast('문구를 먼저 적어 주세요.');
      var t = el.detailBody.querySelector('#quote-text');
      if (t) t.focus();
      return;
    }

    var page = c.quotePage ? C.pageLabel(input.page) : '';
    var quotes = (b.quotes || []).slice();
    var editingId = state.quoteEditingId;

    if (editingId) {
      var i = -1;
      for (var k = 0; k < quotes.length; k++) {
        if (quotes[k].id === editingId) { i = k; break; }
      }
      if (i >= 0) {
        var updated = Object.assign({}, quotes[i], { text: input.text });
        if (page) updated.page = page; else delete updated.page;
        quotes[i] = updated;
      } else {
        editingId = null;
      }
    }

    if (!editingId) {
      var fresh = { id: C.newId(), text: input.text, createdAt: new Date().toISOString() };
      if (page) fresh.page = page;
      quotes.push(fresh);
    }

    commitQuotes(b, quotes, editingId ? '문구를 고쳤어요.' : '문구를 저장했어요.');

    var sec = el.detailBody.querySelector('#quotes-section');
    if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'nearest' });
  }

  function startQuoteEdit(qid) {
    var b = state.detailId ? findIn(state.detailColl, state.detailId) : null;
    var q = b ? findQuote(b, qid) : null;
    if (!q) return;
    state.quoteEditingId = q.id;
    state.quoteDraft = q.text;
    state.quotePage = q.page || '';
    renderQuotesSection();
    var t = el.detailBody.querySelector('#quote-text');
    if (t) {
      t.focus();
      try { t.setSelectionRange(t.value.length, t.value.length); } catch (err) { /* noop */ }
    }
    var sec = el.detailBody.querySelector('#quotes-section');
    if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function cancelQuoteEdit() {
    state.quoteEditingId = null;
    state.quoteDraft = '';
    state.quotePage = '';
    renderQuotesSection();
  }

  function quotePreview(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > 24 ? t.slice(0, 24) + '…' : t;
  }

  function deleteQuote(qid) {
    var b = state.detailId ? findIn(state.detailColl, state.detailId) : null;
    var target = b ? findQuote(b, qid) : null;
    if (!b || !target) return;

    confirmDialog({
      title: '문구를 삭제할까요?',
      message: '「' + quotePreview(target.text) + '」\n지운 문구는 되돌릴 수 없어요.',
      okText: '삭제'
    }).then(function (ok) {
      if (!ok) return;
      var item = state.detailId ? findIn(state.detailColl, state.detailId) : null;
      if (!item) return;
      var wasEditing = state.quoteEditingId === qid;
      var left = (item.quotes || []).filter(function (q) { return q.id !== qid; });
      if (wasEditing) {
        state.quoteEditingId = null;
        state.quoteDraft = '';
        state.quotePage = '';
      }
      commitQuotes(item, left, '문구를 지웠어요.', !wasEditing);
    });
  }

  /* ---------------- 책 정보 자동 검색 (제목 → 저자·표지·분야) ---------------- */

  var GOOGLE_FEED_API = 'https://books.google.com/books/feeds/volumes';
  var GOOGLE_BOOKS_API = 'https://www.googleapis.com/books/v1/volumes';
  var OPEN_LIBRARY_API = 'https://openlibrary.org/search.json';
  var LOOKUP_MAX = 5;
  var lookupSeq = 0;
  var googleCooldownUntil = 0;

  function mapCategory(values) {
    var text = (values || []).join(' ');
    if (!text) return '';
    var rules = [
      [/(essay|biograph|autobiograph|memoir|literary collections|self-help|diary|수필|에세이|자서전|자기계발)/i, '에세이'],
      [/(fiction|novel|literary criticism|short stories|소설|문학)/i, '소설'],
      [/(business|econom|management|finance|marketing|invest|경제|경영|재테크|투자)/i, '경제/경영'],
      [/(philosoph|histor|social science|psycholog|religion|political|anthropolog|sociolog|education|science|인문|철학|역사|사회|심리|과학)/i, '인문']
    ];
    for (var i = 0; i < rules.length; i++) {
      if (rules[i][0].test(text)) return rules[i][1];
    }
    return '';
  }

  function fixCoverUrl(url) {
    var u = String(url || '').trim();
    if (!u) return '';
    u = u.replace(/^http:\/\//i, 'https://');
    if (/books\.google\./.test(u)) {
      u = u.replace(/[?&]edge=curl/g, '');
      u = u.replace(/([?&])zoom=\d+/, '$1zoom=3');
      if (!/[?&]zoom=/.test(u)) u += (u.indexOf('?') >= 0 ? '&' : '?') + 'zoom=3';
    }
    return u;
  }

  function fetchJSON(url, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    if (ctrl) timer = setTimeout(function () { ctrl.abort(); }, ms || 8000);
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) { clearTimeout(timer); return data; })
      .catch(function (err) { clearTimeout(timer); throw err; });
  }

  function searchGoogleFeed(query) {
    var url = GOOGLE_FEED_API + '?q=' + encodeURIComponent(query) + '&alt=json&max-results=20';
    return fetchJSON(url, 8000).then(function (data) {
      var entries = (data && data.feed && data.feed.entry) || [];
      return entries.map(function (entry) {
        var title = ((entry['dc$title'] || [{}])[0] || {}).$t || (entry.title && entry.title.$t) || '';
        var creators = (entry['dc$creator'] || []).map(function (c) { return c.$t; }).filter(Boolean);
        var dates = (entry['dc$date'] || []).map(function (d) { return d.$t; }).filter(Boolean);
        var subjects = (entry['dc$subject'] || []).map(function (s) { return s.$t; }).filter(Boolean);
        var langs = (entry['dc$language'] || []).map(function (l) { return l.$t; }).filter(Boolean);
        var isbn = '';
        (entry['dc$identifier'] || []).forEach(function (id) {
          var v = String(id.$t || '');
          if (!isbn && /^ISBN:97[89]/.test(v)) isbn = v.replace('ISBN:', '');
        });
        var viewability = ((entry['gbs$viewability'] || {}).value || '').slice(-14);
        var volumeId = String(((entry.id || {}).$t) || '').split('/').pop();
        var thumb = '';
        if (viewability !== 'view_no_pages' && !/CAAJ$/.test(volumeId)) {
          (entry.link || []).forEach(function (l) {
            if (!thumb && String(l.rel || '').slice(-9) === 'thumbnail') thumb = l.href;
          });
        }
        return {
          title: String(title).trim(),
          creator: creators.slice(0, 3).join(', '),
          year: dates.length ? String(dates[0]).slice(0, 4) : '',
          cover: fixCoverUrl(thumb),
          thumb: fixCoverUrl(thumb),
          isbn: isbn,
          lang: (langs[0] || '').toLowerCase(),
          category: mapCategory(subjects.concat(creators)),
          desc: String((((entry['dc$description'] || [{}])[0] || {}).$t) || ''),
          source: 'Google Books'
        };
      }).filter(function (r) { return r.title; });
    });
  }

  function searchGoogleBooks(query) {
    if (Date.now() < googleCooldownUntil) {
      return Promise.reject(new Error('cooldown'));
    }
    var url = GOOGLE_BOOKS_API + '?q=' + encodeURIComponent('intitle:' + query)
      + '&maxResults=8&printType=books';
    return fetchJSON(url, 7000).then(function (data) {
      var items = (data && data.items) || [];
      return items.map(function (item) {
        var v = item.volumeInfo || {};
        var links = v.imageLinks || {};
        var cover = fixCoverUrl(links.thumbnail || links.smallThumbnail || '');
        var isbn = '';
        (v.industryIdentifiers || []).forEach(function (id) {
          if (!isbn && id.type === 'ISBN_13') isbn = id.identifier;
        });
        return {
          title: String(v.title || '').trim(),
          creator: (v.authors || []).join(', '),
          year: String(v.publishedDate || '').slice(0, 4),
          cover: cover,
          thumb: cover,
          isbn: isbn,
          lang: String(v.language || '').toLowerCase(),
          category: mapCategory(v.categories || []),
          desc: String(v.description || ''),
          source: 'Google Books'
        };
      }).filter(function (r) { return r.title; });
    }).catch(function (err) {
      if (String(err && err.message).indexOf('429') >= 0) googleCooldownUntil = Date.now() + 10 * 60 * 1000;
      throw err;
    });
  }

  function searchOpenLibrary(query) {
    var url = OPEN_LIBRARY_API + '?title=' + encodeURIComponent(query)
      + '&limit=10&fields=title,author_name,cover_i,first_publish_year,subject,key,first_sentence';
    return fetchJSON(url, 8000).then(function (data) {
      var docs = (data && data.docs) || [];
      return docs.map(function (doc) {
        var id = doc.cover_i;
        var sentence = doc.first_sentence;
        if (Array.isArray(sentence)) sentence = sentence[0];
        return {
          title: String(doc.title || '').trim(),
          creator: (doc.author_name || []).slice(0, 3).join(', '),
          year: doc.first_publish_year ? String(doc.first_publish_year) : '',
          cover: id ? 'https://covers.openlibrary.org/b/id/' + id + '-L.jpg' : '',
          thumb: id ? 'https://covers.openlibrary.org/b/id/' + id + '-M.jpg' : '',
          isbn: '',
          lang: 'ko',
          category: mapCategory(doc.subject || []),
          desc: String(sentence || ''),
          source: 'Open Library'
        };
      }).filter(function (r) { return r.title; });
    });
  }

  function titleKey(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/[\s\-.,:;!?'"`~@#$%^&*()\[\]{}<>\/\\|_+=·…‘’“”「」『』〈〉《》]/g, '');
  }

  function authorsMatch(a, b) {
    var na = titleKey(a), nb = titleKey(b);
    if (!na || !nb) return true;
    return na === nb || na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0;
  }

  function mergeLookupGroup(members, wantKo) {
    var primary = members[0];
    if (wantKo) {
      for (var i = 0; i < members.length; i++) {
        if (/[가-힣]/.test(members[i].title)) { primary = members[i]; break; }
      }
    }

    var merged = {
      title: primary.title,
      creator: '',
      year: '',
      cover: '',
      thumb: '',
      isbn: '',
      lang: primary.lang || '',
      category: '',
      desc: '',
      source: primary.source
    };

    members.forEach(function (m) {
      if (!merged.creator && m.creator && (!wantKo || /[가-힣]/.test(m.creator))) merged.creator = m.creator;
    });
    members.forEach(function (m) {
      if (!merged.creator && m.creator) merged.creator = m.creator;
      if (!merged.year && m.year) merged.year = m.year;
      if (!merged.isbn && m.isbn) merged.isbn = m.isbn;
      if (!merged.category && m.category) merged.category = m.category;
    });

    /* 줄거리·소개는 한글이 있는 것을 먼저, 없으면 가장 긴 것을 씁니다. */
    members.forEach(function (m) {
      var d = String(m.desc || '').trim();
      if (!d) return;
      if (!merged.desc) { merged.desc = d; return; }
      var koNow = /[가-힣]/.test(merged.desc), koNew = /[가-힣]/.test(d);
      if ((koNew && !koNow) || (koNew === koNow && d.length > merged.desc.length)) merged.desc = d;
    });

    for (var j = 0; j < members.length; j++) {
      var m2 = members[j];
      if (m2.cover && authorsMatch(merged.creator, m2.creator)) {
        merged.cover = m2.cover;
        merged.thumb = m2.thumb || m2.cover;
        break;
      }
    }
    if (!merged.cover) {
      for (var k = 0; k < members.length; k++) {
        if (members[k].cover) {
          merged.cover = members[k].cover;
          merged.thumb = members[k].thumb || members[k].cover;
          break;
        }
      }
    }
    return merged;
  }

  function rankLookupItems(query, lists) {
    var q = titleKey(query);
    var wantKo = /[가-힣]/.test(query);
    var groups = {};
    var order = [];

    lists.forEach(function (list) {
      (list || []).forEach(function (item) {
        var key = titleKey(item.title);
        if (!groups[key]) {
          groups[key] = [];
          order.push(key);
        }
        groups[key].push(item);
      });
    });

    var typed = String(query || '').trim().replace(/\s+/g, ' ');
    var rows = order.map(function (key, index) {
      var item = mergeLookupGroup(groups[key], wantKo);
      var score = key === q ? 3 : (key.indexOf(q) === 0 ? 2 : (key.indexOf(q) >= 0 ? 1 : 0));
      if (score === 3 && typed) item.title = typed;
      return { item: item, score: score, index: index, cover: item.cover ? 1 : 0 };
    });

    if (rows.some(function (r) { return r.score >= 2; })) {
      rows = rows.filter(function (r) { return r.score > 0; });
    }

    rows.sort(function (a, b) {
      return b.score - a.score || b.cover - a.cover || a.index - b.index;
    });
    return rows.slice(0, LOOKUP_MAX).map(function (r) { return r.item; });
  }

  function renderLookup() {
    var L = state.lookup;
    var c = current();
    el.fLookup.disabled = !!L.busy;
    el.fLookup.textContent = L.busy ? '🔎 찾는 중…' : (c.lookupLabel || '🔍 표지·저자 찾기');

    var showPanel = L.busy || L.items.length > 0 || !!L.message;
    el.fLookupPanel.hidden = !showPanel;
    if (!showPanel) {
      el.fLookupStatus.textContent = '';
      el.fLookupList.innerHTML = '';
      return;
    }

    el.fLookupStatus.className = 'lookup-status' + (L.tone ? ' ' + L.tone : '');
    el.fLookupStatus.textContent = L.busy
      ? (c.lookupBusy || '표지와 저자를 찾고 있어요…')
      : (L.message || c.lookupHint || '마음에 드는 책을 누르면 제목·저자·표지가 채워져요.');

    el.fLookupList.innerHTML = L.items.map(function (item, i) {
      var thumb = item.thumb || item.cover || '';
      var meta = [item.creator || (c.creatorShort || '저자') + ' 미상', item.year, item.platform || item.kind || item.category]
        .filter(Boolean).join(' · ');
      return '<li>'
        + '<button type="button" class="lookup-item" data-lookup="' + i + '">'
        + '<span class="lookup-thumb">'
        + (thumb ? '<img src="' + esc(thumb) + '" alt="" decoding="async">' : '<span class="lookup-none">📕</span>')
        + '</span>'
        + '<span class="lookup-text">'
        + '<span class="lookup-title">' + esc(item.title) + '</span>'
        + '<span class="lookup-meta">' + esc(meta) + '</span>'
        + '</span>'
        + '</button>'
        + '</li>';
    }).join('');

    Array.prototype.forEach.call(el.fLookupList.querySelectorAll('img'), function (img) {
      img.addEventListener('error', function () {
        var box = img.parentNode;
        if (box) box.innerHTML = '<span class="lookup-none">📕</span>';
      }, { once: true });
    });
  }

  function lookupBooks() {
    var query = el.fTitle.value.trim();
    if (!query) {
      toast('책 제목을 먼저 적어 주세요.');
      el.fTitle.focus();
      return;
    }

    var seq = ++lookupSeq;
    state.lookupQuery = query;
    state.lookup = { busy: true, items: [], message: '', tone: '' };
    renderLookup();

    function settled(promise) {
      return promise.then(
        function (value) { return { ok: true, value: value }; },
        function (error) { return { ok: false, error: error }; }
      );
    }

    function finish(lists, failed, total) {
      if (seq !== lookupSeq) return;
      var items = rankLookupItems(query, lists);
      if (items.length) {
        state.lookup = { busy: false, items: items, message: '', tone: '' };
      } else if (failed === total) {
        state.lookup = {
          busy: false,
          items: [],
          tone: 'error',
          message: '지금은 도서 검색 서비스가 응답하지 않아요. 인터넷 연결을 확인한 뒤 다시 눌러 주세요.'
        };
      } else {
        state.lookup = {
          busy: false,
          items: [],
          tone: 'empty',
          message: '검색 결과가 없어요. 비서에게 채팅으로 책 제목을 알려주시면 표지까지 바로 찾아 넣어드려요!'
        };
      }
      renderLookup();
    }

    Promise.all([settled(searchGoogleFeed(query)), settled(searchOpenLibrary(query))])
      .then(function (results) {
        var lists = [];
        var failed = 0;
        results.forEach(function (r) {
          if (r.ok) lists.push(r.value);
          else failed++;
        });
        if (rankLookupItems(query, lists).length || failed < results.length) {
          finish(lists, failed, results.length);
          return;
        }
        settled(searchGoogleBooks(query)).then(function (r) {
          if (r.ok) finish([r.value], 0, 1);
          else finish([], 1, 1);
        });
      });
  }

  function probeImage(url, timeoutMs) {
    return new Promise(function (resolve) {
      var img = new Image();
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve(false); } }, timeoutMs || 4000);
      img.onload = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(img.naturalWidth >= 60 && img.naturalHeight >= 60);
      };
      img.onerror = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(false);
      };
      img.src = url;
    });
  }

  function applyCover(url) {
    el.fCover.value = url;
    setCoverPreview(url);
  }

  function applyLookupItem(item) {
    if (!item) return;
    var formToken = state.editingId;
    var c = current();
    var who = c.creatorShort || '저자';
    el.fTitle.value = item.title;

    if (item.creator) {
      el.fCreator.value = item.creator;
      lastAuto.creator = item.creator;
    } else if (el.fCreator.value.trim() === lastAuto.creator) {
      el.fCreator.value = '';
      lastAuto.creator = '';
    }

    var kindValue = item.kind || item.category || '';
    if (kindValue && kindList(c).indexOf(kindValue) >= 0) renderFormKinds(kindValue, false);

    if (c.platform) {
      if (item.platform) {
        el.fPlatform.value = item.platform;
        lastAuto.platform = item.platform;
      } else if (el.fPlatform.value.trim() === lastAuto.platform) {
        el.fPlatform.value = '';
        lastAuto.platform = '';
      }
    }

    if (c.link) {
      var linked = el.fLink.value.trim();
      if (item.link) {
        if (!linked || linked === lastAuto.link) el.fLink.value = item.link;
      } else if (linked === lastAuto.link) {
        el.fLink.value = '';
      }
      lastAuto.link = item.link || '';
    }

    el.fTitleError.hidden = true;
    state.lookup = { busy: false, items: [], message: '', tone: '' };
    renderLookup();

    /* 줄거리·소개가 있으면 한줄 감상이 비어 있을 때만 조용히 채워 둡니다.
       (내가 쓴 감상은 건드리지 않습니다. 나중에 '줄거리 넣기' 버튼으로도 넣을 수 있음) */
    var summary = cleanSummary(item.desc, 150);
    /* 소개 글이 없거나, 한국어 제목인데 영어 소개뿐이면 한 번 더 찾아봅니다. */
    var wantBetter = !summary || (/[가-힣]/.test(item.title) && !/[가-힣]/.test(summary));
    state.lookupDesc = summary;
    renderSummaryButton();
    if (summary) {
      var memoNow = el.fMemo.value.trim();
      if (!memoNow || memoNow === lastAuto.memo) {
        el.fMemo.value = summary;
        lastAuto.memo = summary;
      }
    }
    if (wantBetter) {
      /* 후보 제목으로 먼저, 안 되면 내가 입력한 제목으로 백과 문서를 찾아봅니다. */
      var titles = [baseTitle(item.title)];
      var typed = String(state.lookupQuery || '').trim();
      if (typed && titleKey(typed) !== titleKey(item.title) && titleKey(item.title).indexOf(titleKey(typed)) >= 0) {
        titles.push(typed);
      }
      var extraLookup = (c.id === 'books')
        ? fetchBookSummaryGoogle(item.title).then(function (s) { return s || fetchWorkSummary(c.id, titles); })
        : fetchWorkSummary(c.id, titles);
      extraLookup.then(function (s) {
        if (!s || state.editingId !== formToken || el.formModal.hidden) return;
        state.lookupDesc = s;
        renderSummaryButton();
        var now = el.fMemo.value.trim();
        if (!now || now === lastAuto.memo) {
          el.fMemo.value = s;
          lastAuto.memo = s;
        }
      });
    }
    var extra = summary ? '·줄거리' : '';

    if (item.cover) {
      applyCover(item.cover);
      toast('제목·' + who + extra + '·표지를 채웠어요.');
      return;
    }
    if (!item.isbn) {
      toast('제목과 ' + who + extra + '를 채웠어요. 표지는 못 찾았어요.');
      return;
    }

    var ol = 'https://covers.openlibrary.org/b/isbn/' + item.isbn + '-L.jpg?default=false';
    probeImage(ol, 3500).then(function (ok) {
      if (state.editingId !== formToken || el.formModal.hidden) return;
      if (ok) {
        applyCover(ol);
        toast('제목·' + who + extra + '·표지를 채웠어요.');
      } else {
        toast('제목과 ' + who + extra + '를 채웠어요. 표지는 못 찾았어요.');
      }
    });
  }

  /* ---------------- 영상 · 웹툰 정보 자동 검색 (제목 → 감독·작가·표지·분야·플랫폼) ----------------
     서버도 키도 없이 브라우저에서 바로 부를 수 있는 공개 자료만 씁니다.
       · 위키데이터      : 작품·감독·작가·분야·종류 (origin=*)
       · 한국어 위키백과 : 포스터 그림·연출·작가·연재처 (origin=*)
       · 영어 위키백과   : 한국어판에 포스터가 없을 때 보충
       · AniList         : 웹툰·웹소설 표지와 작가 (CORS)
       · Google Books    : 단행본으로 나온 작품의 작가·표지 보충 (CORS) */

  var WIKI_API = {
    ko: 'https://ko.wikipedia.org/w/api.php',
    en: 'https://en.wikipedia.org/w/api.php'
  };
  var WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
  var ANILIST_API = 'https://graphql.anilist.co';
  var GBOOKS_FEED_API = 'https://books.google.com/books/feeds/volumes';
  var ANILIST_QUERY = 'query ($q: String) { Page(perPage: 5) { media(search: $q, type: MANGA, sort: SEARCH_MATCH) {'
    + ' id title { romaji native english } coverImage { large } format countryOfOrigin description(asHtml: false)'
    + ' staff(perPage: 3) { edges { role node { name { full native } } } } startDate { year } siteUrl } } }';

  /* 위키데이터 P31(종류) 값 — 작품 종류를 가려낼 때 씁니다. */
  var FILM_TYPES = ['Q11424', 'Q202866', 'Q93204', 'Q506240', 'Q24856', 'Q29168811', 'Q17517379', 'Q842256'];
  var SHOW_TYPES = ['Q5398426', 'Q581714', 'Q1259759', 'Q63952888', 'Q117467246'];
  var PROGRAM_TYPES = ['Q15416', 'Q1261214'];
  var WEBTOON_TYPES = ['Q74262765', 'Q8274', 'Q1760610', 'Q1004'];
  var WEBNOVEL_TYPES = ['Q1667921', 'Q8261'];

  var PLATFORM_RULES = [
    [/네이버\s*웹툰|네이버웹툰|네이버\s*만화/i, '네이버웹툰'],
    [/네이버\s*시리즈|네이버시리즈/i, '네이버시리즈'],
    [/카카오\s*페이지|카카오페이지/i, '카카오페이지'],
    [/카카오\s*웹툰|다음\s*웹툰|만화속세상/i, '카카오웹툰'],
    [/레진/i, '레진코믹스'],
    [/리디|RIDI/i, '리디'],
    [/문피아/i, '문피아'],
    [/노벨피아/i, '노벨피아'],
    [/조아라/i, '조아라'],
    [/미스터블루/i, '미스터블루'],
    [/봄툰/i, '봄툰'],
    [/탑툰/i, '탑툰'],
    [/북큐브/i, '북큐브'],
    [/원스토어/i, '원스토어']
  ];

  function apiUrl(base, params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === null || v === undefined || v === '') return;
      parts.push(k + '=' + encodeURIComponent(String(v)));
    });
    return base + (base.indexOf('?') >= 0 ? '&' : '?') + parts.join('&');
  }

  function uniq(list) {
    var out = [];
    (list || []).forEach(function (v) { if (v && out.indexOf(v) < 0) out.push(v); });
    return out;
  }

  function postJSON(url, payload, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    if (ctrl) timer = setTimeout(function () { ctrl.abort(); }, ms || 9000);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      clearTimeout(timer);
      return data;
    }).catch(function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function wikiSearchPages(lang, query, limit) {
    var url = apiUrl(WIKI_API[lang], {
      action: 'query', generator: 'search', gsrsearch: query, gsrlimit: limit || 6, gsrnamespace: 0,
      prop: 'extracts', exintro: 1, explaintext: 1, exchars: 700, format: 'json', origin: '*'
    });
    return fetchJSON(url, 9000).then(function (data) {
      var pages = (data && data.query && data.query.pages) || {};
      return Object.keys(pages).map(function (k) { return pages[k]; })
        .sort(function (a, b) { return (a.index || 99) - (b.index || 99); })
        .map(function (p) { return { title: p.title || '', extract: p.extract || '' }; });
    });
  }

  function wikiWikitext(lang, titles) {
    titles = uniq(titles).slice(0, 10);
    if (!titles.length) return Promise.resolve({});
    var chunks = [];
    for (var i = 0; i < titles.length; i += 5) chunks.push(titles.slice(i, i + 5));
    return Promise.all(chunks.map(function (chunk) {
      var url = apiUrl(WIKI_API[lang], {
        action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', redirects: 1,
        titles: chunk.join('|'), format: 'json', origin: '*'
      });
      return fetchJSON(url, 10000).catch(function () { return null; });
    })).then(function (list) {
      var out = {};
      list.forEach(function (data) {
        if (!data || !data.query) return;
        var pages = data.query.pages || {};
        var alias = {};
        (data.query.redirects || []).forEach(function (r) { alias[r.from] = r.to; });
        var byTitle = {};
        Object.keys(pages).forEach(function (k) {
          var p = pages[k];
          var revs = p.revisions || [];
          if (!revs.length || !revs[0].slots || !revs[0].slots.main) return;
          byTitle[p.title] = revs[0].slots.main['*'] || '';
        });
        Object.keys(byTitle).forEach(function (t) { out[t] = byTitle[t]; });
        Object.keys(alias).forEach(function (from) {
          if (byTitle[alias[from]] && !out[from]) out[from] = byTitle[alias[from]];
        });
      });
      return out;
    });
  }

  /* 정보상자 값에서 각주·틀·링크를 걷어내고 사람이 읽을 값만 남깁니다. */
  function cleanWikiValue(raw) {
    var v = String(raw || '');
    if (!v) return '';
    v = v.replace(/<ref[^>]*\/>/g, ' ').replace(/<ref[\s\S]*?<\/ref>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
    v = v.replace(/\{\{[\s\S]*?\}\}/g, ' ');
    v = v.replace(/\[\[([^\]|]*\|)?/g, '').replace(/\]\]/g, '');
    v = v.replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, ' ');
    v = v.replace(/&nbsp;/g, ' ').replace(/''+/g, '');
    v = v.replace(/\s+/g, ' ').replace(/^[\s|,·]+|[\s|,·]+$/g, '').trim();
    if (!v) return '';
    if (/=/.test(v)) return '';
    if (v.length > 120) v = v.slice(0, 120).trim();
    return v;
  }

  /* 문서 첫머리의 정보상자(틀)만 골라 냅니다. 본문에 섞인 다른 틀의 값을 잘못 집지 않도록. */
  function infoboxText(wikitext) {
    var text = String(wikitext || '');
    var i = 0;
    while (i < text.length - 1) {
      if (text.charAt(i) !== '{' || text.charAt(i + 1) !== '{') { i++; continue; }
      var depth = 0;
      var j = i;
      for (; j < text.length - 1; j++) {
        if (text.charAt(j) === '{' && text.charAt(j + 1) === '{') { depth++; j++; }
        else if (text.charAt(j) === '}' && text.charAt(j + 1) === '}') { depth--; j++; if (depth === 0) break; }
      }
      var block = text.slice(i, j + 1);
      if (block.length < 8000 && /(그림|감독|연출|작가|장르|poster|image)/.test(block)) return block;
      i = j + 1;
    }
    return text.slice(0, 6000);
  }

  function infoField(wikitext, names) {
    var text = infoboxText(wikitext);
    for (var i = 0; i < names.length; i++) {
      var m = text.match(new RegExp('\\|\\s*' + names[i] + '\\s*=\\s*([^\\n]*)'));
      if (!m) continue;
      var v = cleanWikiValue(m[1]);
      if (v) return v;
    }
    return '';
  }

  function wikiFileUrl(lang, value) {
    var v = String(value || '').trim();
    if (!v) return '';
    var m = v.match(/(?:파일|File|Image)\s*:\s*([^|\]\n]+)/i);
    var file = m ? m[1] : v;
    file = file.replace(/\[\[|\]\]/g, '').split('|')[0].trim();
    if (!/\.(jpe?g|png|webp|gif|svg)$/i.test(file)) return '';
    var host = lang === 'ko' ? 'ko.wikipedia.org' : 'en.wikipedia.org';
    return 'https://' + host + '/wiki/Special:FilePath/' + encodeURIComponent(file.replace(/\s+/g, '_')) + '?width=400';
  }

  function wdSearch(query, limit) {
    var url = apiUrl(WIKIDATA_API, {
      action: 'wbsearchentities', search: query, language: 'ko', uselang: 'ko',
      type: 'item', limit: limit || 6, format: 'json', origin: '*'
    });
    return fetchJSON(url, 9000).then(function (data) { return (data && data.search) || []; });
  }

  function wdEntities(ids) {
    ids = uniq(ids).slice(0, 20);
    if (!ids.length) return Promise.resolve({});
    var url = apiUrl(WIKIDATA_API, {
      action: 'wbgetentities', ids: ids.join('|'), props: 'labels|descriptions|claims|sitelinks',
      languages: 'ko|en', sitefilter: 'kowiki|enwiki', format: 'json', origin: '*'
    });
    return fetchJSON(url, 10000).then(function (data) { return (data && data.entities) || {}; });
  }

  function wdLabels(ids) {
    ids = uniq(ids).slice(0, 45);
    if (!ids.length) return Promise.resolve({});
    var url = apiUrl(WIKIDATA_API, {
      action: 'wbgetentities', ids: ids.join('|'), props: 'labels', languages: 'ko|en', format: 'json', origin: '*'
    });
    return fetchJSON(url, 10000).then(function (data) {
      var out = {};
      var ents = (data && data.entities) || {};
      Object.keys(ents).forEach(function (id) {
        var labels = ents[id].labels || {};
        var hit = labels.ko || labels.en || {};
        out[id] = hit.value || '';
      });
      return out;
    });
  }

  function wdValues(ent, prop) {
    var out = [];
    (((ent || {}).claims || {})[prop] || []).forEach(function (claim) {
      var dv = claim && claim.mainsnak && claim.mainsnak.datavalue;
      if (!dv) return;
      var v = dv.value;
      if (v && typeof v === 'object') out.push(String(v.id || v.time || v.text || v.amount || ''));
      else if (v !== undefined && v !== null) out.push(String(v));
    });
    return out;
  }

  function wdLabelOf(ent, lang) {
    var labels = (ent || {}).labels || {};
    var hit = labels[lang] || labels.en || {};
    return hit.value || '';
  }

  function wdDescOf(ent) {
    var d = (ent || {}).descriptions || {};
    return ((d.ko || d.en || {}).value) || '';
  }

  function wdSite(ent, site) {
    return (((ent || {}).sitelinks || {})[site] || {}).title || '';
  }

  function sourceRank(source) {
    if (source === '한국어 위키백과') return 1;
    if (source === '위키데이터') return 2;
    if (source === 'AniList') return 3;
    if (source === 'Google Books') return 4;
    return 9;
  }

  function shortNames(value, stripParens) {
    var text = String(value || '').replace(/[{}[\]|]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (stripParens) text = text.replace(/\s*\([^)]*\)/g, ' ');
    var parts = text.split(/[,、·/]/).map(function (part) {
      return part.replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
    var out = [];
    parts.forEach(function (part) { if (out.indexOf(part) < 0) out.push(part); });
    return out.slice(0, 3).join(', ');
  }

  function yearOf(text) {
    var m = String(text || '').match(/(\d{4})/);
    return m ? m[1] : '';
  }

  function plausibleYear(value) {
    var y = parseInt(String(value || ''), 10);
    if (!y || y < 1900 || y > 2100) return '';
    return String(y);
  }

  function baseTitle(title) {
    var t = String(title || '').trim();
    var prev = '';
    while (t !== prev) {
      prev = t;
      t = t.replace(/\s*\([^()]{1,24}\)\s*$/, '').trim();
    }
    return t;
  }

  function mediaKey(title) {
    return titleKey(baseTitle(title));
  }

  function videoKindFrom(text, flags) {
    var t = String(text || '');
    flags = flags || {};
    if (!t && !flags.film && !flags.show && !flags.program) return '';
    if (/(애니메이션|애니|animation|anime)/i.test(t)) return '애니';
    if (/(다큐멘터리|다큐|documentary|시사|교양)/i.test(t)) return '다큐';
    if (/(예능|버라이어티|variety|오락|토크쇼)/i.test(t)) return '예능';
    if (flags.film) return '영화';
    if (flags.show) return '드라마';
    if (/(드라마|텔레비전\s*시리즈|TV\s*시리즈|시트콤|television series|tv series)/i.test(t)) return '드라마';
    if (flags.program) return '예능';
    if (/(영화|film|movie)/i.test(t)) return '영화';
    return '';
  }

  function kindFromText(text) {
    var t = String(text || '');
    var iComic = t.search(/웹툰|만화|코믹|manhwa|webtoon|comic|manga/i);
    var iNovel = t.search(/웹소설|인터넷\s*소설|웹\s*노블|라이트\s*노블|web novel|light novel/i);
    if (iNovel >= 0 && (iComic < 0 || iNovel < iComic)) return '웹소설';
    if (iComic >= 0) return '웹툰';
    if (/(소설|novel)/i.test(t)) return '웹소설';
    return '';
  }

  /* 문서 첫 문장만 잘라 냅니다. 작품이 무엇인지 가장 분명하게 말하는 부분입니다. */
  function firstSentence(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    var cut = t.indexOf('. ');
    if (cut < 0) cut = t.indexOf('\n');
    if (cut > 12) t = t.slice(0, cut + 1);
    return t.slice(0, 160);
  }

  /* 검색으로 받은 줄거리·소개 글을 한줄 감상칸에 넣기 좋게 다듬습니다.
     HTML 태그·위키 기호·각주를 걷어내고, 1~2문장(120~150자 안쪽)으로 자릅니다. */
  function cleanSummary(raw, max) {
    var t = String(raw || '');
    if (!t) return '';
    t = t.replace(/<br\s*\/?>/gi, ' ');
    t = t.replace(/<\/(p|div|li|h[1-6])>/gi, '. ');
    t = t.replace(/<[^>]+>/g, ' ');
    t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    t = t.replace(/\{\{[^{}]*\}\}/g, ' ');
    t = t.replace(/\[\[([^\]|]*\|)?/g, '').replace(/\]\]/g, '');
    t = t.replace(/\[[0-9]+\]/g, ' ');
    t = t.replace(/(^|\s)[=*#]{2,}[^=*#]*[=*#]{2,}/g, ' ');
    t = t.replace(/'''+/g, '');
    t = t.replace(/\.\s*\./g, '.');
    t = t.replace(/\s+([,.!?])/g, '$1');
    t = t.replace(/\s+/g, ' ').trim();
    t = t.replace(/^[\s.,·:;\-–—]+/, '');
    if (!t) return '';

    var limit = max || 150;
    if (t.length <= limit) return t;

    var sentences;
    try { sentences = t.split(/(?<=[.!?。])\s+/); } catch (e) { sentences = [t]; }
    var out = '';
    for (var i = 0; i < sentences.length; i++) {
      var next = out ? out + ' ' + sentences[i] : sentences[i];
      if (next.length > limit) break;
      out = next;
      if (out.length >= limit * 0.72) break;
    }
    if (!out) {
      var head = t.slice(0, limit);
      var sp = head.lastIndexOf(' ');
      out = (sp > limit * 0.55 ? head.slice(0, sp) : head).replace(/[\s,.;:·\-]+$/, '') + '…';
    }
    return out.trim();
  }

  /* 책 소개 글이 검색 결과에 없을 때, 제목이 꼭 맞는 책 소개글이나 백과 문서 첫머리를 한 번 더 찾아봅니다. */
  function fetchBookSummaryGoogle(title) {
    if (Date.now() < googleCooldownUntil) return Promise.resolve('');
    return searchGoogleBooks(title).then(function (list) {
      var q = titleKey(title);
      var best = '';
      for (var i = 0; i < (list || []).length; i++) {
        var d = String(list[i].desc || '').trim();
        if (!d) continue;
        if (titleKey(list[i].title) === q) return cleanSummary(d, 150);
        if (!best) best = d;
      }
      return best ? cleanSummary(best, 150) : '';
    }, function () { return ''; });
  }

  /* 제목이 꼭 맞는 한국어 백과 문서의 첫머리를 가져옵니다. (작품 설명인지 한 번 더 가립니다) */
  function workLikeText(text) {
    return /(소설|웹툰|웹소설|만화|드라마|영화|애니메이션|연재|출판|작품|저자|작가|장편|단편|에세이|시집|시리즈|방송|개봉|무대|공연)/.test(String(text || ''));
  }

  function fetchBookSummary(title) {
    var q = titleKey(title);
    if (!q) return Promise.resolve('');
    return wikiSearchPages('ko', title, 5).then(function (pages) {
      var best = '';
      var bestScore = 0;
      (pages || []).forEach(function (p) {
        var key = titleKey(p.title);
        if (!(key === q || key.indexOf(q) === 0)) return;
        var extract = String(p.extract || '');
        if (!workLikeText(extract)) return;     /* 식물·지명 같은 동명 문서는 건너뜁니다 */
        var score = 1;
        if (key !== q) score += 1;              /* '아몬드 (소설)'처럼 종류를 붙인 문서를 더 선호 */
        if (workLikeText(p.title)) score += 1;
        if (extract.indexOf('《' + title) === 0 || extract.indexOf(title) === 0) score += 1;
        if (score > bestScore) { bestScore = score; best = extract; }
      });
      return best ? cleanSummary(best, 150) : '';
    }, function () { return ''; });
  }

  /* 그 기록 종류에 어울리는 줄거리인지 가립니다. (책 칸에 영화 줄거리가 들어가지 않게) */
  function summaryKindOk(collId, extract) {
    var t = String(extract || '');
    if (collId === 'videos') return looksLikeVideo(t);
    if (collId === 'webtoons' || collId === 'secret') return !!(kindFromText(t) || looksLikeWebtoon(t));
    if (/(영화|드라마|텔레비전|방송|애니메이션)/.test(t) && !/(소설|에세이|문학|저서|작품집|동화|수필)/.test(t)) return false;
    return workLikeText(t);
  }

  /* 제목이 꼭 맞는 백과 문서에서 줄거리를 찾습니다. 후보 제목 → 내가 입력한 제목 순서로. */
  function fetchWorkSummary(collId, titles) {
    var tried = [];
    function tryOne(i) {
      if (i >= titles.length) return Promise.resolve('');
      var title = String(titles[i] || '').trim();
      var q = titleKey(title);
      if (!q || tried.indexOf(q) >= 0) return tryOne(i + 1);
      tried.push(q);
      return wikiSearchPages('ko', title, 5).then(function (pages) {
        var best = '';
        var bestScore = 0;
        (pages || []).forEach(function (p) {
          var key = titleKey(p.title);
          if (!(key === q || key.indexOf(q) === 0)) return;
          var extract = String(p.extract || '');
          if (!summaryKindOk(collId, extract)) return;
          var score = 1;
          if (key !== q) score += 1;
          if (extract.indexOf('《' + title) === 0 || extract.indexOf(title) === 0) score += 1;
          if (score > bestScore) { bestScore = score; best = extract; }
        });
        if (best) return cleanSummary(best, 150);
        return tryOne(i + 1);
      }, function () { return tryOne(i + 1); });
    }
    return tryOne(0);
  }

  function looksLikeWebtoon(text) {
    return /(웹툰|웹소설|만화|소설|코믹|novel|comic|manhwa|manga)/i.test(String(text || ''));
  }

  function looksLikeVideo(text) {
    return /(영화|드라마|방송|프로그램|시리즈|애니메이션|텔레비전|film|movie|series|television|program)/i.test(String(text || ''));
  }

  function detectPlatform(text) {
    var t = String(text || '');
    for (var i = 0; i < PLATFORM_RULES.length; i++) {
      if (PLATFORM_RULES[i][0].test(t)) return PLATFORM_RULES[i][1];
    }
    return '';
  }

  /* 한국어 위키백과 정보상자에서 표지 그림·연출·작가·연재처를 꺼냅니다. */
  function enrichWithWikiKo(list) {
    var titles = [];
    list.forEach(function (it) {
      if (it.wikiTitle) titles.push(it.wikiTitle);
      if (it.koTitle) titles.push(it.koTitle);
    });
    return wikiWikitext('ko', titles).then(function (texts) {
      list.forEach(function (it) {
        var wt = texts[it.wikiTitle] || texts[it.koTitle] || '';
        if (!wt) return;
        it.wikiLead = firstSentence(it.desc);
        it.wikiDirector = infoField(wt, ['감독', '연출']);
        it.wikiAuthor = infoField(wt, ['작가', '글', '저자']);
        it.wikiGenre = infoField(wt, ['장르']);
        it.wikiPlace = infoField(wt, ['연재처', '플랫폼', '방송사', '방송 채널']);
        it.wikiYear = plausibleYear(yearOf(infoField(wt, ['방송 기간', '방영 기간', '개봉일', '공개일', '방송일', '발행일', '연재 기간'])));
        it.wikiPoster = wikiFileUrl('ko', infoField(wt, ['그림', '이미지', '포스터']));
      });
      return list;
    });
  }

  /* 한국어 위키백과에 포스터가 없으면 영어 위키백과 정보상자 그림으로 채웁니다. */
  function fillPostersFromEn(list) {
    var need = list.filter(function (it) { return !it.cover && !it.wikiPoster && it.enTitle; }).slice(0, 4);
    if (!need.length) return Promise.resolve(list);
    return wikiWikitext('en', need.map(function (it) { return it.enTitle; })).then(function (texts) {
      need.forEach(function (it) {
        var wt = texts[it.enTitle];
        if (!wt) return;
        it.wikiPoster = wikiFileUrl('en', infoField(wt, ['poster', 'image', 'Image', 'cover']));
      });
      return list;
    });
  }

  function wdVideoItems(query) {
    return wdSearch(query, 6).then(function (hits) {
      if (!hits.length) return [];
      return wdEntities(hits.map(function (h) { return h.id; })).then(function (ents) {
        var rows = [];
        var labelIds = [];
        hits.forEach(function (hit) {
          var ent = ents[hit.id] || {};
          var types = wdValues(ent, 'P31');
          var dirs = wdValues(ent, 'P57');
          var genres = wdValues(ent, 'P136');
          var makers = wdValues(ent, 'P272');
          var country = wdValues(ent, 'P495');
          labelIds = labelIds.concat(types, dirs, genres, makers);
          rows.push({
            title: wdLabelOf(ent, 'ko') || hit.label || '',
            koTitle: wdSite(ent, 'kowiki'),
            enTitle: wdSite(ent, 'enwiki'),
            desc: wdDescOf(ent) || hit.description || '',
            types: types, dirs: dirs, genres: genres, makers: makers, country: country,
            year: plausibleYear(yearOf(wdValues(ent, 'P577')[0])),
            source: '위키데이터'
          });
        });
        return wdLabels(labelIds).then(function (labels) {
          return rows.map(function (row) {
            var director = row.dirs.map(function (id) { return labels[id]; }).filter(Boolean).join(', ')
              || row.makers.map(function (id) { return labels[id]; }).filter(Boolean).slice(0, 2).join(', ');
            var genreText = row.genres.map(function (id) { return labels[id]; }).filter(Boolean).join(' ');
            var typeText = row.types.map(function (id) { return labels[id]; }).filter(Boolean).join(' ');
            var isFilm = row.types.some(function (t) { return FILM_TYPES.indexOf(t) >= 0; });
            var isShow = row.types.some(function (t) { return SHOW_TYPES.indexOf(t) >= 0; });
            var isProgram = row.types.some(function (t) { return PROGRAM_TYPES.indexOf(t) >= 0; });
            return {
              title: row.title,
              creator: director,
              year: row.year,
              kind: videoKindFrom([row.desc, genreText, typeText].join(' '), { film: isFilm, show: isShow, program: isProgram }),
              koTitle: row.koTitle,
              enTitle: row.enTitle,
              desc: row.desc,
              extra: [genreText, typeText].join(' '),
              yearReliable: !!row.year,
              kr: row.country.indexOf('Q884') >= 0 || /대한민국|한국/.test(row.desc || ''),
              film: isFilm,
              show: isShow,
              program: isProgram,
              media: (isFilm || isShow || isProgram) ? 'video' : '',
              rank: (row.country.indexOf('Q884') >= 0 || /대한민국|한국/.test(row.desc || '')) ? 2 : 3,
              source: '위키데이터'
            };
          });
        });
      });
    });
  }

  function wikiVideoItems(query) {
    return wikiSearchPages('ko', query, 6).then(function (pages) {
      return pages.filter(function (p) {
        return !/^(?:[^\n]{0,40}(?:배우|가수|감독|작가|만화가|성우|방송인)이다)/.test(p.extract || '');
      }).map(function (p) {
        return {
          title: p.title,
          wikiTitle: p.title,
          desc: p.extract,
          kind: videoKindFrom(p.extract),
          rank: 1,
          source: '한국어 위키백과'
        };
      });
    });
  }

  function wdWebtoonItems(query) {
    return wdSearch(query, 6).then(function (hits) {
      if (!hits.length) return [];
      return wdEntities(hits.map(function (h) { return h.id; })).then(function (ents) {
        var rows = [];
        var labelIds = [];
        hits.forEach(function (hit) {
          var ent = ents[hit.id] || {};
          var types = wdValues(ent, 'P31');
          var authors = wdValues(ent, 'P50');
          var genres = wdValues(ent, 'P136');
          labelIds = labelIds.concat(types, authors, genres);
          rows.push({
            title: wdLabelOf(ent, 'ko') || hit.label || '',
            koTitle: wdSite(ent, 'kowiki'),
            enTitle: wdSite(ent, 'enwiki'),
            desc: wdDescOf(ent) || hit.description || '',
            types: types, authors: authors, genres: genres,
            year: plausibleYear(yearOf(wdValues(ent, 'P577')[0])),
            source: '위키데이터'
          });
        });
        return wdLabels(labelIds).then(function (labels) {
          return rows.map(function (row) {
            var isWebtoon = row.types.some(function (t) { return WEBTOON_TYPES.indexOf(t) >= 0; });
            var isNovel = row.types.some(function (t) { return WEBNOVEL_TYPES.indexOf(t) >= 0; });
            var isVideo = row.types.some(function (t) {
              return FILM_TYPES.indexOf(t) >= 0 || SHOW_TYPES.indexOf(t) >= 0 || PROGRAM_TYPES.indexOf(t) >= 0;
            });
            if (isVideo && !isWebtoon && !isNovel) return null;
            var typeText = row.types.map(function (id) { return labels[id]; }).filter(Boolean).join(' ');
            var genreText = row.genres.map(function (id) { return labels[id]; }).filter(Boolean).join(' ');
            var text = [row.desc, typeText, genreText].join(' ');
            return {
              title: row.title,
              creator: row.authors.map(function (id) { return labels[id]; }).filter(Boolean).join(', '),
              year: row.year,
              kind: isNovel ? '웹소설' : (isWebtoon ? '웹툰' : kindFromText(text)),
              platform: detectPlatform(text),
              koTitle: row.koTitle,
              enTitle: row.enTitle,
              desc: row.desc,
              extra: typeText + ' ' + genreText,
              media: (isWebtoon || isNovel) ? 'webtoon' : '',
              rank: 2,
              yearReliable: !!row.year,
              source: '위키데이터'
            };
          }).filter(Boolean);
        });
      });
    });
  }

  function wikiWebtoonItems(query) {
    return wikiSearchPages('ko', query, 6).then(function (pages) {
      return pages.filter(function (p) {
        return kindFromText(p.extract) || looksLikeWebtoon(p.extract);
      }).map(function (p) {
        return {
          title: p.title,
          wikiTitle: p.title,
          desc: p.extract,
          kind: kindFromText(p.extract),
          platform: detectPlatform(p.extract),
          rank: 1,
          source: '한국어 위키백과'
        };
      });
    });
  }

  function aniListItems(query) {
    return postJSON(ANILIST_API, { query: ANILIST_QUERY, variables: { q: query } }, 9000).then(function (data) {
      var media = (((data || {}).data || {}).Page || {}).media || [];
      return media.map(function (m) {
        var titles = m.title || {};
        var creator = ((m.staff || {}).edges || []).map(function (edge) {
          var n = (edge.node || {}).name || {};
          return n.native || n.full || '';
        }).filter(Boolean).join(', ');
        return {
          title: titles.native || titles.romaji || titles.english || '',
          creator: creator,
          year: ((m.startDate || {}).year || '') + '',
          cover: ((m.coverImage || {}).large) || '',
          kind: String(m.format || '').toUpperCase() === 'NOVEL' ? '웹소설' : '웹툰',
          link: m.siteUrl || '',
          desc: String(m.description || ''),
          media: m.countryOfOrigin === 'KR' ? 'webtoon' : '',
          rank: 3,
          source: 'AniList'
        };
      }).filter(function (it) { return it.title; });
    });
  }

  function gbooksItems(query) {
    var url = apiUrl(GBOOKS_FEED_API, { q: query, alt: 'json', 'max-results': 10 });
    return fetchJSON(url, 9000).then(function (data) {
      var entries = (((data || {}).feed || {}).entry) || [];
      return entries.map(function (entry) {
        var title = ((entry['dc$title'] || [{}])[0] || {}).$t || '';
        var creators = (entry['dc$creator'] || []).map(function (c) { return c.$t; }).filter(Boolean);
        var dates = (entry['dc$date'] || []).map(function (d) { return d.$t; }).filter(Boolean);
        var thumb = '';
        (entry.link || []).forEach(function (l) {
          if (!thumb && String(l.rel || '').slice(-9) === 'thumbnail') thumb = l.href;
        });
        return {
          title: String(title || '').trim(),
          creator: creators.slice(0, 2).join(', '),
          year: dates.length ? String(dates[0]).slice(0, 4) : '',
          cover: fixCoverUrl(thumb),
          kind: kindFromText(title),
          rank: 4,
          source: 'Google Books'
        };
      }).filter(function (it) { return it.title; });
    });
  }

  function videoSources(query) {
    function settle(p) {
      return p.then(
        function (items) { return { ok: true, items: items }; },
        function () { return { ok: false, items: [] }; }
      );
    }
    return Promise.all([settle(wdVideoItems(query)), settle(wikiVideoItems(query))]).then(function (res) {
      var list = [];
      var okCount = 0;
      res.forEach(function (r) {
        if (r.ok) okCount++;
        list = list.concat(r.items);
      });
      if (!list.length) return { items: [], okCount: okCount };
      return enrichWithWikiKo(list)
        .then(fillPostersFromEn)
        .then(function (rows) {
          var items = rows.map(function (it) {
            var kind = videoKindFrom(it.wikiLead || '')
              || videoKindFrom([it.wikiGenre, it.desc, it.extra].join(' '), { film: it.film, show: it.show, program: it.program })
              || it.kind || '';
            var lead = it.wikiLead || it.desc || '';
            if (!it.film && !it.show && !it.program && looksLikeWebtoon(lead) && !looksLikeVideo(lead)) return null;
            return {
              title: it.title,
              creator: shortNames(it.wikiDirector, true) || it.creator || '',
              year: it.year || it.wikiYear || plausibleYear(yearOf(String(it.desc || '').match(/\d{4}년/) ? String(it.desc).match(/\d{4}년/)[0] : '')),
              kind: kind,
              cover: it.wikiPoster || '',
              desc: it.desc,
              koTitle: it.koTitle || it.wikiTitle || '',
              enTitle: it.enTitle || '',
              yearReliable: !!it.yearReliable,
              rank: it.rank || sourceRank(it.source),
              source: it.source
            };
          }).filter(Boolean);
          return { items: items, okCount: okCount };
        });
    });
  }

  function webtoonSources(query) {
    function settle(p) {
      return p.then(
        function (items) { return { ok: true, items: items }; },
        function () { return { ok: false, items: [] }; }
      );
    }
    return Promise.all([
      settle(wdWebtoonItems(query)),
      settle(wikiWebtoonItems(query)),
      settle(aniListItems(query)),
      settle(gbooksItems(query))
    ]).then(function (res) {
      var list = [];
      var okCount = 0;
      res.forEach(function (r) {
        if (r.ok) okCount++;
        list = list.concat(r.items);
      });
      if (!list.length) return { items: [], okCount: okCount };
      return enrichWithWikiKo(list).then(function (rows) {
        var items = rows.map(function (it) {
          var kind = it.kind || kindFromText([it.desc, it.wikiGenre, it.extra].join(' '));
          if (kind !== '웹소설' && /소설/.test(it.wikiGenre || '')) kind = '웹소설';
          return {
            title: it.title,
            creator: it.creator || shortNames(it.wikiAuthor, false) || '',
            year: it.year || it.wikiYear || '',
            kind: kind,
            platform: detectPlatform([it.wikiPlace, it.desc].join(' ')) || it.platform, 
            cover: it.cover || '',
            coverAlt: it.wikiPoster || '',
            link: it.link || (it.koTitle ? 'https://ko.wikipedia.org/wiki/' + encodeURIComponent(it.koTitle.replace(/\s+/g, '_')) : ''),
            desc: it.desc,
            koTitle: it.koTitle || it.wikiTitle || '',
            media: it.media || (kind ? 'webtoon' : ''),
            rank: it.rank || sourceRank(it.source),
            source: it.source
          };
        });
        return { items: items, okCount: okCount, boost: 'webtoon' };
      });
    });
  }

  /* 같은 작품을 여러 곳에서 찾아 왔을 때 제목 기준으로 묶고, 입력한 제목과 가까운 순서로 정렬합니다. */
  function mediaCandidates(list, query, boost) {
    var groups = {};
    var order = [];
    (list || []).forEach(function (it) {
      if (!it || !it.title) return;
      var key = mediaKey(it.title);
      if (!key) return;
      if (!groups[key]) {
        groups[key] = [];
        order.push(key);
      }
      groups[key].push(it);
    });

    var typed = String(query || '').trim().replace(/\s+/g, ' ');
    var q = titleKey(typed);

    var rows = order.map(function (key, index) {
      var members = groups[key];
      if (boost) {
        members = members.slice().sort(function (a, b) {
          return (b.media === boost ? 1 : 0) - (a.media === boost ? 1 : 0);
        });
      }
      var merged = {
        title: '', creator: '', year: '', cover: '', coverAlt: '', kind: '', platform: '',
        link: '', koTitle: '', enTitle: '', desc: '', sources: []
      };
      var ranked = members.slice().sort(function (a, b) { return (a.rank || 9) - (b.rank || 9); });
      var pick = { creator: '', year: '', solidYear: '' };
      ranked.forEach(function (m) {
        if (!pick.creator && m.creator) pick.creator = m.creator;
        if (!pick.year && m.year) pick.year = m.year;
        if (!pick.solidYear && m.yearReliable && m.year) pick.solidYear = m.year;
      });
      members.forEach(function (m) {
        if (!merged.title || (merged.title.indexOf('(') >= 0 && m.title.indexOf('(') < 0)) merged.title = m.title;
        if (m.source && merged.sources.indexOf(m.source) < 0) merged.sources.push(m.source);
      });
      var kindCount = {};
      ranked.forEach(function (m) {
        ['cover', 'coverAlt', 'platform', 'link', 'koTitle', 'enTitle', 'desc'].forEach(function (f) {
          if (!merged[f] && m[f]) merged[f] = m[f];
        });
        if (m.kind) kindCount[m.kind] = (kindCount[m.kind] || 0) + 1;
      });
      var bestKind = '';
      var bestCount = 0;
      Object.keys(kindCount).forEach(function (k) {
        if (kindCount[k] > bestCount) { bestCount = kindCount[k]; bestKind = k; }
      });
      merged.kind = bestKind;
      members.forEach(function (m) {
        ['cover', 'coverAlt', 'kind', 'platform', 'link', 'koTitle', 'enTitle', 'desc'].forEach(function (f) {
          if (!merged[f] && m[f]) merged[f] = m[f];
        });
      });
      merged.creator = pick.creator;
      merged.year = pick.solidYear || pick.year;
      if (!merged.cover) merged.cover = merged.coverAlt;
      merged.thumb = merged.cover;

      var score = key === q ? 3 : (key.indexOf(q) === 0 ? 2 : (key.indexOf(q) >= 0 ? 1 : 0));
      if (boost && members.some(function (m) { return m.media === boost; })) score += 0.5;
      if (score >= 3 && typed) merged.title = typed;
      return { item: merged, score: score, index: index, cover: merged.cover ? 1 : 0 };
    });

    if (rows.some(function (r) { return r.score >= 3; })) {
      rows = rows.filter(function (r) { return r.score >= 2; });
    } else if (rows.some(function (r) { return r.score >= 2; })) {
      rows = rows.filter(function (r) { return r.score > 0; });
    }
    rows = rows.filter(function (r) { return r.item.kind || r.item.creator; });

    rows.sort(function (a, b) {
      return b.score - a.score || b.cover - a.cover || a.index - b.index;
    });
    return rows.slice(0, LOOKUP_MAX).map(function (r) { return r.item; });
  }

  function lookupMedia(collectionId) {
    var c = coll(collectionId || state.current);
    var query = el.fTitle.value.trim();
    if (!query) {
      toast(c.itemWord + ' 제목을 먼저 적어 주세요.');
      el.fTitle.focus();
      return;
    }

    var seq = ++lookupSeq;
    state.lookupQuery = query;
    state.lookup = { busy: true, items: [], message: '', tone: '' };
    renderLookup();

    var job = (c.mediaLookup === 'webtoon' || c.id === 'webtoons') ? webtoonSources(query) : videoSources(query);
    job.then(function (res) {
      if (seq !== lookupSeq) return;
      var items = mediaCandidates(res.items, query, res.boost);
      if (items.length) {
        state.lookup = { busy: false, items: items, message: '', tone: '' };
      } else if (!res.okCount) {
        state.lookup = { busy: false, items: [], tone: 'error', message: c.lookupFail };
      } else {
        state.lookup = { busy: false, items: [], tone: 'empty', message: c.lookupEmpty };
      }
      renderLookup();
    }, function () {
      if (seq !== lookupSeq) return;
      state.lookup = { busy: false, items: [], tone: 'error', message: c.lookupFail };
      renderLookup();
    });
  }

  /* ---------------- 등록 / 수정 ---------------- */

  function titleLabel(c) {
    if (c.id === 'books') return '책 제목';
    if (c.id === 'webtoons') return '작품 제목';
    return '제목';
  }

  function openForm(item) {
    var c = current();
    state.editingId = item ? item.id : null;
    el.formHeading.textContent = c.emoji + ' ' + c.label + (item ? ' 수정' : ' 등록');
    el.fTitleLabel.innerHTML = titleLabel(c) + ' <span class="req">*</span>';
    el.fTitle.placeholder = c.titlePlaceholder || '제목';
    el.fCreatorLabel.textContent = c.creatorLabel;
    el.fCreator.placeholder = c.creatorPlaceholder || '';
    el.fStatusLabel.textContent = '상태';
    el.fStartLabel.textContent = c.dates.start;
    el.fEndLabel.textContent = c.dates.end;
    el.fKindLabel.textContent = c.kindLabel;
    el.fMemoLabel.textContent = c.memoLabel;
    el.fMemo.placeholder = c.memoPlaceholder;
    el.fLookup.hidden = !c.lookup;

    el.fTitle.value = item ? item.title : '';
    el.fCreator.value = item ? (item.creator || '') : '';
    el.fStart.value = item ? (item.startDate || '') : '';
    el.fEnd.value = item ? (item.endDate || '') : '';
    el.fMemo.value = item ? (item.memo || '') : '';
    state.formRating = item ? C.itemRating(item) : 0;
    renderFormRating();
    el.fTitleError.hidden = true;
    setCoverPreview(item ? item.cover : '');
    el.fCover.value = item ? (item.cover || '') : '';

    el.fPlatformField.hidden = !c.platform;
    el.fPlatform.value = (item && c.platform) ? (item.platform || '') : '';
    el.fLinkField.hidden = !c.link;
    el.fLink.value = (item && c.link) ? (item.link || '') : '';

    renderFormKinds(item ? (item.kind || c.defaultKind) : c.defaultKind, false);
    renderFormStatus(item ? item.status : 'done');
    clearTimeout(lookupTimer);
    lastAuto = { creator: '', platform: '', link: '', memo: '' };
    state.lookup = { busy: false, items: [], message: '', tone: '' };
    state.lookupDesc = '';
    state.lookupQuery = '';
    renderSummaryButton();
    renderLookup();
    openModal(el.formModal);
    el.formBody.scrollTop = 0;
    setTimeout(function () { if (!item) el.fTitle.focus(); }, 120);
  }

  function renderFormRating() {
    el.fRating.innerHTML = ratingButtonsHTML(state.formRating);
    el.fRatingLabel.textContent = '별점' + (state.formRating ? ' (노란 별 ' + state.formRating + '개)' : '');
  }

  /* 검색으로 줄거리를 가져왔을 때만 보이는 '줄거리 넣기' 버튼 */
  function renderSummaryButton() {
    if (!el.fSummary) return;
    el.fSummary.hidden = !state.lookupDesc;
  }

  function setCoverPreview(url) {
    if (url) {
      el.fCoverPreview.style.backgroundImage = 'url("' + String(url).replace(/"/g, '%22') + '")';
    } else {
      el.fCoverPreview.style.backgroundImage = '';
    }
  }

  function kindList(c) {
    var kinds = (c.kinds || []).slice();
    if (!c.customKind) return kinds;
    itemsOf().forEach(function (b) {
      var k = b.kind || c.defaultKind;
      if (kinds.indexOf(k) < 0) kinds.push(k);
    });
    return kinds;
  }

  function renderFormKinds(value, forceCustom) {
    var c = current();
    var kinds = kindList(c);
    var isCustom = !!value && kinds.indexOf(value) < 0;
    state.formKind = isCustom ? value : (value || c.defaultKind);
    state.formCustom = !!(isCustom || forceCustom);

    var tints = ['rose', 'apricot', 'lavender', 'sage'];
    var html = kinds.map(function (k, i) {
      var active = (!isCustom && !forceCustom && state.formKind === k);
      return '<button type="button" class="chip tint-' + tints[i % tints.length] + (active ? ' is-active' : '') + '"'
        + ' aria-pressed="' + active + '" data-kind="' + esc(k) + '">' + esc(k) + '</button>';
    }).join('');
    if (c.customKind) {
      var customActive = isCustom || forceCustom;
      html += '<button type="button" class="chip' + (customActive ? ' is-active' : '') + '"'
        + ' aria-pressed="' + customActive + '" data-kind="__custom__">직접 입력</button>';
    }
    el.fKinds.innerHTML = html;

    el.fKindCustom.hidden = !(c.customKind && (isCustom || forceCustom));
    el.fKindCustom.value = isCustom ? value : '';
    if (forceCustom) state.formKind = el.fKindCustom.value.trim();
  }

  function renderFormStatus(value) {
    var c = current();
    state.formStatus = C.normalizeStatus(value);
    el.fStatus.innerHTML = C.STATUS_LIST.map(function (s) {
      var active = state.formStatus === s;
      return '<button type="button" class="chip status-chip ' + s + (active ? ' is-active' : '') + '"'
        + ' data-status="' + esc(s) + '" aria-pressed="' + active + '">'
        + esc(C.statusLabel(c, s)) + '</button>';
    }).join('');
  }

  function upsertLocal(item) {
    var c = current();
    var store = storeOf();
    item = C.stamp(item);
    var i = -1;
    for (var k = 0; k < store.added.length; k++) {
      if (store.added[k].id === item.id) { i = k; break; }
    }
    if (i >= 0) {
      store.added[i] = item;
    } else {
      var isRemote = (state.remote[c.id] || []).some(function (r) { return r.id === item.id; });
      if (isRemote) store.edits[item.id] = item;
      else store.added.push(item);
    }
    store.deleted = store.deleted.filter(function (id) { return id !== item.id; });
    saveStores();
    notifyChange(c.id);
  }

  function saveForm() {
    var c = current();
    var title = el.fTitle.value.trim();
    if (!title) {
      el.fTitleError.hidden = false;
      el.fTitle.focus();
      return;
    }
    el.fTitleError.hidden = true;

    var startDate = el.fStart.value || '';
    var endDate = el.fEnd.value || '';
    if (startDate && endDate && startDate > endDate) {
      toast('시작한 날짜가 끝난 날짜보다 늦어요. 날짜를 확인해 주세요.');
      el.fStart.focus();
      return;
    }

    var kind = '';
    if (c.customKind && !el.fKindCustom.hidden) kind = el.fKindCustom.value.trim();
    if (!kind) kind = (state.formKind && state.formKind !== '__custom__') ? state.formKind : c.defaultKind;
    if (!kind) kind = c.defaultKind;

    var editingId = state.editingId;
    var existing = editingId ? findItem(editingId) : null;

    var item = {
      id: editingId || C.newId(),
      title: title,
      creator: el.fCreator.value.trim(),
      kind: kind,
      startDate: startDate,
      endDate: endDate,
      status: C.normalizeStatus(state.formStatus),
      cover: el.fCover.value.trim(),
      memo: el.fMemo.value.trim(),
      rating: state.formRating
    };
    if (c.platform) item.platform = el.fPlatform.value.trim();
    if (c.link) item.link = safeLink(el.fLink.value.trim());
    if (existing && existing.createdAt) item.createdAt = existing.createdAt;
    else item.createdAt = new Date().toISOString();
    if (existing && existing.sample) item.sample = true;
    /* 정보를 고쳐도 저장해 둔 문구는 그대로 둡니다. */
    if (existing && existing.quotes && existing.quotes.length) {
      item.quotes = existing.quotes.map(function (q) { return Object.assign({}, q); });
    }

    upsertLocal(item);
    closeModal(el.formModal);
    state.editingId = null;
    refresh();
    toast(existing
      ? c.label + ' 기록을 고쳤어요.'
      : '「' + item.title + '」을(를) ' + c.label + ' 칸에 담았어요.');
  }

  /* ---------------- 삭제 / 별점 ---------------- */

  function deleteItem(id) {
    var b = findItem(id);
    if (!b) return;
    var c = current();
    confirmDialog({
      title: c.label + ' 기록을 삭제할까요?',
      message: '「' + b.title + '」을(를) ' + c.label + ' 칸에서 지워요. 되돌릴 수 없어요.',
      okText: '삭제'
    }).then(function (ok) {
      if (!ok) return;
      var store = storeOf();
      var i = -1;
      for (var k = 0; k < store.added.length; k++) {
        if (store.added[k].id === id) { i = k; break; }
      }
      if (i >= 0) store.added.splice(i, 1);
      else {
        if (store.deleted.indexOf(id) < 0) store.deleted.push(id);
        delete store.edits[id];
      }
      saveStores();
      notifyChange(c.id);
      closeModal(el.detailModal);
      state.detailId = null;
      refresh();
      toast(c.label + ' 칸에서 지웠어요.');
    });
  }

  /* 별점을 정합니다(0~3). 카드에서 바로 누르면 0 → 1 → 2 → 3 → 0 순서로 돌아가고,
     상세·등록 화면에서는 원하는 별을 누르면 그 개수가 됩니다. */
  function setRating(id, value) {
    var b = findItem(id);
    if (!b) return null;
    var rating = Math.max(0, Math.min(C.RATING_MAX, Math.round(Number(value) || 0)));
    var before = C.itemRating(b);
    var next = Object.assign({}, b, { rating: rating });
    upsertLocal(next);
    refresh();
    if (state.detailId === id) renderDetail(next);
    if (before !== rating) {
      toast(rating ? '노란 별 ' + rating + '개를 채웠어요.' : '별점을 지웠어요.');
    }
    return next;
  }

  function cycleRating(id) {
    var b = findItem(id);
    if (!b) return;
    var rating = C.itemRating(b);
    setRating(id, rating >= C.RATING_MAX ? 0 : rating + 1);
  }

  /* 이미 켜 둔 별을 한 번 더 누르면 0개로 되돌립니다. */
  function tapStar(id, value) {
    var b = findItem(id);
    if (!b) return;
    var want = Math.max(0, Math.min(C.RATING_MAX, Math.round(Number(value) || 0)));
    if (want > 0 && C.itemRating(b) === want) want = 0;
    setRating(id, want);
  }

  /* ---------------- 샘플 ---------------- */

  function clearSamples() {
    var c = current();
    var ids = itemsOf().filter(function (b) { return b.sample; }).map(function (b) { return b.id; });
    if (!ids.length) return;
    confirmDialog({
      title: '샘플 기록을 지울까요?',
      message: '샘플 ' + ids.length + c.unit + '을 ' + c.label + ' 칸에서 지워요. 내가 등록한 기록은 그대로 남아요.',
      okText: '지우기'
    }).then(function (ok) {
      if (!ok) return;
      ids.forEach(function (id) {
        var i = -1;
        for (var k = 0; k < storeOf().added.length; k++) {
          if (storeOf().added[k].id === id) { i = k; break; }
        }
        if (i >= 0) storeOf().added.splice(i, 1);
        else {
          if (storeOf().deleted.indexOf(id) < 0) storeOf().deleted.push(id);
          delete storeOf().edits[id];
        }
      });
      storeOf().hideSampleNote = true;
      saveStores();
      notifyChange(c.id);
      refresh();
      toast('샘플 기록을 지웠어요. 이제 내 기록을 담아보세요.');
    });
  }

  /* ---------------- 복사 / 불러오기 ---------------- */

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; })
        .catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function copyData() {
    var c = current();
    if (!itemsOf().length) {
      toast('아직 복사할 ' + c.itemWord + '이 없어요.');
      return;
    }
    var json = C.exportPayload(itemsOf(), c);
    copyText(json).then(function (ok) {
      if (ok) toast(itemsOf().length + c.unit + '을 복사했어요. 옮길 기기에서 「데이터 불러오기」를 눌러 붙여넣으세요.');
      else toast('자동 복사가 안 됐어요. 「데이터 불러오기」 창에서 직접 복사해 보세요.');
    });
  }

  function openImport() {
    var c = current();
    el.importHelp.textContent = c.label + ' 기록 데이터(JSON)를 붙여넣거나 파일로 선택하세요.';
    el.importText.value = '';
    el.importFile.value = '';
    el.importFileName.hidden = true;
    el.importFileName.textContent = '';
    el.importError.hidden = true;
    el.importError.textContent = '';
    openModal(el.importModal);
  }

  function showImportError(message) {
    el.importError.textContent = message;
    el.importError.hidden = false;
  }

  function submitImport() {
    var text = el.importText.value;
    if (!text.trim()) {
      showImportError('붙여넣은 내용이 없어요. 복사한 데이터를 붙여넣거나 파일을 골라주세요.');
      return;
    }
    var items;
    try {
      items = C.parseImport(text, current());
    } catch (err) {
      showImportError(err.message);
      return;
    }
    var modeInput = document.querySelector('input[name="import-mode"]:checked');
    var mode = modeInput ? modeInput.value : 'replace';
    applyImport(items, mode);
  }

  function applyImport(items, mode) {
    var c = current();
    var ids = {};
    items.forEach(function (b) { ids[b.id] = true; });
    var store = storeOf();

    if (mode === 'merge') {
      items.forEach(function (b) {
        var i = -1;
        for (var k = 0; k < store.added.length; k++) {
          if (store.added[k].id === b.id) { i = k; break; }
        }
        if (i >= 0) store.added[i] = b;
        else if ((state.remote[c.id] || []).some(function (r) { return r.id === b.id; })) store.edits[b.id] = b;
        else store.added.push(b);
      });
      store.deleted = store.deleted.filter(function (id) { return !ids[id]; });
    } else {
      store.edits = {};
      store.added = items.slice();
      store.deleted = (state.remote[c.id] || []).map(function (b) { return b.id; }).filter(function (id) { return !ids[id]; });
    }

    store.hideSampleNote = true;
    saveStores();
    notifyChange(c.id);
    closeModal(el.importModal);
    refresh();
    setView('list');
    toast(items.length + c.unit + '을 불러왔어요.');
  }

  /* ---------------- 공용 기록(JSON) + 기기 간 동기화 ---------------- */

  function syncLocal(id) {
    var c = coll(id);
    var items = C.mergeLibrary(state.remote[c.id] || [], state.store[c.id], c)
      .filter(function (b) { return keepInCollection(b, c); });
    var store = state.store[c.id];
    return {
      items: items.slice(),
      books: items.slice(),
      deleted: (store.deleted || []).slice(),
      seenRemote: (store.seenRemote || []).slice()
    };
  }

  function applySyncItems(id, items, opts) {
    opts = opts || {};
    var c = coll(id);
    var next = (items || []).map(function (b) { return C.normalizeItem(b, c); }).filter(Boolean);
    if (c.id === 'books') next = next.filter(function (b) { return keepInCollection(b, c); });
    syncApplying = true;
    try {
      state.remote[c.id] = next;
      state.remoteLoaded[c.id] = true;
      var store = state.store[c.id];
      if (opts.deleted) {
        var seen = {};
        store.deleted = opts.deleted.filter(function (x) { if (!x || seen[x]) return false; seen[x] = true; return true; });
      }
      if (opts.compact) {
        store.edits = {};
        store.added = [];
        store.seenRemote = next.map(function (b) { return b.id; });
      }
      saveStores();
      mergeAll();
      renderSummary();
      renderChips();
      renderGrid();
      renderStats();
      renderSampleNote();
      if (state.detailId && state.detailColl === c.id) {
        var b = findIn(c.id, state.detailId);
        if (b) renderDetail(b);
        else { closeModal(el.detailModal); state.detailId = null; }
      }
    } finally {
      syncApplying = false;
    }
  }

  function loadFromFile(id) {
    var c = coll(id);
    return fetch(c.file + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var list = C.normalizeList(C.listFromPayload(data, c), c);
        if (c.id === 'books') list = list.filter(function (b) { return keepInCollection(b, c); });
        state.remote[c.id] = list;
        state.remoteLoaded[c.id] = true;
      })
      .catch(function () {
        var snap = loadSnapshot(c.id);
        state.remote[c.id] = snap || state.remote[c.id] || [];
        state.remoteLoaded[c.id] = true;
      });
  }

  function loadRemote() {
    var sync = window.ShelfSync;
    if (sync && sync.getStatus().connected) {
      sync.start();
      return;
    }
    Promise.all(COLLECTIONS.filter(function (c) { return !c.secret; }).map(function (c) { return loadFromFile(c.id); })).then(function () {
      refresh();
      if (state.detailId && state.detailColl) {
        var b = findIn(state.detailColl, state.detailId);
        if (b) renderDetail(b);
      }
    });
    startFilePolling();
  }

  var fileTimer = null;

  function startFilePolling() {
    if (fileTimer) return;
    fileTimer = setInterval(function () {
      if (document.hidden) return;
      if (window.ShelfSync && window.ShelfSync.getStatus().connected) return;
      Promise.all(COLLECTIONS.filter(function (c) { return !c.secret; }).map(function (c) { return loadFromFile(c.id); })).then(function () {
        mergeAll();
        renderSummary();
        renderChips();
        renderGrid();
        renderStats();
      });
    }, 60000);
  }

  /* ---------------- 동기화 화면 ---------------- */

  var SYNC_LABELS = {
    off: '☁️ 동기화 미연결',
    syncing: '🔄 동기화 중...',
    synced: '☁️ 동기화됨',
    error: '⚠️ 동기화 오류'
  };

  function formatSyncTime(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return '';
    var now = new Date();
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    var yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    var isYesterday = d.getFullYear() === yesterday.getFullYear() && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate();
    if (sameDay) return '오늘 ' + hm;
    if (isYesterday) return '어제 ' + hm;
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + hm;
  }

  function renderSyncBadge(s) {
    if (!el.btnSync) return;
    s = s || window.ShelfSync.getStatus();
    var label = SYNC_LABELS[s.phase] || SYNC_LABELS.off;
    el.syncLabel.textContent = label;
    el.btnSync.setAttribute('data-state', s.phase);
    var when = s.lastSyncAt ? formatSyncTime(s.lastSyncAt) : '';
    el.btnSync.setAttribute('aria-label', label + ' — 눌러서 동기화 설정을 열어요');
    el.btnSync.title = s.connected
      ? (label + (when ? ' · 마지막 ' + when : '') + ' · ' + s.repo)
      : '기기 간 동기화를 연결해 보세요';
  }

  function renderSyncModal(s) {
    if (!el.syncModal) return;
    s = s || window.ShelfSync.getStatus();
    var label = SYNC_LABELS[s.phase] || SYNC_LABELS.off;
    el.syncStateText.textContent = label;
    el.syncDot.setAttribute('data-state', s.phase);

    var lines = [];
    if (s.connected) lines.push('저장소 ' + s.repo + ' · books.json / videos.json / webtoons.json');
    else lines.push('아직 이 기기는 GitHub와 연결되지 않았어요.');
    COLLECTIONS.forEach(function (c) {
      lines.push(c.emoji + ' ' + c.label + ' ' + itemsOf(c.id).length + c.unit);
    });
    if (s.lastSyncAt) lines.push('마지막 동기화 ' + formatSyncTime(s.lastSyncAt));
    el.syncStateDetail.textContent = lines.join('\n');
    if (s.phase === 'error' && s.message) showSyncMsg(s.message, 'error');

    el.syncUnlink.hidden = !s.connected;
    el.syncConnect.textContent = s.connected ? '지금 동기화' : '동기화 연결 테스트 및 지금 동기화';
  }

  function openSyncModal() {
    var s = window.ShelfSync.getStatus();
    el.syncRepo.value = s.repo || window.ShelfSync.DEFAULT_REPO;
    el.syncToken.value = '';
    el.syncToken.placeholder = s.connected ? '저장된 토큰 사용 중 (바꾸려면 새 토큰 입력)' : 'ghp_… 또는 github_pat_…';
    showSyncMsg('', '');
    renderSyncModal(s);
    openModal(el.syncModal);
  }

  function showSyncMsg(text, tone) {
    if (!el.syncMsg) return;
    el.syncMsg.textContent = text || '';
    el.syncMsg.className = 'sync-msg' + (tone ? ' ' + tone : '');
    el.syncMsg.hidden = !text;
  }

  function countsText(counts) {
    if (!counts) return '';
    return COLLECTIONS.map(function (c) {
      var n = counts[c.id];
      return typeof n === 'number' ? c.label + ' ' + n + c.unit : null;
    }).filter(Boolean).join(' · ');
  }

  function connectSync() {
    var sync = window.ShelfSync;
    var s = sync.getStatus();
    var token = el.syncToken.value.trim();
    var repo = el.syncRepo.value.trim();
    if (!token && !s.connected) {
      showSyncMsg('토큰을 먼저 만들어 붙여넣어 주세요. 위 링크에서 바로 만들 수 있어요.', 'error');
      el.syncToken.focus();
      return;
    }
    el.syncConnect.disabled = true;
    showSyncMsg('연결을 확인하고 기록을 맞추는 중이에요…', '');
    sync.connect({ token: token, repo: repo }).then(function (r) {
      el.syncConnect.disabled = false;
      el.syncToken.value = '';
      if (r && r.repo) el.syncRepo.value = r.repo;
      el.syncToken.placeholder = '저장된 토큰 사용 중 (바꾸려면 새 토큰 입력)';
      renderSyncModal(sync.getStatus());
      if (!r || !r.ok) {
        showSyncMsg((r && r.message) || '동기화하지 못했어요.', 'error');
        return;
      }
      var text = countsText(r.counts);
      if (r.pushed) {
        toast('동기화 연결 완료! ' + (text || '기록') + '을 GitHub에 올렸어요.');
        showSyncMsg((text || '기록') + '을 GitHub에 올렸어요. 이제 다른 기기와 자동으로 맞춰져요.', 'ok');
      } else {
        toast('동기화 연결 완료! ' + (text || '기록') + '이 최신이에요.');
        showSyncMsg('이미 최신 상태예요. ' + (text || '기록') + '을 확인했어요.', 'ok');
      }
    });
  }

  function unlinkSync() {
    confirmDialog({
      title: '동기화 연결을 끊을까요?',
      message: '이 기기에서만 GitHub와 연결을 끊어요.\n기록 데이터와 다른 기기의 동기화는 그대로 남아요.',
      okText: '연결 해제'
    }).then(function (ok) {
      if (!ok) return;
      window.ShelfSync.disconnect();
      el.syncToken.value = '';
      el.syncToken.placeholder = 'ghp_… 또는 github_pat_…';
      renderSyncModal();
      showSyncMsg('연결을 끊었어요. 기록은 이 기기에 그대로 있어요.', 'ok');
      toast('동기화 연결을 끊었어요.');
    });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        /* 새 코드가 올라왔는지 바로 확인합니다(브라우저가 스스로 확인하는 주기를 기다리지 않도록). */
        if (reg && typeof reg.update === 'function') reg.update().catch(function () {});
      }).catch(function () {});
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (swReloading) return;
        if (document.querySelector('.modal:not([hidden])')) return; /* 입력 중인 화면은 건드리지 않습니다 */
        swReloading = true;
        location.reload();
      });
    });
  }

  /* ---------------- 이벤트 ---------------- */

  function bindEvents() {
    el.btnAdd.addEventListener('click', function () { openForm(null); });
    el.btnView.addEventListener('click', function () { setView(state.view === 'list' ? 'stats' : 'list'); });
    el.btnSync.addEventListener('click', openSyncModal);
    el.syncClose.addEventListener('click', function () { closeModal(el.syncModal); });
    el.syncConnect.addEventListener('click', connectSync);
    el.syncUnlink.addEventListener('click', unlinkSync);
    el.syncToken.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); connectSync(); }
    });
    el.emptyAdd.addEventListener('click', function () { openForm(null); });
    el.btnCopy.addEventListener('click', copyData);
    el.btnImport.addEventListener('click', openImport);

    el.collectionTabs.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-collection]');
      if (!btn) return;
      setCollection(btn.getAttribute('data-collection'));
    });

    el.search.addEventListener('input', function () {
      state.query = el.search.value;
      el.searchClear.hidden = state.query.length === 0;
      renderGrid();
      renderSampleNote();
    });
    el.searchClear.addEventListener('click', function () {
      state.query = '';
      el.search.value = '';
      el.searchClear.hidden = true;
      renderGrid();
      renderSampleNote();
      el.search.focus();
    });

    el.chips.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-filter]');
      if (!btn) return;
      state.filter = btn.getAttribute('data-filter');
      renderChips();
      renderGrid();
      renderSampleNote();
    });

    el.statusChips.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-status-filter]');
      if (!btn) return;
      state.statusFilter = btn.getAttribute('data-status-filter');
      renderStatusFilterChips();
      renderGrid();
      renderSampleNote();
    });

    el.grid.addEventListener('click', function (e) {
      var target = e.target.closest('[data-act]');
      if (!target) return;
      var id = target.getAttribute('data-id');
      if (target.getAttribute('data-act') === 'stars') {
        e.stopPropagation();
        cycleRating(id);
      } else {
        openDetail(id);
      }
    });

    el.grid.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var target = e.target.closest('[data-act="open"]');
      if (!target) return;
      e.preventDefault();
      openDetail(target.getAttribute('data-id'));
    });

    el.detailClose.addEventListener('click', function () {
      closeModal(el.detailModal);
      state.detailId = null;
    });
    el.detailEdit.addEventListener('click', function () {
      var b = findIn(state.detailColl, state.detailId);
      closeModal(el.detailModal);
      if (b) openForm(b);
    });
    el.detailDelete.addEventListener('click', function () {
      if (state.detailId) deleteItem(state.detailId);
    });
    el.detailBody.addEventListener('click', function (e) {
      if (!state.detailId) return;
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'rate') { tapStar(state.detailId, btn.getAttribute('data-rate')); return; }
      if (act === 'quote-save') { saveQuote(); return; }
      if (act === 'quote-cancel') { cancelQuoteEdit(); return; }
      if (act === 'quote-edit') { startQuoteEdit(btn.getAttribute('data-qid')); return; }
      if (act === 'quote-delete') { deleteQuote(btn.getAttribute('data-qid')); }
    });

    el.detailBody.addEventListener('input', function (e) {
      var t = e.target;
      if (!t || !t.id) return;
      if (t.id === 'quote-text') state.quoteDraft = t.value;
      else if (t.id === 'quote-page') state.quotePage = t.value;
    });

    el.detailBody.addEventListener('keydown', function (e) {
      var t = e.target;
      if (!t || !t.id) return;
      if (t.id === 'quote-text' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveQuote();
      } else if (t.id === 'quote-page' && e.key === 'Enter') {
        e.preventDefault();
        saveQuote();
      }
    });

    el.formClose.addEventListener('click', function () { closeModal(el.formModal); });
    el.formCancel.addEventListener('click', function () { closeModal(el.formModal); });
    el.formSave.addEventListener('click', saveForm);
    el.fRating.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-rate]');
      if (!btn) return;
      var want = Number(btn.getAttribute('data-rate')) || 0;
      state.formRating = (want > 0 && state.formRating === want) ? 0 : want;
      renderFormRating();
    });

    el.fKinds.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-kind]');
      if (!btn) return;
      var value = btn.getAttribute('data-kind');
      if (value === '__custom__') {
        renderFormKinds(el.fKindCustom.value || '', true);
        el.fKindCustom.focus();
      } else {
        renderFormKinds(value, false);
      }
    });
    el.fKindCustom.addEventListener('input', function () {
      state.formKind = el.fKindCustom.value.trim();
    });

    el.fCover.addEventListener('input', function () { setCoverPreview(el.fCover.value.trim()); });
    if (el.fSummary) {
      el.fSummary.addEventListener('click', function () {
        var s = state.lookupDesc;
        if (!s) { toast('먼저 제목으로 표지·줄거리를 찾아 주세요.'); return; }
        var cur = el.fMemo.value.trim();
        if (!cur || cur === lastAuto.memo) {
          el.fMemo.value = s;
          lastAuto.memo = s;
          toast('줄거리를 넣었어요.');
          return;
        }
        if (cur.indexOf(s) >= 0) { toast('줄거리가 이미 들어 있어요.'); return; }
        el.fMemo.value = cur + '\n' + s;
        lastAuto.memo = '';
        toast('줄거리를 감상 뒤에 붙였어요.');
        el.fMemo.focus();
      });
    }
    el.fTitle.addEventListener('input', function () {
      el.fTitleError.hidden = true;
      var c = current();
      if (!c.lookup || c.id === 'books') return;
      clearTimeout(lookupTimer);
      var typed = el.fTitle.value.trim();
      if (typed.length < 2) {
        state.lookup = { busy: false, items: [], message: '', tone: '' };
        renderLookup();
        return;
      }
      lookupTimer = setTimeout(function () {
        if (el.formModal.hidden) return;
        if (el.fTitle.value.trim() !== typed) return;
        lookupMedia(c.id);
      }, 900);
    });
    el.fTitle.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); saveForm(); }
    });

    el.fLookup.addEventListener('click', function () {
      var c = current();
      if (c.lookup && c.id !== 'books') { lookupMedia(c.id); return; }
      lookupBooks();
    });
    el.fLookupList.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-lookup]');
      if (!btn) return;
      applyLookupItem(state.lookup.items[Number(btn.getAttribute('data-lookup'))]);
    });

    el.fStatus.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-status]');
      if (!btn) return;
      renderFormStatus(btn.getAttribute('data-status'));
    });

    el.btnClearSamples.addEventListener('click', clearSamples);
    el.btnKeepSamples.addEventListener('click', function () {
      storeOf().hideSampleNote = true;
      saveStores();
      renderSampleNote();
    });

    el.importClose.addEventListener('click', function () { closeModal(el.importModal); });
    el.importCancel.addEventListener('click', function () { closeModal(el.importModal); });
    el.importSubmit.addEventListener('click', submitImport);
    el.importFileBtn.addEventListener('click', function () { el.importFile.click(); });
    el.importFile.addEventListener('change', function () {
      var file = el.importFile.files && el.importFile.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        showImportError('파일이 너무 커요. 5MB 이하의 JSON 파일을 골라주세요.');
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        el.importText.value = String(reader.result || '');
        el.importFileName.textContent = '📎 ' + file.name;
        el.importFileName.hidden = false;
        el.importError.hidden = true;
      };
      reader.onerror = function () { showImportError('파일을 읽지 못했어요.'); };
      reader.readAsText(file);
    });

    el.confirmCancel.addEventListener('click', function () { settleConfirm(false); });
    el.confirmOk.addEventListener('click', function () { settleConfirm(true); });

    /* 비밀 보관함 — 장식(네잎클로버), 잠그기, 설정 */
    if (el.secretClover) {
      el.secretClover.addEventListener('click', function () {
        if (window.ShelfSecret) window.ShelfSecret.openPin();
      });
    }
    if (el.secretLock) el.secretLock.addEventListener('click', function () { lockSecret(); });
    if (el.secretSettings) {
      el.secretSettings.addEventListener('click', function () {
        if (window.ShelfSecret) window.ShelfSecret.openSettings();
      });
    }


    Array.prototype.forEach.call(document.querySelectorAll('.modal'), function (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal && modal !== el.confirmModal) closeModal(modal);
      });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && openStack.length) closeTop();
    });
  }

  /* ---------------- 시작 ---------------- */

  function init() {
    el = {
      app: $('app'),
      summary: $('summary'),
      btnAdd: $('btn-add'),
      btnView: $('btn-view'),
      btnSync: $('btn-sync'),
      syncLabel: $('sync-label'),
      collectionTabs: $('collection-tabs'),
      searchBox: $('search-box'),
      search: $('search'),
      searchClear: $('search-clear'),
      viewList: $('view-list'),
      viewStats: $('view-stats'),
      statsHead: $('stats-head'),
      chips: $('chips'),
      statusChips: $('status-chips'),
      grid: $('grid'),
      empty: $('empty'),
      emptyEmoji: $('empty-emoji'),
      emptyText: $('empty-text'),
      emptyAdd: $('btn-empty-add'),
      sampleNote: $('sample-note'),
      sampleNoteText: $('sample-note-text'),
      btnClearSamples: $('btn-clear-samples'),
      btnKeepSamples: $('btn-keep-samples'),
      statTotal: $('stat-total'),
      statYear: $('stat-year'),
      statStar: $('stat-star'),
      statStarLabel: $('stat-star-label'),
      statStarCard: $('stat-star-card'),
      statTotalLabel: $('stat-total-label'),
      statYearLabel: $('stat-year-label'),
      statNote: $('stat-note'),
      barsYear: $('bars-year'),
      barsMonth: $('bars-month'),
      barsKind: $('bars-kind'),
      panelYearTitle: $('panel-year-title'),
      panelKindTitle: $('panel-kind-title'),
      dataNote: $('data-note'),
      btnCopy: $('btn-copy'),
      btnImport: $('btn-import'),
      detailModal: $('detail-modal'),
      detailHeading: $('detail-heading'),
      detailBody: $('detail-body'),
      detailClose: $('detail-close'),
      detailEdit: $('detail-edit'),
      detailDelete: $('detail-delete'),
      formModal: $('form-modal'),
      formHeading: $('form-heading'),
      formBody: $('item-form'),
      formClose: $('form-close'),
      formCancel: $('form-cancel'),
      formSave: $('form-save'),
      fTitle: $('f-title'),
      fTitleLabel: $('f-title-label'),
      fTitleError: $('f-title-error'),
      fLookup: $('f-lookup'),
      fLookupPanel: $('f-lookup-panel'),
      fLookupStatus: $('f-lookup-status'),
      fLookupList: $('f-lookup-list'),
      fCreator: $('f-creator'),
      fCreatorLabel: $('f-creator-label'),
      fStatus: $('f-status'),
      fStatusLabel: $('f-status-label'),
      fStart: $('f-start'),
      fStartLabel: $('f-start-label'),
      fEnd: $('f-end'),
      fEndLabel: $('f-end-label'),
      fKinds: $('f-kinds'),
      fKindLabel: $('f-kind-label'),
      fKindCustom: $('f-kind-custom'),
      fPlatform: $('f-platform'),
      fPlatformField: $('f-platform-field'),
      fCover: $('f-cover'),
      fCoverPreview: $('f-cover-preview'),
      fLink: $('f-link'),
      fLinkField: $('f-link-field'),
      fMemo: $('f-memo'),
      fMemoLabel: $('f-memo-label'),
      fSummary: $('f-summary'),
      fRating: $('f-rating'),
      fRatingLabel: $('f-rating-label'),
      importModal: $('import-modal'),
      importHelp: $('import-help'),
      importText: $('import-text'),
      importFile: $('import-file'),
      importFileBtn: $('import-file-btn'),
      importFileName: $('import-file-name'),
      importError: $('import-error'),
      importClose: $('import-close'),
      importCancel: $('import-cancel'),
      importSubmit: $('import-submit'),
      syncModal: $('sync-modal'),
      syncClose: $('sync-close'),
      syncRepo: $('sync-repo'),
      syncToken: $('sync-token'),
      syncDot: $('sync-dot'),
      syncStateText: $('sync-state-text'),
      syncStateDetail: $('sync-state-detail'),
      syncMsg: $('sync-msg'),
      syncConnect: $('sync-connect'),
      syncUnlink: $('sync-unlink'),
      secretBar: $('secret-bar'),
      secretState: $('secret-state'),
      secretLock: $('secret-lock'),
      secretSettings: $('secret-settings'),
      secretClover: $('secret-clover'),
      confirmModal: $('confirm-modal'),
      confirmTitle: $('confirm-title'),
      confirmMessage: $('confirm-message'),
      confirmCancel: $('confirm-cancel'),
      confirmOk: $('confirm-ok'),
      toast: $('toast')
    };

    state.store = loadStores();
    state.remote = {};
    COLLECTIONS.forEach(function (c) {
      state.remote[c.id] = loadSnapshot(c.id) || [];
      state.remoteLoaded[c.id] = false;
    });

    bindEvents();
    el.app.setAttribute('data-collection', state.current);
    el.search.placeholder = current().searchPlaceholder;
    setCollection(state.current);
    refresh();

    if (window.ShelfSync) {
      window.ShelfSync.init({
        getLocal: syncLocal,
        applyItems: applySyncItems,
        onStatus: function (s) {
          renderSyncBadge(s);
          renderSyncModal(s);
        }
      });
    }
    loadRemote();
    registerSW();

    if (window.ShelfSecret) {
      window.ShelfSecret.init({
        onUnlocked: enterSecret,
        onRemoteItems: applySecretItems,
        onStatus: renderSecretStatus,
        toast: toast
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
