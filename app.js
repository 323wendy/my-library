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
    quoteEditingId: null
  };

  var el = {};
  var openStack = [];
  var confirmResolve = null;
  var toastTimer = null;
  var syncApplying = false;

  /* ---------------- 기록 종류 도우미 ---------------- */

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
      var s = raw && raw[c.id] ? raw[c.id] : (c.id === 'books' ? legacy : null);
      out[c.id] = normalizeStore(s);
    });
    return out;
  }

  function saveStores() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state.store));
    } catch (e) {
      toast('이 브라우저에는 저장이 안 돼요. 통계 탭에서 데이터를 복사해 두세요.');
    }
  }

  function notifyChange(id) {
    if (syncApplying) return;
    if (window.ShelfSync) window.ShelfSync.notifyLocalChange(id);
  }

  /* 마지막으로 보던 기록을 하나 더 남겨 둡니다(인터넷이 끊겨도 비어 보이지 않게). */
  function saveSnapshot() {
    COLLECTIONS.forEach(function (c) {
      try {
        localStorage.setItem(SNAP_PREFIX + ':' + c.id, JSON.stringify({
          savedAt: new Date().toISOString(),
          items: state.items[c.id] || []
        }));
      } catch (e) { /* noop */ }
    });
  }

  function loadSnapshot(id) {
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
    var hearts = 0;
    list.forEach(function (b) { if (b.heart) hearts++; });
    el.summary.textContent = c.emoji + ' ' + c.label + ' · 총 ' + list.length + c.unit + ' · ❤️ ' + hearts + c.unit;
  }

  function renderChips() {
    var c = current();
    var counts = {};
    itemsOf().forEach(function (b) {
      var k = b.kind || c.defaultKind;
      counts[k] = (counts[k] || 0) + 1;
    });
    var kinds = Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || a.localeCompare(b, 'ko');
    });

    if (state.filter !== 'all' && state.filter !== '__heart__' && kinds.indexOf(state.filter) < 0) {
      state.filter = 'all';
    }

    var html = '<button type="button" class="chip' + (state.filter === 'all' ? ' is-active' : '') + '" data-filter="all">전체</button>';
    html += '<button type="button" class="chip heart' + (state.filter === '__heart__' ? ' is-active' : '') + '" data-filter="__heart__" aria-label="하트한 기록만 보기" aria-pressed="' + (state.filter === '__heart__') + '"><span class="heart-mini">❤️</span></button>';
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
      if (state.filter === '__heart__') {
        if (!b.heart) return false;
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
    return '<article class="card">'
      + '<div class="cover" data-act="open" data-id="' + esc(b.id) + '" role="button" tabindex="0" aria-label="' + esc(b.title) + ' 상세 보기">'
      + fallbackHTML(b)
      + img
      + coverBadgeHTML(b)
      + '<button type="button" class="heart' + (b.heart ? ' on' : '') + '" data-act="heart" data-id="' + esc(b.id) + '"'
      + ' aria-pressed="' + (b.heart ? 'true' : 'false') + '" aria-label="' + esc(b.title) + ' 하트 ' + (b.heart ? '빼기' : '표시') + '">'
      + '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-heart"></use></svg>'
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
      } else {
        el.emptyEmoji.textContent = '🔎';
        el.emptyText.textContent = state.query.trim()
          ? '“' + state.query.trim() + '”에 맞는 ' + c.itemWord + '이 없어요.'
          : '이 분류에는 아직 ' + c.itemWord + '이 없어요.';
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
    el.statHeart.textContent = s.hearts + c.unit;
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

  function setCollection(id) {
    if (!id || !C.collection(id)) return;
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
    window.scrollTo(0, 0);
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
      + (b.heart ? '<span class="cover-heart" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#i-heart"></use></svg></span>' : '')
      + '</div>'
      + '<h2 class="detail-title">' + esc(b.title) + '</h2>'
      + '<p class="detail-author">' + esc(creator || ' ') + '</p>'
      + '<div class="detail-chips">'
      + '<span class="chip-static kind tint-' + c.tint + '">' + esc(b.kind || c.defaultKind) + '</span>'
      + (b.platform ? '<span class="chip-static">' + esc(b.platform) + '</span>' : '')
      + (statusChipText(b, c) ? '<span class="chip-static status' + statusChipClass(b) + '">' + esc(statusChipText(b, c)) + '</span>' : '')
      + '<button type="button" class="chip-static tappable' + (b.heart ? ' on' : '') + '" data-act="detail-heart">'
      + (b.heart ? '❤️ 하트' : '🤍 하트') + '</button>'
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
      + '&limit=10&fields=title,author_name,cover_i,first_publish_year,subject,key';
    return fetchJSON(url, 8000).then(function (data) {
      var docs = (data && data.docs) || [];
      return docs.map(function (doc) {
        var id = doc.cover_i;
        return {
          title: String(doc.title || '').trim(),
          creator: (doc.author_name || []).slice(0, 3).join(', '),
          year: doc.first_publish_year ? String(doc.first_publish_year) : '',
          cover: id ? 'https://covers.openlibrary.org/b/id/' + id + '-L.jpg' : '',
          thumb: id ? 'https://covers.openlibrary.org/b/id/' + id + '-M.jpg' : '',
          isbn: '',
          lang: 'ko',
          category: mapCategory(doc.subject || []),
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
    el.fLookup.disabled = !!L.busy;
    el.fLookup.textContent = L.busy ? '🔎 찾는 중…' : '🔍 표지·저자 찾기';

    var showPanel = L.busy || L.items.length > 0 || !!L.message;
    el.fLookupPanel.hidden = !showPanel;
    if (!showPanel) {
      el.fLookupStatus.textContent = '';
      el.fLookupList.innerHTML = '';
      return;
    }

    el.fLookupStatus.className = 'lookup-status' + (L.tone ? ' ' + L.tone : '');
    el.fLookupStatus.textContent = L.busy
      ? '표지와 저자를 찾고 있어요…'
      : (L.message || '마음에 드는 책을 누르면 제목·저자·표지가 채워져요.');

    el.fLookupList.innerHTML = L.items.map(function (item, i) {
      var thumb = item.thumb || item.cover || '';
      return '<li>'
        + '<button type="button" class="lookup-item" data-lookup="' + i + '">'
        + '<span class="lookup-thumb">'
        + (thumb ? '<img src="' + esc(thumb) + '" alt="" decoding="async">' : '<span class="lookup-none">📕</span>')
        + '</span>'
        + '<span class="lookup-text">'
        + '<span class="lookup-title">' + esc(item.title) + '</span>'
        + '<span class="lookup-meta">' + esc([item.creator || '저자 미상', item.year].filter(Boolean).join(' · ')) + '</span>'
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
    el.fTitle.value = item.title;
    if (item.creator) el.fCreator.value = item.creator;
    if (item.category) renderFormKinds(item.category, false);
    el.fTitleError.hidden = true;
    state.lookup = { busy: false, items: [], message: '', tone: '' };
    renderLookup();

    if (item.cover) {
      applyCover(item.cover);
      toast('제목·저자·표지를 채웠어요.');
      return;
    }
    if (!item.isbn) {
      toast('제목과 저자를 채웠어요. 표지는 못 찾았어요.');
      return;
    }

    var ol = 'https://covers.openlibrary.org/b/isbn/' + item.isbn + '-L.jpg?default=false';
    probeImage(ol, 3500).then(function (ok) {
      if (state.editingId !== formToken || el.formModal.hidden) return;
      if (ok) {
        applyCover(ol);
        toast('제목·저자·표지를 채웠어요.');
      } else {
        toast('제목과 저자를 채웠어요. 표지는 못 찾았어요.');
      }
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
    el.fHeart.checked = item ? !!item.heart : false;
    el.fTitleError.hidden = true;
    setCoverPreview(item ? item.cover : '');
    el.fCover.value = item ? (item.cover || '') : '';

    el.fPlatformField.hidden = !c.platform;
    el.fPlatform.value = (item && c.platform) ? (item.platform || '') : '';
    el.fLinkField.hidden = !c.link;
    el.fLink.value = (item && c.link) ? (item.link || '') : '';

    renderFormKinds(item ? (item.kind || c.defaultKind) : c.defaultKind, false);
    renderFormStatus(item ? item.status : 'done');
    state.lookup = { busy: false, items: [], message: '', tone: '' };
    renderLookup();
    openModal(el.formModal);
    el.formBody.scrollTop = 0;
    setTimeout(function () { if (!item) el.fTitle.focus(); }, 120);
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
      heart: el.fHeart.checked
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

  /* ---------------- 삭제 / 하트 ---------------- */

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

  function toggleHeart(id) {
    var b = findItem(id);
    if (!b) return;
    var next = Object.assign({}, b, { heart: !b.heart });
    upsertLocal(next);
    refresh();
    if (state.detailId === id) renderDetail(next);
    toast(next.heart ? '❤️ 하트에 담았어요.' : '하트를 뺐어요.');
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
    Promise.all(COLLECTIONS.map(function (c) { return loadFromFile(c.id); })).then(function () {
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
      Promise.all(COLLECTIONS.map(function (c) { return loadFromFile(c.id); })).then(function () {
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
      navigator.serviceWorker.register('sw.js').catch(function () {});
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
      if (target.getAttribute('data-act') === 'heart') {
        e.stopPropagation();
        toggleHeart(id);
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
      if (act === 'detail-heart') { toggleHeart(state.detailId); return; }
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
    el.fTitle.addEventListener('input', function () { el.fTitleError.hidden = true; });
    el.fTitle.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); saveForm(); }
    });

    el.fLookup.addEventListener('click', lookupBooks);
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
      statHeart: $('stat-heart'),
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
      fHeart: $('f-heart'),
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
