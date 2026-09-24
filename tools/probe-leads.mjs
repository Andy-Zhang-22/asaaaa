/**
 * 探測「找新客戶」的資料來源，第二回合：每月清冊 PDF 長什麼樣。
 *
 * 第一回合（見 git 歷史）查到的事：
 *   - 商工開放資料 API 不管帶什麼範圍條件都回空的，只能一家一家用統編查，不是撈整批的路。
 *   - serv.gcis.nat.gov.tw/pub/cmpy/reportCity.jsp 直接列出每個縣市、每個月的
 *     設立／變更／解散清冊下載網址，不用 session：
 *       reportAction.do?method=report&reportClass=cmpyCity&subPath=YYYMM&fileName=<縣市代碼><setup|change|rest>YYYMM.pdf
 *   - 沒有 CORS，瀏覽器不能直接抓，所以要由 Actions 抓下來、轉成 CSV 放回 repo。
 *
 * 這一回合要看的是 PDF 的版面：pdftotext -layout 之後每一列長什麼樣、欄位順序、
 * 有沒有變更事項，才寫得出解析。只讀不寫。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';

const UA = 'asaaaa-list-updater/1.0 (+https://github.com/Andy-Zhang-22/asaaaa)';
const BASE = 'https://serv.gcis.nat.gov.tw/pub/cmpy/reportAction.do?method=report';
const CITY = { 新北市: '376410000A', 臺北市: '379100000G' };

async function fetchFile(url) {
  const started = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(120000) });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, ct: res.headers.get('content-type') || '', bytes: buf.length, buf, ms: Date.now() - started, url: res.url };
}

// 最新一期：從 reportCity.jsp 的 YYYMM 下拉抓第一個
let latest = '11508';
{
  const r = await fetchFile('https://serv.gcis.nat.gov.tw/pub/cmpy/reportCity.jsp');
  const html = r.buf.toString('utf8');
  const m = html.match(/<select[^>]*name="YYYMM"[^>]*>[\s\S]*?<option[^>]*value="(\d{5})"/i);
  if (m) latest = m[1];
  console.log(`reportCity.jsp ${r.status} ${r.bytes} bytes；最新一期 ${latest}`);
}

const jobs = [
  ['新北市', 'change', 'cmpyCity'],
  ['新北市', 'setup', 'cmpyCity'],
  ['新北市', 'change', 'cmpyCityItem'],
  ['臺北市', 'change', 'cmpyCity'],
];
for (const [city, type, cls] of jobs) {
  for (const ext of ['pdf', 'csv', 'xlsx']) {
    const name = `${CITY[city]}${type}${latest}.${ext}`;
    const url = `${BASE}&reportClass=${cls}&subPath=${latest}&fileName=${name}`;
    let r;
    try { r = await fetchFile(url); } catch (err) { console.log(`\n### ${city} ${type} ${cls} .${ext}：ERROR ${err.message}`); continue; }
    const magic = r.buf.slice(0, 4).toString('latin1');
    console.log(`\n### ${city} ${type} ${cls} .${ext}：${r.status}　${r.ct}　${r.bytes} bytes　${r.ms}ms　開頭=${JSON.stringify(magic)}`);
    if (ext !== 'pdf') {
      // 不是 PDF 的話看它回什麼（多半是錯誤頁或就是沒有這種格式）
      const t = r.buf.toString('utf8').replace(/\s+/g, ' ').slice(0, 300);
      console.log(t);
      continue;
    }
    if (magic !== '%PDF') { console.log(r.buf.toString('utf8').replace(/\s+/g, ' ').slice(0, 400)); continue; }
    const file = `/tmp/${name}`;
    await fs.writeFile(file, r.buf);
    try {
      const info = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
      console.log(info.split('\n').filter((l) => /Pages|Page size|Producer|Creator/.test(l)).join('　'));
      const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const lines = text.split('\n');
      console.log(`pdftotext -layout：共 ${lines.length} 行`);
      console.log('--- 前 70 行 ---');
      console.log(lines.slice(0, 70).join('\n'));
      console.log('--- 第 2 頁開頭 20 行（看跨頁表頭） ---');
      const p2 = text.indexOf('\f');
      if (p2 > 0) console.log(text.slice(p2 + 1).split('\n').slice(0, 20).join('\n'));
      // 不帶 -layout 的版本：有時欄位分隔比較清楚
      const raw = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      console.log('--- 不帶 -layout 的前 40 行 ---');
      console.log(raw.split('\n').slice(0, 40).join('\n'));
    } catch (err) {
      console.log(`pdftotext 失敗：${err.message}`);
    }
  }
}
console.log('\n探測完畢');
