'use strict';
/*
 * 把 assets/js 底下的瀏覽器模組載進 Node 的測試環境。
 *
 * 這些模組都是 `(function (global) { … })(window)` 的寫法，把 API 掛在 window 上，
 * 沒有 module.exports。這裡用 vm 開一個沙盒，給它一個假的 window，執行完再把
 * window 交回來。載入順序照 index.html：normalize → holidays → registry → rules → sync。
 *
 * 沙盒只放測試會碰到的東西：localStorage 用記憶體版，document 只有最少的
 * createElement（rules.js 的畫面程式只在呼叫時才用到）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
  };
}

function fakeDocument() {
  const makeEl = (tag) => ({
    tagName: String(tag).toUpperCase(), children: [], style: {}, dataset: {},
    append(...nodes) { this.children.push(...nodes); },
    appendChild(n) { this.children.push(n); return n; },
    setAttribute() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
  });
  return {
    createElement: makeEl,
    createTextNode: (t) => ({ textContent: String(t) }),
    head: makeEl('head'), body: makeEl('body'),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {},
  };
}

/**
 * @param {string[]} [names] 要載入的模組（不含 .js），預設全部純邏輯模組
 * @param {object} [extra]   額外塞進沙盒的全域物件（例如 fetch）
 *
 * 不用 vm 開新的 context：那樣模組裡的 [] 與 {} 會是另一個 realm 的 Array／Object，
 * assert.deepEqual 一律判定不相等。改成把整支檔案包進一個函式，
 * 用參數把 window、document、localStorage 這些瀏覽器全域餵進去。
 */
function loadModules(names, extra) {
  const window = {
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    document: fakeDocument(),
    location: { origin: 'https://example.test', href: 'https://example.test/' },
    navigator: { userAgent: 'node-test', language: 'zh-TW' },
    fetch: (typeof fetch === 'function') ? fetch : undefined,
    addEventListener() {}, removeEventListener() {},
    ...(extra || {}),
  };
  window.window = window;
  window.self = window;
  const params = ['window', 'self', 'document', 'localStorage', 'sessionStorage', 'navigator', 'location', 'fetch'];
  (names || ['normalize', 'holidays', 'registry', 'rules', 'sync']).forEach((name) => {
    const file = path.join(ROOT, 'assets', 'js', `${name}.js`);
    const code = fs.readFileSync(file, 'utf8');
    // eslint-disable-next-line no-new-func
    const run = new Function(...params, `${code}\n//# sourceURL=${file}`);
    run(...params.map((k) => window[k]));
  });
  return window;
}

module.exports = { loadModules, ROOT };
