'use strict';
/*
 * rules.js：歸屬分公司的劃分表與判斷、本餘金額解析、微企／一般組的承作提醒。
 * 劃分表是照公司規範抄的，抄重複（一個區同時屬兩家分公司）畫面不會報錯，
 * 只會默默用先找到的那家，所以資料本身也要檢查。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./load');

const { Rules } = loadModules(['normalize', 'rules']);

test('branchOf：一般區、共同區、全公司共同區域', () => {
  const r = Rules.branchOf('桃園市', '龜山區');
  assert.equal(r.kind, 'branch');
  assert.deepEqual(r.branches, ['桃園']);
  assert.equal(r.division, '北二分處');

  assert.deepEqual(Rules.branchOf('台北市', '大安區').branches, ['城中'], '台→臺 要能對上');
  assert.deepEqual(Rules.branchOf('新北市', '汐止區').branches, ['城東'], '規範上不帶「區」也要認');
  assert.deepEqual(Rules.branchOf('基隆市', '仁愛區').branches, ['城北'], '整個縣市（all）');

  const common = Rules.branchOf('桃園市', '平鎮區');
  assert.equal(common.kind, 'common');
  assert.deepEqual(common.branches, ['桃園', '新竹']);
  assert.equal(common.appealTo, '桃園分公司');
  assert.match(common.label, /共同區/);

  assert.equal(Rules.branchOf('澎湖縣', '馬公市').kind, 'shared');
  assert.equal(Rules.branchOf('花蓮縣', '花蓮市').unit, '花蓮一科、二科');
  assert.equal(Rules.branchOf('臺東縣', '臺東市').kind, 'common', '臺東整個縣是共同區');
});

test('branchOf：沒縣市、對不到的區都回空', () => {
  assert.deepEqual(Rules.branchOf('', '大安區'), { kind: '', label: '' });
  assert.equal(Rules.branchOf('臺北市', '').kind, '');
  assert.equal(Rules.branchOf('火星市', '某區').kind, '');
});

test('劃分表：同一縣市的行政區不能同時屬於兩家分公司，也不能同時是共同區', () => {
  const bare = (d) => String(d).replace(/[區鄉鎮市]$/, '');
  const owner = new Map();   // city|district → branch
  for (const b of Rules.BRANCH_AREAS) {
    for (const [city, list] of Object.entries(b.areas)) {
      const items = list === 'all' ? ['*'] : list;
      for (const d of items) {
        const key = `${city}|${bare(d)}`;
        const seen = owner.get(key);
        assert.ok(!seen || seen === b.branch, `${city}${d} 同時屬於 ${seen} 與 ${b.branch}`);
        owner.set(key, b.branch);
      }
    }
  }
  for (const cm of Rules.COMMON_AREAS) {
    const items = cm.districts === 'all' ? ['*'] : cm.districts;
    for (const d of items) {
      const key = `${cm.city}|${bare(d)}`;
      assert.ok(!owner.has(key), `${cm.city}${d} 是共同區，卻也列在 ${owner.get(key)} 的一般區裡`);
      assert.ok(!owner.has(`${cm.city}|*`), `${cm.city} 整個縣市已經歸 ${owner.get(`${cm.city}|*`)}，不該再有共同區`);
    }
    cm.branches.forEach((br) => assert.ok(Rules.BRANCH_AREAS.some((b) => b.branch === br), `共同區寫到不存在的分公司 ${br}`));
  }
});

test('parseBalance：本餘的單位換成仟元', () => {
  assert.equal(Rules.parseBalance('本餘 300 萬'), 3000);
  assert.equal(Rules.parseBalance('本於1200萬'), 12000);
  assert.equal(Rules.parseBalance('本餘 5,000 仟'), 5000);
  assert.equal(Rules.parseBalance('本餘 1.5 億'), 150000);
  assert.equal(Rules.parseBalance('本餘 3000000'), 3000, '沒單位且 ≥ 一百萬當「元」');
  assert.equal(Rules.parseBalance('本餘 300'), 3000, '沒單位且小的當「萬」');
  assert.equal(Rules.parseBalance('本餘１２萬'), 120, '全形數字');
  assert.equal(Rules.parseBalance('本餘 0 萬'), null);
  assert.equal(Rules.parseBalance('沒提到'), null);
  assert.equal(Rules.parseBalance(''), null);
});

test('routeCustomer：資本額分微企／一般組，超過授信上限要移交', () => {
  const micro = Rules.routeCustomer({ capital: 3000 });
  assert.ok(micro.some((n) => n.level === 'ok' && /微型企業/.test(n.text)));

  const big = Rules.routeCustomer({ capital: 8000, exposure: 8000, currentUnit: '微企處' });
  assert.ok(big.some((n) => n.level === 'warn' && /不屬微企處/.test(n.text)));
  assert.ok(big.some((n) => n.level === 'block' && /移交/.test(n.text)));

  const none = Rules.routeCustomer({});
  assert.equal(none.length, 1);
  assert.equal(none[0].level, 'ok');

  const lowSpread = Rules.routeCustomer({ capital: 3000, exposure: 5000, currentUnit: '一般組', spread: 8 });
  assert.ok(lowSpread.some((n) => n.level === 'block' && /Spread/.test(n.text)));
  assert.ok(Rules.routeCustomer({ sameRegion: false }).some((n) => n.level === 'block' && /協銷/.test(n.text)));
});

test('門檻常數跟規範一致', () => {
  assert.equal(Rules.MICRO_CAPITAL_LIMIT, 5000);
  assert.equal(Rules.LARGE_CAPITAL_LIMIT, 500000);
  assert.equal(Rules.MICRO_CREDIT_LIMIT, 7000);
});
