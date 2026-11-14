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
    editingId: null,
    detailId: null,
    formCat: '기타'
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
    cats.forEach(function (c) {
      html += '<button type="button" class="chip' + (state.filter === c ? ' is-active' : '') + '" data-filter="' + esc(c) + '">' + esc(c) + '</button>';
    });
    el.chips.innerHTML = html;
  }

  function visibleBooks() {
    var q = state.query.trim().toLowerCase();
    var list = state.books.filter(function (b) {
      if (state.filter === '__heart__') {
        if (!b.heart) return false;
      } else if (state.filter !== 'all' && (b.category || '기타') !== state.filter) {
        return false;
      }
      if (!q) return true;
      var hay = (b.title + ' ' + (b.author || '') + ' ' + (b.memo || '') + ' ' + (b.category || '')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    return C.sortBooks(list);
  }

  function fallbackHTML(book) {
    return '<span class="cover-fallback" style="--hue:' + hashHue(book.title) + '">'
      + '<span class="fb-title">' + esc(book.title) + '</span>'
      + (book.author ? '<span class="fb-author">' + esc(book.author) + '</span>' : '')
      + '</span>';
  }

  function cardHTML(b) {
    var img = b.cover ? '<img src="' + esc(b.cover) + '" alt="" loading="lazy" decoding="async">' : '';
    return '<article class="card">'
      + '<div class="cover" data-act="open" data-id="' + esc(b.id) + '" role="button" tabindex="0" aria-label="' + esc(b.title) + ' 상세 보기">'
      + fallbackHTML(b)
      + img
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
      + (b.finishedAt ? '<span class="chip-static">' + esc(b.finishedAt) + ' 완독</span>' : '')
      + '<button type="button" class="chip-static tappable' + (b.heart ? ' on' : '') + '" data-act="detail-heart">'
      + (b.heart ? '❤️ 하트' : '🤍 하트') + '</button>'
      + '</div>'
      + (b.memo ? '<p class="detail-memo">' + esc(b.memo) + '</p>' : '');

    attachImageFallback(el.detailBody.querySelector('img'));
    el.detailBody.scrollTop = scrollTop;
  }

  /* ---------------- 등록 / 수정 ---------------- */

  function openForm(book) {
    state.editingId = book ? book.id : null;
    el.formHeading.textContent = book ? '책 수정' : '책 등록';
    el.fTitle.value = book ? book.title : '';
    el.fAuthor.value = book ? (book.author || '') : '';
    el.fDate.value = book ? (book.finishedAt || '') : '';
    el.fMemo.value = book ? (book.memo || '') : '';
    el.fHeart.checked = book ? !!book.heart : false;
    el.fTitleError.hidden = true;
    setCoverPreview(book ? book.cover : '');
    el.fCover.value = book ? (book.cover || '') : '';
    renderCatChips(book ? (book.category || '기타') : '기타', false);
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

  function renderCatChips(value, forceCustom) {
    var cats = categoryList();
    var isCustom = !!value && cats.indexOf(value) < 0;
    state.formCat = isCustom ? value : (value || '기타');

    var html = cats.map(function (c) {
      var active = (!isCustom && !forceCustom && state.formCat === c);
      return '<button type="button" class="chip' + (active ? ' is-active' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('');
    html += '<button type="button" class="chip' + ((isCustom || forceCustom) ? ' is-active' : '') + '" data-cat="__custom__">직접 입력</button>';
    el.fCats.innerHTML = html;

    el.fCatCustom.hidden = !(isCustom || forceCustom);
    el.fCatCustom.value = isCustom ? value : '';
    if (forceCustom) state.formCat = el.fCatCustom.value.trim();
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
      finishedAt: el.fDate.value || '',
      cover: el.fCover.value.trim(),
      memo: el.fMemo.value.trim(),
      heart: el.fHeart.checked
    };
    if (existing && existing.createdAt) book.createdAt = existing.createdAt;
    else book.createdAt = new Date().toISOString();
    if (existing && existing.sample) book.sample = true;

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
      var btn = e.target.closest('[data-act="detail-heart"]');
      if (!btn || !state.detailId) return;
      toggleHeart(state.detailId);
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
      fAuthor: $('f-author'),
      fDate: $('f-date'),
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
