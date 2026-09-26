/*
 * 「快到期」分頁：新北市動產擔保登記清冊，找同業契約快到期的客戶。
 *
 * 動產抵押、附條件買賣都要向新北市經發局登記，清冊是公開的，上面有債務人與債權人的
 * 統編、契約起迄、擔保金額、標的物。同業（新鑫、和潤、合迪、日盛…）的客戶契約快到期，
 * 就是換約的時機——這一頁就是把那些公司按到期日排出來。
 *
 * 資料由 GitHub Actions 每月抓好放在 leads/chattel/（tools/fetch-chattel.mjs），
 * 誰是客戶、誰是金主在那邊就分好了；這裡只讀 CSV、篩選、畫卡片。
 * 跟客戶名單的交集有兩條路，都不另寫邏輯：
 *   - 「已在名單」是在瀏覽器裡拿統編對 IndexedDB 裡的名單，名單不會上傳到任何地方。
 *   - 「加入客戶名單」組成一份標準欄位的 CSV，送進主站現成的匯入流程（自動略過重複、
 *     吃排除名單），動保的資訊寫在訪談內容裡。
 * 「這家不用了」記在 localStorage：只是不想再看到，不是刪客戶，所以不進同步。
 */
(function (global) {
  'use strict';

  const PAGE = 80;
  const DATA_BASE = 'leads/chattel/';
  const HIDDEN_KEY = 'chattel-hidden-v1';
  const DUE = [['m3', '3 個月內', 92], ['m6', '6 個月內', 183], ['m12', '12 個月內', 366], ['expired', '已過期、還沒註銷', -1], ['all', '全部', Infinity]];
  // 金主家族：同一家的分公司、舊名都歸一起，籤才不會一長串
  const LENDERS = [
    ['chailease', '中租', /中租/], ['sinxin', '新鑫', /新鑫/], ['hotai', '和潤', /和潤/], ['hedi', '合迪', /合迪/],
    ['jih', '日盛', /日盛/], ['orix', '歐力士', /歐力士/], ['taishin', '台新', /台新/], ['first', '第一', /第一租賃|一銀租賃/],
    ['yulon', '裕融', /裕融|裕隆/], ['bank', '銀行', /銀行|商銀|農會|漁會|信用合作社|信合社/], ['insure', '保險／資融', /人壽|保險|資融/],
    ['other', '其他（含設備商）', null],
  ];
  const LENDER_RE = /租賃|銀行|商銀|融資|資融|金融|信託|保險|資產管理|信用合作社|信合社|農會|漁會|票券|中租|和潤|新鑫|合迪|裕融|日盛|租賃業/;
  const CSV_HEAD = ['公司名稱', '統編', '電話', '地址', '訪談內容'];

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

  /* ---------------- 純邏輯（測試會叫） ---------------- */

  /** 2026/10/14 或 2026-10-14 → Date（當地時間 0 點）；空白或格式不對 → null。 */
  function parseYmd(s) {
    const m = String(s || '').match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  /** 契約迄日離今天幾天：正＝還有幾天、0＝今天、負＝過期幾天；沒日期＝null。 */
  function daysLeft(end, today) {
    const e = parseYmd(end);
    if (!e) return null;
    return Math.round((dayStart(e) - dayStart(today || new Date())) / 86400000);
  }
  function dueOf(days) {
    if (days == null) return 'none';
    if (days < 0) return 'expired';
    if (days <= 92) return 'm3';
    if (days <= 183) return 'm6';
    if (days <= 366) return 'm12';
    return 'later';
  }
  const passesDue = (key, days) => key === 'all' || (days != null && (key === 'expired' ? days < 0 : days >= 0 && days <= DUE.find((d) => d[0] === key)[2]));
  function lenderFamily(name) {
    for (const [k, , re] of LENDERS) if (re && re.test(name || '')) return k;
    return 'other';
  }
  const lenderLabel = (k) => (LENDERS.find((x) => x[0] === k) || [])[1] || '其他';
  const typeShort = (t) => String(t || '').replace(/登記$/, '') || '動保';
  const wan = (n) => (n >= 1e8 ? `${(n / 1e8).toFixed(n % 1e8 ? 1 : 0)} 億` : `${Math.round(n / 1e4).toLocaleString()} 萬`);
  const dueText = (days) => (days == null ? '' : days < 0 ? `已過期 ${-days} 天` : days === 0 ? '今天到期' : `還有 ${days} 天到期`);
  /**
   * 寫進訪談內容的那一行。日期用 - 不用 /：主站的訪談內容會把 2026/10/14 這種當成一筆通話
   * 紀錄的日期，契約日期就會變成「最近聯絡日」。
   */
  function noteFor(r) {
    const dash = (s) => String(s || '').replace(/\//g, '-');
    return [`動保：${r.lender.name || '不明'}（${typeShort(r.type)}）擔保 ${wan(r.amount)}`,
      `契約 ${dash(r.start)}～${dash(r.end)}${r.days != null ? `（${dueText(r.days)}）` : ''}`,
      r.items ? `標的 ${r.items} 件` : '', r.addr ? `標的物所在地：${r.addr}` : '', r.no ? `登記 ${r.no}` : ''].filter(Boolean).join('，');
  }

  /** 正規的 CSV 解析：欄位裡有逗號、引號、換行都吃得下。 */
  function parseCsv(text) {
    if (global.Leads && global.Leads.parseCsv) return global.Leads.parseCsv(text);
    const out = []; let row = []; let cell = ''; let quoted = false;
    const src = text.replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch; }
      else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); out.push(row); }
    return out.filter((r) => r.length > 1 || (r[0] || '').trim());
  }
  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

  function branchOf(address) {
    if (!global.Rules || !global.Normalize) return { key: '', label: '', district: '' };
    const { city, district } = global.Normalize.parseAddress(address);
    const b = global.Rules.branchOf(city, district);
    const key = b.kind === 'branch' ? `${b.branches[0]}分公司`
      : b.kind === 'common' ? `${b.branches.join('／')}共同區`
      : b.kind === 'shared' ? '全公司共同區域'
      : (city ? '不在劃分表上' : '無地址');
    return { key, label: b.label || key, kind: b.kind, district: city ? `${city}${district}` : '' };
  }

  /** CSV 的一列 → 畫面用的物件。today 可傳進來，測試才好固定。 */
  function toRecord(o, today) {
    const r = {
      type: o['案件類別'] || '', no: o['登記編號'] || '',
      cust: { id: (o['客戶統編'] || '').trim(), name: (o['客戶名稱'] || '').trim() },
      lender: { id: (o['金主統編'] || '').trim(), name: (o['金主名稱'] || '').trim() },
      start: o['契約起'] || '', end: o['契約迄'] || '',
      amount: Number(String(o['擔保金額'] || '').replace(/\D/g, '')) || 0,
      addr: o['標的物所在地'] || '', items: Number(o['標的物件數'] || o['標的物'] || 0) || 0, approved: o['登記核准日'] || '',
    };
    r.days = daysLeft(r.end, today);
    r.due = dueOf(r.days);
    r.family = lenderFamily(r.lender.name);
    r.custIsFin = LENDER_RE.test(r.cust.name);
    r.branch = branchOf(r.addr);
    r.key = r.no || `${r.cust.id}|${r.lender.id}|${r.end}`;
    r.blob = [r.cust.id, r.cust.name, r.lender.name, r.addr, r.no, r.type].join(' ').toLowerCase();
    return r;
  }

  /* ---------------- 狀態 ---------------- */

  let index = null;
  let rows = [];
  let limit = PAGE;
  let started = false;
  let ready = false;
  let showHidden = false;
  const f = { due: 'm6', lenders: new Set(), types: new Set(), branches: new Set(), districts: new Set(), mine: new Set(), q: '' };
  let hidden = new Set();
  try { hidden = new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')); } catch (e) { hidden = new Set(); }
  const saveHidden = () => { try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden])); } catch (e) { /* 無痕 */ } };

  /** 跟名單比對：統編優先，沒統編才比公司名。每次畫都重算（主站的 allViews 有快取，便宜）。 */
  function customerMap() {
    const byTax = new Map();
    const byName = new Map();
    const views = typeof global.customerViews === 'function' ? global.customerViews() : [];
    views.forEach((v) => {
      const tax = String(v.taxId || '').replace(/\D/g, '');
      if (tax && !byTax.has(tax)) byTax.set(tax, v);
      if (v.company && !byName.has(v.company)) byName.set(v.company, v);
    });
    return { byTax, byName };
  }
  const mineOf = (r, cm) => (r.cust.id && cm.byTax.get(r.cust.id.replace(/\D/g, ''))) || (r.cust.name && cm.byName.get(r.cust.name)) || null;
  // 主站只有「禁止推廣」這一種不能打的狀態（婉拒算已聯絡，還是可以再打）
  const declined = (v) => !!v && (v.blocked || v.outcome === 'blocked');

  function criteria() {
    return {
      min: (Number($('#chattel-amtMin').value) || 0) * 10000,
      max: (Number($('#chattel-amtMax').value) || 0) * 10000 || Infinity,
      hideFin: $('#chattel-hideFin').checked,
      terms: f.q.trim().toLowerCase().split(/\s+/).filter(Boolean),
      cm: customerMap(),
    };
  }
  /*
   * 一列過不過得了篩選；except 是「這一組先不算」，給篩選籤上的數字用。
   * 金主沒勾＝同業全部，但中租自家不算（自家的客戶不是要搶的對象）；要看自家就勾它。
   */
  function passes(r, c, except) {
    const mine = mineOf(r, c.cm);
    return (except === 'due' || passesDue(f.due, r.days))
      && (except === 'lenders' || (f.lenders.size ? f.lenders.has(r.family) : r.family !== 'chailease'))
      && (except === 'types' || !f.types.size || f.types.has(r.type))
      && (except === 'branches' || !f.branches.size || f.branches.has(r.branch.key))
      && (except === 'districts' || !f.districts.size || f.districts.has(r.branch.district))
      && (except === 'mine' || !f.mine.size || f.mine.has(mine ? (declined(mine) ? 'declined' : 'in') : 'out'))
      && r.amount >= c.min && r.amount <= c.max
      && !(c.hideFin && r.custIsFin)
      && (showHidden || !hidden.has(r.key))
      && c.terms.every((t) => r.blob.includes(t));
  }
  function visible(c) {
    const list = rows.filter((r) => passes(r, c, null));
    const sort = $('#chattel-sort').value;
    list.sort((a, b) => (sort === 'amount' ? b.amount - a.amount
      : sort === 'company' ? a.cust.name.localeCompare(b.cust.name, 'zh-Hant')
        : (a.days == null ? 1e9 : a.days) - (b.days == null ? 1e9 : b.days)));
    return list;
  }

  /* ---------------- 畫面 ---------------- */

  const mmdd = (iso) => { const m = String(iso || '').match(/^\d{4}-(\d{2})-(\d{2})/); return m ? `${+m[1]}/${+m[2]}` : ''; };
  function card(r, c) {
    const mine = mineOf(r, c.cm);
    const dueBadge = r.days == null ? el('span', { className: 'badge', textContent: '契約沒有迄日' })
      : el('span', { className: `badge${r.days < 0 ? ' badge-expired' : r.days <= 30 ? ' badge-overdue' : r.days <= 90 ? ' badge-due' : ''}`, textContent: dueText(r.days) });
    const lenderBadge = r.family === 'chailease'
      ? el('span', { className: 'badge', textContent: `自家：${r.lender.name}`, title: '中租自家的案件，預設藏起來' })
      : el('span', { className: 'badge badge-peer', textContent: `金主：${r.lender.name || '不明'}` });
    const mineBadge = !mine ? '' : declined(mine)
      ? el('span', { className: 'badge badge-own', textContent: `名單上是禁止推廣${mine.lastDate ? `・${mmdd(mine.lastDate)}` : ''}` })
      : el('span', { className: 'badge badge-mine', textContent: `已在名單${mine.lastDate ? `・上次 ${mmdd(mine.lastDate)}` : ''}${mine.nextDate ? `・下次 ${mmdd(mine.nextDate)}` : ''}` });
    const name = el('span', { className: 'card-name' }, [r.cust.id
      ? el('a', { href: `https://findbiz.nat.gov.tw/fts/company/${encodeURIComponent(r.cust.id)}`, target: '_blank', rel: 'noopener', textContent: r.cust.name || r.cust.id, title: '商工登記公示資料' })
      : document.createTextNode(r.cust.name || '（沒有名稱）')]);
    const isHidden = hidden.has(r.key);
    const actions = mine
      ? [el('button', { className: 'btn btn-tiny btn-primary', type: 'button', textContent: '打開名單上這一家', onclick: () => { if (typeof global.openCustomer === 'function') global.openCustomer(mine.id); } })]
      : [el('button', { className: 'btn btn-tiny btn-primary chattel-add-one', type: 'button', textContent: '加入客戶名單', onclick: () => addToList([r]) }),
        isHidden
          ? el('button', { className: 'btn btn-tiny', type: 'button', textContent: '放回來', onclick: () => { hidden.delete(r.key); saveHidden(); render(); } })
          : el('button', { className: 'btn btn-tiny chattel-hide', type: 'button', textContent: '這家不用了', onclick: () => { hidden.add(r.key); saveHidden(); render(); toast('藏起來了，下個月清冊更新也不會再冒出來'); } })];
    return el('article', { className: `card leads-card chattel-card${mine ? ' is-mine' : r.days != null && r.days >= 0 && r.days <= 30 ? ' is-overdue' : r.days != null && r.days > 30 && r.days <= 90 ? ' is-due' : ''}${isHidden ? ' is-hidden' : ''}`, 'data-key': r.key }, [
      el('div', { className: 'card-top' }, [name, dueBadge, el('span', { className: 'badge', textContent: typeShort(r.type) }), lenderBadge, mineBadge,
        r.branch.key && r.branch.kind ? el('span', { className: `badge badge-branch${r.branch.kind === 'common' ? ' badge-branch-common' : ''}`, textContent: r.branch.key, title: r.branch.label }) : '',
        r.custIsFin ? el('span', { className: 'badge badge-ind', textContent: '客戶那一方也是金融業' }) : '']),
      el('div', { className: 'card-meta' }, [
        el('span', { textContent: `💰 擔保 ${wan(r.amount)}` }),
        el('span', { textContent: `📅 契約 ${r.start || '？'} → ${r.end || '？'}` }),
        r.items ? el('span', { textContent: `📦 標的 ${r.items} 件`, title: '清冊只有件數，沒有標的物內容' }) : '',
        r.addr ? el('span', {}, ['📍 ', el('a', { href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.addr)}`, target: '_blank', rel: 'noopener', textContent: r.addr })]) : '',
        r.no ? el('span', { textContent: `🧾 登記 ${r.no}` }) : '',
        r.cust.id ? el('span', { textContent: `#${r.cust.id}` }) : '',
      ]),
      el('div', { className: 'card-actions' }, actions),
    ]);
  }

  function chips(host, options, set, single) {
    host.textContent = '';
    options.forEach(([value, label, count]) => {
      const on = single ? f.due === value : set.has(value);
      const b = el('button', { className: 'chip', type: 'button' }, [document.createTextNode(label), count != null ? el('small', { textContent: String(count) }) : '']);
      b.setAttribute('aria-pressed', String(on));
      b.onclick = () => {
        if (single) f.due = value;
        else if (set.has(value)) set.delete(value); else set.add(value);
        limit = PAGE;
        render();
      };
      host.append(b);
    });
  }

  /** 篩選籤上的數字：套用其他條件之後這一顆會剩幾家。 */
  function drawChips(c) {
    const facet = (except, pred) => { let n = 0; rows.forEach((r) => { if (pred(r) && passes(r, c, except)) n += 1; }); return n; };
    chips($('#chattel-fDue'), DUE.map(([k, label]) => [k, label, facet('due', (r) => passesDue(k, r.days))]), null, true);
    chips($('#chattel-fLender'), LENDERS.map(([k, label]) => [k, k === 'chailease' ? '中租（自家，預設藏起來）' : label, facet('lenders', (r) => r.family === k)]), f.lenders);
    const types = [...new Set(rows.map((r) => r.type))].sort();
    chips($('#chattel-fType'), types.map((t) => [t, typeShort(t), facet('types', (r) => r.type === t)]), f.types);
    chips($('#chattel-fMine'), [['out', '名單裡沒有'], ['in', '已在我的名單裡'], ['declined', '名單上禁止推廣']].map(([k, label]) => [k, label,
      facet('mine', (r) => { const m = mineOf(r, c.cm); return k === 'out' ? !m : k === 'in' ? (m && !declined(m)) : (m && declined(m)); })]), f.mine);
    // 分公司與區：籤是從資料長出來的，分公司在前、共同區在後、劃分表外最後
    const count = (key, except) => { const m = new Map(); rows.forEach((r) => { const k = key(r); if (k && passes(r, c, except)) m.set(k, (m.get(k) || 0) + 1); }); return m; };
    const bc = count((r) => r.branch.key, 'branches');
    const order = (k) => (/分公司$/.test(k) ? 0 : /共同區$/.test(k) ? 1 : 2);
    const bkeys = [...new Set([...bc.keys(), ...f.branches])].sort((a, b) => order(a) - order(b) || (bc.get(b) || 0) - (bc.get(a) || 0));
    chips($('#chattel-fBranch'), bkeys.map((k) => [k, k, bc.get(k) || 0]), f.branches);
    const dc = count((r) => r.branch.district, 'districts');
    const dkeys = [...new Set([...dc.keys(), ...f.districts])].sort((a, b) => (dc.get(b) || 0) - (dc.get(a) || 0)).slice(0, 24);
    chips($('#chattel-fDistrict'), dkeys.map((k) => [k, k.replace(/^新北市(.)/, '$1'), dc.get(k) || 0]), f.districts);
  }

  let current = [];
  function render() {
    if (!ready) return;
    const c = criteria();
    drawChips(c);
    current = visible(c);
    const host = $('#chattel-cards');
    host.textContent = '';
    current.slice(0, limit).forEach((r) => host.append(card(r, c)));
    const soon = current.filter((r) => r.days != null && r.days >= 0 && r.days <= 92).length;
    const inList = current.filter((r) => mineOf(r, c.cm)).length;
    $('#chattel-count').innerHTML = `符合 <b>${current.length.toLocaleString()}</b> 家<span class="muted">　／ ${soon ? `3 個月內到期 ${soon} 家` : ''}${inList ? `${soon ? '、' : ''}已在名單 ${inList} 家` : ''}${!soon && !inList ? `清冊未註銷共 ${rows.length.toLocaleString()} 筆` : ''}</span>`;
    const hid = rows.filter((r) => hidden.has(r.key)).length;
    const hb = $('#chattel-hidden');
    hb.hidden = !hid;
    hb.textContent = showHidden ? `收起藏起來的 ${hid} 家` : `顯示藏起來的 ${hid} 家`;
    $('#chattel-more').hidden = current.length <= limit;
    $('#chattel-empty').hidden = !!current.length;
    $('#chattel-empty').textContent = rows.length ? '沒有符合條件的案件，把到期時間放寬、或把金主的籤都取消試試。' : '';
    const addable = current.filter((r) => !mineOf(r, c.cm)).length;
    $('#chattel-add').disabled = !addable;
    $('#chattel-add').textContent = `加入客戶名單${addable ? `（${addable} 家）` : ''}`;
    $('#chattel-export').disabled = !current.length;
    $('#chattel-copy').disabled = !current.length;
    const pill = document.getElementById('countChattel');
    if (pill) pill.textContent = current.length.toLocaleString();
  }

  /** 標準欄位的 CSV：主站匯入認得「公司名稱、統編、地址、訪談內容」，不會當成登記清冊再問一次條件。 */
  function toCsv(list) {
    const lines = [CSV_HEAD, ...list.map((r) => [r.cust.name, r.cust.id, '', r.addr, noteFor(r)])].map((row) => row.map(csvCell).join(','));
    return `﻿${lines.join('\n')}\n`;
  }
  const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const csvName = (n) => `動保快到期-${todayIso()}-${n}家.csv`;

  async function addToList(list) {
    if (typeof global.importLeadsFile !== 'function') { toast('主站還沒準備好匯入，請重新整理再試'); return; }
    const c = criteria();
    const fresh = list.filter((r) => !mineOf(r, c.cm));
    if (!fresh.length) { toast('這些都已經在名單裡了'); return; }
    const file = new File([toCsv(fresh)], csvName(fresh.length), { type: 'text/csv' });
    try { await global.importLeadsFile(file); } catch (err) { toast(`加入失敗：${err.message}`); }
    render();   // 匯進去之後卡片就變成「已在名單」
  }

  function build() {
    root.textContent = '';
    const group = (label, node, forId) => el('div', { className: 'leads-group' }, [
      forId ? el('label', { htmlFor: forId, textContent: label }) : el('span', { className: 'lbl', textContent: label }), node]);
    const filters = el('details', { className: 'leads-filters', id: 'chattel-filters' }, [
      el('summary', {}, [el('strong', { textContent: '篩選' })]),
      el('p', { className: 'muted leads-hint', textContent: '籤上的數字＝套用其他條件後這一顆會剩幾家。金主沒勾＝同業全部（中租自家不算）。' }),
      group('契約到期時間', el('div', { className: 'chips', id: 'chattel-fDue' })),
      group('金主（債權人）', el('div', { className: 'chips', id: 'chattel-fLender' })),
      group('案件類別', el('div', { className: 'chips', id: 'chattel-fType' })),
      group('歸屬分公司（依標的物所在地，同「規則」的劃分表）', el('div', { className: 'chips', id: 'chattel-fBranch' })),
      group('標的物所在地', el('div', { className: 'chips', id: 'chattel-fDistrict' })),
      group('跟我的名單比對', el('div', { className: 'chips', id: 'chattel-fMine' })),
      group('擔保債權金額（萬元）', el('div', { className: 'leads-row' }, [
        el('input', { id: 'chattel-amtMin', type: 'number', min: '0', step: '100', placeholder: '下限', value: '100' }), '～',
        el('input', { id: 'chattel-amtMax', type: 'number', min: '0', step: '100', placeholder: '上限' })])),
      el('div', { className: 'leads-group' }, [el('label', {}, [el('input', { type: 'checkbox', id: 'chattel-hideFin', checked: true }), ' 藏起客戶那一方也是租賃／銀行的案件（同業之間的融資，不是要打的對象）'])]),
      group('關鍵字', el('input', { id: 'chattel-q', type: 'search', placeholder: '公司、統編、金主、地址、登記編號', autocomplete: 'off' }), 'chattel-q'),
      group('排序', el('select', { id: 'chattel-sort' }, [
        el('option', { value: 'end', textContent: '到期日（近的在前）' }),
        el('option', { value: 'amount', textContent: '擔保金額（高到低）' }),
        el('option', { value: 'company', textContent: '公司名稱' })]), 'chattel-sort'),
      el('div', { className: 'leads-row' }, [
        el('button', { className: 'btn btn-tiny', id: 'chattel-reset', type: 'button', textContent: '清除篩選' }),
        el('button', { className: 'btn btn-tiny', id: 'chattel-hidden', type: 'button', hidden: true })]),
    ]);
    filters.open = !matchMedia('(max-width: 760px)').matches;
    root.append(
      el('p', { className: 'muted leads-sub', id: 'chattel-sub', textContent: '新北市動產擔保登記清冊：同業客戶的契約什麼時候到期' }),
      filters,
      el('div', { className: 'leads-head' }, [
        el('div', { className: 'leads-count', id: 'chattel-count', textContent: '—' }),
        el('div', { className: 'leads-row' }, [
          el('button', { className: 'btn btn-primary', id: 'chattel-add', type: 'button', title: '把目前篩出來、還不在名單裡的公司送進匯入流程；動保的金主、金額、到期日會寫在訪談內容', textContent: '加入客戶名單' }),
          el('button', { className: 'btn', id: 'chattel-copy', type: 'button', textContent: '複製統編' }),
          el('button', { className: 'btn', id: 'chattel-export', type: 'button', textContent: '匯出 CSV' }),
        ]),
      ]),
      el('div', { className: 'leads-loading', id: 'chattel-loading', hidden: true }),
      el('div', { className: 'cards', id: 'chattel-cards' }),
      el('div', { className: 'empty', id: 'chattel-empty', hidden: true }),
      el('div', { className: 'leads-row leads-more' }, [el('button', { className: 'btn', id: 'chattel-more', type: 'button', textContent: '載入更多', hidden: true })]),
      el('div', { className: 'chattel-legend' }, [
        el('span', {}, [el('i', { className: 'swatch is-overdue' }), ' 30 天內到期']),
        el('span', {}, [el('i', { className: 'swatch is-due' }), ' 90 天內到期']),
        el('span', {}, [el('i', { className: 'swatch is-mine' }), ' 已在你的名單裡'])]),
      el('p', { className: 'muted leads-foot', textContent: '資料來源：新北市政府經濟發展局「動產擔保登記清冊」（每月更新，是從 1995 年累積到現在的全部案件），GitHub Actions 每月 10 日自動抓、只留未註銷的。動產抵押的客戶在債務人欄、附條件買賣的客戶在債權人欄，抓的時候已經翻正，畫面上一律寫「金主」。「已在名單」是在這台瀏覽器裡比對的，名單不會上傳；「這家不用了」也只記在這台裝置。' }),
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
      $('#chattel-empty').hidden = false;
      $('#chattel-empty').textContent = '還沒有抓好的清冊。GitHub Actions 每月 10 日會自動抓，也可以到 repo 的 Actions 頁手動執行「每月動保清冊」。';
      return;
    }
    const through = String(index.dataThrough || '').slice(0, 7);
    $('#chattel-sub').textContent = `新北市動產擔保登記清冊（新北市經發局，每月更新）　·　資料截到 ${through || '？'}　·　上次抓取 ${String(index.generatedAt || '').slice(0, 10).replace(/-/g, '/')}`;
    $('#chattel-loading').hidden = false;
    $('#chattel-loading').textContent = `下載清冊… ${(index.kept || 0).toLocaleString()} 筆`;
    try {
      for (const file of index.files || []) {
        const r = await fetch(`${DATA_BASE}${file.path}?t=${index.generatedAt}`, { cache: 'force-cache' });
        if (!r.ok) throw new Error(`${file.path}：HTTP ${r.status}`);
        const table = parseCsv(await r.text());
        const head = table[0] || [];
        table.slice(1).forEach((cells) => { const o = {}; head.forEach((h, i) => { o[h] = cells[i] || ''; }); rows.push(toRecord(o)); });
      }
    } catch (err) {
      $('#chattel-loading').hidden = true;
      $('#chattel-empty').hidden = false;
      $('#chattel-empty').textContent = `清冊下載失敗：${err.message}`;
      return;
    }
    $('#chattel-loading').hidden = true;
    ready = true;
    const rerender = () => { limit = PAGE; render(); };
    ['#chattel-amtMin', '#chattel-amtMax'].forEach((s) => { $(s).oninput = rerender; });
    $('#chattel-hideFin').onchange = rerender;
    $('#chattel-sort').onchange = rerender;
    let qt = null;
    $('#chattel-q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { f.q = e.target.value; rerender(); }, 120); };
    $('#chattel-more').onclick = () => { limit += PAGE; render(); };
    $('#chattel-hidden').onclick = () => { showHidden = !showHidden; rerender(); };
    $('#chattel-reset').onclick = () => {
      f.due = 'm6'; f.lenders.clear(); f.types.clear(); f.branches.clear(); f.districts.clear(); f.mine.clear(); f.q = '';
      $('#chattel-q').value = ''; $('#chattel-amtMin').value = '100'; $('#chattel-amtMax').value = ''; $('#chattel-hideFin').checked = true; $('#chattel-sort').value = 'end';
      showHidden = false;
      rerender();
    };
    $('#chattel-add').onclick = () => addToList(current);
    $('#chattel-export').onclick = () => {
      const blob = new Blob([toCsv(current)], { type: 'text/csv;charset=utf-8' });
      const a = el('a', { href: URL.createObjectURL(blob), download: csvName(current.length) });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast(`已匯出 ${current.length} 家`);
    };
    $('#chattel-copy').onclick = async () => {
      const text = current.map((r) => r.cust.id).filter(Boolean).join('\n');
      try { await navigator.clipboard.writeText(text); toast(`已複製 ${current.length} 個統編`); }
      catch (e) { toast('這個瀏覽器不讓網頁複製'); }
    };
    rerender();
  }

  /** 主站切到「快到期」分頁時叫這個；第一次才真的去抓資料，之後每次切過來重畫（名單可能變了）。 */
  function show() {
    if (!root) root = document.getElementById('paneChattel');
    if (!root) return;
    if (started) { render(); return; }
    start().catch((err) => { console.error(err); toast(`快到期名單載入失敗：${err.message}`); });
  }

  global.Chattel = { show, parseYmd, daysLeft, dueOf, lenderFamily, lenderLabel, typeShort, noteFor, toRecord, toCsv, LENDER_RE };
})(window);
