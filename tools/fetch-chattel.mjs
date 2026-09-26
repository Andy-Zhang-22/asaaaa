/**
 * 抓新北市「動產擔保登記清冊」，整理成網站「快到期」分頁讀的 CSV。
 *
 * 來源：新北市政府經濟發展局開放資料
 *   https://data.ntpc.gov.tw/datasets/5a6fda8d-c383-42de-a309-67df68d85495
 *   API：https://data.ntpc.gov.tw/api/datasets/<id>/json?page=N&size=500
 * 每月更新，每次都是「從 1995 年累積到現在的全部案件」（約兩萬筆），不是當月新增。
 *
 * 只能在 GitHub Actions 跑：開發環境連不上政府網站，政府網站也沒有 CORS，瀏覽器抓不到。
 * Actions 抓好放回 repo，網站再從自己的網址讀。
 *
 * 兩個陷阱，都在這裡處理掉，網站那邊拿到的就是乾淨的「客戶／金主」：
 *   1. 欄位名叫 coma（債務人）／comb（債權人），但附條件買賣的角色是反的：租賃公司出現在
 *      coma 那一欄。照欄位名一律把 coma 當客戶，會把一半的同業當成客戶名單。
 *      先看名字：哪一方看起來是租賃／銀行／融資公司，哪一方就是金主；兩邊都看不出來才按
 *      案件類別的慣例（動產抵押 coma 是客戶、附條件買賣 comb 是客戶）。
 *   2. 欄位名寫 roc，值卻是西元 8 碼（20190829）。轉成 2019/08/29。
 *
 * 只留「還沒註銷」的案件（約一萬筆）：註銷的不會再到期，網站也用不到。
 *
 * 抓的時候要慢：一次 1000 筆連抓會被對方斷線。一頁 500、頁與頁之間停一下、失敗重試。
 *
 * 用法：node tools/fetch-chattel.mjs [--out leads/chattel] [--pages N] [--probe]
 *   --pages N 只抓前 N 頁（測試用）
 *   --probe 只印統計，不寫檔
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ID = '5a6fda8d-c383-42de-a309-67df68d85495';
const PAGE_URL = `https://data.ntpc.gov.tw/datasets/${ID}`;
const API = `https://data.ntpc.gov.tw/api/datasets/${ID}/json`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const SIZE = 500;
const NAP_MS = 700;
const HEAD = ['案件類別', '登記編號', '客戶統編', '客戶名稱', '金主統編', '金主名稱', '契約起', '契約迄', '擔保金額', '標的物所在地', '標的物件數', '登記核准日', '註銷日', '成立日期'];
// 成立日期是抓完之後由 tools/fill-founded.mjs --source chattel 查商工登記填的（民國），這裡留空

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt; };
const PROBE = args.includes('--probe');
const OUT = opt('out', 'leads/chattel');
const MAX_PAGES = Number(opt('pages', 0)) || 200;

const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(90000) });

/** 看名字像不像金主（租賃、銀行、融資、資融…）。 */
const LENDER_RE = /租賃|銀行|商銀|融資|資融|金融|信託|保險|資產管理|信用合作社|信合社|農會|漁會|票券|中租|和潤|新鑫|合迪|裕融|日盛|國際租|租賃業/;
const looksLender = (name) => LENDER_RE.test(String(name || ''));

