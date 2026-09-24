/**
 * 探測「找新客戶」會用到的公開資料來源，把每一條路實際回什麼印在執行紀錄上。
 *
 * 跟 probe-sources.mjs 一樣只能在 GitHub Actions 上跑（開發環境連不上政府網站），
 * 而且只讀不寫。差別在目的：那支是查「一家公司」的登記資料，這支是找「整批名單」——
 * 每月的設立／變更登記清冊、工廠登記、政府採購決標，都是中小企業有資金動作的訊號。
 *
 * 結果直接印在 log（不只放 artifact），因為開發環境也連不上 artifact 的下載網址，
 * 只有 Actions 的 log 讀得到。
 */

const UA = 'asaaaa-list-updater/1.0 (+https://github.com/Andy-Zhang-22/asaaaa)';
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…（後略，共 ${s.length} 字）` : s);
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function get(url, opts = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: '*/*', ...(opts.headers || {}) },
      signal: AbortSignal.timeout(60000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    // 政府檔案常是 Big5：先看 content-type，沒講就試 utf-8，亂碼再退回 big5
    let text;
    const ct = res.headers.get('content-type') || '';
    if (/big5/i.test(ct)) text = new TextDecoder('big5').decode(buf);
    else {
      text = buf.toString('utf8');
      if ((text.match(/�/g) || []).length > 20) text = new TextDecoder('big5').decode(buf);
    }
    return { ok: res.ok, status: res.status, url: res.url, ct, cors: res.headers.get('access-control-allow-origin') || '', bytes: buf.length, text, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: 'ERROR', error: `${err.name}: ${err.message}`, text: '', ms: Date.now() - started };
  }
}

function report(title, r, extra) {
  console.log(`\n### ${title}`);
  console.log(`- 狀態 ${r.status}${r.error ? ` — ${r.error}` : ''}　${r.ct || ''}　CORS=${r.cors || '無'}　${r.bytes || 0} bytes　${r.ms}ms`);
  if (r.url) console.log(`- 最終網址：${r.url}`);
  if (extra) console.log(extra);
}

/** 從 HTML 抓出所有連結（href + 文字），給目錄頁用。 */
function links(html, base) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = flat(m[2].replace(/<[^>]+>/g, ''));
    let href = m[1];
    try { href = new URL(href, base).href; } catch (e) { /* 留原樣 */ }
    out.push({ href, text });
  }
  return out;
}

