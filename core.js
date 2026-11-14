/* ============================================================
   나만의 서재 — 데이터 로직 (DOM을 쓰지 않는 순수 함수 모음)
   books.json(공용 데이터)과 localStorage(내 수정·추가 내역)를
   id 기준으로 병합하고, 통계와 가져오기/내보내기를 계산합니다.
   ============================================================ */
(function (root) {
  'use strict';

  var DEFAULT_CATEGORIES = ['소설', '인문', '에세이', '경제/경영', '기타'];

  /* 읽기 상태: 완독 / 중단 / 읽는 중 (기본값은 완독) */
  var STATUS = { DONE: '완독', STOPPED: '중단', READING: '읽는 중' };
  var STATUS_LIST = [STATUS.DONE, STATUS.STOPPED, STATUS.READING];

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

  /* "중단", "포기", "DNF", "읽는 중", "reading" … 을 세 가지 상태로 맞춥니다. */
  function normalizeStatus(v) {
    var s = str(v).toLowerCase();
    if (!s) return STATUS.DONE;
    if (/중단|포기|그만|손절|dnf|abandon|drop|gave up|not finish/.test(s)) return STATUS.STOPPED;
    if (/읽는|읽고|reading|ongoing|in progress|진행|미완/.test(s)) return STATUS.READING;
    if (/완독|완료|done|finish|complete|read|finished/.test(s)) return STATUS.DONE;
    return STATUS.DONE;
  }

  function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    var s = str(v).toLowerCase();
    return s === 'true' || s === 'y' || s === 'yes' || s === '1' || s === 'on';
  }

  /* 페이지 번호는 "42", "p.42", "42-43", "42쪽"처럼 적어도 됩니다.
     앞의 p./페이지 같은 말은 떼고 숫자·범위만 남깁니다. */
  function pageLabel(v) {
    var s = str(v).replace(/^\s*(?:p\.?|page|페이지)\s*/i, '').replace(/\s*(?:쪽|페이지|p\.?)$/i, '').trim();
    s = s.replace(/[^0-9\-~,\s]/g, '').replace(/\s+/g, '').replace(/,+/g, ',');
    s = s.replace(/^[-,]+|[-,]+$/g, '');
    return s.slice(0, 12);
  }

  /* 마음에 든 문구 한 개: { id, text, page?, createdAt } */
  function normalizeQuote(raw) {
    if (raw === null || raw === undefined) return null;
    var text = '', id = '', page = '', createdAt = '';

    if (typeof raw === 'string' || typeof raw === 'number') {
      text = str(raw);
    } else if (typeof raw === 'object') {
      text = str(firstOf(raw, ['text', 'quote', 'content', 'sentence', 'phrase', 'body', '문구', '구절', '내용']));
      page = firstOf(raw, ['page', 'pageNo', 'pageNumber', 'p', '페이지']);
      id = str(firstOf(raw, ['id', 'key', '_id', 'quoteId']));
      createdAt = str(firstOf(raw, ['createdAt', 'addedAt', 'created', 'date']));
    }

    if (!text) return null;
    var q = { id: id || newId(), text: text };
    var p = pageLabel(page);
    if (p) q.page = p;
    q.createdAt = createdAt || new Date().toISOString();
    return q;
  }

  /* 문구 목록: 배열 / 문구 한 개 / 문자열 하나 모두 허용. id가 겹치면 새로 붙입니다. */
  function normalizeQuotes(raw) {
    if (raw === null || raw === undefined || raw === '') return [];
    var list = Array.isArray(raw) ? raw : [raw];
    var seen = {};
    var out = [];
    list.forEach(function (item) {
      var q = normalizeQuote(item);
      if (!q) return;
      if (seen[q.id]) q.id = newId();
      seen[q.id] = true;
      out.push(q);
    });
    return out;
  }

  /* 어떤 모양의 책 데이터든 우리 형식으로 바꿉니다.
     (예전에 쓰던 앱에서 내보낸 JSON도 최대한 살려서 읽습니다) */
  function normalizeBook(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var title = str(firstOf(raw, ['title', '제목', 'name', 'bookTitle', 'book_name']));
    if (!title) return null;

    /* 예전 데이터의 단일 날짜(finishedAt · date · 완독일 …)는 끝난 날짜(endDate)로 읽습니다. */
    var endDate = toDate(firstOf(raw, ['endDate', 'finishedAt', 'date', '완독일', 'readDate', 'finished', 'doneAt', 'readAt', 'end', '끝난날짜', '끝난 날짜']));
    var startDate = toDate(firstOf(raw, ['startDate', 'startedAt', 'start', 'readStart', 'beganAt', '시작일', '시작날짜', '시작 날짜']));

    var book = {
      id: str(firstOf(raw, ['id', 'key', '_id', 'bookId'])) || newId(),
      title: title,
      author: str(firstOf(raw, ['author', '저자', 'writer', 'authors', 'authorName'])),
      category: str(firstOf(raw, ['category', '카테고리', 'genre', 'type'])) || '기타',
      startDate: startDate,
      endDate: endDate,
      status: normalizeStatus(firstOf(raw, ['status', '상태', 'state', 'readStatus', '읽기상태'])),
      cover: str(firstOf(raw, ['cover', 'coverUrl', 'coverURL', 'image', 'imageUrl', 'thumbnail', 'thumbnailUrl', '표지'])) || '',
      memo: str(firstOf(raw, ['memo', 'comment', '한줄평', '한 줄 평', 'review', 'note', 'oneLine', 'summary'])),
      heart: toBool(firstOf(raw, ['heart', 'favorite', 'liked', 'isHeart', 'love', 'like'])),
      quotes: normalizeQuotes(firstOf(raw, ['quotes', 'quoteList', 'highlights', 'passages', '문구', '구절']))
    };
    /* 예전 코드가 읽을 수 있도록 끝난 날짜를 finishedAt으로도 함께 남겨 둡니다. */
    book.finishedAt = endDate;
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
      /* 저장된 수정 내역도 먼저 표준 형식으로 바꿔야 예전 finishedAt만 있는 기록도 날짜가 살아납니다. */
      var edit = edits[b.id] ? (normalizeBook(edits[b.id]) || edits[b.id]) : null;
      var merged = edit ? normalizeBook(Object.assign({}, base, edit)) || base : base;
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
      var da = a.endDate || a.startDate || '', db = b.endDate || b.startDate || '';
      if (da !== db) return da < db ? 1 : -1;
      var ca = a.createdAt || '', cb = b.createdAt || '';
      if (ca !== cb) return ca < cb ? 1 : -1;
      return String(a.title).localeCompare(String(b.title), 'ko');
    });
  }

  /* 완독 통계는 상태가 '완독'인 책만 셉니다. 중단·읽는 중은 따로 셉니다. */
  function computeStats(books, now) {
    now = now || new Date();
    var currentYear = now.getFullYear();
    var total = 0, thisYear = 0, hearts = 0, stopped = 0, reading = 0, undated = 0;
    var years = {}, months = {}, cats = {};

    books.forEach(function (b) {
      if (b.heart) hearts++;
      var cat = b.category || '기타';
      cats[cat] = (cats[cat] || 0) + 1;

      var status = normalizeStatus(b.status);
      if (status === STATUS.STOPPED) { stopped++; return; }
      if (status === STATUS.READING) { reading++; return; }

      total++;
      if (!b.endDate) { undated++; return; }
      var y = b.endDate.slice(0, 4);
      var m = b.endDate.slice(0, 7);
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
      stopped: stopped,
      reading: reading,
      undated: undated,
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

  function cleanQuotes(quotes) {
    return (quotes || []).map(function (q) {
      var out = { id: q.id, text: q.text, createdAt: q.createdAt || '' };
      if (q.page) out.page = q.page;
      return out;
    });
  }

  function cleanForExport(b) {
    return {
      id: b.id,
      title: b.title,
      author: b.author || '',
      category: b.category || '기타',
      startDate: b.startDate || '',
      endDate: b.endDate || '',
      /* 예전 버전과도 호환되도록 끝난 날짜를 finishedAt에도 같이 담습니다. */
      finishedAt: b.endDate || '',
      status: normalizeStatus(b.status),
      cover: b.cover || '',
      memo: b.memo || '',
      heart: !!b.heart,
      quotes: cleanQuotes(b.quotes)
    };
  }

  function exportPayload(books) {
    return JSON.stringify({
      app: '나만의 서재',
      version: 2,
      exportedAt: new Date().toISOString(),
      count: books.length,
      books: books.map(cleanForExport)
    }, null, 2);
  }

  var api = {
    DEFAULT_CATEGORIES: DEFAULT_CATEGORIES,
    STATUS: STATUS,
    STATUS_LIST: STATUS_LIST,
    normalizeStatus: normalizeStatus,
    newId: newId,
    toDate: toDate,
    normalizeBook: normalizeBook,
    normalizeQuote: normalizeQuote,
    normalizeQuotes: normalizeQuotes,
    pageLabel: pageLabel,
    mergeLibrary: mergeLibrary,
    sortBooks: sortBooks,
    computeStats: computeStats,
    parseImport: parseImport,
    exportPayload: exportPayload,
    cleanForExport: cleanForExport,
    cleanQuotes: cleanQuotes
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Shelf = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
