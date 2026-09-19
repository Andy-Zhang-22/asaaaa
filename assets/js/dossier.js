/*
 * dossier.js — 徵信資料編輯：列表、五個段落的表格、貼上填入、自動儲存、下載 Excel。
 */
(function () {
  'use strict';

  const Store = window.CrmStore;
  const M = window.DossierModel;
  const SCRIPT_SRC = (document.currentScript && document.currentScript.src) || '';   // 之後非同步時 currentScript 會是 null，先記下來
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

  /* ---------------- 匯入 PDF／Excel ---------------- */

  const importState = { found: [], picks: {} };

  /** 讀進來的檔案 → 認出區塊 → 開預覽。 */
  async function importFiles(files) {
    if (!state.current) { toast('請先打開一份徵信資料'); return; }
    const list = Array.from(files || []).filter((f) => /\.(pdf|xlsx|xlsm|xls|csv|txt)$/i.test(f.name));
    if (!list.length) { toast('請選 PDF、Excel 或 CSV 檔'); return; }
    const btn = $('#btnImportFile');
    btn.disabled = true;
    const saveState = $('#saveState');
    const prevText = saveState.textContent;
    try {
      const found = [];
      for (const file of list) {
        const res = await window.DossierImport.analyze(file, (m) => { saveState.textContent = m; });
        res.found.forEach((f) => found.push({ ...f, file: file.name, source: list.length > 1 || res.tables.length > 1 ? `${file.name}${res.tables.length > 1 ? `／${f.source}` : ''}` : file.name }));
      }
      saveState.textContent = prevText;
      if (!found.length) {
        toast('沒有認出可以匯入的表格：請確認檔案裡有「銀行／科目／餘額」「統編／月平均」「地號／建號」或財務科目這類標題');
        return;
      }
      importState.found = found;
      importState.picks = {};
      found.forEach((f) => { importState.picks[f.id] = f.section; });
      renderImportPreview();
      $('#importDlg').hidden = false;
    } catch (err) {
      console.error(err);
      saveState.textContent = prevText;
      toast(`讀取失敗：${err.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  const SECTION_LABEL = Object.fromEntries(M.SECTIONS.map((s) => [s.key, s.short]));

  function renderImportPreview() {
    const host = $('#importFound');
    host.textContent = '';
    importState.found.forEach((f) => {
      const section = importState.picks[f.id];
      const box = el('div', { className: `import-block${section === 'skip' ? ' is-skip' : ''}` });
      const head = el('div', { className: 'import-block-head' });
      const sel = el('select');
      M.SECTIONS.forEach((s) => sel.append(el('option', { value: s.key, textContent: `放到 ${s.short}` })));
      sel.append(el('option', { value: 'skip', textContent: '略過這一塊' }));
      sel.value = section;
      sel.onchange = () => { importState.picks[f.id] = sel.value; renderImportPreview(); };
      const preview = section === 'skip' ? null : window.DossierImport.mapBlock(f.block, section);
      const count = !preview ? '' : preview.fin ? `${preview.fin.keys} 個科目、${preview.fin.count} 個數字` : `${preview.rows.length} 列`;
      head.append(el('strong', { textContent: `表格 ${f.id}` }), el('span', { className: 'src', textContent: `${f.source}${count ? ` · ${count}` : ''}` }), sel);
      box.append(head);
      if (preview) box.append(previewTable(preview, section));
      host.append(box);
    });
    const active = Object.values(importState.picks).filter((v) => v !== 'skip').length;
    $('#btnImportApply').disabled = !active;
    $('#btnImportApply').textContent = active ? `匯入 ${active} 塊` : '匯入';
  }

  function previewTable(preview, section) {
    const wrap = el('div', { className: 'import-preview' });
    const table = el('table');
    if (preview.fin) {
      const fin = preview.fin;
      const periods = fin.periods || state.current.fin.periods;
      table.append(el('thead', {}, [el('tr', {}, [el('th', { textContent: '科目' })].concat(periods.map((p, i) => el('th', { textContent: p || `第 ${i + 1} 期` }))))]));
      const tbody = el('tbody');
      const keys = M.FIN_ITEMS.filter((it) => fin.values[it.key]);
      keys.slice(0, 8).forEach((it) => {
        tbody.append(el('tr', {}, [el('td', { textContent: it.label })].concat(fin.values[it.key].map((v) => el('td', { className: 'num', textContent: fmt(v) })))));
      });
      table.append(tbody);
      wrap.append(table);
      if (keys.length > 8) wrap.append(el('div', { className: 'more', textContent: `…還有 ${keys.length - 8} 個科目` }));
      if (!fin.periods) wrap.append(el('div', { className: 'more', textContent: '檔案裡沒認出期別標題，會照目前的四期順序填入（最新一期在最左邊）。' }));
      return wrap;
    }
    const columns = ({ debts: M.DEBT_COLUMNS, sales: M.SALES_COLUMNS, purchases: M.PURCHASE_COLUMNS, estates: M.ESTATE_COLUMNS })[section]
      .filter((c) => !c.computed && (preview.columns.includes(c.key) || c.key === 'type'));
    table.append(el('thead', {}, [el('tr', {}, columns.map((c) => el('th', { textContent: c.label })))]));
    const tbody = el('tbody');
    preview.rows.slice(0, 5).forEach((row) => {
      tbody.append(el('tr', {}, columns.map((c) => {
        let v = row[c.key];
        if (c.key === 'type') v = (M.DEBT_TYPES.find((t) => t[0] === v) || [])[1] || v;
        return el('td', { className: c.type === 'number' ? 'num' : '', textContent: c.type === 'number' ? fmt(v) : String(v || '').replace(/\n/g, ' ／ ') });
      })));
    });
    table.append(tbody);
    wrap.append(table);
    if (preview.rows.length > 5) wrap.append(el('div', { className: 'more', textContent: `…還有 ${preview.rows.length - 5} 列` }));
    if (preview.summary) wrap.append(el('div', { className: 'more', textContent: `綜合說明：${preview.summary.slice(0, 80)}` }));
    return wrap;
  }

  async function applyImport() {
    const d = state.current;
    if (!d) return;
    const replace = $('#importReplace').checked;
    const picks = importState.found.map((f) => ({ block: f.block, section: importState.picks[f.id], replace }));
    const added = window.DossierImport.apply(d, picks);
    $('#importDlg').hidden = true;
    const parts = Object.entries(added).map(([k, n]) => `${SECTION_LABEL[k].replace(/^[①-⑤]\s*/, '')} ${n}${k === 'fin' ? ' 個數字' : ' 列'}`);
    const first = M.SECTIONS.find((s) => added[s.key]);
    if (first) state.tab = first.key;
    await saveNow();
    renderTabs();
    renderSection();
    toast(parts.length ? `已匯入：${parts.join('、')}` : '沒有新增任何資料（可能都已經存在）');
  }

  function wireImport() {
    $('#btnImportFile').onclick = () => $('#importPick').click();
    $('#importPick').onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      await importFiles(files);
    };
    $('#btnImportApply').onclick = applyImport;
    $('#importDlg').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) $('#importDlg').hidden = true; });
    // 直接把檔案拖到編輯頁
    const view = $('#editView');
    let depth = 0;
    view.addEventListener('dragenter', (e) => { if (!state.current) return; e.preventDefault(); depth++; view.classList.add('is-dragover'); });
    view.addEventListener('dragover', (e) => { if (!state.current) return; e.preventDefault(); });
    view.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) view.classList.remove('is-dragover'); });
    view.addEventListener('drop', (e) => {
      if (!state.current) return;
      e.preventDefault();
      depth = 0;
      view.classList.remove('is-dragover');
      importFiles(e.dataTransfer.files);
    });
    if (window.pdfjsLib) {
      const v = (SCRIPT_SRC.match(/[?&]v=([^&]+)/) || [])[1];
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = `assets/vendor/pdfjs/pdf.worker.min.js${v ? `?v=${v}` : ''}`;
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
    wireImport();
    await reload();
    const params = new URLSearchParams(location.search);
    if (params.get('id')) {
      await openDossier(params.get('id'));
      if (!state.current) showList();
      return;
    }
    if (params.get('lead') || params.get('company')) {
      /*
       * 從名單的客戶詳細頁過來：帶名單這筆的 id、公司名、統編、負責人。
       * 已有這家的徵信資料（同名單 id、同統編、或同公司名）就直接打開，沒有就建一份填好基本資料。
       */
      const lead = params.get('lead') || '';
      const company = (params.get('company') || '').trim();
      const taxId = (params.get('taxId') || '').replace(/\D/g, '');
      const owner = (params.get('owner') || '').trim();
      const byTime = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
      const existing = state.dossiers.filter((d) => (lead && d.leadId === lead)
        || (taxId.length === 8 && String(d.taxId || '').replace(/\D/g, '') === taxId)
        || (company && String(d.company || '').trim() === company)).sort(byTime)[0];
      history.replaceState(null, '', location.pathname);   // 網址上的參數用過就拿掉，重新整理不會再建一份
      if (existing) {
        if (lead && !existing.leadId) { existing.leadId = lead; await Store.saveDossier(existing); }
        await openDossier(existing.id);
        return;
      }
      await createDossier({ leadId: lead, company, taxId, owner });
      toast(`已用名單資料建立「${company || '未命名'}」的徵信資料`);
      return;
    }
    showList();
  }

  init().catch((err) => {
    console.error(err);
    toast(`初始化失敗：${err.message}`);
  });
})();
