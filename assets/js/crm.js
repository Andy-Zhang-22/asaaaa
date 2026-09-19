/*
 * crm.js — 客戶管理：客戶建檔、貸款案件進度、文件清單、跟進紀錄、待辦與總覽。
 */
(function () {
  'use strict';

  const Store = window.CrmStore;
  const PAGE_SIZE = 60;
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, props, children) => {
    const node = Object.assign(document.createElement(tag), props || {});
    (children || []).forEach((c) => { if (c !== '' && c != null) node.append(c); });
    return node;
  };

  /* ---------------- 常數 ---------------- */

  const STAGES = [
    ['lead', '潛在客戶'], ['talking', '洽談中'], ['processing', '進件中'],
    ['won', '已成交'], ['paused', '暫緩'], ['lost', '流失'],
  ];
  const STAGE_LABEL = Object.fromEntries(STAGES);

  const CASE_STATUS = [
    ['talking', '洽談中'], ['collecting', '收件中'], ['submitted', '已送件'], ['reviewing', '審核中'],
    ['approved', '已核准'], ['funded', '已撥款'], ['declined', '婉拒'], ['cancelled', '取消'],
  ];
  const CASE_LABEL = Object.fromEntries(CASE_STATUS);
  const ACTIVE_STATUS = new Set(['talking', 'collecting', 'submitted', 'reviewing', 'approved']);
  const CLOSED_STATUS = new Set(['funded', 'declined', 'cancelled']);

  const PRODUCTS = ['信保基金保證貸款', '企業週轉金', '設備資金貸款', '不動產抵押貸款', '負責人信用貸款',
    '青年創業及啟動金貸款', '應收帳款融資', '進出口融資', '其他'];
  const BANKS = ['臺灣銀行', '土地銀行', '合作金庫', '第一銀行', '華南銀行', '彰化銀行', '兆豐銀行', '臺灣企銀',
    '台新銀行', '中國信託', '玉山銀行', '國泰世華', '永豐銀行', '台北富邦', '上海商銀', '元大銀行',
    '遠東商銀', '凱基銀行', '王道銀行', '陽信銀行', '聯邦銀行', '新光銀行', '星展銀行', '滙豐銀行',
    '渣打銀行', '高雄銀行', '板信商銀', '三信商銀', '華泰銀行', '京城銀行', '安泰銀行', '農會／信用合作社'];
  const SOURCES = ['電話推廣', '客戶轉介', '朋友介紹', '網路／廣告', '陌生拜訪', '舊客戶回流', '其他'];
  const NOTE_TYPES = ['電話', '拜訪', 'LINE／訊息', 'Email', '其他'];
  const DOCS = [
    ['reg', '公司登記／變更登記表'], ['ownerId', '負責人身分證正反面'],
    ['tax401', '近三年 401／403 申報書'], ['fin', '近兩年財報（資產負債表、損益表）'],
    ['bank6m', '公司近半年銀行往來明細'], ['jcic', '聯徵查詢同意書'],
    ['taxPaid', '營業稅繳款書'], ['ownerAssets', '負責人所得／財產清單'],
    ['seal', '公司大小章'], ['collateral', '擔保品資料（謄本、保單等）'], ['other', '其他'],
  ];
  const DOC_LABEL = Object.fromEntries(DOCS);

  /* ---------------- 工具 ---------------- */

  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayISO = () => isoOf(new Date());
  const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return isoOf(d); };
  const rocLabel = (iso) => {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return `${+y - 1911}/${m}/${d}`;
  };
  const dayDiff = (iso) => Math.round((new Date(`${iso}T00:00:00`) - new Date(`${todayISO()}T00:00:00`)) / 86400000);
  const daysSince = (ts) => Math.floor((Date.now() - ts) / 86400000);
  const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };
  const fmtWan = (n) => (n ? `${Number(n).toLocaleString('zh-Hant-TW', { maximumFractionDigits: 1 })} 萬` : '');
  const dueBucket = (iso) => {
    if (!iso) return 'none';
    const diff = dayDiff(iso);
    if (diff < 0) return 'overdue';
    if (diff === 0) return 'today';
    if (diff <= 7) return 'week';
    return 'later';
  };
  const telHref = (s) => `tel:${String(s).replace(/[^\d+#*]/g, '')}`;

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function badge(cls, text) {
    return el('span', { className: `badge ${cls}`, textContent: text });
  }

  /* ---------------- 狀態 ---------------- */

  const emptyFilters = () => ({
    due: '', stage: new Set(), caseStatus: new Set(), bank: new Set(), source: new Set(),
    tag: new Set(), city: new Set(), industry: '',
  });

  const state = {
    customers: [],
    cases: [],
    notes: [],
    tab: 'overview',
    search: '',
    sort: 'next',
    limit: PAGE_SIZE,
    hideClosed: true,
    filters: emptyFilters(),
    openId: null,
  };

  const casesOf = (customerId) => state.cases
    .filter((k) => k.customerId === customerId)
    .sort((a, b) => b.createdAt - a.createdAt);
  const notesOf = (customerId) => state.notes
    .filter((n) => n.customerId === customerId)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt);
  const customerOf = (id) => state.customers.find((c) => c.id === id);

  /** 客戶 + 案件摘要，給列表、篩選、排序用。 */
  function view(c) {
    const cases = casesOf(c.id);
    const active = cases.filter((k) => ACTIVE_STATUS.has(k.status));
    return {
      ...c,
      cases,
      activeCases: active,
      activeAmount: active.reduce((s, k) => s + num(k.applyAmount), 0),
      fundedAmount: cases.filter((k) => k.status === 'funded').reduce((s, k) => s + num(k.approvedAmount || k.applyAmount), 0),
      _blob: [c.company, c.taxId, c.owner, c.contact, c.phone, c.mobile, c.email, c.address, c.industry,
        c.note, (c.tags || []).join(' '), cases.map((k) => `${k.bank} ${k.product} ${k.note || ''}`).join(' '),
        notesOf(c.id).map((n) => n.text).join(' ')].join(' ').toLowerCase(),
    };
  }

  /* ---------------- 篩選與排序 ---------------- */

  function visibleCustomers() {
    const q = state.search.trim().toLowerCase();
    const terms = q ? q.split(/\s+/) : [];
    const f = state.filters;

    const list = state.customers.map(view).filter((r) => {
      if (f.stage.size && !f.stage.has(r.stage || 'lead')) return false;
      if (f.source.size && !f.source.has(r.source || '未填')) return false;
      if (f.city.size && !f.city.has(r.city || '其他')) return false;
      if (f.tag.size && !(r.tags || []).some((t) => f.tag.has(t))) return false;
      if (f.industry && !(r.industry || '').includes(f.industry)) return false;
      if (f.caseStatus.size && !r.cases.some((k) => f.caseStatus.has(k.status))) return false;
      if (f.bank.size && !r.cases.some((k) => f.bank.has(k.bank || '未填'))) return false;
      if (f.due) {
        const b = dueBucket(r.nextDate);
        if (f.due === 'due' && !(b === 'overdue' || b === 'today')) return false;
        if (f.due === 'overdue' && b !== 'overdue') return false;
        if (f.due === 'week' && !(b === 'overdue' || b === 'today' || b === 'week')) return false;
        if (f.due === 'none' && b !== 'none') return false;
      }
      if (terms.length && !terms.every((t) => r._blob.includes(t))) return false;
      return true;
    });

    const cmp = {
      next: (a, b) => (a.nextDate || '9999').localeCompare(b.nextDate || '9999'),
      updated: (a, b) => b.updatedAt - a.updatedAt,
      amount: (a, b) => b.activeAmount - a.activeAmount,
      company: (a, b) => a.company.localeCompare(b.company, 'zh-Hant'),
      created: (a, b) => b.createdAt - a.createdAt,
    }[state.sort];
    list.sort((a, b) => cmp(a, b) || a.company.localeCompare(b.company, 'zh-Hant'));
    return list;
  }

  function renderFilters() {
    const all = state.customers.map(view);
    const tally = (items) => {
      const m = new Map();
      items.forEach((v) => m.set(v, (m.get(v) || 0) + 1));
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const chips = (host, items, setRef, labelOf) => {
      host.textContent = '';
      items.forEach(([value, count]) => {
        const btn = el('button', { className: 'chip', type: 'button' });
        btn.setAttribute('aria-pressed', setRef.has(value) ? 'true' : 'false');
        btn.append(el('small', { textContent: String(count) }), document.createTextNode(' ' + (labelOf ? labelOf(value) : value)));
        btn.onclick = () => {
          setRef.has(value) ? setRef.delete(value) : setRef.add(value);
          state.limit = PAGE_SIZE;
          render();
        };
        host.append(btn);
      });
    };

    const dueHost = $('#fltDue');
    dueHost.textContent = '';
    [['', '全部'], ['due', '今天以前（待跟進）'], ['overdue', '逾期'], ['week', '一週內'], ['none', '未排定']]
      .forEach(([value, label]) => {
        const btn = el('button', { className: 'chip', type: 'button', textContent: label });
        btn.setAttribute('aria-pressed', state.filters.due === value ? 'true' : 'false');
        btn.onclick = () => { state.filters.due = value; state.limit = PAGE_SIZE; render(); };
        dueHost.append(btn);
      });

    const stageOrder = STAGES.map((s) => s[0]);
    chips($('#fltStage'), tally(all.map((r) => r.stage || 'lead'))
      .sort((a, b) => stageOrder.indexOf(a[0]) - stageOrder.indexOf(b[0])), state.filters.stage, (v) => STAGE_LABEL[v] || v);
    const statusOrder = CASE_STATUS.map((s) => s[0]);
    chips($('#fltCaseStatus'), tally(state.cases.map((k) => k.status))
      .sort((a, b) => statusOrder.indexOf(a[0]) - statusOrder.indexOf(b[0])), state.filters.caseStatus, (v) => CASE_LABEL[v] || v);
    chips($('#fltBank'), tally(state.cases.map((k) => k.bank || '未填')).slice(0, 12), state.filters.bank);
    chips($('#fltSource'), tally(all.map((r) => r.source || '未填')), state.filters.source);
    chips($('#fltTag'), tally(all.flatMap((r) => r.tags || [])).slice(0, 20), state.filters.tag);
    chips($('#fltCity'), tally(all.map((r) => r.city || '其他')).slice(0, 12), state.filters.city);

    const industries = [...new Set(all.map((r) => r.industry).filter(Boolean))].sort();
    $('#industryList').textContent = '';
    industries.forEach((i) => $('#industryList').append(el('option', { value: i })));
  }

  /* ---------------- 客戶列表 ---------------- */

  function phoneLinks(r, limit) {
    const items = [];
    if (r.mobile) items.push([r.mobile, r.contact || r.owner || '手機']);
    if (r.phone) items.push([r.phone, '公司']);
    return items.slice(0, limit || 9).map(([p, note]) => {
      const a = el('a', { className: 'tel', href: telHref(p), textContent: `📞 ${p} · ${note}` });
      a.onclick = (e) => e.stopPropagation();
      return a;
    });
  }

  function caseLine(k, withCompany) {
    const line = el('div', { className: 'case-line' });
    if (withCompany) line.append(el('b', { textContent: customerOf(k.customerId)?.company || '' }));
    line.append(badge(`cs-${k.status}`, CASE_LABEL[k.status] || k.status));
    line.append(el('span', { textContent: `${k.bank || '未填銀行'}${k.product ? ` · ${k.product}` : ''}` }));
    const amt = k.status === 'funded' || k.status === 'approved'
      ? (k.approvedAmount ? `核准 ${fmtWan(k.approvedAmount)}` : fmtWan(k.applyAmount))
      : fmtWan(k.applyAmount);
    if (amt) line.append(el('span', { className: 'amount', textContent: amt }));
    return line;
  }

  function card(r) {
    const bucket = dueBucket(r.nextDate);
    const node = el('article', {
      className: `card${bucket === 'today' ? ' is-due' : ''}${bucket === 'overdue' ? ' is-overdue' : ''}${r.stage === 'won' ? ' is-won' : ''}`,
      tabIndex: 0,
    });
    node.append(el('div', { className: 'card-top' }, [
      el('span', { className: 'card-name', textContent: r.company }),
      badge(`stage-${r.stage || 'lead'}`, STAGE_LABEL[r.stage] || '潛在客戶'),
    ]));

    const meta = el('div', { className: 'card-meta' });
    [
      (r.contact || r.owner) && `👤 ${r.contact || r.owner}${r.title ? `（${r.title}）` : ''}`,
      r.industry && `🏷 ${r.industry}`,
      (r.city || r.address) && `📍 ${r.city || ''}${r.district || ''}`,
      r.source && `🔗 ${r.source}`,
      r.nextDate && `📅 下次 ${rocLabel(r.nextDate)}${bucket === 'overdue' ? `（逾期 ${-dayDiff(r.nextDate)} 天）` : ''}`,
      r.activeCases.length && `📂 進行中 ${r.activeCases.length} 件 · ${fmtWan(r.activeAmount)}`,
      r.fundedAmount && `✅ 累計撥款 ${fmtWan(r.fundedAmount)}`,
    ].filter(Boolean).forEach((b) => meta.append(el('span', { textContent: b })));
    node.append(meta);

    if ((r.tags || []).length) {
      node.append(el('div', { className: 'card-tags' }, r.tags.map((t) => el('span', { className: 'tag', textContent: t }))));
    }
    r.activeCases.slice(0, 2).forEach((k) => node.append(caseLine(k)));

    const latest = notesOf(r.id)[0];
    if (latest) node.append(el('p', { className: 'card-notes', textContent: `${rocLabel(latest.date)} ${latest.text}` }));
    else if (r.note) node.append(el('p', { className: 'card-notes', textContent: r.note }));

    const links = phoneLinks(r, 2);
    if (links.length) node.append(el('div', { className: 'card-actions' }, links));

    node.onclick = () => openDetail(r.id);
    node.onkeydown = (e) => { if (e.key === 'Enter') openDetail(r.id); };
    return node;
  }

  function renderCustomers() {
    const list = visibleCustomers();
    const host = $('#cards');
    host.textContent = '';
    list.slice(0, state.limit).forEach((r) => host.append(card(r)));
    $('#listSummary').textContent = `顯示 ${Math.min(state.limit, list.length)} / ${list.length} 位客戶`;
    $('#btnMore').hidden = list.length <= state.limit;

    const empty = $('#emptyCustomers');
    empty.hidden = !!list.length;
    if (!list.length) {
      empty.textContent = '';
      if (!state.customers.length) {
        empty.append(el('strong', { textContent: '還沒有客戶' }),
          el('p', { textContent: '按右上角「新增客戶」建檔，或從選單匯入你現有的 Excel／CSV 客戶清單。' }));
      } else {
        empty.append(el('strong', { textContent: '沒有符合條件的客戶' }),
          el('p', { textContent: '試著放寬篩選條件或清除搜尋。' }));
      }
    }
  }

  /* ---------------- 案件看板 ---------------- */

  function renderBoard() {
    const host = $('#board');
    host.textContent = '';
    const visibleIds = new Set(visibleCustomers().map((c) => c.id));
    const q = state.search.trim();
    let cases = state.cases.filter((k) => visibleIds.has(k.customerId));
    if (state.hideClosed) cases = cases.filter((k) => !CLOSED_STATUS.has(k.status));
    // 篩選側欄選了案件狀態／銀行時，看板也只留符合的案件
    if (state.filters.caseStatus.size) cases = cases.filter((k) => state.filters.caseStatus.has(k.status));
    if (state.filters.bank.size) cases = cases.filter((k) => state.filters.bank.has(k.bank || '未填'));

    const total = cases.reduce((s, k) => s + num(k.applyAmount), 0);
    $('#caseSummary').textContent = `${cases.length} 件 · 申請金額合計 ${fmtWan(total) || '0 萬'}${q ? `（搜尋「${q}」）` : ''}`;

    if (!state.cases.length) {
      host.append(el('div', { className: 'empty' }, [
        el('strong', { textContent: '還沒有案件' }),
        el('p', { textContent: '打開任一客戶，在「貸款案件」區按「新增案件」。' }),
      ]));
      return;
    }

    const columns = CASE_STATUS.filter(([key]) => !state.hideClosed || !CLOSED_STATUS.has(key));
    columns.forEach(([key, label]) => {
      const items = cases.filter((k) => k.status === key)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const sum = items.reduce((s, k) => s + num(k.applyAmount), 0);
      const col = el('div', { className: 'column' }, [
        el('h3', {}, [
          document.createTextNode(`${label} `),
          el('small', { textContent: `${items.length} 件${sum ? ` · ${fmtWan(sum)}` : ''}` }),
        ]),
      ]);
      if (!items.length) col.append(el('div', { className: 'empty', textContent: '—' }));
      items.forEach((k) => {
        const c = customerOf(k.customerId);
        const stale = ['submitted', 'reviewing'].includes(k.status) && daysSince(k.updatedAt) >= 14;
        const node = el('article', { className: 'card', tabIndex: 0 }, [
          el('div', { className: 'card-top' }, [el('span', { className: 'card-name', textContent: c ? c.company : '（客戶已刪除）' })]),
          el('div', { className: 'card-meta' }, [
            el('span', { textContent: `🏦 ${k.bank || '未填銀行'}` }),
            k.product ? el('span', { textContent: k.product }) : '',
            k.applyAmount ? el('span', { className: 'amount', textContent: `申請 ${fmtWan(k.applyAmount)}` }) : '',
            k.approvedAmount ? el('span', { className: 'amount', textContent: `核准 ${fmtWan(k.approvedAmount)}` }) : '',
            k.appliedDate ? el('span', { textContent: `送件 ${rocLabel(k.appliedDate)}` }) : '',
            el('span', { className: stale ? 'stale' : '', textContent: `更新 ${daysSince(k.updatedAt)} 天前${stale ? ' ⚠' : ''}` }),
          ]),
          k.note ? el('p', { className: 'card-notes', textContent: k.note }) : '',
        ]);
        node.onclick = () => openDetail(k.customerId, k.id);
        node.onkeydown = (e) => { if (e.key === 'Enter') openDetail(k.customerId, k.id); };
        col.append(node);
      });
      host.append(col);
    });
  }

  /* ---------------- 待跟進 ---------------- */

  function renderTodo() {
    const host = $('#paneTodo');
    host.textContent = '';
    const due = visibleCustomers().filter((r) => ['overdue', 'today'].includes(dueBucket(r.nextDate)))
      .sort((a, b) => (a.nextDate || '').localeCompare(b.nextDate || ''));
    const stale = state.cases.filter((k) => ['submitted', 'reviewing'].includes(k.status) && daysSince(k.updatedAt) >= 14)
      .sort((a, b) => a.updatedAt - b.updatedAt);
    const collecting = state.cases.filter((k) => k.status === 'collecting');

    const sec = (title, nodes, emptyText) => {
      const box = el('div', {}, [el('h3', { textContent: title })]);
      if (nodes.length) nodes.forEach((n) => box.append(n));
      else box.append(el('div', { className: 'empty', textContent: emptyText }));
      host.append(box);
    };

    sec(`到期／逾期的跟進（${due.length}）`, el('div', { className: 'cards' }, due.map(card)).childNodes.length
      ? [el('div', { className: 'cards' }, due.map(card))] : [], '今天沒有到期的跟進，太好了。');

    sec(`送件超過兩週沒更新的案件（${stale.length}）`, stale.map((k) => {
      const c = customerOf(k.customerId);
      const node = el('article', { className: 'card is-overdue', tabIndex: 0 }, [
        el('div', { className: 'card-top' }, [
          el('span', { className: 'card-name', textContent: c ? c.company : '' }),
          badge(`cs-${k.status}`, CASE_LABEL[k.status]),
        ]),
        el('div', { className: 'card-meta' }, [
          el('span', { textContent: `🏦 ${k.bank || '未填銀行'} · ${fmtWan(k.applyAmount) || '未填金額'}` }),
          el('span', { className: 'stale', textContent: `已 ${daysSince(k.updatedAt)} 天沒更新，該追一下銀行進度` }),
        ]),
      ]);
      node.onclick = () => openDetail(k.customerId, k.id);
      return node;
    }), '沒有卡住的案件。');

    sec(`收件中的案件，還缺哪些文件（${collecting.length}）`, collecting.map((k) => {
      const c = customerOf(k.customerId);
      const missing = DOCS.filter(([key]) => !(k.docs && k.docs[key])).map(([, label]) => label);
      const node = el('article', { className: 'card', tabIndex: 0 }, [
        el('div', { className: 'card-top' }, [
          el('span', { className: 'card-name', textContent: c ? c.company : '' }),
          el('span', { className: 'muted', textContent: `${k.bank || ''} ${fmtWan(k.applyAmount)}` }),
        ]),
        el('p', { className: 'card-notes', textContent: missing.length ? `缺：${missing.join('、')}` : '文件已齊全，可以送件了 ✅' }),
      ]);
      node.onclick = () => openDetail(k.customerId, k.id);
      return node;
    }), '目前沒有收件中的案件。');
  }

  /* ---------------- 總覽 ---------------- */

  function bar(label, value, max, fmt) {
    return el('div', { className: 'bar' }, [
      el('span', { textContent: label }),
      el('i', { style: `width:${max ? Math.max(2, (value / max) * 100) : 0}%` }),
      el('u', { textContent: fmt ? fmt(value) : String(value) }),
    ]);
  }

  function renderOverview() {
    const host = $('#paneOverview');
    host.textContent = '';
    const all = state.customers.map(view);
    if (!all.length) {
      host.append(el('div', { className: 'empty' }, [
        el('strong', { textContent: '歡迎使用客戶管理' }),
        el('p', { textContent: '先按右上角「新增客戶」建第一位客戶，或從選單匯入 CSV。建好客戶後就能在客戶頁面新增貸款案件、記錄跟進。' }),
      ]));
      return;
    }

    const today = todayISO();
    const ym = today.slice(0, 7);
    const year = today.slice(0, 4);
    const active = state.cases.filter((k) => ACTIVE_STATUS.has(k.status));
    const fundedThisMonth = state.cases.filter((k) => k.status === 'funded' && (k.fundedDate || '').startsWith(ym));
    const fundedThisYear = state.cases.filter((k) => k.status === 'funded' && (k.fundedDate || '').startsWith(year));
    const sumOf = (list, key) => list.reduce((s, k) => s + num(k[key] || k.applyAmount), 0);
    const dueCount = all.filter((r) => ['overdue', 'today'].includes(dueBucket(r.nextDate))).length;
    const feeThisYear = fundedThisYear.reduce((s, k) => s + num(k.fee), 0);

    const tiles = [
      ['客戶總數', all.length, '位'],
      ['進行中案件', active.length, `件 · ${fmtWan(sumOf(active, 'applyAmount')) || '0 萬'}`],
      ['本月撥款', fundedThisMonth.length, `件 · ${fmtWan(sumOf(fundedThisMonth, 'approvedAmount')) || '0 萬'}`],
      ['今年撥款', fundedThisYear.length, `件 · ${fmtWan(sumOf(fundedThisYear, 'approvedAmount')) || '0 萬'}`],
      ['今年服務費收入', fmtWan(feeThisYear) || '0 萬', ''],
      ['待跟進', dueCount, '位到期／逾期'],
    ];
    const row = el('div', { className: 'stat-row' });
    tiles.forEach(([label, value, unit]) => row.append(el('div', { className: 'stat' }, [
      el('b', {}, [document.createTextNode(String(value)), unit ? el('small', { textContent: unit }) : '']),
      el('span', { textContent: label }),
    ])));
    host.append(row);

    // 近六個月撥款金額
    const months = [];
    const d = new Date();
    for (let i = 5; i >= 0; i--) {
      const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
      const key = `${m.getFullYear()}-${pad(m.getMonth() + 1)}`;
      const amount = state.cases.filter((k) => k.status === 'funded' && (k.fundedDate || '').startsWith(key))
        .reduce((s, k) => s + num(k.approvedAmount || k.applyAmount), 0);
      months.push([`${m.getFullYear() - 1911}/${pad(m.getMonth() + 1)}`, amount]);
    }
    const maxM = Math.max(...months.map((m) => m[1]), 1);
    host.append(el('div', { className: 'bars' }, [
      el('h3', { textContent: '近六個月撥款金額（萬元）' }),
      el('div', { className: 'months' }, months.map(([label, amount]) => el('div', { className: 'month' }, [
        el('b', { textContent: amount ? amount.toLocaleString() : '' }),
        el('i', { style: `height:${Math.max(2, (amount / maxM) * 80)}%` }),
        el('span', { textContent: label }),
      ]))),
    ]));

    const group = (items, keyOf) => {
      const m = new Map();
      items.forEach((it) => { const v = keyOf(it) || '未填'; m.set(v, (m.get(v) || 0) + 1); });
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const section = (title, entries, labelOf, fmt) => {
      const max = Math.max(...entries.map((e) => e[1]), 1);
      const box = el('div', { className: 'bars' }, [el('h3', { textContent: title })]);
      entries.slice(0, 10).forEach(([k, v]) => box.append(bar(labelOf ? labelOf(k) : k, v, max, fmt)));
      return box;
    };
    const statusOrder = CASE_STATUS.map((s) => s[0]);
    const byStatus = group(state.cases, (k) => k.status).sort((a, b) => statusOrder.indexOf(a[0]) - statusOrder.indexOf(b[0]));
    const bankAmount = new Map();
    state.cases.forEach((k) => bankAmount.set(k.bank || '未填', (bankAmount.get(k.bank || '未填') || 0) + num(k.applyAmount)));
    const grid = el('div', { className: 'grid-2' }, [
      section('案件狀態', byStatus, (k) => CASE_LABEL[k] || k),
      section('客戶階段', group(all, (r) => r.stage || 'lead'), (k) => STAGE_LABEL[k] || k),
      section('各銀行申請金額（萬）', [...bankAmount.entries()].sort((a, b) => b[1] - a[1]), null, (v) => v.toLocaleString()),
      section('客戶來源', group(all, (r) => r.source)),
    ]);
    host.append(grid);

    // 待跟進清單
    const due = all.filter((r) => ['overdue', 'today'].includes(dueBucket(r.nextDate)))
      .sort((a, b) => (a.nextDate || '').localeCompare(b.nextDate || '')).slice(0, 10);
    const recent = [...all].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
    const list = (title, items, right) => {
      const box = el('div', { className: 'mini-list' }, [el('h3', { textContent: title })]);
      const ul = el('ul');
      if (!items.length) ul.append(el('li', { className: 'muted', textContent: '目前沒有' }));
      items.forEach((r) => {
        const li = el('li', {}, [el('b', { textContent: r.company }), el('span', { textContent: right(r) })]);
        li.onclick = () => openDetail(r.id);
        ul.append(li);
      });
      box.append(ul);
      return box;
    };
    host.append(el('div', { className: 'grid-2' }, [
      list('今天要跟進', due, (r) => (dayDiff(r.nextDate) < 0 ? `逾期 ${-dayDiff(r.nextDate)} 天` : '今天')),
      list('最近更新', recent, (r) => `${daysSince(r.updatedAt)} 天前`),
    ]));
  }

  /* ---------------- 主渲染 ---------------- */

  function render() {
    const all = state.customers.map(view);
    $('#countCustomers').textContent = String(all.length);
    $('#countCases').textContent = String(state.cases.filter((k) => ACTIVE_STATUS.has(k.status)).length);
    const dueCount = all.filter((r) => ['overdue', 'today'].includes(dueBucket(r.nextDate))).length;
    $('#countTodo').textContent = String(dueCount);
    const funded = state.cases.filter((k) => k.status === 'funded');
    $('#brandSub').textContent = all.length
      ? `${all.length} 位客戶 · ${state.cases.length} 件案件 · 已撥款 ${funded.length} 件`
      : '尚未建立客戶';

    ['overview', 'customers', 'cases', 'todo'].forEach((t) => {
      $(`#pane${t[0].toUpperCase()}${t.slice(1)}`).hidden = state.tab !== t;
    });
    renderFilters();
    if (state.tab === 'overview') renderOverview();
    if (state.tab === 'customers') renderCustomers();
    if (state.tab === 'cases') renderBoard();
    if (state.tab === 'todo') renderTodo();
  }

  /* ---------------- 通用表單 ---------------- */

  let formResolve = null;

  /**
   * fields: [{ key, label, type, options, required, full, hint, placeholder, list }]
   * 回傳 Promise<values | null>；extra 可加入「刪除」等額外按鈕。
   */
  function openForm(title, fields, values, extra) {
    const box = $('#formFields');
    box.textContent = '';
    $('#formTitle').textContent = title;
    const actions = $('#formBox .form-actions');
    actions.querySelectorAll('.extra').forEach((n) => n.remove());
    (extra || []).forEach((b) => {
      const btn = el('button', { type: 'button', className: `btn extra ${b.className || ''}`, textContent: b.label });
      btn.onclick = () => b.onClick(closeForm);
      actions.prepend(btn);
    });

    fields.forEach((f) => {
      const wrap = el('div', { className: `field${f.full ? ' full' : ''}` });
      const label = el('label', { htmlFor: `f_${f.key}` }, [document.createTextNode(f.label), f.required ? el('b', { textContent: ' *' }) : '']);
      let input;
      const v = values && values[f.key] != null ? values[f.key] : '';
      if (f.type === 'select') {
        input = el('select', { id: `f_${f.key}`, name: f.key });
        (f.options || []).forEach((o) => {
          const [val, text] = Array.isArray(o) ? o : [o, o];
          input.append(el('option', { value: val, textContent: text }));
        });
        input.value = v || (f.options && f.options.length ? (Array.isArray(f.options[0]) ? f.options[0][0] : f.options[0]) : '');
      } else if (f.type === 'textarea') {
        input = el('textarea', { id: `f_${f.key}`, name: f.key, value: v, placeholder: f.placeholder || '' });
      } else {
        input = el('input', {
          id: `f_${f.key}`, name: f.key, type: f.type || 'text', placeholder: f.placeholder || '',
          value: Array.isArray(v) ? v.join('、') : v,
        });
        if (f.type === 'number') { input.step = f.step || 'any'; input.inputMode = 'decimal'; }
        if (f.list) {
          const dl = el('datalist', { id: `dl_${f.key}` });
          f.list.forEach((o) => dl.append(el('option', { value: o })));
          wrap.append(dl);
          input.setAttribute('list', `dl_${f.key}`);
        }
      }
      if (f.required) input.required = true;
      wrap.prepend(label, input);
      if (f.hint) wrap.append(el('span', { className: 'hint', textContent: f.hint }));
      box.append(wrap);
    });

    $('#formDialog').hidden = false;
    document.body.style.overflow = 'hidden';
    const first = box.querySelector('input, select, textarea');
    if (first) setTimeout(() => first.focus(), 30);
    return new Promise((resolve) => { formResolve = resolve; });
  }

  function closeForm(result) {
    $('#formDialog').hidden = true;
    if (!$('#drawer').hidden) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    const r = formResolve;
    formResolve = null;
    if (r) r(result == null ? null : result);
  }

  function readForm() {
    const out = {};
    $('#formFields').querySelectorAll('input, select, textarea').forEach((i) => {
      if (!i.name) return;
      out[i.name] = i.type === 'number' ? (i.value === '' ? '' : Number(i.value)) : i.value.trim();
    });
    return out;
  }

  /* ---------------- 客戶表單 ---------------- */

  const customerFields = () => [
    { key: 'company', label: '公司名稱', required: true },
    { key: 'taxId', label: '統一編號', placeholder: '8 碼' },
    { key: 'owner', label: '負責人' },
    { key: 'contact', label: '聯絡人／窗口', hint: '留空則以負責人為聯絡人' },
    { key: 'title', label: '職稱' },
    { key: 'mobile', label: '手機', type: 'tel' },
    { key: 'phone', label: '公司電話', type: 'tel', placeholder: '02-1234-5678 #100' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'address', label: '公司地址', full: true },
    { key: 'industry', label: '產業別' },
    { key: 'founded', label: '成立年', placeholder: '例：2015 或 104' },
    { key: 'capital', label: '資本額（萬元）', type: 'number' },
    { key: 'revenue', label: '年營收（萬元）', type: 'number' },
    { key: 'employees', label: '員工人數', type: 'number', step: '1' },
    { key: 'source', label: '客戶來源', type: 'select', options: ['', ...SOURCES] },
    { key: 'stage', label: '客戶階段', type: 'select', options: STAGES },
    { key: 'nextDate', label: '下次跟進日', type: 'date' },
    { key: 'tags', label: '標籤', placeholder: '用逗號或頓號分隔，例：VIP、有擔保品', full: true },
    { key: 'note', label: '備註', type: 'textarea', full: true, placeholder: '資金需求、背景、注意事項…' },
  ];

  function parseTags(s) {
    return [...new Set(String(s || '').split(/[,，、;；\s]+/).map((t) => t.trim()).filter(Boolean))];
  }

  async function editCustomer(existing, prefill) {
    const values = existing ? { ...existing } : { stage: 'lead', ...(prefill || {}) };
    if (Array.isArray(values.tags)) values.tags = values.tags.join('、');
    const extra = existing ? [{
      label: '刪除客戶', className: 'danger',
      onClick: async (close) => {
        if (!confirm(`確定要刪除「${existing.company}」？連同案件與跟進紀錄一起刪除，無法復原。`)) return;
        await Store.deleteCustomer(existing.id);
        await reload();
        close(null);
        closeOverlays();
        render();
        toast('已刪除客戶');
      },
    }] : [];
    const out = await openForm(existing ? '編輯客戶' : '新增客戶', customerFields(), values, extra);
    if (!out) return null;
    const c = { ...(existing || {}), ...out, tags: parseTags(out.tags) };
    if (c.taxId) c.taxId = window.Normalize.toHalfWidth(c.taxId).replace(/\D/g, '');
    Object.assign(c, window.Normalize.parseAddress(c.address || ''));
    if (!existing && prefill && prefill.leadId) c.leadId = prefill.leadId;
    await Store.saveCustomer(c);
    await reload();
    render();
    toast(existing ? '已更新客戶' : '已新增客戶');
    return c;
  }

  /* ---------------- 案件表單 ---------------- */

  const caseFields = () => [
    { key: 'bank', label: '申請銀行', required: true, list: BANKS },
    { key: 'product', label: '貸款類型', type: 'select', options: PRODUCTS },
    { key: 'applyAmount', label: '申請金額（萬元）', type: 'number' },
    { key: 'status', label: '案件狀態', type: 'select', options: CASE_STATUS },
    { key: 'approvedAmount', label: '核准金額（萬元）', type: 'number' },
    { key: 'rate', label: '利率（%）', type: 'number', placeholder: '例：2.5' },
    { key: 'months', label: '期數（月）', type: 'number', step: '1' },
    { key: 'fee', label: '服務費／佣金（萬元）', type: 'number' },
    { key: 'appliedDate', label: '送件日', type: 'date' },
    { key: 'approvedDate', label: '核准日', type: 'date' },
    { key: 'fundedDate', label: '撥款日', type: 'date' },
    { key: 'note', label: '備註', type: 'textarea', full: true, placeholder: '資金用途、承辦窗口、銀行回覆、補件事項…' },
  ];

  /** 狀態往前推時自動補日期，並同步客戶階段。 */
  function applyStatusSideEffects(k, customer) {
    const today = todayISO();
    if (['submitted', 'reviewing', 'approved', 'funded'].includes(k.status) && !k.appliedDate) k.appliedDate = today;
    if (['approved', 'funded'].includes(k.status) && !k.approvedDate) k.approvedDate = today;
    if (k.status === 'funded' && !k.fundedDate) k.fundedDate = today;
    if (k.status === 'funded' && !k.approvedAmount && k.applyAmount) k.approvedAmount = k.applyAmount;
    if (!customer) return false;
    let changed = false;
    if (k.status === 'funded' && customer.stage !== 'won') { customer.stage = 'won'; changed = true; }
    else if (ACTIVE_STATUS.has(k.status) && k.status !== 'talking' && ['lead', 'talking', 'paused'].includes(customer.stage)) {
      customer.stage = 'processing'; changed = true;
    } else if (k.status === 'talking' && customer.stage === 'lead') { customer.stage = 'talking'; changed = true; }
    return changed;
  }

  async function editCase(customerId, existing) {
    const customer = customerOf(customerId);
    const values = existing ? { ...existing } : { status: 'talking', product: PRODUCTS[0] };
    const extra = existing ? [{
      label: '刪除案件', className: 'danger',
      onClick: async (close) => {
        if (!confirm('確定要刪除這件案件？')) return;
        await Store.deleteCase(existing.id);
        await reload();
        close(null);
        render();
        openDetail(customerId);
        toast('已刪除案件');
      },
    }] : [];
    const out = await openForm(existing ? '編輯案件' : `新增案件 — ${customer ? customer.company : ''}`, caseFields(), values, extra);
    if (!out) return null;
    const k = { ...(existing || { docs: {} }), ...out, customerId };
    const changed = applyStatusSideEffects(k, customer);
    await Store.saveCase(k);
    if (changed) await Store.saveCustomer(customer);
    await reload();
    render();
    openDetail(customerId, k.id);
    toast(existing ? '已更新案件' : '已新增案件');
    return k;
  }

  /* ---------------- 詳細資料抽屜 ---------------- */

  function openDetail(id, focusCaseId) {
    const c = customerOf(id);
    if (!c) return;
    const r = view(c);
    state.openId = id;
    const body = $('#drawerBody');
    body.textContent = '';

    const editBtn = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '✎ 編輯' });
    editBtn.onclick = async () => { const saved = await editCustomer(c); if (saved) openDetail(id); };
    const dossierBtn = el('a', { className: 'btn btn-tiny nav-link', href: `dossier.html?customer=${encodeURIComponent(id)}`, textContent: '📑 徵信資料' });
    dossierBtn.title = '填五張表、產出送銀行的 Excel';
    body.append(el('div', { className: 'detail-head' }, [
      el('div', {}, [
        el('h2', { textContent: r.company }),
        el('div', { style: 'margin-top:4px' }, [
          badge(`stage-${r.stage || 'lead'}`, STAGE_LABEL[r.stage] || '潛在客戶'),
          ...(r.tags || []).map((t) => el('span', { className: 'tag', style: 'margin-left:4px', textContent: t })),
        ]),
      ]),
      el('div', { className: 'btn-row' }, [dossierBtn, editBtn]),
    ]));

    const links = phoneLinks(r);
    if (r.email) links.push(el('a', { className: 'tel', href: `mailto:${r.email}`, textContent: `✉️ ${r.email}` }));
    if (links.length) body.append(el('div', { className: 'card-actions' }, links));

    const dl = el('dl', { className: 'detail-grid' });
    [
      ['統一編號', r.taxId], ['負責人', r.owner],
      ['聯絡人', r.contact ? `${r.contact}${r.title ? `（${r.title}）` : ''}` : ''],
      ['產業別', r.industry], ['成立年', r.founded],
      ['資本額', r.capital ? fmtWan(r.capital) : ''], ['年營收', r.revenue ? fmtWan(r.revenue) : ''],
      ['員工人數', r.employees ? `${r.employees} 人` : ''], ['客戶來源', r.source],
      ['下次跟進', r.nextDate ? `${rocLabel(r.nextDate)}（${r.nextDate}）` : ''],
      ['建檔', new Date(r.createdAt).toLocaleDateString('zh-TW')],
    ].forEach(([k, v]) => { if (v) dl.append(el('dt', { textContent: k }), el('dd', { textContent: v })); });
    if (r.address) {
      dl.append(el('dt', { textContent: '地址' }), el('dd', {}, [el('a', {
        href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.address)}`,
        target: '_blank', rel: 'noopener', textContent: r.address,
      })]));
    }
    if (r.note) dl.append(el('dt', { textContent: '備註' }), el('dd', { style: 'white-space:pre-wrap', textContent: r.note }));
    body.append(dl);

    /* 案件 */
    const addCase = el('button', { className: 'btn btn-tiny btn-primary', type: 'button', textContent: '＋ 新增案件' });
    addCase.onclick = () => editCase(id);
    const caseSec = el('div', { className: 'detail-section' }, [
      el('div', { className: 'section-head' }, [el('h3', { textContent: `貸款案件（${r.cases.length}）` }), addCase]),
    ]);
    if (!r.cases.length) caseSec.append(el('p', { className: 'muted', textContent: '還沒有案件。談到具體的銀行與金額時就建一件，方便追進度。' }));
    r.cases.forEach((k) => caseSec.append(caseBox(k, c, k.id === focusCaseId)));
    body.append(caseSec);

    /* 跟進紀錄表單 */
    const sec = el('div', { className: 'detail-section' }, [el('h3', { textContent: '記錄這次跟進' })]);
    const form = el('div', { className: 'logform' });
    const memo = el('textarea', { placeholder: '聊了什麼、客戶的反應、下一步…' });
    const typeSel = el('select');
    NOTE_TYPES.forEach((t) => typeSel.append(el('option', { value: t, textContent: t })));
    const caseSel = el('select');
    caseSel.append(el('option', { value: '', textContent: '不指定案件' }));
    r.cases.forEach((k) => caseSel.append(el('option', { value: k.id, textContent: `${k.bank} ${fmtWan(k.applyAmount)}` })));
    if (focusCaseId) caseSel.value = focusCaseId;
    const nextInput = el('input', { type: 'date', value: r.nextDate || '' });
    const quick = el('div', { className: 'card-actions' });
    [['明天', 1], ['3 天後', 3], ['一週後', 7], ['兩週後', 14], ['一個月後', 30], ['三個月後', 90]].forEach(([label, days]) => {
      const b = el('button', { className: 'btn btn-tiny', type: 'button', textContent: label });
      b.onclick = () => { nextInput.value = addDays(todayISO(), days); };
      quick.append(b);
    });
    const save = el('button', { className: 'btn btn-primary', type: 'button', textContent: '儲存' });
    save.onclick = async () => {
      const text = memo.value.trim();
      if (!text && nextInput.value === (r.nextDate || '')) { toast('請填寫內容或更改下次跟進日'); return; }
      if (text) {
        await Store.saveNote({ customerId: id, caseId: caseSel.value || null, date: todayISO(), type: typeSel.value, text });
      }
      c.nextDate = nextInput.value || '';
      await Store.saveCustomer(c);
      await reload();
      render();
      openDetail(id);
      toast('已儲存跟進紀錄');
    };
    form.append(memo, el('div', { className: 'row' }, [
      el('span', { className: 'muted', textContent: '方式' }), typeSel,
      r.cases.length ? el('span', { className: 'muted', textContent: '案件' }) : '',
      r.cases.length ? caseSel : '',
      el('span', { className: 'muted', textContent: '下次跟進' }), nextInput, save,
    ]), quick);
    sec.append(form);
    body.append(sec);

    /* 時間軸 */
    const notes = notesOf(id);
    if (notes.length) {
      const tl = el('div', { className: 'detail-section' }, [el('h3', { textContent: `跟進紀錄（${notes.length}）` })]);
      const ul = el('ul', { className: 'timeline' });
      notes.forEach((n) => {
        const k = n.caseId ? state.cases.find((x) => x.id === n.caseId) : null;
        const li = el('li', {}, [
          el('time', {}, [
            document.createTextNode(rocLabel(n.date)),
            el('span', { className: 'note-type', textContent: n.type || '' }),
            k ? document.createTextNode(` · ${k.bank}`) : '',
          ]),
          el('p', { textContent: n.text }),
        ]);
        const del = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '刪除' });
        del.onclick = async () => {
          if (!confirm('刪除這則紀錄？')) return;
          await Store.deleteNote(n.id);
          await reload();
          openDetail(id);
        };
        li.append(del);
        ul.append(li);
      });
      tl.append(ul);
      body.append(tl);
    }

    $('#drawer').hidden = false;
    document.body.style.overflow = 'hidden';
    if (focusCaseId) {
      const target = body.querySelector('.case-box.is-target');
      if (target) setTimeout(() => target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
    }
  }

  function caseBox(k, customer, isTarget) {
    const box = el('div', { className: `case-box${isTarget ? ' is-target' : ''}` });
    const statusSel = el('select', { title: '更改案件狀態' });
    CASE_STATUS.forEach(([v, t]) => statusSel.append(el('option', { value: v, textContent: t })));
    statusSel.value = k.status;
    statusSel.onchange = async () => {
      k.status = statusSel.value;
      const changed = applyStatusSideEffects(k, customer);
      await Store.saveCase(k);
      if (changed) await Store.saveCustomer(customer);
      await reload();
      render();
      openDetail(customer.id, k.id);
      toast(`案件狀態改為「${CASE_LABEL[k.status]}」`);
    };
    const edit = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '✎' });
    edit.onclick = () => editCase(customer.id, k);
    box.append(el('div', { className: 'case-top' }, [
      el('b', { className: 'grow', textContent: `${k.bank || '未填銀行'}${k.product ? ` · ${k.product}` : ''}` }),
      statusSel, edit,
    ]));
    const meta = el('div', { className: 'case-meta' });
    [
      k.applyAmount && `申請 ${fmtWan(k.applyAmount)}`,
      k.approvedAmount && `核准 ${fmtWan(k.approvedAmount)}`,
      k.rate && `利率 ${k.rate}%`,
      k.months && `${k.months} 期`,
      k.fee && `服務費 ${fmtWan(k.fee)}`,
      k.appliedDate && `送件 ${rocLabel(k.appliedDate)}`,
      k.approvedDate && `核准 ${rocLabel(k.approvedDate)}`,
      k.fundedDate && `撥款 ${rocLabel(k.fundedDate)}`,
      `更新 ${daysSince(k.updatedAt)} 天前`,
    ].filter(Boolean).forEach((t) => meta.append(el('span', { textContent: t })));
    box.append(meta);
    if (k.note) box.append(el('p', { className: 'case-note', textContent: k.note }));

    // 文件清單
    const docs = k.docs || {};
    const done = DOCS.filter(([key]) => docs[key]).length;
    const details = el('details', { className: 'docs', open: k.status === 'collecting' || isTarget });
    details.append(el('summary', { textContent: `文件清單 ${done}/${DOCS.length}` }));
    details.append(el('div', { className: 'progress' }, [el('i', { style: `width:${(done / DOCS.length) * 100}%` })]));
    const ul = el('ul');
    DOCS.forEach(([key, label]) => {
      const cb = el('input', { type: 'checkbox', checked: !!docs[key] });
      const lab = el('label', { className: docs[key] ? 'is-done' : '' }, [cb, document.createTextNode(label)]);
      cb.onchange = async () => {
        k.docs = { ...(k.docs || {}), [key]: cb.checked };
        lab.classList.toggle('is-done', cb.checked);
        await Store.saveCase(k);
        await reload();
        const n = DOCS.filter(([d]) => k.docs[d]).length;
        details.querySelector('summary').textContent = `文件清單 ${n}/${DOCS.length}`;
        details.querySelector('.progress i').style.width = `${(n / DOCS.length) * 100}%`;
      };
      ul.append(el('li', {}, [lab]));
    });
    details.append(ul);
    box.append(details);
    return box;
  }

  function closeOverlays() {
    $('#drawer').hidden = true;
    $('#importer').hidden = true;
    state.openId = null;
    document.body.style.overflow = '';
  }

  /* ---------------- CSV 匯入 ---------------- */

  const IMPORT_RULES = [
    ['company', ['公司名稱', '公司', '客戶名稱', '客戶', '名稱', 'company']],
    ['taxId', ['統一編號', '統編', 'taxid']],
    ['owner', ['負責人']],
    ['contact', ['聯絡人', '窗口', 'keyman', 'key man', '關鍵人']],
    ['title', ['職稱']],
    ['mobile', ['手機', '行動電話', 'mobile']],
    ['phone', ['公司電話', '電話', 'tel', 'phone']],
    ['email', ['email', 'e-mail', '信箱', '電子郵件']],
    ['address', ['地址', 'address']],
    ['industry', ['產業別', '產業', '行業']],
    ['founded', ['成立年', '成立']],
    ['capital', ['資本額', '資本']],
    ['revenue', ['營收', '營業額']],
    ['employees', ['員工', '人數']],
    ['source', ['來源']],
    ['stage', ['階段', '狀態']],
    ['nextDate', ['下次跟進', '下次聯絡', '下次']],
    ['tags', ['標籤', 'tag']],
    ['note', ['備註', '說明', '需求', '訪談內容', 'note']],
  ];

  function mapHeader(cells) {
    const map = {};
    const used = new Set();
    cells.forEach((raw, i) => {
      const h = String(raw || '').trim().toLowerCase();
      if (!h) return;
      for (const [key, names] of IMPORT_RULES) {
        if (used.has(key)) continue;
        if (names.some((n) => h.includes(n.toLowerCase()))) { map[key] = i; used.add(key); break; }
      }
    });
    return map;
  }

  function logLine(text, cls) {
    $('#importLog').prepend(el('div', { className: cls || '', textContent: text }));
  }

  async function importFiles(files) {
    const wanted = [...files].filter((f) => /\.csv$/i.test(f.name) || f.type === 'text/csv');
    if (!wanted.length) { logLine('沒有偵測到 CSV 檔案（Excel 請先另存成 CSV UTF-8）', 'err'); return; }
    const stageByLabel = Object.fromEntries(STAGES.map(([k, v]) => [v, k]));

    for (const file of wanted) {
      try {
        let text = await file.text();
        if (text.includes('�')) {
          // 不是 UTF-8，很可能是 Excel 預設的 Big5
          try { text = new TextDecoder('big5').decode(await file.arrayBuffer()); } catch (e) { /* ignore */ }
        }
        const rows = window.Normalize.parseCsv(text);
        if (rows.length < 2) { logLine(`⚠️ ${file.name}：沒有資料列`, 'err'); continue; }
        const map = mapHeader(rows[0]);
        if (map.company == null) { logLine(`⚠️ ${file.name}：找不到「公司名稱」欄位`, 'err'); continue; }
        const cell = (row, key) => (map[key] != null ? String(row[map[key]] || '').trim() : '');

        let added = 0;
        let updated = 0;
        const batch = [];
        rows.slice(1).forEach((row) => {
          const company = cell(row, 'company');
          if (!company) return;
          const taxId = window.Normalize.toHalfWidth(cell(row, 'taxId')).replace(/\D/g, '');
          const existing = state.customers.find((c) => (taxId && c.taxId === taxId) || c.company === company);
          const c = existing ? { ...existing } : { stage: 'lead', tags: [], source: '' };
          const assign = (key, val) => { if (val !== '') c[key] = val; };
          assign('company', company);
          assign('taxId', taxId);
          ['owner', 'contact', 'title', 'mobile', 'phone', 'email', 'address', 'industry', 'founded', 'source', 'note']
            .forEach((key) => assign(key, cell(row, key)));
          ['capital', 'revenue', 'employees'].forEach((key) => { const v = cell(row, key); if (v) assign(key, num(v)); });
          const stage = cell(row, 'stage');
          if (stage) assign('stage', stageByLabel[stage] || (STAGE_LABEL[stage] ? stage : c.stage));
          const next = cell(row, 'nextDate');
          if (next) assign('nextDate', window.Normalize.parseDate(next) || '');
          const tags = parseTags(cell(row, 'tags'));
          if (tags.length) c.tags = [...new Set([...(c.tags || []), ...tags])];
          Object.assign(c, window.Normalize.parseAddress(c.address || ''));
          batch.push(c);
          existing ? updated++ : added++;
        });
        await Store.saveCustomers(batch);
        await reload();
        logLine(`✅ ${file.name}：新增 ${added} 位、更新 ${updated} 位客戶`, 'ok');
      } catch (err) {
        console.error(err);
        logLine(`❌ ${file.name}：${err.message || '解析失敗'}`, 'err');
      }
    }
    render();
  }

  /* ---------------- 匯出 ---------------- */

  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;

  function exportCustomersCsv() {
    const head = ['公司名稱', '統一編號', '負責人', '聯絡人', '職稱', '手機', '公司電話', 'Email', '地址', '縣市', '產業別',
      '成立年', '資本額(萬)', '年營收(萬)', '員工人數', '客戶來源', '客戶階段', '下次跟進日', '標籤', '備註',
      '進行中案件數', '進行中申請金額(萬)', '累計撥款(萬)', '案件摘要', '最近跟進紀錄'];
    const lines = [head.map(esc).join(',')];
    state.customers.map(view).forEach((r) => {
      const summary = r.cases.map((k) => `${k.bank} ${k.product || ''} ${fmtWan(k.applyAmount)} [${CASE_LABEL[k.status]}]`).join('\n');
      const latest = notesOf(r.id).slice(0, 5).map((n) => `${rocLabel(n.date)} [${n.type}] ${n.text}`).join('\n');
      lines.push([r.company, r.taxId, r.owner, r.contact, r.title, r.mobile, r.phone, r.email, r.address, r.city, r.industry,
        r.founded, r.capital, r.revenue, r.employees, r.source, STAGE_LABEL[r.stage] || '', r.nextDate ? rocLabel(r.nextDate) : '',
        (r.tags || []).join('、'), r.note, r.activeCases.length, r.activeAmount, r.fundedAmount, summary, latest].map(esc).join(','));
    });
    download(`客戶清單_${todayISO()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }

  function exportCasesCsv() {
    const head = ['公司名稱', '統一編號', '申請銀行', '貸款類型', '案件狀態', '申請金額(萬)', '核准金額(萬)', '利率(%)', '期數',
      '服務費(萬)', '送件日', '核准日', '撥款日', '文件齊全度', '缺少文件', '備註', '最後更新'];
    const lines = [head.map(esc).join(',')];
    [...state.cases].sort((a, b) => b.updatedAt - a.updatedAt).forEach((k) => {
      const c = customerOf(k.customerId) || {};
      const missing = DOCS.filter(([key]) => !(k.docs && k.docs[key])).map(([, l]) => l);
      lines.push([c.company, c.taxId, k.bank, k.product, CASE_LABEL[k.status], k.applyAmount, k.approvedAmount, k.rate, k.months,
        k.fee, k.appliedDate ? rocLabel(k.appliedDate) : '', k.approvedDate ? rocLabel(k.approvedDate) : '',
        k.fundedDate ? rocLabel(k.fundedDate) : '', `${DOCS.length - missing.length}/${DOCS.length}`, missing.join('、'),
        k.note, new Date(k.updatedAt).toLocaleDateString('zh-TW')].map(esc).join(','));
    });
    download(`貸款案件_${todayISO()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }

  /* ---------------- 啟動 ---------------- */

  async function reload() {
    const [customers, cases, notes] = await Promise.all([Store.allCustomers(), Store.allCases(), Store.allNotes()]);
    state.customers = customers;
    state.cases = cases;
    state.notes = notes;
  }

  function wireEvents() {
    $('#search').oninput = (e) => { state.search = e.target.value; state.limit = PAGE_SIZE; render(); };
    $('#sortBy').onchange = (e) => { state.sort = e.target.value; render(); };
    $('#hideClosed').onchange = (e) => { state.hideClosed = e.target.checked; render(); };
    $('#btnMore').onclick = () => { state.limit += PAGE_SIZE; renderCustomers(); };
    $('#fltIndustry').oninput = (e) => { state.filters.industry = e.target.value.trim(); state.limit = PAGE_SIZE; render(); };
    $('#btnResetFilters').onclick = () => {
      state.filters = emptyFilters();
      $('#fltIndustry').value = '';
      state.limit = PAGE_SIZE;
      render();
    };
    $('#btnFilters').onclick = () => {
      const open = $('#filters').classList.toggle('is-open');
      $('#btnFilters').setAttribute('aria-expanded', String(open));
      $('#btnFilters').textContent = open ? '篩選 ▴' : '篩選 ▾';
    };
    $('#tabs').onclick = (e) => {
      const btn = e.target.closest('.tab');
      if (!btn || btn.id === 'btnFilters') return;
      state.tab = btn.dataset.tab;
      state.limit = PAGE_SIZE;
      [...$('#tabs').children].forEach((b) => b.classList.toggle('is-active', b === btn));
      render();
    };

    $('#btnNew').onclick = async () => { const c = await editCustomer(null); if (c) openDetail(c.id); };
    $('#formBox').onsubmit = (e) => { e.preventDefault(); closeForm(readForm()); };
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-form-cancel]')) closeForm(null);
      else if (e.target.closest('[data-close]')) closeOverlays();
      if (!e.target.closest('#menu') && !e.target.closest('#btnMenu')) $('#menu').hidden = true;
    });

    $('#btnPick').onclick = () => $('#filePick').click();
    $('#filePick').onchange = (e) => { importFiles(e.target.files); e.target.value = ''; };
    const dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('is-over'); }));
    dz.addEventListener('drop', (e) => importFiles(e.dataTransfer.files));

    $('#btnMenu').onclick = () => { $('#menu').hidden = !$('#menu').hidden; };
    $('#menu').onclick = async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      $('#menu').hidden = true;
      if (act === 'import-csv') { $('#importLog').textContent = ''; $('#importer').hidden = false; }
      if (act === 'export-customers') exportCustomersCsv();
      if (act === 'export-cases') exportCasesCsv();
      if (act === 'export-json') download(`客戶管理備份_${todayISO()}.json`, JSON.stringify(await Store.exportAll()), 'application/json');
      if (act === 'import-json') $('#jsonPick').click();
      if (act === 'theme') {
        const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
        document.body.dataset.theme = next;
        document.documentElement.dataset.theme = next;
        localStorage.setItem('theme', next);
      }
      if (act === 'wipe') {
        if (confirm('確定要清除這台裝置上的所有客戶、案件與跟進紀錄嗎？此動作無法復原（電話推廣名單不受影響）。')) {
          await Store.wipe();
          await reload(); render();
          toast('已清除');
        }
      }
    };
    $('#jsonPick').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const dump = JSON.parse(await file.text());
        const merge = state.customers.length
          ? confirm('目前已有客戶資料。按「確定」合併（同 id 覆蓋），按「取消」則先清空再還原。')
          : false;
        await Store.importAll(dump, merge);
        await reload(); render();
        toast('備份已還原');
      } catch (err) {
        toast(`還原失敗：${err.message}`);
      }
      e.target.value = '';
    };

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#formDialog').hidden) closeForm(null);
        else closeOverlays();
      }
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        $('#search').focus();
      }
    });
  }

  /** 從電話推廣名單頁「建立為客戶」帶過來的資料。 */
  async function handlePrefill() {
    let raw;
    try { raw = localStorage.getItem('crm-prefill'); } catch (e) { return; }
    if (!raw) return;
    localStorage.removeItem('crm-prefill');
    let lead;
    try { lead = JSON.parse(raw); } catch (e) { return; }
    const existing = state.customers.find((c) => (lead.leadId && c.leadId === lead.leadId)
      || (lead.taxId && c.taxId === lead.taxId));
    if (existing) {
      toast('這家公司已經是客戶了');
      openDetail(existing.id);
      return;
    }
    const c = await editCustomer(null, lead);
    if (c) openDetail(c.id);
  }

  async function init() {
    const saved = localStorage.getItem('theme');
    if (saved) {
      document.body.dataset.theme = saved;
      document.documentElement.dataset.theme = saved;
    }
    wireEvents();
    await reload();
    const params = new URLSearchParams(location.search);
    if (params.get('tab')) {
      state.tab = params.get('tab');
      [...$('#tabs').children].forEach((b) => b.classList.toggle('is-active', b.dataset.tab === state.tab));
    }
    render();
    await handlePrefill();
    if (params.get('open')) openDetail(params.get('open'));
  }

  init().catch((err) => {
    console.error(err);
    toast(`初始化失敗：${err.message}`);
  });
})();
