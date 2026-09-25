/**
 * 撈每月的公司設立／變更登記清冊，轉成網站匯入功能認得的 CSV。
 *
 * 來源：serv.gcis.nat.gov.tw/pub/cmpy/reportCity.jsp 列出的「公司所營事業項目清冊」PDF，
 *   reportAction.do?method=report&reportClass=cmpyCityItem&subPath=YYYMM&fileName=<縣市代碼><setup|change>YYYMM.pdf
 * 選這一份而不是基本清冊，是因為它多了兩欄：「案由或變更事項」（增資、公司所在地、
 * 負責人變更…）與「營業項目」代碼。要找的是「剛增資的製造業」，這兩欄就是關鍵。
 *
 * 只能在 GitHub Actions 跑：開發環境連不上政府網站，而政府網站沒有 CORS，瀏覽器也
 * 抓不到。所以由 Actions 每月抓一次、解析成 CSV 放回 repo，網站再從自己的網址讀。
 *
 * 解析用 pdftotext -tsv（每個字帶座標），不用 -layout 的純文字：清冊的儲存格會換行，
 * 換行那一截在 -layout 裡的字元位置會跟主列對不上（中文字寬不均），照欄位字元數切
 * 會把地址的下半段接到代表人去。座標不會騙人：JasperReports 的欄位左緣整份文件固定。
 *
 * 用法：node tools/fetch-leads.mjs [--period 11508] [--cities 新北市,臺北市] [--types change,setup]
 *       [--out leads] [--probe]
 *   --probe 只印解析結果的樣本與統計，不寫檔。
 *   --prune N 只留最近 N 期（給排程用），其餘都不做。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const UA = 'asaaaa-list-updater/1.0 (+https://github.com/Andy-Zhang-22/asaaaa)';
const REPORT_PAGE = 'https://serv.gcis.nat.gov.tw/pub/cmpy/reportCity.jsp';
const BASE = 'https://serv.gcis.nat.gov.tw/pub/cmpy/reportAction.do?method=report';
// 預設抓服務範圍：新竹以北加宜蘭（跟網站的 SERVICE_CITIES 一致）
const DEFAULT_CITIES = ['新北市', '臺北市', '桃園市', '基隆市', '新竹市', '新竹縣', '宜蘭縣'];
const CITY_RE = /^(臺北市|台北市|新北市|桃園市|臺中市|台中市|臺南市|台南市|高雄市|基隆市|新竹市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義市|嘉義縣|屏東縣|宜蘭縣|花蓮縣|臺東縣|台東縣|澎湖縣|金門縣|連江縣)/;
const ORG_RE = /政府|商業處|商業發展署|經濟部|辦公區/;
const ITEM_CODE_RE = /^[A-Z]{1,2}\d{5,6}$/;
const DATE_RE = /^\d{3}\/\d{2}\/\d{2}$/;
const MONEY_RE = /^\d{1,3}(,\d{3})*$|^\d+$/;

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt; };
const PROBE = args.includes('--probe');
const OUT = opt('out', 'leads');
const TYPES = opt('types', 'change,setup').split(',');
const CITIES = opt('cities', DEFAULT_CITIES.join(',')).split(',').map((c) => c.replace(/^台/, '臺'));

async function fetchBuf(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 從查詢頁拿最新一期與縣市代碼（代碼會變，不寫死）。 */
async function discover() {
  const html = (await fetchBuf(REPORT_PAGE)).toString('utf8');
  const sel = (name) => {
    const m = html.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`, 'i'));
    if (!m) return [];
    const out = [];
    const re = /<option[^>]*value="([^"]*)"[^>]*>([^<]*)</gi;
    let o;
    while ((o = re.exec(m[1])) !== null) out.push([o[1].trim(), o[2].replace(/\s+/g, '')]);
    return out.filter(([v]) => v && v !== 'xxx');
  };
  const periods = sel('YYYMM').map(([v]) => v);
  const cities = {};
  sel('area').forEach(([code, label]) => { cities[label.replace(/政府$/, '').replace(/^台/, '臺')] = code; });
  return { periods, cities };
}

/* ---------------- PDF → 文字座標 → 紀錄 ---------------- */

function words(file) {
  const tsv = execFileSync('pdftotext', ['-tsv', file, '-'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = [];
  for (const line of tsv.split('\n').slice(1)) {
    const c = line.split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    const text = c[11].trim();
    if (!text || text.startsWith('###')) continue;
    out.push({ page: +c[1], x: +c[6], y: +c[7], w: +c[8], text });
  }
  return out;
}

/** 同一頁、y 差不到 3pt 的字算同一行；行內照 x 排。 */
function lines(ws) {
  ws.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const out = [];
  let cur = null;
  for (const w of ws) {
    if (!cur || cur.page !== w.page || Math.abs(cur.y - w.y) > 3) { cur = { page: w.page, y: w.y, words: [] }; out.push(cur); }
    cur.words.push(w);
  }
  out.forEach((l) => l.words.sort((a, b) => a.x - b.x));
  return out;
}

const isMainRow = (l) => l.words.length > 2 && /^\d+$/.test(l.words[0].text) && /^\d{8}$/.test(l.words[1].text);
const isChrome = (l) => {
  const t = l.words.map((w) => w.text).join('');
  return /清冊|產製|頁\/共|序號|統一編號|登記機關/.test(t) || /^\d{3}\.\d{2}(變更|設立|解散)/.test(l.words[0].text);
};

/*
 * 這幾份清冊都是同一套 JasperReports 範本印的，欄位左緣整份文件固定，而且各縣市一樣
 * （實測 115/08 七個縣市全部是這組數字）。量得出來就用量的；量不出來（樣本太少、
 * 某縣市的排版有怪東西）就退回這組，並在 log 講明是退回的。
 */
const KNOWN_EDGES = { company: 176, owner: 276, address: 342, capitalRight: 519, date: 534.75, reason: 592, item: 662 };
// 設立清冊沒有「案由」欄，營業項目往左移到案由的位置
const KNOWN_ITEM_WITHOUT_REASON = 592;

/**
 * 第一趟：從主列量出每一欄的左緣。
 *
 * 用「錨點」各自找，不要求整列照固定順序都認得出來：日期找 115/08/18 那個字、資本額是
 * 日期前一個純數字、地址是資本額前面最後一個以縣市開頭的字、營業項目是日期後第一個代碼。
 * 第一版要求整列依序全對才算樣本，桃園的清冊只有 5% 的列過關、設立清冊只剩 2 列，
 * 量不出欄位整份就丟掉了——其實第二趟照座標分欄對桃園完全沒問題，是量的這一趟太挑。
 */
function measure(ls) {
  const acc = { company: [], owner: [], address: [], capitalRight: [], date: [], reason: [], item: [] };
  for (const l of ls) {
    if (!isMainRow(l)) continue;
    const w = l.words;
    const dateAt = w.findIndex((x, k) => k >= 4 && DATE_RE.test(x.text));
    if (dateAt < 0) continue;
    acc.date.push(w[dateAt].x);
    const capital = w[dateAt - 1];
    if (capital && MONEY_RE.test(capital.text)) acc.capitalRight.push(capital.x + capital.w);
    let addrAt = -1;
    for (let k = dateAt - 2; k >= 3; k--) { if (CITY_RE.test(w[k].text)) { addrAt = k; break; } }
    if (addrAt >= 0) acc.address.push(w[addrAt].x);
    if (ORG_RE.test(w[2].text) && w[3] && addrAt !== 3) {
      acc.company.push(w[3].x);
      // 公司名稱與地址之間還有字＝代表人（外國人名會是好幾個字，取第一個）
      if (addrAt > 4) acc.owner.push(w[4].x);
    }
    const rest = w.slice(dateAt + 1);
    const itemAt = rest.findIndex((x) => ITEM_CODE_RE.test(x.text));
    if (itemAt > 0) acc.reason.push(rest[0].x);
    if (itemAt >= 0) acc.item.push(rest[itemAt].x);
  }
  /*
   * 左緣取「最小值」但要擋離群值：幾千列裡偶爾一列公司名有空格，第二截會被當成代表人，
   * 它的 x 比真正的代表人欄小很多。取第 2 百分位而不是最小值，少數怪列不會把整欄拉歪；
   * 樣本少的檔案（基隆設立 17 列）第 2 百分位就是最小值，沒差。
   */
  const low = (arr) => { if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y); return a[Math.floor(a.length * 0.02)]; };
  const high = (arr) => { if (!arr.length) return null; const a = arr.slice().sort((x, y) => y - x); return a[Math.floor(a.length * 0.02)]; };
  const measured = { company: low(acc.company), owner: low(acc.owner), address: low(acc.address), capitalRight: high(acc.capitalRight), date: low(acc.date), reason: low(acc.reason), item: low(acc.item) };
  const e = { samples: acc.date.length, fallback: [] };
  // 設立清冊沒有案由欄：量不到就是沒有，而且營業項目的已知左緣要換成沒有案由的那一組。
  // 第一版沒換，設立清冊量到的 592 被當成「差太多」退回 662，營業項目整欄變成案由。
  const hasReason = measured.reason !== null;
  const known = { ...KNOWN_EDGES, item: hasReason ? KNOWN_EDGES.item : KNOWN_ITEM_WITHOUT_REASON };
  for (const k of Object.keys(known)) {
    const v = measured[k];
    // 量到的跟已知差太多也不信（>25pt 代表抓錯錨點），退回已知值
    if (v === null || Math.abs(v - known[k]) > 25) { e[k] = known[k]; if (k !== 'reason' && k !== 'owner') e.fallback.push(k); }
    else e[k] = v;
  }
  if (!hasReason) e.reason = null;
  return e;
}

/** 第二趟：每個字照 x 落在哪一欄，主列開新紀錄、其餘行接到上一筆。 */
function parse(ls, e) {
  const TOL = 4;
  const col = (w, main) => {
    const x = w.x + TOL;
    if (e.item !== null && x >= e.item) return 'item';
    if (e.reason !== null && x >= e.reason) return 'reason';
    if (e.date !== null && x >= e.date) return DATE_RE.test(w.text) ? 'date' : 'dateExtra';
    if (x >= e.address) return MONEY_RE.test(w.text) && main ? 'capital' : 'address';
    if (e.owner !== null && x >= e.owner) return 'owner';
    if (x >= e.company) return 'company';
    return 'org';
  };
  const glue = (a, b) => (a && /[A-Za-z0-9)]$/.test(a) && /^[A-Za-z0-9(]/.test(b) ? `${a} ${b}` : `${a}${b}`);
  const records = [];
  let cur = null;
  let pageOfCur = -1;
  const oddities = [];
  for (const l of ls) {
    if (isChrome(l)) continue;
    if (isMainRow(l)) {
      cur = { seq: +l.words[0].text, taxId: l.words[1].text, org: '', company: '', owner: '', address: '', capital: '', date: '', reason: '', itemLines: [], page: l.page };
      records.push(cur);
      pageOfCur = l.page;
      let itemLine = [];
      for (const w of l.words.slice(2)) {
        const c = col(w, true);
        if (c === 'item') itemLine.push(w.text);
        else if (c === 'dateExtra') cur.reason = glue(cur.reason, w.text);
        else cur[c] = glue(cur[c], w.text);
      }
      if (itemLine.length) cur.itemLines.push(itemLine.join(' '));
      continue;
    }
    if (!cur) continue;
    // 續行：只接同一頁或緊接的下一頁（跨頁時表頭已被 isChrome 濾掉）
    if (l.page !== pageOfCur && l.page !== pageOfCur + 1) { oddities.push(`p${l.page} 孤立行：${l.words.map((w) => w.text).join(' ')}`); continue; }
    let itemLine = [];
    for (const w of l.words) {
      const c = col(w, false);
      if (c === 'item') itemLine.push(w.text);
      else if (c === 'capital' || c === 'date' || c === 'dateExtra') oddities.push(`p${l.page} 續行落在 ${c}：${w.text}`);
      else cur[c] = glue(cur[c], w.text);
    }
    if (itemLine.length) cur.itemLines.push(itemLine.join(' '));
  }
  // 營業項目：以代碼開頭的是一項，其餘是上一項說明的換行
  records.forEach((r) => {
    const items = [];
    r.itemLines.forEach((line) => {
      const m = line.match(/^([A-Z]{1,2}\d{5,6})\s*(.*)$/);
      if (m) items.push({ code: m[1], name: m[2] });
      else if (items.length) items[items.length - 1].name += line;
    });
    r.items = items;
    delete r.itemLines;
    r.capitalNum = Number(String(r.capital).replace(/,/g, '')) || 0;
  });
  return { records, oddities };
}

/* ---------------- CSV ---------------- */

const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function toCsv(records, { city, type, period }) {
  // 設立、變更兩欄都放：網站會把幾份清冊合成一份匯入，欄位要對得上
  const head = ['統一編號', '公司名稱', '公司所在地', '代表人', '資本額', '核准設立日期', '核准變更日期', '案由或變更事項', '營業項目', '縣市', '清冊', '期別'];
  const rows = records.map((r) => [
    r.taxId, r.company, r.address, r.owner, r.capitalNum, type === 'setup' ? r.date : '', type === 'setup' ? '' : r.date, r.reason,
    r.items.map((i) => `${i.code} ${i.name}`).join('；'), city, type === 'setup' ? '設立' : '變更', period,
  ]);
  return `﻿${[head, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

/* ---------------- 只留最近幾期 ---------------- */

if (args.includes('--prune')) {
  const keep = Number(opt('prune', '6')) || 6;
  let all = { periods: {} };
  try { all = JSON.parse(await fs.readFile(path.join(OUT, 'index.json'), 'utf8')); } catch (e) { console.log('沒有 index.json，不用清'); process.exit(0); }
  const keys = Object.keys(all.periods || {}).sort();
  const drop = keys.slice(0, Math.max(0, keys.length - keep));
  for (const k of drop) {
    await fs.rm(path.join(OUT, k), { recursive: true, force: true });
    delete all.periods[k];
  }
  all.latest = Object.keys(all.periods).sort().pop() || null;
  await fs.writeFile(path.join(OUT, 'index.json'), `${JSON.stringify(all, null, 1)}\n`, 'utf8');
  console.log(`留 ${keep} 期，清掉 ${drop.length} 期${drop.length ? `：${drop.join('、')}` : ''}`);
  process.exit(0);
}

/* ---------------- 主流程 ---------------- */

const { periods, cities } = await discover();
const period = opt('period', periods[0]);
if (!period) throw new Error('查詢頁上找不到期別');
console.log(`期別 ${period}（查詢頁最新 ${periods[0]}）；縣市代碼 ${Object.keys(cities).length} 個`);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'leads-'));
const index = { generatedAt: new Date().toISOString(), period, files: [] };
for (const city of CITIES) {
  const code = cities[city];
  if (!code) { console.log(`跳過 ${city}：查詢頁上沒有這個縣市`); continue; }
  for (const type of TYPES) {
    const name = `${code}${type}${period}.pdf`;
    const url = `${BASE}&reportClass=cmpyCityItem&subPath=${period}&fileName=${name}`;
    const started = Date.now();
    let buf;
    try { buf = await fetchBuf(url); } catch (err) { console.log(`\n${city} ${type}：下載失敗 ${err.message}`); continue; }
    if (buf.slice(0, 4).toString('latin1') !== '%PDF') { console.log(`\n${city} ${type}：不是 PDF（${buf.length} bytes）`); continue; }
    const file = path.join(tmp, name);
    await fs.writeFile(file, buf);
    const ls = lines(words(file));
    const e = measure(ls);
    if (e.samples < 1) { console.log(`\n${city} ${type}：找不到任何主列`, e); continue; }
    if (e.fallback.length) console.log(`\n${city} ${type}：${e.fallback.join('、')} 量不出來，用已知的欄位左緣`);
    const { records, oddities } = parse(ls, e);
    const bad = records.filter((r) => !r.company || !r.address || !r.capitalNum || !r.date);
    const reasons = {};
    records.forEach((r) => { const k = r.reason || '（空）'; reasons[k] = (reasons[k] || 0) + 1; });
    console.log(`\n${city} ${type}：${(buf.length / 1024).toFixed(0)} KB，${records.length} 筆，欄位不齊 ${bad.length} 筆，${Date.now() - started}ms`);
    console.log(`  欄位左緣 ${JSON.stringify(e)}`);
    console.log(`  案由分布：${Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k} ${v}`).join('、')}`);
    if (PROBE) {
      const show = (r) => console.log(`  #${r.seq} ${r.taxId} ${r.company}｜${r.owner}｜${r.address}｜${r.capital}｜${r.date}｜${r.reason}｜${r.items.slice(0, 3).map((i) => `${i.code} ${i.name}`).join('；')}${r.items.length > 3 ? `…共 ${r.items.length}` : ''}`);
      console.log('  -- 前 6 筆 --'); records.slice(0, 6).forEach(show);
      console.log('  -- 有換行的幾筆（公司名或地址較長） --');
      records.filter((r) => r.company.length > 12 || r.address.length > 16).slice(0, 4).forEach(show);
      console.log('  -- 增資的前 4 筆 --'); records.filter((r) => /增資|發行新股/.test(r.reason)).slice(0, 4).forEach(show);
      if (bad.length) { console.log('  -- 欄位不齊 --'); bad.slice(0, 5).forEach(show); }
      if (oddities.length) console.log(`  -- 異常 ${oddities.length} 則 --\n  ${oddities.slice(0, 8).join('\n  ')}`);
      continue;
    }
    const rel = path.join(period, `${city}-${type}.csv`);
    await fs.mkdir(path.join(OUT, period), { recursive: true });
    await fs.writeFile(path.join(OUT, rel), toCsv(records, { city, type, period }), 'utf8');
    index.files.push({ city, type, path: rel, rows: records.length, capitalUp: records.filter((r) => /增資|發行新股/.test(r.reason)).length });
  }
}
if (!PROBE) {
  // index.json 累積各期：網站只讀這一個檔就知道有哪些可以抓
  let all = { periods: {} };
  try { all = JSON.parse(await fs.readFile(path.join(OUT, 'index.json'), 'utf8')); } catch (e) { /* 第一次 */ }
  all.periods = all.periods || {};
  // 同一期照「縣市＋清冊」合併：只抓一個縣市時，其他縣市的檔案要留著，不能整期蓋掉
  const before = (all.periods[period] && all.periods[period].files) || [];
  const key = (f) => `${f.city}|${f.type}`;
  const fresh = new Set(index.files.map(key));
  index.files = [...before.filter((f) => !fresh.has(key(f))), ...index.files]
    .sort((a, b) => a.city.localeCompare(b.city, 'zh-Hant') || a.type.localeCompare(b.type));
  all.periods[period] = index;
  all.latest = Object.keys(all.periods).sort().pop();
  all.generatedAt = index.generatedAt;
  await fs.writeFile(path.join(OUT, 'index.json'), `${JSON.stringify(all, null, 1)}\n`, 'utf8');
  console.log(`\n已寫入 ${OUT}/index.json，${index.files.length} 個檔案`);
}
console.log('\n完成');
