'use strict';
/*
 * 版本號散在三個地方（index.html 的 ?v=、app.js 的 APP_VERSION、version.json），
 * 任何一處對不上都會出事，而且不會讓任何功能測試變紅：
 * （leads/index.html 現在只是轉址頁，不載入任何 assets，所以不在檢查範圍。）
 *   - version.json 比程式新 → 更新提示無限迴圈
 *   - index.html 的 ?v= 沒跟著換 → 使用者拿到快取的舊 js
 * 這支只做一件事：三處一致，而且 index.html 裡自己的 js／css 每一個都帶了版本號。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./load');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('version.json、APP_VERSION、index.html 的 ?v= 三處一致', () => {
  const json = JSON.parse(read('version.json')).version;
  assert.match(json, /^\d{8}-\d+$/, 'version.json 的格式是 日期-序號');

  const app = (read('assets/js/app.js').match(/const APP_VERSION = '([^']+)'/) || [])[1];
  assert.equal(app, json, 'app.js 的 APP_VERSION 跟 version.json 不一樣');

  for (const page of ['index.html']) {
    const versions = new Set([...read(page).matchAll(/\?v=([\w-]+)/g)].map((m) => m[1]));
    assert.deepEqual([...versions], [json], `${page} 裡的 ?v= 有不一樣的：${[...versions].join('、')}`);
  }
});

test('index.html 裡自己的 js／css 每一個都帶版本號', () => {
  for (const [page, min] of [['index.html', 10]]) {
    const refs = [...read(page).matchAll(/(?:src|href)="((?:\.\.\/)?assets\/(?:js|css)\/[^"?]+)(\?v=[\w-]+)?"/g)];
    assert.ok(refs.length >= min, `${page} 應該至少有 ${min} 個 assets 的引用`);
    const missing = refs.filter((m) => !m[2]).map((m) => m[1]);
    assert.deepEqual(missing, [], `${page} 這些沒帶 ?v=：${missing.join('、')}`);
  }
});
