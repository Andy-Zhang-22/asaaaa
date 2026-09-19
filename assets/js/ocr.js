/*
 * ocr.js — 在瀏覽器裡讀 104 公司頁的截圖。
 *
 * 業務找名單的流程是：在 104 看到正在徵才的公司，截圖存下來。之前要一格一格
 * 抄進名單，統編、負責人還得另外查。這裡把截圖丟進來就好：
 *   1. tesseract.js（繁中模型）在本機辨識文字，截圖不會上傳到任何地方。
 *   2. parse104() 依 104 App 公司頁的固定版面把欄位挑出來。
 *   3. 後面再用商工登記（registry.js）補統編、負責人、登記資本額、成立日、登記地址。
 *
 * 只認「公司簡介」頁。職缺頁上的電話是聯絡窗口的分機，使用者要的是公司頁那支，
 * 公司頁寫「暫不提供」就留空，不拿職缺頁的湊。
 */
(function (global) {
  'use strict';

  const VENDOR = 'assets/vendor/tesseract';
  let workerPromise = null;

  function getWorker(onProgress) {
    if (!global.Tesseract) return Promise.reject(new Error('OCR 元件沒有載入'));
    if (!workerPromise) {
      workerPromise = global.Tesseract.createWorker('chi_tra', 1, {
        workerPath: `${VENDOR}/worker.min.js`,
        corePath: `${VENDOR}/`,
        langPath: `${VENDOR}/lang`,
        gzip: false,
        // 模型存進 IndexedDB：手機每次開網站都重抓 2.3 MB 太浪費
        cacheMethod: 'write',
        logger: (m) => { if (onProgress) onProgress(m); },
      }).then(async (w) => {
        await w.setParameters({ preserve_interword_spaces: '1' });
        return w;
      }).catch((err) => { workerPromise = null; throw err; });
    }
    return workerPromise;
  }

  async function imageSize(file) {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }

  /**
   * 辨識一張截圖，回傳整頁文字。
   *
   * 資本額那一行旁邊常有公司 Logo，整頁辨識時偶爾會把那行吃掉；
   * 沒讀到就再掃一次頁面上方（公司名稱到地址那一塊），把它補回來。
   */
  async function recognize(file, onProgress) {
    const worker = await getWorker(onProgress);
    const { data } = await worker.recognize(file);
    let text = data.text || '';
    if (!/資本額/.test(text)) {
      try {
        const { width, height } = await imageSize(file);
        // 只掃左邊 83%：公司 Logo 在右側，一起掃進去反而會把那行吃掉
        const top = await worker.recognize(file, {
          rectangle: { top: Math.round(height * 0.08), left: 0, width: Math.round(width * 0.83), height: Math.round(height * 0.24) },
        });
        text = `${top.data.text || ''}\n${text}`;
      } catch (err) { /* 補掃失敗就用整頁的結果 */ }
    }
    return text;
  }

  /** 只辨識、回傳文字（給 401 申報書這種掃描 PDF 用；source 可以是 File、Blob 或 canvas）。 */
  async function recognizeText(source, onProgress, params) {
    const worker = await getWorker(onProgress);
    // 例如表格型的申報書用 tessedit_pageseg_mode '11'（散落文字）比較抓得到數字；用完還原
    if (params) await worker.setParameters(params);
    try {
      const { data } = await worker.recognize(source);
      return data.text || '';
    } finally {
      if (params) await worker.setParameters(Object.fromEntries(Object.keys(params).map((k) => [k, k === 'tessedit_pageseg_mode' ? '3' : ''])));
    }
  }

  /* ------------------------------------------------------------------
   * 解析 104 公司頁文字
   * ------------------------------------------------------------------ */
  const CITY_RE = /((?:臺|台)北市|新北市|桃園市|基隆市|新竹市|新竹縣|宜蘭縣|(?:臺|台)中市|彰化縣|南投縣|雲林縣|嘉義市|嘉義縣|(?:臺|台)南市|高雄市|屏東縣|花蓮縣|(?:臺|台)東縣|苗栗縣|澎湖縣|金門縣|連江縣)/;
  const COMPANY_RE = /(股份有限公司|有限公司|企業社|工作室|事務所|商行|商號|工程行|企業行|實業社|診所|工廠)\s*$/;
  const JOB_HINT_RE = /工作內容|職務類別|應徵|薪資|上班時段|工作待遇|休假制度|工作性質/;

  const clean = (s) => String(s || '').replace(/[|｜]/g, '|').replace(/\s+/g, ' ').trim();
  const cjkStart = (s) => s.replace(/^[^一-龥A-Za-z0-9]+/, '');

  function capitalToThousands(num, unit) {
    const n = Number(String(num).replace(/,/g, ''));
    if (!n) return '';
    const yuan = unit === '億' ? n * 100000000 : unit === '萬' ? n * 10000 : n;
    return Math.round(yuan / 1000).toLocaleString('en-US');
  }

  function nextLine(lines, labelRe) {
    const i = lines.findIndex((l) => labelRe.test(l));
    if (i < 0) return '';
    for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
      const v = clean(lines[j]);
      if (v) return v;
    }
    return '';
  }

  function parsePhone(raw) {
    const s = clean(raw);
    if (!s || /暫不提供|未提供|不提供/.test(s)) return '';
    const m = s.match(/(0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{3,4}|09\d{2}[-\s]?\d{3}[-\s]?\d{3})/);
    if (!m) return '';
    const ext = s.match(/(?:分機|轉|#)\s*[:：]?\s*(\d{1,5})/);
    return `${m[1].replace(/\s+/g, '')}${ext ? `分機${ext[1]}` : ''}`;
  }

  function parse104(text) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const out = {
      kind: 'unknown', company: '', industry: '', desc: '', capital: '', capitalRaw: '', employees: '',
      address: '', contact: '', phone: '', phoneRaw: '', website: '', founded: '', jobs: '', intro: '',
    };
    const nameAt = lines.findIndex((l) => COMPANY_RE.test(cjkStart(clean(l))) && cjkStart(clean(l)).length >= 4);
    if (nameAt >= 0) out.company = cjkStart(clean(lines[nameAt])).replace(/\s+/g, '');

    const capLine = lines.find((l) => /資本額/.test(l));
    if (capLine) {
      const m = clean(capLine).match(/資本額\s*[:：]?\s*([\d,.]+)\s*(億|萬)?\s*元?/);
      if (m) { out.capitalRaw = `${m[1]}${m[2] || ''}元`; out.capital = capitalToThousands(m[1], m[2]); }
      const e = clean(capLine).match(/員工數\s*[:：]?\s*(\d+)/);
      if (e) out.employees = e[1];
    }
    if (!out.employees) {
      const e = lines.map(clean).find((l) => /員工數/.test(l));
      const m = e && e.match(/員工數\s*[:：]?\s*(\d+)/);
      if (m) out.employees = m[1];
    }

    // 產業類別在公司名稱下一行；產業描述在標籤下一行
    if (nameAt >= 0 && lines[nameAt + 1] && /業|服務|製造|工程|批發|零售/.test(lines[nameAt + 1]) && !/資本額/.test(lines[nameAt + 1])) {
      // 只留中文與分隔符：右側 Logo 常被辨識成多餘的字
      out.industry = (clean(lines[nameAt + 1]).match(/^[\u4e00-\u9fa5、／/]+/) || [''])[0];
    }
    out.desc = nextLine(lines, /^產業描述/);
    if (out.desc && lines.findIndex((l) => /^產業描述/.test(l)) >= 0) {
      // 產業描述可能折成兩行，下一行若不是新的標籤就接上
      const i = lines.findIndex((l) => /^產業描述/.test(l));
      const more = lines[i + 2];
      if (more && !/^(聯絡人|電話|公司網址|公司簡介|傳真)/.test(more) && more.length <= 12) out.desc += more.trim();
    }

    const addrLine = lines.map(clean).find((l) => CITY_RE.test(l) && /[區鄉鎮市]/.test(l) && /[路街道巷號]/.test(l));
    if (addrLine) {
      const start = addrLine.search(CITY_RE);
      let a = addrLine.slice(start);
      a = a.replace(/[(（][^)）]*(距離|捷運|分鐘)[^)）]*[)）]/g, '');
      // 尾端的「>」「?」是版面上的箭頭被辨識成的符號
      a = a.replace(/[^\u4e00-\u9fa5\d號樓之FＦ室、，,\-～~()（）]+$/, '').trim();
      out.address = a;
    }

    out.contact = cjkStart(nextLine(lines, /^聯絡人/));
    out.phoneRaw = nextLine(lines, /^電話/);
    out.phone = parsePhone(out.phoneRaw);
    const site = nextLine(lines, /^公司網址/);
    if (/^(https?:\/\/|www\.)/i.test(site) || /\.(com|tw|net|org)/i.test(site)) out.website = site.replace(/\s+/g, '');

    const f = String(text).match(/成立(?:時間|於|日期)?\s*[:：]?\s*(\d{4})\s*年/) || String(text).match(/(\d{4})\s*年\s*成立/);
    if (f) out.founded = f[1];
    const jobs = String(text).match(/查看工作機會\s*[（(]\s*(\d+)\s*[）)]/);
    if (jobs) out.jobs = jobs[1];

    // 公司簡介：標籤之後的幾行，當成訪談內容的背景
    const introAt = lines.findIndex((l, i) => /^公司簡介$/.test(clean(l)) && i > 0);
    if (introAt >= 0) {
      out.intro = lines.slice(introAt + 1, introAt + 6).map(clean)
        .filter((l) => !/^(公司簡介|經營理念|[+十]\s*關注)/.test(l) && !/查看工作機會/.test(l) && /[一-龥]{4,}/.test(l))
        .join('').replace(/[|)]/g, '').replace(/\s+/g, '');
      if (out.intro.length > 120) {
        // 在標點處截斷，不要切在句子中間
        const cut = out.intro.slice(0, 120);
        const at = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('。'), cut.lastIndexOf(','));
        out.intro = at > 40 ? cut.slice(0, at + 1) : cut;
      }
    }

    if (out.company && (out.capital || out.address || /公司簡介/.test(text))) out.kind = 'company';
    if (out.kind !== 'company' && JOB_HINT_RE.test(text)) out.kind = 'job';
    return out;
  }

  /** 把解析結果組成訪談內容（沒有日期，匯入後會是「未撥打」）。 */
  function describe(p) {
    const bits = ['104'];
    const facts = [];
    if (p.capitalRaw) facts.push(`資本額${p.capitalRaw.replace(/元$/, '')}`);
    if (p.employees) facts.push(`員工${p.employees}人`);
    if (facts.length) bits.push(`：${facts.join('、')}。`); else bits.push('：');
    if (p.desc) bits.push(`${p.desc}。`);
    if (p.intro) bits.push(`${p.intro}${/[。！？]$/.test(p.intro) ? '' : '…'}`);
    if (p.website) bits.push(`網址${p.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}。`);
    bits.push(p.phone ? `104公司頁電話${p.phone}。` : '104公司頁電話「暫不提供」。');
    if (p.jobs) bits.push(`招募中（${p.jobs}個職缺）。`);
    return bits.join('');
  }

  global.Ocr = { recognize, parse104, describe, parsePhone, capitalToThousands, recognizeText };
})(window);
