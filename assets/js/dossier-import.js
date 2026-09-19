/*
 * dossier-import.js — 把 PDF／Excel／CSV 丟進徵信資料頁，自動認出六張表的內容。
 *
 * 流程：
 *   1. 讀檔成一堆「表格」（每個工作表一張；PDF 用 pdf-table.js 還原格線後整份當一張）。
 *   2. 在每張表裡找「標題列」：一列裡有好幾格對得上某個段落的欄位名稱（借款人／銀行／科目、
 *      統編／月平均／收款條件、所有權人／地號／建號…），標題列到下一個標題列之間就是一塊資料。
 *      乙表財務分析沒有橫的標題列，改認第一欄的科目名稱（流動資產、銷貨淨額…）。
 *   3. 依段落把欄位對到 dossier-model 的 key，回傳給編輯頁預覽；使用者可以改段落或略過再套用。
 *
 * 自家「下載 Excel」出來的檔案可以原樣丟回來（含總計列、借款人省略、兩個「坪數」欄、% 欄）。
 */
(function (global) {
  'use strict';

  const M = global.DossierModel;

  /** 標題文字正規化：去空白、括號內容、全形符號，方便比對。 */
  const norm = (s) => String(s == null ? '' : s)
    .replace(/[\s　]/g, '')
    .replace(/[（(][^（）()]*[）)]/g, '')
    .replace(/[：:／/\\、．.,，－—-]/g, '')
    .replace(/臺/g, '台')
    .toLowerCase();

  const has = (v) => v !== '' && v != null;
  const isTotalRow = (row) => row.some((c) => /^(總計|合計|小計|合計金額|總額)$/.test(String(c || '').trim()));
  const isBlankRow = (row) => !row.some(has);

  /** 數字欄：去千分位與單位，不是數字就留空字串。 */
  function cleanNum(v) {
    if (!has(v)) return '';
    const s = String(v).replace(/[,\s，仟元千]/g, '');
    const m = s.match(/-?\d+(?:\.\d+)?/);
    return m ? m[0] : '';
  }

  /* ---------------- 欄位字典 ---------------- */
  // 每個 key 列出可能出現的標題寫法（已正規化）。anchor = 這個段落一定會有的幾個欄位之一。
  const DICT = {
    debts: {
      anchors: ['bank', 'subject', 'balance', 'limit'],
      keys: {
        type: ['類別', '種類'],
        borrower: ['借款人', '公司', '借款人公司', '公司姓名', '姓名', '借戶', '戶名', '借款戶'],
        bank: ['銀行分行', '銀行', '分行', '金融機構', '往來銀行', '銀行名稱', '債權銀行'],
        subject: ['科目', '授信科目', '貸款科目', '貸款種類', '授信種類'],
        limit: ['額度', '授信額度', '核准額度', '契約金額', '原始金額', '貸款金額'],
        balance: ['本次餘額', '餘額', '目前餘額', '貸款餘額', '授信餘額', '本期餘額', '現欠餘額'],
        collateral: ['擔保條件', '擔保', '擔保品', '擔保情形', '擔保方式'],
        diff: ['前後次差異說明', '差異說明', '差異', '說明', '備註'],
      },
    },
    sales: {
      anchors: ['monthly', 'terms', 'taxId', 'ratio', 'contact'],
      keys: {
        taxId: ['公司統編', '統編', '統一編號', '統一編號統編'],
        name: ['公司名稱', '客戶名稱', '廠商名稱', '客戶', '廠商', '名稱', '公司'],
        monthly: ['月平均往來金額', '月平均', '往來金額', '月平均金額', '平均每月往來金額', '每月往來金額', '月交易額', '交易金額'],
        terms: ['收款條件', '收款方式', '付款方式', '付款條件', '交易條件', '收付款條件', '票期'],
        ratio: ['佔營收比率', '佔營收比', '占營收比率', '營收比率', '比率', '占比', '佔比'],
        items: ['銷貨項目', '進貨項目', '項目', '產品', '品項', '交易項目', '主要品項'],
        note: ['備註', '說明'],
        contact: ['聯絡人', '連絡人', '窗口'],
        phone: ['聯絡電話', '電話', '連絡電話', '電話號碼'],
      },
    },
    estates: {
      anchors: ['landNo', 'buildNo', 'owner', 'section', 'marketValue', 'liens'],
      keys: {
        owner: ['所有權人', '所有人', '持有人', '登記名義人'],
        address: ['地址', '不動產地址', '座落', '坐落', '門牌'],
        section: ['地段', '段', '段小段', '地段小段'],
        landNo: ['地號', '土地地號'],
        landPing: ['坪數', '土地坪數', '面積', '土地面積'],
        buildNo: ['建號', '建物建號'],
        buildPing: ['建物坪數', '建物面積'],
        marketValue: ['不動產市價', '市價', '鑑價', '鑑估值', '鑑估價', '估價', '市值'],
        liens: ['設定金額', '設定', '抵押設定', '設定情形', '他項權利'],
        lienTotal: ['設定合計', '設定總額', '設定金額合計'],
        note: ['備註', '說明'],
      },
    },
  };

  /** 「收款／銷貨」與「付款／進貨」的判斷字眼。 */
  const SALES_HINT = /銷貨|收款|營收|客戶|銷售|應收/;
  const PURCHASE_HINT = /進貨|付款|供應|採購|應付/;

  /** 找出一列裡每一格對到哪個欄位。回傳 { map: {colIndex: key}, keys: Set } */
  function matchHeader(row, section) {
    const dict = DICT[section].keys;
    const map = {};
    const used = new Set();
    // 先做完全相符，再做包含比對；「坪數」第二次出現給建物
    const cells = row.map((c) => norm(c));
    const tryMatch = (exact) => {
      cells.forEach((text, col) => {
        if (!text || map[col] !== undefined) return;
        for (const [key, words] of Object.entries(dict)) {
          if (used.has(key) && !(section === 'estates' && key === 'landPing')) continue;
          const hit = words.some((w) => (exact ? text === w : text.includes(w) && text.length <= w.length + 4));
          if (!hit) continue;
          if (section === 'estates' && key === 'landPing' && used.has('landPing')) {
            if (used.has('buildPing')) continue;
            map[col] = 'buildPing'; used.add('buildPing'); return;
          }
          map[col] = key; used.add(key); return;
        }
      });
    };
    tryMatch(true);
    tryMatch(false);
    return { map, keys: used };
  }

  /** 這一列像不像某個段落的標題列？回傳分數（對到的欄位數），不夠像回 0。 */
  function headerScore(row, section) {
    const { keys } = matchHeader(row, section);
    if (keys.size < 2) return 0;
    if (!DICT[section].anchors.some((k) => keys.has(k))) return 0;
    // 標題列的格子應該都很短；資料列常常有長文字
    const long = row.filter((c) => String(c || '').length > 14).length;
    if (long > 1) return 0;
    return keys.size;
  }

  const FIN_LABELS = (() => {
    const out = new Map();
    M.FIN_ITEMS.forEach((it) => { out.set(norm(it.label), it.key); });
    // 常見的別名
    const alias = {
      cash: ['現金及約當現金', '現金及銀行存款', '庫存現金', '銀行存款'],
      securities: ['短期投資', '有價證券短期投資', '透過損益按公允價值衡量之金融資產'],
      notesRecv: ['應收票據淨額'],
      ar: ['應收帳款淨額', '應收款項'],
      inv: ['存貨淨額'],
      otherCa: ['其他流動資產合計', '預付款項', '其他應收款'],
      lti: ['長期股權投資', '採用權益法之投資'],
      fa: ['不動產廠房及設備', '固定資產淨額', '不動產廠房設備'],
      building: ['房屋及建築', '房屋建築', '建築物及設備'],
      machine: ['機器設備', '機械設備'],
      otherFa: ['其他設備', '運輸設備', '辦公設備'],
      otherAssets: ['其他非流動資產', '其他資產合計'],
      totalAssets: ['資產總計', '資產合計', '總資產'],
      cl: ['流動負債合計'],
      stLoan: ['短期借款', '銀行借款', '短期銀行借款'],
      ap: ['應付票據及帳款', '應付票據及應付帳款', '應付帳款', '應付票據', '應付款項'],
      shareholder: ['股東往來', '應付關係人款項'],
      otherCl: ['其他流動負債合計', '其他應付款', '一年內到期長期負債'],
      ltl: ['長期借款', '長期負債合計', '長期銀行借款'],
      otherL: ['其他負債合計', '其他非流動負債'],
      totalL: ['負債總計', '負債合計', '總負債'],
      capital: ['股本', '資本', '實收資本', '資本額'],
      surplus: ['公積及盈餘', '保留盈餘', '資本公積及保留盈餘'],
      prevSurplus: ['前期公積及盈餘', '期初保留盈餘', '前期盈餘'],
      netIncomeBs: ['本期損益', '本期淨利'],
      adjust: ['調整項目', '其他權益'],
      equity: ['淨值總額', '權益總額', '淨值', '股東權益總額', '股東權益', '權益合計', '淨值合計'],
      sales: ['銷貨淨額', '營業收入', '營業收入淨額', '營收', '銷貨收入', '營業收入合計', '營業收入總額'],
      cogs: ['銷貨成本', '營業成本'],
      gross: ['銷貨毛利', '營業毛利', '毛利'],
      opex: ['營業費用', '推銷及管理費用', '營業費用合計'],
      opIncome: ['營業淨利', '營業利益', '營業淨利益'],
      otherIncome: ['其他收入', '營業外收入', '營業外收入及利益', '營業外收益'],
      interest: ['利息支出', '利息費用', '財務成本'],
      otherExp: ['其他支出', '營業外支出', '營業外費用及損失', '其他損失'],
      pretax: ['稅前淨利', '稅前淨利淨損', '稅前純益', '稅前損益', '稅前利益', '本期稅前淨利'],
      tax: ['所得稅', '所得稅費用', '營利事業所得稅'],
      netIncome: ['稅後淨利', '本期淨利', '稅後純益', '稅後損益', '本期稅後淨利', '本期淨利淨損'],
    };
    Object.entries(alias).forEach(([key, words]) => words.forEach((w) => { if (!out.has(norm(w))) out.set(norm(w), key); }));
    return out;
  })();

  /** 一格文字對到哪個財務科目；「－銷貨成本」「(減)銷貨成本」都認得。 */
  function finKeyOf(text) {
    let t = norm(text).replace(/^[（(]?減[）)]?/, '').replace(/^[－\-—]/, '');
    if (!t) return null;
    if (FIN_LABELS.has(t)) return FIN_LABELS.get(t);
    // 去掉尾巴的「合計／淨額／總計」再試一次
    t = t.replace(/(合計|淨額|總計|總額)$/, '');
    return FIN_LABELS.get(t) || null;
  }

  const PERIOD_RES = [
    /^\d{2,4}年(?:度)?(?:\d{1,2}月)?$/,          // 2025年、113年度、2025年6月
    /^\d{4}[./-]\d{1,2}(?:[./-]\d{1,2})?$/,      // 2026/06、2026.06、2026-06-30
    /^\d{2,3}[/-]\d{1,2}(?:[/-]\d{1,2})?$/,      // 113/06（民國）；不收「71.13」這種小數
    /^\d{4}q[1-4]$/i, /^\d{4}h[12]$/i,
    /^\d{2,4}年?上半年$/, /^\d{2,4}年?\d{1,2}月$/,
  ];
  /** 像不像期別標題：「2025年」「2026/09」「113年度」「2024」（西元年才算，免得把 1,234 這種數字當年度）。 */
  const looksPeriod = (c) => {
    const t = String(c || '').replace(/[\s\u3000]/g, '');
    if (!t) return false;
    if (PERIOD_RES.some((re) => re.test(t))) return true;
    if (/^\d{4}$/.test(t)) { const y = Number(t); return y >= 1990 && y <= 2100; }
    return false;
  };

  /* ---------------- 同期進銷貨比較表（401） ---------------- */
  const VAT_PERIOD_RE = /^(\d{1,2})\s*[~～\-–—至]\s*(\d{1,2})\s*月?$/;
  const YEAR_RE = /^(?:(19|20)\d{2}|1[01]\d)\s*年?(?:度)?$/;
  const kindOf = (t) => (/銷項|銷貨|銷售|營業收入|收入/.test(t) ? 'sales' : /進項|進貨|採購|支出/.test(t) ? 'purchases' : null);

  /** 標題列裡「1~2、3~4…」對到第幾期；另外找年份、項目欄。 */
  function vatHeader(row) {
    const periods = {};
    let yearCol = -1;
    let kindCol = -1;
    row.forEach((c, col) => {
      const t = String(c || '').replace(/[\s\u3000]/g, '');
      const m = t.match(VAT_PERIOD_RE);
      if (m) {
        const idx = M.VAT_PERIODS.findIndex((p) => p.split('~')[0] === String(Number(m[1])));
        if (idx >= 0) periods[col] = idx;
        return;
      }
      if (yearCol < 0 && /年份|年度|年別/.test(t)) yearCol = col;
      else if (kindCol < 0 && /項目|類別|銷進|進銷/.test(t)) kindCol = col;
    });
    return { periods, yearCol, kindCol, score: Object.keys(periods).length };
  }

  function mapVat(block) {
    const header = block.header || guessVatHeader(block.rows);
    const h = vatHeader(header || []);
    const rows = [];
    const dataRows = block.header ? block.rows : block.rows.slice(1);
    let prevYear = '';
    dataRows.forEach((row) => {
      if (isBlankRow(row)) return;
      const texts = row.map(cellText);
      let year = h.yearCol >= 0 ? texts[h.yearCol] : '';
      if (!YEAR_RE.test(year)) year = texts.find((t) => YEAR_RE.test(t) && !Object.prototype.hasOwnProperty.call(h.periods, texts.indexOf(t))) || '';
      let kind = h.kindCol >= 0 ? kindOf(texts[h.kindCol]) : null;
      if (!kind) { const hit = texts.find((t) => t.length <= 6 && kindOf(t)); kind = hit ? kindOf(hit) : null; }
      if (!kind) return;
      year = year.replace(/[^\d]/g, '');
      if (!year) year = prevYear;           // 同一年的第二列省略年份
      if (year.length === 3) year = String(Number(year) + 1911);   // 民國 → 西元
      if (!year) return;
      prevYear = year;
      const values = ['', '', '', '', '', ''];
      let any = false;
      Object.entries(h.periods).forEach(([col, idx]) => { const v = cleanNum(row[col]); values[idx] = v; if (v !== '') any = true; });
      if (!any) return;
      rows.push({ year, kind, values });
    });
    return { rows, summary: summaryOf(block), count: rows.reduce((n, r) => n + r.values.filter((v) => v !== '').length, 0) };
  }

  const guessVatHeader = (rows) => rows.find((r) => vatHeader(r).score >= 3) || rows[0] || [];

  /* ---------------- 切塊 ---------------- */

  /**
   * 把一張表（二維字串陣列）切成好幾塊：{ section, header, headerRow, rows, sheet }。
   * 一般表格靠標題列；乙表財務靠第一欄科目名稱。
   */
  function splitBlocks(rows, sheetName) {
    const blocks = [];
    const nameHint = norm(sheetName || '');
    let cur = null;
    const flush = () => { if (cur) { blocks.push(cur); cur = null; } };

    // 財務科目列：找出每列的科目 key 與所在欄
    const finRows = rows.map((row) => {
      for (let col = 0; col < Math.min(row.length, 3); col++) {
        const key = finKeyOf(row[col]);
        if (key) return { key, col };
      }
      return null;
    });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (isBlankRow(row)) { if (cur) cur.rows.push(row); continue; }
      // 下一張表的標題（金融負債表明細、銷貨廠商資料…）出現，就結束上一塊
      if (cur && cur.section !== 'fin' && isTitleRow(row)) { flush(); continue; }
      let best = null;
      ['debts', 'sales', 'estates'].forEach((section) => {
        const score = headerScore(row, section);
        if (score && (!best || score > best.score)) best = { section, score };
      });
      if (vatHeader(row).score >= 3) best = { section: 'vat', score: 99 };
      if (best) {
        flush();
        let section = best.section;
        if (section === 'sales') section = vendorKind(row, rows.slice(Math.max(0, i - 3), i), nameHint);
        cur = { section, headerRow: i, header: row, rows: [], sheet: sheetName, above: rows.slice(Math.max(0, i - 4), i) };
        continue;
      }
      // 連續幾列都是財務科目 → 乙表區塊
      if (finRows[i] && !(cur && cur.section === 'fin')) {
        let run = 0;
        for (let k = i; k < rows.length && run < 4; k++) { if (finRows[k]) run++; else if (!isBlankRow(rows[k])) break; }
        if (run >= 3) {
          flush();
          cur = { section: 'fin', headerRow: i, header: null, rows: [], sheet: sheetName, above: rows.slice(Math.max(0, i - 6), i), labelCol: finRows[i].col };
        }
      }
      if (cur) cur.rows.push(row);
    }
    flush();
    // 去掉尾端空白列
    blocks.forEach((b) => { while (b.rows.length && isBlankRow(b.rows[b.rows.length - 1])) b.rows.pop(); });
    return blocks.filter((b) => b.rows.length);
  }

  const TITLE_RE = /金融負債|廠商資料|不動產|財務分析|資產負債表|損益表|徵信資料|基準日|進銷貨比較/;
  /** 只有一兩格有字、又是表名的列。 */
  function isTitleRow(row) {
    const cells = row.map(cellText).filter(Boolean);
    if (!cells.length || cells.length > 2) return false;
    return cells.some((c) => TITLE_RE.test(c) && c.length <= 40) && !cells.some((c) => /\d{3,}/.test(c));
  }

  function vendorKind(headerRow, above, nameHint) {
    const text = norm(headerRow.join('')) + norm(above.map((r) => r.join('')).join(''));
    if (PURCHASE_HINT.test(text) && !SALES_HINT.test(text)) return 'purchases';
    if (SALES_HINT.test(text) && !PURCHASE_HINT.test(text)) return 'sales';
    if (PURCHASE_HINT.test(text) && SALES_HINT.test(text)) {
      // 標題列本身優先（收款條件 vs 付款方式）
      const h = norm(headerRow.join(''));
      if (/付款|進貨/.test(h) && !/收款|銷貨/.test(h)) return 'purchases';
      return 'sales';
    }
    if (PURCHASE_HINT.test(nameHint)) return 'purchases';
    return 'sales';
  }

  /* ---------------- 各段落對應 ---------------- */

  function columnsOf(section) {
    return { debts: M.DEBT_COLUMNS, sales: M.SALES_COLUMNS, purchases: M.PURCHASE_COLUMNS, estates: M.ESTATE_COLUMNS }[section];
  }

  const cellText = (v) => (has(v) ? String(v).replace(/\r/g, '').trim() : '');

  /** 一般表格：依標題列把每列對成 {key: value}。 */
  function mapGrid(block, section) {
    const columns = columnsOf(section);
    const dictSection = section === 'purchases' ? 'sales' : section;
    const header = block.header || guessHeader(block.rows, dictSection);
    const { map } = matchHeader(header, dictSection);
    const mapped = [];
    let prev = null;
    let group = 0;   // 金融負債：第幾個「總計」之後（0 = 公司、1 = 負責人）
    const dataRows = block.header ? block.rows : block.rows.slice(1);
    for (const row of dataRows) {
      if (isBlankRow(row)) continue;
      if (isTotalRow(row)) { group++; continue; }
      const r = {};
      columns.forEach((c) => { if (!c.computed) r[c.key] = ''; });
      let any = false;
      Object.entries(map).forEach(([col, key]) => {
        const c = columns.find((x) => x.key === key);
        if (!c) return;
        let v = cellText(row[col]);
        if (c.type === 'number') v = cleanNum(v);
        if (has(v)) any = true;
        r[key] = v;
      });
      if (!any) continue;
      if (section === 'debts') {
        if (!r.borrower && prev) r.borrower = prev.borrower;   // 匯出檔同一借款人只寫第一列
        r.type = normalizeType(r.type, group);
        // 空的說明列（只有借款人）不算資料
        if (!r.bank && !r.subject && !has(r.limit) && !has(r.balance) && !r.collateral) continue;
      }
      mapped.push(r);
      prev = r;
    }
    return { rows: mapped, columns: Object.values(map) };
  }

  function normalizeType(v, group) {
    const t = norm(v);
    if (t) {
      if (/負責人|個人|關係人|保證人|董事|股東/.test(t)) return 'person';
      if (/公司|法人|企業/.test(t)) return 'company';
    }
    return group >= 1 ? 'person' : 'company';
  }

  /** 沒有標題列（使用者硬指定段落）時，拿第一列當標題試試。 */
  function guessHeader(rows, section) {
    return rows.find((r) => headerScore(r, section) > 0) || rows[0] || [];
  }

  /** 綜合說明：匯出檔在標題列上一列的第二格；一般表格找「綜合說明」字樣那列。 */
  function summaryOf(block) {
    for (const row of block.above || []) {
      const idx = row.findIndex((c) => /綜合說明|說明/.test(String(c || '')) && String(c || '').length <= 40);
      if (idx < 0) continue;
      const rest = row.slice(idx + 1).map(cellText).filter(Boolean);
      if (rest.length) return rest.join('\n');
      const self = cellText(row[idx]);
      const m = self.match(/綜合說明[^：:]*[：:]\s*(.+)/s);
      if (m) return m[1].trim();
    }
    return '';
  }

  /** 乙表：第一欄科目 + 幾個期別欄。 */
  function mapFin(block) {
    const labelCol = block.labelCol != null ? block.labelCol : 0;
    const rows = block.rows;
    // 期別標題列：往上找有 2 格以上像年度／年月的列，或含「%」的列
    let periods = null;
    let valueCols = null;
    const candidates = (block.above || []).concat(block.header ? [block.header] : []);
    for (let k = candidates.length - 1; k >= 0; k--) {
      const row = candidates[k];
      const cols = [];
      row.forEach((c, col) => { if (col !== labelCol && looksPeriod(c)) cols.push(col); });
      if (cols.length >= 2) {
        valueCols = cols.slice(0, M.PERIODS);
        periods = valueCols.map((col) => cellText(row[col]));
        break;
      }
    }
    if (!valueCols) {
      // 沒標題：拿科目列裡有數字的欄，但排除「%」欄（同一列裡值域很小又緊跟在數字欄後）
      const numeric = {};
      rows.forEach((row) => {
        row.forEach((c, col) => {
          if (col === labelCol) return;
          const s = String(c || '').trim();
          if (/^-?[\d,]+(\.\d+)?%?$/.test(s) && s !== '') (numeric[col] = numeric[col] || []).push(s);
        });
      });
      const cols = Object.keys(numeric).map(Number).sort((a, b) => a - b);
      const pctCols = new Set();
      const headerish = (block.above || []).concat(rows.slice(0, 1));
      headerish.forEach((row) => row.forEach((c, col) => { if (String(c || '').trim() === '%') pctCols.add(col); }));
      cols.forEach((col) => { if (numeric[col].every((s) => /%$/.test(s))) pctCols.add(col); });
      valueCols = cols.filter((c) => !pctCols.has(c)).slice(0, M.PERIODS);
    }
    const values = {};
    let count = 0;
    rows.forEach((row) => {
      let key = null;
      for (let col = 0; col < Math.min(row.length, 3); col++) { key = finKeyOf(row[col]); if (key) break; }
      if (!key) return;
      const item = M.FIN_ITEMS.find((it) => it.key === key);
      valueCols.forEach((col, i) => {
        if (i >= M.PERIODS || !M.isInput(item, i)) return;
        const v = cleanNum(row[col]);
        if (v === '') return;
        if (!values[key]) values[key] = ['', '', '', ''];
        values[key][i] = v;
        count++;
      });
    });
    return { periods, values, count, keys: Object.keys(values).length };
  }

  /** 把一塊資料對到指定段落，回傳預覽用的結果。 */
  function mapBlock(block, section) {
    if (block.finOne) {
      if (section !== 'fin') return section === 'vat' ? { section, vat: { rows: [], summary: '', count: 0 } } : { section, rows: [], columns: [] };
      const f = block.finOne;
      const values = {};
      Object.entries(f.values).forEach(([k, v]) => { if (v !== '') values[k] = [v]; });
      return { section, fin: { periods: [f.period || '？'], values, count: Object.keys(values).length, keys: Object.keys(values).length, finOne: f } };
    }
    if (block.vat401) {
      // 401 申報書只能變成 401表（銷項／進項一期）；硬指到別段就當作沒資料
      if (section !== 'vat') return section === 'fin' ? { section, fin: { periods: null, values: {}, count: 0, keys: 0 } } : { section, rows: [], columns: [] };
      const v = block.vat401;
      const six = () => ['', '', '', '', '', ''];
      const rows = [];
      if (v.sales) { const a = six(); a[v.idx] = String(Math.round(v.sales / 1000)); rows.push({ year: v.year, kind: 'sales', values: a }); }
      if (v.purchases) { const a = six(); a[v.idx] = String(Math.round(v.purchases / 1000)); rows.push({ year: v.year, kind: 'purchases', values: a }); }
      return { section, vat: { rows, summary: '', count: rows.length } };
    }
    if (block.jcic) {
      // 聯徵報告只能變成金融負債；硬指到別的段落就當作沒有資料
      if (section !== 'debts') return section === 'fin' ? { section, fin: { periods: null, values: {}, count: 0, keys: 0 } } : section === 'vat' ? { section, vat: { rows: [], summary: '', count: 0 } } : { section, rows: [], columns: [] };
      return { section, rows: block.jcic.rows.map((r) => ({ ...r })), columns: ['type', 'borrower', 'bank', 'subject', 'limit', 'balance', 'collateral', 'diff'], baseDate: block.jcic.baseDate };
    }
    if (section === 'fin') return { section, fin: mapFin(block) };
    if (section === 'vat') return { section, vat: mapVat(block) };
    const grid = mapGrid(block, section);
    const out = { section, rows: grid.rows, columns: grid.columns };
    if (section === 'sales' || section === 'purchases') out.summary = summaryOf(block);
    return out;
  }

  /* ---------------- 聯徵「當事人綜合信用報告」→ 金融負債 ---------------- */
  /*
   * 聯徵報告不是一般表格：銀行名稱直排在左邊好幾行、從債務的主借款戶跨三行。
   * 所以不走格線還原，直接拿 pdf.js 的文字座標，用欄位標題的 x 位置對欄。
   *   表 B1 借款餘額明細   → 當事人本人的借款（訂約金額＝額度，未逾期＋逾期＝餘額）
   *   表 B2 從債務／共同債務 → 當事人擔任保證人的借款，主借款戶是公司或其他人
   * 同一借款人、同一家分行的科目合併成一列（跟送銀行的金融負債表一樣），科目取餘額最大的，
   * 其餘明細寫在「前後次差異說明」。
   */
  const BANK_SHORT = [
    [/合作金庫/, '合庫'], [/中小企業銀行|企銀/, '台企銀'], [/第一(商業)?銀行|一銀/, '一銀'], [/華南/, '華銀'],
    [/彰化/, '彰銀'], [/[台臺]灣銀行/, '台銀'], [/土地銀行/, '土銀'], [/兆豐/, '兆豐'], [/國泰世華/, '國泰'],
    [/玉山/, '玉山'], [/台新/, '台新'], [/中國信託/, '中信'], [/[台臺]北富邦/, '北富'], [/上海/, '上海'],
    [/聯邦/, '聯邦'], [/永豐/, '永豐'], [/遠東/, '遠銀'], [/元大/, '元大'], [/新光/, '新光'], [/日盛/, '日盛'],
    [/京城/, '京城'], [/高雄銀行/, '高銀'], [/板信/, '板信'], [/陽信/, '陽信'], [/三信/, '三信'], [/華泰/, '華泰'],
    [/瑞興/, '瑞興'], [/星展/, '星展'], [/[滙匯]豐/, '匯豐'], [/渣打/, '渣打'], [/花旗/, '花旗'], [/郵政|郵局/, '郵局'],
    [/凱基/, '凱基'], [/王道/, '王道'], [/將來/, '將來'], [/樂天/, '樂天'], [/連線/, 'LINE Bank'],
    [/中租/, '中租'], [/裕融/, '裕融'], [/和潤/, '和潤'],
  ];
  function shortBank(name) {
    const t = String(name || '').replace(/[\s\u3000]/g, '');
    if (!t) return '';
    let bank = t.replace(/(商業)?銀行.*$/, '').replace(/股份有限公司/, '');
    for (const [re, short] of BANK_SHORT) { if (re.test(t)) { bank = short; break; } }
    const m = t.match(/(?:銀行|郵政|信用合作社|農會|漁會|公司)(.+?)(?:分行|分部|分社|辦事處|支局)$/);
    const branch = m ? m[1] : '';
    return branch ? `${bank}/${branch}` : bank;
  }
  const SUBJECT_SHORT = [[/長期擔保/, '長擔'], [/長期/, '長放'], [/中期擔保/, '中擔'], [/中期/, '中放'], [/短期擔保/, '短擔'], [/短期/, '短放'], [/信用卡/, '信用卡'], [/現金卡/, '現金卡'], [/呆帳/, '呆帳'], [/催收/, '催收']];
  const shortSubject = (sub) => { const t = String(sub || ''); for (const [re, v] of SUBJECT_SHORT) { if (re.test(t)) return v; } return t.replace(/放款/, '').trim(); };
  const isCompanyName = (n) => /公司|企業|實業|工程|工業|商行|商號|工作室|事務所|工廠|股份|有限|行$|社$|店$/.test(String(n || ''));
  const thousand = (t) => { const m = String(t || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : 0; };

  /** pdf.js 文字項目 → 每頁的「行」（y 相近的併一行，行內依 x 排序）。 */
  async function pdfTextLines(buffer, maxPages) {
    const doc = await global.pdfjsLib.getDocument({ data: buffer, isEvalSupported: false }).promise;
    const pages = [];
    const n = Math.min(doc.numPages, maxPages || doc.numPages);
    for (let p = 1; p <= n; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const items = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str.trim() }));
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const lines = [];
      let cur = null;
      items.forEach((it) => {
        if (!cur || Math.abs(it.y - cur.y) > 3) { cur = { y: it.y, page: p, items: [] }; lines.push(cur); }
        cur.items.push(it);
      });
      lines.forEach((l) => l.items.sort((a, b) => a.x - b.x));
      pages.push(lines);
      page.cleanup();
    }
    const total = doc.numPages;
    await doc.destroy();
    return { pages, total };
  }

  const lineText = (l) => l.items.map((i) => i.s).join(' ');
  const NOISE_LINE = /^(第\s*\d+\s*頁|當事人綜合信用報告|R\d{10,})/;
  const WATERMARK = /^R\d{10,}$/;

  function parseJcic(pages, fileName, ownerHint) {
    const lines = [];
    pages.forEach((pl) => pl.forEach((l) => {
      const items = l.items.filter((it) => !WATERMARK.test(it.s));
      if (!items.length) return;
      const t = items.map((i) => i.s).join(' ');
      if (NOISE_LINE.test(t.trim())) return;
      lines.push({ ...l, items, text: t });
    }));
    const find = (re, from) => lines.findIndex((l, i) => i >= (from || 0) && re.test(l.text.replace(/\s/g, '')));

    let baseDate = '';
    for (const l of lines) {
      const m = l.text.replace(/\s/g, '').match(/截至(\d{2,3})\/(\d{1,2})底止/);
      if (m) { baseDate = `${Number(m[1]) + 1911}${m[2].padStart(2, '0')}`; break; }
    }
    // 當事人姓名：報告內文只有身分證號，從檔名（xxx聯徵紀錄）或負責人欄位拿
    const nameFromFile = (String(fileName || '').match(/([\u4e00-\u9fff]{2,4})(?:聯徵|信用報告|JC)/) || [])[1];
    const subject = nameFromFile || ownerHint || '當事人';

    const raw = [];   // { borrower, type, bank, subject, limit, balance }

    /* ---- 表 B1：本人借款 ---- */
    const b1 = find(/借款餘額明細/);
    const b2 = find(/共同債務|從債務/, b1 + 1);
    if (b1 >= 0) {
      const end = b2 >= 0 ? b2 : lines.length;
      const header = lines.slice(b1, end).find((l) => /訂約金額/.test(l.text) && /科目/.test(l.text));
      const stop = lines.slice(b1, end).findIndex((l) => /未結案之借款總餘額|^借款餘額/.test(l.text.trim()));
      const last = stop >= 0 ? b1 + stop : end;
      if (header) {
        const cols = {};
        header.items.forEach((it) => { ['資料年月', '訂約金額', '未逾期餘額', '逾期金額', '科目', '用途'].forEach((k) => { if (it.s.replace(/\s/g, '').includes(k)) cols[k] = it.x; }); });
        const colOf = (x) => { let best = null; Object.entries(cols).forEach(([k, cx]) => { if (x >= cx - 15 && (!best || cx > cols[best])) best = k; }); return best; };
        const dataRows = [];
        const bankFrags = [];
        const bankLimit = (cols['資料年月'] || 70) - 8;
        for (let i = b1 + 1; i < last; i++) {
          const l = lines[i];
          if (l === header || /金融機構|名稱|最近十二個月/.test(l.text)) continue;
          const money = l.items.filter((it) => /千元$/.test(it.s));
          if (money.length >= 2 && l.items.some((it) => /放款|借款|卡|呆帳|催收|透支|票貼|融資/.test(it.s))) {
            const row = { limit: 0, balance: 0, subject: '', purpose: '' };
            l.items.forEach((it) => {
              if (it.x < bankLimit) { bankFrags.push({ i, s: it.s }); return; }
              if (/千元$/.test(it.s)) {
                const k = colOf(it.x);
                if (k === '訂約金額') row.limit += thousand(it.s);
                else if (k === '未逾期餘額' || k === '逾期金額') row.balance += thousand(it.s);
                return;
              }
              // 「長期擔保放款 購置不動產」有時擠在同一個文字項目裡：科目在前、用途在後
              const m = it.s.match(/^(.*?(?:放款|借款|卡|呆帳|催收|透支|票貼|融資))\s*(.*)$/);
              if (m) { row.subject += m[1]; row.purpose += m[2]; return; }
              if (colOf(it.x) === '用途' && it.x < (cols['用途'] || 0) + 35 && !/^(有|無)$/.test(it.s)) row.purpose += it.s;
            });
            dataRows.push(row);
          } else {
            l.items.forEach((it) => { if (it.x < bankLimit) bankFrags.push({ i, s: it.s }); });
          }
        }
        // 銀行名稱直排成好幾行，平均分給每一列
        const per = dataRows.length ? Math.max(1, Math.round(bankFrags.length / dataRows.length)) : 0;
        dataRows.forEach((row, k) => {
          const frags = k === dataRows.length - 1 ? bankFrags.slice(k * per) : bankFrags.slice(k * per, (k + 1) * per);
          row.bank = shortBank(frags.map((f) => f.s).join(''));
          const purpose = /不動產|房|屋|土地/.test(row.purpose) ? '不動產' : /動產|車/.test(row.purpose) ? '動產' : '';
          raw.push({ borrower: subject, type: 'person', bank: row.bank, subject: shortSubject(row.subject), limit: row.limit, balance: row.balance, purpose });
        });
      }
    }

    /* ---- 表 B2：從債務（本人當保證人） ---- */
    if (b2 >= 0) {
      const endIdx = find(/信用卡資訊|信用卡持卡|票信資訊|查詢紀錄/, b2 + 1);
      const end = endIdx >= 0 ? endIdx : lines.length;
      const region = lines.slice(b2 + 1, end).filter((l) => !/主借款戶|承貸金融機構|從債務資訊|共同債務資訊|截至.*底止/.test(l.text));
      const isData = (l) => l.items.some((it) => /千元$/.test(it.s)) && l.items.some((it) => /放款|借款|卡|呆帳|催收|透支|票貼|融資/.test(it.s));
      const isId = (it) => /X{2,}|\*{2,}/.test(it.s) || /^[A-Z]?\d{4,}X*$/.test(it.s);
      region.forEach((l, j) => {
        if (!isData(l)) return;
        const prev = region[j - 1] && !isData(region[j - 1]) ? region[j - 1] : null;
        const next = region[j + 1] && !isData(region[j + 1]) ? region[j + 1] : null;
        const bankX = (it) => it.x >= 130 && it.x < 280 && !/千元/.test(it.s);
        const bank = [prev, l, next].filter(Boolean).flatMap((x) => x.items.filter(bankX).map((it) => it.s)).join('');
        let name = '';
        [next, prev].filter(Boolean).some((x) => {
          const hit = x.items.filter((it) => it.x < 130 && !isId(it) && /[\u4e00-\u9fff]/.test(it.s)).map((it) => it.s).join('');
          if (hit) { name = hit; return true; }
          return false;
        });
        let balance = 0;
        let subject = '';
        l.items.forEach((it) => {
          if (/千元$/.test(it.s)) balance += thousand(it.s);
          else if (/放款|借款|卡|呆帳|催收|透支|票貼|融資/.test(it.s)) subject += it.s;
        });
        raw.push({ borrower: name || '（主借款戶）', type: isCompanyName(name) ? 'company' : 'person', bank: shortBank(bank), subject: shortSubject(subject), limit: 0, balance, purpose: '' });
      });
    }

    /* ---- 同借款人、同分行合併 ---- */
    const groups = new Map();
    raw.forEach((r) => {
      const key = `${r.type}|${r.borrower}|${r.bank}`;
      if (!groups.has(key)) groups.set(key, { ...r, limit: 0, balance: 0, bySubject: {}, purposes: new Set() });
      const g = groups.get(key);
      g.limit += r.limit;
      g.balance += r.balance;
      g.bySubject[r.subject] = (g.bySubject[r.subject] || 0) + r.balance;
      if (r.purpose) g.purposes.add(r.purpose);
    });
    const fmtK = (n) => Math.round(n).toLocaleString('en-US');
    const rows = [...groups.values()].map((g) => {
      const subs = Object.entries(g.bySubject).sort((a, b) => b[1] - a[1]);
      return {
        type: g.type,
        borrower: g.borrower,
        bank: g.bank,
        subject: subs.length ? subs[0][0] : '',
        limit: g.limit ? String(Math.round(g.limit)) : '',
        balance: String(Math.round(g.balance)),
        collateral: [...g.purposes].join('、'),
        diff: subs.length > 1 ? `含${subs.map(([k, v]) => `${k} ${fmtK(v)}`).join('、')}（聯徵 ${baseDate ? `${baseDate.slice(0, 4)}/${baseDate.slice(4)}` : ''}）` : '',
      };
    });
    // 公司在前、本人其次、其他關係人最後
    rows.sort((a, b) => (a.type === b.type ? (a.borrower === subject ? -1 : b.borrower === subject ? 1 : 0) : (a.type === 'company' ? -1 : 1)));
    return { rows, baseDate, subject, count: raw.length };
  }

  /* ---------------- 營業稅 401 申報書 → 401表（同期進銷貨比較表） ---------------- */
  /*
   * 一份 401 申報書就是一期（兩個月）。要的只有三個東西：
   *   所屬年月份 → 哪一年、哪一期（1~2、3~4…）
   *   銷售額總計（代號 25 (7)，＝應稅 21 (1)＋零稅率 23 (3)）→ 銷項
   *   進項「進貨及費用 合計」（代號 44）→ 進項
   * 金額是元，表上填仟元（四捨五入）。這跟使用者手填 4.pdf 的方式一致：
   * 例如 115 年 05-06 月 銷售額總計 4,995,649 → 2026 年 5~6 銷項 4,996；進貨及費用 1,547,610 → 進項 1,547。
   * 財政部匯出的 401 常是掃描圖，沒有文字層時用 tesseract（繁中）辨識第一頁。
   */
  const is401Text = (t) => /401/.test(t) && /(銷售額與稅額申報書|銷項稅額合計|所屬年月份|得扣抵進項稅額)/.test(t);
  const numOf = (t) => Number(String(t || '').replace(/[,，\s]/g, '')) || 0;

  function parse401Text(text, fileName) {
    const t = String(text || '').replace(/[，]/g, ',').replace(/[\u3000]/g, ' ');
    const flat = t.replace(/\s+/g, ' ');
    let year = 0;
    let startMonth = 0;
    const m = flat.match(/所屬年月份[^0-9]{0,4}(\d{2,3})\s*年\s*(\d{1,2})\s*[^0-9月]{0,4}\s*(\d{1,2})\s*月/);
    if (m) { year = Number(m[1]); startMonth = Number(m[2]); }
    if (!year) {
      const f = String(fileName || '').match(/(\d{2,3})[.\-_年]\s*(\d{1,2})\s*[-~～至]\s*(\d{1,2})\s*月?/);
      if (f) { year = Number(f[1]); startMonth = Number(f[2]); }
    }
    if (!year || !startMonth) return null;
    if (year < 1911) year += 1911;
    const idx = Math.floor((startMonth - 1) / 2);
    if (idx < 0 || idx >= M.VAT_PERIODS.length) return null;

    let sales = 0;
    const s1 = flat.match(/21\s*\(?1\)?\s*([\d,]{3,})/);
    const s3 = flat.match(/23\s*\(?3\)?\s*([\d,]{1,})/);
    if (s1) sales = numOf(s1[1]) + (s3 ? numOf(s3[1]) : 0);
    if (!sales) { const s7 = flat.match(/25\s*\(7\)\s*([\d,]{3,})/); if (s7) sales = numOf(s7[1]); }
    if (!sales) { const st = flat.match(/銷售額總計[^0-9]{0,12}([\d,]{4,})/); if (st) sales = numOf(st[1]); }

    let purchases = 0;
    const p44 = flat.match(/(?:^|\s)44\s+([\d,]{1,})\s+45\b/) || flat.match(/(?:^|\s)44\s+([\d,]{4,})/);
    if (p44) purchases = numOf(p44[1]);
    if (!purchases) { const pt = flat.match(/進項總金額[^0-9]{0,30}([\d,]{4,})/); if (pt) purchases = numOf(pt[1]); }
    if (!purchases) { const p48 = flat.match(/(?:^|\s)48\s+([\d,]{4,})/); if (p48) purchases = numOf(p48[1]); }

    if (!sales && !purchases) return null;
    return { year: String(year), idx, sales, purchases, period: M.VAT_PERIODS[idx] };
  }

  /** 把 pdf.js 的第一頁畫成圖，給 OCR 用。 */
  async function renderPdfPage(buffer, pageNo, scale) {
    const doc = await global.pdfjsLib.getDocument({ data: buffer, isEvalSupported: false }).promise;
    const page = await doc.getPage(pageNo || 1);
    const viewport = page.getViewport({ scale: scale || 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    page.cleanup();
    await doc.destroy();
    return canvas;
  }

  /* ---------------- 財務報表（資產負債表／損益表／營所稅申報書）→ 乙表 ---------------- */
  /*
   * 乙表一欄就是一期。三種來源：
   *   會計師／記帳系統印的「資產負債表」「損益表」（文字 PDF，左右兩欄：資產｜負債及權益）
   *   營所稅結算申報書（第 1 頁「損益及稅額計算表」、第 3 頁「資產負債表」，欄位有代號 04、05、1111…）
   * 對到乙表的規則（跟使用者手填 BOU 一致）：
   *   現金＝現金＋銀行存款；其他流動資產＝流動資產總額－現金－應收票據－應收帳款－存貨
   *   固定資產各項用「原值－累計折舊」；其他＝固定資產總額－土地－建築物－機器設備
   *   其他資產＝資產總額－流動資產－長期投資－固定資產
   *   其他流動負債＝流動負債總額－短期借款－應付票據及帳款－股東往來；其他負債＝負債總額－流動負債－長期負債
   *   公積及盈餘＝權益總額－股本；乙表裡它＝前期公積及盈餘＋本期損益＋調整項目，所以套用後把「調整項目」
   *   算成讓公積及盈餘剛好等於報表的數（分紅、盈餘分配都落在這裡）。最舊一期的「前期公積及盈餘」＝公積及盈餘－本期損益。
   * 金額是元，乙表填仟元（四捨五入）。
   */
  const K = (n) => (n == null || !Number.isFinite(n) ? '' : String(Math.round(n / 1000)));
  /** 「(290,782)」「-1,234」是負數；OCR 常把逗號讀成點或空格，也一併收。 */
  function amountOf(text) {
    const t = String(text == null ? '' : text).replace(/\s/g, '');
    const m = t.match(/\(?-?\d[\d,.]*\)?/);
    if (!m) return null;
    const neg = /^\(/.test(m[0]) || /^-/.test(m[0]);
    const digits = m[0].replace(/[(),.\-]/g, '');
    if (!/^\d+$/.test(digits)) return null;
    return neg ? -Number(digits) : Number(digits);
  }
  const rocPeriod = (y, mo) => {
    let year = Number(y);
    if (year < 1911) year += 1911;
    const m = Number(mo);
    return m === 12 ? `${year}年` : `${year}/${String(m).padStart(2, '0')}`;
  };

  /** 一行裡的文字項目 → 標籤（非數字部分）與金額（最後一個數字）。 */
  function labelAndAmount(items) {
    const labelParts = [];
    let amount = null;
    items.forEach((it) => {
      const s = it.s.trim();
      if (!s || s === '＄' || s === '$') return;
      const a = amountOf(s);
      if (a !== null && /^[\(\-]?[\d,.]+\)?$/.test(s)) { amount = a; return; }
      labelParts.push(s);
    });
    return { label: labelParts.join('').replace(/[\s：:]/g, ''), amount };
  }

  const sumWhere = (rows, re, exclude) => rows.filter((r) => re.test(r.label) && !(exclude && exclude.test(r.label))).reduce((s, r) => s + (r.amount || 0), 0);
  const firstWhere = (rows, re, exclude) => { const hit = rows.find((r) => re.test(r.label) && r.amount !== null && !(exclude && exclude.test(r.label))); return hit ? hit.amount : null; };

  /** 記帳系統的資產負債表：左欄資產、右欄負債及權益。 */
  function parseBalanceSheet(lines) {
    const header = lines.find((l) => l.items.some((it) => /負債及權益|負債及股東權益|負債/.test(it.s)) && l.items.some((it) => /資產/.test(it.s)));
    const rightX = header ? Math.min(...header.items.filter((it) => /負債/.test(it.s)).map((it) => it.x)) - 10 : 290;
    const left = [];
    const right = [];
    lines.forEach((l) => {
      const li = l.items.filter((it) => it.x < rightX);
      const ri = l.items.filter((it) => it.x >= rightX);
      if (li.length) left.push(labelAndAmount(li));
      if (ri.length) right.push(labelAndAmount(ri));
    });
    // 「減：累計折舊-機器」的金額跟在同一行；把它跟前一個資產配對
    const netOf = (re) => {
      const gross = firstWhere(left, re, /累計|折舊|總額/);
      if (gross === null) return null;
      const dep = left.filter((r) => /累計折舊|累計減損/.test(r.label) && re.test(r.label)).reduce((s, r) => s + (r.amount || 0), 0);
      return gross + dep;   // 折舊在括號裡已是負數
    };
    const cash = sumWhere(left, /^(現金|銀行存款|零用金|約當現金|定期存款|庫存現金)/, /總額/);
    const notesRecv = sumWhere(left, /^應收票據/, /總額|備抵/);
    const ar = sumWhere(left, /^應收帳款/, /總額|備抵/);
    const rawMat = sumWhere(left, /^(原料|物料|原物料)/, /總額/);
    const wip = sumWhere(left, /^在製品/, /總額/);
    const finished = sumWhere(left, /^(製成品|商品|存貨)$|^(製成品|商品|存貨)存貨/, /總額|跌價/);
    const caTotal = firstWhere(left, /^流動資產總額|^流動資產合計/);
    const land = firstWhere(left, /^土地/, /累計|總額/) || 0;
    const building = netOf(/房屋|建築/) || 0;
    const machine = netOf(/機器/) || 0;
    let faTotal = firstWhere(left, /^(不動產、?廠房及設備總額?|固定資產總額|固定資產合計|不動產廠房及設備總額?)/);
    if (faTotal === null) faTotal = firstWhere(left, /^不動產、廠房及設備總/);   // 標題被折成兩行時「額」在下一行
    const lti = firstWhere(left, /^(長期投資總額|長期股權投資|基金及投資總額|長期投資)$/) || 0;
    const totalAssets = firstWhere(left, /^資產總額|^資產總計|^資產合計/);
    const stLoan = sumWhere(right, /^(短期借款|銀行借款|銀行透支|應付短期票券)/, /總額/);
    const ap = sumWhere(right, /^(應付票據|應付帳款)/, /總額/);
    const shareholder = sumWhere(right, /^(股東往來|業主往來|業主\(股東\)往來)/, /總額/);
    const clTotal = firstWhere(right, /^流動負債總額|^流動負債合計/);
    let ltl = firstWhere(right, /^長期負債總額|^長期負債合計|^非流動負債總額/);
    if (ltl === null) ltl = sumWhere(right, /^長期借款/, /總額/);
    const totalL = firstWhere(right, /^負債總額|^負債合計/);
    const capital = firstWhere(right, /^(資本總額|股本總額|資本合計)/) ?? firstWhere(right, /^(資本|股本)$/);
    const equity = firstWhere(right, /^(權益總額|股東權益總額|淨值總額|權益合計)/);
    const netIncome = firstWhere(right, /^本期損益|^本期淨利/);
    const values = {
      cash: K(cash), notesRecv: K(notesRecv), ar: K(ar), rawMat: K(rawMat), wip: K(wip), finished: K(finished),
      otherCa: caTotal === null ? '' : K(caTotal - cash - notesRecv - ar - rawMat - wip - finished),
      lti: K(lti), land: K(land), building: K(building), machine: K(machine),
      otherFa: faTotal === null ? '' : K(faTotal - land - building - machine),
      otherAssets: totalAssets === null || caTotal === null || faTotal === null ? '' : K(totalAssets - caTotal - lti - faTotal),
      stLoan: K(stLoan), ap: K(ap), shareholder: K(shareholder),
      otherCl: clTotal === null ? '' : K(clTotal - stLoan - ap - shareholder),
      ltl: K(ltl),
      otherL: totalL === null || clTotal === null ? '' : K(totalL - clTotal - ltl),
      capital: K(capital),
    };
    Object.keys(values).forEach((k) => { if (values[k] === '0') values[k] = ''; });
    const surplusTarget = equity !== null && capital !== null ? equity - capital : null;
    let period = '';
    const dateLine = lines.map((l) => l.items.map((i) => i.s).join('')).find((t) => /民國\s*\d{2,3}\s*年\s*\d{1,2}\s*月/.test(t));
    const dm = dateLine && dateLine.replace(/\s/g, '').match(/民國(\d{2,3})年(\d{1,2})月/);
    if (dm) period = rocPeriod(dm[1], dm[2]);
    const ok = totalAssets !== null || caTotal !== null;
    return ok ? { kind: 'bs', period, values, surplusTarget: surplusTarget === null ? null : Math.round(surplusTarget / 1000), netIncome: netIncome === null ? null : Math.round(netIncome / 1000), check: { totalAssets: K(totalAssets), equity: K(equity) } } : null;
  }

  /** 記帳系統的損益表（可能好幾頁）：每行最後一個數字就是金額。 */
  function parseIncomeStatement(pages) {
    const rows = [];
    pages.forEach((pl) => pl.forEach((l) => rows.push(labelAndAmount(l.items))));
    const sales = firstWhere(rows, /^(營業收入淨額|銷貨淨額|營業收入合計)/) ?? firstWhere(rows, /^(銷貨收入|營業收入)$/);
    const cogs = firstWhere(rows, /^營業成本$/) ?? firstWhere(rows, /^(銷貨總成本|銷貨成本)/, /率/);
    const opex = firstWhere(rows, /^(營業費用總額|營業費用合計|營業費用)$/);
    const otherIncome = firstWhere(rows, /^(非營業收益總額|非營業收入總額|營業外收入總額|營業外收入合計|非營業收益|營業外收入)$/) || 0;
    const interest = firstWhere(rows, /^利息支出/) || 0;
    const nonOpTotal = firstWhere(rows, /^(非營業損失及費用總|非營業損失總額|營業外支出總額|營業外費用總額|營業外支出合計)/);
    const tax = firstWhere(rows, /^(所得稅費用|所得稅|營利事業所得稅)$/);
    const net = firstWhere(rows, /^(本期損益|稅後淨利|本期淨利)/);
    if (sales === null) return null;
    const values = {
      sales: K(sales), cogs: K(cogs), opex: K(opex), otherIncome: K(otherIncome), interest: K(interest),
      otherExp: nonOpTotal === null ? '' : K(nonOpTotal - interest), tax: K(tax),
    };
    Object.keys(values).forEach((k) => { if (values[k] === '0') values[k] = ''; });
    let period = '';
    const t = pages[0] ? pages[0].map((l) => l.items.map((i) => i.s).join('')).join('\n').replace(/\s/g, '') : '';
    const dm = t.match(/至(\d{2,3})年(\d{1,2})月\d{1,2}日/) || t.match(/(\d{2,3})年度/);
    if (dm) period = dm[2] ? rocPeriod(dm[1], dm[2]) : rocPeriod(dm[1], 12);
    return { kind: 'is', period, values, netIncome: net === null ? null : Math.round(net / 1000) };
  }

  /** 營所稅結算申報書：用欄位代號找數字。OCR 讀壞的（例如 11,39,3）就留白，不亂填。 */
  function parseTaxReturn(pageTexts) {
    const clean = (s) => { const t = String(s || '').replace(/[|｜]/g, '').replace(/\s+/g, ''); return /^\d{1,3}([,.]\d{3})+$|^\d{1,6}$/.test(t) ? Number(t.replace(/[,.]/g, '')) : null; };
    // 兩位數代號（損益表）一定要有標籤才算；四位數代號（資產負債表）本身夠獨特，沒標籤也可以
    const grab = (text, code, label) => {
      const flat = text.replace(/[\u3000]/g, ' ');
      // 只認千分位完整的大數字（12,345 或 12.345.678）；OCR 讀壞的 11,39,3 這種就當沒讀到
      const BIG = '(\\d{1,3}(?:[,.] ?\\d{3})+|\\d{4,9})';
      const res = [new RegExp(`(?:^|[^0-9])${code}\\s*${label}.{0,60}?${BIG}`)];
      if (code.length >= 4) res.push(new RegExp(`(?:^|[^0-9])${code}\\s*[|｜]?\\s*${BIG}`));
      for (const re of res) { const m = flat.match(re); if (m) { const v = clean(m[1]); if (v !== null) return v; } }
      return null;
    };
    const missing = [];
    const need = (v, name) => { if (v === null) missing.push(name); return v; };
    const flatOf = (t) => t.replace(/\s/g, '');
    const isPage = pageTexts.find((t) => /損益及稅額計算表/.test(flatOf(t)) && /營業收入/.test(flatOf(t)));
    const bsPage = pageTexts.find((t) => /資產負債表|資產總額|負債及權益總額|權益總額/.test(flatOf(t)) && /1111|1112|流動資產/.test(t) && /2110|2112|短期借款/.test(t));
    if (!isPage && !bsPage) return null;
    const values = {};
    let period = '';
    let surplusTarget = null;
    let netIncome = null;
    let prevSurplusHint = null;
    const all = pageTexts.join('\n').replace(/\s/g, '');
    const ym = all.match(/(\d{2,3})年度損益及稅額計算表/) || all.match(/(\d{2,3})年度營利事業所得稅/);
    if (ym) period = rocPeriod(ym[1], 12);
    if (isPage) {
      const t = isPage;
      const sales = need(grab(t, '04', '營業收入淨'), '營業收入淨額(04)');
      const cogs = need(grab(t, '05', '營業成本'), '營業成本(05)');
      const opex = need(grab(t, '08', '營業費用'), '營業費用(08)');
      const otherIncome = grab(t, '34', '非營業收入');
      const interest = grab(t, '46', '利息支出');
      const nonOp = grab(t, '45', '非營業損失');
      const tax = grab(t, '122', '所得稅費用') ?? grab(t, '60', '本年度應納稅額');
      Object.assign(values, { sales: K(sales), cogs: K(cogs), opex: K(opex), otherIncome: K(otherIncome), interest: K(interest), otherExp: nonOp === null ? '' : K(nonOp - (interest || 0)), tax: K(tax) });
    }
    if (bsPage) {
      const t = bsPage;
      const cash = (grab(t, '1111', '現金') || 0) + (grab(t, '1112', '銀行存款') || 0) + (grab(t, '1113', '約當現金') || 0);
      const notesRecv = grab(t, '1121', '應收票據') || 0;
      const ar = grab(t, '1123', '應收帳款') || 0;
      const inv = grab(t, '1130', '存貨');
      const rawMat = grab(t, '1134', '原料');
      const caTotal = need(grab(t, '1100', '流動資產'), '流動資產(1100)');
      const lti = grab(t, '1300', '長期性之投資') || 0;
      const faTotal = need(grab(t, '1400', '不動產、廠房及設備'), '固定資產(1400)');
      const land = grab(t, '1410', '土地') || 0;
      const building = (grab(t, '1431', '房屋及建築') || 0) - (grab(t, '1432', '累計折舊') || 0);
      const machine = (grab(t, '1441', '機器設備') || 0) - (grab(t, '1442', '累計折舊') || 0);
      const totalAssets = need(grab(t, '1000', '資產總額'), '資產總額(1000)');
      const stLoan = grab(t, '2110', '短期借款') ?? ((grab(t, '2112', '銀行借款') || 0) + (grab(t, '2111', '銀行透支') || 0));
      const ap = (grab(t, '2120', '應付票據') || 0) + (grab(t, '2121', '應付帳款') || 0);
      const shareholder = grab(t, '2192', '業主') || 0;
      const clTotal = need(grab(t, '2100', '流動負債'), '流動負債(2100)');
      const ltl = (grab(t, '2220', '長期借款') || 0) + (grab(t, '2210', '應付公司債') || 0);
      const totalL = need(grab(t, '2000', '負債總額'), '負債總額(2000)');
      const capital = need(grab(t, '3100', '資本'), '資本(3100)');
      const equity = need(grab(t, '3000', '權益總額'), '權益總額(3000)');
      netIncome = grab(t, '3440', '本期損益');
      const surplus = grab(t, '3400', '保留盈餘');
      const inventory = inv === null ? 0 : inv;
      Object.assign(values, {
        cash: K(cash), notesRecv: K(notesRecv), ar: K(ar),
        rawMat: rawMat !== null ? K(rawMat) : '', finished: rawMat === null && inv !== null ? K(inv) : '',
        otherCa: caTotal === null ? '' : K(caTotal - cash - notesRecv - ar - inventory),
        lti: K(lti), land: K(land), building: K(building), machine: K(machine),
        otherFa: faTotal === null ? '' : K(faTotal - land - building - machine),
        otherAssets: totalAssets === null || caTotal === null || faTotal === null ? '' : K(totalAssets - caTotal - lti - faTotal),
        stLoan: K(stLoan), ap: K(ap), shareholder: K(shareholder),
        otherCl: clTotal === null ? '' : K(clTotal - (stLoan || 0) - ap - shareholder),
        ltl: K(ltl), otherL: totalL === null || clTotal === null ? '' : K(totalL - clTotal - ltl),
        capital: K(capital),
      });
      if (equity !== null && capital !== null) surplusTarget = Math.round((equity - capital) / 1000);
      if (surplus !== null && netIncome !== null) prevSurplusHint = Math.round((surplus - netIncome) / 1000);
    }
    Object.keys(values).forEach((k) => { if (values[k] === '0' || values[k] === '-0') values[k] = ''; });
    return { kind: 'tax', period, values, surplusTarget, netIncome: netIncome === null ? null : Math.round(netIncome / 1000), prevSurplusHint, missing };
  }

  /** 這一期要放乙表哪一欄：先找同名期別；再找還沒填數字的欄；年中報表放最左（最新），年度放年份相同或最後一欄。 */
  function slotForPeriod(fin, label) {
    const labels = fin.periods || [];
    const exact = labels.findIndex((p) => String(p || '').replace(/\s/g, '') === String(label || '').replace(/\s/g, ''));
    if (exact >= 0) return exact;
    const yearOf = (p) => { const m = String(p || '').match(/(\d{4})/); return m ? Number(m[1]) : 0; };
    const y = yearOf(label);
    const isMid = /\//.test(label);
    const raw = fin.values || {};
    const empty = [0, 1, 2, 3].filter((i) => !M.hasAnyInput(raw, i));
    if (isMid) return empty.includes(0) ? 0 : 0;
    const sameYear = labels.findIndex((p, i) => yearOf(p) === y && !/\//.test(p) && (empty.includes(i) || true));
    if (sameYear >= 0) return sameYear;
    // 年度：照年份由新到舊排；找第一個「年份比它舊或空著」的欄
    for (let i = 1; i < M.PERIODS; i++) { if (empty.includes(i) || yearOf(labels[i]) < y) return i; }
    return M.PERIODS - 1;
  }

  /** 套用完一期後，把每一欄的「調整項目」算成讓公積及盈餘等於報表的數。 */
  function settleSurplus(fin) {
    const targets = (fin.meta && fin.meta.surplusTarget) || [];
    if (!targets.some((t) => t !== '' && t != null)) return;
    if (!fin.values.adjust) fin.values.adjust = ['', '', '', ''];
    for (let i = M.PERIODS - 1; i >= 0; i--) {
      if (targets[i] === '' || targets[i] == null) continue;
      fin.values.adjust[i] = '';
      const { values } = M.computeFin(fin);
      const adj = Math.round(Number(targets[i]) - values.prevSurplus[i] - values.netIncomeBs[i]);
      fin.values.adjust[i] = adj ? String(adj) : '';
    }
  }

  /* ---------------- 讀檔 ---------------- */

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function sheetToRows(sheet) {
    const XLSX = global.XLSX;
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true, blankrows: true });
    const pad = (n) => String(n).padStart(2, '0');
    return raw.map((row) => row.map((v) => {
      if (v instanceof Date) return `${v.getFullYear()}/${pad(v.getMonth() + 1)}/${pad(v.getDate())}`;
      if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
      return v == null ? '' : String(v);
    }));
  }

  /**
   * 讀一個檔案 → [{ name, rows }]。
   * @param {File} file
   * @param {(msg:string)=>void} [onProgress]
   */
  async function readFile(file, onProgress, opts) {
    const name = file.name || '';
    const ext = (name.split('.').pop() || '').toLowerCase();
    const say = (m) => { if (onProgress) onProgress(m); };
    if (ext === 'csv' || ext === 'txt') {
      const buf = await file.arrayBuffer();
      let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      if (/�/.test(text)) { try { text = new TextDecoder('big5').decode(buf); } catch (e) { /* 沒有 big5 就算了 */ } }
      return [{ name, rows: parseCsv(text.replace(/^﻿/, '')) }];
    }
    if (ext === 'pdf' || file.type === 'application/pdf') {
      if (!global.PdfTable || !global.pdfjsLib) throw new Error('PDF 解析元件沒有載入，請重新整理頁面再試');
      const buffer = await file.arrayBuffer();
      // 先看第一頁是不是聯徵報告或 401 申報書；是的話走專用解析
      const peek = await pdfTextLines(buffer.slice(0), 1);
      const firstText = peek.pages[0] ? peek.pages[0].map(lineText).join('\n') : '';
      if (/綜合信用報告/.test(firstText)) {
        say(`⏳ 解析聯徵報告 ${name}…`);
        const all = await pdfTextLines(buffer.slice(0));
        const jcic = parseJcic(all.pages, name, opts && opts.owner);
        return [{ name, rows: [], jcic }];
      }
      // 記帳系統的資產負債表／損益表、營所稅申報書（文字版）
      if (/資產負債表/.test(firstText) && /(資產項目|流動資產)/.test(firstText) && !/損益及稅額計算表/.test(firstText)) {
        const bs = parseBalanceSheet(peek.pages[0]);
        if (bs) return [{ name, rows: [], finOne: bs }];
      }
      if (/損益表/.test(firstText) && /營業收入/.test(firstText) && !/損益及稅額計算表/.test(firstText)) {
        const all = await pdfTextLines(buffer.slice(0));
        const is = parseIncomeStatement(all.pages);
        if (is) return [{ name, rows: [], finOne: is }];
      }
      if (/營利事業所得稅/.test(firstText) && /結算申報/.test(firstText)) {
        const all = await pdfTextLines(buffer.slice(0));
        const tax = parseTaxReturn(all.pages.map((pl) => pl.map(lineText).join('\n')));
        if (tax) return [{ name, rows: [], finOne: tax }];
      }
      let text401 = is401Text(firstText) ? firstText : '';
      if (!text401 && firstText.replace(/\s/g, '').length < 40 && global.Ocr && global.Tesseract) {
        // 沒有文字層（掃描圖）：辨識第一頁看看是不是 401
        say(`⏳ ${name} 是掃描圖，辨識文字中（第一次要載入辨識模型，約十幾秒）…`);
        try {
          // 放大到 3 倍、用「散落文字」模式（psm 11）抓表格裡的數字最準；抓不到再用分欄模式（psm 4）
          const canvas = await renderPdfPage(buffer.slice(0), 1, 3);
          const progress = (m) => { if (m && m.status === 'recognizing text' && m.progress) say(`⏳ 辨識 ${name}… ${Math.round(m.progress * 100)}%`); };
          let ocr = await global.Ocr.recognizeText(canvas, progress, { tessedit_pageseg_mode: '11' });
          if (!(is401Text(ocr) && parse401Text(ocr, name))) {
            const again = await global.Ocr.recognizeText(canvas, progress, { tessedit_pageseg_mode: '4' });
            if (is401Text(again) && parse401Text(again, name)) ocr = again;
          }
          if (is401Text(ocr) || /401|營業稅/.test(name)) text401 = ocr;
          else if (/營利事業所得稅|結算申報|申報書/.test(ocr) || /營所稅|結算申報/.test(name)) {
            // 掃描的營所稅申報書：逐頁辨識到找到「損益及稅額計算表」和「資產負債表」為止（最多 6 頁）
            const texts = [ocr];
            const total = peek.total || 1;
            for (let pno = 2; pno <= Math.min(total, 6); pno++) {
              say(`⏳ 辨識 ${name} 第 ${pno}/${Math.min(total, 6)} 頁…`);
              const cv = await renderPdfPage(buffer.slice(0), pno, 3);
              texts.push(await global.Ocr.recognizeText(cv, null, { tessedit_pageseg_mode: '4' }));
              if (texts.some((t) => /損益及稅額計算表/.test(t.replace(/\s/g, ''))) && texts.some((t) => /資產負債表|資產總額|權益總額/.test(t.replace(/\s/g, '')) && /2110|2112|短期借款/.test(t))) break;
            }
            const tax = parseTaxReturn(texts);
            if (tax) return [{ name, rows: [], finOne: tax }];
          }
        } catch (err) { console.warn('OCR 失敗', err); }
      }
      if (text401) {
        const vat401 = parse401Text(text401, name);
        if (vat401) return [{ name, rows: [], vat401 }];
        throw new Error(`${name} 看起來是 401 申報書，但讀不到所屬年月份或銷售額，請確認檔案清晰`);
      }
      const parsed = await global.PdfTable.parsePdf(buffer, (done, total) => say(`⏳ 解析 ${name}… 第 ${done}/${total} 頁`));
      return [{ name, rows: parsed.rows, pages: parsed.pages, mode: parsed.mode }];
    }
    if (!global.XLSX) throw new Error('Excel 解析元件沒有載入，請重新整理頁面再試');
    say(`⏳ 讀取 ${name}…`);
    const wb = global.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    return wb.SheetNames.map((sn) => ({ name: sn, rows: sheetToRows(wb.Sheets[sn]) }));
  }

  /**
   * 讀檔並認出所有區塊。
   * 回傳 [{ id, source, section, block, preview }]，preview = mapBlock(block, section)。
   */
  async function analyze(file, onProgress, opts) {
    const tables = await readFile(file, onProgress, opts);
    const found = [];
    tables.forEach((t) => {
      if (t.finOne) {
        const f = t.finOne;
        const kindName = { bs: '資產負債表', is: '損益表', tax: '營所稅申報書' }[f.kind];
        const block = { section: 'fin', finOne: f, header: null, rows: [], sheet: kindName };
        found.push({ id: `${found.length + 1}`, source: `${kindName} ${f.period || '（期別未知）'}${f.missing && f.missing.length ? `，讀不到：${f.missing.join('、')}` : ''}`, section: 'fin', block, preview: mapBlock(block, 'fin') });
        return;
      }
      if (t.vat401) {
        const v = t.vat401;
        const block = { section: 'vat', vat401: v, header: null, rows: [], sheet: '401 申報書' };
        found.push({ id: `${found.length + 1}`, source: `401 申報書 ${v.year} 年 ${v.period} 月`, section: 'vat', block, preview: mapBlock(block, 'vat') });
        return;
      }
      if (t.jcic) {
        if (!t.jcic.rows.length) return;
        const block = { section: 'debts', jcic: t.jcic, header: null, rows: [], sheet: '聯徵報告' };
        found.push({ id: `${found.length + 1}`, source: `聯徵報告，${t.jcic.count} 筆借款`, section: 'debts', block, preview: mapBlock(block, 'debts') });
        return;
      }
      splitBlocks(t.rows, t.name).forEach((block) => {
        const preview = mapBlock(block, block.section);
        const empty = preview.fin ? preview.fin.count === 0 : preview.vat ? preview.vat.rows.length === 0 : preview.rows.length === 0 && !preview.summary;
        if (empty) return;
        found.push({ id: `${found.length + 1}`, source: t.name, section: block.section, block, preview });
      });
    });
    return { tables, found };
  }

  /**
   * 套用到一份徵信資料。picks = [{ block, section, replace }]。
   * 回傳每個段落加了幾列。
   */
  function apply(dossier, picks) {
    const added = {};
    let settled = false;
    picks.forEach((p) => {
      if (!p.section || p.section === 'skip') return;
      const r = mapBlock(p.block, p.section);
      if (p.section === 'fin' && p.block.finOne) {
        const fin = dossier.fin;
        const f = p.block.finOne;
        if (p.replace) { fin.values = {}; fin.meta = {}; }
        if (!fin.meta) fin.meta = {};
        if (!fin.meta.surplusTarget) fin.meta.surplusTarget = ['', '', '', ''];
        const idx = slotForPeriod(fin, f.period);
        if (f.period) fin.periods[idx] = f.period;
        Object.entries(f.values).forEach(([key, v]) => {
          if (v === '') return;
          if (!fin.values[key]) fin.values[key] = ['', '', '', ''];
          if (String(fin.values[key][idx] || '') === v) return;
          fin.values[key][idx] = v;
          added.fin = (added.fin || 0) + 1;
        });
        if (f.surplusTarget !== null && f.surplusTarget !== undefined) fin.meta.surplusTarget[idx] = String(f.surplusTarget);
        if (idx === M.PERIODS - 1 && f.prevSurplusHint != null) {
          if (!fin.values.prevSurplus) fin.values.prevSurplus = ['', '', '', ''];
          fin.values.prevSurplus[idx] = String(f.prevSurplusHint);
        } else if (idx === M.PERIODS - 1 && f.surplusTarget != null && f.netIncome != null) {
          if (!fin.values.prevSurplus) fin.values.prevSurplus = ['', '', '', ''];
          fin.values.prevSurplus[idx] = String(f.surplusTarget - f.netIncome);
        }
        settled = true;
        return;
      }
      if (p.section === 'fin') {
        const fin = dossier.fin;
        if (p.replace) fin.values = {};
        if (r.fin.periods) r.fin.periods.forEach((label, i) => { if (label) fin.periods[i] = label; });
        Object.entries(r.fin.values).forEach(([key, arr]) => {
          if (!fin.values[key]) fin.values[key] = ['', '', '', ''];
          arr.forEach((v, i) => {
            if (v === '' || String(fin.values[key][i] || '') === v) return;
            fin.values[key][i] = v;
            added.fin = (added.fin || 0) + 1;
          });
        });
        return;
      }
      if (p.section === 'vat') {
        const vat = dossier.vat || (dossier.vat = M.blankVat());
        if (p.replace || !M.vatFilled(vat)) {
          const years = [...new Set(r.vat.rows.map((x) => x.year))].sort((a, b) => Number(b) - Number(a));
          Object.assign(vat, M.blankVat(), { summary: p.replace ? '' : vat.summary });
          years.slice(0, M.VAT_YEARS).forEach((y, i) => { vat.years[i] = y; });
        }
        const slotOf = (year) => {
          let i = vat.years.indexOf(year);
          if (i >= 0) return i;
          // 這一年還沒有欄位：找一個沒填數字的年份格借用
          i = vat.years.findIndex((_, k) => !M.VAT_KINDS.some(([kind]) => vat[kind][k].some((v) => v !== '')));
          if (i >= 0) vat.years[i] = year;
          return i;
        };
        r.vat.rows.forEach((row) => {
          const i = slotOf(row.year);
          if (i < 0) return;
          row.values.forEach((v, k) => {
            if (v === '' || String(vat[row.kind][i][k] || '') === v) return;
            vat[row.kind][i][k] = v;
            added.vat = (added.vat || 0) + 1;
          });
        });
        if (r.vat.summary && (p.replace || !vat.summary)) vat.summary = r.vat.summary;
        return;
      }
      if (p.block.jcic && p.section === 'debts') {
        if (p.block.jcic.baseDate) dossier.baseDate = p.block.jcic.baseDate;
        if (!dossier.owner && p.block.jcic.subject && p.block.jcic.subject !== '當事人') dossier.owner = p.block.jcic.subject;
      }
      const sec = dossier[p.section];
      // 編輯頁一開始會放一列空白給人打字，匯入時把全空的列拿掉，免得排在前面
      sec.rows = p.replace ? [] : sec.rows.filter((row) => Object.values(row).some((v) => has(v) && v !== 'company'));
      // 已經有一模一樣的列就不重複加（同一份檔丟兩次）
      const sig = (row) => JSON.stringify(Object.values(row).map((v) => String(v || '').trim()));
      const seen = new Set(sec.rows.map(sig));
      r.rows.forEach((row) => { if (!seen.has(sig(row))) { sec.rows.push(row); seen.add(sig(row)); added[p.section] = (added[p.section] || 0) + 1; } });
      if (r.summary && (p.replace || !sec.summary)) sec.summary = r.summary;
    });
    if (settled) settleSurplus(dossier.fin);
    return added;
  }

  global.DossierImport = { analyze, apply, mapBlock, splitBlocks, readFile, parseCsv, finKeyOf, matchHeader, norm, parseJcic, shortBank, pdfTextLines, parse401Text, parseBalanceSheet, parseIncomeStatement, parseTaxReturn, slotForPeriod, settleSurplus };
})(window);
