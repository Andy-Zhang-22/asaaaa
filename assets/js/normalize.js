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
    ['address', ['地址']],
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

  /** 找出表頭那一列，回傳 { index, map }；找不到回傳 null。 */
  function detectHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 8); i++) {
      const cells = rows[i].map(squash);
      const map = {};
      let hits = 0;
      cells.forEach((cell, col) => {
        if (!cell) return;
        for (const [field, keys] of FIELD_RULES) {
          if (map[field] !== undefined) continue;
          if (keys.some((k) => cell.toUpperCase().includes(k.toUpperCase()))) {
            map[field] = col;
            hits++;
            return;
          }
        }
      });
      if (hits >= 4 && map.company !== undefined) return { index: i, map };
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

    for (const line of toHalfWidth(raw).split(/\n+/)) {
      const re = /\(?0\d{1,3}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}/g;
      let m;
      let foundInLine = false;
      while ((m = re.exec(line)) !== null) {
        const digits = m[0].replace(/\D/g, '');
        if (digits.length < 8 || digits.length > 11) continue;
        foundInLine = true;
        const tail = line.slice(m.index + m[0].length);
        const ext = extOf(tail) || extOf(line);
        const note = noteOf(tail) || noteOf(line);
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
      const body = text.slice(mark.at + mark.raw.length, end).trim();
      entries.push({ date: parseDate(mark.raw), dateRaw: mark.raw, text: body });
    });
    return entries.filter((e) => e.text || e.date);
  }

  function parseAddress(raw) {
    const text = String(raw || '').replace(/\s+/g, '');
    const city = CITIES.find((c) => text.includes(c)) || '';
    let district = '';
    if (city) {
      const after = text.slice(text.indexOf(city) + city.length);
      district = (after.match(/^[一-龥]{1,3}[區鄉鎮市]/) || [''])[0];
    }
    return { city: city.replace(/^台/, '臺'), district };
  }

  /** 從訪談內容推出一個粗略的洽談狀態，讓業務可以快速篩。 */
  function guessOutcome(notes) {
    const t = squash(notes);
    if (!t) return 'new';
    if (/禁止推廣|禁推|別再撥打|不要再打|打死不想/.test(t)) return 'blocked';
    if (/約訪|拜訪|約時間|約下|約他|點到公司/.test(t)) return 'meeting';
    if (/資金需求|有興趣|有些興趣|想了解|報價|額度需求|請他提供資料/.test(t)) return 'interested';
    if (/拒絕|不需要|用不到|用不上|沒機會|沒有需求|秒拒|不考慮/.test(t)) return 'declined';
    if (/未接|沒接|沒人接|無人接|語音|忙線|晚點再撥|再撥打/.test(t)) return 'noanswer';
    return 'contacted';
  }

  const OUTCOME_LABEL = {
    new: '尚未接觸',
    noanswer: '未接通',
    contacted: '已聯絡',
    interested: '有意願',
    meeting: '已約訪',
    declined: '婉拒',
    blocked: '禁止推廣',
  };

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
  function resolveRow(cells, map) {
    const used = new Set();
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

  // 中租體系內部單位
  const INTERNAL_UNITS = ['大企部', '大企', '微企處', '微企', '融專', '城北',
    '一版組', '設備組', '長租', '中租'];
  // 租賃／分期同業
  const PEER_UNITS = ['台新租賃', '中國租賃', '和潤', '裕融', '合迪', '新鑫', '遠信', '博鈞'];
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

  const BALANCE_RE = /本餘|本金餘/;

  const DEALING_LABEL = {
    active: '有跟其他單位往來',
    none: '沒有跟中租往來',
  };

  /** 取最新一期訪談：有日期的取最晚那筆，全都沒日期就取最後一段。 */
  function latestNote(notesRaw) {
    const entries = parseNotes(notesRaw);
    if (!entries.length) return null;
    const dated = entries.filter((e) => e.date);
    if (dated.length) return dated.reduce((a, b) => (b.date >= a.date ? b : a));
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
    const m = text.match(BALANCE_RE);
    if (!m) return { kind: 'none', date: latest.date || null, snippet: '' };
    const from = Math.max(0, m.index - 20);
    return {
      kind: 'active',
      date: latest.date || null,
      snippet: text.slice(from, m.index + 50).replace(/\s+/g, ' ').trim(),
    };
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

    const merged = mergeContinuations(
      body,
      map,
      ((options && options.pageStarts) || []).map((n) => n - offset).filter((n) => n > 0)
    );

    const records = [];
    const skipped = merged.dropped;
    let repaired = 0;

    for (const row of merged.rows) {
      const field = resolveRow(row, map);
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
      const address = (field.address || '').replace(/\n/g, ' ').trim();
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
        notesRaw,
      };
      Object.assign(record, parseAddress(address));
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

  global.Normalize = {
    toRecords, detectHeader, parseDate, extractPhones, parseNotes, splitCompanyNames,
    parseCsv, parseDelimited, detectDelimiter, parsePasted, STANDARD_HEADER,
    validate, resolveRow, detectShift, VALIDATORS,
    detectRelations, relationKinds, RELATION_LABEL,
    detectDealing, latestNote, DEALING_LABEL,
    findFollowUp,
    looksLikeAddress,
    validateAddress: (t) => VALIDATORS.address(t) || '',
    INTERNAL_UNITS, PEER_UNITS, BANKS,
    parseAddress, guessOutcome, OUTCOME_LABEL, makeId, toHalfWidth,
  };
})(window);
