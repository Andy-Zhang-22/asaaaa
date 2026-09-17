/*
 * 商工登記資料查詢。
 *
 * 為什麼查詢做在瀏覽器裡，而不是後端或排程：
 *
 * 1. 客戶名單只存在使用者的裝置上（IndexedDB）。要在別的地方查，就得先把整份
 *    名單送出去——那是中租的開發名單，不該離開使用者手上。瀏覽器自己查，
 *    送出去的只有一個統編，回來的是公開登記資料。
 * 2. 這個網站沒有後端，是純靜態的 GitHub Pages。
 *
 * 唯一的風險是 CORS：政府的開放資料 API 如果不允許跨網域呼叫，瀏覽器會擋下來。
 * 這件事沒辦法在開發環境驗證（連不上政府網站），所以介面上刻意提供「先試一筆」，
 * 讓使用者十秒內就知道走不走得通，而不是跑到一半才炸掉。
 *
 * 使用者指定的 findbiz.nat.gov.tw 是給人操作的查詢畫面（要 session、可能有驗證碼），
 * 沒辦法程式化存取。這裡接的是同一份資料的正規管道：商工行政資料開放平臺。
 */
(function (global) {
  'use strict';

  /*
   * 商工行政資料開放平臺的資料集。
   *
   * 之前把「不帶查詢條件要一筆也回空的」當成資料集編號錯了，其實這支 API 沒有
   * $filter 就回空白，那個判斷本身是錯的。實測（使用者代理）回的是 Content-Type
   * 為 JSON 的空白，正是「有收到、查無資料」的樣子，所以問題在查詢條件，不在編號。
   *
   * 兩個資料集，各有各的用途：
   *   - 用統編查：236EE382-…（公司登記基本資料，Business_Accounting_NO eq 統編）
   *   - 用名稱查：5F64D864-…（公司登記關鍵字查詢，Company_Name like 名稱 and
   *     Company_Status eq 01——沒帶 Company_Status 就查不到，這是它的規矩）
   * 兩個都可以在介面上改，萬一政府改了編號不用等改版。
   */
  const DEFAULT_BASE = 'https://data.gcis.nat.gov.tw/od/data/api/5F64D864-61CB-4D0D-8AD9-492047CC1EA6';
  const DEFAULT_TAXID_BASE = 'https://data.gcis.nat.gov.tw/od/data/api/236EE382-4942-41A9-BD03-CA0709025E7C';
  const BASE_KEY = 'registry-dataset-url';
  const TAXID_BASE_KEY = 'registry-dataset-taxid-url';

  const getBase = () => {
    try { return localStorage.getItem(BASE_KEY) || DEFAULT_BASE; } catch (e) { return DEFAULT_BASE; }
  };
  const setBase = (url) => {
    try {
      const clean = String(url || '').trim().split('?')[0];   // 貼進來的常常帶著查詢參數
      if (clean) localStorage.setItem(BASE_KEY, clean);
      else localStorage.removeItem(BASE_KEY);
    } catch (e) { /* 無痕模式寫不進去，不影響當次使用 */ }
  };
  const getTaxIdBase = () => {
    try { return localStorage.getItem(TAXID_BASE_KEY) || DEFAULT_TAXID_BASE; } catch (e) { return DEFAULT_TAXID_BASE; }
  };
  const setTaxIdBase = (url) => {
    try {
      const clean = String(url || '').trim().split('?')[0];
      if (clean) localStorage.setItem(TAXID_BASE_KEY, clean);
      else localStorage.removeItem(TAXID_BASE_KEY);
    } catch (e) { /* 同上 */ }
  };

  /*
   * 查詢網址用 OData 的寫法組：$format、$filter、$skip、$top。
   * $ 一律照字面寫，不要編碼成 %24——政府那端怎麼解 %24 沒人保證；
   * 篩選條件的值（公司名稱）才做 URL 編碼。
   */
  const odata = (base, filter, top) =>
    `${base}?$format=json&$filter=${encodeURIComponent(filter)}&$skip=0&$top=${top}`;

  /** 用統編查：先用統編專用的資料集，再拿關鍵字資料集當備援。 */
  const officialByTaxId = (taxId) => {
    const id = String(taxId).replace(/\D/g, '');
    return [
      odata(getTaxIdBase(), `Business_Accounting_NO eq ${id}`, 1),
      odata(getBase(), `Business_Accounting_NO eq ${id} and Company_Status eq 01`, 1),
      odata(getBase(), `Business_Accounting_NO eq ${id}`, 1),
    ];
  };

  /*
   * 用名稱查要多試幾種，因為登記上的寫法跟業務手上的名單常常差一點點。
   *
   * 沒有統編的那批只能靠名稱查，而名稱一字不差才找得到，所以：
   *   - 台／臺 兩種寫法都試（登記一律用「臺」，名單上兩種都有）
   *   - 全形括號、空白先清掉
   *   - like 找不到再試 eq
   */
  function nameVariants(raw) {
    const base = String(raw || '').replace(/\s+/g, '').replace(/[（）]/g, (c) => (c === '（' ? '(' : ')'));
    const out = new Set([base]);
    if (base.includes('台')) out.add(base.replace(/台/g, '臺'));
    if (base.includes('臺')) out.add(base.replace(/臺/g, '台'));
    return [...out].filter(Boolean);
  }

  const officialByName = (name) => {
    const urls = [];
    for (const variant of nameVariants(name)) {
      urls.push(odata(getBase(), `Company_Name like ${variant} and Company_Status eq 01`, 5));
      urls.push(odata(getBase(), `Company_Name like ${variant}`, 5));
    }
    return urls;
  };

  /*
   * 實測官方 API 不送 CORS 標頭，瀏覽器直接擋掉，所以只有官方這一條走不通。
   * 這裡改成依序試三個來源，讓使用者有不必改架構就能用的路：
   *
   *   1. 官方  —— 最正確，但目前被擋。留著是因為政府哪天開放就自動能用。
   *   2. g0v   —— 社群維護的同一份資料鏡像，有開 CORS。送出去的只有統編
   *               （本來就是公開資訊），但畢竟是第三方，所以要使用者自己勾選啟用，
   *               不預設偷偷送出去。
   *   3. 自架代理 —— 使用者自己的 Cloudflare Worker 之類，最可控。
   *               填了網址就會用它去轉打官方 API。
   */
  const PROXY_KEY = 'registry-proxy-url';

  const getProxy = () => {
    try { return localStorage.getItem(PROXY_KEY) || ''; } catch (e) { return ''; }
  };
  const setProxy = (url) => {
    try {
      if (url) localStorage.setItem(PROXY_KEY, url);
      else localStorage.removeItem(PROXY_KEY);
    } catch (e) { /* 無痕模式寫不進去，不影響當次使用 */ }
  };

  const viaProxy = (url) => `${getProxy().replace(/\/$/, '')}?url=${encodeURIComponent(url)}`;
  /** 代理網址裡包的那個政府網址；不是代理就原樣回。給使用者在新分頁自己打開看。 */
  const upstreamOf = (url) => {
    // 只解碼一層：searchParams.get 會把裡面的 %20 也還原成空白，網址就不再是原樣
    const m = String(url).match(/[?&]url=([^&]+)/);
    if (!m) return url;
    try {
      const inner = decodeURIComponent(m[1]);
      return /^https:\/\/data\.gcis\.nat\.gov\.tw\//.test(inner) ? inner : url;
    } catch (e) { return url; }
  };

  const SOURCES = {
    official: {
      label: '商工行政資料開放平臺（官方）',
      byTaxId: officialByTaxId,
      byName: officialByName,
    },
    g0v: {
      label: 'g0v 公司登記資料（社群鏡像）',
      byTaxId: (taxId) => [`https://company.g0v.tw/api/show/${encodeURIComponent(taxId)}`],
      byName: (name) => [`https://company.g0v.tw/api/search?q=${encodeURIComponent(name)}`],
    },
    proxy: {
      label: '自架代理',
      byTaxId: (taxId) => officialByTaxId(taxId).map(viaProxy),
      byName: (name) => officialByName(name).map(viaProxy),
    },
  };

  /** g0v 用中文欄位名，而且資料包在 data 底下，跟官方的結構不一樣。 */
  function unwrap(json) {
    if (Array.isArray(json)) return json;
    if (!json || typeof json !== 'object') return [];
    if (json.data && typeof json.data === 'object') {
      return Array.isArray(json.data) ? json.data : [json.data];
    }
    if (json.company && typeof json.company === 'object') return [json.company];
    return [];
  }

  /*
   * 欄位名稱用「候選清單」而不是寫死一個。
   *
   * 我沒辦法從開發環境實際打這支 API，所以不確定欄位到底叫什麼。與其賭一個名字、
   * 猜錯就整個功能靜悄悄地回傳空值，不如列出已知的幾種拼法依序試，並且在介面上
   * 把原始回應秀出來——猜錯的時候看得見，也才改得掉。
   */
  const FIELD_CANDIDATES = {
    taxId: ['Business_Accounting_NO', 'BAN', 'Business_Accounting_No', '統一編號'],
    name: ['Company_Name', 'Business_Name', 'Company_Name_Chinese', '公司名稱', '商業名稱'],
    status: ['Company_Status_Desc', 'Company_Status', 'Business_Status_Desc', '公司狀況', '狀態'],
    owner: ['Responsible_Name', 'Company_Responsible_Name', 'Business_Responsible_Name',
      '代表人姓名', '負責人姓名', '負責人'],
    address: ['Company_Location', 'Business_Address', 'Company_Address', 'Business_Location',
      '公司所在地', '地址', '營業所在地'],
    capital: ['Capital_Stock_Amount', 'Capital_Total_Amount', 'Capital_Amount',
      '資本總額(元)', '資本總額', '資本額'],
    paidIn: ['Paid_In_Capital_Amount', 'Paid_In_Capital_Total_Amount', '實收資本額(元)', '實收資本額'],
    setupDate: ['Company_Setup_Date', 'Business_Setup_Date', 'Setup_Date', '核准設立日期', '設立日期'],
  };

  const pick = (obj, keys) => {
    for (const k of keys) {
      if (obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') {
        return String(obj[k]).trim();
      }
    }
    return '';
  };

  /** 登記資料的金額單位是「元」，名單上的資本額是「仟元」，不換算會差一千倍。 */
  function toThousands(raw) {
    const n = Number(String(raw || '').replace(/[^\d]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return '';
    return Math.round(n / 1000).toLocaleString('en-US');
  }

  /** 民國或西元的 yyyymmdd → 顯示用字串。 */
  function tidyDate(raw) {
    const s = String(raw || '').replace(/\D/g, '');
    if (s.length === 8) return `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)}`;
    if (s.length === 7) return `${+s.slice(0, 3) + 1911}/${s.slice(3, 5)}/${s.slice(5, 7)}`;
    return String(raw || '').trim();
  }

  function mapRow(row) {
    if (!row || typeof row !== 'object') return null;
    const capital = pick(row, FIELD_CANDIDATES.capital) || pick(row, FIELD_CANDIDATES.paidIn);
    return {
      taxId: pick(row, FIELD_CANDIDATES.taxId),
      name: pick(row, FIELD_CANDIDATES.name),
      status: pick(row, FIELD_CANDIDATES.status),
      owner: pick(row, FIELD_CANDIDATES.owner),
      address: pick(row, FIELD_CANDIDATES.address),
      capital: toThousands(capital),
      capitalRaw: capital,
      founded: tidyDate(pick(row, FIELD_CANDIDATES.setupDate)),
      unmappedKeys: Object.keys(row).filter((k) => !Object.values(FIELD_CANDIDATES).flat().includes(k)),
    };
  }

  /**
   * 把 fetch 的失敗翻成看得懂的話。
   * 跨網域被擋跟斷網在瀏覽器裡長得一模一樣（都是 TypeError，拿不到細節），
   * 所以這裡不硬要分辨，而是把兩種可能都講出來。
   */
  const BLOCKED_HINT = {
    official: '瀏覽器擋下了這個請求——政府的開放資料 API 不送 CORS 標頭，'
      + '這條路目前走不通，要靠自架代理或鏡像繞過。',
    g0v: '連不上 g0v 鏡像。可能是對方暫時不通，或你的網路擋掉了。',
    proxy: '連不到你的代理，或它沒有回傳 CORS 標頭。三個最常見的原因：'
      + '① 網址填錯或 Worker 還沒部署；'
      + '② 腳本裡的 ORIGIN 跟你現在開的網址不一樣；'
      + '③ 腳本貼上時沒有把原本的 Hello World 內容刪乾淨，Worker 執行出錯。'
      + '按下面的「檢查代理設定」可以分辨是哪一種。',
  };

  /**
   * 把 fetch 的失敗翻成看得懂的話。
   *
   * 一定要分來源講。跨網域被擋跟斷網在瀏覽器裡長得一模一樣（都是 TypeError、
   * 拿不到細節），所以訊息本身就是使用者唯一的線索；如果不管哪個來源都印
   * 「政府的 API 不允許跨網域」，代理設定出錯的人會被導去完全錯誤的方向。
   */
  function explain(err, sourceKey) {
    if (err && err.name === 'AbortError') return '查詢逾時（超過 20 秒沒有回應）。';
    if (err instanceof TypeError) return BLOCKED_HINT[sourceKey] || '瀏覽器擋下了這個請求。';
    return `查詢失敗：${(err && err.message) || err}`;
  }

  /**
   * 檢查代理本身活著沒有，跟查詢分開。
   *
   * 故意不帶 ?url= 打過去：腳本遇到沒有網址的請求會回 400 並帶 CORS 標頭，
   * 所以「收到 400」反而是最好的消息——代表 Worker 活著、腳本正確、CORS 也對，
   * 問題只在查詢本身。連 400 都收不到就代表前面三關有一關沒過。
   */
  async function checkProxy() {
    const base = getProxy();
    if (!base) return { ok: false, stage: 'unset', message: '還沒填代理網址。' };
    let url;
    try {
      url = new URL(base);
      if (!/^https?:$/.test(url.protocol)) throw new Error('protocol');
    } catch (e) {
      return { ok: false, stage: 'url', message: `「${base}」不是合法的網址，要像 https://xxx.workers.dev 這樣。` };
    }
    try {
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
      const body = (await res.text()).slice(0, 300);
      if (res.status === 400 && body.includes('data.gcis.nat.gov.tw')) {
        return { ok: true, stage: 'alive', status: res.status, body,
          message: '代理活著，腳本與 CORS 都正確。' };
      }
      return { ok: false, stage: 'wrong-script', status: res.status, body,
        message: `代理有回應（HTTP ${res.status}），但回的內容不是預期的白名單訊息。`
          + '最可能是腳本沒貼對，或原本的 Hello World 內容沒刪乾淨。' };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { ok: false, stage: 'timeout', message: '代理 15 秒內沒有回應。' };
      }
      return { ok: false, stage: 'blocked', openUrl: url.toString(),
        message: '連不到代理，或它沒有回傳 CORS 標頭。'
          + '請用瀏覽器新分頁直接打開下面的網址：看得到「只接受 data.gcis.nat.gov.tw 的網址」'
          + '就代表 Worker 活著，問題出在腳本裡的 ORIGIN 設定；'
          + '如果打不開或顯示錯誤，就是網址填錯或 Worker 沒部署成功。' };
    }
  }

  async function request(url) {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    const type = res.headers.get('content-type') || '(沒有 Content-Type)';
    // 收到什麼一定要帶回去。這類失敗光看「不是 JSON」完全無法判斷是政府端回了
    // 錯誤頁、回了空白、還是代理自己出問題——實際內容講得比任何猜測都清楚。
    const describe = () => (text.trim()
      ? `${type}｜${text.replace(/\s+/g, ' ').trim().slice(0, 300)}`
      : `${type}｜（空白回應，一個字都沒有）`);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.body = describe();
      throw err;
    }
    try {
      return unwrap(JSON.parse(text));
    } catch (e) {
      const err = new Error('回應不是 JSON');
      err.body = describe();
      throw err;
    }
  }

  /*
   * 拿一家一定存在的公司來探路：台灣積體電路製造（統編 22099131）。
   *
   * 這支 API 沒有 $filter 就回空白，所以「不帶條件要一筆」永遠是空的，
   * 分不出任何事。改成查一家保證查得到的：查得到就代表路是通的、資料集是對的，
   * 回來那一筆的欄位名稱也正是這支 API 真正的欄位名稱。
   */
  const PROBE_TAXID = '22099131';
  function bareUrls() {
    const urls = [];
    const direct = officialByTaxId(PROBE_TAXID);
    if (getProxy()) direct.forEach((u, i) => urls.push({ label: `自架代理（寫法 ${i + 1}）`, url: viaProxy(u), upstream: u }));
    direct.forEach((u, i) => urls.push({ label: `官方（直接連，寫法 ${i + 1}）`, url: u, upstream: u }));
    return urls;
  }

  async function probeDataset() {
    const tried = [];
    for (const { label, url } of bareUrls()) {
      try {
        const rows = await request(url);
        if (!rows.length) {
          tried.push({ label, url, reason: `連台積電（統編 ${PROBE_TAXID}）都查不到，回的是空的` });
          continue;
        }
        return {
          ok: true, label, url, row: rows[0],
          keys: Object.keys(rows[0]), tried,
        };
      } catch (err) {
        tried.push({ label, url, reason: explain(err, /代理/.test(label) ? 'proxy' : 'official'), body: err.body });
      }
    }
    return { ok: false, tried };
  }

  /** 目前可以用的來源，依序試。沒填代理就跳過代理，沒啟用鏡像就跳過鏡像。 */
  function activeSources({ useMirror = false } = {}) {
    const keys = ['official'];
    if (getProxy()) keys.push('proxy');
    if (useMirror) keys.push('g0v');
    return keys;
  }

  async function tryEach(kind, value, opts) {
    const attempts = [];
    for (const key of activeSources(opts)) {
      const src = SOURCES[key];
      const urls = kind === 'taxId' ? src.byTaxId(value) : src.byName(value);
      for (let i = 0; i < urls.length; i++) {
        const tag = urls.length > 1 ? `${src.label}（寫法 ${i + 1}）` : src.label;
        try {
          const rows = await request(urls[i]);
          if (!rows.length) {
            attempts.push({ source: key, label: tag, reason: '查無資料', url: urls[i], upstream: upstreamOf(urls[i]) });
            continue;   // 同一個來源的其他寫法還有機會
          }
          return {
            ok: true, source: key, label: tag, url: urls[i],
            data: mapRow(rows[0]), candidates: rows.map(mapRow), raw: rows[0], attempts,
          };
        } catch (err) {
          attempts.push({ source: key, label: tag, reason: explain(err, key), body: err.body, url: urls[i], upstream: upstreamOf(urls[i]) });
          // 跨網域被擋是整個來源的問題，換寫法沒有意義
          if (err instanceof TypeError) break;
        }
      }
    }
    return {
      ok: false, attempts,
      reason: attempts.length ? attempts.map((a) => `${a.label}：${a.reason}`).join('\n') : '沒有可用的查詢來源',
    };
  }

  const lookupByTaxId = (taxId, opts) => {
    const clean = String(taxId || '').replace(/\D/g, '');
    if (clean.length !== 8) {
      return Promise.resolve({ ok: false, reason: '統一編號不是 8 碼，無法查詢', attempts: [] });
    }
    return tryEach('taxId', clean, opts);
  };

  const lookupByName = (name, opts) => {
    const clean = String(name || '').trim();
    if (!clean) return Promise.resolve({ ok: false, reason: '沒有公司名稱可以查', attempts: [] });
    return tryEach('name', clean, opts);
  };

  global.Registry = {
    lookupByTaxId, lookupByName, mapRow, toThousands, tidyDate,
    SOURCES, activeSources, getProxy, setProxy, checkProxy, probeDataset, nameVariants,
    getBase, setBase, DEFAULT_BASE, getTaxIdBase, setTaxIdBase, DEFAULT_TAXID_BASE, FIELD_CANDIDATES,
    officialByTaxId, officialByName, upstreamOf, PROBE_TAXID,
  };
})(window);
