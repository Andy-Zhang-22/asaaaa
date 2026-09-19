/*
 * dossier-model.js — 徵信資料（送銀行六張表）的欄位定義與計算。
 * 編輯頁與 Excel 匯出共用，改欄位只要改這裡。
 */
(function (global) {
  'use strict';

  const num = (v) => {
    if (v == null || v === '') return 0;
    const n = Number(String(v).replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  /* ---------- ① 金融負債表明細 ---------- */
  const DEBT_TYPES = [['company', '公司'], ['person', '負責人／關係人']];
  const DEBT_COLUMNS = [
    { key: 'type', label: '類別', type: 'select', options: DEBT_TYPES, width: 110 },
    { key: 'borrower', label: '借款人', width: 110, placeholder: '公司簡稱或姓名' },
    { key: 'bank', label: '銀行/分行', width: 130, placeholder: '合庫/鶯歌' },
    { key: 'subject', label: '科目', width: 90, placeholder: '中擔、長擔…' },
    { key: 'limit', label: '額度（仟）', type: 'number', width: 100 },
    { key: 'balance', label: '本次餘額（仟）', type: 'number', width: 120 },
    { key: 'collateral', label: '擔保條件', width: 140 },
    { key: 'diff', label: '前後次差異說明', width: 180 },
  ];

  /* ---------- ② 銷貨廠商資料 ---------- */
  const SALES_COLUMNS = [
    { key: 'taxId', label: '公司統編', width: 100 },
    { key: 'name', label: '公司名稱', width: 160 },
    { key: 'monthly', label: '月平均往來金額（仟）', type: 'number', width: 130 },
    { key: 'terms', label: '收款條件', width: 110, placeholder: '月結 60 天' },
    { key: 'ratio', label: '佔營收比率(%)', type: 'number', width: 100 },
    { key: 'items', label: '銷貨項目', width: 120 },
    { key: 'note', label: '備註', width: 120 },
    { key: 'contact', label: '聯絡人', width: 100 },
    { key: 'phone', label: '聯絡電話', width: 120 },
  ];

  /* ---------- ③ 進貨廠商資料 ---------- */
  const PURCHASE_COLUMNS = [
    { key: 'taxId', label: '公司統編', width: 100 },
    { key: 'name', label: '公司名稱', width: 160 },
    { key: 'monthly', label: '月平均往來金額（仟）', type: 'number', width: 130 },
    { key: 'terms', label: '付款方式', width: 110, placeholder: '月結 30 天票期' },
    { key: 'items', label: '進貨項目', width: 120 },
    { key: 'note', label: '備註', width: 120 },
    { key: 'contact', label: '聯絡人', width: 100 },
    { key: 'phone', label: '聯絡電話', width: 120 },
  ];

  /* ---------- ④ 不動產 ---------- */
  const ESTATE_COLUMNS = [
    { key: 'owner', label: '所有權人', multiline: true, width: 110, placeholder: '林佳樺\n（負責人）' },
    { key: 'address', label: '地址', multiline: true, width: 160 },
    { key: 'section', label: '地段', multiline: true, width: 120 },
    { key: 'landNo', label: '地號', multiline: true, width: 70 },
    { key: 'landPing', label: '坪數', multiline: true, width: 70 },
    { key: 'buildNo', label: '建號', multiline: true, width: 80 },
    { key: 'buildPing', label: '坪數', multiline: true, width: 80 },
    { key: 'marketValue', label: '不動產市價（仟）', type: 'number', width: 110 },
    { key: 'liens', label: '設定金額（每筆一行）', multiline: true, width: 190, placeholder: '2024.08.26-H1 合作金庫 17,960仟\n2024.08.26-H2 合作金庫 640仟' },
    { key: 'lienTotal', label: '設定合計（仟）', type: 'number', width: 100, hint: '留空會自動加總「設定金額」裡的 xx仟' },
    { key: 'residual', label: '餘值（仟）', computed: true, width: 90 },
    { key: 'note', label: '備註', multiline: true, width: 170, placeholder: '（屋齡：約42年）\n建物1984.11.01完工\n用途：住家用' },
  ];

  /** 「17,960仟」「640仟」這種字樣自動加總；沒寫「仟」就抓每行最後一個數字。 */
  function lienTotalOf(row) {
    if (row.lienTotal !== '' && row.lienTotal != null) return num(row.lienTotal);
    const text = String(row.liens || '');
    let total = 0;
    const withUnit = [...text.matchAll(/([\d,]+(?:\.\d+)?)\s*仟/g)];
    if (withUnit.length) {
      withUnit.forEach((m) => { total += num(m[1]); });
      return total;
    }
    text.split(/\n/).forEach((line) => {
      const nums = line.match(/[\d,]+(?:\.\d+)?/g);
      const last = nums ? nums.filter((n) => n.replace(/[^\d]/g, '').length >= 3).pop() : null;
      if (last) total += num(last);
    });
    return total;
  }
  const residualOf = (row) => num(row.marketValue) - lienTotalOf(row);

  /* ---------- ⑤ 乙表：資產負債表 + 損益表 ---------- */
  // calc = 由哪些列加總；sign 可指定減項。link = 從別處帶入。
  const BS_ITEMS = [
    { key: 'ca', label: '流動資產', level: 0, calc: ['cash', 'securities', 'notesRecv', 'ar', 'inv', 'otherCa'] },
    { key: 'cash', label: '現金', level: 1 },
    { key: 'securities', label: '有價證券', level: 1 },
    { key: 'notesRecv', label: '應收票據', level: 1 },
    { key: 'ar', label: '應收帳款', level: 1 },
    { key: 'inv', label: '存貨', level: 1, calc: ['rawMat', 'wip', 'finished'] },
    { key: 'rawMat', label: '原物料', level: 2 },
    { key: 'wip', label: '在製品', level: 2 },
    { key: 'finished', label: '製成品', level: 2 },
    { key: 'otherCa', label: '其他流動資產', level: 1 },
    { key: 'lti', label: '長期投資', level: 0 },
    { key: 'fa', label: '固定資產', level: 0, calc: ['land', 'building', 'machine', 'otherFa'] },
    { key: 'land', label: '土地', level: 1 },
    { key: 'building', label: '建築物', level: 1 },
    { key: 'machine', label: '機器設備', level: 1 },
    { key: 'otherFa', label: '其他', level: 1 },
    { key: 'otherAssets', label: '其他資產', level: 0 },
    { key: 'totalAssets', label: '資產總額', level: 0, calc: ['ca', 'lti', 'fa', 'otherAssets'], total: true },
    { key: 'cl', label: '流動負債', level: 0, calc: ['stLoan', 'ap', 'shareholder', 'otherCl'] },
    { key: 'stLoan', label: '短期借款', level: 1, highlight: true },
    { key: 'ap', label: '應付票據及應付帳款', level: 1, highlight: true },
    { key: 'shareholder', label: '股東往來', level: 1 },
    { key: 'otherCl', label: '其他流動負債', level: 1 },
    { key: 'ltl', label: '長期負債', level: 0 },
    { key: 'otherL', label: '其他負債', level: 0 },
    { key: 'totalL', label: '負債總額', level: 0, calc: ['cl', 'ltl', 'otherL'], total: true },
    { key: 'capital', label: '股本', level: 0 },
    { key: 'surplus', label: '公積及盈餘', level: 0, calc: ['prevSurplus', 'netIncomeBs', 'adjust'] },
    { key: 'prevSurplus', label: '前期公積及盈餘', level: 1, link: 'prevSurplus' },
    { key: 'netIncomeBs', label: '本期損益', level: 1, link: 'netIncome' },
    { key: 'adjust', label: '調整項目', level: 1 },
    { key: 'equity', label: '淨值總額', level: 0, calc: ['capital', 'surplus'], total: true },
  ];

  const IS_ITEMS = [
    { key: 'sales', label: '銷貨淨額', level: 0, base: true },
    { key: 'cogs', label: '－銷貨成本', level: 1 },
    { key: 'gross', label: '銷貨毛利', level: 0, calc: ['sales', '-cogs'] },
    { key: 'opex', label: '－營業費用', level: 1 },
    { key: 'opIncome', label: '營業淨利', level: 0, calc: ['gross', '-opex'] },
    { key: 'otherIncome', label: '其他收入', level: 1 },
    { key: 'interest', label: '－利息支出', level: 2 },
    { key: 'otherExp', label: '－其他支出', level: 2 },
    { key: 'pretax', label: '稅前淨利', level: 0, calc: ['opIncome', 'otherIncome', '-interest', '-otherExp'] },
    { key: 'tax', label: '－所得稅', level: 1 },
    { key: 'netIncome', label: '稅後淨利', level: 0, calc: ['pretax', '-tax'], total: true },
  ];

  /* ---------- ⑥ 同期進銷貨比較表（401 申報書每兩個月的銷項／進項） ---------- */
  const VAT_PERIODS = ['1~2', '3~4', '5~6', '7~8', '9~10', '11~12'];
  const VAT_YEARS = 4;
  const VAT_KINDS = [['sales', '銷項'], ['purchases', '進項']];

  function defaultVatYears() {
    const y = new Date().getFullYear();
    return [0, 1, 2, 3].map((i) => String(y - i));
  }
  function blankVat() {
    const six = () => ['', '', '', '', '', ''];
    return {
      summary: '',
      years: defaultVatYears(),
      sales: [six(), six(), six(), six()],
      purchases: [six(), six(), six(), six()],
    };
  }
  /** 某一年某類別的六期合計。 */
  const vatTotal = (arr) => (arr || []).reduce((s, v) => s + num(v), 0);
  const vatFilled = (vat) => !!vat && VAT_KINDS.some(([k]) => (vat[k] || []).some((row) => (row || []).some((v) => v !== '' && v != null)));

  const FIN_ITEMS = BS_ITEMS.concat(IS_ITEMS);
  const PERIODS = 4;

  /** 預設四期標題：最近一期用「今年/月」，其餘為前三個年度。 */
  function defaultPeriods() {
    const d = new Date();
    const y = d.getFullYear();
    return [`${y}/${String(d.getMonth() + 1).padStart(2, '0')}`, `${y - 1}年`, `${y - 2}年`, `${y - 3}年`];
  }

  /**
   * 算出每一列四期的數字與百分比。
   * fin = { periods: [..4], values: { key: [v0..v3] } }
   * 回傳 { values: {key: number[]}, pct: {key: number[]} }
   */
  function computeFin(fin) {
    const raw = (fin && fin.values) || {};
    const byKey = Object.fromEntries(FIN_ITEMS.map((it) => [it.key, it]));
    const memo = {};

    // 依相依關係遞迴求值（子項先算），避免順序問題
    const val = (key, i) => {
      const id = `${key}|${i}`;
      if (id in memo) return memo[id];
      const item = byKey[key];
      let v = 0;
      if (!item) v = 0;
      else if (item.calc) {
        v = item.calc.reduce((s, ref) => (ref[0] === '-' ? s - val(ref.slice(1), i) : s + val(ref, i)), 0);
      } else if (item.link === 'netIncome') {
        v = val('netIncome', i);
      } else if (item.link === 'prevSurplus') {
        // 前一期的公積及盈餘；最舊一期沒有前期資料，自己填
        v = i + 1 < PERIODS && hasAnyInput(raw, i + 1) ? val('surplus', i + 1) : num((raw.prevSurplus || [])[i]);
      } else {
        v = num((raw[key] || [])[i]);
      }
      v = Math.round(v * 100) / 100;
      memo[id] = v;
      return v;
    };

    const values = {};
    FIN_ITEMS.forEach((item) => { values[item.key] = [0, 1, 2, 3].map((i) => val(item.key, i)); });

    const pct = {};
    FIN_ITEMS.forEach((item) => {
      const baseKey = BS_ITEMS.includes(item) ? 'totalAssets' : 'sales';
      pct[item.key] = values[item.key].map((v, i) => {
        const base = values[baseKey][i];
        return base ? Math.round((v / base) * 10000) / 100 : 0;
      });
    });
    return { values, pct };
  }

  function hasAnyInput(raw, i) {
    return FIN_ITEMS.some((item) => !item.calc && !item.link && raw[item.key] && raw[item.key][i] !== '' && raw[item.key][i] != null);
  }

  const isInput = (item, periodIndex) => !item.calc && (!item.link || (item.link === 'prevSurplus' && periodIndex === PERIODS - 1));

  function blankDossier(seed) {
    return {
      id: '',
      customerId: (seed && seed.customerId) || '',
      leadId: (seed && seed.leadId) || '',   // 名單那筆的 id，從詳細頁按「徵信資料」過來就記住
      company: (seed && seed.company) || '',
      taxId: (seed && seed.taxId) || '',
      owner: (seed && seed.owner) || '',
      baseDate: defaultBaseDate(),
      debts: { rows: [] },
      sales: { summary: '', rows: [] },
      purchases: { summary: '', rows: [] },
      vat: blankVat(),
      estates: { rows: [] },
      fin: { periods: defaultPeriods(), values: {} },
    };
  }

  function defaultBaseDate() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  /** 匯入時可以放的段落（銷貨、進貨分開），跟編輯頁的分頁不同。 */
  const IMPORT_TARGETS = [
    { key: 'debts', label: '① 金融負債' }, { key: 'sales', label: '② 銷貨廠商' }, { key: 'purchases', label: '② 進貨廠商' },
    { key: 'vat', label: '③ 進銷貨比較' }, { key: 'estates', label: '④ 不動產' }, { key: 'fin', label: '⑤ 財務分析' },
  ];
  /** 某個匯入段落屬於編輯頁的哪個分頁。 */
  const tabOf = (section) => (section === 'sales' || section === 'purchases' ? 'vendors' : section);

  const SECTIONS = [
    { key: 'debts', title: '金融負債表明細', short: '① 金融負債' },
    { key: 'vendors', title: '進銷貨廠商明細', short: '② 進銷貨廠商', parts: ['sales', 'purchases'] },   // 客戶多半一起給，編輯頁放同一頁；Excel 仍是兩張工作表
    { key: 'vat', title: '同期進銷貨比較表', short: '③ 進銷貨比較' },
    { key: 'estates', title: '不動產資料', short: '④ 不動產' },
    { key: 'fin', title: '乙表 財務分析', short: '⑤ 財務分析' },
  ];

  /** 各段落有沒有填東西，列表頁用來顯示完成度。 */
  function sectionFilled(d) {
    const rowsFilled = (rows) => (rows || []).some((r) => Object.values(r).some((v) => v !== '' && v != null));
    const raw = (d.fin && d.fin.values) || {};
    return {
      debts: rowsFilled(d.debts && d.debts.rows),
      sales: rowsFilled(d.sales && d.sales.rows) || !!(d.sales && d.sales.summary),
      purchases: rowsFilled(d.purchases && d.purchases.rows) || !!(d.purchases && d.purchases.summary),
      vendors: rowsFilled(d.sales && d.sales.rows) || !!(d.sales && d.sales.summary) || rowsFilled(d.purchases && d.purchases.rows) || !!(d.purchases && d.purchases.summary),
      vat: vatFilled(d.vat) || !!(d.vat && d.vat.summary),
      estates: rowsFilled(d.estates && d.estates.rows),
      fin: [0, 1, 2, 3].some((i) => hasAnyInput(raw, i)),
    };
  }

  global.DossierModel = {
    num, DEBT_TYPES, DEBT_COLUMNS, SALES_COLUMNS, PURCHASE_COLUMNS, ESTATE_COLUMNS,
    BS_ITEMS, IS_ITEMS, FIN_ITEMS, PERIODS, SECTIONS, IMPORT_TARGETS, tabOf,
    VAT_PERIODS, VAT_YEARS, VAT_KINDS, blankVat, defaultVatYears, vatTotal, vatFilled,
    computeFin, isInput, lienTotalOf, residualOf, blankDossier, defaultPeriods, sectionFilled,
  };
})(window);