/** 20190829 → 2019/08/29；空白或格式不對 → ''。 */
function ymd(s) {
  const t = String(s || '').trim();
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}/${t.slice(4, 6)}/${t.slice(6, 8)}`;
  if (/^\d{7}$/.test(t)) return `${+t.slice(0, 3) + 1911}/${t.slice(3, 5)}/${t.slice(5, 7)}`;   // 萬一哪天真的改成民國
  return '';
}

/**
 * 誰是客戶、誰是金主。回傳 { cust:{id,name}, lender:{id,name}, how }。
 * how：'name'（看名字判定）、'type'（按案件類別慣例）。
 */
export function rolesOf(r) {
  const a = { id: String(r.comaid || '').trim(), name: String(r.comaname || '').trim() };
  const b = { id: String(r.combid || '').trim(), name: String(r.combname || '').trim() };
  const la = looksLender(a.name);
  const lb = looksLender(b.name);
  if (la && !lb) return { cust: b, lender: a, how: 'name' };
  if (lb && !la) return { cust: a, lender: b, how: 'name' };
  // 兩邊都像或都不像：附條件買賣的出賣人在 coma，其餘（動產抵押、信託占有）債務人在 coma
  const type = String(r.casetype || '');
  if (/附條件|買賣/.test(type)) return { cust: b, lender: a, how: 'type' };
  return { cust: a, lender: b, how: 'type' };
}

export function toRow(r) {
  const { cust, lender, how } = rolesOf(r);
  return {
    type: String(r.casetype || '').trim(),
    no: String(r.caseno || '').trim(),
    cust, lender, how,
    start: ymd(r.casesyyyymmddroc), end: ymd(r.caseeyyyymmddroc),
    amount: String(r.casetatol || '').replace(/[^\d]/g, ''),
    addr: String(r.caseaddr || '').replace(/\s+/g, ' ').trim(),
    // caseitemno 是標的物「件數」（0、1、2…），不是標的物內容；清冊上沒有標的物內容
    items: String(r.caseitemno || '').replace(/\D/g, ''),
    approved: ymd(r.caseayyyymmddroc),
    cancelled: ymd(r.casecanyyyymmddroc),
  };
}

const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows) => `﻿${[HEAD, ...rows.map((x) => [x.type, x.no, x.cust.id, x.cust.name, x.lender.id, x.lender.name, x.start, x.end, x.amount, x.addr, x.items, x.approved, x.cancelled, ''])]
  .map((row) => row.map(csvCell).join(',')).join('\n')}\n`;

async function fetchAll() {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let batch = null;
    for (let attempt = 1; attempt <= 4 && !batch; attempt++) {
      try {
        const res = await get(`${API}?page=${page}&size=${SIZE}`);
        const text = await res.text();
        if (!res.ok || !text.trim().startsWith('[')) throw new Error(`HTTP ${res.status}，回的不是陣列：${text.slice(0, 80)}`);
        batch = JSON.parse(text);
      } catch (e) {
        console.log(`page ${page} 第 ${attempt} 次失敗：${e.message}`);
        if (attempt === 4) throw new Error(`第 ${page} 頁連抓四次都失敗，這次不寫檔`);
        await nap(2500 * attempt);
      }
    }
    if (!batch.length) break;
    rows.push(...batch);
    if (page % 10 === 0) console.log(`page ${page}：累計 ${rows.length}`);
    if (batch.length < SIZE) break;
    await nap(NAP_MS);
  }
  return rows;
}

const tally = (list, key) => { const m = new Map(); list.forEach((x) => { const k = key(x); m.set(k, (m.get(k) || 0) + 1); }); return [...m.entries()].sort((a, b) => b[1] - a[1]); };

async function main() {
  console.log(`抓 ${PAGE_URL}`);
  const raw = await fetchAll();
  console.log(`共 ${raw.length} 筆`);
  if (!raw.length) throw new Error('一筆都沒抓到');
  const all = raw.map(toRow);
  const live = all.filter((x) => !x.cancelled);
  const generatedAt = new Date().toISOString();
  const dataThrough = all.map((x) => x.approved).filter(Boolean).sort().pop() || '';
  console.log(`未註銷 ${live.length} 筆；登記核准日最晚 ${dataThrough}`);
  console.log('案件類別：'); tally(live, (x) => x.type).forEach(([k, n]) => console.log(`   ${k || '（空）'}　${n}`));
  console.log('角色怎麼判的：'); tally(live, (x) => x.how).forEach(([k, n]) => console.log(`   ${k}　${n}`));
  console.log('金主前 12 名：'); tally(live, (x) => x.lender.name).slice(0, 12).forEach(([k, n]) => console.log(`   ${k || '（空）'}　${n}`));
  const odd = live.filter((x) => looksLender(x.cust.name)).length;
  console.log(`客戶那一欄看起來還是金主的：${odd} 筆（兩邊都是金融業，網站上預設藏起來）`);
  if (PROBE) { console.log('（--probe，不寫檔）'); return; }

  await fs.mkdir(OUT, { recursive: true });
  const csvPath = path.join(OUT, 'ntpc.csv');
  await fs.writeFile(csvPath, toCsv(live));
  const index = {
    generatedAt, dataThrough, total: all.length, kept: live.length,
    source: { name: '新北市動產擔保登記清冊（新北市政府經濟發展局）', page: PAGE_URL },
    types: Object.fromEntries(tally(live, (x) => x.type)),
    files: [{ path: 'ntpc.csv', rows: live.length }],
  };
  await fs.writeFile(path.join(OUT, 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
  const size = (await fs.stat(csvPath)).size;
  console.log(`寫入 ${csvPath}（${(size / 1024 / 1024).toFixed(1)} MB）與 index.json`);
}

if (process.argv[1] && /fetch-chattel\.mjs$/.test(process.argv[1])) {
  main().catch((err) => { console.error(`✗ ${err.message}`); process.exit(1); });
}