/** 表單欄位：form action、select 名稱與選項、input 名稱。看要帶什麼參數才查得到。 */
function formFields(html) {
  const lines = [];
  const forms = html.match(/<form\b[^>]*>/gi) || [];
  forms.forEach((f) => lines.push(`form: ${flat(f)}`));
  const selRe = /<select\b[^>]*name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi;
  let m;
  while ((m = selRe.exec(html)) !== null) {
    const opts = [];
    const oRe = /<option\b[^>]*value\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;
    let o;
    while ((o = oRe.exec(m[2])) !== null) opts.push(`${o[1]}=${flat(o[2].replace(/<[^>]+>/g, ''))}`);
    lines.push(`select ${m[1]}: ${opts.slice(0, 40).join(' | ')}${opts.length > 40 ? ` …共 ${opts.length} 個` : ''}`);
  }
  const inRe = /<input\b[^>]*>/gi;
  const inputs = (html.match(inRe) || []).map((i) => {
    const name = (i.match(/name\s*=\s*["']([^"']+)["']/i) || [])[1];
    const type = (i.match(/type\s*=\s*["']([^"']+)["']/i) || [])[1] || 'text';
    const value = (i.match(/value\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    return name ? `${name}(${type})=${value}` : '';
  }).filter(Boolean);
  if (inputs.length) lines.push(`inputs: ${inputs.slice(0, 60).join(', ')}`);
  return lines.join('\n');
}

// ---- 1. 商工行政資料開放平臺：目錄頁，找「清冊」類資料集與它們的下載網址 ----
{
  const r = await get('https://data.gcis.nat.gov.tw/od/datacategory');
  const hits = r.text ? links(r.text, r.url).filter((l) => /清冊|設立|變更|增資|解散|工廠|登記/.test(l.text)) : [];
  report('GCIS 開放平臺目錄頁', r, hits.length
    ? hits.slice(0, 80).map((l) => `  - ${l.text} → ${l.href}`).join('\n')
    : `（沒抓到連結）\n${clip(flat(r.text), 1500)}`);
  // 目錄頁如果是 JS 動態載入，連結會在 script 裡；把含 oid 的片段也印出來
  const oids = [...new Set((r.text.match(/oid=[A-Za-z0-9-]{8,}/g) || []))];
  if (oids.length) console.log(`- 頁面裡的 oid：${oids.slice(0, 40).join(', ')}${oids.length > 40 ? ` …共 ${oids.length} 個` : ''}`);
}

// ---- 2. 開放平臺「清冊」下載常見的兩種網址寫法 ----
for (const url of [
  'https://data.gcis.nat.gov.tw/od/rss',
  'https://data.gcis.nat.gov.tw/od/detail?oid=',
  'https://data.gcis.nat.gov.tw/od/file?oid=',
]) {
  const r = await get(url);
  report(`GCIS ${url}`, r, clip(flat(r.text), 600));
}

// ---- 3. 公司變更登記（增資）縣市查詢頁：看表單要帶什麼參數 ----
{
  const r = await get('https://serv.gcis.nat.gov.tw/pub/cmpy/reportCity.jsp');
  report('公司變更登記 縣市查詢頁 reportCity.jsp', r, formFields(r.text) || clip(flat(r.text), 1200));
  const more = links(r.text, r.url).filter((l) => /\.jsp|\.do|report/i.test(l.href));
  if (more.length) console.log(more.slice(0, 40).map((l) => `  - ${l.text || '(無文字)'} → ${l.href}`).join('\n'));
}
// 同目錄下常見的兄弟頁：設立登記、月報
for (const url of [
  'https://serv.gcis.nat.gov.tw/pub/cmpy/reportCityMonth.jsp',
  'https://serv.gcis.nat.gov.tw/pub/cmpy/reportAction.do',
  'https://serv.gcis.nat.gov.tw/pub/cmpy/cmpyInfoListAction.do',
  'https://serv.gcis.nat.gov.tw/pub/cmpy/',
]) {
  const r = await get(url);
  report(`serv.gcis ${url}`, r, r.text ? (formFields(r.text) || clip(flat(r.text), 500)) : '');
}

// ---- 4. 工廠登記（產業發展署 工廠公示資料）----
for (const url of [
  'https://serv.gcis.nat.gov.tw/fm/fmQuery.do',
  'https://serv.gcis.nat.gov.tw/fm/',
  'https://data.gov.tw/datasets/search?p=1&size=10&s=_score_desc&q=%E5%B7%A5%E5%BB%A0%E7%99%BB%E8%A8%98',
  'https://data.gov.tw/api/v2/rest/dataset?q=%E5%B7%A5%E5%BB%A0%E7%99%BB%E8%A8%98',
]) {
  const r = await get(url);
  const ls = r.text ? links(r.text, r.url).filter((l) => /dataset|工廠/.test(l.href + l.text)).slice(0, 30) : [];
  report(`工廠登記 ${url}`, r, ls.length ? ls.map((l) => `  - ${l.text} → ${l.href}`).join('\n') : clip(flat(r.text), 600));
}

// ---- 5. 政府採購決標（g0v 政府標案 API）----
for (const url of [
  'https://pcc.g0v.ronny.tw/api/listbydate?date=20260901',
  'https://pcc.g0v.ronny.tw/api/searchbycompanyname?query=%E7%B2%BE%E5%AF%86',
]) {
  const r = await get(url, { headers: { Origin: 'https://andy-zhang-22.github.io' } });
  report(`政府標案 ${url}`, r, clip(flat(r.text), 800));
}

// ---- 6. 開放平臺 API：用「核准設立日期」撈整批（看 $filter 支不支援範圍）----
for (const url of [
  'https://data.gcis.nat.gov.tw/od/data/api/7E6AFA72-AD6A-46D3-8681-ED77951D912D?$format=json&$filter=Company_Setup_Date ge 1150801 and Company_Setup_Date le 1150831&$skip=0&$top=5',
  'https://data.gcis.nat.gov.tw/od/data/api/236EE382-4942-41A9-BD03-CA0709025E7C?$format=json&$filter=Company_Setup_Date ge 1150801&$skip=0&$top=5',
  'https://data.gcis.nat.gov.tw/od/data/api/5F64D864-61CB-4D0D-8AD9-492047CC1EA6?$format=json&$filter=Company_Name like 精密 and Company_Status eq 01&$skip=0&$top=3',
]) {
  const r = await get(url);
  report(`GCIS API 整批查詢 ${url.split('?')[0].slice(-36)}`, r, clip(flat(r.text), 900));
}

console.log('\n探測完畢');
