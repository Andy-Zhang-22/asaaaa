'use strict';
/*
 * normalize.js 的純函式：日期、電話、地址、CSV、洽談狀態、禁止推廣、下次聯絡日。
 * 這些都是「輸入一段文字、輸出一個結構」，最容易在改正規表示式時不小心弄壞。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./load');

const { Normalize } = loadModules(['normalize']);

test('parseDate：西元、民國、緊湊寫法都認得，壞日期回 null', () => {
  assert.equal(Normalize.parseDate('2025/09/14'), '2025-09-14');
  assert.equal(Normalize.parseDate('2025-9-4'), '2025-09-04');
  assert.equal(Normalize.parseDate('2025年9月14日'), '2025-09-14');
  assert.equal(Normalize.parseDate('114/09/14'), '2025-09-14');
  assert.equal(Normalize.parseDate('20250914'), '2025-09-14');
  assert.equal(Normalize.parseDate('1140914'), '2025-09-14');
  assert.equal(Normalize.parseDate('２０２５/０９/１４'), '2025-09-14', '全形數字要先轉半形');
  assert.equal(Normalize.parseDate('2025'), '2025-01-01', '只有年份補成 1/1');
  assert.equal(Normalize.parseDate('114/13/01'), null, '13 月不是日期');
  assert.equal(Normalize.parseDate(''), null);
  assert.equal(Normalize.parseDate(null), null);
});

test('toHalfWidth：全形括號、井號、破折號、數字轉半形', () => {
  assert.equal(Normalize.toHalfWidth('（０２）＃１２３—x'), '(02)#123-x');
  assert.equal(Normalize.toHalfWidth(null), '');
});

test('extractPhones：分機、括號註記、一行多支各歸各的', () => {
  const one = Normalize.extractPhones('02-2345-6789 分機210');
  assert.equal(one.length, 1);
  assert.equal(one[0].dial, '0223456789,210');
  assert.equal(one[0].display, '02-2345-6789 分機210');

  const two = Normalize.extractPhones('馬少軒0936-570087呂彥皇(員工?)0987-729-798');
  assert.deepEqual(two.map((p) => p.dial), ['0936570087', '0987729798']);
  assert.match(two[0].note, /馬少軒/);
  assert.match(two[1].note, /呂彥皇/);
  assert.doesNotMatch(two[0].note, /呂彥皇/, '第二支的名字不能算到第一支頭上');

  // 分機自己一行 → 掛回上一支電話
  const ext = Normalize.extractPhones('02-2345-6789\n分機210(財務長鍾小姐)');
  assert.deepEqual(ext.map((p) => p.dial), ['0223456789', '0223456789,210']);
  assert.equal(ext[1].note, '財務長鍾小姐');

  // 同一支重複只留一個；(02) 的區碼括號不當備註
  const dup = Normalize.extractPhones('(02)2345-6789 / (02) 2345-6789');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].note, '');

  assert.deepEqual(Normalize.extractPhones(''), []);
  assert.deepEqual(Normalize.extractPhones('沒有電話 123'), []);
});

test('phoneRows／serializePhones 互相讀得回來', () => {
  const rows = [
    { number: '0936-570087', ext: '23', note: '馬少軒' },
    { number: '02-2345-6789', ext: '', note: '' },
    { number: '123', ext: '', note: '不是電話' },   // 不足 8 碼會被丟掉
  ];
  const text = Normalize.serializePhones(rows);
  assert.equal(text, '0936-570087 分機23 (馬少軒)\n02-2345-6789');
  assert.deepEqual(Normalize.phoneRows(text), [
    { number: '0936-570087', digits: '0936570087', ext: '23', note: '馬少軒' },
    { number: '02-2345-6789', digits: '0223456789', ext: '', note: '' },
  ]);
});

test('parseAddress：升格前的舊縣名換成現在的市，鄉鎮市換成區', () => {
  assert.deepEqual(Normalize.parseAddress('臺北縣板橋市文化路一段1號'), { city: '新北市', district: '板橋區' });
  assert.deepEqual(Normalize.parseAddress('桃園縣龜山鄉'), { city: '桃園市', district: '龜山區' });
  assert.deepEqual(Normalize.parseAddress('台北市大安區'), { city: '臺北市', district: '大安區' });
  assert.deepEqual(Normalize.parseAddress('新竹縣竹北市光明六路'), { city: '新竹縣', district: '竹北市' }, '縣底下的市不改成區');
  assert.deepEqual(Normalize.parseAddress(''), { city: '', district: '' });
  assert.deepEqual(Normalize.parseAddress('沒有縣市的地址'), { city: '', district: '' });
});

test('parseAddressAny：實際地址看不出縣市就看登記地址', () => {
  assert.deepEqual(Normalize.parseAddressAny('工業區路 1 號', '新北市新莊區'), { city: '新北市', district: '新莊區' });
  assert.deepEqual(Normalize.parseAddressAny('臺北市內湖區', '新北市新莊區'), { city: '臺北市', district: '內湖區' });
});

test('splitAddress：104 登記與公司登記兩種順序都拆得開', () => {
  assert.deepEqual(Normalize.splitAddress('104登記：臺北市內湖區 / 公司登記：新北市新莊區'), { actual: '臺北市內湖區', registered: '新北市新莊區' });
  assert.deepEqual(Normalize.splitAddress('公司登記：新北市新莊區 / 104登記：臺北市內湖區'), { actual: '臺北市內湖區', registered: '新北市新莊區' });
  assert.deepEqual(Normalize.splitAddress('新北市新莊區'), { registered: '新北市新莊區', actual: '新北市新莊區' });
});

test('parseCsv：BOM、CRLF、引號裡的逗號與雙引號、空白列', () => {
  const rows = Normalize.parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n\r\n,\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'he said "hi"']]);
});

test('detectDelimiter：引號外的 Tab 比逗號多才算 Excel 貼上', () => {
  assert.equal(Normalize.detectDelimiter('a\tb\nc\td'), '\t');
  assert.equal(Normalize.detectDelimiter('a,b\nc,d'), ',');
  assert.equal(Normalize.detectDelimiter('"a\tb",c'), ',', '引號裡的 Tab 不算');
  assert.equal(Normalize.detectDelimiter(''), ',');
});

test('parseNotes：切成一則一則、民國年換算、時間另外收', () => {
  const entries = Normalize.parseNotes('徵才資訊：找業務\n114/09/01 11:00 [已聯絡] 老闆說再看看\n2025/08/15 未接');
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { date: null, text: '徵才資訊：找業務' });
  assert.equal(entries[1].date, '2025-09-01');
  assert.equal(entries[1].time, '11:00');
  assert.equal(entries[1].text, '[已聯絡] 老闆說再看看');
  assert.equal(entries[2].date, '2025-08-15');
  assert.deepEqual(Normalize.parseNotes(''), []);
});

test('guessOutcome：最新一則沒日期＝未撥打；方括號標記直接採用', () => {
  assert.equal(Normalize.guessOutcome(''), 'new');
  assert.equal(Normalize.guessOutcome('徵才資訊：找業務'), 'new');
  assert.equal(Normalize.guessOutcome('114/09/01 未接'), 'noanswer');
  assert.equal(Normalize.guessOutcome('114/09/01 [未接通] 沒人接'), 'noanswer');
  assert.equal(Normalize.guessOutcome('114/09/01 [婉拒] 不需要'), 'contacted', '舊的婉拒併進已聯絡');
  assert.equal(Normalize.guessOutcome('114/09/01 老闆說不需要，晚點再撥'), 'contacted', '有講到話就是已聯絡，即使寫了再撥');
  assert.equal(Normalize.guessOutcome('114/09/01 禁止推廣'), 'blocked');
});

test('normalizeOutcome／outcomeLabel：舊的三種狀態併進已聯絡', () => {
  assert.equal(Normalize.normalizeOutcome('interested'), 'contacted');
  assert.equal(Normalize.normalizeOutcome('noanswer'), 'noanswer');
  assert.equal(Normalize.outcomeLabel('婉拒'), '已聯絡');
  assert.equal(Normalize.outcomeLabel('new'), '未撥打');
  assert.equal(Normalize.outcomeLabel(''), '');
});

test('detectBlocked：只收明確的拒訪語句，信用狀況的「拒絕往來」不算', () => {
  const hit = Normalize.detectBlocked('114/09/01 客戶說不要再打了');
  assert.equal(hit.blocked, true);
  assert.equal(hit.phrase, '不要再打');
  assert.match(hit.snippet, /不要再打/);
  assert.equal(Normalize.detectBlocked('114/09/01 銀行拒絕往來戶，黑名單').blocked, false);
  assert.equal(Normalize.detectBlocked('').blocked, false);
  assert.equal(Normalize.detectBlocked('請勿推銷').phrase, '請勿推銷');
});

test('companyKeys：統編去掉非數字，名稱去掉空白', () => {
  assert.deepEqual(Normalize.companyKeys({ taxId: '12-345678', company: '測試 公司' }), ['tax:12345678', 'name:測試公司']);
  assert.deepEqual(Normalize.companyKeys({ company: '只有名字' }), ['name:只有名字']);
  assert.deepEqual(Normalize.companyKeys({}), []);
  assert.deepEqual(Normalize.companyKeys(null), []);
});

test('makeId：同一份檔案同一家公司永遠同一個 id，空白不影響', () => {
  const a = Normalize.makeId('名單.pdf', '測試公司', '12345678');
  assert.equal(a, Normalize.makeId('名單.pdf', '測試 公司', '1234 5678'));
  assert.notEqual(a, Normalize.makeId('另一份.pdf', '測試公司', '12345678'));
  assert.match(a, /^[0-9a-z]+$/);
});

test('findFollowUp：只抓未來、講過去的月日不推到明年、跨年才推', () => {
  assert.equal(Normalize.findFollowUp('114/09/01 老闆說9/20再聯絡', '2025-09-10').iso, '2025-09-20');
  assert.equal(Normalize.findFollowUp('114/09/01 上次8/1有拜訪過', '2025-09-10'), null, '八月已經過了、又不到半年，是在講過去');
  assert.equal(Normalize.findFollowUp('114/12/20 約1/5再談', '2025-12-22').iso, '2026-01-05');
  assert.equal(Normalize.findFollowUp('114/09/01 已聯絡，沒說什麼', '2025-09-10'), null, '沒有約訪字眼');
  assert.equal(Normalize.findFollowUp('', '2025-09-10'), null);
  // 紀錄開頭的日期本身在未來 + 約訪字眼 → 整則是約訪
  assert.equal(Normalize.findFollowUp('114/09/01 老闆說\n114/10/15 再聯絡', '2025-09-10').iso, '2025-10-15');
});

test('capitalLooksLikeYuan／convertCapitalToThousands：整欄看起來是「元」就換成仟元', () => {
  const rows = [['公司', '資本額'], ['a', '1,200,000'], ['b', '5000000'], ['c', '300000'], ['d', '250,000'], ['e', '不詳'], ['f', '800000']];
  const map = { capital: 1 };
  assert.equal(Normalize.capitalLooksLikeYuan(rows, map), true);
  assert.equal(Normalize.capitalLooksLikeYuan([['公司', '資本額'], ['a', '1,200']], map), false, '不到五筆不猜');
  assert.equal(Normalize.convertCapitalToThousands(rows, map), 5);
  assert.equal(rows[1][1], '1,200');
  assert.equal(rows[5][1], '不詳', '非數字原樣留著');
});

test('splitCompanyNames：靠公司型態字尾切開黏在一起的關係企業', () => {
  const names = Normalize.splitCompanyNames('甲乙股份有限公司丙丁有限公司');
  assert.deepEqual(names, ['甲乙股份有限公司', '丙丁有限公司']);
});
