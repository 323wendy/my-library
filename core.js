/* ============================================================
   나만의 기록 — 데이터 로직 (DOM을 쓰지 않는 순수 함수 모음)

   세 가지 기록을 같은 방식으로 다룹니다.
     books     독서        → books.json
     videos    영상        → videos.json
     webtoons  웹툰·웹소설 → webtoons.json

   각 JSON(공용 데이터)과 localStorage(내 수정·추가 내역)를
   id 기준으로 병합하고, 통계와 가져오기/내보내기를 계산합니다.
   ============================================================ */
(function (root) {
  'use strict';

  /* ---------------- 기록 종류 정의 ---------------- */

  var COLLECTIONS = [
    {
      id: 'books',
      file: 'books.json',
      listKey: 'books',
      label: '독서',
      emoji: '📚',
      unit: '권',
      itemWord: '책',
      tint: 'cream',
      statuses: { done: '완독', stopped: '중단', active: '읽는 중' },
      kinds: ['소설', '인문', '에세이', '경제/경영', '기타'],
      defaultKind: '기타',
      customKind: true,
      kindLabel: '카테고리',
      creatorLabel: '저자',
      creatorPlaceholder: '예: 이라영',
      platform: false,
      dates: { start: '읽기 시작한 날짜', end: '끝난 날짜' },
      memoLabel: '한 줄 평',
      memoPlaceholder: '짧은 감상을 남겨보세요.',
      quotesLabel: '마음에 든 문구',
      quotePlaceholder: '마음에 남은 문장을 적어보세요.',
      quotePage: true,
      link: false,
      lookup: true,
      searchPlaceholder: '책 제목, 저자, 한 줄 평, 문구 검색',
      stats: { done: '총 완독', year: '올해 완독' },
      empty: { emoji: '📚', text: '아직 서재가 비어 있어요. 첫 책을 담아볼까요?' },
      titlePlaceholder: '예: 쇳돌'
    },
    {
      id: 'videos',
      file: 'videos.json',
      listKey: 'items',
      label: '영상',
      emoji: '🎬',
      unit: '편',
      itemWord: '영상',
      tint: 'lavender',
      statuses: { done: '봤음', stopped: '중단', active: '보는 중' },
      kinds: ['영화', '드라마', '애니', '예능', '다큐'],
      defaultKind: '영화',
      customKind: false,
      kindLabel: '분야',
      creatorLabel: '감독·제작',
      creatorPlaceholder: '예: 봉준호',
      platform: false,
      dates: { start: '보기 시작한 날짜', end: '본 날짜' },
      memoLabel: '한 줄 감상',
      memoPlaceholder: '짧은 감상이나 기억에 남는 장면을 적어보세요.',
      quotesLabel: '명대사·기억에 남는 장면',
      quotePlaceholder: '기억에 남는 대사나 장면을 적어보세요.',
      quotePage: false,
      link: true,
      lookup: false,
      searchPlaceholder: '제목, 감독, 한 줄 감상, 명대사 검색',
      stats: { done: '본 영상', year: '올해 본 영상' },
      empty: { emoji: '🍿', text: '아직 본 영상이 없어요. 어제 본 드라마부터 담아볼까요?' },
      titlePlaceholder: '예: 기생충'
    },
    {
      id: 'webtoons',
      file: 'webtoons.json',
      listKey: 'items',
      label: '웹툰·웹소설',
      emoji: '🖍️',
      unit: '개',
      itemWord: '작품',
      tint: 'peach',
      statuses: { done: '완독', stopped: '중단', active: '보는 중' },
      kinds: ['웹툰', '웹소설'],
      defaultKind: '웹툰',
      customKind: false,
      kindLabel: '종류',
      creatorLabel: '작가·원작',
      creatorPlaceholder: '예: 강기 (원작 우지혜)',
      platform: true,
      dates: { start: '보기 시작한 날짜', end: '본 날짜' },
      memoLabel: '한 줄 감상',
      memoPlaceholder: '짧은 감상이나 기억에 남는 장면을 적어보세요.',
      quotesLabel: '명대사·기억에 남는 장면',
      quotePlaceholder: '기억에 남는 대사나 장면을 적어보세요.',
      quotePage: false,
      link: true,
      lookup: false,
      searchPlaceholder: '제목, 작가, 한 줄 감상, 명대사 검색',
      stats: { done: '완독한 작품', year: '올해 완독' },
      empty: { emoji: '🖍️', text: '웹툰·웹소설 칸이 비어 있어요. 정주행한 작품을 담아보세요.' },
      titlePlaceholder: '예: 그저 여명일 뿐'
    }
  ];

  var PLATFORMS = ['네이버웹툰', '네이버시리즈', '카카오페이지', '카카오웹툰', '리디', '레진코믹스', '문피아', '노벨피아', '기타'];

  var DEFAULT_CATEGORIES = ['소설', '인문', '에세이', '경제/경영', '기타'];

  /* 상태는 세 가지로만 다룹니다. 화면에 보이는 말은 기록 종류마다 다릅니다.
     done = 다 봄 / stopped = 중단 / active = 보는 중 */
  var STATUS = { DONE: 'done', STOPPED: 'stopped', ACTIVE: 'active' };
  var STATUS_LIST = [STATUS.DONE, STATUS.STOPPED, STATUS.ACTIVE];

  function collection(id) {
    for (var i = 0; i < COLLECTIONS.length; i++) {
      if (COLLECTIONS[i].id === id) return COLLECTIONS[i];
    }
    return COLLECTIONS[0];
  }

  function statusLabel(coll, status) {
    var c = collection(coll && coll.id ? coll.id : coll);
    return (c.statuses || COLLECTIONS[0].statuses)[status] || c.statuses.done;
  }

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

  /* "중단", "포기", "봤음", "보는 중", "읽는 중", "watching" … 을 done/stopped/active로 맞춥니다.
     이미 done/stopped/active로 적힌 값도 그대로 받습니다. */
  function normalizeStatus(v) {
    var s = str(v).toLowerCase();
    if (!s) return STATUS.DONE;
    if (/중단|포기|그만|손절|dnf|abandon|drop|gave up|not finish|stopped/.test(s)) return STATUS.STOPPED;
    if (/보는|읽는|읽고|시청\s*중|보고|reading|watching|ongoing|in progress|진행|미완|active/.test(s)) return STATUS.ACTIVE;
    if (/완독|완료|봤|본\b|다\s*봄|시청|done|finish|complete|read|watched/.test(s)) return STATUS.DONE;
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
  function normalizeQuote(raw, withPage) {
    if (raw === null || raw === undefined) return null;
    var text = '', id = '', page = '', createdAt = '';

    if (typeof raw === 'string' || typeof raw === 'number') {
      text = str(raw);
    } else if (typeof raw === 'object') {
      text = str(firstOf(raw, ['text', 'quote', 'content', 'sentence', 'phrase', 'body', '문구', '구절', '내용', 'line', '명대사']));
      page = firstOf(raw, ['page', 'pageNo', 'pageNumber', 'p', '페이지']);
      id = str(firstOf(raw, ['id', 'key', '_id', 'quoteId']));
      createdAt = str(firstOf(raw, ['createdAt', 'addedAt', 'created', 'date']));
    }

    if (!text) return null;
    var q = { id: id || newId(), text: text };
    if (withPage !== false) {
      var p = pageLabel(page);
      if (p) q.page = p;
    }
    q.createdAt = createdAt || new Date().toISOString();
    return q;
  }

  /* 문구 목록: 배열 / 문구 한 개 / 문자열 하나 모두 허용. id가 겹치면 새로 붙입니다. */
  function normalizeQuotes(raw, withPage) {
    if (raw === null || raw === undefined || raw === '') return [];
    var list = Array.isArray(raw) ? raw : [raw];
    var seen = {};
    var out = [];
    list.forEach(function (item) {
      var q = normalizeQuote(item, withPage);
      if (!q) return;
      if (seen[q.id]) q.id = newId();
      seen[q.id] = true;
      out.push(q);
    });
    return out;
  }

  var CREATOR_KEYS_BOOK = ['author', '저자', 'writer', 'authors', 'authorName', 'creator', '작가', '감독'];
  var CREATOR_KEYS_OTHER = ['creator', '감독', '제작', '작가', '원작', '저자', 'author', 'director', 'writer', 'studio'];

  /* 어떤 모양의 기록이든 우리 형식으로 바꿉니다.
     (예전에 쓰던 앱에서 내보낸 JSON도 최대한 살려서 읽습니다)
     내부에서는 기록 종류와 상관없이 creator·kind·memo로 다룹니다. */
  function normalizeItem(raw, coll) {
    coll = typeof coll === 'string' ? collection(coll) : (coll || COLLECTIONS[0]);
    if (!raw || typeof raw !== 'object') return null;

    var title = str(firstOf(raw, ['title', '제목', 'name', 'bookTitle', 'book_name', 'workTitle']));
    if (!title) return null;

    /* 예전 데이터의 단일 날짜(finishedAt · date · 완독일 …)는 끝난 날짜(endDate)로 읽습니다. */
    var endDate = toDate(firstOf(raw, ['endDate', 'finishedAt', 'watchedAt', 'date', '완독일', 'readDate', 'finished', 'doneAt', 'readAt', 'end', '끝난날짜', '끝난 날짜']));
    var startDate = toDate(firstOf(raw, ['startDate', 'startedAt', 'start', 'readStart', 'beganAt', '시작일', '시작날짜', '시작 날짜']));

    var kindRaw = str(firstOf(raw, coll.listKey === 'books'
      ? ['category', '카테고리', 'genre', '분야', 'kind', 'type']
      : ['kind', '분야', 'category', '카테고리', 'genre', 'type']));

    var rawMemo = firstOf(raw, ['memo', 'note', '한줄평', '한 줄 평', 'comment', 'review', 'oneLine', 'summary', '감상']);
    var extraNotes = [];
    if (Array.isArray(rawMemo)) { extraNotes = rawMemo.slice(); rawMemo = ''; }

    var quotes = normalizeQuotes(firstOf(raw, ['quotes', 'quoteList', 'highlights', 'passages', '문구', '구절', '명대사', 'lines']), coll.quotePage);
    if (extraNotes.length) {
      var seen = {};
      quotes.forEach(function (q) { seen[q.id] = true; });
      normalizeQuotes(extraNotes, coll.quotePage).forEach(function (q) {
        if (seen[q.id]) q.id = newId();
        quotes.push(q);
      });
    }

    var item = {
      id: str(firstOf(raw, ['id', 'key', '_id', 'bookId', 'itemId'])) || newId(),
      title: title,
      creator: str(firstOf(raw, coll.listKey === 'books' ? CREATOR_KEYS_BOOK : CREATOR_KEYS_OTHER)),
      kind: kindRaw || coll.defaultKind,
      startDate: startDate,
      endDate: endDate,
      status: normalizeStatus(firstOf(raw, ['status', '상태', 'state', 'readStatus', '읽기상태', '보기상태'])),
      cover: str(firstOf(raw, ['cover', 'coverUrl', 'coverURL', 'image', 'imageUrl', 'thumbnail', 'thumbnailUrl', 'poster', '표지', '포스터'])) || '',
      memo: str(rawMemo),
      heart: toBool(firstOf(raw, ['heart', 'favorite', 'liked', 'isHeart', 'love', 'like'])),
      quotes: quotes
    };
    if (coll.platform) item.platform = str(firstOf(raw, ['platform', '플랫폼', 'site', 'service']));
    if (coll.link) item.link = str(firstOf(raw, ['link', 'url', 'href', '링크'])) || '';

    /* 예전 코드가 읽을 수 있도록 끝난 날짜를 finishedAt으로도 함께 남겨 둡니다. */
    item.finishedAt = endDate;
    if (raw.createdAt) item.createdAt = str(raw.createdAt);
    var updatedAt = str(firstOf(raw, ['updatedAt', 'modifiedAt', 'changedAt']));
    if (updatedAt) item.updatedAt = updatedAt;
    if (raw.sample) item.sample = true;
    return item;
  }

  /* books.json처럼 '책'이라는 이름으로 부르던 자리에서도 같은 함수를 씁니다. */
  function normalizeBook(raw) { return normalizeItem(raw, COLLECTIONS[0]); }

  /* JSON 파일에서 목록 배열을 꺼냅니다. (books / items / videos / webtoons …) */
  function listFromPayload(data, coll) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    var keys = ['books', 'items', 'videos', 'webtoons', 'data', 'list', 'library', coll && coll.listKey];
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] && Array.isArray(data[keys[i]])) return data[keys[i]];
    }
    return [];
  }

  function normalizeList(list, coll) {
    var out = [];
    var seen = {};
    (list || []).forEach(function (raw) {
      var item = normalizeItem(raw, coll);
      if (!item) return;
      if (seen[item.id]) item.id = newId();
      seen[item.id] = true;
      out.push(item);
    });
    return out;
  }

  /* JSON 파일(공용) + 내 저장소(수정/추가/삭제) 병합
     - deleted : 내가 지운 기록의 id (파일에 다시 올라와도 지운 채로 둠)
     - edits   : 파일에 있던 기록을 내가 고친 내용 (id별)
     - added   : 내가 직접 등록한 기록 (id별 전체 데이터) */
  function mergeLibrary(remote, store, coll) {
    coll = typeof coll === 'string' ? collection(coll) : (coll || COLLECTIONS[0]);
    store = store || {};
    var deleted = {};
    (store.deleted || []).forEach(function (id) { deleted[id] = true; });
    var edits = store.edits || {};
    var map = {};
    var order = [];

    (remote || []).forEach(function (b) {
      if (!b || !b.id || deleted[b.id]) return;
      var base = normalizeItem(b, coll) || b;
      /* 저장된 수정 내역도 먼저 표준 형식으로 바꿔야 예전 finishedAt만 있는 기록도 날짜가 살아납니다. */
      var edit = edits[b.id] ? (normalizeItem(edits[b.id], coll) || edits[b.id]) : null;
      var merged = edit ? normalizeItem(Object.assign({}, base, edit), coll) || base : base;
      if (!map[b.id]) order.push(b.id);
      map[b.id] = merged;
    });

    (store.added || []).forEach(function (b) {
      if (!b || !b.id || deleted[b.id]) return;
      if (!map[b.id]) order.push(b.id);
      map[b.id] = normalizeItem(b, coll) || b;
    });

    return order.map(function (id) { return map[id]; });
  }

  /* 정렬: '보는 중'(책은 읽는 중)인 기록이 항상 맨 앞, 그다음은 본 날짜가 최근인 것부터.
     - 진행 중끼리는 시작일(없으면 등록한 날짜) 최신 순
     - 끝난 기록은 끝난 날짜 → 시작일 최신 순, 날짜가 아예 없는 것은 맨 뒤
     - 그래도 같으면 등록한 날짜 최신 순 → 제목 가나다순 */
  function sortItems(items, coll) {
    coll = typeof coll === 'string' ? collection(coll) : (coll || COLLECTIONS[0]);
    function isActive(b) { return normalizeStatus(b.status) === STATUS.ACTIVE; }
    function endDay(b) { return b.endDate || b.startDate || ''; }
    function startDay(b) { return b.startDate || b.createdAt || ''; }

    return (items || []).slice().sort(function (a, b) {
      var ra = isActive(a), rb = isActive(b);
      if (ra !== rb) return ra ? -1 : 1;

      var da = ra ? startDay(a) : endDay(a);
      var db = ra ? startDay(b) : endDay(b);
      if (da !== db) {
        if (!da) return 1;
        if (!db) return -1;
        return da < db ? 1 : -1;
      }

      var ca = a.createdAt || '', cb = b.createdAt || '';
      if (ca !== cb) return ca < cb ? 1 : -1;
      var t = String(a.title).localeCompare(String(b.title), 'ko');
      if (t !== 0) return t;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
  }

  /* 끝난(완독) 기록만 세는 통계. 중단·보는 중은 따로 셉니다. */
  function computeStats(items, coll, now) {
    coll = typeof coll === 'string' ? collection(coll) : (coll || COLLECTIONS[0]);
    now = now || new Date();
    var currentYear = now.getFullYear();
    var total = 0, thisYear = 0, hearts = 0, stopped = 0, active = 0, undated = 0;
    var years = {}, months = {}, kinds = {};

    (items || []).forEach(function (b) {
      if (b.heart) hearts++;
      var kind = b.kind || coll.defaultKind;
      kinds[kind] = (kinds[kind] || 0) + 1;

      var status = normalizeStatus(b.status);
      if (status === STATUS.STOPPED) { stopped++; return; }
      if (status === STATUS.ACTIVE) { active++; return; }

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

    var kindRows = Object.keys(kinds)
      .map(function (k) { return { key: k, label: k, count: kinds[k] }; })
      .sort(function (a, b) { return b.count - a.count || a.label.localeCompare(b.label, 'ko'); });

    var count = (items || []).length;
    kindRows.forEach(function (r) {
      r.pct = count ? Math.round((r.count / count) * 100) : 0;
    });

    return {
      total: total,
      thisYear: thisYear,
      hearts: hearts,
      stopped: stopped,
      active: active,
      undated: undated,
      count: count,
      years: rows(years, function (k) { return k + '년'; }),
      months: rows(months, function (k) { return k; }),
      kinds: kindRows,
      categories: kindRows
    };
  }

  /* 붙여넣은 JSON을 기록 목록으로 (배열 / {items:[...]} / {books:[...]} / 한 개 모두 허용) */
  function parseImport(text, coll) {
    coll = typeof coll === 'string' ? collection(coll) : (coll || COLLECTIONS[0]);
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
      var keys = ['books', 'items', 'videos', 'webtoons', 'data', 'list', 'library', '서재', coll.listKey];
      for (var i = 0; i < keys.length; i++) {
        if (Array.isArray(data[keys[i]])) { list = data[keys[i]]; break; }
      }
      if (!list && (data.title || data['제목'])) list = [data];
    }
    if (!list) throw new Error('기록 목록을 찾지 못했어요. 복사한 내용 전체를 붙여넣어 주세요.');

    var seen = {};
    var items = [];
    list.forEach(function (raw) {
      var b = normalizeItem(raw, coll);
      if (!b) return;
      if (seen[b.id]) b.id = newId();
      seen[b.id] = true;
      items.push(b);
    });
    if (!items.length) throw new Error('불러올 기록이 없어요.');
    return items;
  }

  function cleanQuotes(quotes) {
    return (quotes || []).map(function (q) {
      var out = { id: q.id, text: q.text, createdAt: q.createdAt || '' };
      if (q.page) out.page = q.page;
      return out;
    });
  }

  /* 파일에 담을 모양. 기록 종류마다 부르는 이름이 다릅니다.
     books → author/category/memo, videos·webtoons → creator/kind/note */
  function cleanForExport(b, coll) {
    coll = typeof coll === 'string' ? collection(coll) : (coll || COLLECTIONS[0]);
    var out = {
      id: b.id,
      title: b.title
    };
    if (coll.listKey === 'books') {
      out.author = b.creator || '';
      out.category = b.kind || coll.defaultKind;
    } else {
      out.creator = b.creator || '';
      out.kind = b.kind || coll.defaultKind;
      if (coll.platform) out.platform = b.platform || '';
    }
    out.startDate = b.startDate || '';
    out.endDate = b.endDate || '';
    /* 예전 버전과도 호환되도록 끝난 날짜를 finishedAt에도 같이 담습니다. */
    if (coll.listKey === 'books') out.finishedAt = b.endDate || '';
    out.status = statusLabel(coll, normalizeStatus(b.status));
    out.cover = b.cover || '';
    if (coll.listKey === 'books') out.memo = b.memo || '';
    else out.note = b.memo || '';
    out.heart = !!b.heart;
    out.quotes = cleanQuotes(b.quotes);
    if (coll.link) out.link = b.link || '';
    return out;
  }

  /* ---------- 기기 간 동기화(JSON 파일)용 도우미 ---------- */

  /* 기록을 고칠 때마다 붙이는 수정 시각. 같은 기록을 두 기기에서 고쳤을 때
     더 최근에 고친 쪽을 고르는 기준이 됩니다. */
  function stamp(item) {
    var copy = Object.assign({}, item);
    copy.updatedAt = new Date().toISOString();
    return copy;
  }

  function timeOf(item) {
    if (!item) return 0;
    var t = Date.parse(str(item.updatedAt || item.createdAt));
    return isNaN(t) ? 0 : t;
  }

  /* 이 기기 기록(local)과 원격 파일(remote)을 id 기준으로 합칩니다.
     - 같은 기록은 더 최근에 고친 쪽(updatedAt)을 씁니다.
     - 내가 지운 기록(deletedIds)은 되살리지 않습니다.
     - 마지막으로 알던 원격 목록(seenRemote)에는 있었는데 지금 원격에 없는 기록은
       다른 기기에서 지운 것으로 보고 이 기기에서도 지웁니다(removed로 알려줌). */
  function mergeForSync(local, remote, deletedIds, seenRemote) {
    var deleted = {};
    (deletedIds || []).forEach(function (id) { if (id) deleted[id] = true; });

    var remoteList = (remote || []).filter(function (b) { return b && b.id && !deleted[b.id]; });
    var remoteIds = {};
    remoteList.forEach(function (b) { remoteIds[b.id] = true; });

    var removed = [];
    /* 원격이 통째로 비어 있으면 사고일 수 있으니 지움 판단을 하지 않습니다. */
    if (remoteList.length) {
      (seenRemote || []).forEach(function (id) {
        if (id && !remoteIds[id] && !deleted[id]) {
          deleted[id] = true;
          removed.push(id);
        }
      });
    }

    var map = {};
    var order = [];
    remoteList.forEach(function (b) {
      if (!b || !b.id || deleted[b.id] || map[b.id]) return;
      map[b.id] = b;
      order.push(b.id);
    });
    (local || []).forEach(function (b) {
      if (!b || !b.id || deleted[b.id]) return;
      var known = map[b.id];
      if (!known) {
        map[b.id] = b;
        order.push(b.id);
        return;
      }
      if (timeOf(b) > timeOf(known)) map[b.id] = b;
    });

    return {
      items: order.map(function (id) { return map[id]; }),
      books: order.map(function (id) { return map[id]; }),
      removed: removed,
      deleted: Object.keys(deleted)
    };
  }

  /* GitHub JSON 파일에 담을 기록 한 개(필드 순서를 고정합니다). */
  function serializeForRepo(b, coll) {
    var out = cleanForExport(b, coll);
    if (b.updatedAt) out.updatedAt = b.updatedAt;
    if (b.createdAt) out.createdAt = b.createdAt;
    if (b.sample) out.sample = true;
    return out;
  }

  /* 같은 기록인지 견주는 지문. 순서를 고정해 내용이 같으면 같은 글자가 됩니다. */
  function itemsFingerprint(items, coll) {
    coll = typeof coll === 'string' ? collection(coll) : (coll || COLLECTIONS[0]);
    return JSON.stringify(sortItems(items || [], coll).map(function (b) { return serializeForRepo(b, coll); }));
  }

  /* 예전 이름(책만 있던 시절)도 그대로 동작하게 둡니다. */
  function booksFingerprint(books) { return itemsFingerprint(books, COLLECTIONS[0]); }

  function payloadFor(coll, items) {
    coll = typeof coll === 'string' ? collection(coll) : (coll || COLLECTIONS[0]);
    var list = sortItems(items || [], coll).map(function (b) { return serializeForRepo(b, coll); });
    var data = {
      app: '나만의 기록',
      version: coll.listKey === 'books' ? 3 : 1,
      updatedAt: new Date().toISOString(),
      count: list.length
    };
    data[coll.listKey] = list;
    return JSON.stringify(data, null, 2) + '\n';
  }

  function repoPayload(books) { return payloadFor(COLLECTIONS[0], books); }

  /* GitHub Contents API는 파일 내용을 base64(UTF-8)로 주고받습니다. */
  function utf8ToBase64(text) {
    var s = String(text === null || text === undefined ? '' : text);
    if (typeof root.btoa !== 'function' || typeof root.TextEncoder !== 'function') return '';
    var bytes = new root.TextEncoder().encode(s);
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return root.btoa(bin);
  }

  function base64ToUtf8(b64) {
    var s = String(b64 || '').replace(/\s+/g, '');
    if (!s) return '';
    if (typeof root.atob !== 'function' || typeof root.TextDecoder !== 'function') return '';
    var bin = root.atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new root.TextDecoder('utf-8').decode(bytes);
  }

  function exportPayload(items, coll) {
    coll = typeof coll === 'string' ? collection(coll) : (coll || COLLECTIONS[0]);
    var data = {
      app: '나만의 기록',
      collection: coll.id,
      version: coll.listKey === 'books' ? 3 : 1,
      exportedAt: new Date().toISOString(),
      count: (items || []).length
    };
    data[coll.listKey] = (items || []).map(function (b) { return cleanForExport(b, coll); });
    return JSON.stringify(data, null, 2);
  }

  var api = {
    COLLECTIONS: COLLECTIONS,
    PLATFORMS: PLATFORMS,
    DEFAULT_CATEGORIES: DEFAULT_CATEGORIES,
    STATUS: STATUS,
    STATUS_LIST: STATUS_LIST,
    collection: collection,
    statusLabel: statusLabel,
    normalizeStatus: normalizeStatus,
    newId: newId,
    toDate: toDate,
    normalizeItem: normalizeItem,
    normalizeBook: normalizeBook,
    normalizeList: normalizeList,
    listFromPayload: listFromPayload,
    normalizeQuote: normalizeQuote,
    normalizeQuotes: normalizeQuotes,
    pageLabel: pageLabel,
    mergeLibrary: mergeLibrary,
    mergeForSync: mergeForSync,
    stamp: stamp,
    timeOf: timeOf,
    serializeForRepo: serializeForRepo,
    itemsFingerprint: itemsFingerprint,
    booksFingerprint: booksFingerprint,
    payloadFor: payloadFor,
    repoPayload: repoPayload,
    utf8ToBase64: utf8ToBase64,
    base64ToUtf8: base64ToUtf8,
    sortItems: sortItems,
    sortBooks: function (books) { return sortItems(books, COLLECTIONS[0]); },
    computeStats: computeStats,
    parseImport: parseImport,
    exportPayload: exportPayload,
    cleanForExport: cleanForExport,
    cleanQuotes: cleanQuotes
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Shelf = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
