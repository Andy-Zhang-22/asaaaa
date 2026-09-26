/**
 * 探路第二輪：動產擔保、工廠登記到底有沒有開放資料。
 *
 * 第一輪知道的事：
 *   - runner 出得去（data.gov.tw、data.gcis 都 200）
 *   - data.gov.tw 的 /api/v2/rest/dataset 回 405「Must be one of: POST」→ 存在，要 POST
 *   - 經濟部開放資料目錄 /od/datacategory 整頁抓得到（191KB HTML）→ 直接在裡面找
 *   - serv.gcis.nat.gov.tw 那組網址是我猜的，404，不再猜
 *
 * 這一輪只做兩件事：把經濟部目錄整頁翻一遍找關鍵字；用 POST 問 data.gov.tw。
 * 不碰任何客戶名單。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const get = async (url, init = {}) => fetch(url, {
  ...init,
  headers: { 'User-Agent': UA, ...(init.headers || {}) },
  signal: AbortSignal.timeout(60000),
  redirect: 'follow',
});

console.log('=========== 一、經濟部開放資料目錄裡有什麼 ===========');
{
  const res = await get('https://data.gcis.nat.gov.tw/od/datacategory');
  const html = await res.text();
  console.log(`目錄頁 HTML ${res.status}　${html.length} bytes`);

  // 目錄是一張表：把每個連結的文字與網址抓出來，再挑關鍵字
  const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(([, href, text]) => ({ href, text: text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() }))
    .filter((x) => x.text);
  console.log(`頁面上共 ${links.length} 個連結`);

  const KEYS = ['動產擔保', '動保', '抵押', '附條件', '工廠', '設立登記', '變更登記', '停業', '解散', '分公司', '商業登記'];
  for (const k of KEYS) {
    const hit = links.filter((x) => x.text.includes(k));
    console.log(`\n【${k}】${hit.length} 筆`);
    hit.slice(0, 12).forEach((x) => console.log(`   ${x.text}\n      ${x.href}`));
  }

  // 目錄頁上的 UUID（資料集編號）全部列出來，對照標題
  const ids = [...new Set([...html.matchAll(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/gi)].map((m) => m[0]))];
  console.log(`\n頁面上出現的資料集編號共 ${ids.length} 個（前 40 個）：`);
  ids.slice(0, 40).forEach((id) => console.log(`   ${id}`));

  // 標題附近就是編號的話，把「標題 → 編號」配起來印出來
  const rows = [...html.matchAll(/<tr[\s\S]{0,4000}?<\/tr>/gi)]
    .map((m) => m[0])
    .map((tr) => ({
      text: tr.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
      id: (tr.match(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i) || [])[0] || '',
    }))
    .filter((r) => r.text);
  console.log(`\n表格列共 ${rows.length}；含關鍵字的：`);
  rows.filter((r) => /動產擔保|動保|抵押|附條件|工廠/.test(r.text))
    .slice(0, 20).forEach((r) => console.log(`   ${r.id || '(無編號)'}　${r.text.slice(0, 120)}`));
}

console.log('\n\n=========== 二、data.gov.tw 用 POST 問 ===========');
{
  const BODIES = [
    ['{q}', { q: '動產擔保' }],
    ['{keyword}', { keyword: '動產擔保' }],
    ['{query}', { query: '動產擔保' }],
    ['{q,size}', { q: '動產擔保', size: 20, page: 1 }],
  ];
  for (const [label, body] of BODIES) {
    try {
      const res = await get('https://data.gov.tw/api/v2/rest/dataset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      console.log(`\n── POST ${label}　HTTP ${res.status}　${text.length} bytes`);
      console.log(`   ${text.slice(0, 600).replace(/\s+/g, ' ')}`);
    } catch (e) {
      console.log(`\n── POST ${label}　✗ ${e.message}`);
    }
  }
}

console.log('\n\n=========== 三、經濟部目錄的分類頁 ===========');
// 目錄首頁可能只是分類，逐一看有沒有「動產擔保」那一類
for (const path of ['/od/datacategory?category=1', '/od/datacategory?category=2', '/od/datacategory?category=3']) {
  try {
    const res = await get(`https://data.gcis.nat.gov.tw${path}`);
    const html = await res.text();
    const titles = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((m) => m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && /登記|資料|清冊|擔保|工廠/.test(t));
    console.log(`\n── ${path}　HTTP ${res.status}　符合的標題 ${titles.length} 個`);
    [...new Set(titles)].slice(0, 25).forEach((t) => console.log(`   ${t}`));
  } catch (e) { console.log(`\n── ${path}　✗ ${e.message}`); }
}

console.log('\n\n完成。');
