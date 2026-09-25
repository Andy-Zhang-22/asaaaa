/**
 * 商工登記查詢健檢：用網站自己的查詢程式（assets/js/registry.js）查一次台積電。
 *
 * 為什麼不另外寫一套查詢：健檢要驗的就是「網站現在用的那條路」——資料集編號、
 * OData 寫法、欄位名稱、備援順序。另外寫一套，壞的時候只知道「政府 API 還活著」，
 * 不知道網站查不查得到。所以這裡把 registry.js 原樣載進 Node（跟 tests/ 用同一個
 * 載入器），呼叫的函式跟瀏覽器裡一模一樣。
 *
 * 只查台積電（統編 22099131，公開資料）。不碰任何客戶名單。
 *
 * 結果寫成 registry-check.md（給 issue 與執行紀錄看）與 registry-check.json。
 * 「用統編查」不通、或查到但資本額／負責人／地址缺任何一個 → exit 1（每天自動更新靠它）。
 * 名稱查詢、g0v 鏡像不通只警告：那兩條本來就時好時壞，網站也有備援。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { loadModules } = require('../tests/load.js');

// 政府網站對沒有瀏覽器 UA 的請求有時直接回空白，跟自架代理的 Worker 腳本用同一個
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const fetchLikeBrowser = (url, init = {}) => fetch(url, {
  ...init,
  headers: { ...(init.headers || {}), 'User-Agent': UA },
  signal: init.signal || AbortSignal.timeout(30000),
});

const { Registry } = loadModules(['registry'], { fetch: fetchLikeBrowser });

const results = [];
const record = (r) => { results.push(r); console.log(`${r.level === 'fail' ? '✗' : r.level === 'warn' ? '△' : '✓'}  ${r.name}：${r.summary}`); };
const missing = (d) => ['capital', 'owner', 'address'].filter((k) => !(d && d[k]));

// 1. 用統編查（每天自動更新走的路）
{
  const started = Date.now();
  const res = await Registry.lookupByTaxId(Registry.PROBE_TAXID);
  const lack = res.ok ? missing(res.data) : [];
  record({
    name: '用統編查',
    level: !res.ok ? 'fail' : lack.length ? 'fail' : 'ok',
    summary: !res.ok ? `查不到（${(res.attempts || []).length} 種寫法都試過）`
      : lack.length ? `查到了，但缺 ${lack.join('、')}（來源：${res.label}）`
        : `${res.data.name}｜資本總額 ${res.data.capital} 仟元｜${res.data.owner}｜${res.label}${res.partial ? '（部分欄位）' : ''}`,
    ms: Date.now() - started,
    label: res.label || '',
    url: res.url || '',
    unmappedKeys: (res.data && res.data.unmappedKeys) || [],
    attempts: (res.attempts || []).map((a) => ({ label: a.label, reason: a.reason, body: a.body, url: a.upstream || a.url })),
  });
}

// 2. 用名稱查（連結關係企業、沒統編的客戶走的路）
{
  const started = Date.now();
  const res = await Registry.probeNameQuery();
  record({
    name: '用公司名查',
    level: res.ok ? 'ok' : 'warn',
    summary: res.ok ? `查得到「${res.name}」（${res.label}）` : `查不到「${res.name}」，${res.attempts.length} 種寫法都試過`,
    ms: Date.now() - started,
    attempts: res.attempts.map((a) => ({ label: a.label, reason: a.reason, body: a.body, url: a.upstream || a.url })),
  });
}

// 3. 名稱查詢那支資料集本身活著沒（拿統編去試同一支）
{
  const started = Date.now();
  const res = await Registry.probeBaseWithTaxId();
  record({
    name: '關鍵字資料集（拿統編試）',
    level: res.ok ? 'ok' : 'warn',
    summary: res.ok ? `資料集活著（${res.label}）` : '這支資料集用統編也查不到，可能已停用或改編號',
    ms: Date.now() - started,
    attempts: (res.attempts || []).map((a) => ({ label: a.label, reason: a.reason, body: a.body, url: a.upstream || a.url })),
  });
}

// 4. g0v 鏡像（使用者勾選啟用時的備援）
{
  const started = Date.now();
  const url = Registry.SOURCES.g0v.byTaxId(Registry.PROBE_TAXID)[0];
  try {
    const res = await fetchLikeBrowser(url, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    let data = null;
    try { const json = JSON.parse(text); data = Registry.mapRow(json && json.data ? json.data : json); } catch (e) { /* 不是 JSON，下面照實報 */ }
    const lack = missing(data);
    record({
      name: 'g0v 鏡像',
      level: res.ok && data && data.taxId ? (lack.length ? 'warn' : 'ok') : 'warn',
      summary: !res.ok ? `HTTP ${res.status}` : !data || !data.taxId ? `回的不是預期的格式：${text.replace(/\s+/g, ' ').slice(0, 200)}`
        : lack.length ? `查得到但缺 ${lack.join('、')}` : `${data.name}｜資本總額 ${data.capital} 仟元`,
      ms: Date.now() - started,
      url,
    });
  } catch (err) {
    record({ name: 'g0v 鏡像', level: 'warn', summary: `連不上：${err.name}: ${err.message}`, ms: Date.now() - started, url });
  }
}

const failed = results.filter((r) => r.level === 'fail');
const warned = results.filter((r) => r.level === 'warn');
const when = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

const md = [
  `## 商工登記查詢健檢 — ${failed.length ? '❌ 失敗' : warned.length ? '⚠️ 通了但有警告' : '✅ 通過'}`,
  '',
  `檢查時間：${when}（台灣）　樣本：台積電 ${Registry.PROBE_TAXID}`,
  '',
  '| 檢查 | 結果 | 說明 | 耗時 |',
  '|---|---|---|---|',
  ...results.map((r) => `| ${r.name} | ${r.level === 'fail' ? '❌' : r.level === 'warn' ? '⚠️' : '✅'} | ${r.summary.replace(/\|/g, '／')} | ${r.ms} ms |`),
  '',
];
const firstUnmapped = results.find((r) => r.unmappedKeys && r.unmappedKeys.length);
if (firstUnmapped) {
  md.push(`政府回傳裡有網站還沒對應的欄位（不影響功能，只是提醒）：\`${firstUnmapped.unmappedKeys.join('`、`')}\``, '');
}
const detail = results.filter((r) => r.attempts && r.attempts.length);
if (detail.length) {
  md.push('<details><summary>每一次嘗試的網址與回應</summary>', '');
  detail.forEach((r) => {
    md.push(`**${r.name}**`, '');
    r.attempts.forEach((a) => md.push(`- ${a.label}：${a.reason}${a.body ? `｜${String(a.body).slice(0, 200)}` : ''}  \n  \`${a.url}\``));
    md.push('');
  });
  md.push('</details>', '');
}
if (failed.length) {
  md.push('用統編查不通的話，網站的「每天自動更新」與「從商工登記更新公司資料」都會變成「查了查不到」。',
    '先到設定視窗按「先試一筆」看實際回什麼；資料集編號改了的話，設定視窗可以直接換，不用改版。', '');
}

await fs.writeFile('registry-check.md', md.join('\n'), 'utf8');
await fs.writeFile('registry-check.json', JSON.stringify({ when, results }, null, 2), 'utf8');
console.log(`\n報告已寫入 registry-check.md${failed.length ? '（健檢失敗）' : ''}`);
process.exit(failed.length ? 1 : 0);
