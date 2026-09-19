/*
 * dossier.js — 徵信資料編輯：列表、五個段落的表格、貼上填入、自動儲存、下載 Excel。
 */
(function () {
  'use strict';

  const Store = window.CrmStore;
  const M = window.DossierModel;
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, props, children) => {
    const node = Object.assign(document.createElement(tag), props || {});
    (children || []).forEach((c) => { if (c !== '' && c != null) node.append(c); });
    return node;
  };
  const fmt = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('zh-Hant-TW', { maximumFractionDigits: 2 }));

  const state = {
    dossiers: [],
    customers: [],
    current: null,
    tab: 'debts',
    search: '',
  };

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  /* ---------------- 儲存 ---------------- */

  let saveTimer = null;
  function scheduleSave() {
    $('#saveState').textContent = '輸入中…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 500);
  }
  async function saveNow() {
    if (!state.current) return;
    const d = state.current;
    d.company = $('#fCompany').value.trim();
    d.taxId = $('#fTaxId').value.trim().replace(/\D/g, '');
    d.owner = $('#fOwner').value.trim();
    d.baseDate = $('#fBaseDate').value.trim();
    await Store.saveDossier(d);
    const t = new Date();
    $('#saveState').textContent = `已自動儲存 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    renderTabs();
  }

  /* ---------------- 列表 ---------------- */

  function renderList() {
    const q = state.search.trim().toLowerCase();
    const list = state.dossiers
      .filter((d) => !q || [d.company, d.taxId, d.owner, d.baseDate].join(' ').toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const host = $('#cards');
    host.textContent = '';
    list.forEach((d) => {
      const filled = M.sectionFilled(d);
      const doneCount = Object.values(filled).filter(Boolean).length;
      const node = el('article', { className: 'card', tabIndex: 0 }, [
        el('div', { className: 'card-top' }, [
          el('span', { className: 'card-name', textContent: d.company || '（未命名）' }),
          el('span', { className: `badge ${doneCount === 5 ? 'stage-won' : ''}`, textContent: `${doneCount}/5 完成` }),
        ]),
        el('div', { className: 'card-meta' }, [
          d.taxId ? el('span', { textContent: `統編 ${d.taxId}` }) : '',
          d.owner ? el('span', { textContent: `👤 ${d.owner}` }) : '',
          d.baseDate ? el('span', { textContent: `📅 基準日 ${d.baseDate}` }) : '',
          el('span', { textContent: `更新 ${new Date(d.updatedAt).toLocaleString('zh-TW', { hour12: false })}` }),
        ]),
        el('div', { className: 'doss-progress' }, M.SECTIONS.map((s) => el('span', {
          className: filled[s.key] ? 'is-done' : '', textContent: s.short,
        }))),
      ]);
      node.onclick = () => openDossier(d.id);
      node.onkeydown = (e) => { if (e.key === 'Enter') openDossier(d.id); };
      host.append(node);
    });
    $('#listSummary').textContent = `${list.length} 份徵信資料`;
    $('#emptyState').hidden = !!state.dossiers.length;
    $('#brandSub').textContent = state.dossiers.length ? `${state.dossiers.length} 份資料` : '五張表 → 一份 Excel';
  }

  function showList() {
    state.current = null;
    $('#editView').hidden = true;
    $('#listView').hidden = false;
    history.replaceState(null, '', location.pathname);
    renderList();
  }

  /* ---------------- 編輯 ---------------- */

  async function openDossier(id) {
    const d = await Store.getDossier(id);
    if (!d) { toast('找不到這份資料'); return; }
    state.current = normalize(d);
    $('#listView').hidden = true;
    $('#editView').hidden = false;
    $('#fCompany').value = d.company || '';
    $('#fTaxId').value = d.taxId || '';
    $('#fOwner').value = d.owner || '';
    $('#fBaseDate').value = d.baseDate || '';
    $('#saveState').textContent = '已儲存';
    history.replaceState(null, '', `${location.pathname}?id=${encodeURIComponent(id)}`);
    renderTabs();
    renderSection();
    window.scrollTo(0, 0);
  }

  /** 舊資料缺欄位時補齊，避免後面到處判空。 */
  function normalize(d) {
    const blank = M.blankDossier();
    d.debts = d.debts || blank.debts; d.debts.rows = d.debts.rows || [];
    d.sales = d.sales || blank.sales; d.sales.rows = d.sales.rows || [];
    d.purchases = d.purchases || blank.purchases; d.purchases.rows = d.purchases.rows || [];
    d.estates = d.estates || blank.estates; d.estates.rows = d.estates.rows || [];
    d.fin = d.fin || blank.fin; d.fin.periods = d.fin.periods || M.defaultPeriods(); d.fin.values = d.fin.values || {};
    return d;
  }

  async function createDossier(seed) {
    const d = M.blankDossier(seed);
    await Store.saveDossier(d);
    await reload();
    await openDossier(d.id);
    if (!d.company) setTimeout(() => $('#fCompany').focus(), 50);
    return d;
  }

  function renderTabs() {
    const host = $('#sectionTabs');
    host.textContent = '';
    const filled = state.current ? M.sectionFilled(state.current) : {};
    M.SECTIONS.forEach((s) => {
      const btn = el('button', { className: `tab${state.tab === s.key ? ' is-active' : ''}`, type: 'button' }, [
        document.createTextNode(s.short),
        el('span', { className: `dot${filled[s.key] ? ' is-done' : ''}` }),
      ]);
      btn.onclick = () => { state.tab = s.key; renderTabs(); renderSection(); };
      host.append(btn);
    });
  }

  function renderSection() {
    const host = $('#sectionHost');
    host.textContent = '';
    const d = state.current;
    if (!d) return;
    const section = el('div', { className: 'section' });
    const key = state.tab;
    const meta = M.SECTIONS.find((s) => s.key === key);
    section.append(el('h2', { textContent: meta.title }));

    if (key === 'debts') {
      section.append(el('p', { className: 'desc', textContent: '公司與負責人／關係人在各銀行的授信餘額（單位：仟元）。Excel 會依「類別」分組，每組自動加總計。' }));
      section.append(gridEditor(M.DEBT_COLUMNS, d.debts.rows, { defaults: { type: 'company' } }));
    }
    if (key === 'sales' || key === 'purchases') {
      const sec = d[key];
      const summary = el('textarea', {
        className: 'summary', value: sec.summary || '',
        placeholder: key === 'sales' ? '綜合說明：客戶規模、客戶集中度、收款方式…' : '綜合說明：主要供應商、付款方式、往來年資…',
      });
      summary.oninput = () => { sec.summary = summary.value; scheduleSave(); };
      section.append(summary);
      section.append(gridEditor(key === 'sales' ? M.SALES_COLUMNS : M.PURCHASE_COLUMNS, sec.rows, {
        footer: (rows) => {
          const total = rows.reduce((s, r) => s + M.num(r.monthly), 0);
          const ratio = key === 'sales' ? rows.reduce((s, r) => s + M.num(r.ratio), 0) : 0;
          return `月平均往來合計 ${fmt(total)} 仟${key === 'sales' ? ` · 佔營收比率合計 ${fmt(ratio)}%` : ''}`;
        },
      }));
    }
    if (key === 'estates') {
      section.append(el('p', { className: 'desc', textContent: '負責人與關係人名下不動產。餘值＝不動產市價－設定金額合計（單位：仟元），會自動計算。' }));
      section.append(gridEditor(M.ESTATE_COLUMNS, d.estates.rows, {
        computed: { residual: (row) => fmt(M.residualOf(row)) },
      }));
    }
    if (key === 'fin') {
      section.append(el('p', { className: 'desc', textContent: '照財報填「輸入」欄位，小計、總額、百分比會自動算出來，Excel 裡也是公式。單位：仟元。四期標題可以直接改。' }));
      section.append(finEditor(d.fin));
    }
    host.append(section);
  }

  /* ---------------- 通用表格編輯器 ---------------- */

  /** 把剪貼簿的 Excel 內容切成二維陣列（支援引號包住的多行儲存格）。 */
  function parseClipboard(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    const src = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += ch;
        continue;
      }
      if (ch === '"' && field === '') { quoted = true; continue; }
      if (ch === '\t') { row.push(field); field = ''; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
    return rows;
  }

  function gridEditor(columns, rows, opts) {
    opts = opts || {};
    const wrap = el('div');
    const tableWrap = el('div', { className: 'grid-wrap' });
    const table = el('table', { className: 'grid' });
    const editable = columns.filter((c) => !c.computed);

    const thead = el('thead');
    const hr = el('tr', {}, [el('th', { className: 'idx', textContent: '#' })]);
    columns.forEach((c) => {
      const th = el('th', { style: `min-width:${c.width || 100}px` }, [document.createTextNode(c.label)]);
      if (c.hint) th.append(el('small', { textContent: c.hint }));
      hr.append(th);
    });
    hr.append(el('th', { className: 'del' }));
    thead.append(hr);
    table.append(thead);
    const tbody = el('tbody');
    table.append(tbody);
    tableWrap.append(table);

    const footer = el('span', { className: 'muted' });
    const updateFooter = () => { footer.textContent = opts.footer ? opts.footer(rows) : `${rows.length} 列`; };

    const newRow = () => {
      const r = {};
      columns.forEach((c) => { r[c.key] = ''; });
      Object.assign(r, opts.defaults || {});
      return r;
    };

    const renderRow = (row, index) => {
      const tr = el('tr', {}, [el('td', { className: 'idx', textContent: String(index + 1) })]);
      columns.forEach((c) => {
        const td = el('td');
        if (c.computed) {
          td.className = 'computed';
          td.textContent = opts.computed && opts.computed[c.key] ? opts.computed[c.key](row) : '';
          tr.append(td);
          return;
        }
        let input;
        if (c.type === 'select') {
          input = el('select');
          (c.options || []).forEach(([v, t]) => input.append(el('option', { value: v, textContent: t })));
          input.value = row[c.key] || (c.options[0] && c.options[0][0]);
          input.onchange = () => { row[c.key] = input.value; scheduleSave(); };
        } else if (c.multiline) {
          input = el('textarea', { value: row[c.key] || '', placeholder: c.placeholder || '', rows: 2 });
          input.onkeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); focusNext(input, 'down'); }
          };
        } else {
          input = el('input', {
            type: c.type === 'number' ? 'text' : 'text', inputMode: c.type === 'number' ? 'decimal' : 'text',
            value: row[c.key] == null ? '' : row[c.key], placeholder: c.placeholder || '',
          });
          if (c.type === 'number') input.classList.add('num');
          input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); focusNext(input, 'down'); } };
        }
        if (c.type !== 'select') {
          input.oninput = () => {
            row[c.key] = c.type === 'number' ? input.value.replace(/[^\d.\-]/g, '') : input.value;
            if (opts.computed) refreshComputed(tr, row);
            updateFooter();
            scheduleSave();
          };
          input.onpaste = (e) => handlePaste(e, index, editable.indexOf(c));
        }
        input.dataset.col = String(columns.indexOf(c));
        td.append(input);
        if (c.type === 'number') td.className = 'num';
        tr.append(td);
      });
      const del = el('button', { type: 'button', textContent: '✕', title: '刪除這列' });
      del.onclick = () => { rows.splice(index, 1); renderBody(); scheduleSave(); };
      tr.append(el('td', { className: 'del' }, [del]));
      return tr;
    };

    const refreshComputed = (tr, row) => {
      columns.forEach((c, i) => {
        if (!c.computed) return;
        tr.children[i + 1].textContent = opts.computed[c.key] ? opts.computed[c.key](row) : '';
      });
    };

    const renderBody = () => {
      tbody.textContent = '';
      if (!rows.length) rows.push(newRow());
      rows.forEach((row, i) => tbody.append(renderRow(row, i)));
      updateFooter();
    };

    const handlePaste = (e, rowIndex, colIndex) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (!text || (!text.includes('\t') && !text.includes('\n'))) return; // 單格照一般貼上
      e.preventDefault();
      const cells = parseClipboard(text);
      cells.forEach((line, dy) => {
        while (rows.length <= rowIndex + dy) rows.push(newRow());
        const row = rows[rowIndex + dy];
        line.forEach((val, dx) => {
          const col = editable[colIndex + dx];
          if (!col) return;
          if (col.type === 'select') {
            const hit = (col.options || []).find(([v, t]) => v === val || t === val);
            row[col.key] = hit ? hit[0] : row[col.key];
          } else if (col.type === 'number') {
            row[col.key] = val.replace(/[^\d.\-]/g, '');
          } else row[col.key] = val;
        });
      });
      renderBody();
      scheduleSave();
      toast(`已貼上 ${cells.length} 列`);
    };

    const focusNext = (input, dir) => {
      const td = input.closest('td');
      const tr = td.parentElement;
      const colIdx = [...tr.children].indexOf(td);
      let target = null;
      if (dir === 'down') {
        let next = tr.nextElementSibling;
        if (!next) { rows.push(newRow()); renderBody(); next = tbody.lastElementChild; scheduleSave(); }
        target = next.children[colIdx].querySelector('input, select, textarea');
      }
      if (target) { target.focus(); if (target.select) target.select(); }
    };

    const add = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '＋ 新增列' });
    add.onclick = () => { rows.push(newRow()); renderBody(); tbody.lastElementChild.querySelector('input, select, textarea').focus(); };
    const add5 = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '＋ 5 列' });
    add5.onclick = () => { for (let i = 0; i < 5; i++) rows.push(newRow()); renderBody(); };
    const clean = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '清掉空白列' });
    clean.onclick = () => {
      const keep = rows.filter((r) => editable.some((c) => c.type !== 'select' && r[c.key] !== '' && r[c.key] != null));
      rows.splice(0, rows.length, ...keep);
      renderBody(); scheduleSave();
    };

    renderBody();
    wrap.append(tableWrap, el('div', { className: 'section-actions' }, [add, add5, clean, footer]));
    return wrap;
  }

  /* ---------------- 乙表編輯器 ---------------- */

  function finEditor(fin) {
    const wrap = el('div');
    const tableWrap = el('div', { className: 'grid-wrap' });
    const table = el('table', { className: 'grid fin-grid' });
    const thead = el('thead');
    const hr = el('tr', {}, [el('th', { textContent: '項目＼年度' })]);
    for (let i = 0; i < M.PERIODS; i++) {
      const th = el('th', { className: 'period', colSpan: 2 });
      const inp = el('input', { value: fin.periods[i] || '', placeholder: i === 0 ? '2026/06' : `${2025 - i + 1}年` });
      inp.oninput = () => { fin.periods[i] = inp.value; scheduleSave(); };
      th.append(inp);
      hr.append(th);
    }
    thead.append(hr);
    table.append(thead);
    const tbody = el('tbody');
    table.append(tbody);
    tableWrap.append(table);

    const inputs = {};   // key -> [input x4]
    const cells = {};    // key -> { value: td[], pct: td[] }

    const recompute = () => {
      const { values, pct } = M.computeFin(fin);
      M.FIN_ITEMS.forEach((item) => {
        for (let i = 0; i < M.PERIODS; i++) {
          if (!M.isInput(item, i)) cells[item.key].value[i].textContent = fmt(values[item.key][i]);
          cells[item.key].pct[i].textContent = `${pct[item.key][i].toFixed(2)}%`;
        }
      });
    };

    const inputOrder = [];  // 供貼上時往下填：[{key, i}]
    const addRows = (items, baseLabel) => {
      const sr = el('tr', { className: 'section-row' }, [el('td', { colSpan: 1 + M.PERIODS * 2, textContent: baseLabel })]);
      tbody.append(sr);
      items.forEach((item) => {
        const tr = el('tr', { className: `${item.total ? 'is-total' : ''} ${item.highlight ? 'is-highlight' : ''}` });
        tr.append(el('td', { className: `label l${item.level}`, textContent: item.label }));
        cells[item.key] = { value: [], pct: [] };
        inputs[item.key] = [];
        for (let i = 0; i < M.PERIODS; i++) {
          const td = el('td', { className: 'value' });
          if (M.isInput(item, i)) {
            const raw = (fin.values[item.key] || [])[i];
            const inp = el('input', { inputMode: 'decimal', value: raw == null ? '' : raw, placeholder: '0' });
            inp.oninput = () => {
              if (!fin.values[item.key]) fin.values[item.key] = ['', '', '', ''];
              fin.values[item.key][i] = inp.value.replace(/[^\d.\-]/g, '');
              recompute();
              scheduleSave();
            };
            inp.onpaste = (e) => finPaste(e, item.key, i);
            inp.onkeydown = (e) => {
              if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const pos = inputOrder.findIndex((x) => x.key === item.key && x.i === i);
                const dir = e.key === 'ArrowUp' ? -1 : 1;
                let next = pos + dir;
                while (inputOrder[next] && inputOrder[next].i !== i) next += dir;
                if (inputOrder[next]) inputs[inputOrder[next].key][inputOrder[next].i].focus();
              }
            };
            inputs[item.key][i] = inp;
            inputOrder.push({ key: item.key, i });
            td.append(inp);
          } else {
            td.className = 'value computed';
          }
          cells[item.key].value.push(td);
          const pct = el('td', { className: 'pct' });
          cells[item.key].pct.push(pct);
          tr.append(td, pct);
        }
        tbody.append(tr);
      });
    };

    const finPaste = (e, key, colIndex) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (!text || (!text.includes('\t') && !text.includes('\n'))) return;
      e.preventDefault();
      const lines = parseClipboard(text);
      const order = inputOrder.filter((x) => x.i === colIndex).map((x) => x.key);
      const start = order.indexOf(key);
      let filled = 0;
      lines.forEach((line, dy) => {
        const k = order[start + dy];
        if (!k) return;
        line.forEach((val, dx) => {
          const i = colIndex + dx;
          if (i >= M.PERIODS || !M.isInput(M.FIN_ITEMS.find((it) => it.key === k), i)) return;
          if (!fin.values[k]) fin.values[k] = ['', '', '', ''];
          fin.values[k][i] = String(val).replace(/[^\d.\-]/g, '');
          inputs[k][i].value = fin.values[k][i];
          filled++;
        });
      });
      recompute();
      scheduleSave();
      toast(`已填入 ${filled} 格`);
    };

    addRows(M.BS_ITEMS, '(一) 資產負債表 — 百分比以資產總額為基準');
    addRows(M.IS_ITEMS, '(二) 損益表 — 百分比以銷貨淨額為基準');
    recompute();

    const clear = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '清空全部數字' });
    clear.onclick = () => {
      if (!confirm('確定清空乙表所有數字？')) return;
      fin.values = {};
      renderSection();
      scheduleSave();
    };
    wrap.append(tableWrap, el('div', { className: 'section-actions' }, [
      clear,
      el('span', { className: 'muted', textContent: '藍色格子是自動計算。從 Excel 複製一整欄數字貼到第一格會自動往下填。' }),
    ]));
    return wrap;
  }

  /* ---------------- Excel ---------------- */

  async function exportExcel() {
    const d = state.current;
    if (!d) return;
    await saveNow();
    if (!d.company) { toast('請先填公司名稱'); $('#fCompany').focus(); return; }
    const btn = $('#btnExcel');
    btn.disabled = true;
    try {
      const blob = await window.DossierExcel.build(d);
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `${d.company}_徵信資料_${d.baseDate || ''}.xlsx` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('Excel 已下載');
    } catch (err) {
      console.error(err);
      toast(`產生失敗：${err.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------- 啟動 ---------------- */

  async function reload() {
    [state.dossiers, state.customers] = await Promise.all([Store.allDossiers(), Store.allCustomers()]);
    const dl = $('#customerList');
    dl.textContent = '';
    state.customers.forEach((c) => dl.append(el('option', { value: c.company, textContent: c.taxId ? `統編 ${c.taxId}` : '' })));
  }

  function wireEvents() {
    $('#search').oninput = (e) => { state.search = e.target.value; renderList(); };
    $('#btnNew').onclick = () => createDossier();
    $('#btnBack').onclick = async () => { await saveNow(); await reload(); showList(); };
    $('#btnExcel').onclick = exportExcel;
    $('#btnDelete').onclick = async () => {
      const d = state.current;
      if (!d) return;
      if (!confirm(`確定刪除「${d.company || '未命名'}」這份徵信資料？無法復原。`)) return;
      await Store.deleteDossier(d.id);
      await reload();
      showList();
      toast('已刪除');
    };
    ['#fCompany', '#fTaxId', '#fOwner', '#fBaseDate'].forEach((sel) => { $(sel).oninput = scheduleSave; });
    // 公司名稱選到既有客戶時，帶入統編／負責人並記住關聯
    $('#fCompany').onchange = () => {
      const hit = state.customers.find((c) => c.company === $('#fCompany').value.trim());
      if (!hit || !state.current) return;
      if (!$('#fTaxId').value) $('#fTaxId').value = hit.taxId || '';
      if (!$('#fOwner').value) $('#fOwner').value = hit.owner || '';
      state.current.customerId = hit.id;
      scheduleSave();
    };

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#menu') && !e.target.closest('#btnMenu')) $('#menu').hidden = true;
    });
    $('#btnMenu').onclick = () => { $('#menu').hidden = !$('#menu').hidden; };
    $('#menu').onclick = async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      $('#menu').hidden = true;
      if (act === 'export-json') {
        const blob = new Blob([JSON.stringify(await Store.exportAll())], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: `徵信資料備份_${new Date().toISOString().slice(0, 10)}.json` });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      if (act === 'import-json') $('#jsonPick').click();
      if (act === 'theme') {
        const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
        document.body.dataset.theme = next;
        document.documentElement.dataset.theme = next;
        localStorage.setItem('theme', next);
      }
    };
    $('#jsonPick').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const dump = JSON.parse(await file.text());
        const merge = state.dossiers.length || state.customers.length
          ? confirm('目前已有資料。按「確定」合併，按「取消」則先清空再還原。') : false;
        await Store.importAll(dump, merge);
        await reload();
        showList();
        toast('備份已還原');
      } catch (err) {
        toast(`還原失敗：${err.message}`);
      }
      e.target.value = '';
    };
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !$('#listView').hidden && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        $('#search').focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && state.current) { e.preventDefault(); saveNow(); }
    });
    window.addEventListener('beforeunload', () => { if (saveTimer) saveNow(); });
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
    if (params.get('id')) {
      await openDossier(params.get('id'));
      if (!state.current) showList();
      return;
    }
    if (params.get('customer')) {
      // 網址帶 customer 參數（舊的客戶管理頁已移除，留著相容）
      const cid = params.get('customer');
      const existing = state.dossiers.filter((d) => d.customerId === cid).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (existing) { await openDossier(existing.id); return; }
      const c = state.customers.find((x) => x.id === cid);
      await createDossier(c ? { customerId: c.id, company: c.company, taxId: c.taxId, owner: c.owner } : {});
      return;
    }
    showList();
  }

  init().catch((err) => {
    console.error(err);
    toast(`初始化失敗：${err.message}`);
  });
})();
