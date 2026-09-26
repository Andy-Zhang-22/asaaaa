/**
 * 把變更清冊的「核准設立日期」在夜裡先查好，填回 CSV。
 *
 * 為什麼要這支：變更清冊上只有核准變更日期，沒有設立日期，所以「成立幾年」這個條件
 * 原本是使用者打開分頁之後，由瀏覽器一家一家去查商工登記補的——一次一家、每家之間
 * 停 300 毫秒。六期的變更清冊有 52,793 列、47,378 個不重複統編，照那個速度要跑十幾個
 * 小時，而且分頁一切走瀏覽器就把計時器節流掉，等於停住。使用者說「我從中午跑到現在」。
 *
 * 成立年是公開資料，跟任何人的客戶名單都無關，所以這件事該在 Actions 上做一次、
 * 填進 CSV 給所有人用，而不是每個人自己的瀏覽器再跑一遍。
 *
 * 填的是 CSV 裡本來就有、只是空著的「核准設立日期」欄，格式跟隔壁的核准變更日期
 * 一樣用民國（115/08/18）——所以 leads.js 一行都不用改，它本來就讀這一欄。
 *
 * 查到的存進 leads/founded.json（統編 → 民國日期；空字串＝查過了、登記上沒有），
 * 跟著 repo 走。下個月只要查新出現的那幾千家，不用重查四萬多。
 *
 * 時間預算：--minutes 到了就收工，把查到的寫檔、正常結束。GitHub Actions 一個工作最多 6 小時，
 * 時間到會被直接砍掉、什麼都存不到，所以留一小時給存檔。使用者說「請跑到完為止」：收工時
 * 把「還剩幾家、是不是時間到」寫進 $GITHUB_OUTPUT，workflow 看到時間到還有剩，就自己再排
 * 下一輪接著查，直到沒有剩的為止。
 *
 * 動產擔保名單也用這一支（--source chattel）：leads/chattel/ntpc.csv 的「客戶統編」查成立日期，
 * 填進「成立日期」欄。快取另外放 leads/chattel/founded.json，只讀 leads/founded.json 當種子
 * 不寫回去——兩支 workflow 各自 commit 自己的檔，才不會在 main 上互相衝突。
 * 查的順序照契約迄日，快到期的先查：時間到了沒查完，先有的也是最要緊的那幾家。
 *
 * 用法：node tools/fill-founded.mjs [--source leads|chattel] [--out leads] [--minutes 240]
 *                                   [--concurrency 6] [--limit N] [--dry]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { loadModules } = require('../tests/load.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const OUT = opt('out', 'leads');
const SOURCE = opt('source', 'leads');
const MINUTES = Number(opt('minutes', '240')) || 240;
const CONC = Math.max(1, Math.min(12, Number(opt('concurrency', '6')) || 6));
const LIMIT = Number(opt('limit', '0')) || 0;
const DRY = args.includes('--dry');
const CHATTEL = SOURCE === 'chattel';
const CACHE = CHATTEL ? path.join(OUT, 'chattel', 'founded.json') : path.join(OUT, 'founded.json');
const SEED = CHATTEL ? path.join(OUT, 'founded.json') : '';   // 只讀、不寫回
const DEADLINE = Date.now() + MINUTES * 60000;

// 政府網站對沒有瀏覽器 UA 的請求有時直接回空白，跟每週健檢用同一個
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const fetchLikeBrowser = (url, init = {}) => fetch(url, {
  ...init,
  headers: { ...(init.headers || {}), 'User-Agent': UA },
  signal: init.signal || AbortSignal.timeout(30000),
});
const { Registry } = loadModules(['registry'], { fetch: fetchLikeBrowser });

/* ---------------- CSV ---------------- */

