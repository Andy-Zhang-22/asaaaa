/*
 * 「新公司」分頁：經濟部每月的公司設立／變更登記清冊。
 *
 * 以前是獨立網站（leads/index.html），使用者說兩個網站分開很難用，就併進主站當一個分頁。
 * 併進來的只有畫面：清冊資料還是 GitHub Actions 每月抓成 CSV 放在 leads/ 底下，這裡用
 * fetch 讀；客戶名單（IndexedDB）完全不碰。兩邊的交集只有一條路：「加入客戶名單」把篩好的
 * 清冊組成跟 Actions 一模一樣的 CSV，送進主站現成的匯入流程（會再問一次條件、自動略過重複）。
 *
 * 成立年：變更清冊上只有「核准變更日期」，沒有設立日期。打開分頁就自動在背景拿統編查
 * 商工登記（跟「從商工登記更新公司資料」同一條路：官方 → 自架代理 → g0v 鏡像，一次一家
 * 隔 300ms），查到的存在 localStorage，設立日期不會變所以永遠不用重查。
 */
(function (global) {
  'use strict';

  const PAGE = 80;
  const DATA_BASE = 'leads/';
  const TYPE_LABEL = { change: '變更', setup: '設立' };
  const IND = { C: '製造業', E: '營造業', G: '運輸倉儲', F: '批發零售', I: '專業服務', H: '金融不動產', J: '文教育樂', A: '農林漁牧', D: '水電燃氣', B: '礦業土石', Z: '其他' };
  const IND_ORDER = ['C', 'E', 'G', 'F', 'I', 'H', 'J', 'A', 'D', 'B', 'Z'];
  const REASONS = [
    ['up', '增資／發行新股', /增資|發行新股/],
    ['owner', '負責人／董事變更', /負責人|董事|代表人/],
    ['move', '遷址', /所在地|遷/],
    ['down', '減資', /減資/],
    ['other', '其他變更', null],
  ];
  const HOLDING_RE = /投資|資產|控股|創投|管理顧問|顧問/;
  const AGE = [['lt5', '未滿 5 年'], ['ge5', '5 年以上']];
  const AGE_YEARS = 5;
  const CSV_HEAD = ['統一編號', '公司名稱', '公司所在地', '代表人', '資本額', '核准設立日期', '核准變更日期', '案由或變更事項', '營業項目', '縣市', '清冊', '期別'];

  let root = null;
  const $ = (sel) => root.querySelector(sel);
  const el = (tag, props, children) => {
    const n = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => { if (k.includes('-')) n.setAttribute(k, v); else n[k] = v; });
    (children || []).forEach((c) => { if (c !== '' && c != null) n.append(c); });
    return n;
  };
  function toast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600);
  }

  let index = null;
  let rows = [];            // 目前期別載進來的全部列
  const loaded = new Set(); // 已載入的 path
  let limit = PAGE;
  let started = false;      // 第一次切到這個分頁才去抓 index.json
  let ready = false;
  const f = { types: new Set(['change']), cities: new Set(), reasons: new Set(['up']), inds: new Set(), branches: new Set(), ages: new Set(), q: '' };

  /* ---------------- 成立年 ---------------- */

  const FOUNDED_KEY = 'leads-founded-v1';
  let founded = {};   // 統編 → 'YYYY/MM/DD'（西元）；'' ＝ 查過了，登記上查不到
  try { founded = JSON.parse(localStorage.getItem(FOUNDED_KEY) || '{}') || {}; } catch (e) { founded = {}; }
  let saveT = null;
  const saveFounded = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(FOUNDED_KEY, JSON.stringify(founded)); } catch (e) { /* 無痕 */ } }, 500); };

  /** 民國 115/08/21、西元 2026/8/21 或 2006年10月30日 → {y,m,d}；空白與「1911年0月0日」→ null */
  function parseDate(s) {
    const m = String(s || '').match(/^(\d{2,4})[/年.-](\d{1,2})[/月.-](\d{1,2})/);
    if (!m) return null;
    let y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    if (y < 1000) y += 1911;
    if (y <= 1911 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { y, m: mo, d };
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtDate = (dt) => `${dt.y}/${pad2(dt.m)}/${pad2(dt.d)}`;
  const fmtRoc = (dt) => `${dt.y - 1911}/${pad2(dt.m)}/${pad2(dt.d)}`;
  const TODAY = new Date();
  /** 滿幾年：生日還沒到就少算一年，跟算年齡一樣。 */
  function yearsSince(dt) {
    let n = TODAY.getFullYear() - dt.y;
    if (TODAY.getMonth() + 1 < dt.m || (TODAY.getMonth() + 1 === dt.m && TODAY.getDate() < dt.d)) n -= 1;
    return n;
  }
  const cachedFounded = (taxId) => (founded[taxId] ? parseDate(founded[taxId]) : null);
  const ageOf = (r) => (r.foundedDate ? (yearsSince(r.foundedDate) >= AGE_YEARS ? 'ge5' : 'lt5') : null);
  const needLookup = (r) => !r.foundedDate && founded[r['統一編號']] === undefined && /^\d{8}$/.test(r['統一編號'] || '');

  /*
   * 查設立日期的工人：一次一個（跟主站的批次更新一樣），佇列在每次重畫時重算（條件改了就換查別家），
   * gen 變了就是叫它停。連續三次連不上就停下來講，不要一直撞。
   *
   * auto：打開分頁就自己查（使用者說每次都要先按一顆鈕很難用）；paused：使用者按了暫停，
   * 或連不上停下來的，要等使用者按「繼續」才會再動。查的都是「套用其他條件後還在名單上」的公司。
   */
  const hunt = { gen: 0, active: 0, queue: [], dirty: true, pending: new Set(), fail: 0, paused: '', auto: true };
  const stopHunt = () => { hunt.gen += 1; hunt.queue = []; hunt.pending.clear(); hunt.fail = 0; };
  function ensureHunt() {
    if (!global.Registry) { hunt.paused = '找不到查詢程式 registry.js，沒辦法查設立日期。'; return; }
    hunt.dirty = true;
    if (!hunt.active) huntWorker(hunt.gen);
  }
  // 節流不是防抖：結果每 300ms 來一筆，「有新的就重新計時」會讓畫面到整批查完才動一次
  let renderT = null;
  const scheduleRender = () => { if (renderT) return; renderT = setTimeout(() => { renderT = null; render(); }, 600); };
  async function huntWorker(gen) {
    hunt.active += 1;
    let did = 0;   // 這個工人真的查到東西才在收工時重畫；沒事做的工人不重畫，不然 render → ensureHunt → 又派工人，繞不完
    try {
      while (gen === hunt.gen && hunt.auto && !hunt.paused) {
        if (hunt.dirty) {
          const c = criteria();
          hunt.queue = [...new Set(rows.filter((r) => needLookup(r) && !hunt.pending.has(r['統一編號']) && passes(r, c, 'ages')).map((r) => r['統一編號']))];
          hunt.dirty = false;
        }
        const id = hunt.queue.shift();
        if (!id) break;
        if (founded[id] !== undefined || hunt.pending.has(id)) continue;
        hunt.pending.add(id);
        let res;
        // 主站批次更新用的就是 lookupCompany + useMirror：統編查不齊會自己用名稱補
        const name = (rows.find((r) => r['統一編號'] === id) || {})['公司名稱'] || '';
        try { res = await global.Registry.lookupCompany({ taxId: id, name }, { useMirror: true }); }
        catch (err) { res = { ok: false, attempts: [], reason: String((err && err.message) || err) }; }
        hunt.pending.delete(id);
        if (gen !== hunt.gen) break;
        if (res.ok) {
          const dt = parseDate(res.data && res.data.founded);
          founded[id] = dt ? fmtDate(dt) : '';
          hunt.fail = 0;
        } else if (/^用名稱查到/.test(res.reason || '') || (res.attempts || []).some((a) => /查無資料|部分欄位/.test(a.reason || ''))) {
          // 有連上、但登記上查不到（或名稱查到的統編對不上）：記下來，不要一直重查。
          // 連不上的長相是每一次嘗試都被擋或逾時，那種才算失敗
          founded[id] = '';
          hunt.fail = 0;
        } else {
          hunt.fail += 1;
          if (hunt.fail >= 3) {
            hunt.paused = '商工登記連不上（官方、自架代理、g0v 鏡像都不通），先停下來；按「繼續」會從沒查到的接著查。';
            toast('商工登記連不上，成立年先停下來；等一下按「繼續」再查');
            stopHunt();
            break;
          }
          continue;
        }
        rows.forEach((r) => { if (r['統一編號'] === id) r.foundedDate = cachedFounded(id); });
        did += 1;
        saveFounded();
        scheduleRender();
        await new Promise((done) => setTimeout(done, 300));
      }
    } finally {
      hunt.active -= 1;
      // 最後一個工人收工就馬上重畫，不要讓名單還停在 600ms 前的樣子
      if (!hunt.active && did) { clearTimeout(renderT); renderT = null; render(); }
      else foundedBar();
    }
  }
  /** 目前名單（套用成立年數以外的條件）的成立年：已知幾家、登記上查不到幾家、還有幾家沒查。 */
  function foundedStatus() {
    const c = criteria();
    let known = 0; let none = 0; let todo = 0;
    rows.forEach((r) => {
      if (!passes(r, c, 'ages')) return;
      if (r.foundedDate) known += 1;
      else if (founded[r['統一編號']] === '' || !/^\d{8}$/.test(r['統一編號'] || '')) none += 1;
      else todo += 1;
    });
    return { known, none, todo };
  }
  /** 名單上方那一行：成立年查到哪了，跟暫停／繼續。全部查完就收起來。 */
  function foundedBar() {
    const bar = $('#leads-founded');
    if (!bar || !ready) return;
    const st = foundedStatus();
    const running = hunt.active > 0 && !hunt.paused;
    bar.hidden = !st.todo && !hunt.paused;
    if (bar.hidden) return;
    const text = `成立年：已知 ${st.known.toLocaleString()} 家${st.none ? `、登記上查不到 ${st.none} 家` : ''}、還有 ${st.todo.toLocaleString()} 家${running ? '，查詢中…' : ''}`;
    $('#leads-founded-text').textContent = hunt.paused ? `${text}　${hunt.paused}` : text;
    const btn = $('#leads-founded-btn');
    btn.textContent = running ? '暫停' : '繼續';
    btn.hidden = !st.todo && !hunt.paused;
  }
  function toggleHunt() {
    if (hunt.active > 0 && !hunt.paused) {
      stopHunt();
      hunt.paused = '已暫停；查到的都留著。';
      render();
      return;
    }
    hunt.paused = '';
    hunt.auto = true;
    render();
  }

  /* ---------------- 資料 ---------------- */

  /** 歸屬分公司：跟主站 view() 算 branchKey 的方式一樣，籤上才會是同一個字。 */
  function branchOf(address) {
    if (!global.Rules || !global.Normalize) return { key: '', label: '' };
    const { city, district } = global.Normalize.parseAddress(address);
    const b = global.Rules.branchOf(city, district);
    const key = b.kind === 'branch' ? `${b.branches[0]}分公司`
      : b.kind === 'common' ? `${b.branches.join('／')}共同區`
      : b.kind === 'shared' ? '全公司共同區域'
      : (city ? '不在劃分表上' : '無登記地址');
    return { key, label: b.label || key, kind: b.kind };
  }

  /** 正規的 CSV 解析：欄位裡有逗號、引號、換行都吃得下。 */
  function parseCsv(text) {
    const out = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const src = text.replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); out.push(row); }
    return out.filter((r) => r.length > 1 || (r[0] || '').trim());
  }
  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

  function toRecord(obj, file) {
    const codes = (obj['營業項目'] || '').match(/\b[A-Z]{1,2}\d{5,6}\b/g) || [];
    const classes = [...new Set(codes.map((c) => c[0]))];
    const reason = obj['案由或變更事項'] || '';
    let rk = '';
    if (file.type === 'change') { rk = 'other'; for (const [k, , re] of REASONS) { if (re && re.test(reason)) { rk = k; break; } } }
    const branch = branchOf(obj['公司所在地']);
    return {
      ...obj, file, city: file.city, type: file.type, branch,
      capital: Number(String(obj['資本額'] || '').replace(/\D/g, '')) || 0,
      date: obj['核准設立日期'] || obj['核准變更日期'] || '',
      // 設立清冊用清冊上的；變更清冊看之前查過沒有
      foundedDate: parseDate(obj['核准設立日期']) || cachedFounded(obj['統一編號']),
      reason, rk, classes,
      holding: HOLDING_RE.test(obj['公司名稱'] || '') && !classes.some((c) => 'CEG'.includes(c)),
      blob: [obj['統一編號'], obj['公司名稱'], obj['代表人'], obj['公司所在地'], obj['營業項目'], reason].join(' ').toLowerCase(),
    };
  }

  async function loadFile(file) {
    if (loaded.has(file.path)) return;
    // 檔案路徑帶期別（11508/新北市-change.csv），不同期不會撞
    const res = await fetch(`${DATA_BASE}${file.path}?t=${index.generatedAt}`, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`${file.path}：HTTP ${res.status}`);
    const table = parseCsv(await res.text());
    const head = table[0];
    table.slice(1).forEach((r) => { const o = {}; head.forEach((h, i) => { o[h] = r[i] || ''; }); rows.push(toRecord(o, file)); });
    loaded.add(file.path);
  }

  /** 目前勾的縣市與清冊需要哪些檔；沒載的就去載。 */
  const periodFiles = () => {
    const period = $('#leads-period').value;
    if (period === 'all') return Object.keys(index.periods).sort().flatMap((k) => (index.periods[k].files || []).map((x) => ({ ...x, period: k })));
    return ((index.periods[period] || {}).files || []).map((x) => ({ ...x, period }));
  };
  async function ensureLoaded() {
    const files = periodFiles().filter((x) => f.types.has(x.type) && (!f.cities.size || f.cities.has(x.city)));
    const todo = files.filter((x) => !loaded.has(x.path));
    if (!todo.length) return;
    $('#leads-loading').hidden = false;
    $('#leads-loading').textContent = `下載清冊… ${todo.map((x) => `${x.city}${TYPE_LABEL[x.type]}`).join('、')}`;
    try { await Promise.all(todo.map(loadFile)); }
    catch (err) { toast(`下載失敗：${err.message}`); }
    $('#leads-loading').hidden = true;
  }

  /*
   * 一列過不過得了篩選；except 是「這一組先不算」，給篩選籤上的數字用：
   * 籤上的數字要回答「勾了這顆會剩幾家」，所以要套用其他所有條件、唯獨不套自己那一組。
   */
  function criteria() {
    return {
      period: $('#leads-period').value,
      min: (Number($('#leads-capMin').value) || 0) * 10000,
      max: (Number($('#leads-capMax').value) || 0) * 10000 || Infinity,
      skipHolding: $('#leads-skipHolding').checked,
      terms: f.q.trim().toLowerCase().split(/\s+/).filter(Boolean),
    };
  }
  function passes(r, c, except) {
    return (c.period === 'all' || r['期別'] === c.period)
      && (except === 'types' || f.types.has(r.type))
      && (except === 'cities' || !f.cities.size || f.cities.has(r.city))
      && (except === 'reasons' || r.type !== 'change' || !f.reasons.size || f.reasons.has(r.rk))
      && (except === 'inds' || !f.inds.size || r.classes.some((k) => f.inds.has(k)))
      && (except === 'branches' || !f.branches.size || f.branches.has(r.branch.key))
      && (except === 'ages' || !f.ages.size || f.ages.has(ageOf(r)))
      && r.capital >= c.min && r.capital <= c.max
      && !(c.skipHolding && r.holding)
      && c.terms.every((t) => r.blob.includes(t));
  }
  function visible() {
    const c = criteria();
    const list = rows.filter((r) => passes(r, c, null));
    const sort = $('#leads-sort').value;
    list.sort((a, b) => (sort === 'capital' ? b.capital - a.capital
      : sort === 'date' ? (b.date || '').localeCompare(a.date || '')
        : (a['公司名稱'] || '').localeCompare(b['公司名稱'] || '', 'zh-Hant')));
    return list;
  }

  /* ---------------- 畫面 ---------------- */

  const wan = (n) => (n >= 1e8 ? `${(n / 1e8).toFixed(n % 1e8 ? 1 : 0)} 億` : `${Math.round(n / 1e4).toLocaleString()} 萬`);
  function card(r) {
    const reasonBadge = r.type === 'setup' ? el('span', { className: 'badge badge-new', textContent: '新設立' })
      : r.rk === 'up' ? el('span', { className: 'badge badge-up', textContent: r.reason })
        : r.rk === 'down' ? el('span', { className: 'badge badge-down', textContent: r.reason })
          : el('span', { className: 'badge', textContent: r.reason || '變更' });
    const name = el('span', { className: 'card-name' }, [r['統一編號']
      ? el('a', { href: `https://findbiz.nat.gov.tw/fts/company/${encodeURIComponent(r['統一編號'])}`, target: '_blank', rel: 'noopener', textContent: r['公司名稱'] })
      : document.createTextNode(r['公司名稱'])]);
    const inds = r.classes.filter((c) => IND[c]).slice(0, 2).map((c) => el('span', { className: 'badge badge-ind', textContent: IND[c] }));
    const items = (r['營業項目'] || '').split('；').filter(Boolean);
    const all = $('#leads-period').value === 'all';
    return el('article', { className: `card leads-card${r.rk === 'up' ? ' is-up' : ''}` }, [
      el('div', { className: 'card-top' }, [name, reasonBadge, ...inds,
        r.branch.key ? el('span', { className: `badge badge-branch${r.branch.kind === 'common' ? ' badge-branch-common' : ''}`, textContent: r.branch.key, title: r.branch.label }) : '',
        r.holding ? el('span', { className: 'badge badge-ind', textContent: '投資／控股類' }) : '']),
      el('div', { className: 'card-meta' }, [
        el('span', { textContent: `💰 ${wan(r.capital)}` }),
        r['代表人'] ? el('span', { textContent: `👤 ${r['代表人']}` }) : '',
        el('span', {}, ['📍 ', el('a', { href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r['公司所在地'])}`, target: '_blank', rel: 'noopener', textContent: r['公司所在地'] })]),
        el('span', { textContent: `📅 ${r.date}${r.type === 'setup' ? ' 設立' : ' 核准變更'}${all ? `（${r['期別'].slice(0, 3)}/${+r['期別'].slice(3)} 清冊）` : ''}` }),
        // 變更清冊的成立日期是查商工登記來的，秀出來讓人對得上；設立清冊上面那行就是了
        r.type !== 'setup' && r.foundedDate ? el('span', { textContent: `🎂 成立 ${fmtRoc(r.foundedDate)}（${yearsSince(r.foundedDate)} 年）` }) : '',
        el('span', { textContent: `#${r['統一編號']}` }),
      ]),
      items.length ? el('p', { className: 'leads-items', textContent: `${items.slice(0, 4).join('　')}${items.length > 4 ? `　…共 ${items.length} 項` : ''}` }) : '',
    ]);
  }

  function chips(host, options, set) {
    host.textContent = '';
    options.forEach(([value, label, count]) => {
      const approx = String(count).startsWith('~');
      const b = el('button', { className: `chip${approx ? ' is-approx' : ''}`, type: 'button', title: approx ? '這份清冊還沒下載，這是總數；勾了才會照條件算' : '' }, [document.createTextNode(label), count != null ? el('small', { textContent: String(count) }) : '']);
      b.setAttribute('aria-pressed', String(set.has(value)));
      b.onclick = async () => {
        if (set.has(value)) set.delete(value); else set.add(value);
        [...host.children].forEach((c, i) => c.setAttribute('aria-pressed', String(set.has(options[i][0]))));
        limit = PAGE;
        await ensureLoaded();
        render();
      };
      host.append(b);
    });
  }

  /** 所有篩選籤的數字：套用其他條件之後這顆會剩幾家。還沒下載的清冊只能寫總數，前面加 ~。 */
  function drawChips() {
    const c = criteria();
    const files = periodFiles();
    const isLoaded = (subset) => subset.length > 0 && subset.every((x) => loaded.has(x.path));
    const total = (subset) => subset.reduce((n, x) => n + x.rows, 0);
    const facet = (except, pred) => { let n = 0; rows.forEach((r) => { if (pred(r) && passes(r, c, except)) n += 1; }); return n; };
    chips($('#leads-fType'), ['change', 'setup'].map((t) => {
      const need = files.filter((x) => x.type === t && (!f.cities.size || f.cities.has(x.city)));
      return [t, TYPE_LABEL[t], isLoaded(need) ? facet('types', (r) => r.type === t) : `~${total(need)}`];
    }), f.types);
    const cities = [...new Set(files.map((x) => x.city))];
    chips($('#leads-fCity'), cities.map((city) => {
      const need = files.filter((x) => x.city === city && f.types.has(x.type));
      return [city, city, isLoaded(need) ? facet('cities', (r) => r.city === city) : `~${total(need)}`];
    }), f.cities);
    chips($('#leads-fReason'), REASONS.map(([k, label]) => [k, label, facet('reasons', (r) => r.type === 'change' && r.rk === k)]), f.reasons);
    chips($('#leads-fInd'), IND_ORDER.map((k) => [k, IND[k], facet('inds', (r) => r.classes.includes(k))]), f.inds);
    // 成立年數：只算已經知道設立日期的；還沒查的在名單上方那一行
    chips($('#leads-fAge'), AGE.map(([k, label]) => [k, label, facet('ages', (r) => ageOf(r) === k)]), f.ages);
    // 分公司：籤是從載進來的列長出來的（清冊裡沒有這一欄），分公司在前、共同區在後、劃分表外最後
    const counts = new Map();
    rows.forEach((r) => { if (r.branch.key && passes(r, c, 'branches')) counts.set(r.branch.key, (counts.get(r.branch.key) || 0) + 1); });
    const order = (k) => (/分公司$/.test(k) ? 0 : /共同區$/.test(k) ? 1 : 2);
    const keys = [...new Set([...counts.keys(), ...f.branches])].sort((a, b) => order(a) - order(b) || (counts.get(b) || 0) - (counts.get(a) || 0));
    if (!keys.length) { $('#leads-fBranch').textContent = ''; $('#leads-fBranch').append(el('span', { className: 'muted', textContent: '（載入清冊後才算得出來）' })); }
    else chips($('#leads-fBranch'), keys.map((k) => [k, k, counts.get(k) || 0]), f.branches);
  }

  let current = [];
  function render() {
    if (!ready) return;
    // 先派工人再畫：工人一派下去 hunt.active 就是 1，進度那一行這一輪就畫得出來
    if (hunt.auto && !hunt.paused) ensureHunt();
    drawChips();
    foundedBar();
    current = visible();
    const host = $('#leads-cards');
    host.textContent = '';
    current.slice(0, limit).forEach((r) => host.append(card(r)));
    const up = current.filter((r) => r.rk === 'up').length;
    const period = $('#leads-period').value;
    $('#leads-count').innerHTML = `符合 <b>${current.length.toLocaleString()}</b> 家${up ? `，其中增資 ${up} 家` : ''}<span class="muted">　／ ${period === 'all' ? '全部期別' : '本期'}已載入 ${rows.filter((r) => period === 'all' || r['期別'] === period).length.toLocaleString()} 家</span>`;
    $('#leads-more').hidden = current.length <= limit;
    $('#leads-empty').hidden = !!current.length;
    $('#leads-empty').textContent = rows.length ? '沒有符合條件的公司，放寬資本額或案由試試。' : '';
    $('#leads-add').disabled = !current.length;
    $('#leads-export').disabled = !current.length;
    $('#leads-copy').disabled = !current.length;
    const pill = document.getElementById('countLeads');
    if (pill) pill.textContent = current.length.toLocaleString();
  }

  /** 篩好的名單組成跟 Actions 產的一模一樣的 CSV（變更清冊查到的設立日期也填進去，主站匯入就有成立年）。 */
  function toCsv(list) {
    const cell = (r, h) => r[h] || (h === '核准設立日期' && r.foundedDate ? fmtRoc(r.foundedDate) : '');
    const lines = [CSV_HEAD, ...list.map((r) => CSV_HEAD.map((h) => cell(r, h)))].map((row) => row.map(csvCell).join(','));
    return `﻿${lines.join('\n')}\n`;
  }
  const csvName = () => `登記清冊-${$('#leads-period').value === 'all' ? '全部期別' : $('#leads-period').value}-${current.length}家.csv`;

  function build() {
    root.textContent = '';
    const group = (label, node, forId) => el('div', { className: 'leads-group' }, [
      forId ? el('label', { htmlFor: forId, textContent: label }) : el('span', { className: 'lbl', textContent: label }), node]);
    const filters = el('details', { className: 'leads-filters', id: 'leads-filters' }, [
      el('summary', {}, [el('strong', { textContent: '篩選' }), el('span', { className: 'muted', id: 'leads-filter-sum', textContent: '' })]),
      el('p', { className: 'muted leads-hint', textContent: '籤上的數字＝套用其他條件後這一顆會剩幾家；帶 ~ 的清冊還沒下載，勾了才會照條件算。' }),
      group('期別', el('select', { id: 'leads-period' }), 'leads-period'),
      group('清冊', el('div', { className: 'chips', id: 'leads-fType' })),
      group('縣市', el('div', { className: 'chips', id: 'leads-fCity' })),
      group('歸屬分公司（依登記地址，同「規則」的劃分表）', el('div', { className: 'chips', id: 'leads-fBranch' })),
      group('案由（變更清冊）', el('div', { className: 'chips', id: 'leads-fReason' })),
      group('行業（依營業項目大類）', el('div', { className: 'chips', id: 'leads-fInd' })),
      group('成立年數（依核准設立日期；變更清冊的是查商工登記來的）', el('div', { className: 'chips', id: 'leads-fAge' })),
      group('資本額（萬元）', el('div', { className: 'leads-row' }, [
        el('input', { id: 'leads-capMin', type: 'number', min: '0', step: '100', placeholder: '下限', value: '500' }), '～',
        el('input', { id: 'leads-capMax', type: 'number', min: '0', step: '100', placeholder: '上限', value: '6000' })])),
      el('div', { className: 'leads-group' }, [el('label', {}, [el('input', { type: 'checkbox', id: 'leads-skipHolding', checked: true }), ' 略過投資／控股類（沒有設備標的）'])]),
      group('關鍵字', el('input', { id: 'leads-q', type: 'search', placeholder: '公司、統編、代表人、地址、營業項目', autocomplete: 'off' }), 'leads-q'),
      group('排序', el('select', { id: 'leads-sort' }, [
        el('option', { value: 'capital', textContent: '資本額（高到低）' }),
        el('option', { value: 'date', textContent: '日期（新到舊）' }),
        el('option', { value: 'company', textContent: '公司名稱' })]), 'leads-sort'),
      el('div', { className: 'leads-row' }, [el('button', { className: 'btn btn-tiny', id: 'leads-reset', type: 'button', textContent: '清除篩選' })]),
    ]);
    // 桌面版預設展開，手機上先看到名單
    filters.open = !matchMedia('(max-width: 760px)').matches;
    root.append(
      el('p', { className: 'muted leads-sub', id: 'leads-sub', textContent: '經濟部每月公司設立／變更登記清冊' }),
      filters,
      el('div', { className: 'leads-head' }, [
        el('div', { className: 'leads-count', id: 'leads-count', textContent: '—' }),
        el('div', { className: 'leads-row' }, [
          el('button', { className: 'btn btn-primary', id: 'leads-add', type: 'button', title: '把目前篩出來的公司送進「新增客戶」的匯入流程，會再問一次條件、已經在名單裡的會略過', textContent: '加入客戶名單' }),
          el('button', { className: 'btn', id: 'leads-copy', type: 'button', textContent: '複製統編' }),
          el('button', { className: 'btn', id: 'leads-export', type: 'button', textContent: '匯出 CSV' }),
        ]),
      ]),
      el('div', { className: 'leads-loading', id: 'leads-loading', hidden: true }),
      el('div', { className: 'leads-founded', id: 'leads-founded', hidden: true }, [
        el('span', { id: 'leads-founded-text' }),
        el('button', { className: 'btn btn-tiny', id: 'leads-founded-btn', type: 'button', textContent: '暫停' })]),
      el('div', { className: 'cards', id: 'leads-cards' }),
      el('div', { className: 'empty', id: 'leads-empty', hidden: true }),
      el('div', { className: 'leads-row leads-more' }, [el('button', { className: 'btn', id: 'leads-more', type: 'button', textContent: '載入更多', hidden: true })]),
      el('p', { className: 'muted leads-foot', textContent: '資料來源：經濟部商工登記「公司所營事業項目清冊」，GitHub Actions 每月 8 日自動抓取（清冊在次月初產製，8 月的清冊 9 月初才有）。這裡不存任何客戶資料；成立年是用統編查商工登記來的，查到的留在這台瀏覽器省得重查。' }),
    );
  }

  async function start() {
    if (started) return;
    started = true;
    build();
    try {
      const res = await fetch(`${DATA_BASE}index.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      index = await res.json();
    } catch (err) {
      $('#leads-empty').hidden = false;
      $('#leads-empty').textContent = '還沒有抓好的清冊。GitHub Actions 每月 8 日會自動抓，也可以到 repo 的 Actions 頁手動執行「每月新公司清冊」。';
      $('#leads-count').textContent = '—';
      return;
    }
    const periods = Object.keys(index.periods || {}).sort().reverse();
    periods.forEach((k) => $('#leads-period').append(el('option', { value: k, textContent: `${k.slice(0, 3)} 年 ${+k.slice(3)} 月` })));
    // 跨月份一次篩：找「最近半年增資的製造業」這種問題，一個月一個月切換很煩
    if (periods.length > 1) $('#leads-period').append(el('option', { value: 'all', textContent: `全部期別（${periods.length} 期）` }));
    $('#leads-sub').textContent = `經濟部每月公司設立／變更登記清冊　·　最近更新 ${String(index.generatedAt || '').slice(0, 10).replace(/-/g, '/')}`;
    ready = true;
    const rerender = async () => { limit = PAGE; await ensureLoaded(); render(); };
    $('#leads-period').onchange = async () => { await rerender(); };
    $('#leads-capMin').oninput = () => { limit = PAGE; render(); };
    $('#leads-capMax').oninput = () => { limit = PAGE; render(); };
    $('#leads-skipHolding').onchange = () => { limit = PAGE; render(); };
    $('#leads-sort').onchange = () => { limit = PAGE; render(); };
    let qt = null;
    $('#leads-q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { f.q = e.target.value; limit = PAGE; render(); }, 120); };
    $('#leads-more').onclick = () => { limit += PAGE; render(); };
    $('#leads-founded-btn').onclick = toggleHunt;
    $('#leads-reset').onclick = async () => {
      f.types.clear(); f.types.add('change'); f.cities.clear(); f.reasons.clear(); f.reasons.add('up'); f.inds.clear(); f.branches.clear(); f.ages.clear(); f.q = '';
      $('#leads-q').value = ''; $('#leads-capMin').value = '500'; $('#leads-capMax').value = '6000'; $('#leads-skipHolding').checked = true;
      await rerender();
    };
    /*
     * 加入客戶名單：組成跟 Actions 產的 CSV 一模一樣的檔案，交給主站現成的匯入流程
     * （認得「統一編號、公司名稱、公司所在地、代表人、資本額」就是登記清冊，會再問一次
     * 資本額、地區條件，已經在名單裡的自動略過）。不另寫一條匯入路，客戶名單的邏輯不動。
     */
    $('#leads-add').onclick = () => {
      if (typeof global.importLeadsFile !== 'function') { toast('主站還沒準備好匯入，請重新整理再試'); return; }
      const file = new File([toCsv(current)], csvName(), { type: 'text/csv' });
      global.importLeadsFile(file);
    };
    $('#leads-export').onclick = () => {
      const blob = new Blob([toCsv(current)], { type: 'text/csv;charset=utf-8' });
      const a = el('a', { href: URL.createObjectURL(blob), download: csvName() });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast(`已匯出 ${current.length} 家`);
    };
    $('#leads-copy').onclick = async () => {
      const text = current.map((r) => r['統一編號']).filter(Boolean).join('\n');
      try { await navigator.clipboard.writeText(text); toast(`已複製 ${current.length} 個統編`); }
      catch (e) { toast('這個瀏覽器不讓網頁複製'); }
    };
    await rerender();
  }

  /** 主站切到「新公司」分頁時叫這個；第一次才真的去抓資料。 */
  function show() {
    if (!root) root = document.getElementById('paneLeads');
    if (!root) return;
    start().catch((err) => { console.error(err); toast(`新公司名單載入失敗：${err.message}`); });
  }

  global.Leads = { show, parseDate, yearsSince, parseCsv, csvCell, AGE_YEARS };
})(window);
