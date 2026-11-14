/* ============================================================
   나만의 서재 — 화면 동작
   books.json(공용) + localStorage(내 기록) 병합, 서재/통계 화면,
   책 등록·수정·삭제, 데이터 복사·불러오기, PWA 등록.
   ============================================================ */
(function () {
  'use strict';

  var C = window.Shelf;
  var LS_KEY = 'reading-app:v1';

  var state = {
    remote: [],
    remoteLoaded: false,
    store: loadStore(),
    books: [],
    tab: 'library',
    query: '',
    filter: 'all',
    statusFilter: 'all',
    editingId: null,
    detailId: null,
    formCat: '기타',
    formStatus: '완독',
    lookup: { busy: false, items: [], message: '', tone: '' },
    quoteDraft: '',
    quotePage: '',
    quoteEditingId: null
  };

  var el = {};
  var openStack = [];
  var confirmResolve = null;
  var toastTimer = null;

  /* ---------------- 저장소 ---------------- */

  function emptyStore() {
    return { edits: {}, added: [], deleted: [], hideSampleNote: false };
  }

  function loadStore() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return emptyStore();
      var d = JSON.parse(raw) || {};
      return {
        edits: (d.edits && typeof d.edits === 'object') ? d.edits : {},
        added: Array.isArray(d.added) ? d.added.map(C.normalizeBook).filter(Boolean) : [],
        deleted: Array.isArray(d.deleted) ? d.deleted.filter(Boolean) : [],
        hideSampleNote: !!d.hideSampleNote
      };
    } catch (e) {
      return emptyStore();
    }
  }

  function saveStore() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state.store));
    } catch (e) {
      toast('이 브라우저에는 저장이 안 돼요. 통계 탭에서 데이터를 복사해 두세요.');
    }
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

  function findBook(id) {
    for (var i = 0; i < state.books.length; i++) {
      if (state.books[i].id === id) return state.books[i];
    }
    return null;
  }

  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 2600);
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

  /* ---------------- 렌더 ---------------- */

  function refresh() {
    state.books = C.mergeLibrary(state.remote, state.store);
    renderSummary();
    renderChips();
    renderGrid();
    renderStats();
    renderSampleNote();
  }

  function renderSummary() {
    var hearts = 0;
    state.books.forEach(function (b) { if (b.heart) hearts++; });
    el.summary.textContent = '총 ' + state.books.length + '권의 서재 · ❤️ ' + hearts + '권';
  }

  function renderChips() {
    var counts = {};
    state.books.forEach(function (b) {
      var c = b.category || '기타';
      counts[c] = (counts[c] || 0) + 1;
    });
    var cats = Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || a.localeCompare(b, 'ko');
    });

    if (state.filter !== 'all' && state.filter !== '__heart__' && cats.indexOf(state.filter) < 0) {
      state.filter = 'all';
    }

    var html = '<button type="button" class="chip' + (state.filter === 'all' ? ' is-active' : '') + '" data-filter="all">전체</button>';
    html += '<button type="button" class="chip heart' + (state.filter === '__heart__' ? ' is-active' : '') + '" data-filter="__heart__" aria-label="하트한 책만 보기" aria-pressed="' + (state.filter === '__heart__') + '"><span class="heart-mini">❤️</span></button>';
    var tints = ['rose', 'apricot', 'lavender', 'sage'];
    cats.forEach(function (c, i) {
      html += '<button type="button" class="chip tint-' + tints[i % tints.length] + (state.filter === c ? ' is-active' : '') + '" data-filter="' + esc(c) + '">' + esc(c) + '</button>';
    });
    el.chips.innerHTML = html;
    renderStatusFilterChips();
  }

  /* 읽기 상태(전체 / 완독 / 중단 / 읽는 중) 필터 */
  function statusFilterChipsHost() {
    return el.statusChips;
  }

  function renderStatusFilterChips() {
    var counts = { '완독': 0, '중단': 0, '읽는 중': 0 };
    state.books.forEach(function (b) { counts[C.normalizeStatus(b.status)]++; });

    var keys = ['all'].concat(C.STATUS_LIST);
    if (state.statusFilter !== 'all' && C.STATUS_LIST.indexOf(state.statusFilter) < 0) {
      state.statusFilter = 'all';
    }

    var html = keys.map(function (k) {
      var label = k === 'all' ? '전체' : k;
      var count = k === 'all' ? state.books.length : counts[k];
      return '<button type="button" class="chip sm' + (state.statusFilter === k ? ' is-active' : '') + '"'
        + ' data-status-filter="' + esc(k) + '" aria-pressed="' + (state.statusFilter === k) + '">'
        + esc(label) + ' <span class="chip-num">' + count + '</span></button>';
    }).join('');

    var host = statusFilterChipsHost();
    if (host) host.innerHTML = html;
  }

  function visibleBooks() {
    var q = state.query.trim().toLowerCase();
    var list = state.books.filter(function (b) {
      if (state.filter === '__heart__') {
        if (!b.heart) return false;
      } else if (state.filter !== 'all' && (b.category || '기타') !== state.filter) {
        return false;
      }
      if (state.statusFilter !== 'all' && C.normalizeStatus(b.status) !== state.statusFilter) return false;
      if (!q) return true;
      return haystack(b).indexOf(q) >= 0;
    });
    return C.sortBooks(list);
  }

  /* 제목·저자·한 줄 평·카테고리와 함께 저장한 문구 내용으로도 검색합니다. */
  function haystack(b) {
    var parts = [b.title, b.author || '', b.memo || '', b.category || '', C.normalizeStatus(b.status)];
    if (b.startDate) parts.push(b.startDate);
    if (b.endDate) parts.push(b.endDate);
    (b.quotes || []).forEach(function (quote) {
      parts.push(quote.text || '');
      if (quote.page) parts.push('p.' + quote.page);
    });
    return parts.join(' ').toLowerCase();
  }

  var FALLBACK_TINTS = ['rose', 'sage', 'lavender', 'butter', 'apricot'];

  function fallbackHTML(book) {
    var tint = FALLBACK_TINTS[hashHue(book.title) % FALLBACK_TINTS.length];
    return '<span class="cover-fallback fb-' + tint + '">'
      + '<span class="fb-frame" aria-hidden="true"></span>'
      + '<span class="fb-title">' + esc(book.title) + '</span>'
      + '<span class="fb-rule" aria-hidden="true"></span>'
      + (book.author ? '<span class="fb-author">' + esc(book.author) + '</span>' : '')
      + '</span>';
  }

  function coverBadgeHTML(b) {
    var status = C.normalizeStatus(b.status);
    if (status === C.STATUS.STOPPED) return '<span class="cover-badge stopped">중단</span>';
    if (status === C.STATUS.READING) return '<span class="cover-badge reading">읽는 중</span>';
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
      + '<p class="card-author">' + esc(b.author || '') + '</p>'
      + '</article>';
  }

  function attachImageFallback(img) {
    if (!img) return;
    if (img.complete && img.naturalWidth === 0) img.classList.add('err');
    img.addEventListener('error', function () { img.classList.add('err'); }, { once: true });
  }

  function renderGrid() {
    var list = visibleBooks();
    el.grid.innerHTML = list.map(cardHTML).join('');

    Array.prototype.forEach.call(el.grid.querySelectorAll('img'), attachImageFallback);

    var isEmpty = list.length === 0;
    el.empty.hidden = !isEmpty;
    if (isEmpty) {
      if (!state.books.length) {
        el.emptyText.textContent = '아직 서재가 비어 있어요. 첫 책을 등록해 보세요.';
        el.emptyAdd.textContent = '첫 책 등록하기';
      } else {
        el.emptyText.textContent = state.query.trim()
          ? '“' + state.query.trim() + '”에 맞는 책이 없어요.'
          : '이 카테고리에는 아직 책이 없어요.';
        el.emptyAdd.textContent = '책 등록하기';
      }
    }
  }

  function renderSampleNote() {
    var samples = state.books.filter(function (b) { return b.sample; });
    var busy = state.query.trim().length > 0 || state.filter !== 'all';
    var show = samples.length > 0 && !state.store.hideSampleNote && !busy;
    el.sampleNote.hidden = !show;
    if (show) {
      el.sampleNoteText.innerHTML = '미리 넣어둔 샘플 책이 <b>' + samples.length + '권</b> 있어요. 지우고 내 서재를 채워보세요.';
    }
  }

  function barRows(rows, emptyText, withPercent) {
    if (!rows.length) return '<p class="bars-empty">' + esc(emptyText) + '</p>';
    var max = 0;
    rows.forEach(function (r) { if (r.count > max) max = r.count; });
    return rows.map(function (r) {
      var width = max ? Math.round((r.count / max) * 100) : 0;
      var label = withPercent ? r.label + ' (' + r.pct + '%)' : r.label;
      return '<div class="bar-row' + (withPercent ? ' cat' : '') + '">'
        + '<span class="bar-label">' + esc(label) + '</span>'
        + '<span class="bar-track"><span class="bar-fill" style="width:' + width + '%"></span></span>'
        + '<span class="bar-value">' + r.count + '권</span>'
        + '</div>';
    }).join('');
  }

  function renderStats() {
    var s = C.computeStats(state.books, new Date());
    el.statTotal.textContent = s.total + '권';
    el.statYear.textContent = s.thisYear + '권';
    el.statHeart.textContent = s.hearts + '권';
    el.barsYear.innerHTML = barRows(s.years, '아직 완독한 책이 없어요.', false);
    el.barsMonth.innerHTML = barRows(s.months, '완독 날짜가 있는 책이 없어요.', false);
    el.barsCategory.innerHTML = barRows(s.categories, '등록된 책이 없어요.', true);

    var bits = [];
    if (s.stopped) bits.push('중단 ' + s.stopped + '권');
    if (s.reading) bits.push('읽는 중 ' + s.reading + '권');
    el.statNote.textContent = bits.length ? bits.join(' · ') + ' (완독 통계에는 넣지 않았어요)' : '';
    el.statNote.hidden = bits.length === 0;
  }

  /* 상세 화면 날짜·상태 칩: "2026-09-10 ~ 2026-09-17 완독" / "2026-09-10 ~ 중단(포기)" */
  function statusLabel(status) {
    var s = C.normalizeStatus(status);
    if (s === C.STATUS.STOPPED) return '중단(포기)';
    return s;
  }

  function statusChipText(b) {
    var start = b.startDate || '';
    var end = b.endDate || '';
    var range = '';
    if (start && end) range = start + ' ~ ' + end;
    else if (end) range = end;
    else if (start) range = start + ' ~';

    var status = C.normalizeStatus(b.status);
    if (!range) return status === C.STATUS.DONE ? '' : statusLabel(status);
    return range + ' ' + statusLabel(status);
  }

  function statusChipClass(b) {
    var status = C.normalizeStatus(b.status);
    if (status === C.STATUS.STOPPED) return ' stopped';
    if (status === C.STATUS.READING) return ' reading';
    return '';
  }

  /* ---------------- 탭 / 검색 ---------------- */

  function setTab(tab) {
    state.tab = tab;
    var isLib = tab === 'library';
    el.tabLibrary.classList.toggle('is-active', isLib);
    el.tabStats.classList.toggle('is-active', !isLib);
    el.tabLibrary.setAttribute('aria-selected', String(isLib));
    el.tabStats.setAttribute('aria-selected', String(!isLib));
    el.viewLibrary.hidden = !isLib;
    el.viewStats.hidden = isLib;
    if (!isLib) renderStats();
    window.scrollTo(0, 0);
  }

  /* ---------------- 상세 ---------------- */

  function openDetail(id) {
    var b = findBook(id);
    if (!b) return;
    state.detailId = id;
    state.quoteDraft = '';
    state.quotePage = '';
    state.quoteEditingId = null;
    renderDetail(b);
    openModal(el.detailModal);
    el.detailBody.scrollTop = 0;
  }

  function renderDetail(b) {
    var img = b.cover ? '<img src="' + esc(b.cover) + '" alt="">' : '';
    var scrollTop = el.detailBody.scrollTop;
    el.detailBody.innerHTML =
      '<div class="detail-cover">'
      + fallbackHTML(b)
      + img
      + (b.heart ? '<span class="cover-heart" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#i-heart"></use></svg></span>' : '')
      + '</div>'
      + '<h2 class="detail-title">' + esc(b.title) + '</h2>'
      + '<p class="detail-author">' + esc(b.author || '저자 미상') + '</p>'
      + '<div class="detail-chips">'
      + '<span class="chip-static">' + esc(b.category || '기타') + '</span>'
      + (statusChipText(b) ? '<span class="chip-static status' + statusChipClass(b) + '">' + esc(statusChipText(b)) + '</span>' : '')
      + '<button type="button" class="chip-static tappable' + (b.heart ? ' on' : '') + '" data-act="detail-heart">'
      + (b.heart ? '❤️ 하트' : '🤍 하트') + '</button>'
      + '</div>'
      + (b.memo ? '<p class="detail-memo">' + esc(b.memo) + '</p>' : '')
      + quotesHTML(b);

    attachImageFallback(el.detailBody.querySelector('img'));
    el.detailBody.scrollTop = scrollTop;
  }

  /* ---------------- 마음에 든 문구 ---------------- */

  function dateLabel(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '';
    return m[1] + '.' + m[2] + '.' + m[3];
  }

  function findQuote(book, qid) {
    var list = (book && book.quotes) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === qid) return list[i];
    }
    return null;
  }

  function quotesHTML(b) {
    return '<section class="quotes" id="quotes-section" aria-label="마음에 든 문구">'
      + quotesInner(b) + '</section>';
  }

  function quotesInner(b) {
    var quotes = b.quotes || [];
    var editingId = state.quoteEditingId;
    if (editingId && !findQuote(b, editingId)) {
      editingId = null;
      state.quoteEditingId = null;
    }
    var editing = !!editingId;

    var html = '<div class="quotes-head">'
      + '<h3>💬 마음에 든 문구</h3>'
      + (quotes.length ? '<span class="quotes-count">' + quotes.length + '개</span>' : '')
      + '</div>';

    html += '<div class="quote-form' + (editing ? ' is-editing' : '') + '">'
      + (editing ? '<p class="quote-form-note">고칠 내용을 적고 <b>수정 완료</b>를 눌러주세요.</p>' : '')
      + '<textarea class="input quote-input" id="quote-text" rows="2" maxlength="1000"'
      + ' placeholder="마음에 남은 문장을 적어보세요." aria-label="문구 내용">' + esc(state.quoteDraft) + '</textarea>'
      + '<div class="quote-form-row">'
      + '<input class="input quote-page" id="quote-page" type="text" inputmode="numeric" maxlength="12"'
      + ' placeholder="페이지 (선택)" aria-label="페이지 번호 (선택)" autocomplete="off" value="' + esc(state.quotePage) + '">'
      + '<button type="button" class="quote-save" data-act="quote-save">' + (editing ? '수정 완료' : '+ 저장') + '</button>'
      + (editing ? '<button type="button" class="quote-cancel" data-act="quote-cancel">취소</button>' : '')
      + '</div>'
      + '</div>';

    if (!quotes.length) {
      html += '<p class="quotes-empty">아직 저장한 문구가 없어요. 인상 깊었던 한 문장을 남겨보세요.</p>';
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
    var b = state.detailId ? findBook(state.detailId) : null;
    if (!host || !b) return;
    host.innerHTML = quotesInner(b);
  }

  function readQuoteInput() {
    var t = el.detailBody.querySelector('#quote-text');
    var p = el.detailBody.querySelector('#quote-page');
    return { text: t ? String(t.value).trim() : '', page: p ? p.value : '' };
  }

  function commitQuotes(book, quotes, message, keepDraft) {
    upsertLocal(Object.assign({}, book, { quotes: quotes }));
    if (!keepDraft) {
      state.quoteDraft = '';
      state.quotePage = '';
      state.quoteEditingId = null;
    }
    refresh();
    if (state.detailId === book.id) renderQuotesSection();
    if (message) toast(message);
  }

  function saveQuote() {
    var b = state.detailId ? findBook(state.detailId) : null;
    if (!b) return;

    var input = readQuoteInput();
    if (!input.text) {
      toast('문구를 먼저 적어 주세요.');
      var t = el.detailBody.querySelector('#quote-text');
      if (t) t.focus();
      return;
    }

    var page = C.pageLabel(input.page);
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
    var b = state.detailId ? findBook(state.detailId) : null;
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
    var b = state.detailId ? findBook(state.detailId) : null;
    var target = b ? findQuote(b, qid) : null;
    if (!b || !target) return;

    confirmDialog({
      title: '문구를 삭제할까요?',
      message: '「' + quotePreview(target.text) + '」\n지운 문구는 되돌릴 수 없어요.',
      okText: '삭제'
    }).then(function (ok) {
      if (!ok) return;
      var book = state.detailId ? findBook(state.detailId) : null;
      if (!book) return;
      var wasEditing = state.quoteEditingId === qid;
      var left = (book.quotes || []).filter(function (q) { return q.id !== qid; });
      if (wasEditing) {
        state.quoteEditingId = null;
        state.quoteDraft = '';
        state.quotePage = '';
      }
      commitQuotes(book, left, '문구를 지웠어요.', !wasEditing);
    });
  }

  /* ---------------- 책 정보 자동 검색 (제목 → 저자·표지·분야) ---------------- */

  var GOOGLE_FEED_API = 'https://books.google.com/books/feeds/volumes';
  var GOOGLE_BOOKS_API = 'https://www.googleapis.com/books/v1/volumes';
  var OPEN_LIBRARY_API = 'https://openlibrary.org/search.json';
  var LOOKUP_MAX = 5;
  var lookupSeq = 0;
  var googleCooldownUntil = 0;

  /* 분야 이름을 앱의 카테고리로 추정합니다. 확실치 않으면 비워 둡니다. */
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

  /* 표지 주소 보정: http → https, Google 표지는 보기 좋은 크기(zoom=3)로 */
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

  /* Google Books 옛 GData 피드 — 키 없이 CORS로 열리는 경로입니다.
     제목·저자·날짜·분야·ISBN·표지가 모두 들어 있어 한국 책 검색이 잘 됩니다. */
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
        /* 본문이 없는 판본(view_no_pages, id가 CAAJ로 끝남)은 'image not available' 그림이 오므로 표지를 비웁니다. */
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
          author: creators.slice(0, 3).join(', '),
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
          author: (v.authors || []).join(', '),
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
      /* 하루 할당량 초과(429)면 10분 동안 Google은 건너뛰고 Open Library로 바로 갑니다. */
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
          author: (doc.author_name || []).slice(0, 3).join(', '),
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

  /* 제목 비교용 키: 띄어쓰기·문장부호를 지워 같은 책의 여러 판본을 묶습니다. */
  function titleKey(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/[\s\-.,:;!?'"`~@#$%^&*()\[\]{}<>\/\\|_+=·…‘’“”「」『』〈〉《》]/g, '');
  }

  /* 저자가 다르면 같은 제목이라도 다른 책으로 봅니다. */
  function authorsMatch(a, b) {
    var na = titleKey(a), nb = titleKey(b);
    if (!na || !nb) return true;
    return na === nb || na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0;
  }

  /* 같은 제목의 여러 판본은 한 줄로 묶고, 비어 있는 저자·표지를 서로 채워 줍니다. */
  function mergeLookupGroup(members, wantKo) {
    var primary = members[0];
    if (wantKo) {
      for (var i = 0; i < members.length; i++) {
        if (/[가-힣]/.test(members[i].title)) { primary = members[i]; break; }
      }
    }

    var merged = {
      title: primary.title,
      author: '',
      year: '',
      cover: '',
      thumb: '',
      isbn: '',
      lang: primary.lang || '',
      category: '',
      source: primary.source
    };

    /* 저자는 한국어 표기를 먼저 고릅니다. */
    members.forEach(function (m) {
      if (!merged.author && m.author && (!wantKo || /[가-힣]/.test(m.author))) merged.author = m.author;
    });
    members.forEach(function (m) {
      if (!merged.author && m.author) merged.author = m.author;
      if (!merged.year && m.year) merged.year = m.year;
      if (!merged.isbn && m.isbn) merged.isbn = m.isbn;
      if (!merged.category && m.category) merged.category = m.category;
    });

    /* 표지는 저자가 같은 판본에서 먼저 가져오고, 없으면 같은 제목의 Open Library 판본 표지를 씁니다. */
    for (var j = 0; j < members.length; j++) {
      var m2 = members[j];
      if (m2.cover && authorsMatch(merged.author, m2.author)) {
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
      /* 띄어쓰기만 다른 같은 제목이면 사용자가 적은 표기를 그대로 씁니다. */
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
        + '<span class="lookup-meta">' + esc([item.author || '저자 미상', item.year].filter(Boolean).join(' · ')) + '</span>'
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
        /* 두 곳 모두 실패했을 때만 Google Books API를 한 번 더 시도합니다. */
        settled(searchGoogleBooks(query)).then(function (r) {
          if (r.ok) finish([r.value], 0, 1);
          else finish([], 1, 1);
        });
      });
  }

  /* 표지 주소가 실제로 뜨는지 확인 (Open Library ISBN 표지가 404면 기본 표지를 쓰도록) */
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
    if (item.author) el.fAuthor.value = item.author;
    if (item.category) renderCatChips(item.category, false);
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

  function openForm(book) {
    state.editingId = book ? book.id : null;
    el.formHeading.textContent = book ? '책 수정' : '책 등록';
    el.fTitle.value = book ? book.title : '';
    el.fAuthor.value = book ? (book.author || '') : '';
    el.fStart.value = book ? (book.startDate || '') : '';
    el.fEnd.value = book ? (book.endDate || '') : '';
    el.fMemo.value = book ? (book.memo || '') : '';
    el.fHeart.checked = book ? !!book.heart : false;
    el.fTitleError.hidden = true;
    setCoverPreview(book ? book.cover : '');
    el.fCover.value = book ? (book.cover || '') : '';
    renderCatChips(book ? (book.category || '기타') : '기타', false);
    renderStatusChips(book ? book.status : '완독');
    state.lookup = { busy: false, items: [], message: '', tone: '' };
    renderLookup();
    openModal(el.formModal);
    el.formBody.scrollTop = 0;
    setTimeout(function () { if (!book) el.fTitle.focus(); }, 120);
  }

  function setCoverPreview(url) {
    if (url) {
      el.fCoverPreview.style.backgroundImage = 'url("' + String(url).replace(/"/g, '%22') + '")';
    } else {
      el.fCoverPreview.style.backgroundImage = '';
    }
  }

  function categoryList() {
    var cats = C.DEFAULT_CATEGORIES.slice();
    state.books.forEach(function (b) {
      var c = b.category || '기타';
      if (cats.indexOf(c) < 0) cats.push(c);
    });
    return cats;
  }

  function renderCatChips(value, forceCustom) {    var cats = categoryList();
    var isCustom = !!value && cats.indexOf(value) < 0;
    state.formCat = isCustom ? value : (value || '기타');

    var tints = ['rose', 'apricot', 'lavender', 'sage'];
    var html = cats.map(function (c, i) {
      var active = (!isCustom && !forceCustom && state.formCat === c);
      return '<button type="button" class="chip tint-' + tints[i % tints.length] + (active ? ' is-active' : '') + '"'
        + ' aria-pressed="' + active + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('');
    var customActive = isCustom || forceCustom;
    html += '<button type="button" class="chip' + (customActive ? ' is-active' : '') + '"'
      + ' aria-pressed="' + customActive + '" data-cat="__custom__">직접 입력</button>';
    el.fCats.innerHTML = html;

    el.fCatCustom.hidden = !(isCustom || forceCustom);
    el.fCatCustom.value = isCustom ? value : '';
    if (forceCustom) state.formCat = el.fCatCustom.value.trim();
  }

  /* 읽기 상태 선택 칩 */
  function renderStatusChips(value) {
    state.formStatus = C.normalizeStatus(value);
    el.fStatus.innerHTML = C.STATUS_LIST.map(function (s) {
      var active = state.formStatus === s;
      return '<button type="button" class="chip' + (active ? ' is-active' : '') + '"'
        + ' data-status="' + esc(s) + '" aria-pressed="' + active + '">'
        + esc(statusLabel(s)) + '</button>';
    }).join('');
  }

  function upsertLocal(book) {
    var store = state.store;
    var i = -1;
    for (var k = 0; k < store.added.length; k++) {
      if (store.added[k].id === book.id) { i = k; break; }
    }
    if (i >= 0) {
      store.added[i] = book;
    } else {
      var isRemote = state.remote.some(function (r) { return r.id === book.id; });
      if (isRemote) store.edits[book.id] = book;
      else store.added.push(book);
    }
    store.deleted = store.deleted.filter(function (id) { return id !== book.id; });
    saveStore();
  }

  function saveForm() {
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

    var category = '';
    if (!el.fCatCustom.hidden) category = el.fCatCustom.value.trim();
    if (!category) category = (state.formCat && state.formCat !== '__custom__') ? state.formCat : '기타';

    var editingId = state.editingId;
    var existing = editingId ? findBook(editingId) : null;

    var book = {
      id: editingId || C.newId(),
      title: title,
      author: el.fAuthor.value.trim(),
      category: category,
      startDate: startDate,
      endDate: endDate,
      status: C.normalizeStatus(state.formStatus),
      cover: el.fCover.value.trim(),
      memo: el.fMemo.value.trim(),
      heart: el.fHeart.checked
    };
    if (existing && existing.createdAt) book.createdAt = existing.createdAt;
    else book.createdAt = new Date().toISOString();
    if (existing && existing.sample) book.sample = true;
    /* 책 정보를 고쳐도 저장해 둔 문구는 그대로 둡니다. */
    if (existing && existing.quotes && existing.quotes.length) {
      book.quotes = existing.quotes.map(function (q) { return Object.assign({}, q); });
    }

    upsertLocal(book);
    closeModal(el.formModal);
    state.editingId = null;
    refresh();
    toast(existing ? '책 정보를 고쳤어요.' : '「' + book.title + '」을(를) 서재에 담았어요.');
  }

  /* ---------------- 삭제 / 하트 ---------------- */

  function deleteBook(id) {
    var b = findBook(id);
    if (!b) return;
    confirmDialog({
      title: '책을 삭제할까요?',
      message: '「' + b.title + '」을(를) 서재에서 지워요. 되돌릴 수 없어요.',
      okText: '삭제'
    }).then(function (ok) {
      if (!ok) return;
      var store = state.store;
      var i = -1;
      for (var k = 0; k < store.added.length; k++) {
        if (store.added[k].id === id) { i = k; break; }
      }
      if (i >= 0) store.added.splice(i, 1);
      else {
        if (store.deleted.indexOf(id) < 0) store.deleted.push(id);
        delete store.edits[id];
      }
      saveStore();
      closeModal(el.detailModal);
      state.detailId = null;
      refresh();
      toast('서재에서 지웠어요.');
    });
  }

  function toggleHeart(id) {
    var b = findBook(id);
    if (!b) return;
    var next = Object.assign({}, b, { heart: !b.heart });
    upsertLocal(next);
    refresh();
    if (state.detailId === id) renderDetail(next);
    toast(next.heart ? '❤️ 하트에 담았어요.' : '하트를 뺐어요.');
  }

  /* ---------------- 샘플 ---------------- */

  function clearSamples() {
    var ids = state.books.filter(function (b) { return b.sample; }).map(function (b) { return b.id; });
    if (!ids.length) return;
    confirmDialog({
      title: '샘플 책을 지울까요?',
      message: '샘플 ' + ids.length + '권을 서재에서 지워요. 내가 등록한 책은 그대로 남아요.',
      okText: '지우기'
    }).then(function (ok) {
      if (!ok) return;
      ids.forEach(function (id) {
        var i = -1;
        for (var k = 0; k < state.store.added.length; k++) {
          if (state.store.added[k].id === id) { i = k; break; }
        }
        if (i >= 0) state.store.added.splice(i, 1);
        else {
          if (state.store.deleted.indexOf(id) < 0) state.store.deleted.push(id);
          delete state.store.edits[id];
        }
      });
      state.store.hideSampleNote = true;
      saveStore();
      refresh();
      toast('샘플 책을 지웠어요. 이제 내 책을 담아보세요.');
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
    if (!state.books.length) {
      toast('아직 복사할 책이 없어요.');
      return;
    }
    var json = C.exportPayload(state.books);
    copyText(json).then(function (ok) {
      if (ok) toast(state.books.length + '권을 복사했어요. 옮길 기기에서 「데이터 불러오기」를 눌러 붙여넣으세요.');
      else toast('자동 복사가 안 됐어요. 「데이터 불러오기」 창에서 직접 복사해 보세요.');
    });
  }

  function openImport() {
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
      showImportError('붙여넣은 내용이 없어요. 복사한 서재 데이터를 붙여넣거나 파일을 골라주세요.');
      return;
    }
    var books;
    try {
      books = C.parseImport(text);
    } catch (err) {
      showImportError(err.message);
      return;
    }
    var modeInput = document.querySelector('input[name="import-mode"]:checked');
    var mode = modeInput ? modeInput.value : 'replace';
    applyImport(books, mode);
  }

  function applyImport(books, mode) {
    var ids = {};
    books.forEach(function (b) { ids[b.id] = true; });
    var store = state.store;

    if (mode === 'merge') {
      books.forEach(function (b) {
        var i = -1;
        for (var k = 0; k < store.added.length; k++) {
          if (store.added[k].id === b.id) { i = k; break; }
        }
        if (i >= 0) store.added[i] = b;
        else if (state.remote.some(function (r) { return r.id === b.id; })) store.edits[b.id] = b;
        else store.added.push(b);
      });
      store.deleted = store.deleted.filter(function (id) { return !ids[id]; });
    } else {
      store.edits = {};
      store.added = books.slice();
      store.deleted = state.remote.map(function (b) { return b.id; }).filter(function (id) { return !ids[id]; });
    }

    store.hideSampleNote = true;
    saveStore();
    closeModal(el.importModal);
    refresh();
    setTab('library');
    state.query = '';
    el.search.value = '';
    el.searchClear.hidden = true;
    renderGrid();
    toast(books.length + '권을 불러왔어요.');
  }

  /* ---------------- 공용 서재(books.json) ---------------- */

  function loadRemote() {
    fetch('books.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var list = Array.isArray(data) ? data : (data && Array.isArray(data.books) ? data.books : []);
        state.remote = list.map(C.normalizeBook).filter(Boolean);
        state.remoteLoaded = true;
        refresh();
      })
      .catch(function () {
        state.remoteLoaded = true;
        refresh();
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
    el.emptyAdd.addEventListener('click', function () { openForm(null); });
    el.btnCopy.addEventListener('click', copyData);
    el.btnImport.addEventListener('click', openImport);

    el.tabLibrary.addEventListener('click', function () { setTab('library'); });
    el.tabStats.addEventListener('click', function () { setTab('stats'); });

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
      var b = findBook(state.detailId);
      closeModal(el.detailModal);
      if (b) openForm(b);
    });
    el.detailDelete.addEventListener('click', function () {
      if (state.detailId) deleteBook(state.detailId);
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

    el.fCats.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-cat]');
      if (!btn) return;
      var value = btn.getAttribute('data-cat');
      if (value === '__custom__') {
        renderCatChips(el.fCatCustom.value || '', true);
        el.fCatCustom.focus();
      } else {
        renderCatChips(value, false);
      }
    });
    el.fCatCustom.addEventListener('input', function () {
      state.formCat = el.fCatCustom.value.trim();
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
      renderStatusChips(btn.getAttribute('data-status'));
    });

    el.btnClearSamples.addEventListener('click', clearSamples);
    el.btnKeepSamples.addEventListener('click', function () {
      state.store.hideSampleNote = true;
      saveStore();
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
      summary: $('summary'),
      btnAdd: $('btn-add'),
      search: $('search'),
      searchClear: $('search-clear'),
      tabLibrary: $('tab-library'),
      tabStats: $('tab-stats'),
      viewLibrary: $('view-library'),
      viewStats: $('view-stats'),
      chips: $('chips'),
      statusChips: $('status-chips'),
      grid: $('grid'),
      empty: $('empty'),
      emptyText: $('empty-text'),
      emptyAdd: $('btn-empty-add'),
      sampleNote: $('sample-note'),
      sampleNoteText: $('sample-note-text'),
      btnClearSamples: $('btn-clear-samples'),
      btnKeepSamples: $('btn-keep-samples'),
      statTotal: $('stat-total'),
      statYear: $('stat-year'),
      statHeart: $('stat-heart'),
      statNote: $('stat-note'),
      barsYear: $('bars-year'),
      barsMonth: $('bars-month'),
      barsCategory: $('bars-category'),
      btnCopy: $('btn-copy'),
      btnImport: $('btn-import'),
      detailModal: $('detail-modal'),
      detailBody: $('detail-body'),
      detailClose: $('detail-close'),
      detailEdit: $('detail-edit'),
      detailDelete: $('detail-delete'),
      formModal: $('form-modal'),
      formHeading: $('form-heading'),
      formBody: $('book-form'),
      formClose: $('form-close'),
      formCancel: $('form-cancel'),
      formSave: $('form-save'),
      fTitle: $('f-title'),
      fTitleError: $('f-title-error'),
      fLookup: $('f-lookup'),
      fLookupPanel: $('f-lookup-panel'),
      fLookupStatus: $('f-lookup-status'),
      fLookupList: $('f-lookup-list'),
      fAuthor: $('f-author'),
      fStatus: $('f-status'),
      fStart: $('f-start'),
      fEnd: $('f-end'),
      fCats: $('f-cats'),
      fCatCustom: $('f-cat-custom'),
      fCover: $('f-cover'),
      fCoverPreview: $('f-cover-preview'),
      fMemo: $('f-memo'),
      fHeart: $('f-heart'),
      importModal: $('import-modal'),
      importText: $('import-text'),
      importFile: $('import-file'),
      importFileBtn: $('import-file-btn'),
      importFileName: $('import-file-name'),
      importError: $('import-error'),
      importClose: $('import-close'),
      importCancel: $('import-cancel'),
      importSubmit: $('import-submit'),
      confirmModal: $('confirm-modal'),
      confirmTitle: $('confirm-title'),
      confirmMessage: $('confirm-message'),
      confirmCancel: $('confirm-cancel'),
      confirmOk: $('confirm-ok'),
      toast: $('toast')
    };

    bindEvents();
    setTab('library');
    refresh();
    loadRemote();
    registerSW();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
