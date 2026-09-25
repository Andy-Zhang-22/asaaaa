'use strict';
/*
 * registry.js：商工登記查詢的網址組法、欄位對應、日期與金額換算。
 * 查詢本身要連政府網站，這裡不連；把 fetch 換成假的，確認「送出去的網址」跟
 * 「收到回應後怎麼解」——這兩件事在開發環境驗證不了，只能靠測試守著。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./load');

const fakeResponse = (body, type = 'application/json', status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) },
  text: async () => body,
});

const TSMC = {
  Business_Accounting_NO: '22099131',
  Company_Name: '台灣積體電路製造股份有限公司',
  Company_Status_Desc: '核准設立',
  Capital_Stock_Amount: '280500000000',
  Paid_In_Capital_Amount: '259300000000',
  Responsible_Name: '魏哲家',
  Company_Location: '新竹科學園區新竹市力行六路8號',
  Company_Setup_Date: '0760221',
  Change_Of_Approval_Data: '1140601',
  Some_New_Field: 'x',
};

function loadWithFetch(handler) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return handler(url, calls.length); };
  const { Registry } = loadModules(['registry'], { fetch });
  return { Registry, calls };
}

const { Registry } = loadModules(['registry']);

test('tidyDate：西元 8 碼、民國 7 碼、全零＝1911年0月0日', () => {
  assert.equal(Registry.tidyDate('20250914'), '2025/09/14');
  assert.equal(Registry.tidyDate('1140914'), '2025/09/14');
  assert.equal(Registry.tidyDate('0760221'), '1987/02/21');
  assert.equal(Registry.tidyDate('0000000'), '1911年0月0日');
  assert.equal(Registry.tidyDate('19110000'), '1911年0月0日');
  assert.equal(Registry.tidyDate(''), '');
  assert.equal(Registry.tidyDate('2025/9/4'), '2025/9/4', '看不懂的原樣回');
});

test('toThousands：元換仟元，四捨五入加千分位', () => {
  assert.equal(Registry.toThousands('1200000'), '1,200');
  assert.equal(Registry.toThousands('1,200,500'), '1,201');
  assert.equal(Registry.toThousands('0'), '');
  assert.equal(Registry.toThousands('abc'), '');
});

test('mapRow：官方欄位、資本總額與實收分開、沒對到的欄位列出來', () => {
  const d = Registry.mapRow(TSMC);
  assert.equal(d.taxId, '22099131');
  assert.equal(d.name, '台灣積體電路製造股份有限公司');
  assert.equal(d.capital, '280,500,000');
  assert.equal(d.capitalPaid, '259,300,000');
  assert.equal(d.owner, '魏哲家');
  assert.equal(d.founded, '1987/02/21');
  assert.equal(d.regChanged, '2025/06/01');
  assert.deepEqual(d.unmappedKeys, ['Some_New_Field']);
  assert.equal(Registry.mapRow(null), null);
});

test('mapRow：g0v 鏡像的中文欄位、日期物件、名稱陣列', () => {
  const d = Registry.mapRow({ 統一編號: '1', 公司名稱: ['甲公司', '乙'], 核准設立日期: { year: 76, month: 2, day: 21 }, 代表人姓名: 'X', '資本總額(元)': '5000000', 最後核准變更日期: { year: 0, month: 0, day: 0 } });
  assert.equal(d.name, '甲公司');
  assert.equal(d.founded, '1987/02/21');
  assert.equal(d.owner, 'X');
  assert.equal(d.capital, '5,000');
  assert.equal(d.regChanged, '1911年0月0日', '0 年 0 月 0 日是「沒核准過變更」，不是空值');
});

test('tidyDatasetUrl：少字的協定補上、查詢參數去掉、不是政府網域拒收', () => {
  assert.deepEqual(Registry.tidyDatasetUrl('ttps://data.gcis.nat.gov.tw/od/data/api/ABC-123?$format=json'), { ok: true, url: 'https://data.gcis.nat.gov.tw/od/data/api/ABC-123' });
  assert.deepEqual(Registry.tidyDatasetUrl('data.gcis.nat.gov.tw/od/data/api/ABC'), { ok: true, url: 'https://data.gcis.nat.gov.tw/od/data/api/ABC' });
  assert.deepEqual(Registry.tidyDatasetUrl(''), { ok: true, url: '' });
  assert.equal(Registry.tidyDatasetUrl('https://example.com/x').ok, false);
  assert.equal(Registry.setBase('https://example.com/x').ok, false);
  assert.equal(Registry.getBase(), Registry.DEFAULT_BASE, '拒收的網址不會存進去');
});

test('officialByTaxId：$ 照字面、條件有編碼、統編去掉非數字', () => {
  const urls = Registry.officialByTaxId('22-099131');
  assert.equal(urls[0], `${Registry.FULL_TAXID_BASE}?$format=json&$filter=Business_Accounting_NO%20eq%2022099131&$skip=0&$top=1`);
  assert.ok(urls.every((u) => u.includes('$filter=') && !u.includes('%24')));
  assert.ok(urls.some((u) => u.startsWith(Registry.LEGACY_TAXID_BASE)), '舊資料集當備援');
  assert.ok(urls.some((u) => u.startsWith(Registry.DEFAULT_BASE)), '關鍵字資料集也試');
});

test('nameVariants：去空白、全形括號轉半形、台／臺兩種都試', () => {
  assert.deepEqual(Registry.nameVariants('台灣 積體'), ['台灣積體', '臺灣積體']);
  assert.deepEqual(Registry.nameVariants('甲（乙）'), ['甲(乙)']);
  assert.deepEqual(Registry.nameVariants(''), []);
});

test('companyStem：去掉組織型態', () => {
  assert.equal(Registry.companyStem('方舟國際股份有限公司'), '方舟國際');
  assert.equal(Registry.companyStem('甲 企業社'), '甲');
  assert.equal(Registry.companyStem('沒有型態'), '沒有型態');
});

test('upstreamOf：代理網址裡包的政府網址還原出來，不是政府的原樣回', () => {
  const gov = 'https://data.gcis.nat.gov.tw/od/data/api/X?$format=json&$filter=A%20eq%201';
  assert.equal(Registry.upstreamOf(`https://w.example/?url=${encodeURIComponent(gov)}`), gov);
  assert.equal(Registry.upstreamOf(gov), gov);
  const evil = `https://w.example/?url=${encodeURIComponent('https://evil.example/')}`;
  assert.equal(Registry.upstreamOf(evil), evil);
});

test('lookupByTaxId：統編不是 8 碼直接回錯，不打網路', async () => {
  const { Registry: R, calls } = loadWithFetch(() => fakeResponse('[]'));
  const res = await R.lookupByTaxId('123');
  assert.equal(res.ok, false);
  assert.match(res.reason, /8 碼/);
  assert.equal(calls.length, 0);
});

test('lookupByTaxId：第一支資料集查到就停，欄位照 mapRow 解', async () => {
  const { Registry: R, calls } = loadWithFetch(() => fakeResponse(JSON.stringify([TSMC])));
  const res = await R.lookupByTaxId('22099131');
  assert.equal(res.ok, true);
  assert.equal(res.source, 'official');
  assert.equal(res.data.capital, '280,500,000');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, R.officialByTaxId('22099131')[0]);
  assert.equal(calls[0].init.headers.Accept, 'application/json');
});

test('lookupByTaxId：空白回應算查無資料、換下一種寫法；全部都空就 ok:false', async () => {
  const { Registry: R, calls } = loadWithFetch(() => fakeResponse(''));
  const res = await R.lookupByTaxId('22099131');
  assert.equal(res.ok, false);
  assert.equal(calls.length, R.officialByTaxId('22099131').length, '每一種寫法都試過');
  assert.ok(res.attempts.every((a) => a.reason === '查無資料'));
});

test('lookupByTaxId：只回一半欄位的資料集先留著，下一支補齊', async () => {
  const partial = { Business_Accounting_NO: '22099131', Company_Name: '台灣積體電路製造股份有限公司', Company_Status: '01' };
  const { Registry: R } = loadWithFetch((url, n) => fakeResponse(JSON.stringify(n === 1 ? [partial] : [TSMC])));
  const res = await R.lookupByTaxId('22099131');
  assert.equal(res.ok, true);
  assert.equal(res.data.owner, '魏哲家');
  assert.equal(res.data.name, '台灣積體電路製造股份有限公司');
  assert.match(res.label, /＋/, '標籤要看得出是兩支合起來的');
});

test('lookupByTaxId：text/html 的空白回應是失敗，不是查無資料', async () => {
  const { Registry: R } = loadWithFetch(() => fakeResponse('', 'text/html'));
  const res = await R.lookupByTaxId('22099131');
  assert.equal(res.ok, false);
  assert.ok(res.attempts.every((a) => /查詢失敗：空白回應/.test(a.reason)), res.attempts[0].reason);
});

test('lookupCompany：名稱查回來的統編要對得上才採用', async () => {
  const other = { ...TSMC, Business_Accounting_NO: '99999999' };
  const { Registry: R } = loadWithFetch((url) => {
    if (/Business_Accounting_NO/.test(url)) return fakeResponse('');
    return fakeResponse(JSON.stringify([other]));
  });
  const res = await R.lookupCompany({ taxId: '22099131', name: '台灣積體電路製造股份有限公司' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /沒有一筆的統編是 22099131/);
});
