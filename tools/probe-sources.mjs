/**
 * 探路：新北市資料開放平臺的這份資料集
 *   https://data.ntpc.gov.tw/datasets/5a6fda8d-c383-42de-a309-67df68d85495
 *
 * 使用者丟了這個網址說「從這邊看」。開發環境連不出去（data.ntpc.gov.tw 也是 000），
 * 只有 Actions 的 runner 出得去。
 *
 * 一樣不猜：先把頁面整個讀出來看它是什麼、欄位有哪些、下載與 API 連結在哪，
 * 再照頁面上寫的打。查的是公開資料，不碰任何客戶名單。
 */
const ID = '5a6fda8d-c383-42de-a309-67df68d85495';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const get = (url) => fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/json,*/*' }, signal: AbortSignal.timeout(60000), redirect: 'follow' });
const clean = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

console.log('=========== 一、資料集頁面 ===========');
let html = '';
try {
  const res = await get(`https://data.ntpc.gov.tw/datasets/${ID}`);
  html = await res.text();
  console.log(`HTTP ${res.status}　${res.headers.get('content-type')}　${html.length} bytes`);
  console.log(`\n【頁面文字（前 2500 字）】\n${clean(html).slice(0, 2500)}`);
  const links = [...new Set([...html.matchAll(/(?:href|src|data-url)="([^"]+)"/gi)].map((m) => m[1]))]
    .filter((h) => /api|download|\.csv|\.json|\.xml|\.zip|resource/i.test(h));
  console.log(`\n【可能的下載／API 連結 ${links.length} 個】`);
  links.slice(0, 25).forEach((h) => console.log(`   ${h.startsWith('http') ? h : `https://data.ntpc.gov.tw${h.startsWith('/') ? '' : '/'}${h}`}`));
} catch (e) { console.log(`✗ ${e.message}`); }

console.log('\n\n=========== 二、這個平臺常見的幾種 API 寫法 ===========');
// 頁面若是前端算出來的，連結抓不到，就把這個平臺常見的幾條都送出去看誰回 JSON
const CANDIDATES = [
  `https://data.ntpc.gov.tw/api/datasets/${ID}/json?page=0&size=5`,
  `https://data.ntpc.gov.tw/api/datasets/${ID}/json/preview`,
  `https://data.ntpc.gov.tw/api/v1/dataset/${ID}?format=json&limit=5`,
  `https://data.ntpc.gov.tw/api/datasets/${ID}/csv?page=0&size=5`,
  `https://data.ntpc.gov.tw/od/data/api/${ID}?$format=json&$top=5`,
];
for (const url of CANDIDATES) {
  try {
    const res = await get(url);
    const text = await res.text();
    console.log(`\n── ${url}\n   HTTP ${res.status}　${res.headers.get('content-type')}　${text.length} bytes`);
    console.log(`   ${text.slice(0, 900).replace(/\s+/g, ' ')}`);
  } catch (e) { console.log(`\n── ${url}\n   ✗ ${e.message}`); }
}

console.log('\n\n=========== 三、平臺的資料集清單 API（找工廠、公司之類的） ===========');
for (const url of [
  'https://data.ntpc.gov.tw/api/datasets?page=0&size=5',
  'https://data.ntpc.gov.tw/api/v1/datasets?limit=5',
]) {
  try {
    const res = await get(url);
    const text = await res.text();
    console.log(`\n── ${url}\n   HTTP ${res.status}　${res.headers.get('content-type')}　${text.length} bytes`);
    console.log(`   ${text.slice(0, 600).replace(/\s+/g, ' ')}`);
  } catch (e) { console.log(`\n── ${url}\n   ✗ ${e.message}`); }
}
console.log('\n\n完成。');
