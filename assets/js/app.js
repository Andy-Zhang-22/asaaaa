/*
 * app.js — 介面與流程。
 */
(function () {
  'use strict';

  const { OUTCOME_LABEL } = window.Normalize;
  /*
   * 靜態主機會把 js/css 快取起來，沒有版本號的話使用者更新後還是拿到舊檔案。
   * index.html 的每個 assets 網址都帶 ?v=，改版時一起換掉這個字串即可。
   */
  const APP_VERSION = '20260919-114';
  const TAX_LABEL = { yes: '有統編', no: '無統編' };
  const PHONE_LABEL = { yes: '有電話', no: '無電話' };
  // 變更登記：商工登記查核時發現的異動。一家公司可以同時有好幾種（增資＋負責人異動）
  const REG_KIND_LABEL = {
    capitalUp: '增資', capitalDown: '減資', address: '變更登記地址', owner: '負責人異動',
    other: '其他', none: '無變更', unchecked: '未查核',
  };
  const REG_KIND_ORDER = ['capitalUp', 'capitalDown', 'address', 'owner', 'other', 'none', 'unchecked'];
  /*
   * 有沒有機會：業務自己判斷的，不是從訪談內容猜的。
   *
   * 「有意願給資料評估」這種判斷只有打過電話的人知道，任何自動判讀都會猜錯；
   * 猜錯的後果是業務照著錯的名單打，比沒有這個欄位還糟。所以只收手動標記，
   * 沒標的一律算「未判斷」，不預設成無機會。
   */
  const CHANCE_ORDER = ['yes', 'no', 'none'];
  const CHANCE_LABEL = { yes: '有機會', no: '無機會', none: '未判斷' };
  const PAGE_SIZE = 60;
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, props, children) => {
    const node = Object.assign(document.createElement(tag), props || {});
    (children || []).forEach((c) => node.append(c));
    return node;
  };

  const state = {
    records: [],
    logs: [],
    userStates: new Map(),
    tab: 'all',
    search: '',
    /*
     * 預設照「最近核准變更」由新到舊排。
     *
     * 使用者要的是追蹤客戶：剛增資、剛換負責人、剛搬家的公司排在最前面，那是
     * 最值得打的一批。下次聯絡日那條線有提醒列在顧，不需要靠排序。
     */
    sort: 'regchanged',
    limit: PAGE_SIZE,
    hideBlocked: true,
    filters: { due: '', dueFrom: '', dueTo: '', dueNone: false, source: new Set(), outcome: new Set(), city: new Set(), scale: new Set(), territory: new Set(), relation: new Set(), visit: new Set(), chance: new Set(), taxKind: new Set(), phoneKind: new Set(), regChange: new Set(), branch: new Set(), added: new Set(), industry: '' },
  };

  /* ---------------- 工具 ---------------- */

  // 每分鐘算一次就夠了，這個函式在篩選與排序裡會被呼叫上千次
  let todayCache = { at: 0, iso: '', ms: 0 };
  const todayISO = () => {
    const now = Date.now();
    if (now - todayCache.at > 60000) {
      const d = new Date();
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      todayCache = { at: now, iso, ms: Date.parse(`${iso}T00:00:00`) };
    }
    return todayCache.iso;
  };
  const addDays = (iso, n) => {
    const d = new Date(`${iso}T00:00:00`);
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  /*
   * 日期一律顯示西元 yyyy/mm/dd。
   *
   * 曾經改成民國年，使用者用了之後要求改回西元：他的 Excel 母檔、104 與
   * 商工登記全是西元，名單上混著民國反而要換算。
   */
  const dateLabel = (iso) => {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return `${y}/${m}/${d}`;
  };
  /*
   * 日期輸入框旁邊即時顯示 yyyy/mm/dd。
   *
   * <input type="date"> 的顯示格式跟著瀏覽器語系走，在使用者的電腦上是 mm/dd/yyyy，
   * 網頁改不了。選擇器本身很好用（有月曆、有快速鍵），不想換掉，
   * 所以在旁邊補一個跟名單同格式的標示，選了什麼一眼就對得上。
   */
  /**
   * 日期框旁邊的民國日期提示。
   * @param {HTMLInputElement} input
   * @param {boolean} [warnHoliday] 排未來的日期才要提醒放假；紀錄「哪天打的」不用，
   *   那是已經發生的事，週六打過電話也很正常，標上去只是噪音。
   */
  function withDateHint(input, warnHoliday) {
    const hint = el('span', { className: 'date-hint' });
    /*
     * 自己選的日期照舊尊重，不會偷偷改掉——但如果那天是國定假日或週末，
     * 這裡要講出來。快捷鍵（明天、一週後…）才會自動順延。
     */
    const sync = () => {
      if (!input.value) { hint.textContent = ''; hint.classList.remove('is-holiday'); return; }
      const H = warnHoliday ? window.Holidays : null;
      const why = H ? H.holidayName(input.value) : '';
      // 那一年的行事曆還沒補進來時要講明，不然使用者會以為網站已經幫他避開國定假日了
      const gap = H && why && !H.covered(input.value) ? `（${String(input.value).slice(0, 4)} 年行事曆還沒更新，只避得開週末）` : '';
      const label = why ? `${dateLabel(input.value)}　⚠ ${/^週/.test(why) ? `${why}，放假` : `${why}（放假）`}` : dateLabel(input.value);
      hint.textContent = label + gap;
      hint.classList.toggle('is-holiday', !!why);
    };
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    sync();
    return el('span', { className: 'date-with-hint' }, [input, hint]);
  }

  const dayDiff = (iso) => {
    todayISO();
    return Math.round((Date.parse(`${iso}T00:00:00`) - todayCache.ms) / 86400000);
  };

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  /** 時間戳 → 「11:05」 */
  const timeLabel = (ts) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  /** 時間戳 → 「2026/09/18 11:05」；不是今天的才帶日期 */
  const whenLabel = (ts) => {
    const d = new Date(ts);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return iso === todayISO() ? timeLabel(ts) : `${dateLabel(iso)} ${timeLabel(ts)}`;
  };

  /*
   * 回撥提醒。
   *
   * 客戶說「晚點再打」，業務掛了電話就忘。做法：在詳細頁按一下「1 小時後」「14:00」
   * 就記在這筆的追蹤狀態（跟著雲端同步）；名單頁最上面有一條提醒列，時間到了變紅、
   * 跳提示，開了瀏覽器通知的話也會發通知。沒有後端，所以只有網站開著（或裝成
   * 主畫面 App）時才會提醒——這點在提醒列裡講清楚。
   */
  const NOTIFIED_KEY = 'remind-notified';
  async function setReminder(recordId, remindAt, note) {
    await saveState(recordId, { remindAt: remindAt || null, remindNote: remindAt ? (note || '') : '', remindSetAt: Date.now() });
    scheduleSync();
    render();
  }
  function reminders() {
    return allViews().filter((r) => r.remindAt).sort((a, b) => a.remindAt - b.remindAt);
  }
  /*
   * 下次聯絡日也算提醒：訪談紀錄填了下次聯絡日，就不用再另外設時間，
   * 當天打開網站就列在提醒列、跳一次提示與通知（一天一次）。
   */
  const DUE_NOTIFIED_KEY = 'due-notified';
  function dueToday() {
    const today = todayISO();
    return allViews().filter((r) => r.nextDate === today && !r.blocked)
      .sort((a, b) => a.company.localeCompare(b.company, 'zh-Hant'));
  }
  function checkDueToday() {
    const today = todayISO();
    let seen = '';
    try { seen = localStorage.getItem(DUE_NOTIFIED_KEY) || ''; } catch (e) { /* 無痕模式 */ }
    if (seen === today) return;
    const list = dueToday();
    if (!list.length) return;
    try { localStorage.setItem(DUE_NOTIFIED_KEY, today); } catch (e) { /* 無痕模式 */ }
    const names = list.slice(0, 3).map((r) => r.company).join('、') + (list.length > 3 ? ` 等 ${list.length} 家` : '');
    toast(`📅 今天要聯絡：${names}`);
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(`今天要聯絡 ${list.length} 家`, { body: names, tag: 'due-today' });
        n.onclick = () => { window.focus(); applyDueQuick('today'); state.limit = PAGE_SIZE; render(); };
      } catch (e) { /* 有些瀏覽器不給在網頁直接 new Notification */ }
    }
  }
  function notifiedSet() {
    try { return new Set(JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '[]')); } catch (e) { return new Set(); }
  }
  function checkReminders() {
    const now = Date.now();
    checkDueToday();
    const due = reminders().filter((r) => r.remindAt <= now);
    if (!due.length) return;
    const seen = notifiedSet();
    const fresh = due.filter((r) => !seen.has(`${r.id}|${r.remindAt}`));
    if (!fresh.length) return;
    fresh.forEach((r) => seen.add(`${r.id}|${r.remindAt}`));
    try { localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...seen].slice(-200))); } catch (e) { /* 無痕模式 */ }
    const names = fresh.map((r) => r.company).join('、');
    toast(`⏰ 該回撥了：${names}`);
    if ('Notification' in window && Notification.permission === 'granted') {
      fresh.forEach((r) => {
        try {
          const n = new Notification(`該回撥：${r.company}`, { body: r.remindNote || `約 ${timeLabel(r.remindAt)} 回撥`, tag: `remind-${r.id}` });
          n.onclick = () => { window.focus(); openDetail(r.id); };
        } catch (e) { /* 有些瀏覽器不給在網頁直接 new Notification */ }
      });
    }
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) { /* 不支援就算了 */ }
    renderRemindBar();
  }
  const REMIND_OPEN_KEY = 'remind-bar-open';
  /*
   * 提醒列：一份清單就好。
   *
   * 有時間的回撥提醒與「下次聯絡日是今天」合在一起，同一家只列一次（有時間的優先）；
   * 每列固定三欄：時間｜公司＋窗口、電話｜動作，不換行。說明文字不放在列上，
   * 整條可收起，收起後只剩一行標題。
   */
  function remindItems() {
    const now = Date.now();
    const items = reminders().map((r) => ({ r, kind: 'timed', at: r.remindAt, due: r.remindAt <= now }));
    const seen = new Set(items.map((x) => x.r.id));
    dueToday().forEach((r) => { if (!seen.has(r.id)) items.push({ r, kind: 'date', at: 0, due: false }); });
    // 到期的排最前，再來有時間的照時間，最後是只有日期的
    items.sort((x, y) => (Number(y.due) - Number(x.due)) || ((x.at || Infinity) - (y.at || Infinity)) || x.r.company.localeCompare(y.r.company, 'zh-Hant'));
    return items;
  }
  function renderRemindBar() {
    const bar = $('#remindBar');
    if (!bar) return;
    const items = remindItems();
    bar.hidden = !items.length;
    bar.textContent = '';
    if (bar.hidden) return;
    const dueCount = items.filter((x) => x.due).length;
    const dateCount = items.filter((x) => x.kind === 'date').length;
    bar.classList.toggle('is-due', dueCount > 0);
    let open = true;
    try { open = localStorage.getItem(REMIND_OPEN_KEY) !== '0'; } catch (e) { /* 無痕模式 */ }
    bar.classList.toggle('is-closed', !open);

    const toggle = el('button', { className: 'remind-toggle', type: 'button', title: open ? '收起' : '展開' }, [
      el('strong', { textContent: dueCount ? `⏰ 該回撥了（${dueCount}）` : `⏰ 今天要打（${items.length}）` }),
      el('span', { className: 'remind-caret', textContent: open ? '▾' : '▸' }),
    ]);
    toggle.onclick = () => {
      try { localStorage.setItem(REMIND_OPEN_KEY, open ? '0' : '1'); } catch (e) { /* 無痕模式 */ }
      renderRemindBar();
    };
    const head = el('div', { className: 'remind-head' }, [toggle]);
    const tools = el('div', { className: 'remind-tools' });
    if (dateCount) {
      const onlyToday = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '只看今天到期', title: '把名單篩成下次聯絡日是今天的' });
      onlyToday.onclick = () => { applyDueQuick('today'); state.limit = PAGE_SIZE; render(); };
      tools.append(onlyToday);
    }
    if ('Notification' in window && Notification.permission === 'default') {
      const btn = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '開通知', title: '時間到了讓瀏覽器跳通知。網站開著才會提醒；手機請先把網站加到主畫面。' });
      btn.onclick = async () => { try { await Notification.requestPermission(); } catch (e) { /* 使用者拒絕 */ } renderRemindBar(); };
      tools.append(btn);
    }
    head.append(tools);
    bar.append(head);
    if (!open) return;

    const list = el('div', { className: 'remind-list' });
    items.forEach(({ r, kind, due }) => {
      const row = el('div', { className: `remind-row ${due ? 'is-due' : ''} ${kind === 'date' ? 'is-today' : ''}` });
      const time = el('b', { className: 'remind-time', textContent: kind === 'timed' ? whenLabel(r.remindAt) : '今天' });
      const openBtn = el('button', { className: 'remind-open', type: 'button' }, [
        el('span', { className: 'remind-name', textContent: r.company }),
        el('span', { className: 'remind-meta', textContent: [r.remindNote, r.keyman].filter(Boolean).join('　') }),
      ]);
      openBtn.onclick = () => openDetail(r.id);
      const main = el('div', { className: 'remind-main' }, [openBtn]);
      const p = r.phones && r.phones[0];
      if (p) main.append(el('a', { className: 'remind-tel', href: `tel:${p.dial || p.digits}`, textContent: `📞 ${p.display || p.digits}` }));
      const actions = el('div', { className: 'remind-actions' });
      if (kind === 'timed') {
        const done = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '完成', title: '取消這個提醒' });
        done.onclick = () => setReminder(r.id, null);
        const later = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '延 15 分' });
        later.onclick = () => setReminder(r.id, Math.max(Date.now(), r.remindAt) + 15 * 60000, r.remindNote);
        actions.append(done, later);
      }
      row.append(time, main, actions);
      list.append(row);
    });
    bar.append(list);
  }
  /**
   * 「最近核准變更」那一列後面的一句話摘要：查到哪幾種變更、哪些欄位前後值。
   * 完整清單還是在下面的「變更登記」，這裡只求一眼看完。
   */
  function regChangeBrief(r) {
    if (!r.regChange || !r.regKinds || !r.regKinds.length) return '';
    if (r.regKinds[0] === 'none' || r.regKinds[0] === 'unchecked') return '';
    const kinds = r.regKinds.map((k) => REG_KIND_LABEL[k]).join('、');
    const bits = Object.entries(r.regChange.changes || {}).map(([key, ch]) => {
      const label = (REGISTRY_FIELDS.find(([k]) => k === key) || [, key])[1];
      return `${label} ${ch.from || '（空）'} → ${ch.to}`;
    });
    return bits.length ? `查到${kinds}：${bits.join('、')}` : `查到${kinds}`;
  }

  /** 詳細頁的「回撥提醒」區塊 */
  function reminderSection(r) {
    const sec = el('div', { className: 'detail-section remind-section' });
    sec.append(el('h3', { textContent: '回撥提醒' }));
    const now = Date.now();
    if (r.remindAt) {
      const cur = el('p', { className: `rule-verdict ${r.remindAt <= now ? 'is-fail' : 'is-ok'}` }, [
        el('strong', { textContent: `${r.remindAt <= now ? '該回撥了：' : '約 '}${whenLabel(r.remindAt)}${r.remindAt > now ? ' 回撥' : ''}` }),
        r.remindNote ? el('span', { textContent: `　${r.remindNote}` }) : null,
      ].filter(Boolean));
      const cancel = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '完成／取消提醒' });
      cancel.onclick = async () => { await setReminder(r.id, null); openDetail(r.id); toast('已取消提醒'); };
      cur.append(document.createTextNode('　'), cancel);
      sec.append(cur);
    } else {
      sec.append(el('p', { className: 'muted', textContent: '客戶說晚點再打？按一下時間，名單頁最上面會提醒你。' }));
    }
    const note = el('input', { type: 'text', className: 'remind-note', placeholder: '備註（例如：找財務長、老闆 3 點開完會）', value: r.remindNote || '' });
    const quick = el('div', { className: 'card-actions' });
    const at = (ts) => async () => { await setReminder(r.id, ts, note.value.trim()); openDetail(r.id); toast(`已設提醒：${whenLabel(ts)} 回撥 ${r.company}`); };
    [['30 分鐘後', 30], ['1 小時後', 60], ['2 小時後', 120]].forEach(([label, mins]) => {
      const b = el('button', { className: 'btn btn-tiny', type: 'button', textContent: label });
      b.onclick = at(Date.now() + mins * 60000);
      quick.append(b);
    });
    // 今天的整點：過了的就不列（列了也沒意義）
    const today = new Date();
    [9, 10, 11, 13, 14, 15, 16, 17].forEach((h) => {
      const ts = new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, 0, 0, 0).getTime();
      if (ts <= Date.now()) return;
      const b = el('button', { className: 'btn btn-tiny', type: 'button', textContent: `${h}:00` });
      b.onclick = at(ts);
      quick.append(b);
    });
    const custom = el('input', { type: 'datetime-local', className: 'remind-custom' });
    const customBtn = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '自訂時間' });
    customBtn.onclick = async () => {
      const ts = custom.value ? new Date(custom.value).getTime() : NaN;
      if (!ts) { toast('請先選日期時間'); return; }
      /*
       * 撞到國定假日或週末就順延到下一個上班日，時間點（幾點幾分）照留。
       * 連假整串會一起跳過，因為是一天一天往後找的。
       */
      const d = new Date(ts);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const got = window.Holidays ? window.Holidays.nextWorkday(iso) : { iso, moved: false };
      if (!got.moved) { await at(ts)(); return; }
      const [y, m, day] = got.iso.split('-').map(Number);
      const moved = new Date(y, m - 1, day, d.getHours(), d.getMinutes(), 0, 0).getTime();
      await at(moved)();
      toast(`${dateLabel(got.from)} 是${got.reason}，提醒順延到 ${whenLabel(moved)}`);
    };
    sec.append(note, quick, el('div', { className: 'card-actions' }, [custom, customBtn]));
    return sec;
  }

  /** 使用者自己記的狀態會覆蓋 PDF 裡的原始值。 */
  // 每筆客戶最新的一則通話紀錄（依建立時間），跟著資料版本快取
  let lastLogKey = '';
  let lastLogMap = new Map();
  function latestLog(recordId) {
    const key = String(dataVersion);
    if (lastLogKey !== key) {
      lastLogKey = key;
      lastLogMap = new Map();
      state.logs.forEach((l) => {
        const seen = lastLogMap.get(l.recordId);
        if (!seen || (l.createdAt || 0) > (seen.createdAt || 0)) lastLogMap.set(l.recordId, l);
      });
    }
    return lastLogMap.get(recordId) || null;
  }

  function view(record) {
    const mine = state.userStates.get(record.id);
    // 狀態（結果、最近聯絡日）跟通話紀錄是分開存的；狀態若在同步時弄丟了，
    // 紀錄本身通常還在，就從最新一則紀錄把結果與最近聯絡日補回來。
    const lastLog = latestLog(record.id);
    const edits = (mine && mine.edits) || null;
    const base = edits ? { ...record, ...edits } : record;
    // 檔案裡「下次聯絡日」跟「最近聯絡日」填同一天，是使用者的習慣寫法，
    // 意思是那次沒有約下一次；照字面收會讓 19 筆沒約的客戶掛著逾期好幾個月。
    // 只套在檔案帶進來的值，使用者自己在網站上記的下次聯絡日照原樣。
    const fileNext = base.nextDate && base.nextDate === base.lastDate ? null : base.nextDate;
    const out = {
      ...base,
      nextDate: (mine && mine.nextDate) || fileNext,
      lastDate: (mine && mine.lastDate) || (lastLog && lastLog.date) || base.lastDate,
      // 洽談狀態每次都從訪談內容重新判讀，不用匯入時存下來的那份：
      // 判讀規則會改（例如「最上面沒日期＝未撥打」），改了要對已經在名單上的
      // 客戶也生效，不能只對之後匯入的有效。使用者自己記的結果照樣優先。
      outcome: window.Normalize.normalizeOutcome((mine && mine.outcome) || (lastLog && lastLog.outcome) || window.Normalize.guessOutcome(base.notesRaw || '')),
      starred: !!(mine && mine.starred),
      chance: (mine && mine.chance) || '',
      chanceAt: (mine && mine.chanceAt) || 0,
      edited: !!edits,
      group: groupMap().get(record.id) || '',
    };
    // 電話與地址改過就要先重新解析，再去算衍生欄位。
    // 順序不能反過來：服務區域是從地址拆出來的縣市與行政區算的，先算就會拿到
    // 編輯前的舊縣市，改了地址之後篩選與卡片標記都不會跟著動。
    // 電話每次都從原文重新拆：拆法改了（例如備註各歸各的）舊資料才會跟著更新，
    // 不用等重新匯入；名單檔存的 phones 只當原文空白時的備援
    if (String(base.phoneRaw || '').trim()) out.phones = window.Normalize.extractPhones(base.phoneRaw);
    else if (edits && edits.phoneRaw !== undefined) out.phones = [];
    // 登記地址／實際地址：舊資料一格裡寫「104登記：… / 公司登記：…」的在這裡拆開；
    // 實際地址空著就用登記地址。縣市、行政區看實際地址。
    {
      const split = window.Normalize.splitAddress(base.address);
      out.addressRegistered = split.registered;
      out.addressActual = String(base.addressActual || '').trim() || split.actual;
      if (edits && edits.address !== undefined) out.addressRegistered = String(edits.address || '').trim();
      if (edits && edits.addressActual !== undefined) out.addressActual = String(edits.addressActual || '').trim();
      if (!out.addressActual) out.addressActual = out.addressRegistered;
      out.address = out.addressRegistered;
      Object.assign(out, window.Normalize.parseAddressAny(out.addressActual, out.addressRegistered));
    }

    out.scale = capitalScale(out);
    out.territory = territory(out);
    out.relations = window.Normalize.detectRelations(out.notesRaw);
    out.relationKinds = window.Normalize.relationKinds(out.relations);
    // 往來情形看的是「最新一次談話」，在網站上記的通話也算：打完電話聽到
    // 對方說已經解約，這筆就該立刻歸到沒有往來，不用等下次匯入檔案。
    // 關係企業的訪談互通：同組其他家的通話與訪談內容一起看
    const bundle = notesBundle({ ...record, notesRaw: out.notesRaw });
    const allNotes = bundle.text;
    out.dealing = window.Normalize.detectDealing(allNotes);
    out.dealingKind = out.dealing.kind;
    // 有沒有實際拜訪過：跟往來情形一樣，網站上記的通話也算
    out.visit = window.Normalize.detectVisit(allNotes);
    out.visitKind = out.visit.visited ? 'yes' : 'no';
    /*
     * KEYMAN：使用者自己改過的最優先；訪談裡明講「KEYMAN 是 X」次之（比名單檔新）；
     * 再來是名單檔原本的值；都沒有就用訪談稱謂判讀；還是沒有就填負責人。
     */
    {
      const edited = edits && edits.keyman !== undefined ? String(edits.keyman || '').trim() : null;
      const found = window.Normalize.detectKeyman(allNotes);
      const fileValue = String(record.keyman || '').trim();
      if (edited !== null && edited) { out.keyman = edited; out.keymanFrom = 'edit'; }
      else if (found.name && found.reason === '訪談明講') { out.keyman = found.name; out.keymanFrom = 'notes'; }
      else if (fileValue) { out.keyman = fileValue; out.keymanFrom = 'file'; }
      else if (found.name) { out.keyman = found.name; out.keymanFrom = 'notes'; }
      else if (out.owner) { out.keyman = out.owner; out.keymanFrom = 'owner'; }
      else { out.keyman = ''; out.keymanFrom = ''; }
      out.keymanInfo = found;
    }
    // 有沒有統編：欄位裡有數字就算有（編輯過的以編輯後為準）
    out.taxKind = /\d/.test(String(out.taxId || '')) ? 'yes' : 'no';
    out.phoneKind = (out.phones && out.phones.length) ? 'yes' : 'no';
    // 變更登記：最近一次查到異動的種類；查過但從沒異動＝無變更；沒查過＝未查核
    out.regChange = (mine && mine.regChange) || null;
    out.regAt = (mine && mine.regAt) || 0;
    out.regError = (mine && mine.regError) || '';
    // 歸屬分公司：依規範用「公司登記地址」對劃分表；卡片標示與篩選都用這個
    {
      const reg = window.Normalize.parseAddress(out.addressRegistered);
      const b = window.Rules && window.Rules.branchOf ? window.Rules.branchOf(reg.city, reg.district) : { kind: '', label: '' };
      out.branch = b;
      out.branchKey = b.kind === 'branch' ? `${b.branches[0]}分公司`
        : b.kind === 'common' ? `${b.branches.join('／')}共同區`
        : b.kind === 'shared' ? '全公司共同區域'
        : (reg.city ? '不在劃分表上' : '無登記地址');
    }
    out.remindAt = (mine && mine.remindAt) || 0;
    out.remindNote = (mine && mine.remindNote) || '';
    out.regKinds = out.regChange && out.regChange.kinds && out.regChange.kinds.length
      ? out.regChange.kinds
      : (out.regAt && !out.regError ? ['none'] : ['unchecked']);
    /*
     * 禁止推廣獨立於 outcome。
     *
     * outcome 會被之後記的通話紀錄覆蓋，隨便記一通「已聯絡」就會把禁止推廣洗掉，
     * 那位客戶就悄悄回到待打名單裡。所以以訪談內容為準，再把使用者自己選的
     * 「禁止推廣」也算進來——兩邊任一成立就是禁打，只能加不能減。
     */
    out.blockedInfo = window.Normalize.detectBlocked(out.notesRaw);
    out.blocked = out.blockedInfo.blocked || out.outcome === 'blocked';
    return out;
  }

  /*
   * 刪掉單一筆客戶。
   *
   * 原本只能用「管理已匯入名單」整份刪掉，但實際上會遇到的是單筆要移除：
   * 公司倒了、統編重複、或是明確表示不要再打的。為了一筆而整份重匯不合理。
   *
   * 提示裡把會一起消失的東西講清楚（通話紀錄、編輯內容），因為這個動作救不回來。
   */
  function deleteBtn(r) {
    const btn = el('button', { className: 'btn btn-tiny danger', type: 'button', textContent: '刪除這筆' });
    btn.onclick = async () => {
      const logCount = state.logs.filter((l) => l.recordId === r.id).length;
      const extra = [
        logCount ? `${logCount} 則通話紀錄` : '',
        r.edited ? '你改過的欄位內容' : '',
      ].filter(Boolean).join('、');
      const ok = confirm(`確定要從名單刪掉「${r.company}」嗎？\n`
        + (extra ? `\n連同${extra}會一起刪掉。\n` : '')
        + '\n這個動作救不回來，其他裝置同步後也會一起消失。'
        + '\n（之後重新匯入同一份 PDF 的話，這筆會再出現）');
      if (!ok) return;
      await window.Store.deleteRecord(r.id);
      await reload();
      closeOverlays();
      render();
      toast(`已刪除「${r.company}」`);
      scheduleSync();
    };
    return btn;
  }

  /*
   * 檢查公司名稱。
   *
   * 名稱錯就沒辦法拿去比對商工登記——使用者就是卡在這裡。而錯的名稱多半是解析
   * 留下的痕跡：兩家黏在一起、地址或日期溢進來、整段過長。
   *
   * 分成兩堆處理，因為能做的事不一樣：
   *   - 兩家以上都有公司字尾 → 邊界明確，直接拆，第一家當公司名、其餘進別名。
   *   - 其他 → 邊界無從得知（「大同鐵工廠乙建設股份有限公司」要從哪裡切？），
   *     硬拆只會拆錯，列出來讓使用者自己改，並且點一下就能開到那一筆。
   */
  /*
   * 匯入經濟部登記清冊前，先問要留哪些。
   *
   * 使用者實際的篩選習慣是「資本額 6000 萬以下、服務區域內」，所以預設就填好，
   * 但留著可以改——他偶爾也會想看別的區間。畫面即時算出會留下幾筆，
   * 不用先匯進去才知道結果。
   */
  // cities 用函式而不是直接展開：SERVICE_CITIES 宣告在這支檔案的後面，
  // 直接寫 [...SERVICE_CITIES] 會在模組載入時就求值，那時它還沒初始化。
  const GOV_CITY_PRESETS = {
    dual: { label: '只要雙北', cities: () => ['臺北市', '新北市'] },
    service: { label: '整個服務範圍（新竹以北加宜蘭）', cities: () => [...SERVICE_CITIES] },
    all: { label: '不限縣市', cities: () => null },
  };

  function askGovFilter(filename, rows) {
    return new Promise((resolve) => {
      const host = $('#editorBody');
      host.textContent = '';
      host.append(el('h2', { textContent: '匯入經濟部登記清冊' }));
      host.append(el('p', { className: 'muted',
        textContent: `${filename} 共 ${rows.length - 1} 筆。這種清冊一次幾千筆，`
          + '整份匯進來會把名單淹掉，所以先選要留哪些。' }));

      const minIn = el('input', { type: 'number', value: '500', min: '0', step: '100' });
      const maxIn = el('input', { type: 'number', value: '6000', min: '0', step: '100' });
      const citySel = el('select', {}, Object.entries(GOV_CITY_PRESETS)
        .map(([k, v]) => el('option', { value: k, textContent: v.label })));
      const skipHolding = el('input', { type: 'checkbox' });

      host.append(el('label', { className: 'rule-field' }, [
        el('span', { textContent: '資本額下限（萬元）' }), minIn]));
      host.append(el('label', { className: 'rule-field' }, [
        el('span', { textContent: '資本額上限（萬元）' }), maxIn]));
      host.append(el('label', { className: 'rule-field' }, [
        el('span', { textContent: '地區' }), citySel]));
      host.append(el('label', { className: 'rule-field' }, [
        skipHolding, el('span', { textContent: ' 略過投資／控股類（看名字沒有設備標的，通常不值得打）' })]));

      const preview = el('div', { className: 'rule-result' });
      host.append(preview);

      const opts = () => ({
        minCapital: (Number(minIn.value) || 0) * 10000,
        maxCapital: (Number(maxIn.value) || 0) * 10000 || Infinity,
        cities: GOV_CITY_PRESETS[citySel.value].cities(),
      });

      let current = [];
      const recount = () => {
        const out = window.Normalize.fromGovRegistry(rows, opts());
        current = skipHolding.checked ? out.records.filter((r) => r.hasAssets) : out.records;
        preview.textContent = '';
        preview.append(el('p', { className: 'rule-verdict is-ok',
          textContent: `符合條件：${current.length} 筆` }));
        preview.append(el('p', { className: 'rule-note',
          textContent: `（資本額不符 ${out.stats.capitalOut} 筆、地區不符 ${out.stats.cityOut} 筆`
            + `${out.stats.dup ? `、重複 ${out.stats.dup} 筆` : ''}`
            + `${skipHolding.checked ? `、投資控股類 ${out.records.length - current.length} 筆` : ''}）` }));
        // 已經在名單裡的先講，不然匯進去才發現重複
        const known = new Set(state.records.map((r) => (r.taxId || '').replace(/\D/g, '')).filter(Boolean));
        const dup = current.filter((r) => r.taxId && known.has(r.taxId)).length;
        if (dup) {
          preview.append(el('p', { className: 'rule-note',
            textContent: `※ 其中 ${dup} 筆的統編已經在你的名單裡，匯入後會以這份資料更新它們。` }));
        }
        current.slice(0, 5).forEach((r) => {
          preview.append(el('div', { className: 'import-preview' }, [
            el('strong', { textContent: r.company }),
            el('p', { className: 'rule-note',
              textContent: `${r.capitalThousands} 仟元　${r.industry || '產業未知'}　${r.address}` }),
          ]));
        });
        if (current.length > 5) {
          preview.append(el('p', { className: 'rule-note', textContent: `※ 以上只列前 5 筆。` }));
        }
      };
      [minIn, maxIn].forEach((n) => { n.oninput = recount; });
      citySel.onchange = recount;
      skipHolding.onchange = recount;
      recount();

      const go = el('button', { className: 'btn btn-primary', type: 'button', textContent: '匯入' });
      const cancel = el('button', { className: 'btn', type: 'button', textContent: '取消' });
      go.onclick = () => {
        $('#editor').hidden = true;
        resolve(window.Normalize.govToStandardRows(current));
      };
      cancel.onclick = () => { $('#editor').hidden = true; resolve(null); };
      host.insertBefore(el('div', { className: 'card-actions' }, [go, cancel]), preview);

      $('#editor').hidden = false;
    });
  }

  async function reviewCompanyNames() {
    const fixable = [];
    const manual = [];
    state.records.forEach((rec) => {
      const r = view(rec);
      const why = window.Normalize.suspiciousName(r.company);
      if (!why) return;
      const split = window.Normalize.splitGluedName(r.company);
      if (split) fixable.push({ rec, r, why, split });
      else manual.push({ rec, r, why });
    });

    if (!fixable.length && !manual.length) { toast('公司名稱看起來都正常'); return; }

    const host = $('#editorBody');
    host.textContent = '';
    host.append(el('h2', { textContent: '公司名稱檢查' }));
    host.append(el('p', { className: 'muted',
      textContent: `名單共 ${state.records.length} 筆，找到 ${fixable.length + manual.length} 筆名稱看起來有問題。`
        + '名稱不對就沒辦法拿去比對商工登記，所以要先處理這裡。' }));

    if (fixable.length) {
      const sec = el('div', { className: 'detail-section' }, [
        el('h3', { textContent: `可以自動拆開（${fixable.length} 筆）` }),
        el('p', { className: 'muted', textContent: '兩家以上都有公司字尾，邊界很明確。第一家留作公司名，其餘存成別名，搜尋一樣找得到。' }),
      ]);
      fixable.slice(0, 15).forEach(({ r, split }) => {
        sec.append(el('div', { className: 'import-preview' }, [
          el('p', { textContent: `${r.company}` }),
          el('p', { className: 'rule-note', textContent: `→ ${split.company}　＋別名：${split.aliases.join('、')}` }),
        ]));
      });
      if (fixable.length > 15) sec.append(el('p', { className: 'rule-note', textContent: `※ 另外還有 ${fixable.length - 15} 筆，這裡只列前 15 筆。` }));

      const go = el('button', { className: 'btn btn-primary', type: 'button', textContent: `拆開這 ${fixable.length} 筆` });
      go.onclick = async () => {
        go.disabled = true;
        for (const { rec, split } of fixable) {
          const existing = state.userStates.get(rec.id) || {};
          await saveState(rec.id, {
            edits: { ...(existing.edits || {}), company: split.company },
            editsAt: Date.now(),
          });
        }
        await reload();
        closeOverlays();
        render();
        toast(`已拆開 ${fixable.length} 筆公司名稱`);
        scheduleSync();
      };
      sec.append(el('div', { className: 'card-actions' }, [go]));
      host.append(sec);
    }

    if (manual.length) {
      const sec = el('div', { className: 'detail-section' }, [
        el('h3', { textContent: `要自己確認（${manual.length} 筆）` }),
        el('p', { className: 'muted',
          textContent: '這幾筆看得出不對，但正確的斷點無從判斷，自動改只會改錯。點公司名稱可以直接開啟那一筆修改。' }),
      ]);
      manual.slice(0, 40).forEach(({ rec, r, why }) => {
        const link = el('button', { className: 'btn btn-tiny', type: 'button', textContent: r.company || '（空白）' });
        link.onclick = () => { closeOverlays(); openDetail(rec.id); };
        sec.append(el('div', { className: 'import-preview' }, [
          link, el('p', { className: 'rule-note', textContent: why }),
        ]));
      });
      if (manual.length > 40) sec.append(el('p', { className: 'rule-note', textContent: `※ 另外還有 ${manual.length - 40} 筆，這裡只列前 40 筆。` }));
      host.append(sec);
    }

    $('#editor').hidden = false;
  }

  async function saveState(recordId, patch) {
    // updatedAt 要在這裡明確蓋掉：舊狀態本身就帶著上一次的 updatedAt，
    // 展開之後它會蓋過 Store.setState 補的 Date.now()，時間戳永遠停在第一次。
    const merged = { ...(state.userStates.get(recordId) || { recordId }), ...patch, recordId, updatedAt: Date.now() };
    await window.Store.setState(merged);
    state.userStates.set(recordId, merged);
    touch();
    return merged;
  }

  /* ------------------------------------------------------------------
   * 同一老闆的多家公司
   *
   * 業務的客戶常常一個人名下好幾家公司（股份有限公司＋有限公司、母公司＋子公司），
   * 打一通電話談的是整組，但名單上是好幾張卡片。做法：
   *   - 使用者自己把公司連成一組。不猜：曾經拿同負責人、同 KEYMAN 當候選，
   *     結果 KEYMAN 欄位塞著「2023」這種東西，八家毫不相干的公司被列成候選，
   *     使用者說根本是不同負責人。所以視窗就是列出名單內全部企業＋搜尋，自己勾。
   *   - 組別記在每筆的追蹤狀態裡（group + groupAt），跟編輯內容一樣有自己的
   *     時間戳，雲端合併時才不會被一通電話的紀錄洗掉。
   *   - 記通話時可以一次記到整組：每家各寫一則紀錄、各自更新狀態，這樣任何
   *     一家單獨看都是完整的。
   * ------------------------------------------------------------------ */
  /*
   * 每一筆的實際組別。
   *
   * 連結時每家都記 group（組別）與 groupIds（整組成員）。曾經發生 A 連了 B、
   * B 那邊卻沒顯示：B 的組別欄位被別的來源蓋掉了。所以組別不只看自己那份，
   * 別家的成員名單裡有我、而我沒有更新的「解除」紀錄，就一樣算同組——
   * 兩邊互相備援，任何一家還留著就補得回來。
   */
  let groupMapKey = '';
  let groupMapCache = new Map();
  function groupMap() {
    const key = String(dataVersion);
    if (groupMapKey === key) return groupMapCache;
    const exists = (id) => state.records.some((x) => x.id === id);
    const map = new Map();
    state.userStates.forEach((st, id) => { if (st.group && exists(id)) map.set(id, st.group); });
    state.userStates.forEach((st) => {
      if (!st.group || !Array.isArray(st.groupIds)) return;
      st.groupIds.forEach((id) => {
        if (map.has(id) || !exists(id)) return;
        const own = state.userStates.get(id);
        // 自己有比對方更新的「解除連結」紀錄，就尊重解除，不補
        if (own && (own.groupAt || 0) > (st.groupAt || 0)) return;
        map.set(id, st.group);
      });
    });
    groupMapKey = key;
    groupMapCache = map;
    return map;
  }
  function groupMembers(r) {
    if (!r.group) return [];
    const out = [];
    groupMap().forEach((group, id) => { if (group === r.group && id !== r.id) out.push(id); });
    return out.map((id) => view(state.records.find((x) => x.id === id)));
  }

  /*
   * 整組的訪談紀錄。
   *
   * 關係企業是同一個老闆，打一通電話談的是整組，所以訪談紀錄互通：
   * 網站上記的通話（自己的＋同組其他家的，同內容只算一次）與各家名單檔的訪談內容
   * 合成一份，詳細頁的時間軸、往來情形、拜訪、KEYMAN 判讀都看這一份。
   */
  function groupPeerIds(recordId) {
    const map = groupMap();
    const group = map.get(recordId);
    if (!group) return [];
    const out = [];
    map.forEach((g, id) => { if (g === group && id !== recordId) out.push(id); });
    return out;
  }
  function notesBundle(record) {
    const peers = groupPeerIds(record.id);
    const nameOf = (id) => { const x = state.records.find((y) => y.id === id); return x ? x.company : ''; };
    const seen = new Set();
    const logs = [];
    const take = (l, company) => {
      const key = `${l.date}|${l.text || ''}|${l.outcome || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      logs.push({ ...l, company });
    };
    state.logs.filter((l) => l.recordId === record.id).forEach((l) => take(l, ''));
    peers.forEach((id) => state.logs.filter((l) => l.recordId === id).forEach((l) => take(l, nameOf(id))));
    logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const logText = logs.filter((l) => l.text).map((l) => `${(l.date || '').replace(/-/g, '/')} ${l.text}`).join('\n');
    const peerNotes = peers.map((id) => { const x = state.records.find((y) => y.id === id); return x && x.notesRaw ? x.notesRaw : ''; }).filter(Boolean);
    const text = [logText, record.notesRaw || '', ...peerNotes].filter(Boolean).join('\n');
    return { logs, text, peers, nameOf };
  }

  async function setGroup(ids, group) {
    const at = Date.now();
    for (const id of ids) await saveState(id, { group: group || undefined, groupIds: group ? ids : undefined, groupAt: at });
  }

  function openGroupEditor(r) {
    const host = $('#editorBody');
    host.textContent = '';
    host.append(el('h2', { textContent: `連結同一老闆的公司：${r.company}` }));
    host.append(el('p', { className: 'muted',
      textContent: '從名單裡勾選跟這家同一個老闆的公司（可搜尋）。連結後卡片會互相標示，記通話時可以一次記到整組。' }));

    const members = groupMembers(r);
    const picked = new Set(members.map((m) => m.id));
    const chosenBox = el('div', { className: 'chips' });
    const listBox = el('div', { className: 'group-list' });

    const rowFor = (x) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = picked.has(x.id);
      cb.onchange = () => { cb.checked ? picked.add(x.id) : picked.delete(x.id); paintChosen(); };
      const meta = [x.owner && `負責人 ${x.owner}`, x.keyman && `KEYMAN ${x.keyman}`, x.city].filter(Boolean).join('　');
      return el('label', { className: 'group-row' }, [cb,
        el('span', {}, [el('strong', { textContent: x.company }), el('small', { className: 'muted', textContent: meta })])]);
    };
    const paintChosen = () => {
      chosenBox.textContent = '';
      [...picked].forEach((id) => {
        const x = state.records.find((y) => y.id === id);
        if (x) chosenBox.append(el('span', { className: 'chip', textContent: x.company }));
      });
      if (!picked.size) chosenBox.append(el('span', { className: 'muted', textContent: '（還沒選任何公司）' }));
    };
    const paintList = (q) => {
      listBox.textContent = '';
      const terms = q.trim().split(/\s+/).filter(Boolean);
      let shown = 0;
      const show = (x) => { listBox.append(rowFor(x)); shown++; };
      // 已連結的先列，接著是名單內全部企業（照名稱排），有打字就只列符合的
      members.forEach(show);
      const rest = allViews()
        .filter((x) => x.id !== r.id && !picked.has(x.id) && terms.every((t) => x.blob.includes(t)))
        .sort((a, b) => a.company.localeCompare(b.company, 'zh-Hant'));
      rest.forEach(show);
      if (!shown) listBox.append(el('p', { className: 'rule-note', textContent: '找不到符合的公司。' }));
    };
    const search = el('input', { type: 'search', placeholder: '搜尋公司名稱、負責人、統編…' });
    search.style.width = "100%";
    search.oninput = () => paintList(search.value.toLowerCase());

    const save = el('button', { className: 'btn btn-primary', type: 'button', textContent: '儲存連結' });
    const cancel = el('button', { className: 'btn', type: 'button', textContent: '取消' });
    const unlink = el('button', { className: 'btn', type: 'button', textContent: '解除這家的連結' });
    unlink.hidden = !r.group;
    save.onclick = async () => {
      const ids = [r.id, ...picked];
      // 把原本同組但這次沒勾的移出去
      const dropped = members.filter((m) => !picked.has(m.id)).map((m) => m.id);
      if (dropped.length) await setGroup(dropped, '');
      if (picked.size) {
        const group = r.group || `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        await setGroup(ids, group);
      } else if (r.group) {
        await setGroup([r.id], '');
      }
      $('#editor').hidden = true;
      toast(picked.size ? `已連結 ${picked.size + 1} 家公司` : '已解除連結');
      render();
      openDetail(r.id);
      scheduleSync();
    };
    unlink.onclick = async () => {
      const rest = members.map((m) => m.id);
      await setGroup([r.id], '');
      // 其他成員的成員名單也要更新，否則備援機制會把這家補回去
      if (rest.length > 1) await setGroup(rest, r.group); else if (rest.length === 1) await setGroup(rest, '');
      $('#editor').hidden = true;
      toast('已解除連結');
      render();
      openDetail(r.id);
      scheduleSync();
    };
    cancel.onclick = () => { $('#editor').hidden = true; };

    host.append(el('p', { className: 'muted', textContent: '目前選的：' }), chosenBox, search, listBox,
      el('div', { className: 'card-actions' }, [save, unlink, cancel]));
    paintChosen();
    paintList('');
    $('#editor').hidden = false;
    search.focus();
  }

  /*
   * 服務範圍：新竹以北加宜蘭都能服務，其中新北市這九個區是首要目標。
   * 範圍外的客戶依【一般組】行銷規範第(三)項要走協銷，卡片上先標出來，
   * 免得打到一半才發現。
   */
  const PRIORITY_DISTRICTS = new Set(['新莊區', '三重區', '林口區', '泰山區', '五股區',
    '八里區', '淡水區', '蘆洲區', '樹林區']);
  const SERVICE_CITIES = new Set(['臺北市', '新北市', '基隆市', '桃園市',
    '新竹市', '新竹縣', '宜蘭縣']);

  function territory(record) {
    const city = record.city || '';
    if (!city) return '';
    if (city === '新北市' && PRIORITY_DISTRICTS.has(record.district)) return '優先區域';
    return SERVICE_CITIES.has(city) ? '服務範圍' : '範圍外';
  }

  /**
   * 客戶規模看的是「資本總額」（仟元），不是實收資本額——中租的微企／一般組／
   * 大企部是照資本總額分的。名單上的 capital 就是資本總額（查商工登記時，
   * 總額查不到才會拿實收頂著）。見規則頁。
   */
  function capitalScale(record) {
    const value = Number(String(record.capital || '').replace(/[^\d.]/g, ''));
    if (!value) return '';
    const micro = window.Rules ? window.Rules.MICRO_CAPITAL_LIMIT : 5000;
    const large = window.Rules ? window.Rules.LARGE_CAPITAL_LIMIT : 500000;
    // 微企：未達 5,000 仟元（5,000 本身算一般組）
    if (value < micro) return '微企範疇';
    // 大企部：資本額達 500,000 仟元（含）
    if (value >= large) return '大企部範疇';
    return '一般組範疇';
  }
  // 篩選晶片固定由小到大排，最後是沒填的；不跟著筆數浮動，位置才記得住
  const SCALE_ORDER = ['微企範疇', '一般組範疇', '大企部範疇', '未填資本額'];

  /*
   * 每次重繪都把幾百筆資料重新攤平一次，切換分頁與打字才會卡。
   * 這裡把整理好的資料快取起來，只有資料本身或日期變了才重算，
   * 順便把到期分組、客戶規模與搜尋索引一次算完，後面就不必重複計算。
   */
  let dataVersion = 0;
  let viewsKey = '';
  let viewsCache = [];
  const touch = () => { dataVersion += 1; };

  function allViews() {
    const key = `${dataVersion}|${todayISO()}`;
    if (viewsKey === key) return viewsCache;
    const groupCount = new Map();
    groupMap().forEach((group) => groupCount.set(group, (groupCount.get(group) || 0) + 1));
    viewsCache = state.records.map((record) => {
      const v = view(record);
      v.groupSize = v.group ? (groupCount.get(v.group) || 0) : 0;
      v.bucket = dueBucket(v.nextDate);
      v.addedBucket = addedBucket(v.addedDate);
      v.blob = [v.company, v.aliases.join(' '), v.taxId, v.owner, v.keyman, v.industry,
        v.phoneRaw, v.address, v.addressActual, v.notesRaw, v.source].join(' ').toLowerCase();
      return v;
    });
    linkGroupDates(viewsCache);
    viewsKey = key;
    return viewsCache;
  }

  /*
   * 關係企業（手動連結的同老闆公司）的連動：日期、狀態、電話、有沒有機會。
   *
   * 打給老闆談的是整組，但通話可能只記在其中一家。整組以「最近聯絡日最晚的那家」
   * 為準：它的最近聯絡日與下次聯絡日套到每一家；它沒填下次聯絡日就取整組最晚的。
   *
   * 電話與「有沒有機會」也一起共享：同一個老闆，號碼常常只填在其中一家，
   * 談出來的意願也是整個老闆的事，不是某一家公司的事。
   *
   * 只影響顯示、篩選與排序，不改任何一家存起來的資料——解除連結就各自回到原樣。
   */
  function linkGroupDates(views) {
    const byGroup = new Map();
    views.forEach((v) => {
      if (!v.group) return;
      if (!byGroup.has(v.group)) byGroup.set(v.group, []);
      byGroup.get(v.group).push(v);
    });
    byGroup.forEach((members) => {
      if (members.length < 2) return;

      /*
       * 電話共享：自己沒號碼的，借同組有號碼的那家來用。
       *
       * 自己有號碼的一律用自己的——那才是這家公司的總機。借來的會標明來自哪一家，
       * 免得業務打過去說錯公司名。有號碼可打就不算「無電話」，資料完整度那組跟著改，
       * 不然會一直被列進「要補電話」的名單裡，可是根本補不到也不需要補。
       */
      const lender = members.find((m) => m.phones && m.phones.length);
      if (lender) {
        members.forEach((m) => {
          if (m.phones && m.phones.length) return;
          m.phones = lender.phones;
          m.phonesFrom = lender.company;
          m.phoneKind = 'yes';
        });
      }

      /*
       * 有沒有機會共享：整組取最後標的那一次。
       *
       * 老闆說「有意願給資料評估」講的是他自己，不是某一家公司；在哪一家標的
       * 不該影響結果。改過主意的話以最新的為準（chanceAt），跟雲端合併同一套規則。
       */
      const marked = members.filter((m) => m.chance);
      if (marked.length) {
        const lead = marked.reduce((a, b) => ((b.chanceAt || 0) > (a.chanceAt || 0) ? b : a));
        members.forEach((m) => {
          if (m.id === lead.id) return;
          if (m.chance === lead.chance) return;
          m.chance = lead.chance;
          m.chanceFrom = lead.company;
        });
      }
      const lead = members.reduce((a, b) => ((b.lastDate || '') > (a.lastDate || '') ? b : a));
      const lastDate = lead.lastDate || null;
      const nextDate = lead.nextDate || members.map((m) => m.nextDate).filter(Boolean).sort().pop() || null;
      members.forEach((m) => {
        // 撥打狀態也跟著最近聯絡的那家：打給老闆談完，整組都算已聯絡（禁止推廣的那家不動）
        if (lastDate && !m.blocked && m.outcome !== lead.outcome) { m.outcome = lead.outcome; m.groupDatesFrom = lead.company; }
        if ((m.lastDate || null) === lastDate && (m.nextDate || null) === nextDate) return;
        m.groupDatesFrom = lead.company;
        m.lastDate = lastDate;
        m.nextDate = nextDate;
        m.bucket = dueBucket(nextDate);
      });
    });
  }

  /*
   * 名單是什麼時候進來的。
   *
   * 用「離今天多久」而不是列出每一個日期：從 PDF 匯進來的客戶，名單新增日期是
   * 來源檔裡的原始日期，散落好幾年、有上百個不同的值，一個日期一顆按鈕會變成
   * 一面牆。反過來，同一批匯入的會共用同一天，所以「今天」「7 天內」就足以
   * 把剛加進來的那批圈出來。
   *
   * 要精確找某一批的話，「名單來源」那個篩選更直接——匯入時的檔名就是來源。
   */
  function addedBucket(iso) {
    if (!iso) return '未填';
    const diff = -dayDiff(iso);          // dayDiff 是「未來還有幾天」，這裡要反過來
    if (diff < 0) return '未填';         // 日期在未來，多半是解析錯的
    if (diff === 0) return '今天新增';
    if (diff === 1) return '昨天新增';
    if (diff <= 7) return '7 天內';
    if (diff <= 30) return '30 天內';
    if (diff <= 365) return '一年內';
    return '更早';
  }

  const ADDED_ORDER = ['今天新增', '昨天新增', '7 天內', '30 天內', '一年內', '更早', '未填'];

  /*
   * 聯絡時程改成「自選日期區間」。
   *
   * 之前是九顆互相重疊的區間按鈕（今天以前、逾期 1–7 天、逾期 8–30 天……），
   * 使用者用過之後說不合用：他要看的常常是「這週」「下週」「這個月」這種
   * 行事曆上的一段，而不是以今天為原點往前後數幾天。所以改成兩個日期框直接
   * 框「下次聯絡日」，旁邊放幾顆快速鍵把常用的區間一鍵填進去；快速鍵填完
   * 的日期還能再手動微調。
   *
   * 週以星期一為起點、星期日為終點，跟業務的行事曆一致。
   */
  function weekOf(iso, offsetWeeks) {
    const d = new Date(`${iso}T00:00:00`);
    const monday = addDays(iso, -((d.getDay() + 6) % 7) + offsetWeeks * 7);
    return [monday, addDays(monday, 6)];
  }
  function monthOf(iso) {
    const [y, m] = iso.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return [`${iso.slice(0, 7)}-01`, `${iso.slice(0, 7)}-${String(last).padStart(2, '0')}`];
  }
  /** 每顆快速鍵回傳 { from, to } 或 { none: true }；空字串代表不設限。 */
  const DUE_QUICK = [
    ['', '全部', () => ({ from: '', to: '' })],
    ['overdue', '逾期', (t) => ({ from: '', to: addDays(t, -1) })],
    ['today', '今天', (t) => ({ from: t, to: t })],
    ['week', '本週', (t) => { const [a, b] = weekOf(t, 0); return { from: a, to: b }; }],
    ['nextWeek', '下週', (t) => { const [a, b] = weekOf(t, 1); return { from: a, to: b }; }],
    ['month', '本月', (t) => { const [a, b] = monthOf(t); return { from: a, to: b }; }],
    ['none', '未排定', () => ({ none: true })],
  ];

  /** 下次聯絡日落在目前設定的區間內？沒設限就全過。 */
  function matchDue(f, nextDate) {
    if (f.dueNone) return !nextDate;
    if (!f.dueFrom && !f.dueTo) return true;
    if (!nextDate) return false;
    if (f.dueFrom && nextDate < f.dueFrom) return false;
    if (f.dueTo && nextDate > f.dueTo) return false;
    return true;
  }

  function applyDueQuick(key) {
    const quick = DUE_QUICK.find(([k]) => k === key);
    const got = quick ? quick[2](todayISO()) : { from: '', to: '' };
    state.filters.due = key;
    state.filters.dueNone = !!got.none;
    // 區間本身留著：今天、本週、下週這些快速鍵就是換算成一段日期去篩的
    state.filters.dueFrom = got.from || '';
    state.filters.dueTo = got.to || '';
  }

  function dueBucket(iso) {
    if (!iso) return 'none';
    const diff = dayDiff(iso);
    if (diff < 0) return 'overdue';
    if (diff === 0) return 'today';
    if (diff <= 7) return 'week';
    return 'later';
  }

  /* ---------------- 篩選與排序 ---------------- */

  /*
   * 每一組篩選看的是哪個欄位。篩選判斷與晶片上的家數都用這張表，
   * 家數才會跟目前的條件即時連動：每組的數字＝套用「其他所有條件」之後的家數。
   */
  const FACET_VALUE = {
    source: (r) => r.source,
    outcome: (r) => (r.blocked ? 'blocked' : r.outcome),
    city: (r) => r.city || '其他',
    scale: (r) => r.scale || '未填資本額',
    relation: (r) => r.dealingKind,
    visit: (r) => r.visitKind,
    chance: (r) => r.chance || 'none',
    taxKind: (r) => r.taxKind,
    phoneKind: (r) => r.phoneKind,
    regChange: (r) => r.regKinds,   // 一家可能屬多類
    branch: (r) => r.branchKey,
    added: (r) => r.addedBucket,
  };
  const facetHas = (set, value) => (Array.isArray(value) ? value.some((v) => set.has(v)) : set.has(value));
  /** 這筆有沒有通過目前的條件；skip 指定「不算哪一組」，算該組晶片家數時用。 */
  function passesFilters(r, skip, terms) {
    const f = state.filters;
    // 「隱藏禁止推廣」對洽談狀態那組不算：禁打的家數還是要看得到，才知道藏了幾筆
    if (state.hideBlocked && r.blocked && skip !== 'outcome') return false;
    for (const key of Object.keys(FACET_VALUE)) {
      if (key === skip) continue;
      if (f[key].size && !facetHas(f[key], FACET_VALUE[key](r))) return false;
    }
    if (skip !== 'industry' && f.industry && !(r.industry || '').includes(f.industry)) return false;
    if (skip !== 'due' && !matchDue(f, r.nextDate)) return false;
    if (terms && terms.length && !terms.every((t) => r.blob.includes(t))) return false;
    return true;
  }
  const searchTerms = () => { const q = state.search.trim().toLowerCase(); return q ? q.split(/\s+/) : []; };

  function visibleRecords() {
    const terms = searchTerms();
    let list = allViews().filter((r) => passesFilters(r, '', terms));


    const num = (s) => Number(String(s || '').replace(/[^\d]/g, '')) || 0;
    const cmp = {
      next: (a, b) => (a.nextDate || '9999').localeCompare(b.nextDate || '9999'),
      last: (a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''),
      capital: (a, b) => num(b.capital) - num(a.capital),
      // 最近核准變更：新到舊。沒查到日期的排最後（空字串當成最舊，不是最新）
      regchanged: (a, b) => (b.regChanged || '').localeCompare(a.regChanged || ''),
      company: (a, b) => a.company.localeCompare(b.company, 'zh-Hant'),
      territory: (a, b) => {
        const rank = { 優先區域: 0, 服務範圍: 1, '': 2, 範圍外: 3 };
        return (rank[a.territory] ?? 2) - (rank[b.territory] ?? 2)
          || (a.nextDate || '9999').localeCompare(b.nextDate || '9999');
      },
    }[state.sort];
    list.sort((a, b) => cmp(a, b) || a.company.localeCompare(b.company, 'zh-Hant'));
    return list;
  }

  /* ---------------- 畫面 ---------------- */

  let chipsKey = '';

  /** 只更新按鈕的選取狀態，不動 DOM 結構。 */
  function syncChipStates() {
    document.querySelectorAll('#filters .chip[data-filter]').forEach((chip) => {
      const { filter, value } = chip.dataset;
      const on = filter === 'due'
        ? state.filters.due === value
        : state.filters[filter].has(value);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const sel = $('#fltBranch');
    if (sel) sel.value = [...state.filters.branch][0] || '';
    refreshFacetCounts();
    updateFilterCounts();
  }

  /**
   * 晶片上的家數跟著目前的條件即時算。
   * 每一組的數字是「套用其他所有條件」後的家數，自己這組不算進去——
   * 否則點了「無電話」之後「有電話」會變 0，就沒辦法換著看。
   */
  function refreshFacetCounts() {
    const views = allViews();
    const terms = searchTerms();
    const baseFor = (key) => views.filter((r) => passesFilters(r, key, terms));
    Object.keys(FACET_VALUE).forEach((key) => {
      const hosts = document.querySelectorAll(`#filters .chip[data-filter="${key}"]`);
      const sel = key === 'branch' ? $('#fltBranch') : null;
      if (!hosts.length && !sel) return;
      const base = baseFor(key);
      const tally = new Map();
      base.forEach((r) => {
        const v = FACET_VALUE[key](r);
        (Array.isArray(v) ? v : [v]).forEach((x) => tally.set(x, (tally.get(x) || 0) + 1));
      });
      hosts.forEach((chip) => {
        const small = chip.querySelector('small');
        if (small) small.textContent = String(tally.get(chip.dataset.value) || 0);
      });
      if (sel) {
        [...sel.options].forEach((o) => {
          if (o.value) o.textContent = `${o.value}（${tally.get(o.value) || 0}）`;
        });
      }
    });
    // 聯絡時程的快速鍵：各自是一段日期範圍，用同樣的方式算
    const dueBase = baseFor('due');
    const today = todayISO();
    document.querySelectorAll('#filters .chip[data-filter="due"]').forEach((chip) => {
      const quick = DUE_QUICK.find(([k]) => k === chip.dataset.value);
      const small = chip.querySelector('small');
      if (!quick || !chip.dataset.value || !small) return;
      const got = quick[2](today);
      const probe = { dueNone: !!got.none, dueFrom: got.from || '', dueTo: got.to || '' };
      small.textContent = String(dueBase.filter((r) => matchDue(probe, r.nextDate)).length);
    });
  }

  /*
   * 篩選區每一組可收合。手機上一開始只展開聯絡時程、洽談狀態、歸屬分公司、排序，
   * 其他收起來只留標題與「已選幾個」；電腦版側欄有自己的捲軸，預設全部展開。
   * 使用者收合過的記在這台裝置上。
   */
  const GROUPS_KEY = 'filter-groups-open';
  const MOBILE_DEFAULT_OPEN = new Set(['due', 'outcome', 'chance', 'branch', 'sort']);
  function initFilterGroups() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(GROUPS_KEY) || '{}') || {}; } catch (e) { saved = {}; }
    const mobile = window.matchMedia('(max-width: 900px)').matches;
    document.querySelectorAll('#filters .filter-group[data-group]').forEach((g) => {
      const key = g.dataset.group;
      const open = saved[key] !== undefined ? !!saved[key] : (mobile ? MOBILE_DEFAULT_OPEN.has(key) : true);
      g.classList.toggle('is-closed', !open);
      const label = g.querySelector(':scope > label');
      if (!label) return;
      label.onclick = () => {
        const closed = g.classList.toggle('is-closed');
        saved[key] = !closed;
        try { localStorage.setItem(GROUPS_KEY, JSON.stringify(saved)); } catch (e) { /* 無痕模式 */ }
      };
    });
  }
  /** 每一組標題後面標「已選幾個」，收起來也看得到有沒有篩選在作用。 */
  function updateFilterCounts() {
    document.querySelectorAll('#filters .filter-group[data-group]').forEach((g) => {
      let n = g.querySelectorAll('.chip[aria-pressed="true"]').length;
      const key = g.dataset.group;
      if (key === 'due') n = (state.filters.due || state.filters.dueFrom || state.filters.dueTo || state.filters.dueNone) ? 1 : 0;
      if (key === 'industry') n = state.filters.industry ? 1 : 0;
      if (key === 'branch') n = state.filters.branch.size;
      if (key === 'sort') n = 0;
      const label = g.querySelector(':scope > label');
      let pill = label && label.querySelector('.filter-count');
      if (!n) { if (pill) pill.remove(); return; }
      if (!pill) { pill = el('span', { className: 'filter-count' }); label.append(pill); }
      pill.textContent = String(n);
    });
  }

  function renderFilters() {
    // 篩選選項的內容只跟資料有關，跟搜尋字串或目前選了什麼無關，
    // 所以資料沒變就不要重建幾十顆按鈕——那是打字會頓的主因之一。
    const key = String(dataVersion);
    if (chipsKey === key) { syncChipStates(); return; }
    chipsKey = key;

    const all = allViews();
    const tally = (pick) => {
      const m = new Map();
      all.forEach((r) => {
        const v = pick(r);
        m.set(v, (m.get(v) || 0) + 1);
      });
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };

    /*
     * 這幾組改成單選：同一組裡選兩顆等於沒篩（「有拜訪＋無拜訪」就是全部），
     * 看起來卻像有在篩，很容易誤會名單為什麼是這些。按已經選的那顆＝取消。
     * 縣市、客戶規模、洽談狀態、變更登記維持複選——那幾組疊起來是有意義的
     * （台北＋新北、微企＋一般組、增資＋減資）。
     */
    const SINGLE_PICK = new Set(['taxKind', 'phoneKind', 'visit', 'relation', 'chance', 'added']);
    const chips = (host, filter, items, setRef, labelOf) => {
      host.textContent = '';
      items.forEach(([value, count]) => {
        const btn = el('button', { className: 'chip', type: 'button' });
        btn.dataset.filter = filter;
        btn.dataset.value = value;
        btn.append(el('small', { textContent: String(count) }),
          document.createTextNode(' ' + (labelOf ? labelOf(value) : value)));
        btn.onclick = () => {
          const on = setRef.has(value);
          if (SINGLE_PICK.has(filter)) setRef.clear();
          if (on) setRef.delete(value); else setRef.add(value);
          state.limit = PAGE_SIZE;
          render();
        };
        host.append(btn);
      });
    };

    const dueHost = $('#fltDue');
    dueHost.textContent = '';
    const today = todayISO();
    DUE_QUICK.forEach(([value, label, rangeOf]) => {
      const btn = el('button', { className: 'chip', type: 'button' });
      btn.dataset.filter = 'due';
      btn.dataset.value = value;
      // 每顆都標筆數。沒有數字就看不出哪一段積最多，也就無從決定今天先處理哪一堆
      if (value) {
        const got = rangeOf(today);
        const probe = { dueNone: !!got.none, dueFrom: got.from || '', dueTo: got.to || '' };
        const n = all.filter((r) => matchDue(probe, r.nextDate)).length;
        btn.append(el('small', { textContent: String(n) }), document.createTextNode(' ' + label));
      } else {
        btn.textContent = label;
      }
      btn.onclick = () => { applyDueQuick(value); state.limit = PAGE_SIZE; render(); };
      dueHost.append(btn);
    });

    chips($('#fltSource'), 'source', tally((r) => r.source), state.filters.source, (v) => v.replace(/\.pdf$/i, ''));
    // 禁打以 blocked 為準：outcome 可能已經被後來的通話紀錄蓋掉了
    // 順序固定、每一種都顯示（含 0 筆），「未撥打」才不會因為暫時沒有而消失
    const outcomeTally = new Map(tally((r) => (r.blocked ? 'blocked' : r.outcome)));
    chips($('#fltOutcome'), 'outcome', Object.keys(OUTCOME_LABEL).map((k) => [k, outcomeTally.get(k) || 0]),
      state.filters.outcome, (v) => OUTCOME_LABEL[v] || v);
    chips($('#fltCity'), 'city', tally((r) => r.city || '其他').slice(0, 12), state.filters.city);
    const scaleCounts = new Map(SCALE_ORDER.map((k) => [k, 0]));
    all.forEach((r) => { const k = r.scale || '未填資本額'; scaleCounts.set(k, (scaleCounts.get(k) || 0) + 1); });
    chips($('#fltScale'), 'scale', SCALE_ORDER.map((k) => [k, scaleCounts.get(k)]), state.filters.scale);

    // 二分法，順序固定成「有往來 → 沒往來」，不跟著筆數浮動
    const dealCounts = [['active', 0], ['none', 0]];
    all.forEach((r) => { dealCounts[r.dealingKind === 'active' ? 0 : 1][1] += 1; });
    chips($('#fltRelation'), 'relation', dealCounts.filter(([, n]) => n > 0),
      state.filters.relation, (v) => window.Normalize.DEALING_LABEL[v]);

    // 拜訪：固定「有拜訪 → 無拜訪」兩顆，含 0 筆
    const visitCounts = [['yes', 0], ['no', 0]];
    all.forEach((r) => { visitCounts[r.visitKind === 'yes' ? 0 : 1][1] += 1; });
    chips($('#fltVisit'), 'visit', visitCounts, state.filters.visit, (v) => window.Normalize.VISIT_LABEL[v]);

    // 有沒有機會：固定「有機會 → 無機會 → 未判斷」，含 0 筆
    const chanceCounts = new Map(CHANCE_ORDER.map((k) => [k, 0]));
    all.forEach((r) => { const k = r.chance || 'none'; chanceCounts.set(k, (chanceCounts.get(k) || 0) + 1); });
    chips($('#fltChance'), 'chance', CHANCE_ORDER.map((k) => [k, chanceCounts.get(k)]), state.filters.chance, (v) => CHANCE_LABEL[v]);

    // 統編：固定「有統編 → 無統編」兩顆，含 0 筆
    const taxCounts = [['yes', 0], ['no', 0]];
    all.forEach((r) => { taxCounts[r.taxKind === 'yes' ? 0 : 1][1] += 1; });
    chips($('#fltTax'), 'taxKind', taxCounts, state.filters.taxKind, (v) => TAX_LABEL[v]);
    // 電話：同一組「資料完整度」的第二排；統編與電話是兩個條件，可以疊加（有統編＋無電話）
    const phoneCounts = [['yes', 0], ['no', 0]];
    all.forEach((r) => { phoneCounts[r.phoneKind === 'yes' ? 0 : 1][1] += 1; });
    chips($('#fltPhone'), 'phoneKind', phoneCounts, state.filters.phoneKind, (v) => PHONE_LABEL[v]);

    // 變更登記：固定順序含 0 筆；一家可能同時算在好幾顆裡，所以總和可以超過名單筆數
    const regCounts = new Map(REG_KIND_ORDER.map((k) => [k, 0]));
    all.forEach((r) => { r.regKinds.forEach((k) => regCounts.set(k, (regCounts.get(k) || 0) + 1)); });
    chips($('#fltRegChange'), 'regChange', REG_KIND_ORDER.map((k) => [k, regCounts.get(k)]), state.filters.regChange, (v) => REG_KIND_LABEL[v]);

    // 歸屬分公司：下拉選單，依筆數排，自己分公司的通常最多、排最前面
    {
      const sel = $('#fltBranch');
      sel.textContent = '';
      sel.append(el('option', { value: '', textContent: '全部' }));
      tally((r) => r.branchKey).forEach(([key, n]) => sel.append(el('option', { value: key, textContent: `${key}（${n}）` })));
      sel.onchange = () => {
        state.filters.branch.clear();
        if (sel.value) state.filters.branch.add(sel.value);
        state.limit = PAGE_SIZE;
        render();
      };
    }

    // 順序固定成由新到舊，不依筆數排——「今天新增」永遠在第一個位置才好按
    const addedCounts = new Map(ADDED_ORDER.map((k) => [k, 0]));
    all.forEach((r) => { addedCounts.set(r.addedBucket, (addedCounts.get(r.addedBucket) || 0) + 1); });
    // 每一段固定都顯示（含 0 筆）：今天、昨天沒新名單時按鈕消失，看起來像功能壞了
    chips($('#fltAdded'), 'added', ADDED_ORDER.map((k) => [k, addedCounts.get(k)]), state.filters.added);

    const industries = [...new Set(all.map((r) => r.industry).filter(Boolean))].sort();
    $('#industryList').textContent = '';
    industries.forEach((i) => $('#industryList').append(el('option', { value: i })));
    syncChipStates();
  }

  function outcomeBadge(r) {
    // 禁打另外有專屬的紅色標記，這裡再畫一次會變成同一句話出現兩遍
    if (r.blocked) return '';
    return el('span', {
      className: `badge out-${r.outcome}`,
      textContent: OUTCOME_LABEL[r.outcome] || r.outcome,
    });
  }

  /**
   * 把文字複製到剪貼簿。navigator.clipboard 需要安全來源，
   * 以 file:// 開啟或舊瀏覽器會沒有，所以留一個備援。
   */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const box = el('textarea', { value: text });
      box.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.append(box);
      box.select();
      const ok = document.execCommand('copy');
      box.remove();
      return ok;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  /** 一支電話 = 撥號連結 + 複製鈕。複製的是純數字，貼到撥號鍵盤直接可用。 */
  function telGroup(p) {
    const digits = String(p.dial || '').split(',')[0];
    const ext = String(p.dial || '').split(',')[1] || '';

    const link = el('a', { className: 'tel', href: `tel:${p.dial}` });
    link.append(document.createTextNode(`📞 ${p.display}${p.note ? ` · ${p.note}` : ''}`));
    link.onclick = (e) => e.stopPropagation();

    const copy = el('button', {
      className: 'tel-copy', type: 'button',
      title: `複製 ${digits}`, 'aria-label': `複製電話 ${digits}`, textContent: '複製',
    });
    copy.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ok = await copyText(digits);
      toast(ok
        ? `已複製 ${digits}${ext ? `（分機 ${ext}）` : ''}`
        : '複製失敗，請手動選取號碼');
    };

    return el('span', { className: 'tel-group' }, [link, copy]);
  }

  function telLinks(r, limit) {
    return (limit ? r.phones.slice(0, limit) : r.phones).map(telGroup);
  }

  function card(r) {
    const bucket = r.bucket || dueBucket(r.nextDate);
    const node = el('article', {
      className: `card${bucket === 'today' ? ' is-due' : ''}${bucket === 'overdue' ? ' is-overdue' : ''}`,
      tabIndex: 0,
    });
    const top = el('div', { className: 'card-top' }, [
      el('span', { className: 'card-name', textContent: r.company }),
      outcomeBadge(r),
      r.chance === 'yes' ? el('span', { className: 'badge badge-chance-yes', textContent: '有機會' }) : '',
      r.chance === 'no' ? el('span', { className: 'badge badge-chance-no', textContent: '無機會' }) : '',
      (r.scale || capitalScale(r)) === '微企範疇' ? el('span', { className: 'badge badge-micro', textContent: '微企範疇' }) : '',
      (r.scale || capitalScale(r)) === '大企部範疇' ? el('span', { className: 'badge badge-large', textContent: '大企部範疇' }) : '',
      r.regChange && r.regKinds[0] !== 'none' && r.regKinds[0] !== 'unchecked'
        ? el('span', { className: 'badge badge-regchange', textContent: r.regKinds.map((k) => REG_KIND_LABEL[k]).join('、') }) : '',
      r.branch && r.branch.kind === 'branch' ? el('span', { className: 'badge badge-branch', textContent: r.branchKey, title: r.branch.label }) : '',
      r.branch && r.branch.kind === 'common' ? el('span', { className: 'badge badge-branch badge-branch-common', textContent: r.branchKey, title: r.branch.label }) : '',
      r.branch && r.branch.kind === 'shared' ? el('span', { className: 'badge badge-branch badge-branch-common', textContent: '全公司共同區域' }) : '',
      r.territory === '優先區域' ? el('span', { className: 'badge badge-priority', textContent: '優先區域' }) : '',
      r.territory === '範圍外' ? el('span', { className: 'badge badge-outside', textContent: '範圍外·需協銷' }) : '',
      r.blocked ? el('span', { className: 'badge badge-blocked', textContent: '禁止推廣' }) : '',
      r.remindAt ? el('span', { className: `badge badge-remind ${r.remindAt <= Date.now() ? 'is-due' : ''}`, textContent: `⏰ ${whenLabel(r.remindAt)} 回撥` }) : '',
      r.dealingKind === 'active' ? el('span', { className: 'badge badge-dealing', textContent: '中租往來' }) : '',
      r.visitKind === 'yes' ? el('span', { className: 'badge badge-visited', textContent: '已拜訪' }) : '',
      r.groupSize > 1 ? el('span', { className: 'badge badge-group', textContent: `同老闆 ${r.groupSize} 家` }) : '',
    ].filter(Boolean));
    node.append(top);

    const meta = el('div', { className: 'card-meta' });
    const bits = [
      r.industry && `🏷 ${r.industry}`,
      (r.keyman || r.owner) && `👤 ${r.keyman || r.owner}`,
      (r.city || r.address) && `📍 ${r.city}${r.district}`,
      r.capital && `💰 ${r.capital} 仟元`,
      r.nextDate && `📅 下次 ${dateLabel(r.nextDate)}${bucket === 'overdue' ? `（逾期 ${-dayDiff(r.nextDate)} 天）` : ''}`,
      r.lastDate && `🕘 最近 ${dateLabel(r.lastDate)}`,
      `📄 ${r.source.replace(/\.pdf$/i, '')}`,
    ].filter(Boolean);
    bits.forEach((b) => meta.append(el('span', { textContent: b })));
    node.append(meta);

    /*
     * 卡片上那一句要是「最新的談話內容」，不管它是檔案帶進來的還是在網站上記的。
     * 之前只看檔案的訪談內容，在網站上打完電話記的那則永遠上不了卡片，
     * 使用者看到的一直是匯入時的舊話。兩邊各取最新的一則比日期，同一天算
     * 網站上記的比較新（它是匯入之後才寫的）。
     */
    const fromFile = (r.timeline || [])[0];
    const mine = notesBundle(r).logs[0];
    let latest = fromFile;
    if (mine && (!fromFile || !fromFile.date || (mine.date || '') >= fromFile.date)) {
      latest = { text: mine.text || `（${window.Normalize.outcomeLabel(mine.outcome)}）` };
    }
    if (latest) node.append(el('p', { className: 'card-notes', textContent: latest.text }));
    if (r.phones.length) {
      const actions = el('div', { className: 'card-actions' });
      telLinks(r, 2).forEach((a) => actions.append(a));
      node.append(actions);
    }

    node.onclick = () => openDetail(r.id);
    node.onkeydown = (e) => { if (e.key === 'Enter') openDetail(r.id); };
    return node;
  }

  let listKey = '';

  function renderList() {
    // 條件沒變就不用重建幾百個節點（例如從統計切回來時）。
    // 篩選條件用走訪的方式組 key，以後新增篩選才不會忘了加進來而讓畫面不更新。
    const filterKey = Object.entries(state.filters)
      .map(([name, value]) => `${name}:${value instanceof Set ? [...value].sort().join(',') : value}`)
      .join('|');
    const key = [dataVersion, state.tab, state.search, state.sort,
      state.limit, state.hideBlocked, filterKey].join('|');
    if (listKey === key) return;
    listKey = key;

    const list = visibleRecords();
    const host = $('#cards');
    host.textContent = '';
    list.slice(0, state.limit).forEach((r) => host.append(card(r)));

    $('#listSummary').textContent = `顯示 ${Math.min(state.limit, list.length)} / ${list.length} 筆`;
    $('#btnMore').hidden = list.length <= state.limit;
    const empty = $('#emptyState');
    if (list.length) {
      empty.hidden = true;
    } else {
      empty.hidden = false;
      empty.textContent = '';
      if (!state.records.length) {
        empty.append(
          el('strong', { textContent: '還沒有名單' }),
          el('p', { textContent: '按右上角「匯入 PDF」，選擇雲端硬碟裡的電話推廣名單 PDF。' })
        );
      } else {
        empty.append(
          el('strong', { textContent: '沒有符合條件的客戶' }),
          el('p', { textContent: '試著放寬篩選條件或清除搜尋。' })
        );
      }
    }
  }

  function bar(label, value, max) {
    return el('div', { className: 'bar' }, [
      el('span', { textContent: label }),
      el('i', { style: `width:${max ? Math.max(2, (value / max) * 100) : 0}%` }),
      el('u', { textContent: String(value) }),
    ]);
  }

  function renderStats() {
    const all = allViews();
    const host = $('#paneStats');
    host.textContent = '';
    if (!all.length) {
      host.append(el('div', { className: 'empty' }, [el('strong', { textContent: '匯入名單後就會有統計' })]));
      return;
    }

    const buckets = all.reduce((acc, r) => {
      acc[r.bucket] = (acc[r.bucket] || 0) + 1;
      return acc;
    }, {});
    const cards = [
      ['名單總數', all.length],
      ['逾期未聯絡', buckets.overdue || 0],
      ['今日到期', buckets.today || 0],
      ['一週內', buckets.week || 0],
      ['本機通話紀錄', state.logs.length],
    ];
    const row = el('div', { className: 'stat-row' });
    cards.forEach(([label, value]) => row.append(
      el('div', { className: 'stat' }, [el('b', { textContent: String(value) }), el('span', { textContent: label })])
    ));
    host.append(row);

    const group = (key) => {
      const m = new Map();
      all.forEach((r) => {
        const v = key(r) || '未填';
        m.set(v, (m.get(v) || 0) + 1);
      });
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const section = (title, entries, labelOf) => {
      const max = Math.max(...entries.map((e) => e[1]), 1);
      const box = el('div', { className: 'bars' }, [el('h3', { textContent: title })]);
      entries.slice(0, 12).forEach(([k, v]) => box.append(bar(labelOf ? labelOf(k) : k, v, max)));
      host.append(box);
    };
    section('洽談狀態', group((r) => r.outcome), (k) => OUTCOME_LABEL[k] || k);
    section('名單來源', group((r) => r.source), (k) => k.replace(/\.pdf$/i, ''));
    section('縣市 Top 12', group((r) => r.city));
    section('產業別 Top 12', group((r) => r.industry));
  }

  let statsKey = '';
  let rulesRendered = false;

  /** 規則頁不依賴名單資料，建一次就好。 */
  function buildRules() {
    if (rulesRendered) return;
    window.Rules.render($('#paneRules'));
    rulesRendered = true;
  }

  /**
   * 規則頁有三組表單與多張表格，第一次建構要花掉幾百毫秒。
   * 趁使用者還在看名單的空檔先做好，點過去的時候就不會等。
   */
  function prebuildRules() {
    const run = () => { try { buildRules(); } catch (err) { console.error(err); } };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 3000 });
    else setTimeout(run, 800);
  }

  function render() {
    const total = state.records.length;
    $('#countAll').textContent = String(total);
    const sources = new Set(state.records.map((r) => r.source));
    $('#brandSub').textContent = total
      ? `${total} 筆客戶 · ${sources.size} 份名單`
      : '尚未匯入名單';

    const tab = state.tab;
    $('#paneList').hidden = tab !== 'all';
    $('#paneStats').hidden = tab !== 'stats';
    $('#paneRules').hidden = tab !== 'rules';
    // 統計與規則頁用不到左側篩選，讓內容佔滿整個寬度
    const wide = tab === 'stats' || tab === 'rules';
    document.querySelector('.layout').classList.toggle('is-wide', wide);
    $('#filters').hidden = wide;
    $('#btnFilters').hidden = wide;
    renderFilters();
    if (tab === 'stats') {
      // 統計只跟資料有關，資料沒變就不用重畫幾十根長條
      if (statsKey !== String(dataVersion)) { renderStats(); statsKey = String(dataVersion); }
    } else if (tab === 'rules') {
      buildRules();
    } else { renderList(); renderRemindBar(); }
  }

  /* ---------------- 詳細資料抽屜 ---------------- */

  function openDetail(id) {
    const raw = state.records.find((r) => r.id === id);
    if (!raw) return;
    // 用 allViews 的版本：關係企業連動後的日期在那裡
    const r = allViews().find((x) => x.id === id) || view(raw);
    // 組別是靠別家備援補回來的，就順手寫回自己這筆，之後不用再靠別人
    {
      const mine = state.userStates.get(id);
      if (r.group && (!mine || mine.group !== r.group)) {
        const ids = [id, ...groupMembers(r).map((m) => m.id)];
        saveState(id, { group: r.group, groupIds: ids, groupAt: Date.now() }).then(() => scheduleSync()).catch(() => {});
      }
    }
    const body = $('#drawerBody');
    body.textContent = '';

    const editBtn = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '編輯資料' });
    editBtn.onclick = () => openEditor(r.id);
    const dealBtn = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '承作檢核' });
    dealBtn.onclick = () => openDealCheck(r.id);
    // 公司名稱旁一顆複製：查商工登記、找 104、貼進系統都要打公司名，打字容易錯
    const copyName = el('button', { className: 'btn btn-tiny copy-name', type: 'button', textContent: '複製', title: `複製 ${r.company}` });
    copyName.onclick = async () => {
      const ok = await copyText(r.company);
      toast(ok ? `已複製：${r.company}` : '這個瀏覽器不讓網頁複製，請長按公司名稱手動複製');
    };
    /*
     * 有機會／無機會：再按一次同一顆就取消，回到「未判斷」。
     * 判斷會變（今天說要資料、下週說不用了），沒有取消的路就只能在兩個錯的之間選。
     */
    const chanceBtn = (value) => {
      // 亮不亮看自己這家標了沒：跟著同老闆帶過來的值不算自己標的，按了才是
      const own = r.chanceFrom ? '' : r.chance;
      const on = own === value;
      const b = el('button', {
        className: `btn btn-tiny chance-btn${on ? ` is-on chance-${value}` : ''}`,
        type: 'button',
        textContent: CHANCE_LABEL[value],
        title: on ? `再按一次取消，回到未判斷` : `標記為${CHANCE_LABEL[value]}`,
      });
      b.onclick = async () => {
        await saveState(r.id, { chance: on ? '' : value, chanceAt: Date.now() });
        scheduleSync();
        render();
        openDetail(r.id);
        toast(on ? '已取消，回到未判斷' : `已標記為${CHANCE_LABEL[value]}`);
      };
      return b;
    };
    body.append(el('div', { className: 'detail-head' }, [
      el('div', { className: 'detail-title' }, [el('h2', { textContent: r.company }), copyName]),
      r.aliases.length ? el('p', { className: 'detail-alias', textContent: `關係企業：${r.aliases.join('、')}` }) : '',
      el('div', { className: 'detail-badges' }, [
        outcomeBadge(r),
        r.edited ? el('span', { className: 'badge badge-edited', textContent: '已修改' }) : '',
        chanceBtn('yes'),
        chanceBtn('no'),
        editBtn,
        dealBtn,
        deleteBtn(r),
      ].filter(Boolean)),
      r.chanceFrom ? el('p', { className: 'muted', textContent: `${r.chance === 'yes' ? '有機會' : '無機會'} 是跟著同老闆的「${r.chanceFrom}」，整組一起算。在這裡按也可以，會以最後按的為準。` }) : '',
    ].filter(Boolean)));

    /*
     * 禁打的警告放在最上面、電話的上面。
     *
     * 放下面沒有用：撥號鍵就在上面，看到電話就會直接按下去。
     */
    if (r.blocked) {
      const warn = el('div', { className: 'blocked-warning' }, [
        el('strong', { textContent: '⛔ 禁止推廣 — 請勿撥打' }),
      ]);
      if (r.blockedInfo.snippet) {
        warn.append(el('p', { textContent: `訪談內容：「${r.blockedInfo.snippet}」` }));
      } else {
        warn.append(el('p', { textContent: '這筆是在通話結果裡被標記為禁止推廣的。' }));
      }
      body.append(warn);
    }

    if (r.phones.length) {
      const box = el('div', { className: 'card-actions' });
      telLinks(r).forEach((a) => box.append(a));
      body.append(box);
      // 借來的號碼要標明是哪一家的，不然打過去會說錯公司名
      if (r.phonesFrom) {
        body.append(el('p', { className: 'muted', textContent: `這家自己沒有電話，上面的號碼是同老闆的「${r.phonesFrom}」的。` }));
      }
    } else if (r.phoneRaw) {
      body.append(el('p', { className: 'muted', textContent: `電話：${r.phoneRaw}` }));
    }

    // 同一老闆的公司
    const members = groupMembers(r);
    {
      const sec = el('div', { className: 'detail-section group-section' });
      const head = el('div', { className: 'group-head' }, [el('h3', { textContent: `同一老闆的公司${members.length ? `（${members.length + 1} 家）` : ''}` })]);
      const linkBtn = el('button', { className: 'btn btn-tiny', type: 'button', textContent: members.length ? '修改連結' : '連結其他公司' });
      linkBtn.onclick = () => openGroupEditor(r);
      head.append(linkBtn);
      sec.append(head);
      if (members.length) {
        const ul = el('ul', { className: 'group-members' });
        members.forEach((m) => {
          const a = el('a', { href: '#', textContent: m.company });
          a.onclick = (e) => { e.preventDefault(); openDetail(m.id); };
          const bits = [m.nextDate && `下次 ${dateLabel(m.nextDate)}`, window.Normalize.outcomeLabel(m.outcome)].filter(Boolean).join('　');
          ul.append(el('li', {}, [a, el('small', { className: 'muted', textContent: bits ? `　${bits}` : '' })]));
        });
        sec.append(ul);
      } else {
        sec.append(el('p', { className: 'muted', textContent: '這家還沒連結其他公司。' }));
      }
      body.append(sec);
    }

    const dl = el('dl', { className: 'detail-grid' });
    const rows = [
      ['統一編號', r.taxId], ['負責人', r.owner],
      ['KEYMAN', r.keyman ? `${r.keyman}${r.keymanFrom === 'notes' ? `　（${r.keymanInfo.reason}：「${r.keymanInfo.snippet}」）` : r.keymanFrom === 'owner' ? '　（訪談看不出 KEYMAN，先填負責人）' : ''}` : ''],
      ['產業別', r.industry], ['成立年', r.founded],
      ['資本總額', r.capital ? `${r.capital} 仟元${capitalScale(r) ? `（${capitalScale(r)}）` : ''}` : ''],
      ['實收資本額', r.capitalPaid ? `${r.capitalPaid} 仟元` : ''],
      /*
       * 這一列一律顯示，即使登記上沒有變更紀錄（那種會是「1911年0月0日」，
       * 跟自己去查登記看到的一樣）。整列藏起來的話，看到的人只會以為是網站漏掉了。
       *
       * 日期後面接上「查到什麼」：只有一個日期，看的人還是得往下捲到變更登記
       * 才知道公司到底動了什麼。用「查到」而不是直接寫在日期上，是因為那個日期
       * 是政府登記的核准日，跟網站查到差異的那天未必是同一天。
       */
      ['最近核准變更', [
        r.regChanged || (r.regAt ? '—' : '—　還沒查過商工登記'),
        regChangeBrief(r),
      ].filter(Boolean).join('　')],
      ['下次聯絡', r.nextDate ? dateLabel(r.nextDate) : ''],
      ['最近聯絡', r.lastDate ? dateLabel(r.lastDate) : ''],
      ['名單新增', r.addedDate ? dateLabel(r.addedDate) : ''],
    ];
    rows.forEach(([k, v]) => {
      if (!v) return;
      dl.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
    });
    // 行銷區域：依規範用「公司登記地址」判，跟服務區域（看實際地址）分開
    {
      const reg = window.Normalize.parseAddress(r.addressRegistered);
      const b = window.Rules && window.Rules.branchOf ? window.Rules.branchOf(reg.city, reg.district) : null;
      if (b && b.label) {
        dl.append(el('dt', { textContent: '行銷區域' }),
          el('dd', { textContent: b.label, className: b.kind === 'common' ? 'branch-common' : '' }));
      } else if (reg.city) {
        dl.append(el('dt', { textContent: '行銷區域' }),
          el('dd', { className: 'muted', textContent: `${reg.city}${reg.district} 不在劃分表上（登記地址）` }));
      }
    }
    if (r.territory) {
      dl.append(el('dt', { textContent: '服務區域' }),
        el('dd', { textContent: r.territory === '範圍外'
          ? '範圍外——依【一般組】行銷規範第(三)項應採協銷辦理'
          : r.territory }));
    }
    const addrRow = (label, value, note) => {
      if (!value) return;
      dl.append(el('dt', { textContent: label }));
      const dd = el('dd');
      dd.append(el('a', {
        href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}`,
        target: '_blank', rel: 'noopener', textContent: value,
      }));
      if (note) dd.append(el('span', { className: 'muted', textContent: `　${note}` }));
      dl.append(dd);
    };
    addrRow('登記地址', r.addressRegistered);
    addrRow('實際地址', r.addressActual);
    // 變更登記：查核結果與異動明細
    {
      dl.append(el('dt', { textContent: '變更登記' }));
      const dd = el('dd');
      if (r.regChange) {
        dd.append(document.createTextNode(`${r.regKinds.map((k) => REG_KIND_LABEL[k]).join('、')}（${dateLabel(r.regChange.date)} 查到，已套用）`));
        Object.entries(r.regChange.changes || {}).forEach(([key, ch]) => {
          const label = (REGISTRY_FIELDS.find(([k]) => k === key) || [, key])[1];
          dd.append(el('div', { className: 'muted', textContent: `${label}：${ch.from || '（空）'} → ${ch.to}` }));
        });
      } else {
        if (r.regError) {
          dd.append(document.createTextNode('未查核：查不到'));
          dd.append(el('div', { className: 'muted', textContent: `商工登記查不到這家（${r.regError}）。統編或公司名稱跟登記不一樣就會查不到，改對之後明天自動更新會再查，或用選單「從商工登記更新公司資料」馬上查。` }));
        } else if (r.regAt) {
          dd.append(document.createTextNode('無變更'));
        } else {
          dd.append(document.createTextNode('未查核'));
          dd.append(el('div', { className: 'muted', textContent: '還沒查過商工登記：跨過 0:00 會自動查一次全部名單，之後新增的客戶要等明天，或用選單「從商工登記更新公司資料」馬上查。' }));
        }
      }
      /*
       * 兩個日期常常不一樣，被問過「是不是沒同步更新」：異動日是最後一次真的有變動
       * 的那天（那天就套用進名單了），查核日是最後一次去對登記的那天。後者比較新
       * 就等於「後來再查過，沒有新的變動」，講白比較不會被誤會。
       */
      if (r.regAt) {
        const checkedOn = new Date(r.regAt).toISOString().slice(0, 10);
        const stale = r.regChange && r.regChange.date && r.regChange.date < checkedOn;
        dd.append(el('div', {
          className: 'muted',
          textContent: stale
            ? `最近查核 ${dateLabel(checkedOn)}：這天再對過一次，跟登記一樣，沒有新的變動`
            : `最近查核 ${dateLabel(checkedOn)}`,
        }));
      }
      dl.append(dd);
    }
    // 名單來源不在詳細頁列出（使用者說看起來亂），卡片上仍有、篩選也有
    body.append(dl);

    // 通話紀錄表單
    const section = el('div', { className: 'detail-section' }, [el('h3', { textContent: '記錄這通電話' })]);
    const form = el('div', { className: 'logform' });
    const memo = el('textarea', { placeholder: '這通電話聊了什麼？（例如：總機轉接財務長，約下週三拜訪）' });
    const outcomeSel = el('select');
    ['noanswer', 'contacted', 'blocked'].forEach((k) => {
      outcomeSel.append(el('option', { value: k, textContent: OUTCOME_LABEL[k] }));
    });
    outcomeSel.value = r.outcome === 'new' ? 'noanswer' : r.outcome;
    const nextInput = el('input', { type: 'date', value: r.nextDate || '' });
    /*
     * 打到一半的草稿保存在這台裝置（每家各一份）。
     *
     * 打字打到一半接到另一通、關掉視窗、按了提醒或連結讓詳細頁重畫，字就不見了。
     * 每打一個字就存，回到這家自動填回來，存好紀錄才清掉。
     */
    const DRAFT_KEY = `log-draft:${r.id}`;
    const readDraft = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { return null; } };
    const writeDraft = () => {
      const d = { text: memo.value, outcome: outcomeSel.value, nextDate: nextInput.value, at: Date.now() };
      try {
        if (d.text.trim() || d.nextDate !== (r.nextDate || '')) localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
        else localStorage.removeItem(DRAFT_KEY);
      } catch (e) { /* 無痕模式 */ }
      draftNote.hidden = !memo.value.trim();
    };
    const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* 無痕模式 */ } };
    const draftNote = el('p', { className: 'muted draft-note', hidden: true });
    const draft = readDraft();
    if (draft && (draft.text || draft.nextDate)) {
      memo.value = draft.text || '';
      if (draft.outcome) outcomeSel.value = draft.outcome;
      if (draft.nextDate) nextInput.value = draft.nextDate;
      draftNote.hidden = !memo.value.trim();
      const discard = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '丟掉草稿' });
      discard.onclick = () => { memo.value = ''; nextInput.value = r.nextDate || ''; nextInput.dispatchEvent(new Event('change')); clearDraft(); draftNote.hidden = true; };
      draftNote.append(document.createTextNode(`還沒送出的草稿已填回來（${whenLabel(draft.at || Date.now())}）　`), discard);
    }
    memo.addEventListener('input', writeDraft);
    outcomeSel.addEventListener('change', writeDraft);
    nextInput.addEventListener('change', writeDraft);
    const quick = el('div', { className: 'card-actions' });
    [['今天', 0], ['明天', 1], ['3 天後', 3], ['一週後', 7], ['兩週後', 14], ['一個月後', 30], ['三個月後', 90]].forEach(([label, days]) => {
      const b = el('button', { className: 'btn btn-tiny', type: 'button', textContent: label });
      b.onclick = () => {
        const want = addDays(todayISO(), days);
        // 「今天」不順延：人是在今天按的，今天放假也是他自己知道
        const got = days && window.Holidays ? window.Holidays.nextWorkday(want) : { iso: want, moved: false };
        nextInput.value = got.iso;
        // 直接改 value 不會觸發事件，旁邊的日期提示要靠這個才會跟著換
        nextInput.dispatchEvent(new Event('change'));
        if (got.moved) toast(`${dateLabel(got.from)} 是${got.reason}，順延到 ${dateLabel(got.iso)}（${window.Holidays.weekLabel(got.iso)}）`);
      };
      quick.append(b);
    });
    const save = el('button', { className: 'btn btn-primary', type: 'button', textContent: '儲存紀錄' });
    save.onclick = async () => {
      const text = memo.value.trim();
      // 禁止推廣不需要內容或下次聯絡日：判定了就是判定了，之後也不會再打
      const blocking = outcomeSel.value === 'blocked';
      if (!text && !nextInput.value && !blocking) { toast('請至少填寫內容或下次聯絡日'); return; }
      const today = todayISO();

      /*
       * 日期欄沒填，但內容裡寫了再聯絡的日期，就補進去。
       *
       * 實際使用時很容易把「約10/20再拜訪」打在內容裡就送出，日期欄留空。
       * 那筆客戶因此永遠不會出現在今日待打——寫了等於沒寫。
       * 只在日期欄是空的時候才補，使用者自己填的一律尊重。
       */
      let picked = nextInput.value;
      let auto = null;
      if (!picked) {
        auto = window.Normalize.findFollowUp(text, today);
        // 內容裡寫的日期是隨口約的，撞到連假一樣要順延；自己填在日期欄的才照原樣
        if (auto) {
          const got = window.Holidays ? window.Holidays.nextWorkday(auto.iso) : { iso: auto.iso, moved: false };
          auto = { ...auto, iso: got.iso, movedFrom: got.moved ? got.from : '', reason: got.reason };
          picked = auto.iso;
        }
      }
      // 只寫這一家：同組其他家靠訪談互通與日期、狀態連動看得到同一通電話，不用各寫一則
      await window.Store.addLog({
        recordId: r.id, date: today, text, outcome: outcomeSel.value, createdAt: Date.now(),
      });
      await saveState(r.id, {
        outcome: outcomeSel.value,
        nextDate: picked || null,
        lastDate: today,
      });
      state.logs = await window.Store.allLogs();
      clearDraft();
      const extra = members.length ? `（同老闆的 ${members.length} 家一起看得到）` : '';
      const autoNote = auto
        ? `已儲存${extra}，並依內容把下次聯絡日設為 ${dateLabel(auto.iso)}`
          + (auto.movedFrom ? `（${dateLabel(auto.movedFrom)} 是${auto.reason}，順延了）` : '')
        : '';
      toast(blocking && !text ? `已標記禁止推廣${extra}` : auto ? autoNote : `已儲存通話紀錄${extra}`);
      render();
      openDetail(r.id);
      scheduleSync();
    };
    form.append(memo, draftNote, el('div', { className: 'row' }, [
      el('span', { className: 'muted', textContent: '結果' }), outcomeSel,
      el('span', { className: 'muted', textContent: '下次聯絡' }), withDateHint(nextInput, true), save,
    ]));
    form.append(quick);
    if (members.length) {
      form.append(el('p', { className: 'muted apply-group', textContent: `這通電話同老闆的 ${members.length} 家（${members.map((m) => m.company).join('、')}）也會一起看到，日期與狀態一起連動。` }));
    }
    section.append(form);
    body.append(section);

    // 回撥提醒放在記通話的下面、往來情形的上面：掛了電話先記錄、再設提醒
    body.append(reminderSection(r));

    // 往來情形：先講二分法的結論，再列往來對象當佐證
    {
      const sec = el('div', { className: 'detail-section' }, [el('h3', { textContent: '往來情形' })]);
      sec.append(el('p', { className: `dealing-verdict dealing-${r.dealingKind}` }, [
        el('strong', { textContent: window.Normalize.DEALING_LABEL[r.dealingKind] }),
        el('span', { className: 'muted', textContent: r.dealingKind === 'active'
          ? `（最新一期${r.dealing.date ? ` ${r.dealing.date} ` : ''}有提到本餘或還在跟中租往來）`
          : `（最新一期${r.dealing.ended ? '寫到合作已結束' : '沒提到本餘或跟中租往來'}）` }),
      ]));
      if (r.dealing.snippet) {
        sec.append(el('p', { className: 'relation-snippet', textContent: `「…${r.dealing.snippet}…」` }));
      }
      sec.append(el('p', { className: `dealing-verdict visit-${r.visitKind}` }, [
        el('strong', { textContent: r.visitKind === 'yes' ? '有拜訪' : '無拜訪' }),
        el('span', { className: 'muted', textContent: r.visitKind === 'yes'
          ? `（${r.visit.date ? `${dateLabel(r.visit.date)} ` : ''}依訪談內容判讀）`
          : '（訪談內容裡沒有實際拜訪的紀錄）' }),
      ]));
      if (r.visit.snippet) {
        sec.append(el('p', { className: 'relation-snippet', textContent: `「…${r.visit.snippet}…」` }));
      }
      ['internal', 'peer', 'bank'].forEach((kind) => {
        if (!r.relations[kind].length) return;
        const group = el('div', { className: `relation-group relation-${kind}` }, [
          el('strong', { textContent: `${window.Normalize.RELATION_LABEL[kind]}：${r.relations[kind].map((x) => x.name).join('、')}` }),
        ]);
        // 同一句話可能同時提到好幾個對象，原文只需要秀一次
        [...new Set(r.relations[kind].map((item) => item.snippet))].forEach((snippet) => {
          group.append(el('p', { className: 'relation-snippet', textContent: `「${snippet}」` }));
        });
        sec.append(group);
      });
      if (r.relationKinds.length) {
        sec.append(el('p', { className: 'muted',
          textContent: '以上往來對象是從訪談內容的關鍵字判讀出來的，請對照原文確認。' }));
      }
      body.append(sec);
    }

    // 時間軸：本機紀錄 + PDF 原始訪談內容
    const bundle = notesBundle(r);
    const mineLogs = bundle.logs
      .map((l) => ({ date: l.date, time: l.createdAt ? timeLabel(l.createdAt) : '', text: l.text || `（${window.Normalize.outcomeLabel(l.outcome)}）`, mine: true, logId: l.logId, company: l.company, own: !l.company }));
    // 同組其他家名單檔裡的訪談內容也列進來，標出是哪一家的
    const peerEntries = bundle.peers.flatMap((id) => {
      const x = state.records.find((y) => y.id === id);
      return x ? window.Normalize.parseNotes(x.notesRaw || '').map((e) => ({ ...e, company: x.company })) : [];
    });
    // 全部照日期由新到舊；沒日期的（背景資料）排最後
    const entries = mineLogs.concat(r.timeline || [], peerEntries)
      .map((e, i) => ({ ...e, i }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.i - b.i);
    if (entries.length) {
      const sec = el('div', { className: 'detail-section' }, [el('h3', { textContent: `訪談紀錄（${entries.length}）` })]);
      const ul = el('ul', { className: 'timeline' });
      entries.forEach((e) => {
        const li = el('li');
        li.append(el('time', {
          className: e.mine ? 'is-mine' : '',
          textContent: `${e.date ? dateLabel(e.date) : (e.dateRaw || '日期未標示')}${e.time ? `  ${e.time}` : ''}${e.mine ? ' · 我的紀錄' : ''}${e.company ? ` · ${e.company}` : ''}`,
        }));
        li.append(el('p', { textContent: e.text }));
        if (e.mine && e.own) {
          /*
           * 自己記的紀錄要能改，不能只有刪除。
           *
           * 打完電話當下打字很容易漏字或記錯，如果只能刪掉重打，日期跟結果都要
           * 重新選一次，而且原本那則的時間戳就沒了。改成就地編輯。
           */
          const edit = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '修改' });
          const del = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '刪除' });
          const actions = el('div', { className: 'card-actions' }, [edit, del]);

          edit.onclick = () => {
            const box = el('textarea', { className: 'paste-box', rows: 3, value: e.text });
            const when = el('input', { type: 'date', value: e.date || todayISO() });
            // 改紀錄時順便能改下次聯絡日：談話內容改了，約的時間多半也跟著改
            const nextEdit = el('input', { type: 'date', value: r.nextDate || '' });
            const ok = el('button', { className: 'btn btn-primary btn-tiny', type: 'button', textContent: '儲存' });
            const cancel = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '取消' });
            const editor = el('div', {}, [box,
              el('div', { className: 'row' }, [
                el('span', { className: 'muted', textContent: '紀錄日期' }), withDateHint(when),
                el('span', { className: 'muted', textContent: '下次聯絡' }), withDateHint(nextEdit, true),
                ok, cancel]),
            ]);
            li.replaceChild(editor, actions);
            box.focus();
            cancel.onclick = () => { li.replaceChild(actions, editor); };
            ok.onclick = async () => {
              const text = box.value.trim();
              await window.Store.updateLog(e.logId, { text, date: when.value || e.date });
              state.logs = await window.Store.allLogs();
              // 下次聯絡日：有改就照改的；沒填的話從內容找「約10/20再拜訪」這種寫法
              let next = nextEdit.value || null;
              let auto = null;
              if (!next && text) {
                auto = window.Normalize.findFollowUp(text, todayISO());
                if (auto) next = auto.iso;
              }
              if ((next || null) !== (r.nextDate || null)) await saveState(r.id, { nextDate: next });
              touch();
              render();
              openDetail(r.id);
              toast(auto ? `已更新，並依內容把下次聯絡日設為 ${dateLabel(auto.iso)}` : '已更新這則紀錄');
              scheduleSync();
            };
          };

          del.onclick = async () => {
            if (!confirm('確定刪除這則紀錄嗎？')) return;
            await window.Store.deleteLog(e.logId);
            state.logs = await window.Store.allLogs();
            touch();
            render();
            openDetail(r.id);
            toast('已刪除這則紀錄');
            scheduleSync();
          };
          li.append(actions);
        }
        ul.append(li);
      });
      sec.append(ul);
      body.append(sec);
    }

    $('#drawer').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeOverlays() {
    $('#drawer').hidden = true;
    $('#importer').hidden = true;
    $('#syncSetup').hidden = true;
    $('#editor').hidden = true;
    document.body.style.overflow = '';
  }

  /* ---------------- 編輯與新增客戶 ---------------- */

  const EDIT_FIELDS = [
    ['company', '公司名稱', 'text'],
    ['taxId', '統一編號', 'text'],
    ['grade', '分級', 'text'],
    ['founded', '成立年', 'text'],
    ['capital', '資本總額（仟元）', 'text'],
    ['capitalPaid', '實收資本額（仟元）', 'text'],
    ['regChanged', '最近核准變更日期', 'text'],
    ['phoneRaw', '電話', 'textarea'],
    ['owner', '負責人', 'text'],
    ['keyman', 'KEYMAN', 'text'],
    ['industry', '產業別', 'text'],
    ['address', '登記地址', 'textarea'],
    ['addressActual', '實際地址（空著就同登記地址）', 'textarea'],
  ];

  /** 產生編輯表單，回傳 { node, read }。 */
  /** 電話列表編輯器：每列號碼／分機／備註，最後一顆「＋ 新增電話」。 */
  function phoneEditor(raw) {
    const node = el('div', { className: 'phone-editor' });
    const list = el('div', { className: 'phone-rows' });
    const add = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '＋ 加一支電話' });
    const rows = [];
    const addRow = (r) => {
      const number = el('input', { type: 'tel', placeholder: '02-1234-5678 或 0912-345-678', value: r.number || '' });
      const ext = el('input', { type: 'text', placeholder: '分機', value: r.ext || '', className: 'phone-ext' });
      const note = el('input', { type: 'text', placeholder: '備註（找誰、身分）', value: r.note || '' });
      const del = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '刪除', title: '刪除這支電話' });
      const row = el('div', { className: 'phone-row' }, [number, ext, note, del]);
      const item = { number, ext, note, row };
      del.onclick = () => { row.remove(); rows.splice(rows.indexOf(item), 1); if (!rows.length) addRow({}); };
      rows.push(item);
      list.append(row);
      return item;
    };
    const set = (text) => {
      rows.splice(0); list.textContent = '';
      const parsed = window.Normalize.phoneRows(text);
      (parsed.length ? parsed : [{}]).forEach(addRow);
    };
    add.onclick = () => { addRow({}).number.focus(); };
    set(raw);
    node.append(list, add);
    return {
      node,
      set,
      read: () => window.Normalize.serializePhones(rows.map((r) => ({ number: r.number.value, ext: r.ext.value, note: r.note.value }))),
    };
  }

  function editForm(values) {
    const node = el('div', { className: 'edit-form' });
    const inputs = {};
    let phoneEd = null;
    EDIT_FIELDS.forEach(([key, label, type]) => {
      if (key === 'phoneRaw') {
        // 電話一支一列：號碼、分機、備註，可刪可加。原本一整段文字擠在一起，改不動
        phoneEd = phoneEditor(values.phoneRaw || '');
        inputs.phoneRaw = { get value() { return phoneEd.read(); }, set value(v) { phoneEd.set(v); } };
        node.append(el('div', { className: 'rule-field rule-field-wide phone-field' }, [
          el('span', { textContent: label }), phoneEd.node,
        ]));
        return;
      }
      const control = type === 'textarea'
        ? el('textarea', { rows: 2, value: values[key] || '' })
        : el('input', { type: 'text', value: values[key] || '' });
      inputs[key] = control;
      node.append(el('label', { className: 'rule-field' }, [
        el('span', { textContent: label }), control,
      ]));
    });
    const nextDate = el('input', { type: 'date', value: values.nextDate || '' });
    inputs.nextDate = nextDate;
    node.append(el('label', { className: 'rule-field' }, [
      el('span', { textContent: '下次聯絡日' }), withDateHint(nextDate, true),
    ]));
    return {
      node,
      inputs,
      read: () => {
        const out = {};
        EDIT_FIELDS.forEach(([key]) => { out[key] = inputs[key].value.trim(); });
        out.nextDate = nextDate.value || null;
        return out;
      },
      /** 把解析出來的欄位填進表單；只填有值的，不清掉使用者已經打的。 */
      fill: (values) => {
        Object.entries(values).forEach(([key, v]) => { if (inputs[key] && v) inputs[key].value = v; });
      },
    };
  }


  /*
   * 承作檢核：輸入案件架構，跟這家客戶的名單資料、訪談內容（含網站上記的通話）
   * 一起丟給規則判斷，列出衝突與調整建議。判斷邏輯在 rules.js 的 checkDeal，
   * 這裡只負責收輸入、把訪談判讀出來的事實攤開給人覆核。
   */
  function openDealCheck(recordId) {
    const raw = state.records.find((x) => x.id === recordId);
    if (!raw) return;
    const r = allViews().find((x) => x.id === recordId) || view(raw);
    const R = window.Rules;
    const N = window.Normalize;
    const host = $('#editorBody');
    host.textContent = '';
    host.append(el('h2', { textContent: `承作檢核：${r.company}` }));
    host.append(el('p', { className: 'muted', textContent: '輸入這個案子的架構，網站會拿名單資料（登記地址、資本額）跟訪談內容（往來單位、本餘）對照規則，指出衝突並給調整建議。金額一律仟元。' }));

    // 訪談：網站上記的通話 + 名單原本的內容，跟往來情形判讀用同一份
    const allNotes = notesBundle(r).text;
    const relations = N.detectRelations(allNotes);
    const latest = N.latestNote(allNotes);
    const balanceGuess = R.parseBalance((latest && latest.text) || '') || R.parseBalance(allNotes);
    const reg = N.parseAddress(r.addressRegistered);
    const act = N.parseAddress(r.addressActual);
    const branch = R.branchOf(reg.city, reg.district);
    const actualBranch = R.branchOf(act.city, act.district);

    const branches = [...new Set(R.BRANCH_AREAS.map((b) => b.branch))];
    const mk = (tag, props) => el(tag, props);
    const sel = (options, value) => {
      const s = mk('select');
      options.forEach((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; s.append(el('option', { value: String(v), textContent: l })); });
      if (value !== undefined) s.value = String(value);
      return s;
    };
    const fieldOf = (label, control, hint) => el('label', { className: 'rule-field' }, [el('span', { textContent: label }), control, hint ? el('small', { textContent: hint }) : null].filter(Boolean));
    const num = (input) => Number(String(input.value).replace(/[^\d.-]/g, '')) || 0;

    const myBranch = sel(branches, registryPref('my-branch') || '新莊');
    const myUnit = sel(['一般組', '微企處', '大企部'], registryPref('my-unit') || '一般組');
    const caseType = sel(['一般案件', '存貨擔保融資', 'OSF'], '一般案件');
    const amount = mk('input', { type: 'text', inputMode: 'numeric', placeholder: '例如 5,000' });
    const months = mk('input', { type: 'number', min: '1', placeholder: '例如 36' });
    const freq = sel([[1, '月繳'], [3, '季繳'], [6, '半年繳'], [12, '年繳']], 1);
    const method = sel(['本息平均攤還', '本金平均攤還', '頭小尾大', '不規則還款'], '本息平均攤還');
    const spread = mk('input', { type: 'text', inputMode: 'decimal', placeholder: '例如 9.5' });
    const yieldRate = mk('input', { type: 'text', inputMode: 'decimal', placeholder: '例如 11' });
    const balance = mk('input', { type: 'text', inputMode: 'numeric', value: balanceGuess ? String(balanceGuess) : '', placeholder: '訪談沒寫就留空' });
    const handover = sel(['不適用', '主動移交', '被動移交'], '不適用');
    const schedule = mk('textarea', { rows: 3, placeholder: '頭小尾大／不規則時填：每期償還本金，用逗號或換行分開（單位仟元）' });
    const collateralBox = el('div', { className: 'chips' });
    const chosen = new Set(['純信用（無擔保品）']);
    ['純信用（無擔保品）', ...R.EXCLUDING, ...R.CONTROLLED_COLLATERAL].forEach((name) => {
      const chip = el('button', { className: 'chip', type: 'button', textContent: name });
      chip.setAttribute('aria-pressed', chosen.has(name) ? 'true' : 'false');
      chip.onclick = () => {
        if (name === '純信用（無擔保品）') { chosen.clear(); chosen.add(name); }
        else { chosen.delete('純信用（無擔保品）'); chosen.has(name) ? chosen.delete(name) : chosen.add(name); if (!chosen.size) chosen.add('純信用（無擔保品）'); }
        [...collateralBox.children].forEach((c) => c.setAttribute('aria-pressed', chosen.has(c.textContent) ? 'true' : 'false'));
        run();
      };
      collateralBox.append(chip);
    });

    host.append(el('div', { className: 'rule-form deal-form' }, [
      fieldOf('我的分公司', myBranch, '會記住，也跟著雲端同步'),
      fieldOf('我的單位', myUnit),
      fieldOf('案件類型', caseType),
      fieldOf('本案金額（仟元）', amount),
      fieldOf('期數（月）', months),
      fieldOf('繳款頻率', freq),
      fieldOf('還款方式', method),
      fieldOf('本案 Spread（%）', spread),
      fieldOf('實質收益率（%）', yieldRate),
      fieldOf('客戶既有本餘（仟元）', balance, balanceGuess ? `從訪談內容抓到「本餘」約 ${balanceGuess.toLocaleString('zh-TW')} 仟元，可修改` : '訪談內容沒寫到本餘'),
      fieldOf('移交方式', handover),
    ]));
    host.append(fieldOf('擔保品（可複選）', collateralBox));
    const schedField = fieldOf('還款計畫（每期償還本金）', schedule);
    host.append(schedField);

    const result = el('div', { className: 'rule-result deal-result' });
    host.append(result);

    function run() {
      registryPref('my-branch', myBranch.value);
      registryPref('my-unit', myUnit.value);
      schedField.hidden = !['頭小尾大', '不規則還款'].includes(method.value);
      const out = R.checkDeal({
        company: r.company, capital: num({ value: r.capital }),
        branch, actualBranch, myBranch: myBranch.value, myUnit: myUnit.value,
        dealing: r.dealing, relations,
        balance: num(balance), balanceSource: balanceGuess && num(balance) === balanceGuess ? `訪談：「${(latest && latest.text || '').slice(0, 60)}」` : '手動填入',
        amount: num(amount), months: Number(months.value) || 0, periodMonths: Number(freq.value) || 1,
        method: method.value, collaterals: [...chosen], schedule: R.parseSchedule(schedule.value),
        spread: spread.value.trim() === '' ? '' : num(spread),
        yieldRate: yieldRate.value.trim() === '' ? '' : num(yieldRate),
        caseType: caseType.value, handoverType: handover.value === '不適用' ? '' : handover.value,
      });
      result.textContent = '';
      const CLS = { ok: 'is-ok', warn: 'is-warn', block: 'is-fail' };
      result.append(el('p', { className: `rule-verdict ${CLS[out.verdict]} deal-summary`, textContent: out.summary }));

      const facts = el('dl', { className: 'deal-facts' });
      out.facts.forEach((f) => {
        facts.append(el('dt', { textContent: f.label }));
        const dd = el('dd', { textContent: f.value });
        if (f.source) dd.append(el('div', { className: 'muted', textContent: f.source }));
        facts.append(dd);
      });
      result.append(el('h3', { textContent: '從名單與訪談內容判讀到的' }), facts);

      const order = { block: 0, warn: 1, ok: 2 };
      const sorted = [...out.findings].sort((a, b) => order[a.level] - order[b.level]);
      result.append(el('h3', { textContent: '跟規則對照' }));
      sorted.forEach((f) => {
        const p = el('p', { className: `rule-verdict ${CLS[f.level]}`, textContent: `${f.level === 'block' ? '衝突：' : f.level === 'warn' ? '注意：' : '符合：'}${f.text}` });
        if (f.rule) p.append(el('span', { className: 'muted deal-rule', textContent: `　〔${f.rule}〕` }));
        result.append(p);
      });
      if (out.suggestions.length) {
        result.append(el('h3', { textContent: '調整建議' }));
        result.append(el('ol', { className: 'deal-suggestions' }, out.suggestions.map((t) => el('li', { textContent: t }))));
      }
      if (out.principal && out.principal.checkpoints.length) {
        const t = el('table', { className: 'rule-table' });
        t.append(el('thead', {}, [el('tr', {}, ['檢核點', '月', '應累計償還', '計畫償還', '結果'].map((h) => el('th', { textContent: h })))]));
        t.append(el('tbody', {}, out.principal.checkpoints.map((c) => el('tr', {}, [
          String(c.index), String(c.month), R.fmt(c.required), R.fmt(c.actual),
          c.status === 'pass' ? '達標' : c.status === 'waived' ? '餘額≤10% 免檢' : `差 ${R.fmt(c.shortfall)}`,
        ].map((v) => el('td', { textContent: v }))))));
        result.append(t);
      }
    }
    [amount, months, spread, yieldRate, balance, schedule].forEach((i) => { i.oninput = run; });
    [myBranch, myUnit, caseType, freq, method, handover].forEach((i) => { i.onchange = run; });
    run();
    $('#editor').hidden = false;
  }

  /** 編輯既有客戶：存成覆蓋層，重新匯入 PDF 不會被蓋掉，也會跟著雲端同步。 */
  function openEditor(recordId) {
    const raw = state.records.find((r) => r.id === recordId);
    if (!raw) return;
    const r = view(raw);
    const host = $('#editorBody');
    host.textContent = '';
    host.append(el('h2', { textContent: '編輯客戶資料' }));
    host.append(el('p', { className: 'muted',
      textContent: '修改內容會蓋在原始名單之上。重新匯入同一份 PDF 不會覆蓋你改過的欄位，'
        + '也會透過雲端同步帶到其他裝置。' }));

    // KEYMAN 若是判讀出來的就不預填，免得存別的欄位時把判讀值當成使用者填的
    const form = editForm({ ...r, keyman: r.keymanFrom === 'edit' || r.keymanFrom === 'file' ? r.keyman : '',
      addressActual: r.addressActual === r.addressRegistered ? '' : r.addressActual });
    host.append(form.node);

    const save = el('button', { className: 'btn btn-primary', type: 'button', textContent: '儲存' });
    save.onclick = async () => {
      const values = form.read();
      const nextDate = values.nextDate;
      delete values.nextDate;
      // 只記下跟原始資料不同的欄位，之後 PDF 更新了還看得出哪些是自己改的
      const edits = {};
      Object.entries(values).forEach(([key, value]) => {
        if (value !== (raw[key] || '')) edits[key] = value;
      });
      const existing = state.userStates.get(recordId) || {};
      await saveState(recordId, {
        edits: Object.keys(edits).length ? edits : undefined,
        editsAt: Date.now(),      // 編輯有自己的時間戳，同步時才不會被通話紀錄洗掉
        nextDate: nextDate || existing.nextDate || null,
      });
      closeOverlays();
      render();
      openDetail(recordId);
      toast(Object.keys(edits).length ? '已儲存修改' : '已清除先前的修改');
      scheduleSync();
    };
    const revert = el('button', { className: 'btn', type: 'button', textContent: '還原成名單原始內容' });
    revert.onclick = async () => {
      await saveState(recordId, { edits: undefined, editsAt: Date.now() });
      closeOverlays();
      render();
      openDetail(recordId);
      toast('已還原為 PDF 原始內容');
      scheduleSync();
    };
    host.append(el('div', { className: 'card-actions' }, [save, r.edited ? revert : null].filter(Boolean)));
    $('#editor').hidden = false;
  }

  /** 手動新增一筆客戶（例如客戶轉介或名片）。 */
  function openNewCustomer() {
    const host = $('#editorBody');
    host.textContent = '';
    host.append(el('h2', { textContent: '手動新增客戶' }));
    host.append(el('p', { className: 'muted', textContent: '來源會標記為「手動新增」，和匯入的名單分開管理。' }));
    const form = editForm({ nextDate: todayISO() });

    /*
     * 貼上區：把商工登記查詢頁（或 g0v 公司資料）整段複製過來，欄位自動填進下面的表單。
     * 使用者查完登記資料要新增客戶，一格一格抄既慢又容易抄錯統編。
     */
    const kvBox = el('textarea', {
      className: 'paste-box', rows: 4, id: 'kvPaste',
      placeholder: '可直接貼上商工登記的公司資料，例如：\n統一編號\t28443147\n公司名稱\t三貝德數位文創股份有限公司\n資本總額(元)\t1,100,000,000\n實收資本額(元)\t491,600,000\n代表人姓名\t余明珊\n公司所在地\t新北市三重區重新路5段609巷2號5樓\n最後核准變更日期\t114年07月16日',
    });
    const kvNote = el('p', { className: 'rule-note' });
    const kvRun = () => {
      const got = window.Normalize.parseKeyValue(kvBox.value);
      if (!got) { kvNote.textContent = kvBox.value.trim() ? '看不出欄位／值的格式，請確認每行是「欄位名稱、Tab 或冒號、內容」。' : ''; return; }
      form.fill(got);
      const filled = Object.keys(got).map((k) => (EDIT_FIELDS.find(([key]) => key === k) || [])[1]).filter(Boolean);
      kvNote.textContent = `已填入：${filled.join('、')}${got.capital ? '（資本額已從元換算成仟元）' : ''}。請檢查後按「新增」。`;
    };
    kvBox.oninput = kvRun;
    kvBox.onpaste = () => setTimeout(kvRun, 0);
    host.append(el('label', { className: 'rule-field' }, [
      el('span', { textContent: '貼上公司資料（選填）' }), kvBox,
    ]), kvNote);
    host.append(form.node);

    const save = el('button', { className: 'btn btn-primary', type: 'button', textContent: '新增' });
    save.onclick = async () => {
      const v = form.read();
      if (!v.company && !v.phoneRaw) { toast('請至少填公司名稱或電話'); return; }
      const source = '手動新增';
      const id = window.Normalize.makeId(source, v.company, v.taxId);
      if (state.records.some((r) => r.id === id)) { toast('已經有同名同統編的客戶了'); return; }
      const record = {
        id, source,
        company: v.company, aliases: [], taxId: v.taxId,
        grade: v.grade.toUpperCase(), founded: v.founded, capital: v.capital,
        phoneRaw: v.phoneRaw, phones: window.Normalize.extractPhones(v.phoneRaw),
        owner: v.owner, keyman: v.keyman, industry: v.industry,
        nextDate: v.nextDate, lastDate: null, addedDate: todayISO(), country: '台灣',
        address: v.address, addressActual: v.addressActual || v.address, notesRaw: '', timeline: [], outcome: 'new',
        importedAt: Date.now(),
      };
      Object.assign(record, window.Normalize.parseAddressAny(v.addressActual, v.address));
      await window.Store.saveRecords([record]);
      await reload();
      closeOverlays();
      render();
      openDetail(id);
      toast('已新增客戶');
      scheduleSync();
      checkNewRecords([id]);
    };
    host.append(el('div', { className: 'card-actions' }, [save]));
    $('#editor').hidden = false;
  }

  /**
   * 從試算表複製整列貼上新增客戶。走的是跟 CSV 匯入同一套解析與內容驗證，
   * 所以訪談內容、多支電話、民國年都會正確處理。先預覽再寫入。
   */
  /*
   * 從商工登記更新公司資料。
   *
   * 介面刻意分成「先試一筆」跟「全部更新」兩段。原因是這條路有一個沒辦法事先
   * 驗證的風險：政府的開放資料 API 若不允許跨網域呼叫，瀏覽器會直接擋掉。與其讓
   * 使用者按下「全部更新」跑到一半才發現全軍覆沒，不如先花十秒確認通不通，
   * 順便把原始回應攤開來看——欄位名稱要是跟預期的不一樣，這時候就看得出來。
   *
   * 更新一律寫成「編輯」，不動原始名單資料：登記資料未必永遠比業務手上的新
   * （例如剛換負責人還沒登記），保留得回原狀的路。
   */
  /*
   * 自架代理用的 Cloudflare Worker 腳本。
   *
   * 放在程式裡而不是只寫在 README，是因為使用者要設定的時候人在瀏覽器前面，
   * 不會跑去翻 GitHub。旁邊直接給複製鈕。
   *
   * 兩個容易忽略但會害人 debug 半天的細節：
   *   1. 連錯誤回應都要帶 CORS 標頭。少了的話，瀏覽器只會報「跨網域被擋」，
   *      把真正的錯誤訊息（例如網址不在白名單）整個吃掉，等於瞎子摸象。
   *   2. 白名單不能拿掉。沒有它，這個 Worker 就是誰都能拿去轉打任意網站的跳板。
   */
  const WORKER_SCRIPT = `const ALLOWED = ['https://data.gcis.nat.gov.tw/', 'https://company.g0v.ronny.tw/'];
const ORIGIN = '${location.origin}';

const cors = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const target = new URL(request.url).searchParams.get('url');
    // 白名單不要拿掉：沒有它，這個 Worker 就是任何人都能拿去轉打任意網站的跳板
    if (!target || !ALLOWED.some((a) => target.startsWith(a))) {
      return new Response('只接受 data.gcis.nat.gov.tw 與 company.g0v.ronny.tw 的網址', { status: 400, headers: cors });
    }

    try {
      const upstream = await fetch(target, {
        headers: {
          Accept: 'application/json',
          // 政府網站對沒有瀏覽器 UA 的請求有時直接回空白，帶一個一般瀏覽器的
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
        },
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          ...cors,
          'Content-Type': upstream.headers.get('content-type') || 'application/json',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    } catch (err) {
      // 錯誤也要帶 cors，否則瀏覽器只會說「跨網域被擋」，看不到真正的原因
      return new Response('連不上政府網站：' + err.message, { status: 502, headers: cors });
    }
  },
};`;

  /*
   * 「只查欄位有空白的客戶」只看這五個核心欄位。
   *
   * 實收資本額與最近核准變更日期是後來才加的，舊名單一定是空的；把它們算進去，
   * 這個範圍就等於「全部」，那這個選項就沒用了。這兩個欄位靠每天的自動更新（查
   * 全部）補，不需要讓快速範圍跟著變慢。
   */
  const REGISTRY_BLANK_FIELDS = ['taxId', 'capital', 'owner', 'address', 'founded'];
  /*
   * 查核欄位改版時換這個字串。
   *
   * 「每天只跑一次」是靠記下當天日期擋的，所以改版當天加的新欄位（實收資本額、
   * 最近核准變更日期）會整天都是空的——今天的自動更新在改版前就跑完了，得等到
   * 隔天 0:00 才補得到。使用者看到的是「你說有這兩欄，我這裡沒有」。
   * 換了字串就把當天那個記號清掉，下次打開網站立刻重查一次全部。
   */
  const REGISTRY_FIELDS_REV = '2026-09-19-capital-2';
  const REGISTRY_FIELDS = [
    ['taxId', '統一編號'],
    ['capital', '資本總額（仟元）'],
    ['capitalPaid', '實收資本額（仟元）'],
    ['owner', '負責人'],
    ['address', '登記地址'],
    ['founded', '成立年'],
    ['regChanged', '最近核准變更日期'],
  ];
  // 登記給的是完整日期（2016/03/01），名單上只記年份：比對與寫入都只用年
  const registryValue = (key, data) => {
    const v = String(data[key] || '').trim();
    if (key === 'founded') { const m = v.match(/^(\d{4})/); return m ? m[1] : ''; }
    return v;
  };
  const listValue = (key, r) => {
    const v = String(r[key] || '').trim();
    if (key === 'founded') { const m = v.match(/(\d{4})/); return m ? m[1] : v; }
    return v;
  };

  // 這幾個設定要跟著雲端同步：在電腦上設定好，手機打開也要能用
  const SYNCED_PREFS = new Set(['registry-proxy-url', 'registry-dataset-url', 'registry-dataset-taxid-url',
    'registry-mirror', 'registry-auto', 'registry-auto-last', 'registry-auto-summary',
    // 欄位改版的記號也同步：某台已經重查完、資料也同步過來了，另一台就不用再查一次
    'registry-fields-rev', 'my-branch', 'my-unit']);
  /** 每天自動對商工登記：預設開，使用者關掉才存 '0'。 */
  const registryAutoOn = () => registryPref('registry-auto') !== '0';
  const registryPref = (key, value) => {
    try {
      if (value === undefined) return localStorage.getItem(key) || '';
      if (value) localStorage.setItem(key, value); else localStorage.removeItem(key);
    } catch (e) { /* 無痕模式 */ }
    if (SYNCED_PREFS.has(key)) {
      window.Store.setSetting(key, value || '').then(() => scheduleSync()).catch(() => {});
    }
    return value;
  };
  /** Registry 的 set* 寫完 localStorage 後，再把值登記到會同步的設定裡。 */
  const syncRegistrySetting = (key, value) => {
    window.Store.setSetting(key, value || '').then(() => scheduleSync()).catch(() => {});
  };

  /** 一批客戶逐一查商工登記，回傳差異與失敗清單；不寫入。 */
  async function registryBatch(targets, { useMirror, onProgress, isCancelled, onEach, delay = 300 }) {
    const diffs = [];
    const failures = [];
    const checked = [];   // 每一筆查成功的都在這裡，含沒差異的；變更登記的分類靠它
    for (let i = 0; i < targets.length; i++) {
      if (isCancelled && isCancelled()) break;
      const { rec, r } = targets[i];
      if (onProgress) onProgress(i + 1, targets.length, r);
      const opts = { useMirror };
      // 統編查不齊（資料集只回一半）會自動再用名稱補，所以統編、名稱一起給
      const res = await window.Registry.lookupCompany({ taxId: r.taxId, name: r.company }, opts);
      if (!res.ok) { failures.push({ rec, company: r.company, reason: res.reason }); }
      else {
        const changes = {};
        const all = {};
        REGISTRY_FIELDS.forEach(([key]) => {
          const now = listValue(key, r);
          const next = registryValue(key, res.data);
          if (next && next !== now) all[key] = { from: now, to: next };
          // 查到不一致就更新，不分「只補空白」——查到了不寫入，等於白查
          if (next && next !== now) changes[key] = { from: now, to: next };
        });
        const item = { rec, r, changes: all };
        checked.push(item);
        const diff = Object.keys(changes).length ? { rec, r, changes, status: res.data.status } : null;
        if (diff) diffs.push(diff);
        // 交給呼叫端決定要不要馬上寫入：背景跑很久，寫在最後的話關掉分頁就整批白做
        if (onEach) await onEach({ ok: true, checked: item, diff });
      }
      if (!res.ok && onEach) await onEach({ ok: false, failure: failures[failures.length - 1] });
      // 一筆一筆送，別對政府網站造成負擔；連續失敗太多就是被擋了，不用再耗
      if (failures.length >= 8 && diffs.length === 0 && failures.length === i + 1) break;
      if (delay) await new Promise((done) => setTimeout(done, delay));
    }
    return { diffs, failures, checked };
  }

  /**
   * 把查核結果分類成「變更登記」：
   * 增資／減資看資本額數字、登記地址不同、負責人不同、其他欄位（統編、成立年）算其他。
   * 原本空白後來補上的不算變更——那是名單缺資料，不是公司變更登記。
   */
  function classifyRegistryChanges(changes, r) {
    const kinds = new Set();
    const num = (v) => Number(String(v || '').replace(/[^\d.]/g, '')) || 0;
    /*
     * 名單原本那一格是實收資本額（公司給的檔案多半填實收），查到的是資本總額，
     * 兩個本來就不一樣——不擋的話第一次查完整份名單都會冒出假的增資。
     * 舊值剛好等於這次查到的實收，就當成「欄位對齊」，不是公司真的增資。
     */
    const paidNow = num((changes && changes.capitalPaid && changes.capitalPaid.to) || (r && r.capitalPaid));
    Object.entries(changes || {}).forEach(([key, ch]) => {
      if (!String(ch.from || '').trim()) return;
      // 核准變更日期本身不是一種變更：公司只要動任何登記它就會變，
      // 真正變了什麼看上面那幾個欄位就夠了
      if (key === 'regChanged') return;
      if (key === 'capital' || key === 'capitalPaid') {
        const a = num(ch.from); const b = num(ch.to);
        if (key === 'capital' && paidNow && a === paidNow) return;
        if (b > a) kinds.add('capitalUp'); else if (b < a) kinds.add('capitalDown');
      } else if (key === 'address') kinds.add('address');
      else if (key === 'owner') kinds.add('owner');
      else kinds.add('other');
    });
    return REG_KIND_ORDER.filter((k) => kinds.has(k));
  }

  /**
   * 把這次查核記到每筆的追蹤狀態：regAt＝最近查核時間；有異動的另外記 regChange
   * （日期、種類、欄位前後值），沒異動的保留上一次的 regChange，篩選才看得到
   * 「這家今年增資過」，不會隔天套用完就變回無變更。
   */
  async function recordRegistryChecks(checked, failures) {
    const now = Date.now();
    const date = todayISO();
    // 查不到的也記下來（時間與原因），詳細頁才分得出「還沒查」和「查了查不到」
    for (const f of failures || []) {
      if (!f.rec) continue;
      await saveState(f.rec.id, { regAt: now, regError: String(f.reason || '查不到').split('\n')[0].slice(0, 120) });
    }
    for (const c of checked) {
      const kinds = classifyRegistryChanges(c.changes, c.r);
      const patch = { regAt: now, regError: undefined };
      if (kinds.length) {
        const kept = {};
        Object.entries(c.changes).forEach(([key, ch]) => { if (String(ch.from || '').trim()) kept[key] = ch; });
        patch.regChange = { date, kinds, changes: kept };
      }
      await saveState(c.rec.id, patch);
    }
  }

  /*
   * 新增客戶後立刻查核。
   *
   * 每天自動查核只在當天第一次打開網站時跑一次，之後手動新增、貼上、104 加入的
   * 客戶會一直掛著「未查核」到隔天。有開自動更新的話，新增完就在背景查這幾筆。
   */
  /** 失敗原因是「查無資料」這類（有回應但沒這家），而不是連不上。 */
  const lookedUpButMissing = (reason) => /查無資料|沒有一筆的統編是|只回了部分欄位|不是 8 碼/.test(String(reason || ''));

  async function checkNewRecords(ids) {
    if (!registryAutoOn() || !ids.length) return;
    const targets = state.records.filter((r) => ids.includes(r.id)).map((rec) => ({ rec, r: view(rec) }));
    if (!targets.length) return;
    try {
      const { diffs, failures, checked } = await registryBatch(targets, { useMirror: registryPref('registry-mirror') === '1', delay: 300 });
      if (!checked.length && failures.length === targets.length && !failures.some((f) => lookedUpButMissing(f.reason))) {
        // 來源掛了（連一個「查無資料」都沒有，全是連不上）就不記成查不到，明天自動更新再試
        toast('商工登記查不到，明天自動更新會再試（細節在選單「從商工登記更新公司資料」）');
        return;
      }
      await recordRegistryChecks(checked, failures);
      if (diffs.length) await applyRegistryDiffs(diffs);
      await reload();
      render();
      if ($('#drawer') && !$('#drawer').hidden && ids.length === 1) openDetail(ids[0]);
      scheduleSync();
      toast(diffs.length ? `已依商工登記更新 ${diffs.length} 筆新客戶的資料` : `新客戶已查核商工登記${failures.length ? `（${failures.length} 筆查不到）` : ''}`);
    } catch (err) { console.error('新客戶查核失敗', err); }
  }

  /** 把差異寫成「編輯」：看得出是後來動過的，同步到其他裝置，詳細頁可還原。 */
  async function applyRegistryDiffs(diffs) {
    for (const d of diffs) {
      const existing = state.userStates.get(d.rec.id) || {};
      const edits = { ...(existing.edits || {}) };
      Object.entries(d.changes).forEach(([key, ch]) => { edits[key] = ch.to; });
      await saveState(d.rec.id, { edits, editsAt: Date.now() });
    }
  }

  function autoRegistrySummary() {
    const last = registryPref('registry-auto-last');
    const info = registryPref('registry-auto-summary');
    if (!last) return '還沒有自動更新過。';
    return `上次自動更新：${dateLabel(last)}${info ? `，${info}` : ''}`;
  }

  /*
   * 每天自動把全部名單對一次商工登記。
   *
   * 沒有後端，所以沒辦法在瀏覽器關著的時候跑；能做到的是「網站開著就跨過 0:00
   * 準時開跑，沒開著就等下次打開時補跑」——兩邊都走這支，靠 registry-auto-last
   * 這個日期擋重複。查的是全部校正（登記資料是使用者要的正確版本），差異直接
   * 套用；一路失敗就停下來，當天不再重試，把原因記在設定視窗裡。
   */
  async function maybeAutoRegistry() {
    if (!registryAutoOn()) return;
    if (!state.records.length) return;
    if (registryJob.running) return;   // 手動那輪還在跑，先不要搶，下一分鐘再看
    const today = todayISO();
    if (registryPref('registry-auto-last') === today) return;
    registryPref('registry-auto-last', today);   // 先記，避免同一天多個分頁重複跑
    await runRegistryJob({
      targets: state.records.map((rec) => ({ rec, r: view(rec) })),
      useMirror: registryPref('registry-mirror') === '1',
      auto: true,
    });
  }

  function autoRegistryTick() {
    maybeAutoRegistry().catch((err) => console.error('自動更新商工登記失敗', err));
  }

  /*
   * 商工登記更新改成背景工作。
   *
   * 882 筆要跑四分多鐘，以前得把設定視窗開著等——那段時間沒辦法打電話。
   * 現在按下去就把視窗收起來，底部留一條進度，名單照常可以用；查到的差異
   * 一筆一筆寫進去，中途關掉分頁也只損失還沒查到的那些。
   */
  const registryJob = { running: false, cancelled: false, done: 0, total: 0, company: '', updated: 0, result: null, auto: false };

  function renderRegistryBar() {
    const bar = $('#registryBar');
    if (!bar) return;
    const j = registryJob;
    const show = j.running || !!j.result;
    bar.hidden = !show;
    document.body.classList.toggle('has-registry-bar', show);
    if (!show) return;
    $('#registryFill').style.width = `${j.total ? Math.round((j.done / j.total) * 100) : 0}%`;
    const stopBtn = $('#btnRegistryStop');
    const closeBtn = $('#btnRegistryClose');
    if (j.running) {
      $('#registryBarTitle').textContent = `登記更新 ${j.done}/${j.total}`;
      $('#registryBarNote').textContent = j.updated ? `已更新 ${j.updated}` : '';
      // 公司名稱放在提示文字裡：列太小了塞不下，但滑過去還看得到查到哪一家
      bar.title = j.company ? `商工登記更新中 ${j.done} / ${j.total}　目前：${j.company}` : '商工登記更新中';
      stopBtn.hidden = false;
      stopBtn.textContent = j.cancelled ? '停止中' : '停止';
      stopBtn.disabled = j.cancelled;
      closeBtn.hidden = true;
    } else {
      const r = j.result;
      const detail = r.sourceDown
        ? '每一筆都失敗，來源被擋住了，不是資料的問題。'
        : `查了 ${r.checkedCount} 筆，更新 ${r.updated} 筆，${r.failed} 筆查不到。`;
      $('#registryBarTitle').textContent = r.stopped ? '登記更新已停止' : '登記更新完成';
      $('#registryBarNote').textContent = r.sourceDown ? '來源被擋住' : `更新 ${r.updated}／查不到 ${r.failed}`;
      bar.title = `${r.stopped ? '商工登記更新已停止' : '商工登記更新完成'}　${detail}`;
      stopBtn.hidden = true;
      closeBtn.hidden = false;
    }
    stopBtn.onclick = () => { registryJob.cancelled = true; renderRegistryBar(); };
    closeBtn.onclick = () => { registryJob.result = null; renderRegistryBar(); };
  }

  /**
   * 跑一次商工登記更新。手動「全部更新」與每天自動更新都走這裡。
   * 同一時間只跑一個；查到的結果一筆一筆寫入，最後才重繪名單（中途重繪會打斷正在看的畫面）。
   */
  async function runRegistryJob({ targets, useMirror, auto }) {
    if (registryJob.running) { toast('商工登記更新正在進行中'); return null; }
    Object.assign(registryJob, { running: true, cancelled: false, done: 0, total: targets.length, company: '', updated: 0, result: null, auto: !!auto });
    renderRegistryBar();
    let wrote = 0;
    const { diffs, failures, checked } = await registryBatch(targets, {
      useMirror,
      onProgress: (i, n, r) => { registryJob.done = i; registryJob.company = r.company; renderRegistryBar(); },
      isCancelled: () => registryJob.cancelled,
      onEach: async (item) => {
        if (!item.ok) return;   // 查不到的最後再一起記，才分得出「來源掛了」
        await recordRegistryChecks([item.checked], []);
        if (item.diff) { await applyRegistryDiffs([item.diff]); registryJob.updated += 1; }
        wrote += 1;
        renderRegistryBar();
      },
    });
    // 全部都失敗是來源掛了，不把每一家都記成「查不到」
    const sourceDown = !checked.length && failures.length === targets.length && !!targets.length
      && !failures.some((f) => lookedUpButMissing(f.reason));
    if (!sourceDown && failures.length) await recordRegistryChecks([], failures);
    if (wrote || (!sourceDown && failures.length)) { await reload(); render(); scheduleSync(); }

    registryJob.running = false;
    registryJob.result = {
      at: Date.now(), stopped: registryJob.cancelled, sourceDown,
      checkedCount: checked.length, updated: diffs.length, failed: failures.length,
      diffs: diffs.slice(0, 20), diffTotal: diffs.length, reason: failures.length ? failures[0].reason : '',
    };
    renderRegistryBar();
    registryPref('registry-auto-summary', sourceDown
      ? `全部失敗（${String(failures[0].reason || '').split('\n')[0]}）`
      : `查 ${targets.length} 筆，更新 ${diffs.length} 筆，${failures.length} 筆查不到`);
    if (sourceDown) toast('商工登記更新失敗：來源連不上。細節在選單「從商工登記更新公司資料」。');
    else if (!auto || diffs.length) toast(diffs.length ? `商工登記更新：已更新 ${diffs.length} 筆` : '商工登記更新：資料都是最新的');
    return registryJob.result;
  }

  /** 把背景工作的進度或結果畫進設定視窗（視窗關著時不影響工作）。 */
  function renderRegistryRunResult(box) {
    box.textContent = '';
    const note = (text, cls) => box.append(el('p', { className: cls || 'rule-note', textContent: text }));
    if (registryJob.running) {
      note(`更新進行中 ${registryJob.done} / ${registryJob.total}，已更新 ${registryJob.updated} 筆。`
        + '關掉這個視窗也會繼續跑，進度在畫面下方。', 'rule-verdict is-ok');
      return;
    }
    const r = registryJob.result;
    if (!r) return;
    if (r.sourceDown) {
      note('上次更新：每一筆都失敗，代表來源被擋住了，不是資料的問題。', 'rule-verdict is-fail');
      if (r.reason) note(r.reason);
      return;
    }
    note(`上次更新（${r.stopped ? '中途停止' : '已完成'}）：查了 ${r.checkedCount} 筆，`
      + `${r.updated} 筆跟登記不一致、已直接更新，${r.failed} 筆查不到或失敗。`, 'rule-verdict is-ok');
    if (!r.diffTotal) { note('登記資料跟名單一致，沒有要更新的。'); return; }
    r.diffs.forEach((d) => {
      const dl = el('dl');
      Object.entries(d.changes).forEach(([key, ch]) => {
        const label = (REGISTRY_FIELDS.find(([k]) => k === key) || [, key])[1];
        dl.append(el('dt', { textContent: label }), el('dd', { textContent: `${ch.from || '（空）'}　→　${ch.to}` }));
      });
      box.append(el('div', { className: 'import-preview' }, [el('strong', { textContent: d.company || d.r.company }), dl]));
    });
    if (r.diffTotal > r.diffs.length) note(`※ 另外還有 ${r.diffTotal - r.diffs.length} 筆有差異，這裡只列前 ${r.diffs.length} 筆。`);
    note('以上都已更新到客戶欄位並記成「已修改」，每一筆都可以在詳細頁按「還原成名單原始內容」退回。'
      + '篩選區的「變更登記」也已依此分類。');
  }

  function openRegistryUpdate() {
    const host = $('#editorBody');
    host.textContent = '';
    host.append(el('h2', { textContent: '從商工登記更新公司資料' }));
    host.append(el('p', { className: 'muted',
      textContent: '查詢的是「商工行政資料開放平臺」的公司登記基本資料，跟 findbiz 查詢畫面同一份來源。'
        + '查詢由你的瀏覽器直接發出，送出去的只有統一編號，客戶名單不會離開這台裝置。' }));

    // 官方 API 實測會被 CORS 擋掉，所以這裡要讓使用者選別的路走。
    // 鏡像預設不開：那是第三方，就算只送出公開的統編，也該由使用者自己決定。
    const mirror = el('input', { type: 'checkbox', id: 'useMirror' });
    mirror.checked = registryPref('registry-mirror') === '1';
    mirror.onchange = () => registryPref('registry-mirror', mirror.checked ? '1' : '');
    host.append(el('label', { className: 'rule-field' }, [
      mirror,
      el('span', { textContent: ' 允許使用 g0v 社群鏡像（官方被擋時的替代來源，只會送出統一編號）' }),
    ]));

    /*
     * 每天自動更新。
     *
     * 網站沒有後端，瀏覽器關著的時候不可能自己跑；做法是網站開著就在 0:00 自己
     * 開跑，沒開著就等下次打開時補跑，對使用者來說效果一樣：每天看到的都是當天
     * 查過的登記資料。
     * 查完直接套用（登記資料就是使用者要的正確資訊），套用的內容記成「已修改」，
     * 詳細頁隨時可以還原。
     */
    const auto = el('input', { type: 'checkbox', id: 'autoRegistry' });
    auto.checked = registryAutoOn();
    auto.onchange = () => registryPref('registry-auto', auto.checked ? '1' : '0');
    const autoInfo = el('p', { className: 'muted', textContent: autoRegistrySummary() });
    host.append(el('label', { className: 'rule-field' }, [
      auto,
      el('span', { textContent: ' 每天自動更新全部名單（跨過 0:00 就在背景查一次，查到的差異直接套用；網站沒開著就等下次打開時補跑）' }),
    ]), autoInfo);

    /*
     * 兩個資料集網址都可以自己填：萬一政府改了編號，不用等改版。
     */
    const dataset = el('input', {
      id: 'datasetUrl', type: 'url', className: 'paste-box',
      placeholder: window.Registry.DEFAULT_BASE,
      value: window.Registry.getBase() === window.Registry.DEFAULT_BASE ? '' : window.Registry.getBase(),
    });
    host.append(el('label', { className: 'rule-field' }, [
      el('span', { textContent: '用名稱查的資料集網址（公司登記關鍵字查詢；留空用內建）' }), dataset,
    ]));
    const datasetNote = el('p', { className: 'rule-note' });
    dataset.onchange = () => {
      const t = window.Registry.setBase(dataset.value);
      if (t.ok) syncRegistrySetting('registry-dataset-url', t.url);
      datasetNote.textContent = t.ok ? (t.url && t.url !== dataset.value.trim() ? `已整理成：${t.url}` : '') : t.message;
      datasetNote.className = t.ok ? 'rule-note' : 'rule-verdict is-fail';
      if (t.ok && t.url) dataset.value = t.url;
    };
    host.append(datasetNote);
    const datasetTax = el('input', {
      id: 'datasetTaxUrl', type: 'url', className: 'paste-box',
      placeholder: window.Registry.DEFAULT_TAXID_BASE,
      value: window.Registry.getTaxIdBase() === window.Registry.DEFAULT_TAXID_BASE ? '' : window.Registry.getTaxIdBase(),
    });
    host.append(el('label', { className: 'rule-field' }, [
      el('span', { textContent: '用統編查的資料集網址（留空用內建的「公司登記基本資料-應用一」，欄位最齊；236EE382 那個只回統編、狀態、設立日期）' }), datasetTax,
    ]));
    const datasetTaxNote = el('p', { className: 'rule-note' });
    datasetTax.onchange = () => {
      const t = window.Registry.setTaxIdBase(datasetTax.value);
      if (t.ok) syncRegistrySetting('registry-dataset-taxid-url', t.url);
      datasetTaxNote.textContent = t.ok ? (t.url && t.url !== datasetTax.value.trim() ? `已整理成：${t.url}` : '') : t.message;
      datasetTaxNote.className = t.ok ? 'rule-note' : 'rule-verdict is-fail';
      if (t.ok && t.url) datasetTax.value = t.url;
    };
    host.append(datasetTaxNote);

    const proxy = el('input', {
      id: 'proxyUrl', type: 'url', className: 'paste-box', placeholder: 'https://你的-worker.workers.dev/（選填）',
      value: window.Registry.getProxy(),
    });
    host.append(el('label', { className: 'rule-field' }, [
      el('span', { textContent: '自架代理網址（不想經過第三方就用這個；開了雲端同步會跟著同步到其他裝置）' }), proxy,
    ]));
    proxy.onchange = () => { window.Registry.setProxy(proxy.value.trim()); syncRegistrySetting('registry-proxy-url', window.Registry.getProxy()); };

    /*
     * 代理的健康檢查跟查詢分開。
     *
     * 查詢失敗時，瀏覽器給的資訊少到無法分辨「代理沒部署」「網址填錯」「腳本貼錯」
     * 「ORIGIN 不對」——全部都是同一個 TypeError。這顆按鈕不帶查詢參數直接打代理，
     * 腳本正常的話會回 400 加白名單訊息，收到就代表前三關都過了。
     */
    const diag = el('div', { className: 'rule-result proxy-diag' });
    const checkBtn = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '檢查代理設定' });
    checkBtn.onclick = async () => {
      window.Registry.setProxy(proxy.value.trim());
      syncRegistrySetting('registry-proxy-url', window.Registry.getProxy());
      diag.textContent = '';
      diag.append(el('p', { className: 'rule-note', textContent: '檢查中…' }));
      const res = await window.Registry.checkProxy();
      diag.textContent = '';
      diag.append(el('p', { className: `rule-verdict ${res.ok ? 'is-ok' : 'is-fail'}`, textContent: res.message }));
      if (res.body) diag.append(el('p', { className: 'rule-note', textContent: `代理回應：${res.body}` }));
      if (res.openUrl) {
        diag.append(el('p', {}, [
          el('a', { href: res.openUrl, target: '_blank', rel: 'noopener', textContent: res.openUrl }),
        ]));
      }
      if (res.ok) diag.append(el('p', { className: 'rule-note', textContent: '可以按「先試一筆」了。' }));
    };
    host.append(el('div', { className: 'card-actions' }, [checkBtn]), diag);

    const guide = el('details', { className: 'proxy-guide' }, [
      el('summary', { textContent: '怎麼架自己的代理（免費，約五分鐘）' }),
    ]);
    guide.append(el('ol', {}, [
      el('li', { textContent: '到 dash.cloudflare.com 註冊（免費方案就夠用）。' }),
      el('li', { textContent: '左側選 Workers & Pages → Create → Start with Hello World → Deploy。' }),
      el('li', { textContent: '按 Edit code，把編輯器裡原有的內容全部刪掉，貼上下面這段，然後 Deploy。' }),
      el('li', { textContent: '把它給你的網址（長得像 https://xxx.workers.dev）填回上面的欄位。' }),
      el('li', { textContent: '按「先試一筆」確認通了。' }),
    ]));
    const code = el('pre', { className: 'proxy-code', textContent: WORKER_SCRIPT });
    const copyBtn = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '複製腳本' });
    copyBtn.onclick = async () => {
      toast(await copyText(WORKER_SCRIPT) ? '已複製，貼到 Cloudflare 的編輯器裡' : '複製失敗，請手動選取');
    };
    guide.append(el('div', { className: 'card-actions' }, [copyBtn]), code);
    guide.append(el('p', { className: 'muted',
      textContent: '腳本裡的白名單只允許轉打政府的開放資料網址，請不要拿掉——'
        + '沒有它，這個代理就變成任何人都能拿去轉打任意網站的跳板。' }));
    host.append(guide);

    const result = el('div', { className: 'rule-result' });
    const tryOne = el('button', { className: 'btn btn-primary', type: 'button', textContent: '先試一筆' });
    const runAll = el('button', { className: 'btn', type: 'button', textContent: '全部更新' });
    runAll.disabled = true;
    const stop = el('button', { className: 'btn', type: 'button', textContent: '停止' });
    stop.hidden = true;
    host.append(el('div', { className: 'card-actions' }, [tryOne, runAll, stop]));
    host.append(result);

    /*
     * 範圍只決定「查哪些客戶」，查到的差異一律直接更新到欄位。
     *
     * 以前分「只補空白」與「全部校正」，查完還要再按一次套用。使用者實際用起來
     * 是：變更登記那邊已經看到增資、換負責人，欄位卻還是舊的——查到了不更新，
     * 等於白查。現在查到不一致就寫入（記成「已修改」，詳細頁可還原）。
     * 「只查有空白的」留著是因為快：872 筆要四分半，只查缺欄位的可能幾十筆。
     */
    const scope = el('select', {}, [
      el('option', { value: 'blank', textContent: '只查欄位有空白的客戶（較快；查到的差異一樣會更新）' }),
      el('option', { value: 'all', textContent: '查全部客戶（每一筆都跟登記核對）' }),
    ]);
    host.append(el('label', { className: 'rule-field' }, [
      el('span', { textContent: '範圍' }), scope,
    ]));

    // 「有空白」看五個核心欄位（統編、資本總額、負責人、登記地址、成立年）任一個空著
    const scopeTargets = () => state.records
      .map((rec) => ({ rec, r: view(rec) }))
      .filter(({ r }) => (scope.value === 'blank'
        ? REGISTRY_BLANK_FIELDS.some((key) => !String(r[key] || '').trim())
        : true));

    const summary = el('p', { className: 'muted registry-summary' });
    host.append(summary);
    const refreshSummary = () => {
      const targets = scopeTargets();
      const withTaxId = targets.filter(({ r }) => /^\d{8}$/.test(String(r.taxId || '').replace(/\D/g, ''))).length;
      const secs = Math.ceil(targets.length * 0.3);
      summary.textContent = scope.value === 'blank'
        ? `名單共 ${state.records.length} 筆，其中 ${targets.length} 筆有欄位是空的。`
          + `${withTaxId} 筆有 8 碼統編可直接查，其餘 ${targets.length - withTaxId} 筆只能用公司名稱查。`
          + `約需 ${secs} 秒。`
        : `名單共 ${targets.length} 筆，其中 ${withTaxId} 筆有 8 碼統編可直接查，`
          + `其餘用公司名稱查。約需 ${secs} 秒。`;
    };
    scope.onchange = refreshSummary;
    // 沒有缺地址的客戶時，預設停在「只補地址」會讓人一按就撞到「沒有東西可以查」。
    // 這種時候直接預設成全部校正。
    if (!state.records.map(view).some((r) => REGISTRY_BLANK_FIELDS.some((k) => !String(r[k] || '').trim()))) {
      scope.value = 'all';
    }
    refreshSummary();

    const note = (text, cls) => result.append(el('p', { className: cls || 'rule-note', textContent: text }));
    const openLink = (url) => result.append(el('p', { className: 'rule-note' }, [
      document.createTextNode('　　'),
      el('a', { href: url, target: '_blank', rel: 'noopener', textContent: '在新分頁打開這個查詢網址' }),
      el('span', { className: 'muted', textContent: `　${url.slice(0, 120)}${url.length > 120 ? '…' : ''}` }),
    ]));

    tryOne.onclick = async () => {
      result.textContent = '';
      // 拿目前範圍裡的第一筆來試，而且優先挑有統編的——沒統編只能用名稱查，
      // 查不到時分不清是「這條路不通」還是「這家剛好比對不到」，那就白試了
      const pool = scopeTargets();
      const withId = pool.filter(({ r }) => /^\d{8}$/.test(String(r.taxId || '').replace(/\D/g, '')));
      const target = (withId[0] || pool[0] || {}).r;
      if (!target) { note('名單是空的，沒有東西可以查。', 'rule-verdict is-fail'); return; }
      note(`正在查：${target.company}（${target.taxId || '無統編，改用名稱'}）…`);
      const opts = { useMirror: mirror.checked };
      const res = await window.Registry.lookupCompany({ taxId: target.taxId, name: target.company }, opts);
      result.textContent = '';
      /*
       * 原始回應一律附上，成功失敗都是。
       *
       * 欄位名稱是用候選清單猜的（開發環境連不上政府網站，沒辦法確認），猜錯的話
       * 查詢會「成功」但每一格都是空的——那是最難查的一種壞法。把原始回應攤開來，
       * 一眼就看得出是沒查到、還是查到了但欄位名字不一樣。
       */
      const showRaw = (payload) => {
        if (payload === undefined || payload === null) return;
        const box = el('details', { className: 'proxy-guide' }, [
          el('summary', { textContent: '顯示原始回應（欄位對不上時把這段給我）' }),
          el('pre', { className: 'proxy-code',
            textContent: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }),
        ]);
        result.append(box);
      };

      if (!res.ok) {
        note('每個來源都失敗了。', 'rule-verdict is-fail');
        (res.attempts || []).forEach((a) => {
          note(`${a.label}：${a.reason}`);
          // 實際收到什麼比任何推測都有用，沒收到內容也要講「空白」而不是不講
          if (a.body) note(`　　實際收到：${a.body}`);
          if (a.upstream || a.url) openLink(a.upstream || a.url);
        });
        note('把上面任何一個「在新分頁打開」點開：那是你的瀏覽器直接連政府網站，不受跨網域限制。'
          + '有看到 JSON 資料就是查詢語法對了、只是代理那段有問題；看到空白就是這個統編／名稱在登記上查不到。');
        if (!res.attempts || !res.attempts.length) note(res.reason);
        /*
         * 沒填代理時要直接講。
         *
         * 代理網址存在各台裝置自己的瀏覽器裡、不會同步，所以在電腦上設定好之後
         * 換到手機還是空的。使用者看到的是一長串「每個來源都失敗」，很難聯想到
         * 「這台沒設定」——原本的提示又只在「兩個都沒開」時才出現，勾了鏡像就看不到了。
         */
        if (!window.Registry.getProxy()) {
          note('這台裝置還沒有自架代理網址。開了雲端同步的話，另一台設定好的網址下次同步就會過來；'
            + '沒開同步就要在這台再填一次。', 'rule-verdict is-fail');
        }
        if (!mirror.checked && !window.Registry.getProxy()) {
          note('也還沒勾 g0v 鏡像。兩個來源都沒有的話，只剩下必定被擋的官方那條。');
        }

        /*
         * 全部都是「空白回應」或「查無資料」時，多做一步：不帶篩選跟資料集要一筆。
         *
         * 那個症狀分不出「這個統編剛好沒資料」「篩選語法不對」「資料集編號是錯的」
         * 三件事，而這三件事的處理方式完全不同。拿掉篩選就分得出來——資料集存在
         * 的話一定給得出一筆。
         */
        // 只看真的收到回應的那些。官方那條永遠是跨網域被擋、根本沒收到東西，
        // 把它算進來的話「全部都空」這個條件永遠不會成立。
        const responded = (res.attempts || []).filter((a) => a.body || /查無資料/.test(a.reason));
        const allEmpty = responded.length
          && responded.every((a) => /空白回應|查無資料/.test(`${a.reason} ${a.body || ''}`));
        if (allEmpty) {
          note(`正在確認整條路通不通（改查一家一定存在的公司：台積電，統編 ${window.Registry.PROBE_TAXID}）…`);
          const probe = await window.Registry.probeDataset();
          if (probe.ok) {
            note(`路是通的：查台積電查得到（經由${probe.label}）。`
              + '所以剛才那家只是登記上查不到，換別家試試，或用「全部更新」跑跑看。', 'rule-verdict is-fail');
            note(`這支 API 實際的欄位名稱：${probe.keys.join('、')}`);
            showRaw(probe.row);
            note('把上面這段給我，我照真正的欄位名稱改查詢條件與對應表。');
          } else {
            note('連台積電都查不到，代表整條路不通：不是資料集編號錯、就是政府網站把代理的請求擋掉了。', 'rule-verdict is-fail');
            (probe.tried || []).forEach((t) => {
              note(`${t.label}：${t.reason}`);
              openLink(t.upstream || t.url);
            });
            note('請點開上面的網址看政府網站直接回什麼，把畫面貼給我。');
          }
        }
        return;
      }
      note(`查詢成功，走的是「${res.label}」。`, 'rule-verdict is-ok');
      // 最後採用的那條（只回一半、後來用名稱補齊）不算「不通」，不列
      (res.attempts || []).filter((a) => !(res.supplemented && /只回了部分欄位/.test(a.reason))).forEach((a) => note(`（${a.label} 不通：${a.reason.split('\n')[0]}）`));
      if (res.supplemented) {
        note(`統編查到的資料集只給了一部分欄位，資本額／負責人／地址是再用公司名稱查（${res.supplemented}）補上的。`);
      }
      if (res.partial) {
        note('查到了，但資本額、負責人、地址還是有缺：統編那個資料集只回統編、名稱、狀態、設立日期，'
          + '用名稱查也沒對到同統編的公司。若「用統編查的資料集網址」有自己填過，清空改用內建的（應用一）再試。', 'rule-verdict is-fail');
      }

      // 每一格都空的，代表欄位名稱猜錯了，這時候要講得比「成功」更清楚
      const mapped = REGISTRY_FIELDS.filter(([key]) => res.data[key]).length;
      if (!mapped) {
        note('連上了，但沒有一個欄位對得上——回應的欄位名稱跟預期的不一樣。'
          + '請把下面的原始回應給我，我改對應表。', 'rule-verdict is-fail');
      }
      const dl = el('dl');
      REGISTRY_FIELDS.forEach(([key, label]) => {
        dl.append(el('dt', { textContent: label }),
          el('dd', { textContent: `名單：${listValue(key, target) || '（空）'}　→　登記：${registryValue(key, res.data) || '（查無）'}` }));
      });
      if (res.data.status) dl.append(el('dt', { textContent: '營業狀態' }), el('dd', { textContent: res.data.status }));
      result.append(dl);
      if (res.data.unmappedKeys && res.data.unmappedKeys.length) {
        note(`回應裡還有這些沒對應到的欄位，可能有用：${res.data.unmappedKeys.join('、')}`);
      }
      showRaw(res.raw);
      runAll.disabled = mapped === 0;
    };

    stop.onclick = () => { registryJob.cancelled = true; stop.textContent = '停止中…'; renderRegistryBar(); };

    runAll.onclick = async () => {
      const blanksOnly = scope.value === 'blank';
      const all = scopeTargets();
      if (!all.length) {
        alert(blanksOnly ? '名單裡沒有欄位空白的客戶。' : '名單是空的。');
        return;
      }
      if (registryJob.running) { toast('已經在更新了，進度在畫面下方'); return; }
      if (!confirm(`要查 ${all.length} 筆嗎？\n\n`
        + '會在背景一筆一筆送出（每筆間隔 0.3 秒，避免對政府網站造成負擔），'
        + '這個視窗會自動收起來，你可以繼續打電話；進度在畫面下方，隨時可以按停止。\n\n'
        + '查到跟登記不一致的欄位（統編、資本總額、實收資本額、負責人、登記地址、成立年、最近核准變更日期）會直接更新，'
        + '記成「已修改」，每一筆都可以在詳細頁還原。')) return;
      $('#editor').hidden = true;
      toast('已在背景開始更新，可以繼續用名單');
      runRegistryJob({ targets: all, useMirror: mirror.checked })
        .then((res) => { if (res) renderRegistryRunResult(result); })
        .catch((err) => { console.error('商工登記更新失敗', err); toast('商工登記更新失敗，請看主控台訊息'); });
    };

    // 設定視窗重新打開時，把正在跑的進度或上一次的結果接回來
    renderRegistryRunResult(result);
    if (registryJob.running) { tryOne.disabled = true; runAll.disabled = true; stop.hidden = false; }

    $('#editor').hidden = false;
  }

  function openPasteImport() {
    const host = $('#editorBody');
    host.textContent = '';
    host.append(el('h2', { textContent: '貼上新增客戶' }));
    host.append(el('p', { className: 'muted',
      textContent: '從 Excel 或 Google 試算表選取整列複製，貼在下面即可，一次多列也可以。'
        + '沒有標題列的話會依名單的標準欄位順序判讀，並自動檢查內容有沒有放錯欄位。' }));

    const box = el('textarea', {
      className: 'paste-box', rows: 6,
      placeholder: '公司名稱\t統編\t分級\t成立\t資本額\t電話\t負責人\t…（直接貼上即可）',
    });
    host.append(box);

    const preview = el('div', { className: 'rule-result' });
    const save = el('button', { className: 'btn btn-primary', type: 'button', textContent: '新增到名單' });
    save.disabled = true;
    host.append(el('div', { className: 'card-actions' }, [save]));
    host.append(preview);

    let parsed = null;
    const SOURCE = '手動新增';

    function run() {
      const text = box.value;
      preview.textContent = '';
      parsed = null;
      save.disabled = true;
      if (!text.trim()) return;

      try {
        parsed = window.Normalize.parsePasted(text, SOURCE);
      } catch (err) {
        preview.append(el('p', { className: 'rule-verdict is-fail', textContent: `解析失敗：${err.message}` }));
        return;
      }
      if (!parsed.records.length) {
        preview.append(el('p', { className: 'rule-verdict is-fail',
          textContent: '讀不出任何客戶。請確認有複製到整列，且至少包含公司名稱或電話。' }));
        return;
      }

      const existing = new Set(state.records.map((r) => r.id));
      const updating = parsed.records.filter((r) => existing.has(r.id)).length;
      preview.append(el('p', { className: 'rule-verdict is-ok',
        textContent: `讀到 ${parsed.records.length} 筆`
          + `${updating ? `（其中 ${updating} 筆已存在，將更新）` : ''}`
          + `，分隔符號：${parsed.delimiter === '\t' ? 'Tab（試算表）' : '逗號'}`
          + `${parsed.synthesized ? '，未偵測到標題列，已依標準欄位順序判讀' : ''}` }));
      if (parsed.shift) {
        preview.append(el('p', { className: 'rule-note', textContent: `※ 偵測到欄位整體平移 ${parsed.shift > 0 ? '+' : ''}${parsed.shift} 格，已自動校正。` }));
      }
      if (parsed.repaired) {
        preview.append(el('p', { className: 'rule-note', textContent: `※ 有 ${parsed.repaired} 筆的部分欄位內容對不上欄位名稱，已依內容重新歸位。` }));
      }

      parsed.records.slice(0, 5).forEach((r) => {
        const dl = el('dl');
        [['公司名稱', r.company], ['統編', r.taxId], ['分級', r.grade],
          ['資本額', r.capital], ['電話', r.phoneRaw.replace(/\n/g, ' / ')],
          ['負責人', r.owner], ['產業別', r.industry],
          ['下次聯絡', r.nextDate || ''], ['地址', r.address],
          ['訪談紀錄', r.timeline.length ? `${r.timeline.length} 則` : ''],
        ].forEach(([k, v]) => {
          if (!v) return;
          dl.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
        });
        preview.append(el('div', { className: 'import-preview' }, [dl]));
      });
      if (parsed.records.length > 5) {
        preview.append(el('p', { className: 'muted', textContent: `…另外還有 ${parsed.records.length - 5} 筆` }));
      }
      save.disabled = false;
    }

    save.onclick = async () => {
      if (!parsed || !parsed.records.length) return;
      const importedAt = Date.now();
      parsed.records.forEach((r) => { r.importedAt = importedAt; });
      const existing = new Set(state.records.map((r) => r.id));
      const added = parsed.records.filter((r) => !existing.has(r.id)).length;
      await window.Store.saveRecords(parsed.records);   // 累加，不刪既有的「手動新增」
      await reload();
      closeOverlays();
      render();
      if (parsed.records.length === 1) openDetail(parsed.records[0].id);
      toast(`已新增 ${added} 筆${parsed.records.length - added ? `、更新 ${parsed.records.length - added} 筆` : ''}`);
      scheduleSync();
      checkNewRecords(parsed.records.map((r) => r.id));
    };

    box.oninput = run;
    box.onpaste = () => setTimeout(run, 0);
    $('#editor').hidden = false;
    setTimeout(() => box.focus(), 50);
  }

  /* ---------------- 匯入 ---------------- */

  function logLine(text, cls) {
    const node = el('div', { className: cls || '', textContent: text });
    $('#importLog').prepend(node);
    return node;
  }

  /** 匯入後秀前幾筆的欄位對照，讓使用者當場看得出有沒有跑錯格。 */
  function showPreview(filename, records) {
    const box = el('div', { className: 'import-preview' });
    box.append(el('h3', { textContent: `${filename.replace(/\.(pdf|csv)$/i, '')}　欄位檢查（前 ${Math.min(3, records.length)} 筆）` }));
    records.slice(0, 3).forEach((r) => {
      const dl = el('dl');
      const rows = [
        ['公司名稱', r.company + (r.aliases.length ? `（另有 ${r.aliases.join('、')}）` : '')],
        ['統編', r.taxId], ['分級', r.grade], ['成立年', r.founded],
        ['資本額', r.capital], ['電話', r.phoneRaw.replace(/\n/g, ' / ')],
        ['負責人', r.owner], ['KEYMAN', r.keyman], ['產業別', r.industry],
        ['下次聯絡', r.nextDate || ''], ['最近聯絡', r.lastDate || ''],
        ['地址', r.address],
        ['訪談內容', (r.notesRaw || '').replace(/\n/g, ' ').slice(0, 60) + ((r.notesRaw || '').length > 60 ? '…' : '')],
      ];
      rows.forEach(([k, v]) => {
        dl.append(el('dt', { textContent: k }), el('dd', {
          textContent: v || '（空白）',
          className: v ? '' : 'is-blank',
        }));
      });
      box.append(dl);
    });
    box.append(el('p', { className: 'muted', textContent: '對照一下內容有沒有放錯欄位。有錯的話把這段截圖給我，我再調整。' }));
    $('#importLog').prepend(box);
  }

  /*
   * 匯入時遇到已經在名單裡的公司要怎麼辦。
   *
   * 客戶的 id 是「檔名＋公司名＋統編」算出來的，所以同一家公司出現在不同檔案裡，
   * 會變成兩張各自獨立的卡片。名單越匯越多，同一家公司就散在好幾處，
   * 打過的紀錄在這張、新的資料在那張。
   *
   * 比對優先用統一編號：那是唯一且不會有寫法差異的。沒有統編才退回公司名稱，
   * 並且把「台／臺」正規化——登記一律用「臺」，但名單上兩種都有。
   */
  const taxKey = (r) => {
    const taxId = String(r.taxId || '').replace(/\D/g, '');
    return taxId.length === 8 ? `tax:${taxId}` : '';
  };
  const nameKey = (r) => {
    const name = String(r.company || '').replace(/\s+/g, '').replace(/台/g, '臺');
    return name ? `name:${name}` : '';
  };
  const dedupeKey = (r) => taxKey(r) || nameKey(r);

  /**
   * 找出這批要匯入的資料裡，有哪些公司已經在名單上。
   * 同一份來源檔的舊資料不算——那些本來就會被整份換掉。
   */
  function findImportDuplicates(incoming, sourceName) {
    // 每筆同時用統編與名稱建索引：新資料沒統編、名單上那筆有，也要靠名稱對得起來
    const index = new Map();
    state.records.forEach((rec) => {
      if (rec.source === sourceName) return;
      [taxKey(rec), nameKey(rec)].forEach((key) => { if (key && !index.has(key)) index.set(key, rec); });
    });
    const hits = [];
    incoming.forEach((r) => {
      const byTax = taxKey(r) ? index.get(taxKey(r)) : null;
      const old = byTax || (nameKey(r) ? index.get(nameKey(r)) : null);
      if (old) hits.push({ incoming: r, old, byTaxId: !!byTax });
    });
    return hits;
  }

  /**
   * 問使用者要怎麼處理重複的，回傳 'overwrite' | 'keep' | 'skip' | null（取消）。
   *
   * 沒有預設幫他決定，因為三種做法的後果差很多，而且覆蓋會動到他手動改過的內容。
   */
  function askDuplicatePolicy(filename, hits) {
    return new Promise((resolve) => {
      const edited = hits.filter(({ old }) => {
        const st = state.userStates.get(old.id);
        return st && st.edits && Object.keys(st.edits).length;
      }).length;
      const logged = hits.filter(({ old }) =>
        state.logs.some((l) => l.recordId === old.id)).length;

      const host = $('#editorBody');
      host.textContent = '';
      host.append(el('h2', { textContent: '有重複的公司' }));
      host.append(el('p', { className: 'muted',
        textContent: `${filename} 裡有 ${hits.length} 家公司已經在名單上。要怎麼處理？` }));

      const facts = el('div', { className: 'rule-result' });
      facts.append(el('p', { className: 'rule-note',
        textContent: `比對方式：${hits.filter((h) => h.byTaxId).length} 筆靠統一編號、`
          + `${hits.filter((h) => !h.byTaxId).length} 筆靠公司名稱。` }));
      if (logged) {
        facts.append(el('p', { className: 'rule-note',
          textContent: `其中 ${logged} 筆有通話紀錄——不管選哪一種，通話紀錄都會保留。` }));
      }
      if (edited) {
        facts.append(el('p', { className: 'rule-verdict is-fail',
          textContent: `其中 ${edited} 筆你曾經手動修改過欄位。選「覆蓋」的話，`
            + '那些修改會被新檔案的內容取代。' }));
      }
      hits.slice(0, 5).forEach(({ incoming, old }) => {
        facts.append(el('div', { className: 'import-preview' }, [
          el('strong', { textContent: incoming.company }),
          el('p', { className: 'rule-note',
            textContent: `名單上的來源：${old.source}　→　新檔案：${filename}` }),
        ]));
      });
      if (hits.length > 5) {
        facts.append(el('p', { className: 'rule-note', textContent: `※ 以上只列前 5 筆。` }));
      }
      host.append(facts);

      const pick = (value, label, hint, primary) => {
        const btn = el('button', { className: `btn${primary ? ' btn-primary' : ''}`, type: 'button', textContent: label });
        btn.onclick = () => { $('#editor').hidden = true; resolve(value); };
        host.append(el('div', {}, [
          el('div', { className: 'card-actions' }, [btn]),
          el('p', { className: 'rule-note', textContent: hint }),
        ]));
      };
      pick('overwrite', '以新檔案覆蓋', '同一家公司只留一張卡片，內容以新檔案為準。通話紀錄保留。', true);
      pick('keep', '兩邊都留著', '新檔案的資料另外新增一筆。同一家公司會有兩張卡片。');
      pick('skip', '略過重複的', '名單上已經有的就不動，只匯入新的公司。');

      const cancel = el('button', { className: 'btn', type: 'button', textContent: '取消匯入' });
      cancel.onclick = () => { $('#editor').hidden = true; resolve(null); };
      host.append(el('div', { className: 'card-actions' }, [cancel]));

      $('#editor').hidden = false;
    });
  }

  /*
   * 讀 Excel，回傳跟 CSV 一樣的「列陣列」，後面共用同一條解析流程。
   *
   * 只讀第一個工作表——公司匯出的名單只有一張。日期格用 cellDates 讓 SheetJS
   * 直接給 Date 物件再自己轉成 YYYY/MM/DD：不這樣做的話拿到的是 Excel 內部的
   * 序號（45914 之類）或跟著電腦語系走的字串，兩種都會讓日期解析失敗。
   */
  async function readXlsx(file) {
    if (!window.XLSX) throw new Error('Excel 解析元件沒有載入');
    const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
    const pad = (n) => String(n).padStart(2, '0');
    return raw.map((row) => row.map((v) => {
      if (v instanceof Date) return `${v.getFullYear()}/${pad(v.getMonth() + 1)}/${pad(v.getDate())}`;
      return v == null ? '' : String(v);
    }));
  }

  /* ------------------------------------------------------------------
   * 104 截圖 → 名單
   *
   * 使用者在 104 看到正在徵才的公司會截圖存起來。把截圖丟進匯入區：
   *   1. Ocr.recognize 在本機辨識（tesseract.js，截圖不上傳）。
   *   2. Ocr.parse104 挑出公司名稱、資本額、員工數、地址、聯絡人、電話。
   *   3. 預覽視窗讓使用者改辨識錯的字，按「查商工登記」補統編、負責人、
   *      登記資本額、成立年、登記地址（走 registry.js，同時試官方、代理與 g0v 鏡像）。
   *   4. 加入名單。電話只用公司頁上的，「暫不提供」就留白，不拿職缺頁的湊。
   * ------------------------------------------------------------------ */
  async function importScreenshots(files) {
    if (!window.Ocr || !window.Tesseract) { logLine('❌ 截圖辨識元件沒有載入，請重新整理頁面再試', 'err'); return; }
    const items = [];
    const line = logLine(`⏳ 辨識截圖 0 / ${files.length} …`);
    const setLine = (text) => { if (line) line.textContent = text; };
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setLine(`⏳ 辨識截圖 ${i + 1} / ${files.length}：${file.name} …`);
      try {
        const text = await window.Ocr.recognize(file, (m) => {
          if (m && m.status === 'loading language traineddata' && m.progress < 1) setLine(`⏳ 第一次使用要先載入辨識模型（約 6 MB）… ${Math.round(m.progress * 100)}%`);
          else if (m && m.status === 'recognizing text') setLine(`⏳ 辨識截圖 ${i + 1} / ${files.length}：${file.name} … ${Math.round(m.progress * 100)}%`);
        });
        const parsed = window.Ocr.parse104(text);
        parsed.file = file.name;
        parsed.text = text;
        items.push(parsed);
      } catch (err) {
        console.error(err);
        items.push({ kind: 'error', file: file.name, error: err && err.message ? err.message : '辨識失敗' });
      }
    }
    const companies = [];
    const skipped = [];
    items.forEach((p) => {
      if (p.kind !== 'company') { skipped.push(p); return; }
      // 同一家公司截了好幾張（公司頁＋職缺頁）就併成一筆，資料多的那張優先
      const key = p.company.replace(/\s/g, '');
      const seen = companies.find((c) => c.company.replace(/\s/g, '') === key);
      if (!seen) companies.push(p);
      else if (!seen.capital && p.capital) Object.assign(seen, p);
    });
    setLine(`✅ 截圖辨識完成：${companies.length} 家公司`
      + `${skipped.length ? `，${skipped.length} 張不是公司頁或讀不出來（${skipped.map((x) => x.file).join('、')}）` : ''}`);
    if (!companies.length) { logLine('沒有辨識出任何公司頁。請確認截的是 104 的「公司簡介」頁，而不是職缺頁。', 'err'); return; }
    open104Preview(companies);
  }

  /** 商工登記查回來的候選裡挑名稱最像的：台／臺互通，去空白。 */
  function pickRegistryMatch(res, company) {
    const norm = (v) => String(v || '').replace(/\s/g, '').replace(/台/g, '臺');
    const want = norm(company);
    const list = (res && res.candidates) || [];
    return list.find((c) => c && norm(c.name) === want) || list.find((c) => c && norm(c.name).includes(want)) || (res && res.data) || null;
  }

  function open104Preview(companies) {
    const host = $('#editorBody');
    host.textContent = '';
    host.append(el('h2', { textContent: `104 截圖：${companies.length} 家公司` }));
    host.append(el('p', { className: 'muted',
      textContent: '下面是截圖辨識出來的內容，可以直接修改。按「查商工登記」會用公司名稱查統編、負責人、登記資本額、成立年與登記地址，查到的會蓋過截圖的值；沒查到就照截圖的加入，之後再補。' }));

    const FIELDS = [
      ['company', '公司名稱'], ['taxId', '統一編號'], ['owner', '負責人'], ['capital', '資本額（仟元）'],
      ['founded', '成立年'], ['phone', '電話'], ['contact', '聯絡人'], ['industry', '產業別'],
      ['addressActual', '實際地址（104）'], ['address', '登記地址（商工登記）'],
    ];
    const rows = companies.map((p) => ({
      p,
      values: {
        company: p.company, taxId: '', owner: '', capital: p.capital, founded: p.founded,
        phone: p.phone, contact: p.contact, industry: p.desc || p.industry, addressActual: p.address, address: p.address,
      },
      registry: null, inputs: {}, status: null,
    }));

    const list = el('div');
    rows.forEach((row) => {
      const card = el('div', { className: 'import-preview shot-row' });
      const grid = el('div', { className: 'shot-grid' });
      FIELDS.forEach(([key, label]) => {
        const input = /address/.test(key) ? el('textarea', { rows: 2, value: row.values[key] || '' })
          : el('input', { type: 'text', value: row.values[key] || '' });
        input.dataset.field = key;
        row.inputs[key] = input;
        grid.append(el('label', { className: 'rule-field' }, [el('span', { textContent: label }), input]));
      });
      row.status = el('p', { className: 'rule-note', textContent: p104Status(row) });
      const look = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '查商工登記' });
      look.onclick = () => lookupRow(row, look);
      card.append(el('div', { className: 'group-head' }, [el('strong', { textContent: row.p.file }), look]), grid, row.status);
      list.append(card);
    });

    function p104Status(row) {
      const bits = [];
      if (row.p.employees) bits.push(`104：員工 ${row.p.employees} 人`);
      if (row.p.jobs) bits.push(`招募中 ${row.p.jobs} 個職缺`);
      bits.push(row.p.phone ? `公司頁電話 ${row.p.phone}` : '公司頁電話「暫不提供」，電話留白');
      return bits.join('　');
    }

    async function lookupRow(row, btn) {
      const name = row.inputs.company.value.trim();
      if (!name) { row.status.textContent = '沒有公司名稱，無法查商工登記。'; return; }
      btn.disabled = true;
      row.status.textContent = `查詢中：${name} …`;
      try {
        const res = await window.Registry.lookupByName(name, { useMirror: true });
        if (!res.ok) {
          row.registry = null;
          row.status.textContent = `商工登記查不到：${res.reason || '沒有回應'}。將照截圖的內容加入，統編等欄位可以之後再補。`;
          row.status.className = 'rule-verdict is-fail';
          return;
        }
        const hit = pickRegistryMatch(res, name);
        row.registry = hit;
        const set = (key, v) => { if (v) row.inputs[key].value = v; };
        set('taxId', hit.taxId);
        set('owner', hit.owner);
        set('capital', hit.capital);
        set('founded', hit.founded ? String(hit.founded).slice(0, 4) : '');
        set('address', hit.address);
        if (hit.name && hit.name.replace(/\s/g, '') !== name.replace(/\s/g, '')) set('company', hit.name);
        row.status.textContent = `已依商工登記（${res.label}）填入：統編 ${hit.taxId || '—'}、負責人 ${hit.owner || '—'}、資本額 ${hit.capital || '—'} 仟元、成立 ${hit.founded || '—'}。`;
        row.status.className = 'rule-verdict is-ok';
      } catch (err) {
        row.status.textContent = `查詢失敗：${err && err.message ? err.message : err}`;
        row.status.className = 'rule-verdict is-fail';
      } finally {
        btn.disabled = false;
      }
    }

    const lookupAll = el('button', { className: 'btn', type: 'button', textContent: '全部查商工登記' });
    const add = el('button', { className: 'btn btn-primary', type: 'button', textContent: '加入名單' });
    const cancel = el('button', { className: 'btn', type: 'button', textContent: '取消' });
    const progress = el('p', { className: 'muted' });
    lookupAll.onclick = async () => {
      lookupAll.disabled = true;
      const buttons = [...list.querySelectorAll('button')];
      for (let i = 0; i < rows.length; i++) {
        progress.textContent = `查詢中 ${i + 1} / ${rows.length}`;
        await lookupRow(rows[i], buttons[i]);
      }
      progress.textContent = '';
      lookupAll.disabled = false;
    };
    cancel.onclick = () => { $('#editor').hidden = true; };
    add.onclick = async () => {
      const source = `104截圖-${todayISO().replace(/-/g, '')}`;
      const today = todayISO();
      const records = rows.map((row) => {
        const v = {};
        FIELDS.forEach(([key]) => { v[key] = row.inputs[key].value.trim(); });
        const notes = window.Ocr.describe({ ...row.p, phone: v.phone })
          + (row.registry ? '' : '※統編、負責人待查商工登記。');
        const record = {
          id: window.Normalize.makeId(source, v.company, v.taxId), source,
          company: v.company, aliases: [], taxId: v.taxId.replace(/\D/g, ''),
          grade: '', founded: v.founded, capital: v.capital,
          phoneRaw: v.phone, phones: window.Normalize.extractPhones(v.phone),
          owner: v.owner, keyman: v.contact, industry: v.industry,
          nextDate: null, lastDate: null, addedDate: today, country: '台灣',
          address: v.address, addressActual: v.addressActual || v.address, notesRaw: notes, importedAt: Date.now(),
        };
        Object.assign(record, window.Normalize.parseAddressAny(v.addressActual, v.address));
        record.timeline = window.Normalize.parseNotes(notes);
        record.outcome = window.Normalize.guessOutcome(notes);
        return record;
      }).filter((r) => r.company);
      if (!records.length) { toast('沒有可加入的公司（公司名稱是空的）'); return; }

      let toSave = records;
      // 來源名稱傳空字串：跟名單上「所有」公司比對，包括之前同一天截圖加進來的
      const hits = findImportDuplicates(records, '');
      if (hits.length) {
        const policy = await askDuplicatePolicy('104 截圖', hits);
        if (!policy) { open104Preview(companies); return; }
        if (policy === 'skip') toSave = records.filter((r) => !hits.some((h) => h.incoming === r));
        else if (policy === 'overwrite') {
          hits.forEach(({ incoming, old }) => { incoming.id = old.id; incoming.source = old.source; });
          await window.Store.deleteRecordsById(hits.map(({ old }) => old.id));
          for (const { old } of hits) {
            const st = state.userStates.get(old.id);
            if (st && st.edits) await saveState(old.id, { edits: undefined, editsAt: Date.now() });
          }
        }
      }
      await window.Store.saveRecords(toSave);
      await reload();
      $('#editor').hidden = true;
      closeOverlays();
      render();
      toast(`已加入 ${toSave.length} 家公司`);
      if (toSave.length === 1) openDetail(toSave[0].id);
      scheduleSync();
      checkNewRecords(toSave.map((r) => r.id));
    };

    host.append(el('div', { className: 'card-actions' }, [lookupAll, add, cancel]), progress, list);
    $('#editor').hidden = false;
  }

  async function importFiles(files) {
    const isImage = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|heic)$/i.test(f.name);
    const shots = [...files].filter(isImage);
    const wanted = [...files].filter((f) => !isImage(f) && (/\.(pdf|csv|xlsx|xls)$/i.test(f.name)
      || f.type === 'application/pdf' || f.type === 'text/csv'));
    if (!wanted.length && !shots.length) { logLine('沒有偵測到 PDF、CSV、Excel 或截圖檔案', 'err'); return; }
    if (shots.length) await importScreenshots(shots);

    for (const file of wanted) {
      const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
      const isXlsx = /\.xlsx?$/i.test(file.name);
      logLine(`⏳ 解析 ${file.name} …`);
      try {
        let rows;
        let pages = 1;
        let pageStarts = [0];
        let mode = 'csv';
        if (isXlsx) {
          rows = await readXlsx(file);
        } else if (isCsv) {
          rows = window.Normalize.parseCsv(await file.text());
          /*
           * 經濟部的登記清冊一次四千多筆，但真正要打的只有一小撮。
           * 整份匯進來只會把名單淹掉，所以先問條件再匯。
           */
        }
        if ((isCsv || isXlsx) && window.Normalize.isGovRegistry(rows)) {
          const picked = await askGovFilter(file.name, rows);
          if (!picked) { logLine(`已取消 ${file.name}`); continue; }
          rows = picked;
        }
        if (!isCsv && !isXlsx) {
          const buffer = await file.arrayBuffer();
          const parsed = await window.PdfTable.parsePdf(buffer, (done, total) => {
            $('#importLog').firstChild.textContent = `⏳ 解析 ${file.name} … 第 ${done}/${total} 頁`;
          });
          ({ rows, pages, pageStarts, mode } = parsed);
        }
        /*
         * 資本額單位。公司匯出的 xlsx 是「元」，名單慣例是「仟元」，差一千倍。
         * 只在看起來像元的時候問，看起來已經是仟元就不打擾。
         */
        {
          const found = window.Normalize.detectHeader(rows);
          if (found && window.Normalize.capitalLooksLikeYuan(rows, found.map)) {
            const sample = String((rows[found.index + 1] || [])[found.map.capital] || '');
            const yes = confirm(`${file.name} 的資本額看起來是「元」（例如 ${sample}），`
              + '但名單用的是「仟元」。\n\n要換算成仟元再匯入嗎？\n（選取消 = 照原值匯入）');
            if (yes) {
              const n = window.Normalize.convertCapitalToThousands(rows, found.map);
              logLine(`資本額已由元換算成仟元（${n} 筆）`);
            }
          }
        }
        const { records, header, skipped, shift, repaired } =
          window.Normalize.toRecords(rows, file.name, { pageStarts });
        if (!header) {
          logLine(`⚠️ ${file.name}：找不到「公司名稱／電話」等欄位標題，請確認這是名單表格。`, 'err');
          continue;
        }
        if (!records.length) {
          logLine(`⚠️ ${file.name}：讀到表頭但沒有資料列。`, 'err');
          continue;
        }
        const importedAt = Date.now();
        records.forEach((r) => { r.importedAt = importedAt; });

        /*
         * 重複處理要在刪掉同名來源之前比對：比對的對象是「現在名單上的其他來源」，
         * 順序反過來的話會把剛刪掉的也算進去。
         */
        let toSave = records;
        let dupNote = '';
        const hits = findImportDuplicates(records, file.name);
        if (hits.length) {
          const policy = await askDuplicatePolicy(file.name, hits);
          if (!policy) { logLine(`已取消 ${file.name}`); continue; }
          const byIncoming = new Map(hits.map((h) => [h.incoming, h]));
          if (policy === 'skip') {
            toSave = records.filter((r) => !byIncoming.has(r));
            dupNote = `，略過 ${hits.length} 筆重複`;
          } else if (policy === 'overwrite') {
            // 沿用舊的 id，通話紀錄才會繼續掛在同一筆上
            hits.forEach(({ incoming, old }) => { incoming.id = old.id; });
            const ids = hits.map(({ old }) => old.id);
            await window.Store.deleteRecordsById(ids);
            // 手動修改過的內容會蓋掉新檔案的值，既然選了覆蓋就要清掉
            for (const id of ids) {
              const st = state.userStates.get(id);
              if (st && st.edits) await saveState(id, { edits: undefined, editsAt: Date.now() });
            }
            dupNote = `，覆蓋 ${hits.length} 筆重複`;
          } else {
            dupNote = `，另外新增 ${hits.length} 筆重複的公司`;
          }
        }

        await window.Store.deleteSource(file.name, { keepTombstone: false });   // 同名重匯 = 更新
        await window.Store.saveRecords(toSave);
        logLine(
          `✅ ${file.name}：${isXlsx ? 'Excel' : isCsv ? 'CSV' : `${pages} 頁`} → ${records.length} 筆客戶`
          + `${dupNote}`
          + `${skipped ? `（略過 ${skipped} 個空列）` : ''}`
          + `${mode === 'heuristic' ? '（此檔沒有表格框線，欄位為推測結果）' : ''}`,
          'ok'
        );
        if (shift) logLine(`🔧 偵測到整份表格欄位平移 ${shift > 0 ? '+' : ''}${shift} 格，已自動校正。`);
        if (repaired) logLine(`🔧 有 ${repaired} 筆的部分欄位內容對不上欄位標題，已依內容重新歸位。`);
        showPreview(file.name, records);
      } catch (err) {
        console.error(err);
        logLine(`❌ ${file.name}：${err && err.message ? err.message : '解析失敗'}`, 'err');
      }
    }
    await reload();
    render();
    scheduleSync();
  }

  /* ---------------- 匯出 ---------------- */

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /*
   * 匯出 Excel，做成使用者名單母檔的樣子：
   *   - 15 欄、欄名一模一樣（含「地址(至少填到行政區/路名)」「名單新增日期(必填)」），
   *     改完可以直接再拖回網站。
   *   - 表頭黃底粗體置中、全部細框線、自動換行、垂直置中；訪談內容與地址靠左。
   *   - 日期欄 yyyy/m/d；訪談內容裡的日期用民國年（母檔的寫法），網站上記的通話
   *     寫成「115/09/17 [結果] 內容」放最前面、新的在上。資本額仟元。
   *   - 列高依訪談內容行數估算：Excel 開檔不會自動調整程式產生的列高，不設的話
   *     長篇訪談只看得到第一行。
   */
  const EXPORT_HEAD = ['公司名稱', '統編', '分級', '成立年', '資本額', '電話', '負責人', 'KEYMAN', '產業別',
    '下次聯絡日', '最近聯絡日', '訪談內容', '地址(至少填到行政區/路名)', '名單新增日期(必填)', '國家', '實際地址'];
  const EXPORT_WIDTHS = [22, 10, 5, 7, 9, 18, 8, 12, 14, 11, 11, 44, 30, 13, 6, 30];
  const EXPORT_LEFT = new Set([11, 12, 15]);   // 訪談內容、地址靠左，其餘置中

  const rocSlash = (iso) => { const [y, m, d] = String(iso).split('-'); return `${+y - 1911}/${m}/${d}`; };
  const ymdShort = (iso) => { const [y, m, d] = String(iso).split('-'); return `${y}/${+m}/${+d}`; };

  function exportXlsx() {
    if (!window.XLSX) { toast('Excel 元件沒有載入，請重新整理頁面再試'); return; }
    const rows = [EXPORT_HEAD];
    allViews().forEach((r) => {
      const mine = state.logs.filter((l) => l.recordId === r.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((l) => `${l.date ? rocSlash(l.date) : ''}${l.createdAt ? ` ${timeLabel(l.createdAt)}` : ''} [${window.Normalize.outcomeLabel(l.outcome)}] ${l.text}`.trim());
      const notes = [...mine, r.notesRaw || ''].filter(Boolean).join('\n');
      rows.push([r.company, r.taxId, r.grade, r.founded, r.capital, r.phoneRaw, r.owner, r.keyman, r.industry,
        r.nextDate ? ymdShort(r.nextDate) : '', r.lastDate ? ymdShort(r.lastDate) : '', notes,
        r.addressRegistered, r.addedDate ? ymdShort(r.addedDate) : '', r.country || '台灣',
        r.addressActual === r.addressRegistered ? '' : r.addressActual]);
    });
    const ws = window.XLSX.utils.aoa_to_sheet(rows);
    const thin = { style: 'thin', color: { rgb: '000000' } };
    const border = { top: thin, bottom: thin, left: thin, right: thin };
    const headStyle = {
      font: { bold: true, sz: 10 }, fill: { patternType: 'solid', fgColor: { rgb: 'FFC000' } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border,
    };
    const bodyStyle = (col) => ({
      font: { sz: 9 },
      alignment: { horizontal: EXPORT_LEFT.has(col) ? 'left' : 'center', vertical: 'center', wrapText: true },
      border,
    });
    const range = window.XLSX.utils.decode_range(ws['!ref']);
    for (let R = range.s.r; R <= range.e.r; R++) {
      for (let C = 0; C < EXPORT_HEAD.length; C++) {
        const addr = window.XLSX.utils.encode_cell({ r: R, c: C });
        if (!ws[addr]) ws[addr] = { t: 's', v: '' };
        ws[addr].s = R === 0 ? headStyle : bodyStyle(C);
      }
    }
    ws['!cols'] = EXPORT_WIDTHS.map((w) => ({ wch: w }));
    // 列高：看每格會折成幾行（訪談內容 44 字寬、地址 30 字寬），一行約 12pt
    ws['!rows'] = rows.map((row, i) => {
      if (i === 0) return { hpt: 30 };
      const lines = Math.max(1, ...row.map((v, c) => String(v == null ? '' : v).split('\n')
        .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / (EXPORT_WIDTHS[c] * 0.9))), 0)));
      return { hpt: Math.min(400, 6 + lines * 12) };
    });
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, '名單');
    const out = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    download(`電話推廣名單_${todayISO()}.xlsx`, out,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  /* ---------------- 雲端同步 ---------------- */

  let syncTimer = null;

  function setSyncButton(stateName, title) {
    const btn = $('#btnSync');
    btn.hidden = !window.DriveSync.isConfigured();
    btn.classList.toggle('is-busy', stateName === 'busy');
    btn.classList.toggle('is-error', stateName === 'error');
    btn.textContent = stateName === 'busy' ? '⋯' : '⟳';
    btn.title = title || '與雲端硬碟同步';
  }

  async function showSyncTime() {
    const at = await window.Store.getMeta('lastSyncAt');
    if (at) setSyncButton('idle', `上次同步 ${new Date(at).toLocaleString('zh-TW')}`);
    else setSyncButton('idle', '尚未同步過');
    return at;
  }

  /**
   * @param {{interactive?:boolean, quiet?:boolean}} [opts]
   *   interactive：允許跳出 Google 授權視窗（使用者主動按的時候才可以）
   *   quiet：失敗時不要吵使用者
   */
  async function runSync(opts) {
    const { interactive = false, quiet = false } = opts || {};
    if (!window.DriveSync.isConfigured()) {
      if (!quiet) toast('請先到「雲端同步設定」填入 Google 用戶端 ID');
      return null;
    }
    setSyncButton('busy');
    try {
      const result = await window.DriveSync.sync({ interactive });
      await reload();
      render();
      await showSyncTime();
      if (!quiet) {
        const g = result.gained;
        const gained = [
          g.records > 0 ? `名單 +${g.records}` : '',
          g.logs > 0 ? `通話紀錄 +${g.logs}` : '',
        ].filter(Boolean).join('、');
        toast(result.firstTime ? '已建立雲端同步檔' : (gained ? `同步完成（${gained}）` : '同步完成，沒有新資料'));
      }
      const status = $('#syncStatus');
      if (status) status.textContent = `上次同步：${new Date().toLocaleString('zh-TW')}`;
      return result;
    } catch (err) {
      console.error(err);
      setSyncButton('error', String(err.message || err));
      if (!quiet) toast(`同步失敗：${err.message || err}`);
      const status = $('#syncStatus');
      if (status && !quiet) status.textContent = `同步失敗：${err.message || err}`;
      return null;
    }
  }

  /** 記完通話後過幾秒自動推上去，不要每按一次就打一次 API。 */
  function scheduleSync() {
    if (!window.DriveSync.isConfigured()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => runSync({ quiet: true }), 4000);
  }

  /* ---------------- 版本檢查 ---------------- */

  /*
   * 靜態主機連 index.html 本身都會被快取，所以就算資源網址帶了版本號，
   * 使用者還是可能停在舊版、看不到新功能。這裡另外抓一個永不快取的
   * version.json 來比對；不一致就提示更新，並用帶參數的網址重新載入，
   * 強迫瀏覽器重新抓 index.html。
   */
  /*
   * 檢查有沒有新版本。
   *
   * @param {boolean} loud 使用者自己按「檢查更新」時為 true，已是最新版也要回報。
   *   自動檢查時保持安靜——每次開啟都跳「已是最新版」很吵。
   *
   * 會做這件事是因為使用者多次遇到「我明明更新了，但畫面沒變」。實際上是
   * 瀏覽器拿快取的舊檔，而從畫面上完全看不出自己跑的是哪一版，只能瞎猜。
   */
  async function checkForUpdate(loud) {
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) { if (loud) toast('連不到伺服器，無法檢查更新'); return; }
      const data = await res.json();
      if (!data || !data.version || data.version === APP_VERSION) {
        if (loud) toast(`已經是最新版（${APP_VERSION}）`);
        return;
      }

      const bar = $('#updateBar');
      bar.hidden = false;
      if (loud) toast(`有新版本 ${data.version}，目前是 ${APP_VERSION}`);
      $('#btnUpdate').onclick = () => {
        // 換一個沒看過的網址，瀏覽器才會重新抓 index.html 而不是用快取
        location.replace(`${location.pathname}?v=${encodeURIComponent(data.version)}`);
      };
      $('#btnUpdateLater').onclick = () => { bar.hidden = true; };
    } catch (err) {
      // 以 file:// 開啟或離線時抓不到，忽略即可
    }
  }

  /*
   * 徵信資料功能移除後，瀏覽器裡還留著它的資料庫（crm-db）。名單完全用不到，
   * 留著只是佔空間又沒有介面可以看，所以每台裝置第一次開到新版時清掉一次。
   * 其他分頁還開著舊版徵信頁時瀏覽器會擋住刪除，那就不記旗標，下次開再試。
   */
  function dropOldDossierDb() {
    try {
      if (localStorage.getItem('crm-db-dropped') === '1' || !window.indexedDB) return;
      const req = indexedDB.deleteDatabase('crm-db');
      req.onsuccess = () => {
        try { localStorage.setItem('crm-db-dropped', '1'); } catch (e) { /* 無痕模式 */ }
      };
    } catch (e) { /* 無痕模式或瀏覽器不給刪，下次再試 */ }
  }

  /* ---------------- 啟動 ---------------- */

  async function reload() {
    touch();
    const [records, logs, states] = await Promise.all([
      window.Store.allRecords(), window.Store.allLogs(), window.Store.allStates(),
    ]);
    state.records = records;
    state.logs = logs;
    state.userStates = new Map(states.map((s) => [s.recordId, s]));
  }

  function wireEvents() {
    let searchTimer = null;
    $('#search').oninput = (e) => {
      const value = e.target.value;
      clearTimeout(searchTimer);
      // 每打一個字就重算幾百筆會頓，等使用者停一下再算
      searchTimer = setTimeout(() => {
        state.search = value;
        state.limit = PAGE_SIZE;
        render();
      }, 120);
    };
    // 下拉的預設值跟 state 對齊，不然畫面顯示第一個選項、實際卻是另一種排序
    $('#sortBy').value = state.sort;
    $('#sortBy').onchange = (e) => { state.sort = e.target.value; render(); };
    $('#hideBlocked').onchange = (e) => { state.hideBlocked = e.target.checked; render(); };
    $('#btnMore').onclick = () => { state.limit += PAGE_SIZE; renderList(); };
    $('#fltIndustry').oninput = (e) => { state.filters.industry = e.target.value.trim(); state.limit = PAGE_SIZE; render(); };
    $('#btnResetFilters').onclick = () => {
      // 就地清空，不要換掉整個 state.filters 物件：chip 的 onclick 抓的是 Set 的參照，
      // 一旦換成新物件，按鈕改到的就是被丟掉的舊 Set，按下去完全沒反應。
      Object.values(state.filters).forEach((v) => { if (v instanceof Set) v.clear(); });
      applyDueQuick('');
      state.filters.industry = '';
      $('#fltIndustry').value = '';
      state.limit = PAGE_SIZE;
      render();
    };

    initFilterGroups();
    $('#btnFilters').onclick = () => {
      const open = $('#filters').classList.toggle('is-open');
      $('#btnFilters').setAttribute('aria-expanded', String(open));
      $('#btnFilters').textContent = open ? '篩選 ▴' : '篩選 ▾';
    };

    $('#tabs').onclick = (e) => {
      const btn = e.target.closest('.tab');
      if (!btn || btn.id === 'btnFilters' || btn.classList.contains('tab-link') || btn.classList.contains('nav-link')) return;
      state.tab = btn.dataset.tab;
      state.limit = PAGE_SIZE;
      [...$('#tabs').children].forEach((b) => b.classList.toggle('is-active', b === btn));
      render();
    };

    $('#btnImport').onclick = () => { $('#importer').hidden = false; };
    $('#btnSync').onclick = () => runSync({ interactive: true });
    $('#btnSaveClientId').onclick = async () => {
      const id = $('#clientId').value.trim();
      if (!id) { toast('請貼上 Google 用戶端 ID'); return; }
      if (!/\.apps\.googleusercontent\.com$/.test(id)) {
        toast('用戶端 ID 看起來不對，應該以 .apps.googleusercontent.com 結尾');
        return;
      }
      window.DriveSync.setClientId(id);
      setSyncButton('idle');
      await runSync({ interactive: true });
    };
    $('#btnSyncSignOut').onclick = () => {
      window.DriveSync.signOut();
      toast('已登出，下次同步會重新要求授權');
    };
    // 匯入視窗把四種新增方式集中在一起：檔案、104 截圖、貼上整列、手動輸入
    $('#importer').addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('[data-act]');
      const act = btn && btn.dataset.act;
      if (!act) return;
      if (act === 'paste-customer') { $('#importer').hidden = true; openPasteImport(); }
      if (act === 'new-customer') { $('#importer').hidden = true; openNewCustomer(); }
    });
    $('#btnPick').onclick = () => $('#filePick').click();
    $('#filePick').onchange = (e) => {
      const files = [...e.target.files];
      // 清空選擇，否則再選同一個檔案更新名單時不會觸發 change
      e.target.value = '';
      importFiles(files);
    };
    // 手機相簿：使用者的 104 截圖都在手機上，這條路要一按就開相簿
    $('#btnShotPick').onclick = () => $('#shotPick').click();
    $('#shotPick').onchange = (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      importFiles(files);
    };

    const dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.remove('is-over');
    }));
    dz.addEventListener('drop', (e) => importFiles(e.dataTransfer.files));

    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) closeOverlays();
      if (!e.target.closest('#menu') && !e.target.closest('#btnMenu')) $('#menu').hidden = true;
    });
    $('#btnMenu').onclick = () => { $('#menu').hidden = !$('#menu').hidden; };
    $('#menu').onclick = async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      $('#menu').hidden = true;
      if (act === 'export-xlsx') exportXlsx();
      if (act === 'export-json') {
        download(`電話推廣名單備份_${todayISO()}.json`,
          JSON.stringify(await window.Store.exportAll()), 'application/json');
      }
      if (act === 'import-json') $('#jsonPick').click();
      if (act === 'theme') {
        const now = document.body.dataset.theme;
        const next = now === 'dark' ? 'light' : 'dark';
        document.body.dataset.theme = next;
        document.documentElement.dataset.theme = next;
        localStorage.setItem('theme', next);
      }
      if (act === 'sync-now') runSync({ interactive: true });
      if (act === 'sync-setup') {
        $('#clientId').value = window.DriveSync.clientId();
        $('#syncSetup').hidden = false;
        showSyncTime().then((at) => {
          $('#syncStatus').textContent = at
            ? `上次同步：${new Date(at).toLocaleString('zh-TW')}`
            : '尚未同步過';
        });
      }
      if (act === 'new-customer') openNewCustomer();
      if (act === 'registry') { openRegistryUpdate(); return; }
      if (act === 'check-update') { await checkForUpdate(true); return; }
      if (act === 'check-names') { await reviewCompanyNames(); return; }
      if (act === 'manage') {
        const sources = [...new Set(state.records.map((r) => r.source))];
        if (!sources.length) { toast('目前沒有已匯入的名單'); return; }
        const name = prompt(`目前已匯入：\n${sources.join('\n')}\n\n輸入要刪除的檔名（留空取消）：`);
        if (name && sources.includes(name.trim())) {
          const n = await window.Store.deleteSource(name.trim());
          await reload(); render();
          toast(`已刪除 ${name.trim()}（${n} 筆）`);
        }
      }
      if (act === 'wipe') {
        const synced = window.DriveSync.isConfigured();
        const total = state.records.length;
        const logs = state.logs.length;
        if (!total && !logs) { toast('名單已經是空的'); return; }
        const ok1 = confirm(`確定要清空所有名單嗎？\n\n共 ${total} 筆客戶、${logs} 則通話紀錄。`
          + (synced ? '\n\n你有開雲端同步：清除會傳到所有裝置，雲端那份也會一起清掉。' : '')
          + '\n\n此動作無法復原。按確定後會先自動下載一份備份。');
        if (!ok1) return;
        // 不可逆又會傳到所有裝置的動作，先留一份備份再動手
        download(`電話推廣名單備份_清空前_${todayISO()}.json`,
          JSON.stringify(await window.Store.exportAll()), 'application/json');
        const ok2 = confirm('備份已開始下載。\n\n再確認一次：真的要清空全部名單嗎？');
        if (!ok2) return;
        const gone = await window.Store.wipe();
        await reload(); render();
        toast(`已清除 ${gone.records} 筆客戶、${gone.logs} 則通話紀錄`);
        // 立刻同步，讓墓碑上雲端；不然要等下一次自動同步，中間別台裝置會先把舊資料推上去
        if (synced) runSync({ quiet: true });
      }
    };
    $('#jsonPick').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const incoming = JSON.parse(await file.text());
        if (!incoming || !Array.isArray(incoming.records)) throw new Error('備份檔格式不正確');
        const merged = window.DriveSync.mergeDumps(await window.Store.exportAll(), incoming);
        await window.Store.replaceAll(merged);
        await reload(); render();
        toast(`已合併備份：共 ${merged.records.length} 筆客戶、${merged.logs.length} 則通話紀錄`);
      } catch (err) {
        toast(`還原失敗：${err.message}`);
      }
      e.target.value = '';
    };

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeOverlays();
      if (e.key === '/' && document.activeElement !== $('#search')) {
        e.preventDefault();
        $('#search').focus();
      }
    });
  }

  async function init() {
    const saved = localStorage.getItem('theme');
    if (saved) {
      document.body.dataset.theme = saved;
      document.documentElement.dataset.theme = saved;
    }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = `assets/vendor/pdfjs/pdf.worker.min.js?v=${APP_VERSION}`;
    $('#menuVersion').textContent = `版本 ${APP_VERSION}`;
    wireEvents();
    await reload();
    render();
    if (window.DriveSync.isConfigured()) {
      await showSyncTime();
      runSync({ quiet: true });          // 背景靜默同步，失敗就等使用者自己按
    }
    prebuildRules();
    checkForUpdate(false);
    dropOldDossierDb();
    // 查核欄位改版了：把「今天已經跑過」的記號清掉，馬上重查一次補上新欄位
    if (registryPref('registry-fields-rev') !== REGISTRY_FIELDS_REV) {
      registryPref('registry-fields-rev', REGISTRY_FIELDS_REV);
      registryPref('registry-auto-last', '');
    }
    autoRegistryTick();
    /*
     * 每分鐘看一次日期跳了沒，跨過 0:00 就自己開跑。
     *
     * 不用「算到下一個午夜的 setTimeout」是因為筆電闔上、手機鎖屏的時候計時器
     * 不會準時醒來，睡醒之後那個時間點早就過去了；每分鐘比一次日期最不會漏，
     * 而且日期沒跳的時候 maybeAutoRegistry 只是讀一個 localStorage 就回來。
     */
    setInterval(autoRegistryTick, 60000);
    checkReminders();
    setInterval(checkReminders, 30000);
    /*
     * 切回這個分頁時再檢查一次。
     *
     * 原本只在載入時檢查，但手機上把網站加到主畫面之後常常是同一個分頁一直開著，
     * 那就永遠不會再檢查——更新了也不知道。
     */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      checkForUpdate(false);
      autoRegistryTick();   // 手機鎖了一整晚，解鎖回來就該補跑
    });
    if (!state.records.length) $('#importer').hidden = false;
  }

  init().catch((err) => {
    console.error(err);
    toast(`初始化失敗：${err.message}`);
  });
})();
