/**
 * 探路：看看「動產擔保交易登記」「工廠登記」「政府採購決標」「進出口廠商」
 * 這幾份公開資料到底撈不撈得到。
 *
 * 為什麼要這支：開發環境連不出政府網站，只有 Actions 的 runner 出得去。
 * 而且上一次「用公司名查商工登記」就是憑空想了一個很像的網址、白走好幾輪，
 * 所以這支不猜網址——先問政府資料開放平臺「有沒有這份資料」，它回什麼就記什麼，
 * 每一個候選網址的狀態、內容型別、前幾百個字全部印出來，看得到才下判斷。
 *
 * 不碰任何客戶名單，查的全是公開目錄。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

async function probe(label, url, { head = 500 } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/html;q=0.8, */*;q=0.5' },
      signal: AbortSignal.timeout(45000),
      redirect: 'follow',
    });
    const type = res.headers.get('content-type') || '(無)';
    const body = await res.text();
    const ms = Date.now() - started;
    console.log(`\n── ${label}`);
    console.log(`   ${url}`);
    console.log(`   HTTP ${res.status}　${type}　${body.length} bytes　${ms}ms`);
    console.log(`   ${body.slice(0, head).replace(/\s+/g, ' ')}`);
    return { ok: res.ok, status: res.status, type, body };
  } catch (err) {
    console.log(`\n── ${label}`);
    console.log(`   ${url}`);
    console.log(`   ✗ ${err && err.message ? err.message : err}`);
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

console.log('=========== 一、先確認 runner 出得去 ===========');
await probe('政府資料開放平臺首頁', 'https://data.gov.tw/', { head: 120 });
await probe('商工行政服務入口', 'https://serv.gcis.nat.gov.tw/', { head: 120 });
await probe('商工登記開放資料（已知可用的那支）',
  'https://data.gcis.nat.gov.tw/od/data/api/5F64D864-61CB-4D0D-8AD9-492047CC1EA6?$format=json&$filter=Business_Accounting_NO eq 22099131&$skip=0&$top=1');

console.log('\n\n=========== 二、資料開放平臺的搜尋 API 哪一條通 ===========');
// 只試官方文件上出現過的幾種寫法，通了哪一條再用哪一條，不自己發明
const SEARCH = [
  ['v2 rest/dataset', (q) => `https://data.gov.tw/api/v2/rest/dataset?q=${encodeURIComponent(q)}&size=20`],
  ['v1 rest/datasets', (q) => `https://data.gov.tw/api/v1/rest/datasets?q=${encodeURIComponent(q)}`],
  ['front/dataset/search', (q) => `https://data.gov.tw/api/front/dataset/search?q=${encodeURIComponent(q)}&size=20`],
];
let searcher = null;
for (const [name, build] of SEARCH) {
  const r = await probe(`搜尋 API：${name}`, build('動產擔保'), { head: 700 });
  if (r.ok && /json/i.test(r.type || '') && !searcher) searcher = build;
}

console.log('\n\n=========== 三、四個題目各有沒有資料 ===========');
const TOPICS = ['動產擔保', '工廠登記', '決標', '進出口廠商'];
if (!searcher) {
  console.log('搜尋 API 全部不通，沒辦法用「問目錄」的方式找，只能之後手動翻網站。');
} else {
  for (const q of TOPICS) {
    const r = await probe(`搜尋「${q}」`, searcher(q), { head: 60 });
    if (!r.ok) continue;
    let rows = [];
    try {
      const j = JSON.parse(r.body);
      rows = j.result?.results || j.result || j.data || j.records || (Array.isArray(j) ? j : []);
    } catch (e) { console.log('   （回的不是能解析的 JSON）'); continue; }
    if (!Array.isArray(rows)) { console.log(`   （結構不是陣列：${Object.keys(rows).slice(0, 8).join(', ')}）`); continue; }
    console.log(`   共 ${rows.length} 筆：`);
    rows.slice(0, 10).forEach((d, i) => {
      const title = d.title || d.datasetName || d.name || '(無標題)';
      const org = d.organization?.title || d.organization || d.providerName || '';
      const id = d.id || d.datasetId || '';
      console.log(`   ${i + 1}. ${title}　${org ? `｜${org}` : ''}${id ? `｜id=${id}` : ''}`);
      const res = d.resources || d.distribution || [];
      (Array.isArray(res) ? res : []).slice(0, 3).forEach((x) => {
        console.log(`        └ ${x.format || x.resourceFormat || '?'}　${x.url || x.downloadUrl || x.resourceDownloadUrl || ''}`);
      });
    });
  }
}

console.log('\n\n=========== 四、動保查詢頁本身有沒有回應 ===========');
// 只看首頁／查詢入口回什麼，不送任何查詢條件
await probe('動產擔保交易登記查詢（商工行政服務入口）',
  'https://serv.gcis.nat.gov.tw/moeadsBF/chattel/chattel_list.jsp', { head: 400 });
await probe('經濟部開放資料目錄', 'https://data.gcis.nat.gov.tw/od/datacategory', { head: 400 });

console.log('\n\n完成。');
