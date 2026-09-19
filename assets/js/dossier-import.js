/*
 * dossier-import.js — 把 PDF／Excel／CSV 丟進徵信資料頁，自動認出五張表的內容。
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

  const TITLE_RE = /金融負債|廠商資料|不動產|財務分析|資產負債表|損益表|徵信資料|基準日/;
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
    if (section === 'fin') return { section, fin: mapFin(block) };
    const grid = mapGrid(block, section);
    const out = { section, rows: grid.rows, columns: grid.columns };
    if (section === 'sales' || section === 'purchases') out.summary = summaryOf(block);
    return out;
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
  async function readFile(file, onProgress) {
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
  async function analyze(file, onProgress) {
    const tables = await readFile(file, onProgress);
    const found = [];
    tables.forEach((t) => {
      splitBlocks(t.rows, t.name).forEach((block) => {
        const preview = mapBlock(block, block.section);
        const empty = preview.fin ? preview.fin.count === 0 : preview.rows.length === 0 && !preview.summary;
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
    picks.forEach((p) => {
      if (!p.section || p.section === 'skip') return;
      const r = mapBlock(p.block, p.section);
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
      const sec = dossier[p.section];
      // 編輯頁一開始會放一列空白給人打字，匯入時把全空的列拿掉，免得排在前面
      sec.rows = p.replace ? [] : sec.rows.filter((row) => Object.values(row).some((v) => has(v) && v !== 'company'));
      // 已經有一模一樣的列就不重複加（同一份檔丟兩次）
      const sig = (row) => JSON.stringify(Object.values(row).map((v) => String(v || '').trim()));
      const seen = new Set(sec.rows.map(sig));
      r.rows.forEach((row) => { if (!seen.has(sig(row))) { sec.rows.push(row); seen.add(sig(row)); added[p.section] = (added[p.section] || 0) + 1; } });
      if (r.summary && (p.replace || !sec.summary)) sec.summary = r.summary;
    });
    return added;
  }

  global.DossierImport = { analyze, apply, mapBlock, splitBlocks, readFile, parseCsv, finKeyOf, matchHeader, norm };
})(window);
