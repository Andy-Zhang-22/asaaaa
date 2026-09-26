/**
 * 探路第五輪（最後）：把說明頁整頁讀出來，裡面才有真正的 API 網址。
 *
 * 第四輪學到的：目錄頁連結上的 oid 是「目錄編號」，不是「API 編號」。
 * 拿 oid 去打 /od/data/api/<oid> 一律回「此API不存在」；網站在用的公司登記 API
 * 是另一組 id（5F64D864-…）。真正的網址寫在各資料集的說明頁裡——動保那三頁的
 * 「原始檔案下載 2026年08月 CSV」就是這樣讀出來的。
 *
 * 這一輪把三個說明頁整頁的文字印出來，看欄位說明與 API 網址長什麼樣。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const SETS = [
  ['公司負責人資料查詢', 'B61991E3-55E6-4A39-8BDC-31B5D965D711'],
  ['公司資料異動查詢', 'C1DA4270-227F-4E88-8D25-762690C10840'],
  ['公司登記董監事資料', '7CD44707-5D43-4C93-BC45-50E22F67EB01'],
];
for (const [label, oid] of SETS) {
  console.log(`\n\n=========== ${label} ===========`);
  try {
    const res = await fetch(`https://data.gcis.nat.gov.tw/od/detail?oid=${oid}`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
    const html = await res.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    // 只印中間那段（前後都是選單與版權）
    const from = text.indexOf('資料集名稱');
    console.log(`HTTP ${res.status}　${html.length} bytes`);
    console.log(text.slice(from >= 0 ? from : 0, (from >= 0 ? from : 0) + 1500));
    // 頁面裡出現的所有 data.gcis 網址與 UUID
    const urls = [...new Set([...html.matchAll(/https?:\/\/data\.gcis\.nat\.gov\.tw[^\s"'<>)]*/gi)].map((m) => m[0]))];
    console.log(`\n【頁面裡的 data.gcis 網址 ${urls.length} 個】`);
    urls.slice(0, 15).forEach((u) => console.log(`   ${u}`));
    const ids = [...new Set([...html.matchAll(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/gi)].map((m) => m[0]))];
    console.log(`【頁面裡的編號】 ${ids.join('  ')}`);
  } catch (e) { console.log(`✗ ${e.message}`); }
}
console.log('\n\n完成。');
