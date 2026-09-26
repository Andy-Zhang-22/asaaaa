'use strict';
/*
 * 快到期分頁的純邏輯：日期怎麼算、金主怎麼歸類、寫進訪談內容的那一行不能被當成通話紀錄；
 * 以及抓清冊的腳本裡「誰是客戶、誰是金主」的判定（附條件買賣的角色是反的）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModules, ROOT } = require('./load');

const w = loadModules(['normalize', 'holidays', 'rules', 'chattel']);
const C = w.Chattel;
const TODAY = new Date(2026, 8, 26);

test('契約迄日離今天幾天，以及落在哪一格', () => {
  assert.equal(C.daysLeft('2026/10/14', TODAY), 18);
  assert.equal(C.daysLeft('2026-09-26', TODAY), 0);
  assert.equal(C.daysLeft('2026/09/20', TODAY), -6);
  assert.equal(C.daysLeft('', TODAY), null);
  assert.equal(C.dueOf(18), 'm3');
  assert.equal(C.dueOf(120), 'm6');
  assert.equal(C.dueOf(300), 'm12');
  assert.equal(C.dueOf(-6), 'expired');
  assert.equal(C.dueOf(500), 'later');
  assert.equal(C.dueOf(null), 'none');
});

test('金主歸類：分公司、舊名都歸同一家；看不出來的歸其他', () => {
  assert.equal(C.lenderFamily('中租迪和股份有限公司新莊分公司'), 'chailease');
  assert.equal(C.lenderFamily('新鑫股份有限公司'), 'sinxin');
  assert.equal(C.lenderFamily('和潤企業股份有限公司'), 'hotai');
  assert.equal(C.lenderFamily('台灣中小企業銀行'), 'bank');
  assert.equal(C.lenderFamily('王小明'), 'other');
});

test('CSV 的一列變成卡片資料：到期、金主、分公司、客戶那一方是不是金融業', () => {
  const r = C.toRecord({
    '案件類別': '附條件買賣登記', '登記編號': '112新經動字第004821號',
    '客戶統編': '28451237', '客戶名稱': '禾泰精密工業有限公司', '金主統編': '05072925', '金主名稱': '新鑫股份有限公司',
    '契約起': '2023/10/15', '契約迄': '2026/10/14', '擔保金額': '12000000',
    '標的物所在地': '新北市新莊區五權一路12號', '標的物': 'CNC 3台', '登記核准日': '2023/10/20',
  }, TODAY);
  assert.equal(r.days, 18);
  assert.equal(r.due, 'm3');
  assert.equal(r.family, 'sinxin');
  assert.equal(r.amount, 12000000);
  assert.equal(r.branch.key, '新莊分公司');
  assert.equal(r.branch.district, '新北市新莊區');
  assert.equal(r.custIsFin, false);
  const fin = C.toRecord({ '客戶名稱': '合迪股份有限公司', '金主名稱': '中租迪和股份有限公司', '契約迄': '2027/01/01' }, TODAY);
  assert.equal(fin.custIsFin, true);
  assert.equal(fin.family, 'chailease');
});

test('寫進訪談內容的那一行：主站不會把契約日期當成一筆通話', () => {
  const r = C.toRecord({ '案件類別': '動產抵押登記', '客戶名稱': '甲公司', '金主名稱': '和潤企業股份有限公司', '契約起': '2023/10/15', '契約迄': '2026/10/14', '擔保金額': '8600000', '標的物': '曳引車 2 輛' }, TODAY);
  const note = C.noteFor(r);
  assert.match(note, /和潤/);
  assert.match(note, /860 萬/);
  assert.match(note, /2023-10-15～2026-10-14/);
  assert.match(note, /還有 18 天到期/);
  const entries = w.Normalize.parseNotes(note);
  assert.equal(entries.length, 1, '整行是一則備註，不是好幾筆通話');
  assert.equal(entries[0].date, null, '沒有日期，才不會變成最近聯絡日');
  assert.equal(w.Normalize.guessOutcome(note), 'new');
  const csv = C.toCsv([r]);
  assert.match(csv.split('\n')[0], /公司名稱,統編,電話,地址,訪談內容/);
  assert.equal(w.Normalize.isGovRegistry(w.Normalize.parseCsv(csv)), false, '不能被當成經濟部登記清冊再問一次條件');
});

test('抓清冊的腳本：誰是客戶、誰是金主', async () => {
  const m = await import(path.join(ROOT, 'tools', 'fetch-chattel.mjs'));
  // 附條件買賣：租賃公司在 coma（欄位名寫債務人），照名字翻正
  const a = m.rolesOf({ casetype: '附條件買賣登記', comaname: '中租迪和股份有限公司', comaid: '05072925', combname: '禾泰精密工業有限公司', combid: '28451237' });
  assert.equal(a.cust.name, '禾泰精密工業有限公司');
  assert.equal(a.lender.id, '05072925');
  assert.equal(a.how, 'name');
  // 動產抵押：金主在 comb
  const b = m.rolesOf({ casetype: '動產抵押登記', comaname: '禾泰精密工業有限公司', combname: '新鑫股份有限公司' });
  assert.equal(b.cust.name, '禾泰精密工業有限公司');
  assert.equal(b.lender.name, '新鑫股份有限公司');
  // 兩邊都看不出來：按案件類別的慣例
  const c = m.rolesOf({ casetype: '附條件買賣登記', comaname: '甲', combname: '乙' });
  assert.equal(c.cust.name, '乙'); assert.equal(c.how, 'type');
  const d = m.rolesOf({ casetype: '動產抵押登記', comaname: '甲', combname: '乙' });
  assert.equal(d.cust.name, '甲');
  // 日期是西元 8 碼，轉成 yyyy/mm/dd；註銷日空白就是還沒註銷
  const row = m.toRow({ casetype: '動產抵押登記', comaname: '甲', combname: '新鑫股份有限公司', casesyyyymmddroc: '20231015', caseeyyyymmddroc: '20261014', casetatol: '1,200,000', casecanyyyymmddroc: '' });
  assert.equal(row.start, '2023/10/15'); assert.equal(row.end, '2026/10/14'); assert.equal(row.amount, '1200000'); assert.equal(row.cancelled, '');
});
