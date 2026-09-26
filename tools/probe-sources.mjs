/**
 * 探路第三輪：動保清冊裡到底有什麼欄位、下載得到嗎。
 *
 * 第二輪找到的（經濟部開放資料目錄 /od/datacategory 裡確實有）：
 *   動產擔保交易公示登記清冊(月份)  oid=07C2AB4A-4A73-402C-B8EE-2D04A56FA75E
 *   動產擔保交易公示變更清冊(月份)  oid=A14C70AF-F019-4695-93DF-C0763E2E08B4
 *   動產擔保交易公示註銷清冊(月份)  oid=1492458C-C729-45A2-9F55-CC5EF0C2E264
 * 另外三筆「動產擔保交易登記統計」只有總額、沒有公司，用不上。
 *
 * 順便看三個原本不知道的：公司負責人資料查詢、公司登記董監事資料、公司資料異動查詢。
 *
 * 這一輪要回答的就一件事：清冊下載得到嗎？裡面有沒有統編、公司名、債權人、金額、日期？
 * 不碰任何客戶名單。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const get = (url, init = {}) => fetch(url, {
  ...init,
  headers: { 'User-Agent': UA, ...(init.headers || {}) },
  signal: AbortSignal.timeout(90000),
  redirect: 'follow',
});
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

const SETS = [
  ['動保：登記清冊(月份)', '07C2AB4A-4A73-402C-B8EE-2D04A56FA75E'],
  ['動保：變更清冊(月份)', 'A14C70AF-F019-4695-93DF-C0763E2E08B4'],
  ['動保：註銷清冊(月份)', '1492458C-C729-45A2-9F55-CC5EF0C2E264'],
  ['公司負責人資料查詢', ''],
  ['公司登記董監事資料', ''],
];

for (const [label, oid] of SETS) {
  if (!oid) continue;
  console.log(`\n\n=========== ${label} ===========`);
  const url = `https://data.gcis.nat.gov.tw/od/detail?oid=${oid}`;
  try {
    const res = await get(url);
    const html = await res.text();
    console.log(`detail 頁 HTTP ${res.status}　${html.length} bytes`);
    // 說明文字：欄位清單通常就寫在這裡
    console.log(`\n【頁面文字（前 1800 字）】\n${strip(html).slice(0, 1800)}`);
    // 下載／API 連結
    const links = [...new Set([...html.matchAll(/(?:href|action)="([^"]+)"/gi)].map((m) => m[1]))]
      .filter((h) => /download|\.csv|\.zip|\.json|\.xml|\/od\/data\/api|file/i.test(h));
    console.log(`\n【可能的下載／API 連結 ${links.length} 個】`);
    links.slice(0, 20).forEach((h) => console.log(`   ${h.startsWith('http') ? h : `https://data.gcis.nat.gov.tw${h.startsWith('/') ? '' : '/od/'}${h}`}`));
  } catch (e) {
    console.log(`✗ ${e.message}`);
  }
}

console.log('\n\n=========== 直接試 API 端點（跟公司登記同一種寫法） ===========');
for (const [label, oid] of SETS.filter(([, o]) => o)) {
  const url = `https://data.gcis.nat.gov.tw/od/data/api/${oid}?$format=json&$skip=0&$top=2`;
  try {
    const res = await get(url);
    const text = await res.text();
    console.log(`\n── ${label}\n   ${url}\n   HTTP ${res.status}　${res.headers.get('content-type')}　${text.length} bytes`);
    console.log(`   ${text.slice(0, 900).replace(/\s+/g, ' ')}`);
  } catch (e) {
    console.log(`\n── ${label}　✗ ${e.message}`);
  }
}

console.log('\n\n=========== 目錄裡這幾個的 oid 是多少 ===========');
{
  const res = await get('https://data.gcis.nat.gov.tw/od/datacategory');
  const html = await res.text();
  const links = [...html.matchAll(/<a\b[^>]*href="([^"]*oid=([0-9A-F-]{36})[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(([, , oid, text]) => ({ oid, text: text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() }));
  ['負責人', '董監事', '異動', '資本額', '設立'].forEach((k) => {
    console.log(`\n【${k}】`);
    links.filter((x) => x.text.includes(k)).slice(0, 8).forEach((x) => console.log(`   ${x.oid}　${x.text}`));
  });
}
console.log('\n\n完成。');
