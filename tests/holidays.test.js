'use strict';
/*
 * 行事曆資料的合理性檢查。
 *
 * 資料是人手抄進去的，抄錯一天不會有任何功能壞掉，只會讓某個客戶的下次聯絡日
 * 悄悄排到放假那天。所以這裡不是測程式，是測資料：
 *   - off 只能列平日（週六日本來就不上班，列了代表日期抄錯）
 *   - work（補班）只能是週末
 *   - 固定日期的國定假日：落在平日一定要在 off 裡，落在週末一定要有補假
 *   - 明年 1/1 是週六的話，今年 12/31 要補假
 * 另外把 2027 年已經公告的連假整段對一次，之後有人改到才會知道。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./load');

const { Holidays } = loadModules(['holidays']);
const { DATA } = Holidays;

const dow = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();   // 0=日 6=六
const isWeekend = (iso) => dow(iso) === 0 || dow(iso) === 6;
const validIso = (iso) => /^\d{4}-\d{2}-\d{2}$/.test(iso) && new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso;

// 紀念日及節日實施條例（2025 年 5 月通過）以後的固定放假日；2025 年只算舊制的那幾天
const FIXED_SINCE_2026 = ['01-01', '02-28', '04-04', '05-01', '09-28', '10-10', '10-25', '12-25'];
const FIXED_2025 = ['01-01', '02-28', '04-04', '10-10', '12-25'];

test('每一年的 off 都是該年的平日，work 都是該年的週末', () => {
  for (const [year, y] of Object.entries(DATA)) {
    for (const iso of Object.keys(y.off)) {
      assert.ok(validIso(iso), `${iso} 不是合法日期`);
      assert.equal(iso.slice(0, 4), year, `${iso} 放錯年份（在 ${year} 底下）`);
      assert.ok(!isWeekend(iso), `${iso}（${y.off[iso]}）是週末，週末不用列在 off`);
      assert.ok(String(y.off[iso]).trim(), `${iso} 沒有名稱`);
    }
    for (const iso of y.work) {
      assert.ok(validIso(iso), `${iso} 不是合法日期`);
      assert.equal(iso.slice(0, 4), year, `${iso} 放錯年份`);
      assert.ok(isWeekend(iso), `補班日 ${iso} 不是週末`);
      assert.ok(!y.off[iso], `${iso} 同時是補班日又是放假日`);
    }
  }
});

test('固定日期的國定假日：平日要放假，週末要有補假', () => {
  for (const [year, y] of Object.entries(DATA)) {
    const fixed = Number(year) >= 2026 ? FIXED_SINCE_2026 : FIXED_2025;
    for (const md of fixed) {
      const iso = `${year}-${md}`;
      const d = dow(iso);
      if (d >= 1 && d <= 5) {
        assert.ok(y.off[iso], `${iso} 是平日的國定假日，但 off 裡沒有`);
      } else if (d === 6) {
        const fri = Holidays.addDays(iso, -1);
        assert.ok(y.off[fri], `${iso} 是週六，前一天 ${fri} 應該補假`);
      } else {
        const mon = Holidays.addDays(iso, 1);
        const tue = Holidays.addDays(iso, 2);
        assert.ok(y.off[mon] || y.off[tue], `${iso} 是週日，${mon} 或 ${tue} 應該補假`);
      }
    }
    // 明年元旦落在週六 → 今年 12/31 補假（2027-12-31 就是這種）
    const nextJan1 = `${Number(year) + 1}-01-01`;
    if (dow(nextJan1) === 6) {
      assert.ok(y.off[`${year}-12-31`], `${nextJan1} 是週六，${year}-12-31 應該補假`);
    }
  }
});

test('2027 年：公告的春節、清明、端午、中秋整段都在', () => {
  const off = DATA[2027].off;
  // 春節 2/4（小年夜，四）～ 2/10（三），初一、初二落在週末，補到 2/9、2/10
  ['2027-02-04', '2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10'].forEach((d) => assert.ok(off[d], `${d} 春節連假漏了`));
  assert.equal(off['2027-02-05'], '農曆除夕');
  // 兒童節 4/4 是週日、清明 4/5 週一，補到 4/6
  assert.ok(off['2027-04-05'] && off['2027-04-06'], '清明連假漏了');
  assert.ok(off['2027-06-09'], '端午節 2027-06-09 漏了');
  assert.ok(off['2027-09-15'], '中秋節 2027-09-15 漏了');
  assert.equal(DATA[2027].work.length, 0, '2027 年沒有補班日');
});

test('holidayName：平日空字串、週末回星期、補班日照常上班', () => {
  assert.equal(Holidays.holidayName('2026-09-24'), '');
  assert.equal(Holidays.holidayName('2026-09-26'), '週六');
  assert.equal(Holidays.holidayName('2026-09-25'), '中秋節');
  assert.equal(Holidays.holidayName('2025-02-08'), '', '2025-02-08 是補班日，要上班');
  assert.equal(Holidays.holidayName(''), '');
});

test('nextWorkday：整串連假一次跳過', () => {
  // 除夕（五）→ 2/6 六、2/7 日、2/8 初三、2/9、2/10 補假 → 2/11（四）
  assert.deepEqual(Holidays.nextWorkday('2027-02-05'), { iso: '2027-02-11', moved: true, from: '2027-02-05', reason: '農曆除夕', covered: true });
  // 中秋（五）→ 週末 → 9/28 教師節（一）→ 9/29（二）
  assert.equal(Holidays.nextWorkday('2026-09-25').iso, '2026-09-29');
  // 已經是上班日就原樣回傳
  assert.deepEqual(Holidays.nextWorkday('2026-09-24'), { iso: '2026-09-24', moved: false, from: '2026-09-24', reason: '', covered: true });
  // 跨到還沒有資料的年份：只避得開週末，covered 要講清楚
  const r = Holidays.nextWorkday('2028-01-01');
  assert.equal(r.iso, '2028-01-03');
  assert.equal(r.covered, false);
});

test('covered：有資料的年份才算', () => {
  assert.equal(Holidays.covered('2027-06-01'), true);
  assert.equal(Holidays.covered('2028-03-01'), false);
  assert.equal(Holidays.covered(''), false);
  assert.ok(Holidays.MAX_YEAR >= 2027);
});
