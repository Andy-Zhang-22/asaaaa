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

  // 商工行政資料開放平臺：公司登記基本資料
  const BASE = 'https://data.gcis.nat.gov.tw/od/data/api/5F64D864-61CB-4D0D-8AD9-492047CC1EA6';

  const urlByTaxId = (taxId) =>
    `${BASE}?%24format=json&%24filter=Business_Accounting_NO%20eq%20${encodeURIComponent(taxId)}&%24skip=0&%24top=1`;

  const urlByName = (name) =>
    `${BASE}?%24format=json&%24filter=Company_Name%20like%20${encodeURIComponent(name)}&%24skip=0&%24top=5`;

  /*
   * 欄位名稱用「候選清單」而不是寫死一個。
   *
   * 我沒辦法從開發環境實際打這支 API，所以不確定欄位到底叫什麼。與其賭一個名字、
   * 猜錯就整個功能靜悄悄地回傳空值，不如列出已知的幾種拼法依序試，並且在介面上
   * 把原始回應秀出來——猜錯的時候看得見，也才改得掉。
   */
  const FIELD_CANDIDATES = {
    taxId: ['Business_Accounting_NO', 'BAN', 'Business_Accounting_No'],
    name: ['Company_Name', 'Business_Name', 'Company_Name_Chinese'],
    status: ['Company_Status_Desc', 'Company_Status', 'Business_Status_Desc'],
    owner: ['Responsible_Name', 'Company_Responsible_Name', 'Business_Responsible_Name'],
    address: ['Company_Location', 'Business_Address', 'Company_Address', 'Business_Location'],
    capital: ['Capital_Stock_Amount', 'Capital_Total_Amount', 'Capital_Amount'],
    paidIn: ['Paid_In_Capital_Amount', 'Paid_In_Capital_Total_Amount'],
    setupDate: ['Company_Setup_Date', 'Business_Setup_Date', 'Setup_Date'],
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
  function explain(err) {
    if (err && err.name === 'AbortError') return '查詢逾時（超過 20 秒沒有回應）。';
    if (err instanceof TypeError) {
      return '瀏覽器擋下了這個請求。最可能的原因是政府的開放資料 API 不允許跨網域呼叫（CORS）；'
        + '也有可能是網路不通。這一條路走不通的話，要改用另一種做法（由排程抓整批資料回來比對）。';
    }
    return `查詢失敗：${(err && err.message) || err}`;
  }

  async function request(url) {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.body = text.slice(0, 400);
      throw err;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      const err = new Error('回應不是 JSON');
      err.body = text.slice(0, 400);
      throw err;
    }
    return Array.isArray(json) ? json : (json && json.data) || [];
  }

  async function lookupByTaxId(taxId) {
    const clean = String(taxId || '').replace(/\D/g, '');
    if (clean.length !== 8) return { ok: false, reason: '統一編號不是 8 碼，無法查詢' };
    try {
      const rows = await request(urlByTaxId(clean));
      if (!rows.length) return { ok: false, reason: '查無這個統編的登記資料', raw: rows };
      return { ok: true, data: mapRow(rows[0]), raw: rows[0] };
    } catch (err) {
      return { ok: false, reason: explain(err), body: err.body };
    }
  }

  async function lookupByName(name) {
    const clean = String(name || '').trim();
    if (!clean) return { ok: false, reason: '沒有公司名稱可以查' };
    try {
      const rows = await request(urlByName(clean));
      if (!rows.length) return { ok: false, reason: '查無這個名稱的登記資料', raw: rows };
      return { ok: true, data: mapRow(rows[0]), candidates: rows.map(mapRow), raw: rows[0] };
    } catch (err) {
      return { ok: false, reason: explain(err), body: err.body };
    }
  }

  global.Registry = {
    lookupByTaxId, lookupByName, mapRow, toThousands, tidyDate,
    urlByTaxId, urlByName, FIELD_CANDIDATES,
  };
})(window);
