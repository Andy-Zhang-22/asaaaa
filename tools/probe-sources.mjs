/**
 * 探路：新北市動產擔保登記清冊涵蓋哪幾個月。
 *
 * 使用者問「只有 8 月的資料嗎」。前一次只抽了頭 4000 筆（登記核准日是 2019 年的），
 * 沒看完整份。這次把全部 19,541 筆抓下來，把「登記核准日期」按年、按月統計，
 * 並把資料集頁面上「子資料集」下拉選單的選項印出來。
 *
 * 抓的時候要慢：一次 1000 筆連抓會被對方斷線。一頁 500、頁間停一下、失敗重試。
 * 查的是公開資料，不碰任何客戶名單。
 */
const ID = '5a6fda8d-c383-42de-a309-67df68d85495';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const get = (url) => fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(90000) });
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('=========== 一、頁面上的「子資料集」有哪些 ===========');
try {
  const html = await (await get(`https://data.ntpc.gov.tw/datasets/${ID}`)).text();
  // 下拉選單通常是 <select> 或 <option>；也有可能是前端算的，就把含 option 的都印
  const opts = [...html.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)].map((m) => m[1].replace(/<[^>]*>/g, '').trim()).filter(Boolean);
  console.log(`option 標籤 ${opts.length} 個：`, [...new Set(opts)].slice(0, 40).join(' ｜ '));
  const sub = [...html.matchAll(/子資料集[\s\S]{0,600}/g)].map((m) => m[0].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
  console.log('「子資料集」附近的文字：'); sub.slice(0, 3).forEach((t) => console.log('   ' + t));
  const links = [...new Set([...html.matchAll(/href="([^"]*(?:resources|datasets\/[0-9a-f-]{36}\/[^"]*)[^"]*)"/gi)].map((m) => m[1]))];
  console.log(`可能的資源連結 ${links.length} 個：`); links.slice(0, 15).forEach((l) => console.log('   ' + l));
} catch (e) { console.log(`✗ ${e.message}`); }

console.log('\n=========== 二、把整份抓下來 ===========');
const rows = [];
const SIZE = 500;
for (let page = 0; page < 80; page++) {
  let batch = null;
  for (let attempt = 1; attempt <= 3 && !batch; attempt++) {
    try {
      const res = await get(`https://data.ntpc.gov.tw/api/datasets/${ID}/json?page=${page}&size=${SIZE}`);
      const text = await res.text();
      if (!res.ok || !text.trim().startsWith('[')) { console.log(`page ${page}：HTTP ${res.status}，不是陣列`); batch = []; break; }
      batch = JSON.parse(text);
    } catch (e) { console.log(`page ${page} 第 ${attempt} 次失敗：${e.message}`); await nap(2500 * attempt); }
  }
  if (!batch || !batch.length) break;
  rows.push(...batch);
  if (page % 10 === 0) console.log(`page ${page}：累計 ${rows.length}`);
  if (batch.length < SIZE) break;
  await nap(700);
}
console.log(`共 ${rows.length} 筆`);

const tally = (get) => { const m = new Map(); rows.forEach((r) => { const v = get(r); if (v) m.set(v, (m.get(v) || 0) + 1); }); return [...m.entries()].sort(); };
const ym = (s) => { const t = String(s || '').trim(); return /^\d{8}$/.test(t) ? `${t.slice(0, 4)}/${t.slice(4, 6)}` : ''; };
const yr = (s) => { const t = String(s || '').trim(); return /^\d{8}$/.test(t) ? t.slice(0, 4) : ''; };

console.log('\n=========== 三、登記核准日期（caseayyyymmddroc）按年 ===========');
tally((r) => yr(r.caseayyyymmddroc)).forEach(([k, n]) => console.log(`   ${k}　${String(n).padStart(6)}`));
console.log('\n=========== 四、登記核准日期 按月（最近 24 個月） ===========');
tally((r) => ym(r.caseayyyymmddroc)).slice(-24).forEach(([k, n]) => console.log(`   ${k}　${String(n).padStart(6)}`));
console.log('\n=========== 五、註銷日期 按月（最近 12 個月） ===========');
tally((r) => ym(r.casecanyyyymmddroc)).slice(-12).forEach(([k, n]) => console.log(`   ${k}　${String(n).padStart(6)}`));
console.log('\n=========== 六、契約終止日期 按年（未註銷的） ===========');
const live = rows.filter((r) => !String(r.casecanyyyymmddroc || '').trim());
const lm = new Map(); live.forEach((r) => { const y = yr(r.caseeyyyymmddroc); if (y) lm.set(y, (lm.get(y) || 0) + 1); });
[...lm.entries()].sort().forEach(([k, n]) => console.log(`   ${k}　${String(n).padStart(6)}`));
console.log(`\n未註銷共 ${live.length} 筆／全部 ${rows.length} 筆`);
console.log('\n完成。');
