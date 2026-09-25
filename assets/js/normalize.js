/*
 * normalize.js — 把 PDF 還原出來的表格列，轉成前端好用的客戶名單物件。
 */
(function (global) {
  'use strict';

  // 依序比對，先命中的優先（「下次聯絡日」要比「最近聯絡日」更早判斷）
  const FIELD_RULES = [
    ['company', ['公司名稱', '公司', '客戶名稱']],
    ['taxId', ['統編', '統一編號']],
    ['grade', ['分級', '等級']],
    ['founded', ['成立年', '成立']],
    ['capital', ['資本額', '資本']],
    ['phone', ['電話']],
    ['owner', ['負責人']],
    ['keyman', ['KEYMAN', 'KEY MAN', '關鍵人']],
    ['industry', ['產業別', '行業']],
    ['nextDate', ['下次聯絡日', '下次']],
    ['lastDate', ['最近聯絡日', '最近']],
    ['notes', ['訪談內容', '拜訪內容', '備註']],
    ['addressActual', ['實際地址']],   // 要排在「地址」前面：「實際地址」也含「地址」兩個字
    ['address', ['地址', '登記地址']],
    ['addedDate', ['名單新增日期', '名單新增', '新增日期']],
    ['country', ['國家']],
  ];

  const CITIES = ['臺北市', '台北市', '新北市', '桃園市', '臺中市', '台中市', '臺南市', '台南市',
    '高雄市', '基隆市', '新竹市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義市',
    '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '台東縣', '澎湖縣', '金門縣', '連江縣'];

  const squash = (s) => String(s || '').replace(/\s+/g, '');

  /** 全形括號、井號轉半形，方便後面用正規表示式處理。 */
  function toHalfWidth(text) {
    return String(text || '')
      .replace(/[（]/g, '(').replace(/[）]/g, ')')
      .replace(/[＃]/g, '#').replace(/[－―—]/g, '-')
      .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  }

  // 一格裡常常塞了好幾家關係企業，列印後會跟自動折行混在一起，
  // 只能靠公司型態字尾來切。長的字尾要排前面，才不會被「公司」先吃掉。
  const NAME_SUFFIX = /(股份有限公司|有限公司|股份公司|合夥事業|土木包工業|建築師事務所|會計師事務所|事務所|企業社|企業行|實業社|工程行|工作室|商行|營造廠|公司)/g;

  function splitCompanyNames(raw) {
    // 先照換行切。
    //
    // 這一步是必要的：PDF 解析那邊已經分辨過「折行」跟「真的換行」了（折行會被
    // 接回去），所以留到這裡的換行就代表是不同的公司。之前把換行整個刪掉、單靠
    // 公司字尾切，遇到沒有字尾的商號就會出事——
    //   「大同鐵工廠」＋「乙建設股份有限公司」
    // 刪掉換行後變成一長串，字尾只在最後面匹配到一次，於是整串被當成一家公司的
    // 名字，看起來就像亂碼。
    const lines = String(raw || '').split(/\n+/).map((l) => l.replace(/\s+/g, '')).filter(Boolean);
    if (!lines.length) return [];

    const names = [];
    for (const line of lines) {
      // 同一行裡還是可能擠了好幾家，所以行內再用公司字尾切一次
      let cut = 0;
      let m;
      NAME_SUFFIX.lastIndex = 0;
      while ((m = NAME_SUFFIX.exec(line)) !== null) {
        const end = m.index + m[0].length;
        const name = line.slice(cut, end).trim();
        if (name) names.push(name);
        cut = end;
      }
      const tail = line.slice(cut).trim();
      if (tail) {
        // 「…股份有限公司(3490)」這種尾巴要黏回上一個名字
        if (names.length && /^[(（]/.test(tail)) names[names.length - 1] += tail;
        else names.push(tail);
      }
    }
    return names.length ? names : [lines.join('')];
  }

  /*
   * 這個公司名稱看起來對不對。
   *
   * 名稱錯就沒辦法拿去比對商工登記，而錯的名稱通常是解析時留下的痕跡：
   * 兩家黏在一起、地址或日期溢進來、整段過長。挑出來讓使用者自己改，
   * 比讓他一筆一筆翻 872 筆快得多。
   *
   * 只回報「看得出哪裡不對」的，不做模糊猜測——誤報會讓人失去信任，
   * 之後真的有問題也懶得看。
   */
  function suspiciousName(raw) {
    const name = String(raw || '').replace(/\s+/g, '');
    if (!name) return '名稱是空的';

    NAME_SUFFIX.lastIndex = 0;
    const suffixes = name.match(NAME_SUFFIX) || [];
    if (suffixes.length > 1) return `疑似兩家以上黏在一起（出現 ${suffixes.length} 個公司字尾）`;

    /*
     * 「大同鐵工廠乙建設股份有限公司」這種：前一家是商號（鐵工廠、五金行…），
     * 這些字眼不在 NAME_SUFFIX 裡，所以整串只數得到一個公司字尾，上面那條抓不到。
     *
     * 這裡改看「商號字眼出現在中間，後面還接著一個完整的公司名」。
     * 必須說清楚的是：這個判斷一定會有誤報——「台灣工廠設備有限公司」跟
     * 「大同鐵工廠|乙建設股份有限公司」在結構上完全一樣，沒有任何規則分得開。
     * 但這只是列進「請你確認」的清單、不會自動改任何東西，所以寧可多報：
     * 誤報只花使用者一眼，漏報卻讓那筆永遠比對不到商工登記。
     */
    const SHOP_WORDS = /(鐵工廠|機械廠|加工廠|五金行|材料行|水電行|車行|商號|銀樓|農場|牧場|藥局|診所)/g;
    SHOP_WORDS.lastIndex = 0;
    let m;
    while ((m = SHOP_WORDS.exec(name)) !== null) {
      const tail = name.slice(m.index + m[0].length);
      if (tail.length < 4) continue;                 // 商號字眼落在結尾，是正常名稱
      NAME_SUFFIX.lastIndex = 0;
      if (NAME_SUFFIX.test(tail)) {
        return `可能是兩家黏在一起：「${name.slice(0, m.index + m[0].length)}」＋「${tail}」，請確認`;
      }
    }

    if (/\d{2,4}\/\d{1,2}\/\d{1,2}/.test(name)) return '名稱裡有日期，可能混到訪談內容';
    if (looksLikeAddress(name)) return '名稱看起來是地址';
    if (/^\d/.test(name)) return '名稱開頭是數字，可能混到統編或資本額';
    if (name.length > 24) return `名稱過長（${name.length} 字），可能黏到別欄的內容`;
    return '';
  }

  /**
   * 拆得開就拆，拆不開就回 null。
   * 「大同鐵工廠乙建設股份有限公司」這種前一家沒有可辨識字尾的，邊界在哪無從得知，
   * 硬拆只會拆錯——這種要讓使用者自己判斷，不要自作聰明。
   */
  function splitGluedName(raw) {
    const parts = splitCompanyNames(raw);
    if (parts.length < 2) return null;
    return { company: parts[0], aliases: parts.slice(1) };
  }

  /* ------------------------------------------------------------------
   * 經濟部公司登記清冊（設立／變更）
   *
   * 使用者每個月會去撈這種檔案找新線索。欄位固定是：
   *   序號, 統一編號, 公司名稱, 公司所在地, 代表人, 資本額, 核准設立日期
   *
   * 一次四千多筆，但他要的其實只有一小撮：資本額在一定範圍、地址在服務區。
   * 以前得自己在試算表裡篩，現在直接在匯入時做掉。
   *
   * 順便從公司名稱推產業別——這種檔案沒有行業欄位，但設備租賃做不做得成，
   * 看名字就有八成把握：「精密工業」「機械」有實體設備可談，「投資」「控股」
   * 通常只有一張辦公桌。推測歸推測，所以是標記而不是直接濾掉。
   * ------------------------------------------------------------------ */

  const GOV_COLUMNS = ['統一編號', '公司名稱', '公司所在地', '代表人', '資本額'];

  /** 這份檔案是不是經濟部的登記清冊。 */
  function isGovRegistry(rows) {
    if (!rows || !rows.length) return false;
    const head = (rows[0] || []).map(squash);
    return GOV_COLUMNS.every((c) => head.some((cell) => cell.includes(c)));
  }

  const GOV_INDUSTRY = [
    [/(精密|機械|機電|工業|製造|鑄造|模具|沖壓|加工)/, '製造加工', true],
    [/(工程|營造|水電|土木|鋼構|空調|消防)/, '工程營造', true],
    [/(物流|通運|運輸|貨運|倉儲|車業|汽車)/, '運輸物流', true],
    [/(食品|餐飲|烘焙|農產|生鮮|肉品)/, '食品餐飲', true],
    [/(科技|資訊|電子|半導體|光電|軟體|數位|網路)/, '科技資訊', true],
    [/(生技|醫療|藥品|檢驗|器材)/, '生技醫療', true],
    [/(能源|太陽能|環保|再生)/, '能源環保', true],
    [/(印刷|紡織|塑膠|橡膠|化工|金屬|五金)/, '傳統製造', true],
    [/(建設|開發|營建|不動產|地產)/, '建設開發', true],
    [/(投資|資產|控股|創投|管理顧問|顧問)/, '投資控股', false],
    [/(貿易|國際|企業|實業|興業)/, '貿易實業', true],
  ];

  function guessIndustry(name) {
    for (const [re, label, worth] of GOV_INDUSTRY) {
      if (re.test(name)) return { industry: label, hasAssets: worth };
    }
    return { industry: '', hasAssets: true };
  }

  /*
   * 營業項目代碼的大類（經濟部公司行號營業項目代碼表的第一碼）。
   * 清冊 CSV 帶了營業項目時，名字看不出行業的（「XX 有限公司」）就用這個補；
   * 有 C（製造）、E（營造）、G（運輸）項目的，看名字像投資公司也當作有設備標的。
   */
  const ITEM_CLASS = { A: '農林漁牧', B: '礦業土石', C: '製造業', D: '水電燃氣', E: '營造業', F: '批發零售', G: '運輸倉儲', H: '金融不動產', I: '專業服務', J: '文教育樂', Z: '其他' };
  function industryFromItems(items) {
    const codes = String(items || '').match(/\b[A-Z]{1,2}\d{5,6}\b/g) || [];
    if (!codes.length) return { industry: '', hasAssets: null };
    const first = codes[0][0];
    // 製造業優先：只要有一項是 C 就算製造業，那才是租賃設備會落腳的地方
    const cls = codes.some((c) => c[0] === 'C') ? 'C' : first;
    return { industry: ITEM_CLASS[cls] || '', hasAssets: codes.some((c) => /^[CEG]/.test(c)) };
  }

  /**
   * @param {Array<Array<string>>} rows 原始表格（含表頭）
   * @param {object} opt
   *   minCapital/maxCapital 單位是「元」，跟來源檔一致；cities 是要保留的縣市。
   * @returns {{records:Array, stats:object}}
   */
  function fromGovRegistry(rows, opt) {
    const o = opt || {};
    const min = Number.isFinite(o.minCapital) ? o.minCapital : 0;
    const max = Number.isFinite(o.maxCapital) ? o.maxCapital : Infinity;
    const cities = o.cities && o.cities.length ? o.cities : null;

    const head = (rows[0] || []).map(squash);
    const at = (name) => head.findIndex((c) => c.includes(name));
    /*
     * 成立年只看「核准設立日期」。
     *
     * 變更登記清冊的日期欄是「核准變更日期」，以前用「核准」去對，換負責人那天就變成
     * 成立年，整批公司都變成今年才成立的。變更日期另外收，寫進訪談內容當背景。
     */
    const idx = {
      taxId: at('統一編號'), company: at('公司名稱'), address: at('公司所在地'),
      owner: at('代表人'), capital: at('資本額'), date: at('核准設立'), changed: at('核准變更'),
      reason: at('案由'), items: at('營業項目'), period: at('期別'),
    };
    if (idx.date < 0 && idx.changed < 0) idx.date = at('核准');   // 舊格式：只有一欄，當成設立
    const onlyUp = !!o.onlyCapitalUp;

    const stats = { total: rows.length - 1, capitalOut: 0, cityOut: 0, dup: 0, kept: 0, notUp: 0 };
    const seen = new Set();
    const records = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const cell = (k) => (idx[k] >= 0 ? String(row[idx[k]] || '').trim() : '');
      const taxId = cell('taxId').replace(/\D/g, '');
      const company = cell('company');
      if (!company) continue;

      const reason = cell('reason');
      if (onlyUp && !/增資|發行新股/.test(reason)) { stats.notUp++; continue; }   // 發行新股就是增資
      const capital = Number(cell('capital').replace(/\D/g, ''));
      if (!Number.isFinite(capital) || capital < min || capital > max) { stats.capitalOut++; continue; }

      const address = cell('address');
      const city = (CITIES.find((c) => address.startsWith(c)) || '').replace(/^台/, '臺');
      if (cities && !cities.includes(city)) { stats.cityOut++; continue; }

      // 同一批檔案裡（例如同月份的兩份）會有完全相同的資料列
      const key = taxId || squash(company);
      if (seen.has(key)) { stats.dup++; continue; }
      seen.add(key);

      const byName = guessIndustry(company);
      const byItems = industryFromItems(cell('items'));
      const industry = byName.industry || byItems.industry;
      const hasAssets = byItems.hasAssets === true ? true : byName.hasAssets;
      // 期別 11508 → 「115年8月」；清冊本身的類別看有沒有變更日期
      const period = cell('period').match(/^(\d{3})(\d{2})$/);
      const when = period ? `${period[1]}年${+period[2]}月` : '';
      const changed = cell('changed');
      const items = cell('items').split(/；|;/).map((x) => x.trim()).filter(Boolean);
      records.push({
        taxId,
        company,
        address,
        owner: cell('owner'),
        capitalThousands: Math.round(capital / 1000).toLocaleString('en-US'),
        capitalRaw: capital,
        founded: (cell('date').match(/^\d{3}/) ? String(+cell('date').slice(0, 3) + 1911) : ''),
        industry,
        hasAssets,
        reason,
        capitalUp: /增資|發行新股/.test(reason),
        // 訪談內容裡的背景一行：不能帶「115/08/18」這種日期，parseNotes 會把它當成一通電話
        background: [
          changed ? `${when}變更登記：${reason || '（案由未載明）'}` : (cell('date') ? `${when}設立登記` : ''),
          items.length ? `營業項目：${items.slice(0, 6).join('；')}${items.length > 6 ? `…共 ${items.length} 項` : ''}` : '',
        ].filter(Boolean).join('。'),
      });
      stats.kept++;
    }
    return { records, stats };
  }

  /** 轉成「貼上新增客戶」那套標準欄位順序，後面就走既有的解析流程。 */
  function govToStandardRows(records) {
    const out = [STANDARD_HEADER.slice()];
    records.forEach((r) => {
      const note = [r.background || '', r.hasAssets ? '' : '（名稱看起來是投資／控股類，可能沒有設備標的）'].filter(Boolean).join('\n');
      out.push([r.company, r.taxId, '', r.founded, r.capitalThousands, '', r.owner,
        '', r.industry, '', '', note, r.address, '', '']);
    });
    return out;
  }

  /*
   * 資本額的單位是「元」還是「仟元」。
   *
   * 名單的慣例是仟元（PDF 上寫 38,000 就是三千八百萬），但公司匯出的 xlsx 是元
   * （寫 30000000）。直接匯進來會差一千倍，把五十萬變成五億。
   *
   * 看整欄的中位數判斷：中小企業的資本額用仟元表示多半在幾千到幾萬之間，
   * 用元表示則是幾百萬起跳，中間隔了兩個數量級，20 萬這條線離兩邊都很遠。
   * 值太少（不到 5 筆）就不猜，寧可不換算也不要換錯。
   */
  function capitalLooksLikeYuan(rows, map) {
    if (!rows || map.capital === undefined) return false;
    const nums = [];
    for (let i = 1; i < rows.length; i++) {
      const raw = String((rows[i] || [])[map.capital] || '').replace(/[,\s]/g, '');
      if (/^\d+(\.\d+)?$/.test(raw)) nums.push(Number(raw));
    }
    if (nums.length < 5) return false;
    nums.sort((a, b) => a - b);
    return nums[Math.floor(nums.length / 2)] >= 200000;
  }

  /** 把整欄資本額由元換成仟元，回傳換了幾筆。非數字的原樣留著。 */
  function convertCapitalToThousands(rows, map) {
    let n = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      const raw = String(row[map.capital] || '').replace(/[,\s]/g, '');
      if (!/^\d+(\.\d+)?$/.test(raw)) continue;
      row[map.capital] = Math.round(Number(raw) / 1000).toLocaleString('en-US');
      n++;
    }
    return n;
  }

  /** 找出表頭那一列，回傳 { index, map }；找不到回傳 null。 */
  function detectHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 8); i++) {
      const cells = rows[i].map(squash);
      const map = {};
      const ignored = [];
      let hits = 0;
      cells.forEach((cell, col) => {
        if (!cell) return;
        for (const [field, keys] of FIELD_RULES) {
          const matches = keys.some((k) => cell.toUpperCase().includes(k.toUpperCase()));
          if (!matches) continue;
          if (map[field] !== undefined) {
            // 同一個欄位出現兩次時（例如「名單新增日期(必填)」跟「名單新增日期(更新版)」），
            // 使用者確認過「更新版」才是正確的，所以標著「更新」的那欄優先。
            //
            // 落選的那欄要記下來：它有表頭、內容也是正經的日期，但不是我們要的。
            // 不記的話 resolveRow 會把它當成「不知道屬於誰的日期」，塞給空著的
            // 下次聯絡日——結果一堆根本沒約的客戶全變成逾期。
            const prev = cells[map[field]] || '';
            if (cell.includes('更新') && !prev.includes('更新')) {
              ignored.push(map[field]);
              map[field] = col;
            } else {
              ignored.push(col);
            }
            return;
          }
          map[field] = col;
          hits++;
          return;
        }
      });
      if (hits >= 4 && map.company !== undefined) return { index: i, map, ignored };
    }
    return null;
  }

  /**
   * 日期字串轉 ISO。支援 2026/9/14、2026-09-14、115/09/14（民國）、2024年、20260320。
   */
  function parseDate(raw) {
    const text = toHalfWidth(raw).trim();
    if (!text) return null;
    let m = text.match(/(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/);
    if (m) return iso(+m[1], +m[2], +m[3]);
    m = text.match(/\b(\d{2,3})\/(\d{1,2})\/(\d{1,2})/);           // 民國
    if (m && +m[1] < 200) return iso(+m[1] + 1911, +m[2], +m[3]);
    m = text.match(/\b(\d{4})(\d{2})(\d{2})\b/);
    if (m) return iso(+m[1], +m[2], +m[3]);
    m = text.match(/\b(1[0-9]{2})(\d{2})(\d{2})\b/);               // 1150914
    if (m) return iso(+m[1] + 1911, +m[2], +m[3]);
    m = text.match(/(\d{4})\s*年?$/);
    if (m && +m[1] > 1900 && +m[1] < 2100) return `${m[1]}-01-01`;
    return null;
  }

  function iso(y, mo, d) {
    if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  /** 從一段文字抓出所有電話，含分機與括號註記。 */
  function extractPhones(raw) {
    const out = [];
    const seen = new Set();
    const extOf = (text) => (text.match(/(?:#|分機|轉)\s*(\d{2,5})/) || [])[1] || '';
    const noteOf = (text) => {
      const m = text.match(/\(([^)]{1,20})\)/);
      // 排除 (02) 這種把區碼括起來的寫法
      return m && /[^\d\s-]/.test(m[1]) ? m[1].trim() : '';
    };

    const PHONE_RE_SRC = '\\(?0\\d{1,3}\\)?[\\s-]?\\d{3,4}[\\s-]?\\d{3,4}';
    const STOP_LEAD = /^(電話|手機|公司|市話|傳真|TEL|Tel|tel|FAX|Fax|行動|聯絡電話|公司電話|辦公室|總機)$/;
    for (const line of toHalfWidth(raw).split(/\n+/)) {
      const re = new RegExp(PHONE_RE_SRC, 'g');
      let m;
      let foundInLine = false;
      let lastEnd = 0;
      const single = (line.match(new RegExp(PHONE_RE_SRC, 'g')) || []).length === 1;
      while ((m = re.exec(line)) !== null) {
        const digits = m[0].replace(/\D/g, '');
        if (digits.length < 8 || digits.length > 11) continue;
        foundInLine = true;
        /*
         * 一行裡好幾支電話時，每支的備註各自歸各自：
         *   「馬少軒0936-570087呂彥皇(員工?)0987-729-798」
         *   → 0936 的備註是前面的「馬少軒」；「呂彥皇(員工?)」是 0987 的。
         * 尾巴只看到下一支電話之前；尾巴的括號要緊接著號碼才算這支的。
         */
        let tail = line.slice(m.index + m[0].length);
        const nextAt = tail.search(new RegExp(PHONE_RE_SRC));
        if (nextAt >= 0) tail = tail.slice(0, nextAt);
        const head = line.slice(lastEnd, m.index).replace(/^[\s\-,，、;；/]+/, '');
        lastEnd = m.index + m[0].length;
        const ext = extOf(tail) || (single ? extOf(line) : '');
        const tailNote = /^[\s\-,，、;；]*\(/.test(tail) ? noteOf(tail) : '';
        const headParen = noteOf(head);
        let lead = head.replace(/\([^)]*\)/g, ' ').replace(/[\d\s\-()#、,，;；/:：]/g, ' ').replace(/分機|轉/g, ' ').trim();
        if (STOP_LEAD.test(lead) || lead.length < 2 || lead.length > 12) lead = '';
        const note = tailNote || [lead, headParen].filter(Boolean).join(' ') || (single ? noteOf(line) : '');
        const key = digits + '#' + ext;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          display: m[0].trim() + (ext ? ` 分機${ext}` : ''),
          dial: ext ? `${digits},${ext}` : digits,
          note,
        });
      }
      // 「分機210(財務長鍾小姐)」常常自己一行，掛回上一支電話
      if (!foundInLine && out.length) {
        const ext = extOf(line);
        if (ext) {
          const base = out[out.length - 1];
          const digits = base.dial.split(',')[0];
          const key = digits + '#' + ext;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({
              display: `${base.display.split(' 分機')[0]} 分機${ext}`,
              dial: `${digits},${ext}`,
              note: noteOf(line),
            });
          }
        }
      }
    }
    return out;
  }

  /** 電話欄拆成一列一列（號碼、分機、備註），給編輯表單用；serializePhones 再拼回去。 */
  function phoneRows(raw) {
    return extractPhones(raw).map((p) => {
      const [digits, ext] = p.dial.split(',');
      return { number: p.display.split(' 分機')[0].trim(), digits, ext: ext || '', note: p.note || '' };
    });
  }
  /** 一支電話一行：「0936-570087 分機23 (馬少軒)」，extractPhones 讀得回來。 */
  function serializePhones(rows) {
    return rows
      .filter((r) => String(r.number || '').replace(/\D/g, '').length >= 8)
      .map((r) => `${String(r.number).trim()}${r.ext ? ` 分機${String(r.ext).trim()}` : ''}${r.note ? ` (${String(r.note).trim()})` : ''}`)
      .join('\n');
  }

  /** 把訪談內容切成一則則帶日期的紀錄，新到舊排序。 */
  function parseNotes(raw) {
    const text = toHalfWidth(raw).replace(/\r/g, '');
    if (!text.trim()) return [];
    const re = /(\d{4}\/\d{1,2}\/\d{1,2}|\d{2,3}\/\d{1,2}\/\d{1,2})/g;
    const marks = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > 0 && /[\d\/]/.test(text[m.index - 1])) continue;
      marks.push({ at: m.index, raw: m[1] });
    }
    if (!marks.length) return [{ date: null, text: text.trim() }];

    const entries = [];
    if (marks[0].at > 0) {
      const head = text.slice(0, marks[0].at).trim();
      if (head) entries.push({ date: null, text: head });
    }
    marks.forEach((mark, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].at : text.length;
      let body = text.slice(mark.at + mark.raw.length, end).trim();
      // 日期後面緊接著的「11:00」是網站記通話時存的時間，另外收起來，不算內容
      let time = '';
      const t = body.match(/^(\d{1,2}:\d{2})(?=\s|$|\[|［)/);
      if (t) { time = t[1].padStart(5, '0'); body = body.slice(t[0].length).trim(); }
      entries.push({ date: parseDate(mark.raw), dateRaw: mark.raw, time, text: body });
    });
    return entries.filter((e) => e.text || e.date);
  }

  /*
   * 一格地址拆成「登記地址」與「實際地址」。
   *
   * 名單上有些地址寫成「104登記：臺北市內湖區… / 公司登記：新北市新莊區…」：
   * 104 上的是公司實際上班的地方，商工登記的是登記地。使用者要兩欄分開看，
   * 沒有這種寫法的就兩欄都是同一個地址。
   */
  function splitAddress(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) return { registered: '', actual: '' };
    const m1 = text.match(/104登記[：:]\s*(.+?)\s*[\/／]\s*公司登記[：:]\s*(.+)$/);
    if (m1) return { actual: m1[1].trim(), registered: m1[2].trim() };
    const m2 = text.match(/公司登記[：:]\s*(.+?)\s*[\/／]\s*104登記[：:]\s*(.+)$/);
    if (m2) return { registered: m2[1].trim(), actual: m2[2].trim() };
    const only104 = text.match(/^104登記[：:]\s*(.+)$/);
    if (only104) return { registered: only104[1].trim(), actual: only104[1].trim() };
    const onlyReg = text.match(/^公司登記[：:]\s*(.+)$/);
    if (onlyReg) return { registered: onlyReg[1].trim(), actual: onlyReg[1].trim() };
    return { registered: text, actual: text };
  }

  /*
   * 2010／2014 升格前的舊寫法：名單上還有不少「臺北縣板橋市」「桃園縣龜山鄉」。
   * 只認新名字的話這些客戶會被歸到「未填地址」，明明地址就寫在那裡。
   * 縣名換成現在的市名，底下的鄉鎮市一律換成區（直轄市底下只有區）。
   */
  const LEGACY_CITY = {
    臺北縣: '新北市', 台北縣: '新北市', 桃園縣: '桃園市',
    臺中縣: '臺中市', 台中縣: '臺中市', 臺南縣: '臺南市', 台南縣: '臺南市', 高雄縣: '高雄市',
  };
  const MUNICIPALITIES = new Set(['臺北市', '新北市', '桃園市', '臺中市', '臺南市', '高雄市']);
  function parseAddress(raw) {
    let text = String(raw || '').replace(/\s+/g, '');
    let legacy = false;
    Object.entries(LEGACY_CITY).forEach(([old, now]) => {
      if (text.includes(old)) { text = text.replace(old, now); legacy = true; }
    });
    const city = CITIES.find((c) => text.includes(c)) || '';
    let district = '';
    if (city) {
      const after = text.slice(text.indexOf(city) + city.length);
      district = (after.match(/^[一-龥]{1,3}[區鄉鎮市]/) || [''])[0];
    }
    const cityNow = city.replace(/^台/, '臺');
    if ((legacy || MUNICIPALITIES.has(cityNow)) && /[鄉鎮市]$/.test(district)) district = district.replace(/[鄉鎮市]$/, '區');
    return { city: cityNow, district };
  }
  /** 先看實際地址，看不出縣市再看登記地址——兩個欄位有一個能判讀就不算沒地址。 */
  function parseAddressAny(actual, registered) {
    const first = parseAddress(actual);
    if (first.city || !registered) return first;
    return parseAddress(registered);
  }

  /** 從訪談內容推出一個粗略的洽談狀態，讓業務可以快速篩。 */
  /*
   * 洽談狀態只有四種：未撥打、未接通、已聯絡、禁止推廣。
   * 曾經有「有意願」「已約訪」「婉拒」三種，使用者說談過就是談過，全部併進已聯絡；
   * 舊資料、舊紀錄、母檔裡的「[婉拒]」標記都照這張表換算。
   */
  const OUTCOME_LABEL = {
    new: '未撥打',
    noanswer: '未接通',
    contacted: '已聯絡',
    blocked: '禁止推廣',
  };
  const LEGACY_OUTCOME = {
    interested: 'contacted', meeting: 'contacted', declined: 'contacted',
    有意願: 'contacted', 已約訪: 'contacted', 婉拒: 'contacted',
  };
  const normalizeOutcome = (k) => LEGACY_OUTCOME[k] || k;
  const outcomeLabel = (k) => OUTCOME_LABEL[normalizeOutcome(k)] || k || '';

  function guessOutcome(notes) {
    const t = squash(notes);
    if (!t) return 'new';
    // 最上面那則沒有標日期，代表那是背景資料（徵才資訊、產品線），不是一通電話。
    // 使用者的規則：最新一次紀錄沒日期＝還沒撥打。
    const entries = parseNotes(notes);
    if (entries.length && !entries[0].date) return 'new';
    // 網站匯出（或使用者母檔）的寫法是「日期 [結果] 內容」，方括號裡就是結果，直接採用
    const tagged = entries.length && String(entries[0].text || '').match(/^\s*[\[［]([^\]］]{2,5})[\]］]/);
    if (tagged) {
      const label = tagged[1].trim();
      const key = Object.keys(OUTCOME_LABEL).find((k) => OUTCOME_LABEL[k] === label) || LEGACY_OUTCOME[label];
      if (key) return key;
    }
    if (/禁止推廣|禁推|別再撥打|不要再打|打死不想/.test(t)) return 'blocked';
    // 有講到話（約訪、有興趣、拒絕都算）就是已聯絡，即使後面寫了「再撥打」
    if (/約訪|拜訪|約時間|約下|約他|點到公司|資金需求|有興趣|有些興趣|想了解|報價|額度需求|請他提供資料|拒絕|不需要|用不到|用不上|沒機會|沒有需求|秒拒|不考慮/.test(t)) return 'contacted';
    if (/未接|沒接|沒人接|無人接|語音|忙線|晚點再撥|再撥打/.test(t)) return 'noanswer';
    return 'contacted';
  }


  /**
   * 表格跨頁時，同一筆資料會被切成上下兩段。沒有公司名稱的片段一定是續行，
   * 把它併回真正的那一列。
   */
  function mergeContinuations(rows, map, pageStarts) {
    const at = (row, field) => (map[field] === undefined ? '' : (row[map[field]] || '').trim());
    const filled = (row) => row.some((c) => c && c.trim());
    // 跨頁切開的片段是「同一段文字被裁成兩半」，所以直接接起來，不要補換行
    const glue = (a, b) => ((a || '').trim() + (b || '').trim());
    const joinInto = (target, extra) => target.map((cell, c) => glue(extra[c], cell));
    // 有公司名卻連統編、電話、任何日期都沒有 → 這是被切在頁尾的上半段
    const isTopFragment = (row) => !at(row, 'taxId') && !at(row, 'phone')
      && !at(row, 'nextDate') && !at(row, 'lastDate') && !at(row, 'addedDate');

    const startsPage = new Set(pageStarts || []);
    const endsPage = new Set((pageStarts || []).map((n) => n - 1));
    const queue = rows.map((r) => r.slice());
    const out = [];
    let dropped = 0;

    for (let i = 0; i < queue.length; i++) {
      const row = queue[i];
      if (!filled(row)) continue;
      if (squash(at(row, 'company')).includes('公司名稱')) continue;  // 跨頁重複的表頭

      const company = at(row, 'company');
      const fragment = !company || isTopFragment(row);
      // 頁尾的殘缺列 → 接到下一頁的開頭；頁首的殘缺列 → 接回上一頁的最後一筆
      if (fragment && endsPage.has(i) && queue[i + 1] && filled(queue[i + 1])) {
        queue[i + 1] = joinInto(queue[i + 1], row);
        continue;
      }
      if (fragment && startsPage.has(i) && out.length) {
        const prev = out[out.length - 1];
        row.forEach((cell, c) => { if (cell && cell.trim()) prev[c] = glue(prev[c], cell); });
        continue;
      }
      if (company && isTopFragment(row) && queue[i + 1] && filled(queue[i + 1])) {
        queue[i + 1] = joinInto(queue[i + 1], row);   // 併進下一頁的下半段
        continue;
      }
      if (!company) {
        if (out.length) {
          const prev = out[out.length - 1];
          row.forEach((cell, c) => { if (cell && cell.trim()) prev[c] = glue(prev[c], cell); });
        } else if (queue[i + 1]) {
          queue[i + 1] = joinInto(queue[i + 1], row);
        } else {
          dropped++;
        }
        continue;
      }
      out.push(row);
    }
    return { rows: out, dropped };
  }

  /* ------------------------------------------------------------------
   * 內容型態驗證
   *
   * 只靠欄位位置對應是脆弱的：PDF 少偵測到一條直線、或表格有合併儲存格，
   * 整列就會整個平移，訪談內容就跑到「成立年」底下。所以每個欄位都要能
   * 自己驗證「這格看起來像不像我」，不像就去別格找。
   * ------------------------------------------------------------------ */

  const COUNTRIES = /^(台灣|臺灣|中國|大陸|中國大陸|香港|澳門|越南|美國|日本|韓國|新加坡|馬來西亞|泰國|印尼|菲律賓|印度|德國|英國|法國|加拿大|澳洲)$/;

  /** 這格是不是「只有日期」（最多兩個日期，沒有別的內容）。 */
  function dateOnly(text) {
    const s = squash(toHalfWidth(text));
    if (!s || s.length > 26) return null;
    if (!/^[\d\/\-.年月日]+$/.test(s)) return null;
    return parseDate(s);
  }

  /**
   * 每個欄位的驗證器：看得懂就回傳「清理過的值」，看不懂就回傳空字串。
   * 回傳值而不是布林，是因為儲存格可能黏了鄰欄的內容（例如「2022 1,000」），
   * 這時候把屬於自己的那一段挑出來，比整格丟掉好。
   */
  /**
   * 這串看起來像不像地址。
   *
   * 人名欄位（負責人、KEYMAN）非用不可：原本的 person 驗證器只管「26 字以內的
   * 中文數字」，而「新北市新莊區幸福東路79號4樓」正好符合，於是 KEYMAN 會在第一輪
   * 就把地址搶走並佔住那一格，等輪到 address 時已經拿不到了——這就是名單裡大量
   * 「未填地址」的真正原因，資料其實一直都在，只是掛錯欄位。
   */
  function looksLikeAddress(raw) {
    const s = squash(raw);
    if (!s) return false;
    if (/[縣市][\u4e00-\u9fa5]{1,3}[區鄉鎮市]/.test(s)) return true;          // 新北市新莊區
    if (/\d+號/.test(s) && /[路街巷弄段村里]/.test(s)) return true;            // …幸福東路79號
    if (/[路街道]\s*[一二三四五六七八九十\d]+段/.test(s)) return true;          // …中正路二段
    return false;
  }

  const VALIDATORS = {
    taxId: (t) => {
      const s = squash(t);
      if (!s || s.length > 24) return '';
      const m = s.match(/(?:^|[^\d])(\d{8})(?![\d])/);
      return m ? m[1] : '';
    },
    grade: (t) => {
      const s = squash(t).toUpperCase();
      return /^[SABC][?？]?$/.test(s) ? s : '';
    },
    founded: (t) => {
      const s = squash(t);
      if (!s || s.length > 16) return '';               // 長文一定不是年份欄
      const m = s.match(/(?:19|20)\d{2}/);
      return m ? m[0] : '';
    },
    capital: (t) => {
      const s = squash(t);
      return /^[\d,]{1,15}$/.test(s) && /\d/.test(s) ? s : '';
    },
    country: (t) => (COUNTRIES.test(squash(t)) ? squash(t) : ''),
    phone: (t) => {
      const body = String(t || '').trim();
      if (!body || body.length > 90) return '';        // 一大段訪談內容裡就算有號碼也不是電話欄
      return extractPhones(body).length ? body : '';
    },
    address: (t) => {
      const body = String(t || '').trim();
      const s = squash(body);
      if (!s || s.length > 160) return '';
      if (!/[縣市]/.test(s) || !/[區鄉鎮市路街號村里巷弄段樓]/.test(s)) return '';
      if (/\d{2,3}\/\d{1,2}\/\d{1,2}/.test(s)) return '';   // 有訪談日期 → 是訪談內容
      return body;
    },
    notes: (t) => {
      const body = String(t || '').trim();
      if (!body) return '';
      const s = squash(body);
      if (/\d{2,4}\/\d{1,2}\/\d{1,2}/.test(s) && s.length > 10) return body;
      return s.length >= 14 ? body : '';
    },
    company: (t) => {
      const body = String(t || '').replace(/\n/g, '').trim();
      const s = squash(body);
      if (!s || s.length > 90) return '';
      NAME_SUFFIX.lastIndex = 0;
      if (NAME_SUFFIX.test(s)) return body;
      // 沒有公司型態字尾的（商號、個人戶）：中文為主、不含日期或長句
      return /^[\u4e00-\u9fa5A-Za-z0-9()（）\-&.· ]{2,24}$/.test(s) && !/\d{2,4}\/\d{1,2}/.test(s) ? body : '';
    },
    industry: (t) => {
      const body = String(t || '').trim();
      const s = squash(body);
      if (!s || s.length > 24) return '';
      if (/\d{2,4}\/\d{1,2}\/\d{1,2}/.test(s)) return '';
      if (looksLikeAddress(s)) return '';   // 是地址
      return /[\u4e00-\u9fa5]/.test(s) ? body : '';
    },
    person: (t) => {
      const body = String(t || '').trim();
      const s = squash(body);
      if (!s || s.length > 26) return '';
      if (/\d{2,4}\/\d{1,2}\/\d{1,2}/.test(s)) return '';
      if (looksLikeAddress(s)) return '';        // 地址不是人名，別讓 KEYMAN 搶走
      return /^[\u4e00-\u9fa5A-Za-z0-9()（）?？\-. ]{1,26}$/.test(s) ? body : '';
    },
    nextDate: dateOnly,
    lastDate: dateOnly,
    addedDate: dateOnly,
  };
  VALIDATORS.addressActual = (t) => VALIDATORS.address(t);
  VALIDATORS.owner = VALIDATORS.person;
  VALIDATORS.keyman = VALIDATORS.person;

  const validate = (field, text) => {
    const fn = VALIDATORS[field];
    if (!fn) return String(text || '').trim();
    return fn(text) || '';
  };

  // 這幾個欄位的內容型態夠明確，適合拿來判斷「整列是不是平移了」
  const ANCHOR_FIELDS = ['taxId', 'grade', 'capital', 'founded', 'country', 'phone', 'address'];

  /**
   * 整份表格如果因為少偵測到一條直線而整體平移，位置對應會全錯。
   * 拿前面幾十列試算各種位移，挑出讓錨點欄位驗證通過最多次的那一個。
   */
  function detectShift(rows, map) {
    const sample = rows.slice(0, 40);
    const width = Math.max(...sample.map((r) => r.length), 0);
    let best = { shift: 0, score: -1 };
    for (let shift = -4; shift <= 4; shift++) {
      let score = 0;
      for (const row of sample) {
        for (const field of ANCHOR_FIELDS) {
          const idx = map[field];
          if (idx === undefined) continue;
          const at = idx + shift;
          if (at < 0 || at >= width) continue;
          if (validate(field, row[at])) score++;
        }
      }
      // 同分時維持不位移，不要無謂地動它
      if (score > best.score || (score === best.score && shift === 0)) best = { shift, score };
    }
    return best;
  }

  /**
   * 把一列的每個欄位安置到正確的格子：先用表頭位置，位置上的內容驗證不過，
   * 就在整列裡找一個驗證得過、而且還沒被別人用走的格子。
   */
  function resolveRow(cells, map, ignored) {
    // 表頭裡落選的重複欄位一開始就標成用過，任何一輪都不准撿它的內容
    const used = new Set(ignored || []);
    const out = {};

    // 第零輪：地址優先卡位。
    //
    // address 的驗證條件是所有文字欄位裡最嚴的（要同時有縣市和路街門牌），所以
    // 一格內容若通過 address 驗證，它幾乎不可能是人名、產業別或訪談內容。反過來
    // 卻不成立——那些欄位的驗證都寬鬆到會接受地址。若照 FIELD_RULES 的順序跑，
    // 排在前面的 KEYMAN／訪談內容會在第一輪就把地址搶走並佔住格子，等輪到
    // address 時那格已經被標記用過了。這正是名單裡大量「未填地址」的成因：
    // 資料一直都在，只是掛錯欄位。
    if (map.address === undefined || !validate('address', cells[map.address])) {
      // 地址在這類名單裡通常排在最後幾欄，從列尾往前找命中率最高
      for (let i = cells.length - 1; i >= 0; i--) {
        if (used.has(i)) continue;
        const value = validate('address', cells[i]);
        if (value) { out.address = value; used.add(i); break; }
      }
    }

    // 第一輪：位置正確的先卡位
    for (const [field] of FIELD_RULES) {
      if (out[field] !== undefined) continue;
      const idx = map[field];
      if (idx === undefined || used.has(idx)) continue;
      const value = validate(field, cells[idx]);
      if (value) { out[field] = value; used.add(idx); }
    }

    // 第二輪：位置上對不起來的，改用內容找
    const DATE_FIELDS = ['nextDate', 'lastDate', 'addedDate'];
    for (const [field] of FIELD_RULES) {
      if (out[field] !== undefined || DATE_FIELDS.includes(field)) continue;
      let pick = -1;
      let pickValue = '';
      for (let i = 0; i < cells.length; i++) {
        if (used.has(i)) continue;
        const value = validate(field, cells[i]);
        if (!value) continue;
        // 就近優先：離原本的欄位越近越可能是它
        if (pick < 0 || (map[field] !== undefined
          && Math.abs(i - map[field]) < Math.abs(pick - map[field]))) {
          pick = i;
          pickValue = value;
        }
      }
      if (pick >= 0) { out[field] = pickValue; used.add(pick); }
    }

    // 日期三兄弟一起處理：長相一樣，只能靠位置與先後順序分辨
    const dateCells = [];
    for (let i = 0; i < cells.length; i++) {
      const iso = dateOnly(cells[i]);
      if (iso) dateCells.push({ index: i, iso });
    }
    for (const field of DATE_FIELDS) {
      const idx = map[field];
      const hit = dateCells.find((d) => d.index === idx && !used.has(d.index));
      if (hit) { out[field] = hit.iso; used.add(hit.index); }
    }
    // 還缺的就按時間先後補：名單新增 ≤ 最近聯絡 ≤ 下次聯絡
    const spare = dateCells.filter((d) => !used.has(d.index)).sort((a, b) => a.iso.localeCompare(b.iso));
    for (const field of ['addedDate', 'lastDate', 'nextDate']) {
      if (out[field] || !spare.length) continue;
      const take = field === 'nextDate' ? spare.pop() : spare.shift();
      if (take) { out[field] = take.iso; used.add(take.index); }
    }
    return out;
  }

  /* ------------------------------------------------------------------
   * 往來對象判讀
   *
   * 訪談內容裡常寫到客戶跟誰有往來，這會直接影響案子怎麼走：
   * 中租其他單位的舊戶牽動歸屬與收益率控管，同業與銀行則是競爭態勢。
   * 名稱是從實際名單的訪談內容裡挖出來的，不是憑空列的。
   * ------------------------------------------------------------------ */

  // 租賃／分期同業
  // 合迪不在這裡：它是中租集團的公司，算自己人（見 INTERNAL_UNITS）
  const PEER_UNITS = ['台新租賃', '中國租賃', '和潤', '裕融', '新鑫', '遠信', '博鈞'];
  // 銀行（需要出現在金融關係的上下文才算，避免「國泰建設」這種同名誤判）
  const BANKS = ['兆豐', '玉山', '永豐', '國泰', '富邦', '元大', '華南', '第一銀', '彰銀',
    '合庫', '土銀', '上海商銀', '陽信', '板信', '新光', '台企銀', '中國信託', '星展', '匯豐'];
  const BANK_CONTEXT = /(額度|貸款|融資|往來|核准|撥款|授信|存款|利率|銀行|借款|保證|履保)/;

  const RELATION_LABEL = {
    internal: '中租其他單位',
    peer: '同業',
    bank: '銀行',
  };

  /**
   * 從訪談內容判讀客戶跟哪些單位有往來。
   * 每一筆都附上原文片段，方便使用者自己確認判斷對不對。
   * @returns {{internal:Array, peer:Array, bank:Array}}
   */
  function detectRelations(notesRaw) {
    const out = { internal: [], peer: [], bank: [] };
    const text = toHalfWidth(notesRaw || '');
    if (!text.trim()) return out;
    const lines = text.split(/\n+/);

    const collect = (bucket, names, needContext) => {
      const seen = new Set();
      names.forEach((name) => {
        for (const line of lines) {
          if (!line.includes(name)) continue;
          // 中租單位要排掉同名的地址與銀行（新北市、彰化銀行）
          if (bucket === 'internal' && !hasInternalUnit(line)) continue;
          if (needContext && !BANK_CONTEXT.test(line)) continue;
          // 已經收過更長的名稱就不重複收短的（例如有「台新租賃」就不再收「台新」）
          if ([...seen].some((got) => got.includes(name))) return;
          seen.add(name);
          out[bucket].push({ name, snippet: line.trim().slice(0, 70) });
          return;
        }
      });
    };

    collect('internal', INTERNAL_UNITS, false);
    collect('peer', PEER_UNITS, false);
    collect('bank', BANKS, true);
    return out;
  }

  /* ------------------------------------------------------------------
   * 往來與否（二分法）
   *
   * 業務實際在用的判準只有一條：最新一期訪談內容有沒有寫到「本餘」。
   * 有寫本餘＝這家現在還有在跑的案子，本金餘額掛在別的單位身上；
   * 沒寫＝我們這邊沒有往來紀錄，是可以直接切進去談的名單。
   * 只看最新一期，是因為三年前的本餘早就還完了，拿舊資料判斷會誤判。
   * ------------------------------------------------------------------ */

  // 「本於」是「本餘」的誤植——餘和於字形相近，打字和辨識都常錯。
  // 使用者實際在名單裡看到這種寫法，所以一併收。
  const BALANCE_RE = /本餘|本金餘|本於|本金於/;

  /*
   * 中租體系的單位名稱（往來情形與往來對象兩處共用）。
   *
   * 除了大企、微企、融專這些，**行銷區域的各分公司名稱也算**——業務在紀錄裡會直接
   * 寫「城東202210結束」「融專目前億土建榮」「宜花已經沒」，不會寫成「中租城東分公司」。
   * 「供型／弓形」是同一個東西的兩種寫法，名單裡兩種都出現過。
   */
  const INTERNAL_UNITS = ['大企部', '大企', '微企處', '微企', '融專',
    '一版組', '設備組', '長租', '中租', '供型', '弓形',
    '合迪',   // 中租集團的公司，客戶跟合迪有案子就是跟中租往來
    // 行銷區域劃分表上的分公司名稱
    '城中', '城東', '城北', '新莊', '新北', '桃園', '新竹', '宜花',
    '北台中', '南台中', '中彰', '彰化', '嘉義', '府城', '台南', '北高雄', '南高雄', '高屏'];

  /*
   * 分公司名稱有一半同時是地名或銀行名，後面接這些字就不是在講中租的單位。
   *
   * 「新北市新莊區中正路」是地址、「彰化銀行」是銀行、「台南的廠」是地點——
   * 不擋的話，光是地址出現在訪談內容裡就會被判成跟中租往來。
   */
  const UNIT_NOT_AFTER = /^(市|縣|區|鄉|鎮|村|里|路|街|巷|弄|號|樓|銀行|商銀|銀|分行)/;
  /** 這段文字裡有沒有真的提到中租的單位（排除地址、銀行那種同名的）。 */
  function hasInternalUnit(text) {
    const re = new RegExp(INTERNAL_UNITS.join('|'), 'g');
    let m = re.exec(text);
    while (m) {
      if (!UNIT_NOT_AFTER.test(text.slice(m.index + m[0].length))) return true;
      m = re.exec(text);
    }
    return false;
  }

  // 合作已經結束的寫法。最新一期若寫到這些，就算同一則裡還提到本餘（例如
  // 「本餘還完、5 月解約了」），也視為沒有往來——使用者要的是「現在」的狀態。
  // 字眼只收明確講「結束」的，「到期」「續約」這種可能還在談的不收。
  const ENDED_RE = /解約|結清|還清|繳清|繳完|還完|已結束|結束了|合作結束|往來結束|沒繼續|沒有繼續|不再往來|沒再往來|沒往來了|已經沒有往來|終止合作|終止往來|停止往來/;

  // 「還在往來」的寫法。使用者在網站上記的通話多半不會寫本餘，會寫「目前還在跟中租
  // 往來」「跟大企有配合」這種話，一樣要歸到有往來。
  //
  // 只算中租體系（中租、大企、微企、融專、城北、長租、設備組、一版組）：使用者說
  // 跟銀行、同業有合作不算，分類就是「有跟中租往來／沒有跟中租往來」。
  // 以逗號、句號切成小句，同一小句要同時有中租單位、往來字眼，而且沒有否定字。
  /*
   * 往來字眼。
   *
   * 原本一定要有「還在／目前／有」這種前綴才算，但業務寫的是「城東8000萬往來中」
   * 「新北承作過設備」這種短句，沒有前綴；使用者要的規則是「分公司名稱＋本餘或往來」
   * 就算，所以把單獨的往來、本餘、承作、進件、有案也收進來（同一小句裡有否定字
   * 還是不算）。
   */
  const ACTIVE_WORD_RE = /(還在|仍在|有在|正在|持續|目前|現在|一直|尚在|有)[^，。,；;\n]{0,10}(往來|合作|配合|承作|進件|有案)|(往來|合作|配合|承作)中|往來|本餘|承作|進件|有案/;
  const NEGATED_RE = /沒|無|不|未|停|結束|解約|過$/;
  function findActive(text) {
    const clauses = text.split(/[，。,；;\n]/);
    let offset = 0;
    for (const clause of clauses) {
      if (hasInternalUnit(clause) && ACTIVE_WORD_RE.test(clause) && !NEGATED_RE.test(clause)) {
        const m = [clause.trim()];
        m.index = offset + clause.indexOf(clause.trim());
        return m;
      }
      offset += clause.length + 1;
    }
    return null;
  }

  const DEALING_LABEL = {
    active: '有跟中租往來',
    none: '沒有跟中租往來',
  };

  /**
   * 取最新一期訪談：有日期的取最晚那筆，全都沒日期就取最後一段。
   *
   * 同一天記兩則時要取「寫在上面」的那則：訪談內容的慣例是新的在最前面，
   * 所以日期一樣的話，越上面越新。以前用 `>=` 比較，同日的下一則（比較舊的那則）
   * 會蓋過上面那則——今天先記「解約」、再記「又有新本餘」，往來情形卻還停在解約。
   */
  function latestNote(notesRaw) {
    const entries = parseNotes(notesRaw);
    if (!entries.length) return null;
    const dated = entries.filter((e) => e.date);
    if (dated.length) return dated.reduce((a, b) => (b.date > a.date ? b : a));
    return entries[entries.length - 1];
  }

  /**
   * 二分法判讀往來情形，並附上原文片段讓業務自己覆核。
   * @returns {{kind:'active'|'none', date:?string, snippet:string}}
   */
  function detectDealing(notesRaw) {
    const latest = latestNote(notesRaw);
    if (!latest) return { kind: 'none', date: null, snippet: '' };
    const text = toHalfWidth(latest.text || '');
    const around = (m) => text.slice(Math.max(0, m.index - 20), m.index + 50).replace(/\s+/g, ' ').trim();
    const ended = text.match(ENDED_RE);
    if (ended) return { kind: 'none', date: latest.date || null, snippet: around(ended), ended: true };
    const m = text.match(BALANCE_RE) || findActive(text);
    if (!m) return { kind: 'none', date: latest.date || null, snippet: '' };
    return { kind: 'active', date: latest.date || null, snippet: around(m) };
  }

  /* ------------------------------------------------------------------
   * 從訪談內容找出「下次聯絡日」
   *
   * 業務常常把再聯絡的時間寫在紀錄的文字裡（「約10/15再拜訪」），而不是填進
   * 日期欄位。之前程式只讀日期欄位，所以那些客戶永遠不會出現在今日待打，
   * 等於白寫。
   *
   * 判讀刻意訂得保守，因為猜錯會打亂整個聯絡排程：
   *   - 只看每則紀錄的「內文」。開頭那個日期是訪談當天（parseNotes 已經切開），
   *     拿它當下次聯絡日一定是錯的。
   *   - 同一則紀錄裡要出現約訪的字眼才算，避免把金額、比例、電話誤判成日期。
   *   - 只接受今天以後、且一年半以內的日期。
   *   - 取最新一則紀錄的判讀結果：舊的約訪早就過期了。
   * ------------------------------------------------------------------ */

  const FOLLOWUP_HINT = /(再聯絡|再撥|再打|再約|再談|再看|再拜訪|回電|追蹤|下次|約訪|拜訪|月底|月初|月中)/;
  const FOLLOWUP_MAX_DAYS = 550;

  function addDays(isoDate, days) {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /**
   * @param {string} notesRaw 整欄訪談內容
   * @param {string} todayIso 今天（傳進來而不是直接讀時鐘，測試才好固定）
   * @returns {{iso:string, snippet:string, from:?string}|null}
   */
  function findFollowUp(notesRaw, todayIso) {
    const today = todayIso || new Date().toISOString().slice(0, 10);
    const limit = addDays(today, FOLLOWUP_MAX_DAYS);
    const entries = parseNotes(notesRaw);
    if (!entries.length) return null;

    const scan = (entry) => {
      const text = toHalfWidth(entry.text || '');
      if (!text || !FOLLOWUP_HINT.test(text)) return null;
      const re = /(\d{1,4})[\/\-.](\d{1,2})(?:[\/\-.](\d{1,2}))?/g;
      let m;
      let hit = null;
      while ((m = re.exec(text)) !== null) {
        let value = null;
        if (m[3]) {
          value = parseDate(m[0]);
        } else {
          // 只寫了月/日，要補年份。
          //
          // 只有「同年的那天已經過去很久」才推到明年——那代表是跨年（12 月寫 1/5）。
          // 不能看到過去就一律推明年：九月寫「上次8/1有拜訪過」是在講過去，
          // 推成明年 8/1 會憑空生出一個約訪。
          const mo = +m[1];
          const day = +m[2];
          if (mo < 1 || mo > 12 || day < 1 || day > 31) continue;
          const year = +today.slice(0, 4);
          const same = iso(year, mo, day);
          if (!same) continue;
          value = same >= today
            ? same
            : (same < addDays(today, -180) ? iso(year + 1, mo, day) : null);
        }
        if (!value || value <= today || value > limit) continue;
        // 同一則裡有好幾個未來日期就取最早的：那通常才是最近一次要做的事
        if (!hit || value < hit) hit = value;
      }
      if (!hit) return null;
      return { iso: hit, snippet: text.replace(/\s+/g, ' ').trim().slice(0, 60), from: entry.date || null };
    };

    // 從最新一則往回找，找到就停
    const ordered = entries.slice().reverse();
    const dated = entries.filter((e) => e.date);
    if (dated.length) {
      ordered.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    }
    for (const entry of ordered) {
      /*
       * 紀錄開頭的日期本身就在未來時，那一則整個就是約訪。
       *
       * 會有這種情況是因為 parseNotes 看到日期就切成新的一則，所以
       * 「115/09/01 老闆說115/10/15再聯絡」會被切成兩則，10/15 變成第二則的
       * 開頭日期而不是內文。只掃內文的話這種寫法永遠抓不到。
       * 一樣要有約訪字眼才算，否則「115/10/01 已聯絡」也會被當成約訪。
       */
      // 內文裡寫明的日期優先：開頭那個日期是這則寫下的時間，
      // 內文的「約1/5再談」才是真正約好的那一天。
      const got = scan(entry);
      if (got) return got;
      if (entry.date && entry.date > today && entry.date <= limit
        && FOLLOWUP_HINT.test(toHalfWidth(entry.text || ''))) {
        return {
          iso: entry.date,
          snippet: toHalfWidth(entry.text || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          from: null,
        };
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------
   * 禁止推廣
   *
   * 這是所有標記裡唯一「不能出錯也不能被蓋掉」的一個：客戶明講不要再打了，
   * 再打就是騷擾。
   *
   * 原本它只是 outcome 的七個值之一，而 outcome 會被之後記的通話紀錄覆蓋——
   * 隨便記一通「已聯絡」，禁止推廣就消失，那位客戶會悄悄回到待打名單裡。
   * 所以改成直接從訪談內容判讀，跟 outcome 分開，蓋不掉。
   *
   * 用詞只收明確的拒訪語句。像「黑名單」「拒絕往來」看起來很像，但在金融業的
   * 訪談紀錄裡通常是在講客戶自己的信用狀況（拒絕往來戶），不是叫我們別打，
   * 收進來會製造假的禁打名單。
   * ------------------------------------------------------------------ */

  const BLOCKED_RE = /禁止推廣|禁推|勿再推廣|不得推廣|請勿推銷|不要推銷|不要再(?:打|撥|來電|聯絡)|別再(?:撥打|打|來電|聯絡)|勿再(?:撥打|來電|聯絡)|打死不想/;

  /**
   * @returns {{blocked:boolean, phrase:string, snippet:string}}
   */
  function detectBlocked(notesRaw) {
    const text = toHalfWidth(notesRaw || '');
    if (!text.trim()) return { blocked: false, phrase: '', snippet: '' };
    for (const line of text.split(/\n+/)) {
      const m = line.match(BLOCKED_RE);
      if (m) {
        return { blocked: true, phrase: m[0], snippet: line.replace(/\s+/g, ' ').trim().slice(0, 80) };
      }
    }
    return { blocked: false, phrase: '', snippet: '' };
  }

  /** 這筆客戶有哪幾類往來，給篩選用。 */
  function relationKinds(relations) {
    return ['internal', 'peer', 'bank'].filter((k) => relations[k] && relations[k].length);
  }

  /** 穩定的 ID：重新匯入同一份 PDF 時，通話紀錄才不會跟著跑掉。 */
  function makeId(source, company, taxId) {
    const base = `${source}|${squash(company)}|${squash(taxId)}`;
    let h = 5381;
    for (let i = 0; i < base.length; i++) h = ((h * 33) ^ base.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  /**
   * @param {string[][]} rows  PdfTable 解析出來的原始列
   * @param {string} source    名單來源（用檔名）
   * @param {{pageStarts?:number[]}} [options]  每一頁從第幾列開始
   */
  function toRecords(rows, source, options) {
    const header = detectHeader(rows);
    if (!header) return { records: [], header: null, skipped: rows.length };

    const map = { ...header.map };
    const offset = header.index + 1;
    const body = rows.slice(offset);

    // 先做整體平移校正：少偵測到一條直線就會整份錯位，連「哪一格是公司名稱」
    // 都會跟著錯，所以要在合併跨頁殘列之前就修好。
    const { shift } = detectShift(body, map);
    if (shift) Object.keys(map).forEach((k) => { map[k] += shift; });
    const ignored = (header.ignored || []).map((c) => c + shift);

    const merged = mergeContinuations(
      body,
      map,
      ((options && options.pageStarts) || []).map((n) => n - offset).filter((n) => n > 0)
    );

    const records = [];
    const skipped = merged.dropped;
    let repaired = 0;

    for (const row of merged.rows) {
      const field = resolveRow(row, map, ignored);
      const company = field.company || '';
      const phoneRaw = field.phone || '';
      if (!company && !phoneRaw) continue;

      // 有欄位是靠內容救回來的就記一筆，匯入完提醒使用者抽查
      for (const [name] of FIELD_RULES) {
        const idx = map[name];
        if (idx === undefined || field[name] === undefined) continue;
        if (!validate(name, row[idx])) { repaired++; break; }
      }

      const names = splitCompanyNames(company);
      const split = splitAddress((field.address || '').replace(/\n/g, ' ').trim());
      const address = split.registered;
      const addressActual = (field.addressActual || '').replace(/\n/g, ' ').trim() || split.actual;
      const notesRaw = field.notes || '';
      const record = {
        id: makeId(source, company, field.taxId || ''),
        source,
        company: names[0] || company.replace(/\n/g, ''),
        aliases: names.slice(1),
        taxId: field.taxId || '',
        grade: field.grade || '',
        founded: field.founded || '',
        capital: field.capital || '',
        phoneRaw,
        phones: extractPhones(phoneRaw),
        owner: (field.owner || '').replace(/\n/g, ' ').trim(),
        keyman: (field.keyman || '').replace(/\n/g, ' ').trim(),
        industry: (field.industry || '').replace(/\n/g, '／').trim(),
        nextDate: field.nextDate || null,
        lastDate: field.lastDate || null,
        addedDate: field.addedDate || null,
        country: field.country || '',
        address,
        addressActual,
        notesRaw,
      };
      // 縣市、行政區看實際地址：業務要去的是公司實際在的地方
      Object.assign(record, parseAddressAny(addressActual, address));
      record.timeline = parseNotes(notesRaw);
      record.outcome = guessOutcome(notesRaw);
      records.push(record);
    }
    return { records, header, skipped, shift, repaired };
  }

  /**
   * 最小可用的分隔文字解析，支援引號內的分隔符號與換行。
   * 逗號用於 CSV，Tab 用於從 Excel／Google 試算表直接複製貼上。
   */
  function parseDelimited(text, delimiter) {
    const delim = delimiter || ',';
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += ch;
        continue;
      }
      if (ch === '"') { quoted = true; continue; }
      if (ch === delim) { row.push(field); field = ''; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => c && c.trim()));
  }

  const parseCsv = (text) => parseDelimited(text, ',');

  /** 引號外的 Tab 比逗號多就當成 Excel 貼上的內容。 */
  function detectDelimiter(text) {
    let quoted = false;
    let tabs = 0;
    let commas = 0;
    const src = String(text);
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (ch === '\t') tabs++;
      else if (ch === ',') commas++;
    }
    return tabs >= commas && tabs > 0 ? '\t' : ',';
  }

  /** 名單的標準欄位順序，貼上的內容沒有標題列時用這個補。 */
  const STANDARD_HEADER = ['公司名稱', '統編', '分級', '成立', '資本額', '電話', '負責人',
    'KEYMAN', '產業別', '下次聯絡日', '最近聯絡日', '訪談內容', '地址', '名單新增日期', '國家'];

  /**
   * 解析使用者從試算表複製貼上的內容。自動判斷分隔符號；
   * 沒有標題列時補上標準欄位順序，再交給內容驗證去修正錯位。
   */
  function parsePasted(text, source) {
    const delimiter = detectDelimiter(text);
    let rows = parseDelimited(text, delimiter);
    if (!rows.length) return { records: [], synthesized: false, delimiter, rows: [] };

    let synthesized = false;
    if (!detectHeader(rows)) {
      const width = Math.max(...rows.map((r) => r.length));
      const header = STANDARD_HEADER.slice(0, width);
      while (header.length < width) header.push('');
      rows = [header].concat(rows);
      synthesized = true;
    }
    const out = toRecords(rows, source, { pageStarts: [0] });
    return { ...out, synthesized, delimiter, rows };
  }

  /* ------------------------------------------------------------------
   * 「欄位／值」格式的公司資料（商工登記查詢頁、g0v 公司資料複製下來就是這樣）：
   *
   *   統一編號        28443147
   *   公司名稱        三貝德數位文創股份有限公司
   *   資本總額(元)    1,100,000,000
   *   代表人姓名      余明珊
   *   公司所在地      新北市三重區重新路5段609巷2號5樓
   *   核准設立日期    2006年10月30日
   *
   * 每行一個欄位，欄位名跟值之間是 Tab、全形／半形冒號或兩個以上空白。
   * 認得的欄位對到名單的標準欄位；資本額從「元」換成網站慣用的「仟元」。
   * 回傳 null 代表看起來不是這種格式（認得的欄位不到兩個）。
   * ------------------------------------------------------------------ */
  const KV_FIELDS = [
    ['taxId', /^(統一編號|統編)$/],
    ['company', /^(公司名稱|商業名稱|名稱|公司名)$/],
    ['capitalTotal', /^資本總額/],
    ['capitalPaid', /^實收資本額/],
    ['capitalPlain', /^資本額/],
    ['owner', /^(代表人姓名|代表人|負責人姓名|負責人)$/],
    ['address', /^(公司所在地|商業所在地|地址|登記地址|營業地址)$/],
    ['founded', /^(核准設立日期|設立日期|成立日期|核准設立)$/],
    ['changed', /^(最後核准變更日期|最近核准變更日期|最後變更日期)$/],
    ['phone', /^(電話|聯絡電話|公司電話)$/],
    ['industry', /^(產業別|營業項目|行業)$/],
  ];
  function parseKeyValue(text) {
    const lines = toHalfWidth(String(text || '')).split(/\r?\n/);
    const got = {};
    lines.forEach((line) => {
      const m = line.match(/^\s*([^\t:：]{2,12}?)\s*(?:\t+|[:：]|\s{2,})\s*(.+?)\s*$/);
      if (!m) return;
      const key = m[1].trim();
      const value = m[2].trim();
      if (!value || value === '值') return;
      for (const [field, re] of KV_FIELDS) {
        if (re.test(key) && got[field] === undefined) { got[field] = value; break; }
      }
    });
    const known = Object.keys(got).length;
    if (known < 2) return null;

    const out = {};
    if (got.company) out.company = got.company;
    if (got.taxId && /^\d{8}$/.test(got.taxId.replace(/\D/g, ''))) out.taxId = got.taxId.replace(/\D/g, '');
    if (got.owner) out.owner = got.owner;
    if (got.address) out.address = got.address;
    if (got.phone) out.phoneRaw = got.phone;
    if (got.industry) out.industry = got.industry;
    /*
     * 資本額：名單上的「資本總額」用來分微企／一般組／大企部，實收資本額另外存一格。
     * 登記資料是「元」，網站用「仟元」。資本總額沒有就拿實收頂著（分級總比空白好）。
     */
    const toThousands = (raw) => {
      const n = Number(String(raw || '').replace(/[^\d.]/g, ''));
      if (!raw || !(n > 0)) return '';
      const isYuan = /元/.test(raw) || n >= 1000000;
      return Math.round(isYuan ? n / 1000 : n).toLocaleString('en-US');
    };
    const total = toThousands(got.capitalTotal || got.capitalPlain || '');
    const paid = toThousands(got.capitalPaid || '');
    if (total || paid) out.capital = total || paid;
    if (paid) out.capitalPaid = paid;
    if (got.founded) {
      const y = got.founded.match(/(\d{4})\s*年?/);
      const roc = got.founded.match(/^(\d{2,3})[\/年]/);
      if (y) out.founded = y[1];
      else if (roc) out.founded = String(+roc[1] + 1911);
    }
    // 最後核准變更日期：登記頁寫民國（114年07月16日），存成跟其他日期一樣的西元格式
    if (got.changed) {
      const roc = got.changed.match(/^(\d{2,3})[\/年-](\d{1,2})[\/月-](\d{1,2})/);
      const ad = got.changed.match(/^(\d{4})[\/年-](\d{1,2})[\/月-](\d{1,2})/);
      const pad = (v) => String(v).padStart(2, '0');
      if (ad) out.regChanged = `${ad[1]}/${pad(ad[2])}/${pad(ad[3])}`;
      else if (roc) out.regChanged = `${+roc[1] + 1911}/${pad(roc[2])}/${pad(roc[3])}`;
    }
    return out;
  }

  /* ------------------------------------------------------------------
   * 有沒有實際拜訪過
   *
   * 業務要分「打過電話」跟「人真的到過公司」。訪談內容裡拜訪的寫法很固定：
   * 「跟陳老闆拜訪」「拜訪薛老闆」「現場拜訪」「到現場才知道」「12/10拜訪蔡總」。
   * 要小心的是兩種假陽性：
   *   - 還沒發生的：「約下週拜訪」「明日拜訪時間」「讓我去拜訪」「歡迎拜訪」。
   *   - 別人去的：「大企部的同仁昨天才去拜訪」「之前有同仁過去拜訪過」「沒人去拜訪過」。
   * 所以命中的那一段本身不能有「約、再、明天」這類字，前面十幾個字也不能是
   * 同仁、學長、中租這些別人；「拜訪過他」是別人拜訪他，也不算。
   * ------------------------------------------------------------------ */
  const VISIT_RES = [
    // 跟陳老闆拜訪、跟古先生(Jonny)拜訪、帶協理去跟財務長拜訪
    /跟[^，。,；;\n]{1,14}?(?:去)?拜訪/g,
    // 句首（或日期、括號之後）的「拜訪薛老闆」「拜訪游青山」「拜訪，主要是賣設備」
    /(?:^|[\s，。,；;\d)）])拜訪(?=[，,。]|[\u4e00-\u9fa5A-Za-z(（]{1,8}(?:[，,。(（\s]|$))/g,
    // 「小老闆拜訪，」「財務長(嚴)拜訪，」：人物接著拜訪再接標點
    /(?:老闆|總|董|經理|小姐|先生|財務長|協理|副總|會計|[)）])\s*拜訪(?=[，,。]|$)/g,
    /(?:現場|實地|親自|登門)拜訪|到現場|現場留|拜訪過(?!他|她|你)|已拜訪|已經拜訪/g,
  ];
  // 命中那一段裡有這些字就是還沒發生（約拜訪、再拜訪、明日拜訪時間）
  const VISIT_FUTURE_RE = /約|再|明天|明日|下周|下週|下次|時間|要|想|可以|能|先|歡迎|方便|結束/;
  // 命中前面幾個字是這些就是別人去的、或被拒絕的
  const VISIT_OTHERS_RE = /同仁|學長|學姊|業務|主管|部的|中租|有人|沒人|其他|別的|他們|親自|哥|讓我|不給|沒空|歡迎|不用|之前有|曾有|拒絕|不讓|城東|城北|大企|微企|融專/;
  // 命中前面緊接著的幾個字若是這些，也是還沒發生（明天拜訪結束後、約周五拜訪）
  const VISIT_PLAN_BEFORE_RE = /約|明天|明日|下周|下週|下禮拜|再|先|想|要|會|可以/;
  function detectVisit(notesRaw) {
    const entries = parseNotes(notesRaw);
    for (const entry of entries) {
      const text = toHalfWidth(entry.text || '');
      for (const re of VISIT_RES) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          const hit = m[0];
          if (VISIT_FUTURE_RE.test(hit)) continue;
          const before = text.slice(Math.max(0, m.index - 14), m.index);
          if (VISIT_OTHERS_RE.test(before)) continue;
          if (VISIT_PLAN_BEFORE_RE.test(text.slice(Math.max(0, m.index - 6), m.index))) continue;
          return {
            visited: true, date: entry.date || null,
            snippet: text.slice(Math.max(0, m.index - 12), m.index + hit.length + 20).replace(/\s+/g, ' ').trim(),
          };
        }
      }
    }
    return { visited: false, date: null, snippet: '' };
  }
  const VISIT_LABEL = { yes: '有拜訪', no: '無拜訪' };

  /* ------------------------------------------------------------------
   * 從訪談內容判讀 KEYMAN
   *
   * 業務打電話會記「總機轉楊小姐」「黃副總說要看資料」「KEYMAN 是陳經理」。
   * 規則：
   *   - 明講的最準：「KEYMAN 是 X」「X 是 KEYMAN」「窗口 X」。
   *   - 沒明講就看稱謂：姓＋職稱（老闆、總經理、財務、會計、經理、小姐…），
   *     職稱越接近決策者權重越高，同權重取最新一則。
   *   - 否定句要吃掉：「楊小姐接電話，他應該不是 KEYMAN」→ 楊小姐不算。
   *   - 總機、櫃台不是人名，永遠不算。
   * 姓氏用常見姓氏表過濾，才不會把「給我楊小姐」抓成「給我楊」。
   * ------------------------------------------------------------------ */
  const SURNAMES = '陳林黃張李王吳劉蔡楊許鄭謝郭洪邱曾廖賴徐周葉蘇莊呂江何蕭羅高潘簡朱鍾游彭詹胡施沈余盧梁趙顏柯翁魏孫戴范方宋鄧杜傅侯曹薛丁卓阮馬董溫唐藍蔣石古紀姚連馮歐程湯田康姜白汪鄒尤巫鐘黎塗龔嚴韓袁金童陸夏柳凃邵錢伍倪包萬段辛梅樊史顧孟龍俞秦谷符寧鄔葛穆龐甘岳霍申裴牛喬曲祝吉井房殷莫費岑竇滕尹辜官蒲成易毛于文陶章鄧桂焦樂卜芮利刁佘駱練喻管褚汲宗閻羊巴甯鄺左關璩藍游';
  const COMPOUND_SURNAMES = ['歐陽', '司徒', '上官', '諸葛', '張簡', '范姜', '司馬', '公孫', '端木', '夏侯', '皇甫', '尉遲', '長孫'];
  const KEY_TITLES = [
    ['董事長', 5], ['老闆娘', 5], ['老闆', 5], ['總經理', 5], ['執行長', 5], ['負責人', 5], ['總裁', 5],
    ['財務長', 4], ['財務', 4], ['會計', 4], ['特助', 4], ['副總', 4], ['協理', 4], ['財會', 4],
    ['經理', 3], ['處長', 3], ['廠長', 3], ['主任', 3], ['課長', 3], ['襄理', 3], ['組長', 3], ['店長', 3], ['總監', 3], ['採購', 3],
    ['秘書', 2], ['助理', 2], ['小姐', 1], ['先生', 1],
  ];
  const TITLE_RE = new RegExp(`([\\u4e00-\\u9fff]{1,3})(${KEY_TITLES.map(([t]) => t).join('|')})`, 'g');
  const TITLE_WEIGHT = Object.fromEntries(KEY_TITLES);
  const TITLE_TAIL_RE = new RegExp(`(${KEY_TITLES.map(([t]) => t).join('|')})$`);
  const TITLE_HEAD_RE = new RegExp(`^(${KEY_TITLES.map(([t]) => t).join('|')})`);
  const NOT_PERSON_RE = /總機|櫃台|櫃檯|客服|警衛|門市|公司|本公司|中租|老闆娘說|沒有/;
  const NEG_RE = /不是\s*(KEYMAN|keyman|窗口|決策|負責的)|非\s*KEYMAN|沒有決定權|不能決定|作不了主|做不了主|只是(總機|助理|櫃台)|不負責|已離職|離職/i;

  const TITLE_ALT = KEY_TITLES.map(([t]) => t).join('|');
  // 名字寫法：「姓＋職稱」或 2～3 字全名。職稱那段用懶惰量詞，姓先短後長，職稱才接得上
  const NAME_TOKEN = `([\\u4e00-\\u9fff]{1,3}?(?:${TITLE_ALT})|[\\u4e00-\\u9fff]{2,3})`;
  const LINK = '(?:是|為|就是|改成|換成|改為|變成|叫|[:：])?\\s*';
  const EXPLICIT_RES = [
    new RegExp(`KEYMAN\\s*${LINK}${NAME_TOKEN}`, 'i'),
    new RegExp(`${NAME_TOKEN}\\s*(?:是|為|就是)\\s*KEYMAN`, 'i'),
    new RegExp(`窗口\\s*${LINK}${NAME_TOKEN}`),
  ];
  /** 明講抓到的字串整理成人名：「給我楊小姐」→「楊小姐」；「改成」這種不是名字的丟掉。 */
  function validName(token) {
    const t = String(token || '');
    const m = t.match(new RegExp(`^([\\u4e00-\\u9fff]{1,3}?)(${TITLE_ALT})$`));
    if (m) {
      if (TITLE_TAIL_RE.test(m[1])) return '';   // 「楊副總秘書」是身分描述，不是名字
      const s = trimToName(m[1]);
      return s && !NOT_PERSON_RE.test(s + m[2]) ? s + m[2] : '';
    }
    if (t.length >= 2 && t.length <= 3 && trimToName(t) === t && !NOT_PERSON_RE.test(t)) return t;
    return '';
  }

  /** 「給我楊」→「楊」；「陳美玲」→「陳美玲」：取最長、且開頭是姓氏的尾段。 */
  function trimToName(prefix) {
    for (let len = prefix.length; len >= 1; len--) {
      const cand = prefix.slice(prefix.length - len);
      if (COMPOUND_SURNAMES.some((c) => cand.startsWith(c))) return cand;
      if (len <= 3 && SURNAMES.includes(cand[0]) && !/[給跟找說請由是和與的了他她我向對轉接到把讓叫問幫聯絡為在]/.test(cand[0])) {
        // 兩字以上時第二個字不能是動詞／助詞，否則「找林」會變成「找林」
        if (len === 1 || !/[給跟找說請由是和與的了他她我向對轉接到把讓叫問幫為在]/.test(cand[1])) return cand;
      }
    }
    return '';
  }

  /**
   * @returns {{name:string, reason:string, snippet:string}} name 為空代表判讀不出
   */
  function detectKeyman(notesRaw) {
    const entries = parseNotes(notesRaw);
    // 新的在前：有日期的照日期由新到舊，沒日期的（背景資料）排最後
    const ordered = entries.map((e, i) => ({ ...e, i }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.i - b.i);
    const negated = new Set();
    const candidates = [];
    ordered.forEach((entry, order) => {
      const text = toHalfWidth(entry.text || '');
      const clauses = text.split(/[，。；;\n]/);
      // 明講的：先試「姓＋職稱」（懶惰量詞，才不會把「李總經」當名字），再試 2～3 字全名
      let explicit = null;
      for (const re of EXPLICIT_RES) {
        re.lastIndex = 0;
        const m = re.exec(text);
        if (m) { explicit = m; break; }
      }
      if (explicit) {
        // 「KEYMAN 是楊副總秘書」：名字後面緊接著另一個職稱，整段是身分描述
        const after = text.slice(explicit.index + explicit[0].length);
        const name = TITLE_HEAD_RE.test(after) ? '' : validName(explicit[1]);
        const around = text.slice(Math.max(0, explicit.index - 10), explicit.index + explicit[0].length + 10);
        if (name && !NEG_RE.test(around)) candidates.push({ name, weight: 9, order, snippet: around.trim() });
      }
      // 稱謂
      clauses.forEach((clause, ci) => {
        TITLE_RE.lastIndex = 0;
        let m;
        while ((m = TITLE_RE.exec(clause)) !== null) {
          // 「謝小姐(楊副總秘書)」：稱謂前面已經是另一個職稱，或後面緊接著另一個職稱
          //（「是楊副總秘書」會先對到「楊副總」），那是在描述身分，不是名字
          if (TITLE_TAIL_RE.test(m[1]) || TITLE_HEAD_RE.test(clause.slice(m.index + m[0].length))) continue;
          const surname = trimToName(m[1]);
          if (!surname) continue;
          const name = surname + m[2];
          if (NOT_PERSON_RE.test(name)) continue;
          const here = clause + '，' + (clauses[ci + 1] || '');
          if (NEG_RE.test(here)) { negated.add(name); continue; }
          candidates.push({ name, weight: TITLE_WEIGHT[m[2]] || 1, order, snippet: clause.trim().slice(0, 60) });
        }
      });
    });
    const live = candidates.filter((c) => !negated.has(c.name));
    if (!live.length) return { name: '', reason: negated.size ? `訪談提到 ${[...negated].join('、')}，但寫明不是 KEYMAN` : '訪談內容看不出 KEYMAN', snippet: '' };
    live.sort((a, b) => b.weight - a.weight || a.order - b.order);
    const best = live[0];
    return { name: best.name, reason: best.weight >= 9 ? '訪談明講' : '依訪談稱謂判讀', snippet: best.snippet };
  }

  /*
   * 一家公司的識別鍵，用來記「這家被刪掉過」。
   *
   * 客戶的 id 是「檔名＋公司名＋統編」算出來的，所以同一家公司在不同名單裡是
   * 不同的 id。用 id 記刪除，下次匯入別份名單時完全對不上——使用者刪掉的公司
   * 又整批回來了，這就是他實際遇到的狀況。
   *
   * 改成記公司本身：有統編記統編，另外再記一次公司名稱（去掉空白）。
   * 兩個都記是因為同一家公司可能這份名單有統編、那份沒有，只記一種就漏掉。
   * 比對時只要中一個就算同一家，跟 sameCompany 的判斷一致。
   */
  function companyKeys(rec) {
    const keys = [];
    const tax = String((rec && rec.taxId) || '').replace(/\D/g, '');
    if (tax) keys.push(`tax:${tax}`);
    const name = String((rec && rec.company) || '').replace(/\s/g, '');
    if (name) keys.push(`name:${name}`);
    return keys;
  }

  global.Normalize = {
    companyKeys,
    detectVisit, VISIT_LABEL, detectKeyman,
    parseKeyValue,
    toRecords, detectHeader, parseDate, extractPhones, phoneRows, serializePhones, parseNotes, splitCompanyNames,
    parseCsv, parseDelimited, detectDelimiter, parsePasted, STANDARD_HEADER,
    validate, resolveRow, detectShift, VALIDATORS,
    detectRelations, relationKinds, RELATION_LABEL,
    detectDealing, latestNote, DEALING_LABEL,
    detectBlocked,
    suspiciousName, splitGluedName,
    isGovRegistry, fromGovRegistry, govToStandardRows, guessIndustry,
    capitalLooksLikeYuan, convertCapitalToThousands,
    findFollowUp,
    looksLikeAddress,
    validateAddress: (t) => VALIDATORS.address(t) || '',
    INTERNAL_UNITS, PEER_UNITS, BANKS,
    parseAddress, parseAddressAny, splitAddress, guessOutcome, OUTCOME_LABEL, normalizeOutcome, outcomeLabel, makeId, toHalfWidth,
  };
})(window);
