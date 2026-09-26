/**
 * 探路：新北市動產擔保登記清冊，確認怎麼判讀。
 *
 * 第一輪確認的：
 *   https://data.ntpc.gov.tw/api/datasets/5a6fda8d-c383-42de-a309-67df68d85495/json?page=0&size=N
 *   回 JSON，欄位 casetype, caseno, comaid/comaname（債務人）, combid/combname（債權人）,
 *   casesyyyymmddroc/caseeyyyymmddroc（契約起訖）, casetatol（金額）, caseaddr（標的物所在地）,
 *   casecanyyyymmddroc（註銷日期）。19541 筆，每月更新。
 *
 * 但前幾筆看起來有個陷阱：附條件買賣的案件裡，租賃公司出現在 comaname（債務人）那一欄，
 * 跟動產抵押相反。不確認清楚就會把同業當成客戶。這一輪抓一批樣本統計。
 * 也要確認日期到底是民國還是西元（欄位名寫 roc，值卻是 8 碼）。
 */
const URL = 'https://data.ntpc.gov.tw/api/datasets/5a6fda8d-c383-42de-a309-67df68d85495/json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const rows = [];
for (let page = 0; page < 4; page++) {
  const res = await fetch(`${URL}?page=${page}&size=1000`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(90000) });
  const text = await res.text();
  if (!res.ok || !text.trim().startsWith('[')) { console.log(`page ${page}：HTTP ${res.status}，回的不是陣列，停`); break; }
  const batch = JSON.parse(text);
  rows.push(...batch);
  console.log(`page ${page}：${batch.length} 筆（累計 ${rows.length}）`);
  if (batch.length < 1000) break;
}
console.log(`\n共抓到 ${rows.length} 筆`);

const tally = (get) => {
  const m = new Map();
  rows.forEach((r) => { const v = get(r); if (v) m.set(v, (m.get(v) || 0) + 1); });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

console.log('\n=========== 案件類別 ===========');
tally((r) => r.casetype).forEach(([k, n]) => console.log(`   ${n.toString().padStart(5)}　${k}`));

console.log('\n=========== 日期格式（確認民國還是西元） ===========');
{
  const lens = tally((r) => `起始長度 ${String(r.casesyyyymmddroc || '').trim().length}`);
  lens.forEach(([k, n]) => console.log(`   ${n.toString().padStart(5)}　${k}`));
  const sample = rows.filter((r) => String(r.casesyyyymmddroc || '').trim()).slice(0, 5);
  sample.forEach((r) => console.log(`   例：起 ${r.casesyyyymmddroc}　迄 ${r.caseeyyyymmddroc}　核准 ${r.caseayyyymmddroc}`));
}

console.log('\n=========== 各案件類別裡，coma / comb 各是誰（出現最多的前 8 名） ===========');
for (const [type] of tally((r) => r.casetype)) {
  const sub = rows.filter((r) => r.casetype === type);
  const top = (key) => {
    const m = new Map();
    sub.forEach((r) => { const v = r[key]; if (v) m.set(v, (m.get(v) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  };
  console.log(`\n── ${type}（${sub.length} 筆）`);
  console.log('   comaname（欄位名寫「債務人」）：');
  top('comaname').forEach(([k, n]) => console.log(`      ${n.toString().padStart(4)}　${k}`));
  console.log('   combname（欄位名寫「債權人」）：');
  top('combname').forEach(([k, n]) => console.log(`      ${n.toString().padStart(4)}　${k}`));
}

console.log('\n=========== 中租出現在哪一欄 ===========');
['comaname', 'combname'].forEach((key) => {
  const hit = rows.filter((r) => /中租|迪和/.test(String(r[key] || '')));
  console.log(`   ${key}：${hit.length} 筆`);
  [...new Set(hit.map((r) => `${r[key]}（統編 ${r[key === 'comaname' ? 'comaid' : 'combid']}）`))].slice(0, 5)
    .forEach((s) => console.log(`      ${s}`));
});

console.log('\n=========== 還沒註銷、且未來 12 個月內到期的有幾筆 ===========');
{
  const today = new Date();
  const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const now = ymd(today);
  const in12 = ymd(new Date(today.getFullYear() + 1, today.getMonth(), today.getDate()));
  const live = rows.filter((r) => !String(r.casecanyyyymmddroc || '').trim());
  const soon = live.filter((r) => {
    const e = String(r.caseeyyyymmddroc || '').trim();
    return e && e >= now && e <= in12;
  });
  console.log(`   總筆數 ${rows.length}／未註銷 ${live.length}／${now}～${in12} 到期 ${soon.length}`);
  soon.slice(0, 8).forEach((r) => console.log(`      ${r.caseeyyyymmddroc} 到期　${r.casetype}　${r.comaname} ／ ${r.combname}　${Number(r.casetatol || 0).toLocaleString()} 元　${r.caseaddr || ''}`.slice(0, 160)));
}
console.log('\n\n完成。');
