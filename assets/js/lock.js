/*
 * 密碼鎖。
 *
 * 使用者把網址分享給同事之後反悔了。名單本來就沒外流——資料只存在各自的瀏覽器，
 * 雲端同步走的是各自的 Google 帳號——所以要擋的只是「不讓他用這個工具」。
 *
 * 這是純前端的靜態網站，原始碼在 GitHub 上是公開的，所以：
 *   - 密碼**絕對不能**明文寫進程式裡，只放 PBKDF2 的雜湊與鹽。
 *   - 即使如此，這也只是「擋住不請自來的人」等級：懂技術的人可以把這段跳過。
 *     但跳過之後看到的仍然是一個空的網站（資料在本機，不在網址裡），所以不是漏洞，
 *     是門檻。這一點在 README 有寫清楚，不要讓人誤以為這是帳號系統。
 *   - 迭代次數開到 25 萬，讓離線暴力猜密碼慢到不值得。
 *
 * 解開之後記在這台裝置上，所以手機、電腦各輸入一次就好。
 */
(function (global) {
  'use strict';

  const SALT_HEX = '51e9b1a472e8c5ec09b0aa5b6b1f0b5d';
  const HASH_HEX = 'a025246b267006367ce98f0d622f27177777915f8e2c94083fe6dc04820b435a';
  const ITERATIONS = 250000;
  const OK_KEY = 'unlocked-2026';

  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const bytes = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

  async function digest(passcode) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: bytes(SALT_HEX), iterations: ITERATIONS, hash: 'SHA-256' },
      key, 256,
    );
    return hex(bits);
  }

  const remembered = () => {
    try { return localStorage.getItem(OK_KEY) === HASH_HEX; } catch (e) { return false; }
  };

  function unlock() {
    document.documentElement.removeAttribute('data-locked');
    const gate = document.getElementById('lockGate');
    if (gate) gate.remove();
  }

  function paintGate() {
    const box = document.createElement('div');
    box.className = 'lock-box';
    box.innerHTML = ''
      + '<h1>📞 電話推廣名單系統</h1>'
      + '<p>這個網站是私人的工作工具，請輸入密碼。</p>'
      + '<form id="lockForm" autocomplete="off">'
      + '<input id="lockInput" type="password" inputmode="text" autocomplete="off"'
      + ' autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="密碼" aria-label="密碼">'
      + '<button class="btn btn-primary" type="submit">進入</button>'
      + '</form>'
      + '<p class="lock-msg" id="lockMsg" hidden></p>'
      + '<p class="lock-note">解開之後這台裝置會記住，不用每次輸入。</p>';
    const gate = document.createElement('div');
    gate.id = 'lockGate';
    gate.className = 'lock-gate';
    gate.append(box);
    document.body.append(gate);

    const form = box.querySelector('#lockForm');
    const input = box.querySelector('#lockInput');
    const msg = box.querySelector('#lockMsg');
    const btn = box.querySelector('button');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      btn.disabled = true;
      btn.textContent = '檢查中…';
      msg.hidden = true;
      let got = '';
      try {
        got = await digest(value);
      } catch (err) {
        // 非 https 或很舊的瀏覽器沒有 crypto.subtle，講出原因而不是一直說密碼錯
        msg.textContent = `這個瀏覽器沒辦法檢查密碼（${err && err.message ? err.message : err}）。請改用 https 開啟，或換一個瀏覽器。`;
        msg.hidden = false;
        btn.disabled = false;
        btn.textContent = '進入';
        return;
      }
      btn.disabled = false;
      btn.textContent = '進入';
      if (got !== HASH_HEX) {
        msg.textContent = '密碼不對。';
        msg.hidden = false;
        input.select();
        return;
      }
      try { localStorage.setItem(OK_KEY, HASH_HEX); } catch (err) { /* 無痕模式：這次能用就好 */ }
      unlock();
    };
    input.focus();
  }

  /*
   * 本機不鎖。
   *
   * 要擋的是「分享出去的那個網址」。在自己電腦上跑（localhost／檔案打開）沒有這個
   * 問題——而且原始碼本來就是公開的，任何人都能自己跑起來，所以這裡鎖了也沒有多
   * 擋到誰，只會讓每一支自動測試都卡在門口。
   * 網址帶 ?lock=1 就照鎖，這樣這道門本身才測得到。
   */
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(location.hostname)
    || location.protocol === 'file:';
  const forced = /[?&]lock=1(&|$)/.test(location.search);
  if (local && !forced) { global.AppLock = { locked: () => false }; return; }

  // 一開始就鎖住：屬性在 <head> 的 CSS 裡把畫面蓋掉，避免先閃一下內容
  document.documentElement.setAttribute('data-locked', '1');
  const start = () => { if (remembered()) unlock(); else paintGate(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  global.AppLock = { locked: () => !remembered() };
})(window);
