/**
 * 探路第六輪（收尾）：照文件實際打一次，確認真的回得出東西。
 *
 * 第五輪從說明頁讀到真正的 API 編號（頁面上第二個 UUID 才是 API id）：
 *   4B61A0F1-458C-43F9-93F3-9FD6DA5E1B08  公司負責人資料查詢（條件：負責人姓名）
 *   4347A009-6489-4F19-AC79-78F366BE7976  公司資料異動查詢（條件：最後核准變更日期）
 *   4E5F7653-1B91-4DDC-99D5-468530FAE396  公司登記董監事資料（條件：公司統一編號，約 200 萬筆）
 * 說明頁也指出有 OAS 文件：https://data.gcis.nat.gov.tw/resources/swagger/swagger.json
 *
 * 不猜參數名：先把 swagger 裡這三支的路徑與參數印出來，再照著打。
 * 查的是台積電與魏哲家（公開資料），不碰任何客戶名單。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const IDS = {
  '公司負責人資料查詢': '4B61A0F1-458C-43F9-93F3-9FD6DA5E1B08',
  '公司資料異動查詢': '4347A009-6489-4F19-AC79-78F366BE7976',
  '公司登記董監事資料': '4E5F7653-1B91-4DDC-99D5-468530FAE396',
};
const get = (url) => fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });

console.log('=========== 一、swagger 文件裡這三支怎麼呼叫 ===========');
try {
  const res = await get('https://data.gcis.nat.gov.tw/resources/swagger/swagger.json');
  const text = await res.text();
  console.log(`swagger HTTP ${res.status}　${text.length} bytes`);
  const doc = JSON.parse(text);
  const paths = doc.paths || {};
  for (const [label, id] of Object.entries(IDS)) {
    const key = Object.keys(paths).find((p) => p.toUpperCase().includes(id));
    console.log(`\n── ${label}　${id}`);
    if (!key) { console.log('   swagger 裡找不到這個編號'); continue; }
    console.log(`   路徑：${key}`);
    const ops = paths[key];
    for (const [method, op] of Object.entries(ops)) {
      console.log(`   ${method.toUpperCase()}　${op.summary || op.description || ''}`);
      (op.parameters || []).forEach((p) => console.log(`      參數 ${p.name}（${p.in}${p.required ? '，必填' : ''}）${p.description || ''}`));
    }
  }
} catch (e) { console.log(`✗ ${e.message}`); }

console.log('\n\n=========== 二、照文件實際打一次 ===========');
const call = async (label, url) => {
  try {
    const res = await get(url);
    const text = await res.text();
    console.log(`\n── ${label}\n   ${url}\n   HTTP ${res.status}　${res.headers.get('content-type')}　${text.length} bytes`);
    console.log(`   ${text.slice(0, 700).replace(/\s+/g, ' ')}`);
  } catch (e) { console.log(`\n── ${label}\n   ${url}\n   ✗ ${e.message}`); }
};
const B = 'https://data.gcis.nat.gov.tw/od/data/api';
// 負責人：文件說條件是「負責人姓名」，常見參數名一併試
for (const q of ['$filter=Responsible_Name eq 魏哲家', 'Responsible_Name=魏哲家', 'president=魏哲家']) {
  await call(`負責人查詢：${q.split(/[=&]/)[0]}`, `${B}/${IDS['公司負責人資料查詢']}?$format=json&${q}&$skip=0&$top=5`);
}
// 董監事：條件是公司統一編號
for (const q of ['$filter=Business_Accounting_NO eq 22099131', 'Business_Accounting_NO=22099131']) {
  await call(`董監事：${q.split(/[=&]/)[0]}`, `${B}/${IDS['公司登記董監事資料']}?$format=json&${q}&$skip=0&$top=5`);
}
// 異動：條件是最後核准變更日期（民國 yyyMMdd 與西元都試）
const d = new Date(Date.now() - 5 * 86400000);
const ad = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const roc = `${d.getFullYear() - 1911}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
for (const v of [roc, ad]) {
  await call(`異動查詢：Change_Of_Approval_Data=${v}`,
    `${B}/${IDS['公司資料異動查詢']}?$format=json&$filter=Change_Of_Approval_Data eq ${v}&$skip=0&$top=3`);
}
console.log('\n\n完成。');