/** 逐字元解析，因為營業項目那一欄會被引號包起來，裡面可能有逗號與換行。 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] || '').trim());
}
const csvCell = (v) => { const t = String(v == null ? '' : v); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const toCsv = (rows) => `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\n')}\n`;

/** 商工登記回的是西元（1987/2/21），CSV 這一欄用民國，跟隔壁的核准變更日期對齊。 */
function toRoc(raw) {
  const m = String(raw || '').match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return '';
  const y = +m[1] - 1911;
  if (y <= 0) return '';   // 登記上沒有設立日期的會是「1911年0月0日」
  return `${y}/${String(+m[2]).padStart(2, '0')}/${String(+m[3]).padStart(2, '0')}`;
}

/* ---------------- 先看要查哪些 ---------------- */

let cache = {};
try { cache = JSON.parse(await fs.readFile(CACHE, 'utf8')) || {}; } catch (e) { console.log(`還沒有 ${CACHE}，這次從頭建`); }
let seeded = 0;
if (SEED) {
  try {
    const seed = JSON.parse(await fs.readFile(SEED, 'utf8')) || {};
    Object.entries(seed).forEach(([k, v]) => { if (cache[k] === undefined) { cache[k] = v; seeded += 1; } });
  } catch (e) { /* 沒有種子就算了 */ }
  if (seeded) console.log(`從 ${SEED} 先拿到 ${seeded.toLocaleString()} 個查過的統編`);
}

// 每種來源：哪些檔、統編／名稱在哪一欄、填哪一欄、查的先後
const COLS = CHATTEL
  ? { tax: '客戶統編', name: '客戶名稱', fill: '成立日期', order: '契約迄', label: '動產擔保名單' }
  : { tax: '統一編號', name: '公司名稱', fill: '核准設立日期', order: '', label: '變更清冊' };
