/**
 * 探路第四輪：動保沒用，改驗撈到的兩個替代品。
 *
 * 第三輪的結論：動產擔保交易那三份清冊的欄位是「年月、報表種類、登記機關、案件類別、
 * 擔保債權額、幣別、訂立契約日期、終止日期」——沒有公司名、沒有統編、沒有債權人，
 * 而且全國一個月只有一兩百筆，是彙總報表不是個案明細。我想的「看得到同業客戶與到期
 * 時間」那個構想，資料裡沒有支撐。這條斷了。
 *
 * 但目錄裡撈到兩個真正有用的：
 *   B61991E3-55E6-4A39-8BDC-31B5D965D711  公司負責人資料查詢 → 老闆名下還有哪幾家
 *   C1DA4270-227F-4E88-8D25-762690C10840  公司資料異動查詢   → 夜裡先備好「誰動了」
 *   7CD44707-5D43-4C93-BC45-50E22F67EB01  公司登記董監事資料
 *
 * 一樣不猜：每種寫法都送出去，回什麼就印什麼。查的是台積電與魏哲家（公開資料）。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const API = 'https://data.gcis.nat.gov.tw/od/data/api';

async function tryUrl(label, url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
    const text = await res.text();
    console.log(`\n── ${label}`);
    console.log(`   ${url}`);
    console.log(`   HTTP ${res.status}　${res.headers.get('content-type')}　${text.length} bytes`);
    console.log(`   ${text.slice(0, 900).replace(/\s+/g, ' ')}`);
    return text;
  } catch (e) {
    console.log(`\n── ${label}\n   ${url}\n   ✗ ${e.message}`);
    return '';
  }
}

console.log('=========== 一、公司負責人資料查詢（老闆名下還有哪幾家） ===========');
{
  const oid = 'B61991E3-55E6-4A39-8BDC-31B5D965D711';
  await tryUrl('不帶條件（看它要什麼）', `${API}/${oid}?$format=json&$skip=0&$top=1`);
  for (const field of ['Responsible_Name', 'Company_Responsible_Name', 'Name', 'President_Name']) {
    await tryUrl(`用 ${field} 查魏哲家`,
      `${API}/${oid}?$format=json&$filter=${field} eq 魏哲家&$skip=0&$top=5`);
  }
}

console.log('\n\n=========== 二、公司資料異動查詢（夜裡先備好誰動了） ===========');
{
  const oid = 'C1DA4270-227F-4E88-8D25-762690C10840';
  await tryUrl('不帶條件', `${API}/${oid}?$format=json&$skip=0&$top=1`);
  const d = new Date(Date.now() - 3 * 86400000);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  for (const field of ['Change_Of_Approval_Data', 'Data_Date', 'Change_Date']) {
    await tryUrl(`用 ${field}=${ymd}`, `${API}/${oid}?$format=json&$filter=${field} eq ${ymd}&$skip=0&$top=3`);
  }
}

console.log('\n\n=========== 三、公司登記董監事資料 ===========');
{
  const oid = '7CD44707-5D43-4C93-BC45-50E22F67EB01';
  await tryUrl('不帶條件', `${API}/${oid}?$format=json&$skip=0&$top=1`);
  await tryUrl('用統編查台積電',
    `${API}/${oid}?$format=json&$filter=Business_Accounting_NO eq 22099131&$skip=0&$top=3`);
}

console.log('\n\n=========== 四、API 指引頁怎麼說 ===========');
{
  try {
    const res = await fetch('https://data.gcis.nat.gov.tw/od/apiguide', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
    const html = await res.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`指引頁 HTTP ${res.status}　${html.length} bytes`);
    const at = text.indexOf('負責人');
    console.log(at >= 0 ? text.slice(Math.max(0, at - 600), at + 900) : text.slice(0, 1200));
  } catch (e) { console.log(`✗ ${e.message}`); }
}
console.log('\n\n完成。');
