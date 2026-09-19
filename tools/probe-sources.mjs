/**
 * 探測政府公司登記資料的各個來源，看哪一條路走得通。
 *
 * 為什麼需要這支：開發環境連不上政府網站（對外網路只開放 GitHub、npm 等少數網域），
 * 所以沒辦法在本機確認每個端點回什麼。GitHub Actions 的 runner 沒有這個限制，
 * 就讓它跑一次、把實際收到的東西記下來，再照著寫真正的解析程式。
 *
 * 這支只讀不寫，不會改到名單資料。
 */

const TAX_ID = process.env.PROBE_TAX_ID || '22099131';   // 台積電，公開資料，只是拿來當樣本

const SOURCES = [
  {
    key: 'findbiz-queryinit',
    title: '商工登記公示資料查詢服務（使用者指定的網址）',
    url: 'https://findbiz.nat.gov.tw/fts/query/QueryBar/queryInit.do',
    note: '這是給人操作的查詢畫面，預期拿到 HTML；要看它有沒有擋程式存取、需不需要 session。',
  },
  {
    key: 'gcis-od-company',
    title: '商工行政資料開放平臺：公司登記基本資料 API',
    url: `https://data.gcis.nat.gov.tw/od/data/api/5F64D864-61CB-4D0D-8AD9-492047CC1EA6?%24format=json&%24filter=Business_Accounting_NO%20eq%20${TAX_ID}&%24skip=0&%24top=1`,
    note: '官方開放資料，跟 findbiz 同一份來源。這是最該優先用的正規管道。',
  },
  {
    key: 'gcis-od-company-cors',
    title: '同上，但檢查 CORS 標頭（決定能不能直接從瀏覽器呼叫）',
    url: `https://data.gcis.nat.gov.tw/od/data/api/5F64D864-61CB-4D0D-8AD9-492047CC1EA6?%24format=json&%24filter=Business_Accounting_NO%20eq%20${TAX_ID}&%24skip=0&%24top=1`,
    headers: { Origin: 'https://andy-zhang-22.github.io' },
    note: '有 Access-Control-Allow-Origin 的話，網站就能自己查，不必經過這個排程。',
  },
  {
    key: 'gcis-report-city',
    title: '公司變更登記（增資）縣市統計查詢頁',
    url: 'https://serv.gcis.nat.gov.tw/pub/cmpy/reportCity.jsp',
    note: '使用者先前指定的增資名單來源。要看它是靜態頁還是要帶查詢參數。',
  },
];

const clip = (s, n) => (s.length > n ? s.slice(0, n) + `…（後略，共 ${s.length} 字）` : s);

async function probe(src) {
  const started = Date.now();
  const row = { ...src, ok: false };
  try {
    const res = await fetch(src.url, {
      redirect: 'follow',
      headers: {
        // 表明身分，不偽裝成一般瀏覽器
        'User-Agent': 'asaaaa-list-updater/1.0 (+https://github.com/Andy-Zhang-22/asaaaa)',
        'Accept': '*/*',
        ...(src.headers || {}),
      },
      signal: AbortSignal.timeout(45000),
    });
    const body = await res.text();
    row.ok = res.ok;
    row.status = res.status;
    row.contentType = res.headers.get('content-type') || '(無)';
    row.cors = res.headers.get('access-control-allow-origin') || '(沒有這個標頭)';
    row.bytes = Buffer.byteLength(body);
    row.sample = clip(body.replace(/\s+/g, ' ').trim(), 900);
    row.ms = Date.now() - started;
  } catch (err) {
    row.status = 'ERROR';
    row.error = `${err.name}: ${err.message}`;
    row.ms = Date.now() - started;
  }
  return row;
}

const rows = [];
for (const src of SOURCES) {
  const row = await probe(src);
  rows.push(row);
  console.log(`${row.ok ? '通' : '不通'}  ${row.status}  ${row.key}  ${row.ms}ms  ${row.bytes ?? 0} bytes`);
}

const md = [
  '# 政府資料來源探測結果',
  '',
  `探測時間：${new Date().toISOString()}`,
  `樣本統編：${TAX_ID}`,
  '',
  '| 來源 | 狀態 | Content-Type | CORS | 大小 |',
  '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.key} | ${r.status} | ${r.contentType || '-'} | ${r.cors || '-'} | ${r.bytes ?? 0} |`),
  '',
  '## 各來源細節',
  '',
  ...rows.flatMap((r) => [
    `### ${r.title}`,
    '',
    `- 網址：\`${r.url}\``,
    `- 用途：${r.note}`,
    `- 結果：${r.status}${r.error ? ` — ${r.error}` : ''}`,
    `- CORS 標頭：${r.cors || '-'}`,
    '',
    r.sample ? '```\n' + r.sample + '\n```' : '（沒有內容）',
    '',
  ]),
].join('\n');

const fs = await import('node:fs/promises');
await fs.writeFile('probe-report.md', md, 'utf8');
await fs.writeFile('probe-raw.json', JSON.stringify(rows, null, 2), 'utf8');
console.log('\n報告已寫入 probe-report.md');
