/* ============================================================
   나만의 서재 — 데이터 로직 (DOM을 쓰지 않는 순수 함수 모음)
   books.json(공용 데이터)과 localStorage(내 수정·추가 내역)를
   id 기준으로 병합하고, 통계와 가져오기/내보내기를 계산합니다.
   ============================================================ */
(function (root) {
  'use strict';

  var DEFAULT_CATEGORIES = ['소설', '인문', '에세이', '경제/경영', '기타'];

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function newId() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') {
      try { return root.crypto.randomUUID(); } catch (e) { /* fall through */ }
    }
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function str(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.map(str).filter(Boolean).join(', ');
    return String(v).trim();
  }

  function firstOf(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return '';
  }

  // "2026.09.17", "2026년 9월 17일", "2026-09-17T..." → "2026-09-17"
  function toDate(v) {
    var s = str(v);
    if (!s) return '';
    var m = s.match(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
    if (m) {
      var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        return y + '-' + pad(mo) + '-' + pad(d);
      }
    }
    var t = Date.parse(s);
    if (!isNaN(t)) {
      var dt = new Date(t);
      return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
    }
    return '';
  }

  function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    var s = str(v).toLowerCase();
    return s === 'true' || s === 'y' || s === 'yes' || s === '1' || s === 'on';
  }

  /* 어떤 모양의 책 데이터든 우리 형식으로 바꿉니다.
     (예전에 쓰던 앱에서 내보낸 JSON도 최대한 살려서 읽습니다) */
  function normalizeBook(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var title = str(firstOf(raw, ['title', '제목', 'name', 'bookTitle', 'book_name']));
    if (!title) return null;

    var book = {
      id: str(firstOf(raw, ['id', 'key', '_id', 'bookId'])) || newId(),
      title: title,
      author: str(firstOf(raw, ['author', '저자', 'writer', 'authors', 'authorName'])),
      category: str(firstOf(raw, ['category', '카테고리', 'genre', 'type'])) || '기타',
      finishedAt: toDate(firstOf(raw, ['finishedAt', 'date', '완독일', 'readDate', 'finished', 'doneAt', 'endDate', 'readAt'])),
      cover: str(firstOf(raw, ['cover', 'coverUrl', 'coverURL', 'image', 'imageUrl', 'thumbnail', 'thumbnailUrl', '표지'])) || '',
      memo: str(firstOf(raw, ['memo', 'comment', '한줄평', '한 줄 평', 'review', 'note', 'oneLine', 'summary'])),
      heart: toBool(firstOf(raw, ['heart', 'favorite', 'liked', 'isHeart', 'love', 'like']))
    };
    if (raw.createdAt) book.createdAt = str(raw.createdAt);
    if (raw.sample) book.sample = true;
    return book;
  }

  /* books.json(공용) + 내 저장소(수정/추가/삭제) 병합
     - deleted : 내가 지운 책의 id (books.json에 다시 올라와도 지운 채로 둠)
     - edits   : books.json 책을 내가 고친 내용 (id별)
     - added   : 내가 직접 등록한 책 (id별 전체 데이터) */
  function mergeLibrary(remote, store) {
    store = store || {};
    var deleted = {};
    (store.deleted || []).forEach(function (id) { deleted[id] = true; });
    var edits = store.edits || {};
    var map = {};
    var order = [];

    (remote || []).forEach(function (b) {
      if (!b || !b.id || deleted[b.id]) return;
      var base = normalizeBook(b) || b;
      var merged = edits[b.id] ? normalizeBook(Object.assign({}, base, edits[b.id])) || base : base;
      if (!map[b.id]) order.push(b.id);
      map[b.id] = merged;
    });

    (store.added || []).forEach(function (b) {
      if (!b || !b.id || deleted[b.id]) return;
      if (!map[b.id]) order.push(b.id);
      map[b.id] = normalizeBook(b) || b;
    });

    return order.map(function (id) { return map[id]; });
  }

  /* 최근에 읽은 책이 먼저 오도록 정렬 */
  function sortBooks(books) {
    return books.slice().sort(function (a, b) {
      var da = a.finishedAt || '', db = b.finishedAt || '';
      if (da !== db) return da < db ? 1 : -1;
      var ca = a.createdAt || '', cb = b.createdAt || '';
      if (ca !== cb) return ca < cb ? 1 : -1;
      return String(a.title).localeCompare(String(b.title), 'ko');
    });
  }

  function computeStats(books, now) {
    now = now || new Date();
    var currentYear = now.getFullYear();
    var total = 0, thisYear = 0, hearts = 0;
    var years = {}, months = {}, cats = {};

    books.forEach(function (b) {
      if (b.heart) hearts++;
      var cat = b.category || '기타';
      cats[cat] = (cats[cat] || 0) + 1;

      if (!b.finishedAt) return;
      total++;
      var y = b.finishedAt.slice(0, 4);
      var m = b.finishedAt.slice(0, 7);
      if (Number(y) === currentYear) thisYear++;
      years[y] = (years[y] || 0) + 1;
      months[m] = (months[m] || 0) + 1;
    });

    function rows(obj, labeler) {
      return Object.keys(obj)
        .map(function (k) { return { key: k, label: labeler(k), count: obj[k] }; })
        .sort(function (a, b) { return a.key < b.key ? 1 : (a.key > b.key ? -1 : 0); });
    }

    var categoryRows = Object.keys(cats)
      .map(function (k) { return { key: k, label: k, count: cats[k] }; })
      .sort(function (a, b) { return b.count - a.count || a.label.localeCompare(b.label, 'ko'); });

    var bookCount = books.length;
    categoryRows.forEach(function (r) {
      r.pct = bookCount ? Math.round((r.count / bookCount) * 100) : 0;
    });

    return {
      total: total,
      thisYear: thisYear,
      hearts: hearts,
      count: bookCount,
      years: rows(years, function (k) { return k + '년'; }),
      months: rows(months, function (k) { return k; }),
      categories: categoryRows
    };
  }

  /* 붙여넣은 JSON을 책 목록으로 (배열 / {books:[...]} / 책 한 권 모두 허용) */
  function parseImport(text) {
    var data;
    try {
      data = JSON.parse(String(text));
    } catch (e) {
      throw new Error('JSON 형식이 아니에요. 복사한 내용을 다시 확인해 주세요.');
    }

    var list = null;
    if (Array.isArray(data)) {
      list = data;
    } else if (data && typeof data === 'object') {
      var keys = ['books', 'items', 'data', 'list', 'library', '서재'];
      for (var i = 0; i < keys.length; i++) {
        if (Array.isArray(data[keys[i]])) { list = data[keys[i]]; break; }
      }
      if (!list && (data.title || data['제목'])) list = [data];
    }
    if (!list) throw new Error('책 목록을 찾지 못했어요. 서재 데이터를 복사한 내용 전체를 붙여넣어 주세요.');

    var seen = {};
    var books = [];
    list.forEach(function (raw) {
      var b = normalizeBook(raw);
      if (!b) return;
      if (seen[b.id]) b.id = newId();
      seen[b.id] = true;
      books.push(b);
    });
    if (!books.length) throw new Error('불러올 책이 없어요.');
    return books;
  }

  function cleanForExport(b) {
    return {
      id: b.id,
      title: b.title,
      author: b.author || '',
      category: b.category || '기타',
      finishedAt: b.finishedAt || '',
      cover: b.cover || '',
      memo: b.memo || '',
      heart: !!b.heart
    };
  }

  function exportPayload(books) {
    return JSON.stringify({
      app: '나만의 서재',
      version: 1,
      exportedAt: new Date().toISOString(),
      count: books.length,
      books: books.map(cleanForExport)
    }, null, 2);
  }

  var api = {
    DEFAULT_CATEGORIES: DEFAULT_CATEGORIES,
    newId: newId,
    toDate: toDate,
    normalizeBook: normalizeBook,
    mergeLibrary: mergeLibrary,
    sortBooks: sortBooks,
    computeStats: computeStats,
    parseImport: parseImport,
    exportPayload: exportPayload,
    cleanForExport: cleanForExport
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Shelf = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
