'use strict';
/*
 * 計價測試：菜單資料合法、單價、加料、買5送1。
 *
 * js/ 底下的模組是 (function (global) {...})(window) 的寫法，把 API 掛在 window 上，
 * 這裡把整支檔案包成函式、餵一個假的 window 進去，就能在 Node 跑。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function load() {
  const window = {};
  window.window = window;
  for (const name of ['menu', 'pricing']) {
    const file = path.join(ROOT, 'js', `${name}.js`);
    // eslint-disable-next-line no-new-func
    new Function('window', `${fs.readFileSync(file, 'utf8')}\n//# sourceURL=${file}`)(window);
  }
  return window;
}

const { DrinkMenu, DrinkPricing } = load();
const menu = DrinkMenu.defaults();

test('菜單：品項 id 不重複，價格都是數字，XL 不會比 L 便宜（特調系列除外，老闆指定）', () => {
  const ids = new Set();
  for (const cat of menu.categories) {
    for (const it of cat.items) {
      assert.ok(!ids.has(it.id), `重複的 id：${it.id}`);
      ids.add(it.id);
      assert.equal(typeof it.price.L, 'number', `${it.name} 沒有 L 價`);
      if (it.price.XL != null) {
        assert.equal(typeof it.price.XL, 'number');
        if (cat.id !== 'special') assert.ok(it.price.XL >= it.price.L, `${it.name} 的 XL 比 L 便宜`);
      }
    }
  }
  assert.ok(ids.size >= 60, '菜單應該有 60 項以上');
});

test('菜單：老闆指定的價格', () => {
  const byName = {};
  menu.categories.forEach((c) => c.items.forEach((i) => { byName[i.name] = i.price; }));
  assert.deepEqual(byName['檸檬烏龍'], { L: 35, XL: 40 });
  assert.deepEqual(byName['青梅烏龍'], { L: 35, XL: 40 });
  assert.equal(byName['番茄梅'].XL, 40);
  assert.equal(byName['番茄多多'].XL, 40);
  assert.deepEqual(byName['古早味紅茶冰'], { L: 25, XL: 30 });
  assert.deepEqual(byName['鮮奶烏龍'], { L: 50, XL: 55 });
  assert.deepEqual(byName['百香果綠茶'], { L: 50, XL: 55 });
  assert.deepEqual(byName['薑汁熱鮮奶'], { L: 55, XL: null });
});

test('單價：尺寸 + 加料', () => {
  assert.equal(DrinkPricing.unitPrice(menu, { itemId: 'black-1', size: 'L' }), 25);
  assert.equal(DrinkPricing.unitPrice(menu, { itemId: 'black-1', size: 'XL' }), 30);
  assert.equal(DrinkPricing.unitPrice(menu, { itemId: 'black-1', size: 'XL', toppings: ['boba'] }), 40);
  assert.equal(DrinkPricing.unitPrice(menu, { itemId: 'milk-1', size: 'L', toppings: ['pudding', 'grass'] }), 45);
  assert.equal(DrinkPricing.unitPrice(menu, { itemId: 'hot-8', size: 'XL' }), null, '熱飲沒有 XL');
  assert.equal(DrinkPricing.unitPrice(menu, { itemId: 'nope', size: 'L' }), null);
});

test('整單：沒滿 6 杯就沒折扣', () => {
  const s = DrinkPricing.summarize(menu, [
    { itemId: 'black-1', size: 'L', qty: 2 },
    { itemId: 'milk-3', size: 'XL', qty: 1, toppings: ['pudding'] },
  ]);
  assert.equal(s.cups, 3);
  assert.equal(s.subtotal, 25 * 2 + 55);
  assert.equal(s.freeCups, 0);
  assert.equal(s.discount, 0);
  assert.equal(s.total, 105);
});

test('整單：買5送1，第 6 杯送最便宜的那杯，加料照算', () => {
  const s = DrinkPricing.summarize(menu, [
    { itemId: 'milk-3', size: 'XL', qty: 5 },            // 50 x5
    { itemId: 'black-1', size: 'L', qty: 1, toppings: ['boba'] }, // 25 + 10
  ]);
  assert.equal(s.cups, 6);
  assert.equal(s.subtotal, 250 + 35);
  assert.equal(s.freeCups, 1);
  assert.equal(s.discount, 25, '送的是茶價 25，波霸 10 元照收');
  assert.equal(s.total, 260);
});

test('整單：12 杯送 2 杯；關掉活動就不折', () => {
  const lines = [{ itemId: 'black-1', size: 'L', qty: 12 }];
  const on = DrinkPricing.summarize(menu, lines);
  assert.equal(on.freeCups, 2);
  assert.equal(on.total, 25 * 10);
  const off = DrinkPricing.summarize(menu, lines, { enabled: false });
  assert.equal(off.freeCups, 0);
  assert.equal(off.total, 25 * 12);
});

test('製作單文字：熱飲不印冰量、加料與備註都會帶到', () => {
  const cold = DrinkPricing.describeLine(menu, { itemId: 'milk-1', size: 'L', sugar: '半糖', ice: '少冰', toppings: ['boba'], note: '打包' });
  assert.equal(cold, 'L / 半糖 / 少冰 / +波霸 / 備註：打包');
  const hot = DrinkPricing.describeLine(menu, { itemId: 'hot-1', size: 'L', sugar: '微糖', ice: '正常冰' });
  assert.equal(hot, 'L / 微糖 / 熱');
});
