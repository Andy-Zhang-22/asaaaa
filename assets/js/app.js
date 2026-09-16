/*
 * app.js — 介面與流程。
 */
(function () {
  'use strict';

  const { OUTCOME_LABEL } = window.Normalize;
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
    tab: 'today',
    search: '',
    sort: 'next',
    limit: PAGE_SIZE,
    hideBlocked: true,
    filters: { due: '', source: new Set(), grade: new Set(), outcome: new Set(), city: new Set(), scale: new Set(), industry: '' },
  };

  /* ---------------- 工具 ---------------- */

  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const addDays = (iso, n) => {
    const d = new Date(`${iso}T00:00:00`);
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const rocLabel = (iso) => {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return `${+y - 1911}/${m}/${d}`;
  };
  const dayDiff = (iso) => Math.round(
    (new Date(`${iso}T00:00:00`) - new Date(`${todayISO()}T00:00:00`)) / 86400000
  );

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  /** 使用者自己記的狀態會覆蓋 PDF 裡的原始值。 */
  function view(record) {
    const mine = state.userStates.get(record.id);
    return {
      ...record,
      nextDate: (mine && mine.nextDate) || record.nextDate,
      lastDate: (mine && mine.lastDate) || record.lastDate,
      outcome: (mine && mine.outcome) || record.outcome,
      starred: !!(mine && mine.starred),
    };
  }

  /** 資本額（仟元）≤ 10,000 者屬微型企業營業處客戶範疇，見規則頁。 */
  function capitalScale(record) {
    const value = Number(String(record.capital || '').replace(/[^\d.]/g, ''));
    if (!value) return '';
    return value <= (window.Rules ? window.Rules.MICRO_CAPITAL_LIMIT : 10000) ? '微企範疇' : '一般組範疇';
  }

  function searchBlob(r) {
    if (!r._blob) {
      r._blob = [r.company, r.aliases.join(' '), r.taxId, r.owner, r.keyman, r.industry,
        r.phoneRaw, r.address, r.notesRaw, r.source].join(' ').toLowerCase();
    }
    return r._blob;
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

  function visibleRecords() {
    const q = state.search.trim().toLowerCase();
    const f = state.filters;
    const terms = q ? q.split(/\s+/) : [];

    let list = state.records.map(view).filter((r) => {
      if (state.hideBlocked && r.outcome === 'blocked') return false;
      if (f.source.size && !f.source.has(r.source)) return false;
      if (f.grade.size && !f.grade.has(r.grade || '未分級')) return false;
      if (f.outcome.size && !f.outcome.has(r.outcome)) return false;
      if (f.city.size && !f.city.has(r.city || '其他')) return false;
      if (f.scale.size && !f.scale.has(capitalScale(r) || '未填資本額')) return false;
      if (f.industry && !(r.industry || '').includes(f.industry)) return false;
      if (f.due) {
        const b = dueBucket(r.nextDate);
        if (f.due === 'due' && !(b === 'overdue' || b === 'today')) return false;
        if (f.due === 'overdue' && b !== 'overdue') return false;
        if (f.due === 'week' && !(b === 'overdue' || b === 'today' || b === 'week')) return false;
        if (f.due === 'none' && b !== 'none') return false;
      }
      if (terms.length) {
        const blob = searchBlob(r);
        if (!terms.every((t) => blob.includes(t))) return false;
      }
      return true;
    });

    if (state.tab === 'today') {
      list = list.filter((r) => ['overdue', 'today'].includes(dueBucket(r.nextDate)));
    }

    const gradeRank = { S: 0, 'S?': 1, A: 2, B: 3, C: 4 };
    const num = (s) => Number(String(s || '').replace(/[^\d]/g, '')) || 0;
    const cmp = {
      next: (a, b) => (a.nextDate || '9999').localeCompare(b.nextDate || '9999'),
      last: (a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''),
      grade: (a, b) => (gradeRank[a.grade] ?? 9) - (gradeRank[b.grade] ?? 9),
      capital: (a, b) => num(b.capital) - num(a.capital),
      company: (a, b) => a.company.localeCompare(b.company, 'zh-Hant'),
    }[state.sort];
    list.sort((a, b) => cmp(a, b) || a.company.localeCompare(b.company, 'zh-Hant'));
    return list;
  }

  /* ---------------- 畫面 ---------------- */

  function renderFilters() {
    const all = state.records.map(view);
    const tally = (key) => {
      const m = new Map();
      all.forEach((r) => {
        const v = key(r);
        m.set(v, (m.get(v) || 0) + 1);
      });
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

    const dueItems = [
      ['', '全部'], ['due', '今天以前（待打）'], ['overdue', '逾期'],
      ['week', '一週內'], ['none', '未排定'],
    ];
    const dueHost = $('#fltDue');
    dueHost.textContent = '';
    dueItems.forEach(([value, label]) => {
      const btn = el('button', { className: 'chip', type: 'button', textContent: label });
      btn.setAttribute('aria-pressed', state.filters.due === value ? 'true' : 'false');
      btn.onclick = () => { state.filters.due = value; state.limit = PAGE_SIZE; render(); };
      dueHost.append(btn);
    });

    chips($('#fltSource'), tally((r) => r.source), state.filters.source, (v) => v.replace(/\.pdf$/i, ''));
    chips($('#fltGrade'), tally((r) => r.grade || '未分級'), state.filters.grade);
    chips($('#fltOutcome'), tally((r) => r.outcome), state.filters.outcome, (v) => OUTCOME_LABEL[v] || v);
    chips($('#fltCity'), tally((r) => r.city || '其他').slice(0, 12), state.filters.city);
    chips($('#fltScale'), tally((r) => capitalScale(r) || '未填資本額'), state.filters.scale);

    const industries = [...new Set(all.map((r) => r.industry).filter(Boolean))].sort();
    $('#industryList').textContent = '';
    industries.forEach((i) => $('#industryList').append(el('option', { value: i })));
  }

  function outcomeBadge(r) {
    return el('span', {
      className: `badge out-${r.outcome}`,
      textContent: OUTCOME_LABEL[r.outcome] || r.outcome,
    });
  }

  function telLinks(r, limit) {
    return (limit ? r.phones.slice(0, limit) : r.phones).map((p) => {
      const a = el('a', { className: 'tel', href: `tel:${p.dial}` });
      a.append(document.createTextNode(`📞 ${p.display}${p.note ? ` · ${p.note}` : ''}`));
      a.onclick = (e) => e.stopPropagation();
      return a;
    });
  }

  function card(r) {
    const bucket = dueBucket(r.nextDate);
    const node = el('article', {
      className: `card${bucket === 'today' ? ' is-due' : ''}${bucket === 'overdue' ? ' is-overdue' : ''}`,
      tabIndex: 0,
    });
    const top = el('div', { className: 'card-top' }, [
      el('span', { className: 'card-name', textContent: r.company }),
      r.grade ? el('span', { className: `badge badge-grade badge-${r.grade}`, textContent: r.grade }) : '',
      outcomeBadge(r),
      capitalScale(r) === '微企範疇' ? el('span', { className: 'badge badge-micro', textContent: '微企範疇' }) : '',
    ].filter(Boolean));
    node.append(top);

    const meta = el('div', { className: 'card-meta' });
    const bits = [
      r.industry && `🏷 ${r.industry}`,
      (r.keyman || r.owner) && `👤 ${r.keyman || r.owner}`,
      (r.city || r.address) && `📍 ${r.city}${r.district}`,
      r.capital && `💰 ${r.capital} 仟元`,
      r.nextDate && `📅 下次 ${rocLabel(r.nextDate)}${bucket === 'overdue' ? `（逾期 ${-dayDiff(r.nextDate)} 天）` : ''}`,
      r.lastDate && `🕘 最近 ${rocLabel(r.lastDate)}`,
      `📄 ${r.source.replace(/\.pdf$/i, '')}`,
    ].filter(Boolean);
    bits.forEach((b) => meta.append(el('span', { textContent: b })));
    node.append(meta);

    const latest = (r.timeline || [])[0];
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

  function renderList() {
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
          el('p', { textContent: state.tab === 'today' ? '今天沒有到期的追蹤對象，切到「全部名單」看看。' : '試著放寬篩選條件或清除搜尋。' })
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
    const all = state.records.map(view);
    const host = $('#paneStats');
    host.textContent = '';
    if (!all.length) {
      host.append(el('div', { className: 'empty' }, [el('strong', { textContent: '匯入名單後就會有統計' })]));
      return;
    }

    const buckets = all.reduce((acc, r) => {
      acc[dueBucket(r.nextDate)] = (acc[dueBucket(r.nextDate)] || 0) + 1;
      return acc;
    }, {});
    const cards = [
      ['名單總數', all.length],
      ['逾期未聯絡', buckets.overdue || 0],
      ['今日到期', buckets.today || 0],
      ['一週內', buckets.week || 0],
      ['本機通話紀錄', state.logs.length],
      ['已約訪／有意願', all.filter((r) => ['meeting', 'interested'].includes(r.outcome)).length],
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
    section('分級', group((r) => r.grade));
    section('名單來源', group((r) => r.source), (k) => k.replace(/\.pdf$/i, ''));
    section('縣市 Top 12', group((r) => r.city));
    section('產業別 Top 12', group((r) => r.industry));
  }

  function render() {
    const total = state.records.length;
    $('#countAll').textContent = String(total);
    $('#countToday').textContent = String(
      state.records.map(view).filter((r) => ['overdue', 'today'].includes(dueBucket(r.nextDate))).length
    );
    const sources = new Set(state.records.map((r) => r.source));
    $('#brandSub').textContent = total
      ? `${total} 筆客戶 · ${sources.size} 份名單`
      : '尚未匯入名單';

    const tab = state.tab;
    $('#paneList').hidden = tab !== 'today' && tab !== 'all';
    $('#paneStats').hidden = tab !== 'stats';
    $('#paneRules').hidden = tab !== 'rules';
    // 統計與規則頁用不到左側篩選，讓內容佔滿整個寬度
    const wide = tab === 'stats' || tab === 'rules';
    document.querySelector('.layout').classList.toggle('is-wide', wide);
    $('#filters').hidden = wide;
    $('#btnFilters').hidden = wide;
    renderFilters();
    if (tab === 'stats') renderStats();
    else if (tab === 'rules') window.Rules.render($('#paneRules'));
    else renderList();
  }

  /* ---------------- 詳細資料抽屜 ---------------- */

  function openDetail(id) {
    const raw = state.records.find((r) => r.id === id);
    if (!raw) return;
    const r = view(raw);
    const body = $('#drawerBody');
    body.textContent = '';

    body.append(el('div', { className: 'detail-head' }, [
      el('h2', { textContent: r.company }),
      r.aliases.length ? el('p', { className: 'detail-alias', textContent: `關係企業：${r.aliases.join('、')}` }) : '',
      el('div', {}, [
        r.grade ? el('span', { className: `badge badge-grade badge-${r.grade}`, textContent: `分級 ${r.grade}` }) : '',
        outcomeBadge(r),
      ].filter(Boolean)),
    ].filter(Boolean)));

    if (r.phones.length) {
      const box = el('div', { className: 'card-actions' });
      telLinks(r).forEach((a) => box.append(a));
      body.append(box);
    } else if (r.phoneRaw) {
      body.append(el('p', { className: 'muted', textContent: `電話：${r.phoneRaw}` }));
    }

    const dl = el('dl', { className: 'detail-grid' });
    const rows = [
      ['統一編號', r.taxId], ['負責人', r.owner], ['KEYMAN', r.keyman],
      ['產業別', r.industry], ['成立年', r.founded],
      ['資本額', r.capital ? `${r.capital} 仟元${capitalScale(r) ? `（${capitalScale(r)}）` : ''}` : ''],
      ['下次聯絡', r.nextDate ? `${rocLabel(r.nextDate)}（${r.nextDate}）` : ''],
      ['最近聯絡', r.lastDate ? `${rocLabel(r.lastDate)}（${r.lastDate}）` : ''],
      ['名單新增', r.addedDate ? rocLabel(r.addedDate) : ''],
      ['名單來源', r.source],
    ];
    rows.forEach(([k, v]) => {
      if (!v) return;
      dl.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
    });
    if (r.address) {
      dl.append(el('dt', { textContent: '地址' }));
      const dd = el('dd');
      const link = el('a', {
        href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.address)}`,
        target: '_blank', rel: 'noopener', textContent: r.address,
      });
      dd.append(link);
      dl.append(dd);
    }
    body.append(dl);

    // 通話紀錄表單
    const section = el('div', { className: 'detail-section' }, [el('h3', { textContent: '記錄這通電話' })]);
    const form = el('div', { className: 'logform' });
    const memo = el('textarea', { placeholder: '這通電話聊了什麼？（例如：總機轉接財務長，約下週三拜訪）' });
    const outcomeSel = el('select');
    ['noanswer', 'contacted', 'interested', 'meeting', 'declined', 'blocked'].forEach((k) => {
      outcomeSel.append(el('option', { value: k, textContent: OUTCOME_LABEL[k] }));
    });
    outcomeSel.value = r.outcome === 'new' ? 'noanswer' : r.outcome;
    const nextInput = el('input', { type: 'date', value: r.nextDate || '' });
    const quick = el('div', { className: 'card-actions' });
    [['明天', 1], ['3 天後', 3], ['一週後', 7], ['兩週後', 14], ['一個月後', 30], ['三個月後', 90]].forEach(([label, days]) => {
      const b = el('button', { className: 'btn btn-tiny', type: 'button', textContent: label });
      b.onclick = () => { nextInput.value = addDays(todayISO(), days); };
      quick.append(b);
    });
    const save = el('button', { className: 'btn btn-primary', type: 'button', textContent: '儲存紀錄' });
    save.onclick = async () => {
      const text = memo.value.trim();
      if (!text && !nextInput.value) { toast('請至少填寫內容或下次聯絡日'); return; }
      const today = todayISO();
      await window.Store.addLog({
        recordId: r.id, date: today, text, outcome: outcomeSel.value, createdAt: Date.now(),
      });
      const mine = {
        recordId: r.id,
        outcome: outcomeSel.value,
        nextDate: nextInput.value || null,
        lastDate: today,
      };
      await window.Store.setState(mine);
      state.userStates.set(r.id, mine);
      state.logs = await window.Store.allLogs();
      toast('已儲存通話紀錄');
      render();
      openDetail(r.id);
      scheduleSync();
    };
    form.append(memo, el('div', { className: 'row' }, [
      el('span', { className: 'muted', textContent: '結果' }), outcomeSel,
      el('span', { className: 'muted', textContent: '下次聯絡' }), nextInput, save,
    ]));
    form.append(quick);
    section.append(form);
    body.append(section);

    // 時間軸：本機紀錄 + PDF 原始訪談內容
    const mineLogs = state.logs
      .filter((l) => l.recordId === r.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((l) => ({ date: l.date, text: l.text || `（${OUTCOME_LABEL[l.outcome] || ''}）`, mine: true, logId: l.logId }));
    const entries = mineLogs.concat(r.timeline || []);
    if (entries.length) {
      const sec = el('div', { className: 'detail-section' }, [el('h3', { textContent: `訪談紀錄（${entries.length}）` })]);
      const ul = el('ul', { className: 'timeline' });
      entries.forEach((e) => {
        const li = el('li');
        li.append(el('time', {
          className: e.mine ? 'is-mine' : '',
          textContent: `${e.date ? rocLabel(e.date) : (e.dateRaw || '日期未標示')}${e.mine ? ' · 我的紀錄' : ''}`,
        }));
        li.append(el('p', { textContent: e.text }));
        if (e.mine) {
          const del = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '刪除' });
          del.onclick = async () => {
            await window.Store.deleteLog(e.logId);
            state.logs = await window.Store.allLogs();
            openDetail(r.id);
          };
          li.append(del);
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
    document.body.style.overflow = '';
  }

  /* ---------------- 匯入 ---------------- */

  function logLine(text, cls) {
    $('#importLog').prepend(el('div', { className: cls || '', textContent: text }));
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

  async function importFiles(files) {
    const wanted = [...files].filter((f) => /\.(pdf|csv)$/i.test(f.name)
      || f.type === 'application/pdf' || f.type === 'text/csv');
    if (!wanted.length) { logLine('沒有偵測到 PDF 或 CSV 檔案', 'err'); return; }

    for (const file of wanted) {
      const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
      logLine(`⏳ 解析 ${file.name} …`);
      try {
        let rows;
        let pages = 1;
        let pageStarts = [0];
        let mode = 'csv';
        if (isCsv) {
          rows = window.Normalize.parseCsv(await file.text());
        } else {
          const buffer = await file.arrayBuffer();
          const parsed = await window.PdfTable.parsePdf(buffer, (done, total) => {
            $('#importLog').firstChild.textContent = `⏳ 解析 ${file.name} … 第 ${done}/${total} 頁`;
          });
          ({ rows, pages, pageStarts, mode } = parsed);
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
        await window.Store.deleteSource(file.name, { keepTombstone: false });   // 同名重匯 = 更新
        await window.Store.saveRecords(records);
        logLine(
          `✅ ${file.name}：${isCsv ? 'CSV' : `${pages} 頁`} → ${records.length} 筆客戶`
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

  function exportCsv() {
    const head = ['公司名稱', '關係企業', '統編', '分級', '成立年', '資本額(仟元)', '電話', '負責人',
      'KEYMAN', '產業別', '縣市', '地址', '下次聯絡日', '最近聯絡日', '洽談狀態', '名單來源',
      '我的通話紀錄', 'PDF訪談內容'];
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [head.map(esc).join(',')];
    state.records.map(view).forEach((r) => {
      const mine = state.logs.filter((l) => l.recordId === r.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((l) => `${rocLabel(l.date)} [${OUTCOME_LABEL[l.outcome] || ''}] ${l.text}`)
        .join('\n');
      lines.push([r.company, r.aliases.join('、'), r.taxId, r.grade, r.founded, r.capital,
        r.phoneRaw, r.owner, r.keyman, r.industry, r.city, r.address,
        r.nextDate ? rocLabel(r.nextDate) : '', r.lastDate ? rocLabel(r.lastDate) : '',
        OUTCOME_LABEL[r.outcome] || r.outcome, r.source, mine, r.notesRaw].map(esc).join(','));
    });
    download(`電話推廣名單_${todayISO()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
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

  /* ---------------- 啟動 ---------------- */

  async function reload() {
    const [records, logs, states] = await Promise.all([
      window.Store.allRecords(), window.Store.allLogs(), window.Store.allStates(),
    ]);
    state.records = records;
    state.logs = logs;
    state.userStates = new Map(states.map((s) => [s.recordId, s]));
  }

  function wireEvents() {
    $('#search').oninput = (e) => { state.search = e.target.value; state.limit = PAGE_SIZE; render(); };
    $('#sortBy').onchange = (e) => { state.sort = e.target.value; render(); };
    $('#hideBlocked').onchange = (e) => { state.hideBlocked = e.target.checked; render(); };
    $('#btnMore').onclick = () => { state.limit += PAGE_SIZE; renderList(); };
    $('#fltIndustry').oninput = (e) => { state.filters.industry = e.target.value.trim(); state.limit = PAGE_SIZE; render(); };
    $('#btnResetFilters').onclick = () => {
      state.filters = { due: '', source: new Set(), grade: new Set(), outcome: new Set(), city: new Set(), scale: new Set(), industry: '' };
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
    $('#btnPick').onclick = () => $('#filePick').click();
    $('#filePick').onchange = (e) => importFiles(e.target.files);

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
      if (act === 'export-csv') exportCsv();
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
        if (confirm('確定要清除這台裝置上的所有名單與通話紀錄嗎？此動作無法復原。')) {
          await window.Store.wipe();
          await reload(); render();
          toast('已清除');
        }
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
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'assets/vendor/pdfjs/pdf.worker.min.js';
    wireEvents();
    await reload();
    render();
    if (window.DriveSync.isConfigured()) {
      await showSyncTime();
      runSync({ quiet: true });          // 背景靜默同步，失敗就等使用者自己按
    }
    if (!state.records.length) $('#importer').hidden = false;
  }

  init().catch((err) => {
    console.error(err);
    toast(`初始化失敗：${err.message}`);
  });
})();
