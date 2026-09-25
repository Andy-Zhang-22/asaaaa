'use strict';
/*
 * sync.js 的合併邏輯（純函式，跟 Google 無關）。
 * 同步合併錯了是最痛的一種 bug：畫面上看起來存好了，同步一次就變回去，而且無聲。
 * 所以重點測「兩邊順序對調結果要一樣」跟「墓碑不會把使用者剛匯入的資料吃掉」。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./load');

const { DriveSync } = loadModules(['sync']);

// exportedAt 是當下時間，比對前拿掉；陣列順序不影響語意，排好再比
const norm = (d) => ({
  records: [...d.records].sort((a, b) => a.id.localeCompare(b.id)),
  logs: [...d.logs].sort((a, b) => a.uid.localeCompare(b.uid)),
  states: [...d.states].sort((a, b) => a.recordId.localeCompare(b.recordId)),
  tombstones: d.tombstones,
  settings: d.settings,
});

test('mergeTombstones：同一個鍵取比較新的墓碑，兩種格式都吃', () => {
  const a = { records: { r1: 100, r2: 500 }, companies: { c1: { at: 10, name: '甲' } } };
  const b = { records: { r1: 300, r3: 50 }, companies: { c1: { at: 5, name: '甲舊' } } };
  const ab = DriveSync.mergeTombstones(a, b);
  assert.deepEqual(ab.records, { r1: 300, r2: 500, r3: 50 });
  assert.deepEqual(ab.companies, { c1: { at: 10, name: '甲' } });
  assert.deepEqual(DriveSync.mergeTombstones(b, a), ab, '順序對調結果一樣');
  assert.deepEqual(DriveSync.mergeTombstones(null, undefined), { logs: {}, sources: {}, records: {}, companies: {} });
});

test('mergeRegChanges：聯集、同一天同種類算一次、新到舊、壞資料丟掉', () => {
  const left = [{ date: '2025-09-16', kinds: ['capitalUp'] }, { date: '2025-10-08', kinds: ['address'] }];
  const right = [{ date: '2025-09-16', kinds: ['capitalUp'] }, { date: '2025-11-01', kinds: ['owner'] }, { date: '', kinds: ['x'] }, { date: '2025-12-01', kinds: [] }, null];
  const out = DriveSync.mergeRegChanges(left, right);
  assert.deepEqual(out.map((e) => e.date), ['2025-11-01', '2025-10-08', '2025-09-16']);
  assert.deepEqual(DriveSync.regHistoryOf({ regChange: { date: '2025-01-01', kinds: ['other'] } }).length, 1, '舊版單筆 regChange 也收進來');
  assert.deepEqual(DriveSync.regHistoryOf(null), []);
});

test('mergeState：整體取較新，但編輯內容、連結、提醒各看自己的時間戳', () => {
  const a = { recordId: 'r', updatedAt: 10, edits: { phone: '02' }, editsAt: 9, remindAt: '2025-10-01', remindSetAt: 8 };
  const b = { recordId: 'r', updatedAt: 20, outcome: 'contacted' };
  const out = DriveSync.mergeState(a, b);
  assert.equal(out.updatedAt, 20);
  assert.equal(out.outcome, 'contacted');
  assert.deepEqual(out.edits, { phone: '02' }, '另一台只是記了一通電話，不能洗掉這台的編輯');
  assert.equal(out.remindAt, '2025-10-01');
  assert.deepEqual(DriveSync.mergeState(b, a), out, '順序對調結果一樣');

  // 還原（把 edits 清掉）也算一次編輯：editsAt 比較新的那邊沒有 edits，就該沒有
  const restored = DriveSync.mergeState(a, { recordId: 'r', updatedAt: 5, editsAt: 30 });
  assert.equal(restored.edits, undefined);
  assert.equal(restored.editsAt, 30);
});

test('mergeDumps：兩邊順序對調結果一樣；紀錄靠 uid 去重、改得比較新的贏', () => {
  const a = {
    records: [{ id: 'r1', source: 's', importedAt: 100 }],
    logs: [{ uid: 'l1', recordId: 'r1', createdAt: 100, updatedAt: 300, text: '改過的' }],
    states: [{ recordId: 'r1', updatedAt: 100 }],
    settings: { theme: { at: 1, value: 'dark' } },
  };
  const b = {
    records: [{ id: 'r1', source: 's', importedAt: 100 }, { id: 'r2', source: 's', importedAt: 100 }],
    logs: [{ uid: 'l1', recordId: 'r1', createdAt: 100, updatedAt: 200, text: '舊的' }, { uid: 'l2', recordId: 'r2', createdAt: 150 }],
    states: [{ recordId: 'r2', updatedAt: 100 }],
    settings: { theme: { at: 2, value: 'light' } },
  };
  const ab = DriveSync.mergeDumps(a, b);
  const ba = DriveSync.mergeDumps(b, a);
  assert.deepEqual(norm(ab), norm(ba));
  assert.equal(ab.records.length, 2);
  assert.equal(ab.logs.length, 2);
  assert.equal(ab.logs.find((l) => l.uid === 'l1').text, '改過的', '同一則紀錄取改得比較新的，不是先到先贏');
  assert.equal(ab.states.length, 2);
  assert.equal(ab.settings.theme.value, 'light');
  assert.equal(ab.version, 2);
});

test('mergeDumps：墓碑只擋得住比它舊的匯入，之後再匯入一次就該回來', () => {
  const cloud = { records: [], tombstones: { records: { r1: 200 }, sources: {}, logs: {}, companies: {} } };
  const oldImport = { records: [{ id: 'r1', source: 's', importedAt: 100 }], states: [{ recordId: 'r1', updatedAt: 100 }] };
  const newImport = { records: [{ id: 'r1', source: 's', importedAt: 300 }], states: [{ recordId: 'r1', updatedAt: 300 }] };
  assert.equal(DriveSync.mergeDumps(cloud, oldImport).records.length, 0, '刪掉之後的舊資料不能救回來');
  assert.equal(DriveSync.mergeDumps(cloud, oldImport).states.length, 0, '客戶不在了，狀態也一起丟');
  assert.equal(DriveSync.mergeDumps(cloud, newImport).records.length, 1, '使用者自己又匯入了一次，要留著');
  assert.equal(DriveSync.mergeDumps(cloud, newImport).states.length, 1);
});

test('mergeDumps：整份名單被刪掉、被刪掉的通話紀錄不回來', () => {
  const cloud = { tombstones: { sources: { 'a.pdf': 500 }, logs: { l1: 500 }, records: {}, companies: {} } };
  const local = {
    records: [{ id: 'r1', source: 'a.pdf', importedAt: 100 }, { id: 'r2', source: 'b.pdf', importedAt: 100 }],
    logs: [{ uid: 'l1', recordId: 'r2', createdAt: 100 }, { uid: 'l2', recordId: 'r2', createdAt: 100 }],
  };
  const out = DriveSync.mergeDumps(cloud, local);
  assert.deepEqual(out.records.map((r) => r.id), ['r2']);
  assert.deepEqual(out.logs.map((l) => l.uid), ['l2']);
});

test('mergeDumps：清除名單前建的狀態，之後還在記電話就算活的', () => {
  // 狀態的 updatedAt 卡在清除之前，但清除之後又記了一通電話 → 狀態要留
  const cloud = { tombstones: { records: { r1: 200 }, sources: {}, logs: {}, companies: {} } };
  const local = {
    records: [{ id: 'r1', source: 's', importedAt: 300 }],
    states: [{ recordId: 'r1', updatedAt: 100, outcome: 'contacted' }],
    logs: [{ uid: 'l1', recordId: 'r1', createdAt: 250 }],
  };
  const out = DriveSync.mergeDumps(cloud, local);
  assert.equal(out.states.length, 1);
  assert.equal(out.states[0].outcome, 'contacted');
});

test('diffSummary：這次同步多了幾筆', () => {
  assert.deepEqual(DriveSync.diffSummary({ records: [1], logs: [], states: [] }, { records: [1, 2], logs: [1], states: [] }), { records: 1, logs: 1, states: 0 });
  assert.deepEqual(DriveSync.diffSummary(null, null), { records: 0, logs: 0, states: 0 });
});
