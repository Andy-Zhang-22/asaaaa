/*
 * dossier-excel.js — 把一份徵信資料輸出成 Excel（六個工作表），版面比照範例。
 * 需要 ExcelJS（assets/vendor/exceljs）。
 */
(function (global) {
  'use strict';

  const M = global.DossierModel;
  const num = M.num;

  const thin = (color) => ({ style: 'thin', color: { argb: color || 'FF000000' } });
  const medium = (color) => ({ style: 'medium', color: { argb: color || 'FF000000' } });
  const boxAll = (b) => ({ top: b, left: b, bottom: b, right: b });
  const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  const KAI = '標楷體';
  const MING = '新細明體';
  const AMOUNT = '#,##0;-#,##0;';       // 0 顯示為空白（範例的空白格）
  const AMOUNT0 = '#,##0';              // 0 也顯示
  const PCT = '0.00';

  const has = (v) => v !== '' && v != null;
  const lineCount = (s) => String(s || '').split('\n').length;
  const colLetter = (n) => {
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };

  function setCell(ws, addr, value, style) {
    const c = ws.getCell(addr);
    if (value !== undefined) c.value = value;
    if (style) Object.assign(c, style);
    return c;
  }

  /* ---------- ① 金融負債表明細 ---------- */
  function sheetDebts(wb, d) {
    const ws = wb.addWorksheet('金融負債表明細', {
      views: [{ showGridLines: false }],
      pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } },
    });
    [10, 16, 9, 10, 14, 14, 24].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    const base = { font: { name: KAI, size: 12 }, alignment: { vertical: 'middle', wrapText: true } };

    ws.mergeCells('B2:F4');
    setCell(ws, 'B2', '金融負債表明細', {
      font: { name: KAI, size: 16, bold: true },
      alignment: { horizontal: 'center', vertical: 'middle' },
      border: boxAll(thin()),
    });
    ['C2', 'D2', 'E2', 'F2', 'B3', 'F3', 'B4', 'C4', 'D4', 'E4', 'F4'].forEach((a) => { ws.getCell(a).border = boxAll(thin()); });
    ws.getRow(2).height = 22; ws.getRow(3).height = 22; ws.getRow(4).height = 22;

    setCell(ws, 'B6', '基準日', { font: { name: KAI, size: 12 }, alignment: { horizontal: 'left', vertical: 'bottom' } });
    ws.mergeCells('D6:E6');
    setCell(ws, 'D6', d.baseDate || '', { font: { name: 'Times New Roman', size: 12 }, alignment: { horizontal: 'center', vertical: 'bottom' } });

    const headers = ['公司', '銀行/分行', '科目', '額度', '本次餘額', '擔保條件', '前後次差異說明'];
    headers.forEach((h, i) => setCell(ws, `${colLetter(i + 1)}7`, h, {
      ...base, alignment: { horizontal: 'center', vertical: 'middle' }, border: boxAll(thin()),
    }));
    ws.getRow(7).height = 30;

    // 依類別（公司／個人）分組，同一借款人只在第一列顯示名字，每組後面一列空白 + 總計
    const rows = (d.debts && d.debts.rows) || [];
    let r = 8;
    M.DEBT_TYPES.forEach(([type]) => {
      const group = rows.filter((x) => (x.type || 'company') === type && Object.values(x).some((v) => has(v) && v !== type));
      if (!group.length) return;
      const start = r;
      let lastBorrower = null;
      group.forEach((x) => {
        const vals = [x.borrower !== lastBorrower ? x.borrower : '', x.bank, x.subject,
          has(x.limit) ? num(x.limit) : '', has(x.balance) ? num(x.balance) : '', x.collateral, x.diff];
        lastBorrower = x.borrower;
        vals.forEach((v, i) => {
          const c = setCell(ws, `${colLetter(i + 1)}${r}`, v === '' ? null : v, {
            ...base, border: boxAll(thin()),
            alignment: { horizontal: i === 3 || i === 4 ? 'right' : 'left', vertical: 'middle', wrapText: true },
          });
          if (i === 3 || i === 4) c.numFmt = AMOUNT;
        });
        ws.getRow(r).height = 30;
        r++;
      });
      // 空白列
      for (let i = 1; i <= 7; i++) ws.getCell(`${colLetter(i)}${r}`).border = boxAll(thin());
      ws.getRow(r).height = 30;
      r++;
      // 總計
      for (let i = 1; i <= 7; i++) ws.getCell(`${colLetter(i)}${r}`).border = boxAll(thin());
      setCell(ws, `D${r}`, '總計', { ...base, alignment: { horizontal: 'center', vertical: 'middle' } });
      const sum = group.reduce((s, x) => s + num(x.balance), 0);
      setCell(ws, `E${r}`, { formula: `SUM(E${start}:E${r - 2})`, result: sum }, {
        ...base, numFmt: AMOUNT0, alignment: { horizontal: 'right', vertical: 'middle' },
      });
      ws.getRow(r).height = 30;
      r++;
    });
    if (r === 8) {
      // 沒資料也留幾列空白給人手寫
      for (let k = 0; k < 6; k++) {
        for (let i = 1; i <= 7; i++) ws.getCell(`${colLetter(i)}${r}`).border = boxAll(thin());
        ws.getRow(r).height = 30;
        r++;
      }
    }
    return ws;
  }

  /* ---------- ②③ 銷貨／進貨廠商 ---------- */
  function sheetVendors(wb, title, summaryLabel, columns, section, minRows) {
    const ws = wb.addWorksheet(title, {
      views: [{ showGridLines: false }],
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } },
    });
    const widths = { taxId: 16, name: 15, monthly: 19, terms: 12, ratio: 9, items: 11, note: 12, contact: 14, phone: 17 };
    columns.forEach((c, i) => { ws.getColumn(i + 1).width = widths[c.key] || 12; });
    const n = columns.length;
    const last = colLetter(n);
    const PURPLE = 'FF7F7FBF';
    const border = boxAll(thin(PURPLE));

    ws.mergeCells(`A1:${last}1`);
    setCell(ws, 'A1', title, { font: { name: KAI, size: 16, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
    ws.getRow(1).height = 26;

    setCell(ws, 'A2', summaryLabel, { font: { name: KAI, size: 10 }, alignment: { vertical: 'middle', wrapText: true }, border });
    ws.mergeCells(`B2:${last}2`);
    setCell(ws, 'B2', section.summary || '', { font: { name: KAI, size: 11 }, alignment: { vertical: 'top', wrapText: true }, border });
    for (let i = 3; i <= n; i++) ws.getCell(`${colLetter(i)}2`).border = border;
    ws.getRow(2).height = Math.max(42, lineCount(section.summary) * 15 + 8);

    columns.forEach((c, i) => setCell(ws, `${colLetter(i + 1)}3`, c.label.replace(/（/g, ' (').replace(/）/g, ')'), {
      font: { name: KAI, size: 11 }, fill: fill('FFCCCCFF'), border,
      alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
    }));
    ws.getRow(3).height = 30;

    const rows = (section.rows || []).filter((x) => Object.values(x).some(has));
    const total = Math.max(minRows, rows.length);
    for (let k = 0; k < total; k++) {
      const x = rows[k] || {};
      const r = 4 + k;
      columns.forEach((c, i) => {
        const v = x[c.key];
        const cell = setCell(ws, `${colLetter(i + 1)}${r}`, has(v) ? (c.type === 'number' ? num(v) : v) : null, {
          font: { name: KAI, size: 11 }, border,
          alignment: { horizontal: c.type === 'number' ? 'right' : 'left', vertical: 'middle', wrapText: true },
        });
        if (c.type === 'number') cell.numFmt = c.key === 'ratio' ? '0.0' : AMOUNT;
      });
      ws.getRow(r).height = 20;
    }
    return ws;
  }

  /* ---------- ④ 同期進銷貨比較表 ---------- */
  function sheetVat(wb, d) {
    const ws = wb.addWorksheet('同期進銷貨比較表', {
      views: [{ showGridLines: false }],
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } },
    });
    const vat = d.vat || M.blankVat();
    const nCols = 3 + M.VAT_PERIODS.length;   // 年份、項目、六期、合計
    const last = colLetter(nCols);
    [10, 10].concat(M.VAT_PERIODS.map(() => 11), [11]).forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    const PURPLE = 'FF7F7FBF';
    const border = boxAll(thin(PURPLE));
    const numFont = { name: 'Times New Roman', size: 12 };

    ws.mergeCells(`A1:${last}1`);
    setCell(ws, 'A1', '同期進銷貨比較表', { font: { name: KAI, size: 16, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
    ws.getRow(1).height = 30;

    setCell(ws, 'A2', '綜合說明', { font: { name: KAI, size: 12 }, alignment: { vertical: 'middle', wrapText: true }, border });
    ws.mergeCells(`B2:${last}2`);
    setCell(ws, 'B2', vat.summary || '', { font: { name: KAI, size: 11 }, alignment: { vertical: 'top', wrapText: true }, border });
    for (let i = 3; i <= nCols; i++) ws.getCell(`${colLetter(i)}2`).border = border;
    ws.getRow(2).height = Math.max(24, lineCount(vat.summary) * 15 + 8);

    const headers = ['年份\n(YYYY)', '項目/月'].concat(M.VAT_PERIODS, ['合計']);
    headers.forEach((h, i) => setCell(ws, `${colLetter(i + 1)}3`, h, {
      font: i >= 2 ? numFont : { name: KAI, size: 12 }, fill: fill('FFCCCCFF'), border,
      alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
    }));
    ws.getRow(3).height = 34;

    let r = 4;
    M.VAT_KINDS.forEach(([kind, label]) => {
      for (let y = 0; y < M.VAT_YEARS; y++) {
        const values = (vat[kind] && vat[kind][y]) || [];
        const year = (vat.years || [])[y] || '';
        setCell(ws, `A${r}`, /^\d+$/.test(year) ? Number(year) : year, { font: numFont, border, alignment: { horizontal: 'right', vertical: 'middle' } });
        setCell(ws, `B${r}`, label, { font: { name: KAI, size: 12 }, border, alignment: { horizontal: 'center', vertical: 'middle' } });
        M.VAT_PERIODS.forEach((_, p) => {
          const v = values[p];
          const c = setCell(ws, `${colLetter(3 + p)}${r}`, has(v) ? num(v) : null, { font: numFont, border, numFmt: AMOUNT, alignment: { horizontal: 'right', vertical: 'middle' } });
          return c;
        });
        const first = colLetter(3);
        const lastP = colLetter(2 + M.VAT_PERIODS.length);
        setCell(ws, `${last}${r}`, { formula: `SUM(${first}${r}:${lastP}${r})`, result: M.vatTotal(values) }, {
          font: { ...numFont, bold: true }, border, numFmt: AMOUNT, alignment: { horizontal: 'right', vertical: 'middle' },
        });
        ws.getRow(r).height = 20;
        r++;
      }
    });
    return ws;
  }

  /* ---------- ⑤ 不動產 ---------- */
  function sheetEstates(wb, d) {
    const ws = wb.addWorksheet('不動產', {
      views: [{ showGridLines: false }],
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.5, header: 0.3, footer: 0.3 } },
    });
    const cols = [
      ['owner', '所有權人', 12], ['address', '地址', 17], ['section', '地段', 11], ['landNo', '地號', 6],
      ['landPing', '坪數', 5], ['buildNo', '建號', 10], ['buildPing', '坪數', 10], ['marketValue', '不動產市價', 10],
      ['residual', '餘值\n(扣除所有設定後餘值)', 9], ['liens', '設定金額', 19], ['note', '備註', 15],
    ];
    cols.forEach((c, i) => { ws.getColumn(i + 1).width = c[2]; });
    const border = boxAll(thin('FF999999'));
    const font = { name: KAI, size: 10 };
    ws.getRow(1).height = 50;

    cols.forEach((c, i) => setCell(ws, `${colLetter(i + 1)}2`, c[1], {
      font, fill: fill('FFF8CBAD'), border, alignment: { vertical: 'top', wrapText: true },
    }));
    ws.getRow(2).height = 40;

    const rows = ((d.estates && d.estates.rows) || []).filter((x) => Object.values(x).some(has));
    const total = Math.max(5, rows.length);
    for (let k = 0; k < total; k++) {
      const x = rows[k] || {};
      const r = 3 + k;
      let lines = 1;
      cols.forEach((c, i) => {
        let v = x[c[0]];
        if (c[0] === 'residual') v = rows[k] ? M.residualOf(x) : '';
        else if (c[0] === 'marketValue') v = has(v) ? num(v) : '';
        const isNum = c[0] === 'residual' || c[0] === 'marketValue';
        const cell = setCell(ws, `${colLetter(i + 1)}${r}`, has(v) ? v : null, {
          font, fill: fill('FFFFFFCC'), border,
          alignment: { horizontal: isNum ? 'right' : 'left', vertical: 'top', wrapText: true },
        });
        if (isNum) cell.numFmt = AMOUNT0;
        if (!isNum) lines = Math.max(lines, lineCount(v), Math.ceil(String(v || '').length / Math.max(4, c[2] - 1)));
      });
      ws.getRow(r).height = rows[k] ? Math.max(18, lines * 14 + 4) : 15;
    }
    return ws;
  }

  /* ---------- ⑥ 乙表 財務分析 ---------- */
  function sheetFin(wb, d) {
    const ws = wb.addWorksheet('乙表財務分析', {
      views: [{ showGridLines: false }],
      pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1, margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } },
      headerFooter: { oddFooter: '&L財務分析系統&C-1' },
    });
    [24, 9.5, 7, 9.5, 7, 9.5, 7, 9.5, 7].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    const fin = d.fin || { periods: M.defaultPeriods(), values: {} };
    const periods = fin.periods || M.defaultPeriods();
    const raw = fin.values || {};
    const { values, pct } = M.computeFin(fin);
    const border = boxAll(thin());
    const BLUE = 'FF0000FF';

    setCell(ws, 'A1', '2023-01改版', { font: { name: MING, size: 10 }, alignment: { vertical: 'middle' } });
    ws.mergeCells('C1:I1');
    setCell(ws, 'C1', '中 租 迪 和 客 戶 財 務 分 析 系 統', { font: { name: KAI, size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } });
    ws.getRow(1).height = 22;

    setCell(ws, 'A2', '◉ 客戶　○ 保證公司', { font: { name: MING, size: 11 }, alignment: { horizontal: 'right', vertical: 'middle' } });
    ws.mergeCells('C2:F2');
    setCell(ws, 'C2', d.company || '', { font: { name: MING, size: 12, bold: true }, fill: fill('FFCCFFCC'), alignment: { vertical: 'middle' }, border: { bottom: thin() } });
    ws.getRow(2).height = 20;

    setCell(ws, 'A3', '(一)資產負債表', { font: { name: MING, size: 12, bold: true }, alignment: { vertical: 'bottom' } });
    ws.mergeCells('C3:F3');
    setCell(ws, 'C3', `統一編號(身分證)：${d.taxId || ''}`, { font: { name: MING, size: 9 }, alignment: { vertical: 'bottom' } });
    ws.mergeCells('H3:I3');
    setCell(ws, 'H3', '單位：仟元', { font: { name: MING, size: 11 }, alignment: { horizontal: 'right', vertical: 'bottom' } });

    const headerRow = 4;
    setCell(ws, `A${headerRow}`, '項目＼年度', { font: { name: MING, size: 11 }, alignment: { horizontal: 'left', vertical: 'middle' }, border });
    for (let i = 0; i < M.PERIODS; i++) {
      setCell(ws, `${colLetter(2 + i * 2)}${headerRow}`, periods[i] || '', { font: { name: MING, size: 11 }, alignment: { horizontal: 'center', vertical: 'middle' }, border });
      setCell(ws, `${colLetter(3 + i * 2)}${headerRow}`, '%', { font: { name: MING, size: 11 }, alignment: { horizontal: 'center', vertical: 'middle' }, border });
    }
    ws.getRow(headerRow).height = 18;

    const rowOf = {};
    let r = headerRow + 1;
    const writeItems = (items, baseKey) => {
      items.forEach((item) => { rowOf[item.key] = r; r++; });
      items.forEach((item) => {
        const row = rowOf[item.key];
        const label = setCell(ws, `A${row}`, item.label, {
          font: { name: MING, size: 11 }, border,
          alignment: { horizontal: 'left', vertical: 'middle', indent: item.level },
        });
        if (item.highlight) label.fill = fill('FFCCFFFF');
        for (let i = 0; i < M.PERIODS; i++) {
          const vc = colLetter(2 + i * 2);
          const pc = colLetter(3 + i * 2);
          const computed = !M.isInput(item, i);
          let value;
          if (item.calc) {
            const expr = item.calc.map((ref, k) => {
              const neg = ref[0] === '-';
              const key = neg ? ref.slice(1) : ref;
              return `${neg ? '-' : (k ? '+' : '')}${vc}${rowOf[key]}`;
            }).join('');
            value = { formula: expr, result: values[item.key][i] };
          } else if (item.link === 'netIncome') {
            value = { formula: `${vc}${rowOf.netIncome}`, result: values[item.key][i] };
          } else if (item.link === 'prevSurplus' && computed) {
            value = { formula: `${colLetter(2 + (i + 1) * 2)}${rowOf.surplus}`, result: values[item.key][i] };
          } else {
            const rv = (raw[item.key] || [])[i];
            value = has(rv) ? num(rv) : null;
          }
          setCell(ws, `${vc}${row}`, value, {
            font: { name: MING, size: 11, color: computed ? { argb: BLUE } : undefined },
            numFmt: computed ? AMOUNT0 : AMOUNT, border,
            alignment: { horizontal: 'right', vertical: 'middle' },
          });
          const baseRef = `${vc}$${rowOf[baseKey]}`;
          setCell(ws, `${pc}${row}`, {
            formula: `IF(${baseRef}=0,0,ROUND(${vc}${row}/${baseRef}*100,2))`, result: pct[item.key][i],
          }, {
            font: { name: MING, size: 11, color: { argb: BLUE } }, numFmt: PCT, border,
            alignment: { horizontal: 'right', vertical: 'middle' },
          });
        }
        ws.getRow(row).height = 17;
      });
    };

    // 損益表的列號要先決定（資產負債表的本期損益會參照），所以先配號再寫
    const bsStart = r;
    r += M.BS_ITEMS.length + 1; // +1 是「(二)損益表」標題列
    M.IS_ITEMS.forEach((item) => { rowOf[item.key] = r; r++; });
    r = bsStart;
    writeItems(M.BS_ITEMS, 'totalAssets');
    ws.mergeCells(`A${r}:I${r}`);
    setCell(ws, `A${r}`, '(二)損益表', { font: { name: MING, size: 12, bold: true }, alignment: { vertical: 'middle' } });
    ws.getRow(r).height = 20;
    r++;
    writeItems(M.IS_ITEMS, 'sales');
    return ws;
  }

  async function build(d) {
    if (!global.ExcelJS) throw new Error('ExcelJS 沒有載入');
    const wb = new global.ExcelJS.Workbook();
    wb.creator = '徵信資料';
    wb.created = new Date();
    sheetDebts(wb, d);
    sheetVendors(wb, '銷貨廠商資料', '綜合說明(客戶規模、客戶集中度、收款方式…等)', M.SALES_COLUMNS, d.sales || {}, 12);
    sheetVendors(wb, '進貨廠商資料', '綜合說明', M.PURCHASE_COLUMNS, d.purchases || {}, 11);
    sheetVat(wb, d);
    sheetEstates(wb, d);
    sheetFin(wb, d);
    const buffer = await wb.xlsx.writeBuffer();
    return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  global.DossierExcel = { build };
})(window);