const files = [];
if (CHATTEL) {
  files.push(path.join(OUT, 'chattel', 'ntpc.csv'));
} else {
  for (const period of (await fs.readdir(OUT, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    for (const name of (await fs.readdir(path.join(OUT, period))).filter((f) => f.endsWith('-change.csv'))) {
      files.push(path.join(OUT, period, name));
    }
  }
}
console.log(`${COLS.label} ${files.length} 個檔`);

const need = new Map();   // 統編 → { name, order }（統編查不齊時用名稱補；order 決定先查誰）
let rowsTotal = 0;
const parsed = [];
for (const file of files) {
  let rows;
  try { rows = parseCsv(await fs.readFile(file, 'utf8')); } catch (e) { console.log(`跳過 ${file}：${e.message}`); continue; }
  const head = rows[0] || [];
  const iTax = head.indexOf(COLS.tax);
  const iName = head.indexOf(COLS.name);
  let iSetup = head.indexOf(COLS.fill);
  const iOrder = COLS.order ? head.indexOf(COLS.order) : -1;
  if (iTax < 0) { console.log(`跳過 ${file}：欄位對不上`); continue; }
  // 動產擔保名單的「成立日期」是這支加上去的欄，清冊剛抓下來時沒有
  if (iSetup < 0) { head.push(COLS.fill); iSetup = head.length - 1; rows.forEach((r, i) => { if (i) r[iSetup] = ''; }); }
  parsed.push({ file, rows, iTax, iName, iSetup });
  for (let i = 1; i < rows.length; i++) {
    rowsTotal += 1;
    const tax = (rows[i][iTax] || '').trim();
    if ((rows[i][iSetup] || '').trim()) continue;
    if (!/^\d{8}$/.test(tax)) continue;
    if (cache[tax] !== undefined) continue;
    const order = iOrder >= 0 ? (rows[i][iOrder] || '9999') : '';
    const prev = need.get(tax);
    if (!prev) need.set(tax, { name: (rows[i][iName] || '').trim(), order });
    else if (order < prev.order) prev.order = order;
  }
}
const known = Object.values(cache).filter(Boolean).length;
console.log(`${COLS.label}共 ${rowsTotal.toLocaleString()} 列；快取已有 ${Object.keys(cache).length.toLocaleString()} 個統編（查到日期的 ${known.toLocaleString()}）；這次要查 ${need.size.toLocaleString()} 個`);

/* ---------------- 查 ---------------- */

// 動產擔保名單照契約迄日排：已過期的排最後，快到期的先查
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
const rank = (o) => (!o ? '' : o < today ? `z${o}` : o);
const todo = [...need.entries()].sort((a, b) => rank(a[1].order).localeCompare(rank(b[1].order))).map(([tax, v]) => [tax, v.name]).slice(0, LIMIT || undefined);
if (DRY) console.log(`先查這幾家：${todo.slice(0, 5).map(([t]) => `${t}（${need.get(t).order || '－'}）`).join('、')}`);
let done = 0; let hit = 0; let miss = 0; let fail = 0; let stopped = '';
const started = Date.now();
if (!DRY && todo.length) {
  let next = 0;
  const worker = async () => {
    while (!stopped) {
      const i = next; next += 1;
      if (i >= todo.length) return;
      if (Date.now() > DEADLINE) { stopped = `時間到（${MINUTES} 分鐘）`; return; }
      const [tax, name] = todo[i];
      let res;
      try { res = await Registry.lookupCompany({ taxId: tax, name }, { useMirror: true }); }
      catch (err) { res = { ok: false, reason: String((err && err.message) || err) }; }
      if (res.ok) {
        const roc = toRoc(res.data && res.data.founded);
        cache[tax] = roc;
        if (roc) hit += 1; else miss += 1;
        fail = 0;
      } else if (/查無資料|沒有一筆的統編是|部分欄位|用名稱查到/.test(res.reason || '')
        || (res.attempts || []).some((a) => /查無資料|部分欄位/.test(a.reason || ''))) {
        // 連得上、只是登記上沒有這一家：記下來別再重查
        cache[tax] = '';
        miss += 1;
        fail = 0;
      } else {
        // 連不上才算失敗，不寫進快取，下次再查
        fail += 1;
        if (fail >= 20) { stopped = `連續 ${fail} 次連不上（${String(res.reason || '').slice(0, 60)}）`; return; }
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      done += 1;
      if (done % 500 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        const left = todo.length - done;
        console.log(`  ${done.toLocaleString()} / ${todo.length.toLocaleString()}　查到 ${hit.toLocaleString()}　登記上沒有 ${miss.toLocaleString()}　${rate.toFixed(1)} 家/秒　估計還要 ${(left / rate / 60).toFixed(0)} 分鐘`);
        if (!DRY) await fs.writeFile(CACHE, `${JSON.stringify(cache)}\n`, 'utf8');   // 中途被砍掉也不白跑
      }
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
}
console.log(`\n查完 ${done.toLocaleString()} 家：查到 ${hit.toLocaleString()}、登記上沒有 ${miss.toLocaleString()}${stopped ? `　（提早收工：${stopped}）` : ''}`);

/* ---------------- 填回 CSV ---------------- */

const remaining = todo.length - done;
// 給 workflow 看：時間到還有剩，就自己再排一輪
if (process.env.GITHUB_OUTPUT) {
  await fs.appendFile(process.env.GITHUB_OUTPUT, `remaining=${remaining}\ntimeout=${/^時間到/.test(stopped) && remaining > 0}\nreason=${stopped.replace(/\n/g, ' ')}\n`);
}
if (DRY) { console.log('--dry：不寫檔'); process.exit(0); }
await fs.writeFile(CACHE, `${JSON.stringify(cache)}\n`, 'utf8');

let filled = 0; let touched = 0;
for (const { file, rows, iTax, iSetup } of parsed) {
  let changed = false;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][iSetup] || '').trim()) continue;
    const got = cache[(rows[i][iTax] || '').trim()];
    if (!got) continue;
    rows[i][iSetup] = got;
    filled += 1;
    changed = true;
  }
  if (changed) { await fs.writeFile(file, toCsv(rows), 'utf8'); touched += 1; }
}
console.log(`填了 ${filled.toLocaleString()} 列的${COLS.fill}，動到 ${touched} 個檔`);
console.log(`快取 ${CACHE}：${Object.keys(cache).length.toLocaleString()} 個統編`);
console.log(stopped ? `\n沒查完，還剩 ${remaining.toLocaleString()} 家，下次跑會從沒查到的接著查。` : '\n完成');
