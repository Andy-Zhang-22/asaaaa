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
    const text = String(raw || '').replace(/\s+/g, '');
    if (!text) return [];
    const names = [];
    let cut = 0;
    let m;
    NAME_SUFFIX.lastIndex = 0;
    while ((m = NAME_SUFFIX.exec(text)) !== null) {
      const end = m.index + m[0].length;
      const name = text.slice(cut, end).trim();
      if (name) names.push(name);
      cut = end;
    }
    const tail = text.slice(cut).trim();
    if (tail) {
      // 「…股份有限公司(3490)」這種尾巴要黏回上一個名字
      if (names.length && /^[(（]/.test(tail)) names[names.length - 1] += tail;
      else names.push(tail);
    }
    return names.length ? names : [text];
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

    const { map } = header;
    const offset = header.index + 1;
    const merged = mergeContinuations(
      rows.slice(offset),
      map,
      ((options && options.pageStarts) || []).map((n) => n - offset).filter((n) => n > 0)
    );
    const cell = (row, field) => (map[field] === undefined ? '' : (row[map[field]] || '').trim());
    const records = [];
    const skipped = merged.dropped;

    for (const row of merged.rows) {
      const company = cell(row, 'company');
      const phoneRaw = cell(row, 'phone');
      if (!company && !phoneRaw) continue;

      const names = splitCompanyNames(company);
      const address = cell(row, 'address').replace(/\n/g, ' ').trim();
      const record = {
        id: makeId(source, company, cell(row, 'taxId')),
        source,
        company: names[0] || company.replace(/\n/g, ''),
        aliases: names.slice(1),
        taxId: squash(cell(row, 'taxId')),
        grade: squash(cell(row, 'grade')).toUpperCase().replace(/[^A-Z?]/g, '') || '',
        founded: squash(cell(row, 'founded')),
        capital: squash(cell(row, 'capital')),
        phoneRaw,
        phones: extractPhones(phoneRaw),
        owner: cell(row, 'owner').replace(/\n/g, ' ').trim(),
        keyman: cell(row, 'keyman').replace(/\n/g, ' ').trim(),
        industry: cell(row, 'industry').replace(/\n/g, '／').trim(),
        nextDate: parseDate(cell(row, 'nextDate')),
        lastDate: parseDate(cell(row, 'lastDate')),
        addedDate: parseDate(cell(row, 'addedDate')),
        country: squash(cell(row, 'country')),
        address,
        notesRaw: cell(row, 'notes'),
      };
      Object.assign(record, parseAddress(address));
      record.timeline = parseNotes(record.notesRaw);
      record.outcome = guessOutcome(record.notesRaw);
      records.push(record);
    }
    return { records, header, skipped };
  }

  /** 最小可用的 CSV 解析（支援引號內的逗號與換行）。 */
  function parseCsv(text) {
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
      if (ch === ',') { row.push(field); field = ''; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => c && c.trim()));
  }

  global.Normalize = {
    toRecords, detectHeader, parseDate, extractPhones, parseNotes, splitCompanyNames, parseCsv,
    parseAddress, guessOutcome, OUTCOME_LABEL, makeId, toHalfWidth,
  };
})(window);
