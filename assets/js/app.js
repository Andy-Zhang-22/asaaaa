/*
 * app.js — 介面與流程。
 */
(function () {
  'use strict';

  const { OUTCOME_LABEL } = window.Normalize;
  /*
   * 靜態主機會把 js/css 快取起來，沒有版本號的話使用者更新後還是拿到舊檔案。
   * index.html 的每個 assets 網址都帶 ?v=，改版時一起換掉這個字串即可。
   */
  const APP_VERSION = '20260916-40';
  const PAGE_SIZE = 60;
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, props, children) => {
    const node = Object.assign(document.createElement(tag), props || {});
    (children || []).forEach((c) => node.append(c));
    return node;
  };

  const state = {
    records: [],
    logs: [],
    userStates: new Map(),
    tab: 'all',
    search: '',
    sort: 'next',
    limit: PAGE_SIZE,
    hideBlocked: true,
    filters: { due: '', dueFrom: '', dueTo: '', dueNone: false, source: new Set(), grade: new Set(), outcome: new Set(), city: new Set(), scale: new Set(), territory: new Set(), relation: new Set(), added: new Set(), industry: '' },
  };

  /* ---------------- 工具 ---------------- */

  // 每分鐘算一次就夠了，這個函式在篩選與排序裡會被呼叫上千次
  let todayCache = { at: 0, iso: '', ms: 0 };
  const todayISO = () => {
    const now = Date.now();
    if (now - todayCache.at > 60000) {
      const d = new Date();
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      todayCache = { at: now, iso, ms: Date.parse(`${iso}T00:00:00`) };
    }
    return todayCache.iso;
  };
  const addDays = (iso, n) => {
    const d = new Date(`${iso}T00:00:00`);
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  /*
   * 日期一律顯示西元 yyyy/mm/dd。
   *
   * 曾經改成民國年，使用者用了之後要求改回西元：他的 Excel 母檔、104 與
   * 商工登記全是西元，名單上混著民國反而要換算。
   */
  const dateLabel = (iso) => {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return `${y}/${m}/${d}`;
  };
  /*
   * 日期輸入框旁邊即時顯示 yyyy/mm/dd。
   *
   * <input type="date"> 的顯示格式跟著瀏覽器語系走，在使用者的電腦上是 mm/dd/yyyy，
   * 網頁改不了。選擇器本身很好用（有月曆、有快速鍵），不想換掉，
   * 所以在旁邊補一個跟名單同格式的標示，選了什麼一眼就對得上。
   */
  function withDateHint(input) {
    const hint = el('span', { className: 'date-hint' });
    const sync = () => { hint.textContent = input.value ? dateLabel(input.value) : ''; };
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    sync();
    return el('span', { className: 'date-with-hint' }, [input, hint]);
  }

  const dayDiff = (iso) => {
    todayISO();
    return Math.round((Date.parse(`${iso}T00:00:00`) - todayCache.ms) / 86400000);
  };

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  /** 使用者自己記的狀態會覆蓋 PDF 裡的原始值。 */
  function view(record) {
    const mine = state.userStates.get(record.id);
    const edits = (mine && mine.edits) || null;
    const base = edits ? { ...record, ...edits } : record;
    // 檔案裡「下次聯絡日」跟「最近聯絡日」填同一天，是使用者的習慣寫法，
    // 意思是那次沒有約下一次；照字面收會讓 19 筆沒約的客戶掛著逾期好幾個月。
    // 只套在檔案帶進來的值，使用者自己在網站上記的下次聯絡日照原樣。
    const fileNext = base.nextDate && base.nextDate === base.lastDate ? null : base.nextDate;
    const out = {
      ...base,
      nextDate: (mine && mine.nextDate) || fileNext,
      lastDate: (mine && mine.lastDate) || base.lastDate,
      outcome: (mine && mine.outcome) || base.outcome,
      starred: !!(mine && mine.starred),
      edited: !!edits,
    };
    // 電話與地址改過就要先重新解析，再去算衍生欄位。
    // 順序不能反過來：服務區域是從地址拆出來的縣市與行政區算的，先算就會拿到
    // 編輯前的舊縣市，改了地址之後篩選與卡片標記都不會跟著動。
    if (edits && edits.phoneRaw !== undefined) out.phones = window.Normalize.extractPhones(edits.phoneRaw);
    if (edits && edits.address !== undefined) Object.assign(out, window.Normalize.parseAddress(edits.address));

    out.scale = capitalScale(out);
    out.territory = territory(out);
    out.relations = window.Normalize.detectRelations(out.notesRaw);
    out.relationKinds = window.Normalize.relationKinds(out.relations);
    // 往來情形看的是「最新一次談話」，在網站上記的通話也算：打完電話聽到
    // 對方說已經解約，這筆就該立刻歸到沒有往來，不用等下次匯入檔案。
    const mineNotes = state.logs
      .filter((l) => l.recordId === record.id && l.text)
      .map((l) => `${(l.date || '').replace(/-/g, '/')} ${l.text}`)
      .join('\n');
    out.dealing = window.Normalize.detectDealing(mineNotes ? `${mineNotes}\n${out.notesRaw || ''}` : out.notesRaw);
    out.dealingKind = out.dealing.kind;
    /*
     * 禁止推廣獨立於 outcome。
     *
     * outcome 會被之後記的通話紀錄覆蓋，隨便記一通「已聯絡」就會把禁止推廣洗掉，
     * 那位客戶就悄悄回到待打名單裡。所以以訪談內容為準，再把使用者自己選的
     * 「禁止推廣」也算進來——兩邊任一成立就是禁打，只能加不能減。
     */
    out.blockedInfo = window.Normalize.detectBlocked(out.notesRaw);
    out.blocked = out.blockedInfo.blocked || out.outcome === 'blocked';
    return out;
  }

  /** 更新某一筆的個人狀態，保留既有欄位（通話結果與編輯內容互不覆蓋）。 */
  /*
   * 舊資料修復：把誤放到 KEYMAN／負責人／產業別的地址搬回地址欄。
   *
   * 匯入時的欄位判斷曾經讓人名欄位吃下地址（人名的驗證條件太寬鬆，而
   * 「新北市新莊區幸福東路79號4樓」正好符合），造成大量客戶顯示「未填地址」。
   * 匯入端已經修好，但已經進到資料庫的那些還在原地，而且使用者未必留著原始 PDF，
   * 所以提供這個就地修復。
   *
   * 搬移是寫成「編輯」而不是直接改原始資料：這樣看得出哪些是後來動過的，
   * 也會透過既有機制同步到其他裝置，不滿意還能用詳細頁的「還原成名單原始內容」退回。
   * 只處理地址欄本來就空的客戶，不會覆蓋任何已經有地址的資料。
   */
  const STRAY_FIELDS = [['keyman', 'KEYMAN'], ['owner', '負責人'], ['industry', '產業別']];

  function findStrayAddress(r) {
    for (const [field, label] of STRAY_FIELDS) {
      const value = window.Normalize.validateAddress(r[field] || '');
      if (value) return { field, label, value };
    }
    return null;
  }

  /*
   * 批次：把訪談內容裡寫到的下次聯絡日補進日期欄。
   *
   * 跟上面那個即時補的差別在於對象：這個處理的是已經在名單裡、
   * 當初匯入時就只讀日期欄的舊資料。判讀規則共用 findFollowUp()。
   *
   * 只碰「日期欄空白，或日期已經過去」的客戶——已經排好且還沒到的約訪不動，
   * 那是使用者自己排的，比訪談內容的舊字句可信。
   */
  /*
   * 刪掉單一筆客戶。
   *
   * 原本只能用「管理已匯入名單」整份刪掉，但實際上會遇到的是單筆要移除：
   * 公司倒了、統編重複、或是明確表示不要再打的。為了一筆而整份重匯不合理。
   *
   * 提示裡把會一起消失的東西講清楚（通話紀錄、編輯內容），因為這個動作救不回來。
   */
  function deleteBtn(r) {
    const btn = el('button', { className: 'btn btn-tiny danger', type: 'button', textContent: '刪除這筆' });
    btn.onclick = async () => {
      const logCount = state.logs.filter((l) => l.recordId === r.id).length;
      const extra = [
        logCount ? `${logCount} 則通話紀錄` : '',
        r.edited ? '你改過的欄位內容' : '',
      ].filter(Boolean).join('、');
      const ok = confirm(`確定要從名單刪掉「${r.company}」嗎？\n`
        + (extra ? `\n連同${extra}會一起刪掉。\n` : '')
        + '\n這個動作救不回來，其他裝置同步後也會一起消失。'
        + '\n（之後重新匯入同一份 PDF 的話，這筆會再出現）');
      if (!ok) return;
      await window.Store.deleteRecord(r.id);
      await reload();
      closeOverlays();
      render();
      toast(`已刪除「${r.company}」`);
      scheduleSync();
    };
    return btn;
  }

  /*
   * 檢查公司名稱。
   *
   * 名稱錯就沒辦法拿去比對商工登記——使用者就是卡在這裡。而錯的名稱多半是解析
   * 留下的痕跡：兩家黏在一起、地址或日期溢進來、整段過長。
   *
   * 分成兩堆處理，因為能做的事不一樣：
   *   - 兩家以上都有公司字尾 → 邊界明確，直接拆，第一家當公司名、其餘進別名。
   *   - 其他 → 邊界無從得知（「大同鐵工廠乙建設股份有限公司」要從哪裡切？），
   *     硬拆只會拆錯，列出來讓使用者自己改，並且點一下就能開到那一筆。
   */
  /*
   * 匯入經濟部登記清冊前，先問要留哪些。
   *
   * 使用者實際的篩選習慣是「資本額 6000 萬以下、服務區域內」，所以預設就填好，
   * 但留著可以改——他偶爾也會想看別的區間。畫面即時算出會留下幾筆，
   * 不用先匯進去才知道結果。
   */
  // cities 用函式而不是直接展開：SERVICE_CITIES 宣告在這支檔案的後面，
  // 直接寫 [...SERVICE_CITIES] 會在模組載入時就求值，那時它還沒初始化。
  const GOV_CITY_PRESETS = {
    dual: { label: '只要雙北', cities: () => ['臺北市', '新北市'] },
    service: { label: '整個服務範圍（新竹以北加宜蘭）', cities: () => [...SERVICE_CITIES] },
    all: { label: '不限縣市', cities: () => null },
  };

  function askGovFilter(filename, rows) {
    return new Promise((resolve) => {
      const host = $('#editorBody');
      host.textContent = '';
      host.append(el('h2', { textContent: '匯入經濟部登記清冊' }));
      host.append(el('p', { className: 'muted',
        textContent: `${filename} 共 ${rows.length - 1} 筆。這種清冊一次幾千筆，`
          + '整份匯進來會把名單淹掉，所以先選要留哪些。' }));

      const minIn = el('input', { type: 'number', value: '500', min: '0', step: '100' });
      const maxIn = el('input', { type: 'number', value: '6000', min: '0', step: '100' });
      const citySel = el('select', {}, Object.entries(GOV_CITY_PRESETS)
        .map(([k, v]) => el('option', { value: k, textContent: v.label })));
      const skipHolding = el('input', { type: 'checkbox' });

      host.append(el('label', { className: 'rule-field' }, [
        el('span', { textContent: '資本額下限（萬元）' }), minIn]));
      host.append(el('label', { className: 'rule-field' }, [
        el('span', { textContent: '資本額上限（萬元）' }), maxIn]));
      host.append(el('label', { className: 'rule-field' }, [
        el('span', { textContent: '地區' }), citySel]));
      host.append(el('label', { className: 'rule-field' }, [
        skipHolding, el('span', { textContent: ' 略過投資／控股類（看名字沒有設備標的，通常不值得打）' })]));

      const preview = el('div', { className: 'rule-result' });
      host.append(preview);

      const opts = () => ({
        minCapital: (Number(minIn.value) || 0) * 10000,
        maxCapital: (Number(maxIn.value) || 0) * 10000 || Infinity,
        cities: GOV_CITY_PRESETS[citySel.value].cities(),
      });

      let current = [];
      const recount = () => {
        const out = window.Normalize.fromGovRegistry(rows, opts());
        current = skipHolding.checked ? out.records.filter((r) => r.hasAssets) : out.records;
        preview.textContent = '';
        preview.append(el('p', { className: 'rule-verdict is-ok',
          textContent: `符合條件：${current.length} 筆` }));
        preview.append(el('p', { className: 'rule-note',
          textContent: `（資本額不符 ${out.stats.capitalOut} 筆、地區不符 ${out.stats.cityOut} 筆`
            + `${out.stats.dup ? `、重複 ${out.stats.dup} 筆` : ''}`
            + `${skipHolding.checked ? `、投資控股類 ${out.records.length - current.length} 筆` : ''}）` }));
        // 已經在名單裡的先講，不然匯進去才發現重複
        const known = new Set(state.records.map((r) => (r.taxId || '').replace(/\D/g, '')).filter(Boolean));
        const dup = current.filter((r) => r.taxId && known.has(r.taxId)).length;
        if (dup) {
          preview.append(el('p', { className: 'rule-note',
            textContent: `※ 其中 ${dup} 筆的統編已經在你的名單裡，匯入後會以這份資料更新它們。` }));
        }
        current.slice(0, 5).forEach((r) => {
          preview.append(el('div', { className: 'import-preview' }, [
            el('strong', { textContent: r.company }),
            el('p', { className: 'rule-note',
              textContent: `${r.capitalThousands} 仟元　${r.industry || '產業未知'}　${r.address}` }),
          ]));
        });
        if (current.length > 5) {
          preview.append(el('p', { className: 'rule-note', textContent: `※ 以上只列前 5 筆。` }));
        }
      };
      [minIn, maxIn].forEach((n) => { n.oninput = recount; });
      citySel.onchange = recount;
      skipHolding.onchange = recount;
      recount();

      const go = el('button', { className: 'btn btn-primary', type: 'button', textContent: '匯入' });
      const cancel = el('button', { className: 'btn', type: 'button', textContent: '取消' });
      go.onclick = () => {
        $('#editor').hidden = true;
        resolve(window.Normalize.govToStandardRows(current));
      };
      cancel.onclick = () => { $('#editor').hidden = true; resolve(null); };
      host.insertBefore(el('div', { className: 'card-actions' }, [go, cancel]), preview);

      $('#editor').hidden = false;
    });
  }

  async function reviewCompanyNames() {
    const fixable = [];
    const manual = [];
    state.records.forEach((rec) => {
      const r = view(rec);
      const why = window.Normalize.suspiciousName(r.company);
      if (!why) return;
      const split = window.Normalize.splitGluedName(r.company);
      if (split) fixable.push({ rec, r, why, split });
      else manual.push({ rec, r, why });
    });

    if (!fixable.length && !manual.length) { toast('公司名稱看起來都正常'); return; }

    const host = $('#editorBody');
    host.textContent = '';
    host.append(el('h2', { textContent: '公司名稱檢查' }));
    host.append(el('p', { className: 'muted',
      textContent: `名單共 ${state.records.length} 筆，找到 ${fixable.length + manual.length} 筆名稱看起來有問題。`
        + '名稱不對就沒辦法拿去比對商工登記，所以要先處理這裡。' }));

    if (fixable.length) {
      const sec = el('div', { className: 'detail-section' }, [
        el('h3', { textContent: `可以自動拆開（${fixable.length} 筆）` }),
        el('p', { className: 'muted', textContent: '兩家以上都有公司字尾，邊界很明確。第一家留作公司名，其餘存成別名，搜尋一樣找得到。' }),
      ]);
      fixable.slice(0, 15).forEach(({ r, split }) => {
        sec.append(el('div', { className: 'import-preview' }, [
          el('p', { textContent: `${r.company}` }),
          el('p', { className: 'rule-note', textContent: `→ ${split.company}　＋別名：${split.aliases.join('、')}` }),
        ]));
      });
      if (fixable.length > 15) sec.append(el('p', { className: 'rule-note', textContent: `※ 另外還有 ${fixable.length - 15} 筆，這裡只列前 15 筆。` }));

      const go = el('button', { className: 'btn btn-primary', type: 'button', textContent: `拆開這 ${fixable.length} 筆` });
      go.onclick = async () => {
        go.disabled = true;
        for (const { rec, split } of fixable) {
          const existing = state.userStates.get(rec.id) || {};
          await saveState(rec.id, {
            edits: { ...(existing.edits || {}), company: split.company },
            editsAt: Date.now(),
          });
        }
        await reload();
        closeOverlays();
        render();
        toast(`已拆開 ${fixable.length} 筆公司名稱`);
        scheduleSync();
      };
      sec.append(el('div', { className: 'card-actions' }, [go]));
      host.append(sec);
    }

    if (manual.length) {
      const sec = el('div', { className: 'detail-section' }, [
        el('h3', { textContent: `要自己確認（${manual.length} 筆）` }),
        el('p', { className: 'muted',
          textContent: '這幾筆看得出不對，但正確的斷點無從判斷，自動改只會改錯。點公司名稱可以直接開啟那一筆修改。' }),
      ]);
      manual.slice(0, 40).forEach(({ rec, r, why }) => {
        const link = el('button', { className: 'btn btn-tiny', type: 'button', textContent: r.company || '（空白）' });
        link.onclick = () => { closeOverlays(); openDetail(rec.id); };
        sec.append(el('div', { className: 'import-preview' }, [
          link, el('p', { className: 'rule-note', textContent: why }),
        ]));
      });
      if (manual.length > 40) sec.append(el('p', { className: 'rule-note', textContent: `※ 另外還有 ${manual.length - 40} 筆，這裡只列前 40 筆。` }));
      host.append(sec);
    }

    $('#editor').hidden = false;
  }

  async function repairFollowUps() {
    const today = todayISO();
    const targets = [];
    state.records.forEach((rec) => {
      const r = view(rec);
      if (r.nextDate && r.nextDate >= today) return;
      const found = window.Normalize.findFollowUp(r.notesRaw, today);
      if (found && found.iso !== r.nextDate) targets.push({ rec, r, found });
    });

    if (!targets.length) { toast('訪談內容裡沒有找到可以補的下次聯絡日'); return; }

    const samples = targets.slice(0, 5)
      .map((t) => `　・${t.r.company}\n　　「${t.found.snippet}」→ ${dateLabel(t.found.iso)}`).join('\n');
    const ok = confirm(`找到 ${targets.length} 筆客戶的訪談內容寫了再聯絡的日期，但日期欄是空的或已經過期：\n\n`
      + `${samples}\n\n`
      + '要把這些日期補進去嗎？\n（已經排好、還沒到的約訪不會被動到；補進去的可以在詳細頁改回來）');
    if (!ok) return;

    for (const { rec, found } of targets) {
      await saveState(rec.id, { nextDate: found.iso });
    }
    await reload();
    render();
    toast(`已補上 ${targets.length} 筆下次聯絡日`);
    scheduleSync();
  }

  async function repairStrayAddresses() {
    const targets = [];
    state.records.forEach((rec) => {
      const r = view(rec);
      if (r.address) return;                      // 已經有地址的完全不碰
      const stray = findStrayAddress(r);
      if (stray) targets.push({ rec, r, stray });
    });

    if (!targets.length) {
      toast('沒有找到錯置的地址，不需要修復');
      return;
    }

    const byField = new Map();
    targets.forEach((t) => byField.set(t.stray.label, (byField.get(t.stray.label) || 0) + 1));
    const breakdown = [...byField.entries()].map(([label, n]) => `　・${label}：${n} 筆`).join('\n');
    const samples = targets.slice(0, 3)
      .map((t) => `　・${t.r.company}\n　　${t.stray.label} → 地址：${t.stray.value}`).join('\n');

    const ok = confirm(`找到 ${targets.length} 筆地址被放到別的欄位：\n${breakdown}\n\n`
      + `例如：\n${samples}\n\n`
      + '要把它們搬回地址欄嗎？\n（會記錄成「已修改」，可以在各客戶的詳細頁還原）');
    if (!ok) return;

    for (const { rec, r, stray } of targets) {
      const existing = state.userStates.get(rec.id) || {};
      const edits = { ...(existing.edits || {}) };
      edits.address = stray.value;
      // 原本那格放的是地址不是人名／產業別，一併清掉才不會兩邊都顯示同一串
      if ((r[stray.field] || '').trim() === stray.value.trim()) edits[stray.field] = '';
      await saveState(rec.id, { edits, editsAt: Date.now() });
    }

    await reload();
    render();
    toast(`已修復 ${targets.length} 筆地址`);
    scheduleSync();
  }

  async function saveState(recordId, patch) {
    const merged = { ...(state.userStates.get(recordId) || { recordId }), ...patch, recordId };
    await window.Store.setState(merged);
    state.userStates.set(recordId, merged);
    touch();
    return merged;
  }

  /*
   * 服務範圍：新竹以北加宜蘭都能服務，其中新北市這九個區是首要目標。
   * 範圍外的客戶依【一般組】行銷規範第(三)項要走協銷，卡片上先標出來，
   * 免得打到一半才發現。
   */
  const PRIORITY_DISTRICTS = new Set(['新莊區', '三重區', '林口區', '泰山區', '五股區',
    '八里區', '淡水區', '蘆洲區', '樹林區']);
  const SERVICE_CITIES = new Set(['臺北市', '新北市', '基隆市', '桃園市',
    '新竹市', '新竹縣', '宜蘭縣']);

  function territory(record) {
    const city = record.city || '';
    if (!city) return '';
    if (city === '新北市' && PRIORITY_DISTRICTS.has(record.district)) return '優先區域';
    return SERVICE_CITIES.has(city) ? '服務範圍' : '範圍外';
  }

  /** 資本額（仟元）≤ 10,000 者屬微型企業營業處客戶範疇，見規則頁。 */
  function capitalScale(record) {
    const value = Number(String(record.capital || '').replace(/[^\d.]/g, ''));
    if (!value) return '';
    return value <= (window.Rules ? window.Rules.MICRO_CAPITAL_LIMIT : 10000) ? '微企範疇' : '一般組範疇';
  }

  /*
   * 每次重繪都把幾百筆資料重新攤平一次，切換分頁與打字才會卡。
   * 這裡把整理好的資料快取起來，只有資料本身或日期變了才重算，
   * 順便把到期分組、客戶規模與搜尋索引一次算完，後面就不必重複計算。
   */
  let dataVersion = 0;
  let viewsKey = '';
  let viewsCache = [];
  const touch = () => { dataVersion += 1; };

  function allViews() {
    const key = `${dataVersion}|${todayISO()}`;
    if (viewsKey === key) return viewsCache;
    viewsCache = state.records.map((record) => {
      const v = view(record);
      v.bucket = dueBucket(v.nextDate);
      v.addedBucket = addedBucket(v.addedDate);
      v.blob = [v.company, v.aliases.join(' '), v.taxId, v.owner, v.keyman, v.industry,
        v.phoneRaw, v.address, v.notesRaw, v.source].join(' ').toLowerCase();
      return v;
    });
    viewsKey = key;
    return viewsCache;
  }

  /*
   * 名單是什麼時候進來的。
   *
   * 用「離今天多久」而不是列出每一個日期：從 PDF 匯進來的客戶，名單新增日期是
   * 來源檔裡的原始日期，散落好幾年、有上百個不同的值，一個日期一顆按鈕會變成
   * 一面牆。反過來，同一批匯入的會共用同一天，所以「今天」「7 天內」就足以
   * 把剛加進來的那批圈出來。
   *
   * 要精確找某一批的話，「名單來源」那個篩選更直接——匯入時的檔名就是來源。
   */
  function addedBucket(iso) {
    if (!iso) return '未填';
    const diff = -dayDiff(iso);          // dayDiff 是「未來還有幾天」，這裡要反過來
    if (diff < 0) return '未填';         // 日期在未來，多半是解析錯的
    if (diff === 0) return '今天新增';
    if (diff <= 7) return '7 天內';
    if (diff <= 30) return '30 天內';
    if (diff <= 365) return '一年內';
    return '更早';
  }

  const ADDED_ORDER = ['今天新增', '7 天內', '30 天內', '一年內', '更早', '未填'];

  /*
   * 聯絡時程改成「自選日期區間」。
   *
   * 之前是九顆互相重疊的區間按鈕（今天以前、逾期 1–7 天、逾期 8–30 天……），
   * 使用者用過之後說不合用：他要看的常常是「這週」「下週」「這個月」這種
   * 行事曆上的一段，而不是以今天為原點往前後數幾天。所以改成兩個日期框直接
   * 框「下次聯絡日」，旁邊放幾顆快速鍵把常用的區間一鍵填進去；快速鍵填完
   * 的日期還能再手動微調。
   *
   * 週以星期一為起點、星期日為終點，跟業務的行事曆一致。
   */
  function weekOf(iso, offsetWeeks) {
    const d = new Date(`${iso}T00:00:00`);
    const monday = addDays(iso, -((d.getDay() + 6) % 7) + offsetWeeks * 7);
    return [monday, addDays(monday, 6)];
  }
  function monthOf(iso) {
    const [y, m] = iso.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return [`${iso.slice(0, 7)}-01`, `${iso.slice(0, 7)}-${String(last).padStart(2, '0')}`];
  }
  /** 每顆快速鍵回傳 { from, to } 或 { none: true }；空字串代表不設限。 */
  const DUE_QUICK = [
    ['', '全部', () => ({ from: '', to: '' })],
    ['overdue', '逾期', (t) => ({ from: '', to: addDays(t, -1) })],
    ['today', '今天', (t) => ({ from: t, to: t })],
    ['week', '本週', (t) => { const [a, b] = weekOf(t, 0); return { from: a, to: b }; }],
    ['nextWeek', '下週', (t) => { const [a, b] = weekOf(t, 1); return { from: a, to: b }; }],
    ['month', '本月', (t) => { const [a, b] = monthOf(t); return { from: a, to: b }; }],
    ['none', '未排定', () => ({ none: true })],
  ];

  /** 下次聯絡日落在目前設定的區間內？沒設限就全過。 */
  function matchDue(f, nextDate) {
    if (f.dueNone) return !nextDate;
    if (!f.dueFrom && !f.dueTo) return true;
    if (!nextDate) return false;
    if (f.dueFrom && nextDate < f.dueFrom) return false;
    if (f.dueTo && nextDate > f.dueTo) return false;
    return true;
  }

  function applyDueQuick(key) {
    const quick = DUE_QUICK.find(([k]) => k === key);
    const got = quick ? quick[2](todayISO()) : { from: '', to: '' };
    state.filters.due = key;
    state.filters.dueNone = !!got.none;
    state.filters.dueFrom = got.from || '';
    state.filters.dueTo = got.to || '';
    syncDueInputs();
  }

  function syncDueInputs() {
    const from = $('#dueFrom');
    const to = $('#dueTo');
    if (!from || !to) return;
    from.value = state.filters.dueFrom;
    to.value = state.filters.dueTo;
    from.disabled = to.disabled = state.filters.dueNone;
  }

  function dueBucket(iso) {
    if (!iso) return 'none';
    const diff = dayDiff(iso);
    if (diff < 0) return 'overdue';
    if (diff === 0) return 'today';
    if (diff <= 7) return 'week';
    return 'later';
  }

  /* ---------------- 篩選與排序 ---------------- */

  function visibleRecords() {
    const q = state.search.trim().toLowerCase();
    const f = state.filters;
    const terms = q ? q.split(/\s+/) : [];

    let list = allViews().filter((r) => {
      if (state.hideBlocked && r.blocked) return false;
      if (f.source.size && !f.source.has(r.source)) return false;
      if (f.grade.size && !f.grade.has(r.grade || '未分級')) return false;
      if (f.outcome.size && !f.outcome.has(r.blocked ? 'blocked' : r.outcome)) return false;
      if (f.city.size && !f.city.has(r.city || '其他')) return false;
      if (f.scale.size && !f.scale.has(r.scale || '未填資本額')) return false;
      if (f.territory.size && !f.territory.has(r.territory || '未填地址')) return false;
      if (f.relation.size && !f.relation.has(r.dealingKind)) return false;
      if (f.added.size && !f.added.has(r.addedBucket)) return false;
      if (f.industry && !(r.industry || '').includes(f.industry)) return false;
      if (!matchDue(f, r.nextDate)) return false;
      if (terms.length && !terms.every((t) => r.blob.includes(t))) return false;
      return true;
    });


    const gradeRank = { S: 0, 'S?': 1, A: 2, B: 3, C: 4 };
    const num = (s) => Number(String(s || '').replace(/[^\d]/g, '')) || 0;
    const cmp = {
      next: (a, b) => (a.nextDate || '9999').localeCompare(b.nextDate || '9999'),
      last: (a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''),
      grade: (a, b) => (gradeRank[a.grade] ?? 9) - (gradeRank[b.grade] ?? 9),
      capital: (a, b) => num(b.capital) - num(a.capital),
      company: (a, b) => a.company.localeCompare(b.company, 'zh-Hant'),
      territory: (a, b) => {
        const rank = { 優先區域: 0, 服務範圍: 1, '': 2, 範圍外: 3 };
        return (rank[a.territory] ?? 2) - (rank[b.territory] ?? 2)
          || (a.nextDate || '9999').localeCompare(b.nextDate || '9999');
      },
    }[state.sort];
    list.sort((a, b) => cmp(a, b) || a.company.localeCompare(b.company, 'zh-Hant'));
    return list;
  }

  /* ---------------- 畫面 ---------------- */

  let chipsKey = '';

  /** 只更新按鈕的選取狀態，不動 DOM 結構。 */
  function syncChipStates() {
    document.querySelectorAll('#filters .chip[data-filter]').forEach((chip) => {
      const { filter, value } = chip.dataset;
      const on = filter === 'due'
        ? state.filters.due === value
        : state.filters[filter].has(value);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function renderFilters() {
    // 篩選選項的內容只跟資料有關，跟搜尋字串或目前選了什麼無關，
    // 所以資料沒變就不要重建幾十顆按鈕——那是打字會頓的主因之一。
    const key = String(dataVersion);
    if (chipsKey === key) { syncChipStates(); return; }
    chipsKey = key;

    const all = allViews();
    const tally = (pick) => {
      const m = new Map();
      all.forEach((r) => {
        const v = pick(r);
        m.set(v, (m.get(v) || 0) + 1);
      });
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };

    const chips = (host, filter, items, setRef, labelOf) => {
      host.textContent = '';
      items.forEach(([value, count]) => {
        const btn = el('button', { className: 'chip', type: 'button' });
        btn.dataset.filter = filter;
        btn.dataset.value = value;
        btn.append(el('small', { textContent: String(count) }),
          document.createTextNode(' ' + (labelOf ? labelOf(value) : value)));
        btn.onclick = () => {
          setRef.has(value) ? setRef.delete(value) : setRef.add(value);
          state.limit = PAGE_SIZE;
          render();
        };
        host.append(btn);
      });
    };

    const dueHost = $('#fltDue');
    dueHost.textContent = '';
    const today = todayISO();
    DUE_QUICK.forEach(([value, label, rangeOf]) => {
      const btn = el('button', { className: 'chip', type: 'button' });
      btn.dataset.filter = 'due';
      btn.dataset.value = value;
      // 每顆都標筆數。沒有數字就看不出哪一段積最多，也就無從決定今天先處理哪一堆
      if (value) {
        const got = rangeOf(today);
        const probe = { dueNone: !!got.none, dueFrom: got.from || '', dueTo: got.to || '' };
        const n = all.filter((r) => matchDue(probe, r.nextDate)).length;
        btn.append(el('small', { textContent: String(n) }), document.createTextNode(' ' + label));
      } else {
        btn.textContent = label;
      }
      btn.onclick = () => { applyDueQuick(value); state.limit = PAGE_SIZE; render(); };
      dueHost.append(btn);
    });

    chips($('#fltSource'), 'source', tally((r) => r.source), state.filters.source, (v) => v.replace(/\.pdf$/i, ''));
    chips($('#fltGrade'), 'grade', tally((r) => r.grade || '未分級'), state.filters.grade);
    // 禁打以 blocked 為準：outcome 可能已經被後來的通話紀錄蓋掉了
    chips($('#fltOutcome'), 'outcome', tally((r) => (r.blocked ? 'blocked' : r.outcome)),
      state.filters.outcome, (v) => OUTCOME_LABEL[v] || v);
    chips($('#fltCity'), 'city', tally((r) => r.city || '其他').slice(0, 12), state.filters.city);
    chips($('#fltScale'), 'scale', tally((r) => r.scale || '未填資本額'), state.filters.scale);
    chips($('#fltTerritory'), 'territory', tally((r) => r.territory || '未填地址'), state.filters.territory);

    // 二分法，順序固定成「有往來 → 沒往來」，不跟著筆數浮動
    const dealCounts = [['active', 0], ['none', 0]];
    all.forEach((r) => { dealCounts[r.dealingKind === 'active' ? 0 : 1][1] += 1; });
    chips($('#fltRelation'), 'relation', dealCounts.filter(([, n]) => n > 0),
      state.filters.relation, (v) => window.Normalize.DEALING_LABEL[v]);

    // 順序固定成由新到舊，不依筆數排——「今天新增」永遠在第一個位置才好按
    const addedCounts = new Map(ADDED_ORDER.map((k) => [k, 0]));
    all.forEach((r) => { addedCounts.set(r.addedBucket, (addedCounts.get(r.addedBucket) || 0) + 1); });
    chips($('#fltAdded'), 'added',
      ADDED_ORDER.filter((k) => addedCounts.get(k)).map((k) => [k, addedCounts.get(k)]),
      state.filters.added);

    const industries = [...new Set(all.map((r) => r.industry).filter(Boolean))].sort();
    $('#industryList').textContent = '';
    industries.forEach((i) => $('#industryList').append(el('option', { value: i })));
    syncChipStates();
  }

  function outcomeBadge(r) {
    // 禁打另外有專屬的紅色標記，這裡再畫一次會變成同一句話出現兩遍
    if (r.blocked) return '';
    return el('span', {
      className: `badge out-${r.outcome}`,
      textContent: OUTCOME_LABEL[r.outcome] || r.outcome,
    });
  }

  /**
   * 把文字複製到剪貼簿。navigator.clipboard 需要安全來源，
   * 以 file:// 開啟或舊瀏覽器會沒有，所以留一個備援。
   */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const box = el('textarea', { value: text });
      box.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.append(box);
      box.select();
      const ok = document.execCommand('copy');
      box.remove();
      return ok;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  /** 一支電話 = 撥號連結 + 複製鈕。複製的是純數字，貼到撥號鍵盤直接可用。 */
  function telGroup(p) {
    const digits = String(p.dial || '').split(',')[0];
    const ext = String(p.dial || '').split(',')[1] || '';

    const link = el('a', { className: 'tel', href: `tel:${p.dial}` });
    link.append(document.createTextNode(`📞 ${p.display}${p.note ? ` · ${p.note}` : ''}`));
    link.onclick = (e) => e.stopPropagation();

    const copy = el('button', {
      className: 'tel-copy', type: 'button',
      title: `複製 ${digits}`, 'aria-label': `複製電話 ${digits}`, textContent: '複製',
    });
    copy.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ok = await copyText(digits);
      toast(ok
        ? `已複製 ${digits}${ext ? `（分機 ${ext}）` : ''}`
        : '複製失敗，請手動選取號碼');
    };

    return el('span', { className: 'tel-group' }, [link, copy]);
  }

  function telLinks(r, limit) {
    return (limit ? r.phones.slice(0, limit) : r.phones).map(telGroup);
  }

  function card(r) {
    const bucket = r.bucket || dueBucket(r.nextDate);
    const node = el('article', {
      className: `card${bucket === 'today' ? ' is-due' : ''}${bucket === 'overdue' ? ' is-overdue' : ''}`,
      tabIndex: 0,
    });
    const top = el('div', { className: 'card-top' }, [
      el('span', { className: 'card-name', textContent: r.company }),
      r.grade ? el('span', { className: `badge badge-grade badge-${r.grade}`, textContent: r.grade }) : '',
      outcomeBadge(r),
      (r.scale || capitalScale(r)) === '微企範疇' ? el('span', { className: 'badge badge-micro', textContent: '微企範疇' }) : '',
      r.territory === '優先區域' ? el('span', { className: 'badge badge-priority', textContent: '優先區域' }) : '',
      r.territory === '範圍外' ? el('span', { className: 'badge badge-outside', textContent: '範圍外·需協銷' }) : '',
      r.blocked ? el('span', { className: 'badge badge-blocked', textContent: '禁止推廣' }) : '',
      r.dealingKind === 'active' ? el('span', { className: 'badge badge-dealing', textContent: '有往來' }) : '',
    ].filter(Boolean));
    node.append(top);

    const meta = el('div', { className: 'card-meta' });
    const bits = [
      r.industry && `🏷 ${r.industry}`,
      (r.keyman || r.owner) && `👤 ${r.keyman || r.owner}`,
      (r.city || r.address) && `📍 ${r.city}${r.district}`,
      r.capital && `💰 ${r.capital} 仟元`,
      r.nextDate && `📅 下次 ${dateLabel(r.nextDate)}${bucket === 'overdue' ? `（逾期 ${-dayDiff(r.nextDate)} 天）` : ''}`,
      r.lastDate && `🕘 最近 ${dateLabel(r.lastDate)}`,
      `📄 ${r.source.replace(/\.pdf$/i, '')}`,
    ].filter(Boolean);
    bits.forEach((b) => meta.append(el('span', { textContent: b })));
    node.append(meta);

    /*
     * 卡片上那一句要是「最新的談話內容」，不管它是檔案帶進來的還是在網站上記的。
     * 之前只看檔案的訪談內容，在網站上打完電話記的那則永遠上不了卡片，
     * 使用者看到的一直是匯入時的舊話。兩邊各取最新的一則比日期，同一天算
     * 網站上記的比較新（它是匯入之後才寫的）。
     */
    const fromFile = (r.timeline || [])[0];
    const mine = state.logs.filter((l) => l.recordId === r.id).sort((a, b) => b.createdAt - a.createdAt)[0];
    let latest = fromFile;
    if (mine && (!fromFile || !fromFile.date || (mine.date || '') >= fromFile.date)) {
      latest = { text: mine.text || `（${OUTCOME_LABEL[mine.outcome] || ''}）` };
    }
    if (latest) node.append(el('p', { className: 'card-notes', textContent: latest.text }));
    if (r.phones.length) {
      const actions = el('div', { className: 'card-actions' });
      telLinks(r, 2).forEach((a) => actions.append(a));
      node.append(actions);
    }

    node.onclick = () => openDetail(r.id);
    node.onkeydown = (e) => { if (e.key === 'Enter') openDetail(r.id); };
    return node;
  }

  let listKey = '';

  function renderList() {
    // 條件沒變就不用重建幾百個節點（例如從統計切回來時）。
    // 篩選條件用走訪的方式組 key，以後新增篩選才不會忘了加進來而讓畫面不更新。
    const filterKey = Object.entries(state.filters)
      .map(([name, value]) => `${name}:${value instanceof Set ? [...value].sort().join(',') : value}`)
      .join('|');
    const key = [dataVersion, state.tab, state.search, state.sort,
      state.limit, state.hideBlocked, filterKey].join('|');
    if (listKey === key) return;
    listKey = key;

    const list = visibleRecords();
    const host = $('#cards');
    host.textContent = '';
    list.slice(0, state.limit).forEach((r) => host.append(card(r)));

    $('#listSummary').textContent = `顯示 ${Math.min(state.limit, list.length)} / ${list.length} 筆`;
    $('#btnMore').hidden = list.length <= state.limit;
    const empty = $('#emptyState');
    if (list.length) {
      empty.hidden = true;
    } else {
      empty.hidden = false;
      empty.textContent = '';
      if (!state.records.length) {
        empty.append(
          el('strong', { textContent: '還沒有名單' }),
          el('p', { textContent: '按右上角「匯入 PDF」，選擇雲端硬碟裡的電話推廣名單 PDF。' })
        );
      } else {
        empty.append(
          el('strong', { textContent: '沒有符合條件的客戶' }),
          el('p', { textContent: '試著放寬篩選條件或清除搜尋。' })
        );
      }
    }
  }

  function bar(label, value, max) {
    return el('div', { className: 'bar' }, [
      el('span', { textContent: label }),
      el('i', { style: `width:${max ? Math.max(2, (value / max) * 100) : 0}%` }),
      el('u', { textContent: String(value) }),
    ]);
  }

  function renderStats() {
    const all = allViews();
    const host = $('#paneStats');
    host.textContent = '';
    if (!all.length) {
      host.append(el('div', { className: 'empty' }, [el('strong', { textContent: '匯入名單後就會有統計' })]));
      return;
    }

    const buckets = all.reduce((acc, r) => {
      acc[r.bucket] = (acc[r.bucket] || 0) + 1;
      return acc;
    }, {});
    const cards = [
      ['名單總數', all.length],
      ['逾期未聯絡', buckets.overdue || 0],
      ['今日到期', buckets.today || 0],
      ['一週內', buckets.week || 0],
      ['本機通話紀錄', state.logs.length],
      ['已約訪／有意願', all.filter((r) => ['meeting', 'interested'].includes(r.outcome)).length],
    ];
    const row = el('div', { className: 'stat-row' });
    cards.forEach(([label, value]) => row.append(
      el('div', { className: 'stat' }, [el('b', { textContent: String(value) }), el('span', { textContent: label })])
    ));
    host.append(row);

    const group = (key) => {
      const m = new Map();
      all.forEach((r) => {
        const v = key(r) || '未填';
        m.set(v, (m.get(v) || 0) + 1);
      });
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const section = (title, entries, labelOf) => {
      const max = Math.max(...entries.map((e) => e[1]), 1);
      const box = el('div', { className: 'bars' }, [el('h3', { textContent: title })]);
      entries.slice(0, 12).forEach(([k, v]) => box.append(bar(labelOf ? labelOf(k) : k, v, max)));
      host.append(box);
    };
    section('洽談狀態', group((r) => r.outcome), (k) => OUTCOME_LABEL[k] || k);
    section('分級', group((r) => r.grade));
    section('名單來源', group((r) => r.source), (k) => k.replace(/\.pdf$/i, ''));
    section('縣市 Top 12', group((r) => r.city));
    section('產業別 Top 12', group((r) => r.industry));
  }

  let statsKey = '';
  let rulesRendered = false;

  /** 規則頁不依賴名單資料，建一次就好。 */
  function buildRules() {
    if (rulesRendered) return;
    window.Rules.render($('#paneRules'));
    rulesRendered = true;
  }

  /**
   * 規則頁有三組表單與多張表格，第一次建構要花掉幾百毫秒。
   * 趁使用者還在看名單的空檔先做好，點過去的時候就不會等。
   */
  function prebuildRules() {
    const run = () => { try { buildRules(); } catch (err) { console.error(err); } };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 3000 });
    else setTimeout(run, 800);
  }

  function render() {
    const total = state.records.length;
    $('#countAll').textContent = String(total);
    const sources = new Set(state.records.map((r) => r.source));
    $('#brandSub').textContent = total
      ? `${total} 筆客戶 · ${sources.size} 份名單`
      : '尚未匯入名單';

    const tab = state.tab;
    $('#paneList').hidden = tab !== 'all';
    $('#paneStats').hidden = tab !== 'stats';
    $('#paneRules').hidden = tab !== 'rules';
    // 統計與規則頁用不到左側篩選，讓內容佔滿整個寬度
    const wide = tab === 'stats' || tab === 'rules';
    document.querySelector('.layout').classList.toggle('is-wide', wide);
    $('#filters').hidden = wide;
    $('#btnFilters').hidden = wide;
    renderFilters();
    if (tab === 'stats') {
      // 統計只跟資料有關，資料沒變就不用重畫幾十根長條
      if (statsKey !== String(dataVersion)) { renderStats(); statsKey = String(dataVersion); }
    } else if (tab === 'rules') {
      buildRules();
    } else renderList();
  }

  /* ---------------- 詳細資料抽屜 ---------------- */

  function openDetail(id) {
    const raw = state.records.find((r) => r.id === id);
    if (!raw) return;
    const r = view(raw);
    const body = $('#drawerBody');
    body.textContent = '';

    const editBtn = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '編輯資料' });
    editBtn.onclick = () => openEditor(r.id);
    body.append(el('div', { className: 'detail-head' }, [
      el('h2', { textContent: r.company }),
      r.aliases.length ? el('p', { className: 'detail-alias', textContent: `關係企業：${r.aliases.join('、')}` }) : '',
      el('div', { className: 'detail-badges' }, [
        r.grade ? el('span', { className: `badge badge-grade badge-${r.grade}`, textContent: `分級 ${r.grade}` }) : '',
        outcomeBadge(r),
        r.edited ? el('span', { className: 'badge badge-edited', textContent: '已修改' }) : '',
        editBtn,
        deleteBtn(r),
      ].filter(Boolean)),
    ].filter(Boolean)));

    /*
     * 禁打的警告放在最上面、電話的上面。
     *
     * 放下面沒有用：撥號鍵就在上面，看到電話就會直接按下去。
     */
    if (r.blocked) {
      const warn = el('div', { className: 'blocked-warning' }, [
        el('strong', { textContent: '⛔ 禁止推廣 — 請勿撥打' }),
      ]);
      if (r.blockedInfo.snippet) {
        warn.append(el('p', { textContent: `訪談內容：「${r.blockedInfo.snippet}」` }));
      } else {
        warn.append(el('p', { textContent: '這筆是在通話結果裡被標記為禁止推廣的。' }));
      }
      body.append(warn);
    }

    if (r.phones.length) {
      const box = el('div', { className: 'card-actions' });
      telLinks(r).forEach((a) => box.append(a));
      body.append(box);
    } else if (r.phoneRaw) {
      body.append(el('p', { className: 'muted', textContent: `電話：${r.phoneRaw}` }));
    }

    const dl = el('dl', { className: 'detail-grid' });
    const rows = [
      ['統一編號', r.taxId], ['負責人', r.owner], ['KEYMAN', r.keyman],
      ['產業別', r.industry], ['成立年', r.founded],
      ['資本額', r.capital ? `${r.capital} 仟元${capitalScale(r) ? `（${capitalScale(r)}）` : ''}` : ''],
      ['下次聯絡', r.nextDate ? dateLabel(r.nextDate) : ''],
      ['最近聯絡', r.lastDate ? dateLabel(r.lastDate) : ''],
      ['名單新增', r.addedDate ? dateLabel(r.addedDate) : ''],
    ];
    rows.forEach(([k, v]) => {
      if (!v) return;
      dl.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
    });
    if (r.territory) {
      dl.append(el('dt', { textContent: '服務區域' }),
        el('dd', { textContent: r.territory === '範圍外'
          ? '範圍外——依【一般組】行銷規範第(三)項應採協銷辦理'
          : r.territory }));
    }
    if (r.address) {
      dl.append(el('dt', { textContent: '地址' }));
      const dd = el('dd');
      const link = el('a', {
        href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.address)}`,
        target: '_blank', rel: 'noopener', textContent: r.address,
      });
      dd.append(link);
      dl.append(dd);
    }
    // 名單來源放最後，看的頻率最低
    if (r.source) dl.append(el('dt', { textContent: '名單來源' }), el('dd', { textContent: r.source }));
    body.append(dl);

    // 通話紀錄表單
    const section = el('div', { className: 'detail-section' }, [el('h3', { textContent: '記錄這通電話' })]);
    const form = el('div', { className: 'logform' });
    const memo = el('textarea', { placeholder: '這通電話聊了什麼？（例如：總機轉接財務長，約下週三拜訪）' });
    const outcomeSel = el('select');
    ['noanswer', 'contacted', 'interested', 'meeting', 'declined', 'blocked'].forEach((k) => {
      outcomeSel.append(el('option', { value: k, textContent: OUTCOME_LABEL[k] }));
    });
    outcomeSel.value = r.outcome === 'new' ? 'noanswer' : r.outcome;
    const nextInput = el('input', { type: 'date', value: r.nextDate || '' });
    const quick = el('div', { className: 'card-actions' });
    [['明天', 1], ['3 天後', 3], ['一週後', 7], ['兩週後', 14], ['一個月後', 30], ['三個月後', 90]].forEach(([label, days]) => {
      const b = el('button', { className: 'btn btn-tiny', type: 'button', textContent: label });
      b.onclick = () => {
        nextInput.value = addDays(todayISO(), days);
        // 直接改 value 不會觸發事件，旁邊的日期提示要靠這個才會跟著換
        nextInput.dispatchEvent(new Event('change'));
      };
      quick.append(b);
    });
    const save = el('button', { className: 'btn btn-primary', type: 'button', textContent: '儲存紀錄' });
    save.onclick = async () => {
      const text = memo.value.trim();
      if (!text && !nextInput.value) { toast('請至少填寫內容或下次聯絡日'); return; }
      const today = todayISO();

      /*
       * 日期欄沒填，但內容裡寫了再聯絡的日期，就補進去。
       *
       * 實際使用時很容易把「約10/20再拜訪」打在內容裡就送出，日期欄留空。
       * 那筆客戶因此永遠不會出現在今日待打——寫了等於沒寫。
       * 只在日期欄是空的時候才補，使用者自己填的一律尊重。
       */
      let picked = nextInput.value;
      let auto = null;
      if (!picked) {
        auto = window.Normalize.findFollowUp(text, today);
        if (auto) picked = auto.iso;
      }
      await window.Store.addLog({
        recordId: r.id, date: today, text, outcome: outcomeSel.value, createdAt: Date.now(),
      });
      await saveState(r.id, {
        outcome: outcomeSel.value,
        nextDate: picked || null,
        lastDate: today,
      });
      state.logs = await window.Store.allLogs();
      toast(auto ? `已儲存，並依內容把下次聯絡日設為 ${dateLabel(auto.iso)}` : '已儲存通話紀錄');
      render();
      openDetail(r.id);
      scheduleSync();
    };
    form.append(memo, el('div', { className: 'row' }, [
      el('span', { className: 'muted', textContent: '結果' }), outcomeSel,
      el('span', { className: 'muted', textContent: '下次聯絡' }), withDateHint(nextInput), save,
    ]));
    form.append(quick);
    section.append(form);
    body.append(section);

    // 往來情形：先講二分法的結論，再列往來對象當佐證
    {
      const sec = el('div', { className: 'detail-section' }, [el('h3', { textContent: '往來情形' })]);
      sec.append(el('p', { className: `dealing-verdict dealing-${r.dealingKind}` }, [
        el('strong', { textContent: window.Normalize.DEALING_LABEL[r.dealingKind] }),
        el('span', { className: 'muted', textContent: r.dealingKind === 'active'
          ? `（最新一期${r.dealing.date ? ` ${r.dealing.date} ` : ''}有提到本餘）`
          : '（最新一期沒提到本餘）' }),
      ]));
      if (r.dealing.snippet) {
        sec.append(el('p', { className: 'relation-snippet', textContent: `「…${r.dealing.snippet}…」` }));
      }
      ['internal', 'peer', 'bank'].forEach((kind) => {
        if (!r.relations[kind].length) return;
        const group = el('div', { className: `relation-group relation-${kind}` }, [
          el('strong', { textContent: `${window.Normalize.RELATION_LABEL[kind]}：${r.relations[kind].map((x) => x.name).join('、')}` }),
        ]);
        // 同一句話可能同時提到好幾個對象，原文只需要秀一次
        [...new Set(r.relations[kind].map((item) => item.snippet))].forEach((snippet) => {
          group.append(el('p', { className: 'relation-snippet', textContent: `「${snippet}」` }));
        });
        sec.append(group);
      });
      if (r.relationKinds.length) {
        sec.append(el('p', { className: 'muted',
          textContent: '以上往來對象是從訪談內容的關鍵字判讀出來的，請對照原文確認。' }));
      }
      body.append(sec);
    }

    // 時間軸：本機紀錄 + PDF 原始訪談內容
    const mineLogs = state.logs
      .filter((l) => l.recordId === r.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((l) => ({ date: l.date, text: l.text || `（${OUTCOME_LABEL[l.outcome] || ''}）`, mine: true, logId: l.logId }));
    const entries = mineLogs.concat(r.timeline || []);
    if (entries.length) {
      const sec = el('div', { className: 'detail-section' }, [el('h3', { textContent: `訪談紀錄（${entries.length}）` })]);
      const ul = el('ul', { className: 'timeline' });
      entries.forEach((e) => {
        const li = el('li');
        li.append(el('time', {
          className: e.mine ? 'is-mine' : '',
          textContent: `${e.date ? dateLabel(e.date) : (e.dateRaw || '日期未標示')}${e.mine ? ' · 我的紀錄' : ''}`,
        }));
        li.append(el('p', { textContent: e.text }));
        if (e.mine) {
          /*
           * 自己記的紀錄要能改，不能只有刪除。
           *
           * 打完電話當下打字很容易漏字或記錯，如果只能刪掉重打，日期跟結果都要
           * 重新選一次，而且原本那則的時間戳就沒了。改成就地編輯。
           */
          const edit = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '修改' });
          const del = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '刪除' });
          const actions = el('div', { className: 'card-actions' }, [edit, del]);

          edit.onclick = () => {
            const box = el('textarea', { className: 'paste-box', rows: 3, value: e.text });
            const when = el('input', { type: 'date', value: e.date || todayISO() });
            const ok = el('button', { className: 'btn btn-primary btn-tiny', type: 'button', textContent: '儲存' });
            const cancel = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '取消' });
            const editor = el('div', {}, [box, el('div', { className: 'row' }, [withDateHint(when), ok, cancel])]);
            li.replaceChild(editor, actions);
            box.focus();
            cancel.onclick = () => { li.replaceChild(actions, editor); };
            ok.onclick = async () => {
              await window.Store.updateLog(e.logId, { text: box.value.trim(), date: when.value || e.date });
              state.logs = await window.Store.allLogs();
              touch();
              render();
              openDetail(r.id);
              toast('已更新這則紀錄');
              scheduleSync();
            };
          };

          del.onclick = async () => {
            if (!confirm('確定刪除這則紀錄嗎？')) return;
            await window.Store.deleteLog(e.logId);
            state.logs = await window.Store.allLogs();
            touch();
            render();
            openDetail(r.id);
            toast('已刪除這則紀錄');
            scheduleSync();
          };
          li.append(actions);
        }
        ul.append(li);
      });
      sec.append(ul);
      body.append(sec);
    }

    $('#drawer').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeOverlays() {
    $('#drawer').hidden = true;
    $('#importer').hidden = true;
    $('#syncSetup').hidden = true;
    $('#editor').hidden = true;
    document.body.style.overflow = '';
  }

  /* ---------------- 編輯與新增客戶 ---------------- */

  const EDIT_FIELDS = [
    ['company', '公司名稱', 'text'],
    ['taxId', '統一編號', 'text'],
    ['grade', '分級', 'text'],
    ['founded', '成立年', 'text'],
    ['capital', '資本額（仟元）', 'text'],
    ['phoneRaw', '電話', 'textarea'],
    ['owner', '負責人', 'text'],
    ['keyman', 'KEYMAN', 'text'],
    ['industry', '產業別', 'text'],
    ['address', '地址', 'textarea'],
  ];

  /** 產生編輯表單，回傳 { node, read }。 */
  function editForm(values) {
    const node = el('div', { className: 'edit-form' });
    const inputs = {};
    EDIT_FIELDS.forEach(([key, label, type]) => {
      const control = type === 'textarea'
        ? el('textarea', { rows: 2, value: values[key] || '' })
        : el('input', { type: 'text', value: values[key] || '' });
      inputs[key] = control;
      node.append(el('label', { className: 'rule-field' }, [
        el('span', { textContent: label }), control,
      ]));
    });
    const nextDate = el('input', { type: 'date', value: values.nextDate || '' });
    inputs.nextDate = nextDate;
    node.append(el('label', { className: 'rule-field' }, [
      el('span', { textContent: '下次聯絡日' }), withDateHint(nextDate),
    ]));
    return {
      node,
      read: () => {
        const out = {};
        EDIT_FIELDS.forEach(([key]) => { out[key] = inputs[key].value.trim(); });
        out.nextDate = nextDate.value || null;
        return out;
      },
    };
  }

  /** 編輯既有客戶：存成覆蓋層，重新匯入 PDF 不會被蓋掉，也會跟著雲端同步。 */
  function openEditor(recordId) {
    const raw = state.records.find((r) => r.id === recordId);
    if (!raw) return;
    const r = view(raw);
    const host = $('#editorBody');
    host.textContent = '';
    host.append(el('h2', { textContent: '編輯客戶資料' }));
    host.append(el('p', { className: 'muted',
      textContent: '修改內容會蓋在原始名單之上。重新匯入同一份 PDF 不會覆蓋你改過的欄位，'
        + '也會透過雲端同步帶到其他裝置。' }));

    const form = editForm(r);
    host.append(form.node);

    const save = el('button', { className: 'btn btn-primary', type: 'button', textContent: '儲存' });
    save.onclick = async () => {
      const values = form.read();
      const nextDate = values.nextDate;
      delete values.nextDate;
      // 只記下跟原始資料不同的欄位，之後 PDF 更新了還看得出哪些是自己改的
      const edits = {};
      Object.entries(values).forEach(([key, value]) => {
        if (value !== (raw[key] || '')) edits[key] = value;
      });
      const existing = state.userStates.get(recordId) || {};
      await saveState(recordId, {
        edits: Object.keys(edits).length ? edits : undefined,
        editsAt: Date.now(),      // 編輯有自己的時間戳，同步時才不會被通話紀錄洗掉
        nextDate: nextDate || existing.nextDate || null,
      });
      closeOverlays();
      render();
      openDetail(recordId);
      toast(Object.keys(edits).length ? '已儲存修改' : '已清除先前的修改');
      scheduleSync();
    };
    const revert = el('button', { className: 'btn', type: 'button', textContent: '還原成名單原始內容' });
    revert.onclick = async () => {
      await saveState(recordId, { edits: undefined, editsAt: Date.now() });
      closeOverlays();
      render();
      openDetail(recordId);
      toast('已還原為 PDF 原始內容');
      scheduleSync();
    };
    host.append(el('div', { className: 'card-actions' }, [save, r.edited ? revert : null].filter(Boolean)));
    $('#editor').hidden = false;
  }

  /** 手動新增一筆客戶（例如客戶轉介或名片）。 */
  function openNewCustomer() {
    const host = $('#editorBody');
    host.textContent = '';
    host.append(el('h2', { textContent: '手動新增客戶' }));
    host.append(el('p', { className: 'muted', textContent: '來源會標記為「手動新增」，和匯入的名單分開管理。' }));
    const form = editForm({ nextDate: todayISO() });
    host.append(form.node);

    const save = el('button', { className: 'btn btn-primary', type: 'button', textContent: '新增' });
    save.onclick = async () => {
      const v = form.read();
      if (!v.company && !v.phoneRaw) { toast('請至少填公司名稱或電話'); return; }
      const source = '手動新增';
      const id = window.Normalize.makeId(source, v.company, v.taxId);
      if (state.records.some((r) => r.id === id)) { toast('已經有同名同統編的客戶了'); return; }
      const record = {
        id, source,
        company: v.company, aliases: [], taxId: v.taxId,
        grade: v.grade.toUpperCase(), founded: v.founded, capital: v.capital,
        phoneRaw: v.phoneRaw, phones: window.Normalize.extractPhones(v.phoneRaw),
        owner: v.owner, keyman: v.keyman, industry: v.industry,
        nextDate: v.nextDate, lastDate: null, addedDate: todayISO(), country: '台灣',
        address: v.address, notesRaw: '', timeline: [], outcome: 'new',
        importedAt: Date.now(),
      };
      Object.assign(record, window.Normalize.parseAddress(v.address));
      await window.Store.saveRecords([record]);
      await reload();
      closeOverlays();
      render();
      openDetail(id);
      toast('已新增客戶');
      scheduleSync();
    };
    host.append(el('div', { className: 'card-actions' }, [save]));
    $('#editor').hidden = false;
  }

  /**
   * 從試算表複製整列貼上新增客戶。走的是跟 CSV 匯入同一套解析與內容驗證，
   * 所以訪談內容、多支電話、民國年都會正確處理。先預覽再寫入。
   */
  /*
   * 從商工登記更新公司資料。
   *
   * 介面刻意分成「先試一筆」跟「全部更新」兩段。原因是這條路有一個沒辦法事先
   * 驗證的風險：政府的開放資料 API 若不允許跨網域呼叫，瀏覽器會直接擋掉。與其讓
   * 使用者按下「全部更新」跑到一半才發現全軍覆沒，不如先花十秒確認通不通，
   * 順便把原始回應攤開來看——欄位名稱要是跟預期的不一樣，這時候就看得出來。
   *
   * 更新一律寫成「編輯」，不動原始名單資料：登記資料未必永遠比業務手上的新
   * （例如剛換負責人還沒登記），保留得回原狀的路。
   */
  /*
   * 自架代理用的 Cloudflare Worker 腳本。
   *
   * 放在程式裡而不是只寫在 README，是因為使用者要設定的時候人在瀏覽器前面，
   * 不會跑去翻 GitHub。旁邊直接給複製鈕。
   *
   * 兩個容易忽略但會害人 debug 半天的細節：
   *   1. 連錯誤回應都要帶 CORS 標頭。少了的話，瀏覽器只會報「跨網域被擋」，
   *      把真正的錯誤訊息（例如網址不在白名單）整個吃掉，等於瞎子摸象。
   *   2. 白名單不能拿掉。沒有它，這個 Worker 就是誰都能拿去轉打任意網站的跳板。
   */
  const WORKER_SCRIPT = `const ALLOWED = 'https://data.gcis.nat.gov.tw/';
const ORIGIN = '${location.origin}';

const cors = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const target = new URL(request.url).searchParams.get('url');
    // 白名單不要拿掉：沒有它，這個 Worker 就是任何人都能拿去轉打任意網站的跳板
    if (!target || !target.startsWith(ALLOWED)) {
      return new Response('只接受 data.gcis.nat.gov.tw 的網址', { status: 400, headers: cors });
    }

    try {
      const upstream = await fetch(target, { headers: { Accept: 'application/json' } });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          ...cors,
          'Content-Type': upstream.headers.get('content-type') || 'application/json',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    } catch (err) {
      // 錯誤也要帶 cors，否則瀏覽器只會說「跨網域被擋」，看不到真正的原因
      return new Response('連不上政府網站：' + err.message, { status: 502, headers: cors });
    }
  },
};`;

  const REGISTRY_FIELDS = [
    ['taxId', '統一編號'],
    ['capital', '資本額（仟元）'],
    ['owner', '負責人'],
    ['address', '登記地址'],
  ];

  function openRegistryUpdate() {
    const host = $('#editorBody');
    host.textContent = '';
    host.append(el('h2', { textContent: '從商工登記更新公司資料' }));
    host.append(el('p', { className: 'muted',
      textContent: '查詢的是「商工行政資料開放平臺」的公司登記基本資料，跟 findbiz 查詢畫面同一份來源。'
        + '查詢由你的瀏覽器直接發出，送出去的只有統一編號，客戶名單不會離開這台裝置。' }));

    // 官方 API 實測會被 CORS 擋掉，所以這裡要讓使用者選別的路走。
    // 鏡像預設不開：那是第三方，就算只送出公開的統編，也該由使用者自己決定。
    const mirror = el('input', { type: 'checkbox', id: 'useMirror' });
    host.append(el('label', { className: 'rule-field' }, [
      mirror,
      el('span', { textContent: ' 允許使用 g0v 社群鏡像（官方被擋時的替代來源，只會送出統一編號）' }),
    ]));

    /*
     * 資料集網址可以自己填。
     *
     * 程式裡預設的那串 GUID 實測是錯的（不帶查詢條件要一筆也回空的），但開發環境
     * 連不上政府網站，查不出正確的編號。與其讓使用者等我改一版再部署一次，
     * 不如讓他從開放資料平臺複製網址貼進來——這種只有他那端查得到的資訊，
     * 本來就不該寫死在程式裡。
     */
    const dataset = el('input', {
      id: 'datasetUrl', type: 'url', className: 'paste-box',
      placeholder: window.Registry.DEFAULT_BASE,
      value: window.Registry.getBase() === window.Registry.DEFAULT_BASE ? '' : window.Registry.getBase(),
    });
    host.append(el('label', { className: 'rule-field' }, [
      el('span', { textContent: '資料集 API 網址（目前程式內建的那組是錯的，需要換）' }), dataset,
    ]));
    dataset.onchange = () => { window.Registry.setBase(dataset.value); };
    host.append(el('details', { className: 'proxy-guide' }, [
      el('summary', { textContent: '去哪裡找正確的網址' }),
      el('ol', {}, [
        el('li', { textContent: '打開 data.gcis.nat.gov.tw（商工行政資料開放平臺）。' }),
        el('li', { textContent: '找「公司登記基本資料」這個資料集。' }),
        el('li', { textContent: '點它的「API」或「資料集描述」，裡面會有一段 https://data.gcis.nat.gov.tw/od/data/api/XXXX 的網址。' }),
        el('li', { textContent: '把那段貼進上面的欄位（後面的 ?$format=... 有沒有一起貼都可以，程式會自己去掉）。' }),
        el('li', { textContent: '按「先試一筆」。' }),
      ]),
      el('p', { className: 'muted',
        textContent: '貼進來之後就存在這台裝置的瀏覽器裡，跟代理網址一樣不會同步。' }),
    ]));

    const proxy = el('input', {
      id: 'proxyUrl', type: 'url', className: 'paste-box', placeholder: 'https://你的-worker.workers.dev/（選填）',
      value: window.Registry.getProxy(),
    });
    host.append(el('label', { className: 'rule-field' }, [
      el('span', { textContent: '自架代理網址（不想經過第三方就用這個）' }), proxy,
    ]));
    proxy.onchange = () => { window.Registry.setProxy(proxy.value.trim()); };

    /*
     * 代理的健康檢查跟查詢分開。
     *
     * 查詢失敗時，瀏覽器給的資訊少到無法分辨「代理沒部署」「網址填錯」「腳本貼錯」
     * 「ORIGIN 不對」——全部都是同一個 TypeError。這顆按鈕不帶查詢參數直接打代理，
     * 腳本正常的話會回 400 加白名單訊息，收到就代表前三關都過了。
     */
    const diag = el('div', { className: 'rule-result proxy-diag' });
    const checkBtn = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '檢查代理設定' });
    checkBtn.onclick = async () => {
      window.Registry.setProxy(proxy.value.trim());
      diag.textContent = '';
      diag.append(el('p', { className: 'rule-note', textContent: '檢查中…' }));
      const res = await window.Registry.checkProxy();
      diag.textContent = '';
      diag.append(el('p', { className: `rule-verdict ${res.ok ? 'is-ok' : 'is-fail'}`, textContent: res.message }));
      if (res.body) diag.append(el('p', { className: 'rule-note', textContent: `代理回應：${res.body}` }));
      if (res.openUrl) {
        diag.append(el('p', {}, [
          el('a', { href: res.openUrl, target: '_blank', rel: 'noopener', textContent: res.openUrl }),
        ]));
      }
      if (res.ok) diag.append(el('p', { className: 'rule-note', textContent: '可以按「先試一筆」了。' }));
    };
    host.append(el('div', { className: 'card-actions' }, [checkBtn]), diag);

    const guide = el('details', { className: 'proxy-guide' }, [
      el('summary', { textContent: '怎麼架自己的代理（免費，約五分鐘）' }),
    ]);
    guide.append(el('ol', {}, [
      el('li', { textContent: '到 dash.cloudflare.com 註冊（免費方案就夠用）。' }),
      el('li', { textContent: '左側選 Workers & Pages → Create → Start with Hello World → Deploy。' }),
      el('li', { textContent: '按 Edit code，把編輯器裡原有的內容全部刪掉，貼上下面這段，然後 Deploy。' }),
      el('li', { textContent: '把它給你的網址（長得像 https://xxx.workers.dev）填回上面的欄位。' }),
      el('li', { textContent: '按「先試一筆」確認通了。' }),
    ]));
    const code = el('pre', { className: 'proxy-code', textContent: WORKER_SCRIPT });
    const copyBtn = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '複製腳本' });
    copyBtn.onclick = async () => {
      toast(await copyText(WORKER_SCRIPT) ? '已複製，貼到 Cloudflare 的編輯器裡' : '複製失敗，請手動選取');
    };
    guide.append(el('div', { className: 'card-actions' }, [copyBtn]), code);
    guide.append(el('p', { className: 'muted',
      textContent: '腳本裡的白名單只允許轉打政府的開放資料網址，請不要拿掉——'
        + '沒有它，這個代理就變成任何人都能拿去轉打任意網站的跳板。' }));
    host.append(guide);

    const result = el('div', { className: 'rule-result' });
    const tryOne = el('button', { className: 'btn btn-primary', type: 'button', textContent: '先試一筆' });
    const runAll = el('button', { className: 'btn', type: 'button', textContent: '全部更新' });
    runAll.disabled = true;
    const stop = el('button', { className: 'btn', type: 'button', textContent: '停止' });
    stop.hidden = true;
    host.append(el('div', { className: 'card-actions' }, [tryOne, runAll, stop]));
    host.append(result);

    /*
     * 範圍分兩種，因為用途完全不同：
     *
     *   全部  —— 校正既有資料，四個欄位都比對，會蓋掉不一致的內容。
     *   補地址 —— 只處理地址空白的那幾筆，而且只寫地址。
     *
     * 分開的理由不只是快（872 筆查完要四分半，只補地址可能只要幾十筆）：
     * 「只填空白、絕不覆蓋」是個明確得多的承諾。想補地址的人不會希望順手把
     * 負責人也改掉——登記上的負責人未必比業務手上的新。
     */
    const scope = el('select', {}, [
      el('option', { value: 'blank', textContent: '只補空白欄位（絕不覆蓋任何既有內容）' }),
      el('option', { value: 'all', textContent: '全部校正（會覆蓋跟登記不一致的內容）' }),
    ]);
    host.append(el('label', { className: 'rule-field' }, [
      el('span', { textContent: '範圍' }), scope,
    ]));

    /*
     * 「只補空白」涵蓋四個欄位而不只是地址。
     *
     * 看過原始 PDF 才知道：沒地址的那批，統編在來源就是空的，不是解析掉的。
     * 而統編空著就只能用名稱查，名稱一字不差才找得到——所以順手把查回來的統編
     * 也填上，下一次就能用統編精準查，路會越走越順。
     * 承諾維持不變：只填空白，既有內容一個字都不動。
     */
    const scopeTargets = () => state.records
      .map((rec) => ({ rec, r: view(rec) }))
      .filter(({ r }) => (scope.value === 'blank'
        ? REGISTRY_FIELDS.some(([key]) => !String(r[key] || '').trim())
        : true));

    const summary = el('p', { className: 'muted registry-summary' });
    host.append(summary);
    const refreshSummary = () => {
      const targets = scopeTargets();
      const withTaxId = targets.filter(({ r }) => /^\d{8}$/.test(String(r.taxId || '').replace(/\D/g, ''))).length;
      const secs = Math.ceil(targets.length * 0.3);
      summary.textContent = scope.value === 'blank'
        ? `名單共 ${state.records.length} 筆，其中 ${targets.length} 筆有欄位是空的。`
          + `${withTaxId} 筆有 8 碼統編可直接查，其餘 ${targets.length - withTaxId} 筆只能用公司名稱查。`
          + `約需 ${secs} 秒。`
        : `名單共 ${targets.length} 筆，其中 ${withTaxId} 筆有 8 碼統編可直接查，`
          + `其餘用公司名稱查。約需 ${secs} 秒。`;
    };
    scope.onchange = refreshSummary;
    // 沒有缺地址的客戶時，預設停在「只補地址」會讓人一按就撞到「沒有東西可以查」。
    // 這種時候直接預設成全部校正。
    if (!state.records.map(view).some((r) => REGISTRY_FIELDS.some(([k]) => !String(r[k] || '').trim()))) {
      scope.value = 'all';
    }
    refreshSummary();

    const note = (text, cls) => result.append(el('p', { className: cls || 'rule-note', textContent: text }));

    tryOne.onclick = async () => {
      result.textContent = '';
      // 拿目前範圍裡的第一筆來試，而且優先挑有統編的——沒統編只能用名稱查，
      // 查不到時分不清是「這條路不通」還是「這家剛好比對不到」，那就白試了
      const pool = scopeTargets();
      const withId = pool.filter(({ r }) => /^\d{8}$/.test(String(r.taxId || '').replace(/\D/g, '')));
      const target = (withId[0] || pool[0] || {}).r;
      if (!target) { note('名單是空的，沒有東西可以查。', 'rule-verdict is-fail'); return; }
      note(`正在查：${target.company}（${target.taxId || '無統編，改用名稱'}）…`);
      const opts = { useMirror: mirror.checked };
      const res = target.taxId
        ? await window.Registry.lookupByTaxId(target.taxId, opts)
        : await window.Registry.lookupByName(target.company, opts);
      result.textContent = '';
      /*
       * 原始回應一律附上，成功失敗都是。
       *
       * 欄位名稱是用候選清單猜的（開發環境連不上政府網站，沒辦法確認），猜錯的話
       * 查詢會「成功」但每一格都是空的——那是最難查的一種壞法。把原始回應攤開來，
       * 一眼就看得出是沒查到、還是查到了但欄位名字不一樣。
       */
      const showRaw = (payload) => {
        if (payload === undefined || payload === null) return;
        const box = el('details', { className: 'proxy-guide' }, [
          el('summary', { textContent: '顯示原始回應（欄位對不上時把這段給我）' }),
          el('pre', { className: 'proxy-code',
            textContent: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }),
        ]);
        result.append(box);
      };

      if (!res.ok) {
        note('每個來源都失敗了。', 'rule-verdict is-fail');
        (res.attempts || []).forEach((a) => {
          note(`${a.label}：${a.reason}`);
          // 實際收到什麼比任何推測都有用，沒收到內容也要講「空白」而不是不講
          if (a.body) note(`　　實際收到：${a.body}`);
          if (a.url) note(`　　查詢網址：${a.url}`);
        });
        if (!res.attempts || !res.attempts.length) note(res.reason);
        /*
         * 沒填代理時要直接講。
         *
         * 代理網址存在各台裝置自己的瀏覽器裡、不會同步，所以在電腦上設定好之後
         * 換到手機還是空的。使用者看到的是一長串「每個來源都失敗」，很難聯想到
         * 「這台沒設定」——原本的提示又只在「兩個都沒開」時才出現，勾了鏡像就看不到了。
         */
        if (!window.Registry.getProxy()) {
          note('這台裝置還沒有填自架代理網址。代理設定只存在各台裝置自己的瀏覽器裡，'
            + '不會跟著同步——在電腦上設定過，換到手機還是要再填一次。', 'rule-verdict is-fail');
        }
        if (!mirror.checked && !window.Registry.getProxy()) {
          note('也還沒勾 g0v 鏡像。兩個來源都沒有的話，只剩下必定被擋的官方那條。');
        }

        /*
         * 全部都是「空白回應」或「查無資料」時，多做一步：不帶篩選跟資料集要一筆。
         *
         * 那個症狀分不出「這個統編剛好沒資料」「篩選語法不對」「資料集編號是錯的」
         * 三件事，而這三件事的處理方式完全不同。拿掉篩選就分得出來——資料集存在
         * 的話一定給得出一筆。
         */
        // 只看真的收到回應的那些。官方那條永遠是跨網域被擋、根本沒收到東西，
        // 把它算進來的話「全部都空」這個條件永遠不會成立。
        const responded = (res.attempts || []).filter((a) => a.body || /查無資料/.test(a.reason));
        const allEmpty = responded.length
          && responded.every((a) => /空白回應|查無資料/.test(`${a.reason} ${a.body || ''}`));
        if (allEmpty) {
          note('正在確認資料集本身有沒有反應（不帶查詢條件要一筆）…');
          const probe = await window.Registry.probeDataset();
          if (probe.ok) {
            note(`資料集是好的：不帶條件要得到資料（經由${probe.label}）。`
              + '所以問題出在查詢條件，不是網址。', 'rule-verdict is-fail');
            note(`這支 API 實際的欄位名稱：${probe.keys.join('、')}`);
            showRaw(probe.row);
            note('把上面這段給我，我照真正的欄位名稱改查詢條件與對應表。');
          } else {
            note('資料集本身也要不到任何資料，代表我用的資料集編號是錯的，'
              + '再怎麼調查詢條件都沒用。', 'rule-verdict is-fail');
            (probe.tried || []).forEach((t) => {
              note(`${t.label}：${t.reason}`);
              note(`　　網址：${t.url}`);
            });
            note('把上面這段給我，我換一個資料集編號。');
          }
        }
        return;
      }
      note(`查詢成功，走的是「${res.label}」。`, 'rule-verdict is-ok');
      (res.attempts || []).forEach((a) => note(`（${a.label} 不通：${a.reason.split('\n')[0]}）`));

      // 每一格都空的，代表欄位名稱猜錯了，這時候要講得比「成功」更清楚
      const mapped = REGISTRY_FIELDS.filter(([key]) => res.data[key]).length;
      if (!mapped) {
        note('連上了，但沒有一個欄位對得上——回應的欄位名稱跟預期的不一樣。'
          + '請把下面的原始回應給我，我改對應表。', 'rule-verdict is-fail');
      }
      const dl = el('dl');
      REGISTRY_FIELDS.forEach(([key, label]) => {
        dl.append(el('dt', { textContent: label }),
          el('dd', { textContent: `名單：${target[key] || '（空）'}　→　登記：${res.data[key] || '（查無）'}` }));
      });
      if (res.data.status) dl.append(el('dt', { textContent: '營業狀態' }), el('dd', { textContent: res.data.status }));
      result.append(dl);
      if (res.data.unmappedKeys && res.data.unmappedKeys.length) {
        note(`回應裡還有這些沒對應到的欄位，可能有用：${res.data.unmappedKeys.join('、')}`);
      }
      showRaw(res.raw);
      runAll.disabled = mapped === 0;
    };

    let cancelled = false;
    stop.onclick = () => { cancelled = true; stop.textContent = '停止中…'; };

    runAll.onclick = async () => {
      const blanksOnly = scope.value === 'blank';
      const all = scopeTargets();
      if (!all.length) {
        alert(blanksOnly ? '名單裡沒有欄位空白的客戶。' : '名單是空的。');
        return;
      }
      if (!confirm(`要查 ${all.length} 筆嗎？\n\n`
        + (blanksOnly ? '只會填入目前空白的欄位，既有內容一個字都不會動。\n\n' : '')
        + '會一筆一筆送出（每筆間隔 0.3 秒，避免對政府網站造成負擔），'
        + '中途可以按停止。查完會先列出有差異的項目，確認後才寫入。')) return;
      cancelled = false;
      tryOne.disabled = true; runAll.disabled = true; stop.hidden = false;
      result.textContent = '';
      const progress = el('p', { className: 'rule-verdict is-ok', textContent: '準備中…' });
      result.append(progress);

      const diffs = [];
      const failures = [];
      const fields = REGISTRY_FIELDS;
      for (let i = 0; i < all.length; i++) {
        if (cancelled) break;
        const { rec, r } = all[i];
        progress.textContent = `查詢中 ${i + 1} / ${all.length}：${r.company}`;
        const opts = { useMirror: mirror.checked };
        const res = /^\d{8}$/.test(String(r.taxId || '').replace(/\D/g, ''))
          ? await window.Registry.lookupByTaxId(r.taxId, opts)
          : await window.Registry.lookupByName(r.company, opts);
        if (!res.ok) { failures.push({ company: r.company, reason: res.reason }); }
        else {
          const changes = {};
          fields.forEach(([key]) => {
            const now = String(r[key] || '').trim();
            const next = String(res.data[key] || '').trim();
            // 只補空白模式：本來就有值的一律不碰
            if (blanksOnly && now) return;
            if (next && next !== now) changes[key] = { from: now, to: next };
          });
          if (Object.keys(changes).length) diffs.push({ rec, r, changes, status: res.data.status });
        }
        await new Promise((done) => setTimeout(done, 300));
      }

      stop.hidden = true; stop.textContent = '停止'; tryOne.disabled = false;
      result.textContent = '';
      // 全部都失敗，幾乎可以確定是被擋掉，而不是資料真的都查不到
      if (!diffs.length && failures.length === all.length && all.length) {
        note('全部查詢都失敗，代表來源被擋住了，不是資料的問題。', 'rule-verdict is-fail');
        note(failures[0].reason);
        return;
      }
      note(`查完 ${all.length} 筆：${diffs.length} 筆${blanksOnly ? '查到可補的資料' : '有差異'}，`
        + `${failures.length} 筆查不到或失敗。`,
        'rule-verdict is-ok');
      if (!diffs.length) {
        note(blanksOnly ? '這些客戶在商工登記上查不到可以補的資料。' : '登記資料跟名單一致，沒有要更新的。');
        return;
      }

      diffs.slice(0, 20).forEach((d) => {
        const dl = el('dl');
        Object.entries(d.changes).forEach(([key, ch]) => {
          const label = (REGISTRY_FIELDS.find(([k]) => k === key) || [, key])[1];
          dl.append(el('dt', { textContent: label }),
            el('dd', { textContent: `${ch.from || '（空）'}　→　${ch.to}` }));
        });
        result.append(el('div', { className: 'import-preview' },
          [el('strong', { textContent: d.company || d.r.company }), dl]));
      });
      if (diffs.length > 20) note(`※ 另外還有 ${diffs.length - 20} 筆有差異，這裡只列前 20 筆。`);

      const apply = el('button', { className: 'btn btn-primary', type: 'button',
        textContent: blanksOnly ? `填入這 ${diffs.length} 筆` : `套用這 ${diffs.length} 筆更新` });
      apply.onclick = async () => {
        apply.disabled = true;
        for (const d of diffs) {
          const existing = state.userStates.get(d.rec.id) || {};
          const edits = { ...(existing.edits || {}) };
          Object.entries(d.changes).forEach(([key, ch]) => { edits[key] = ch.to; });
          await saveState(d.rec.id, { edits, editsAt: Date.now() });
        }
        await reload();
        closeOverlays();
        render();
        toast(`已依登記資料更新 ${diffs.length} 筆`);
        scheduleSync();
      };
      result.append(el('div', { className: 'card-actions' }, [apply]));
      note('套用後會記成「已修改」，每一筆都可以在詳細頁按「還原成名單原始內容」退回。');
    };

    $('#editor').hidden = false;
  }

  function openPasteImport() {
    const host = $('#editorBody');
    host.textContent = '';
    host.append(el('h2', { textContent: '貼上新增客戶' }));
    host.append(el('p', { className: 'muted',
      textContent: '從 Excel 或 Google 試算表選取整列複製，貼在下面即可，一次多列也可以。'
        + '沒有標題列的話會依名單的標準欄位順序判讀，並自動檢查內容有沒有放錯欄位。' }));

    const box = el('textarea', {
      className: 'paste-box', rows: 6,
      placeholder: '公司名稱\t統編\t分級\t成立\t資本額\t電話\t負責人\t…（直接貼上即可）',
    });
    host.append(box);

    const preview = el('div', { className: 'rule-result' });
    const save = el('button', { className: 'btn btn-primary', type: 'button', textContent: '新增到名單' });
    save.disabled = true;
    host.append(el('div', { className: 'card-actions' }, [save]));
    host.append(preview);

    let parsed = null;
    const SOURCE = '手動新增';

    function run() {
      const text = box.value;
      preview.textContent = '';
      parsed = null;
      save.disabled = true;
      if (!text.trim()) return;

      try {
        parsed = window.Normalize.parsePasted(text, SOURCE);
      } catch (err) {
        preview.append(el('p', { className: 'rule-verdict is-fail', textContent: `解析失敗：${err.message}` }));
        return;
      }
      if (!parsed.records.length) {
        preview.append(el('p', { className: 'rule-verdict is-fail',
          textContent: '讀不出任何客戶。請確認有複製到整列，且至少包含公司名稱或電話。' }));
        return;
      }

      const existing = new Set(state.records.map((r) => r.id));
      const updating = parsed.records.filter((r) => existing.has(r.id)).length;
      preview.append(el('p', { className: 'rule-verdict is-ok',
        textContent: `讀到 ${parsed.records.length} 筆`
          + `${updating ? `（其中 ${updating} 筆已存在，將更新）` : ''}`
          + `，分隔符號：${parsed.delimiter === '\t' ? 'Tab（試算表）' : '逗號'}`
          + `${parsed.synthesized ? '，未偵測到標題列，已依標準欄位順序判讀' : ''}` }));
      if (parsed.shift) {
        preview.append(el('p', { className: 'rule-note', textContent: `※ 偵測到欄位整體平移 ${parsed.shift > 0 ? '+' : ''}${parsed.shift} 格，已自動校正。` }));
      }
      if (parsed.repaired) {
        preview.append(el('p', { className: 'rule-note', textContent: `※ 有 ${parsed.repaired} 筆的部分欄位內容對不上欄位名稱，已依內容重新歸位。` }));
      }

      parsed.records.slice(0, 5).forEach((r) => {
        const dl = el('dl');
        [['公司名稱', r.company], ['統編', r.taxId], ['分級', r.grade],
          ['資本額', r.capital], ['電話', r.phoneRaw.replace(/\n/g, ' / ')],
          ['負責人', r.owner], ['產業別', r.industry],
          ['下次聯絡', r.nextDate || ''], ['地址', r.address],
          ['訪談紀錄', r.timeline.length ? `${r.timeline.length} 則` : ''],
        ].forEach(([k, v]) => {
          if (!v) return;
          dl.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
        });
        preview.append(el('div', { className: 'import-preview' }, [dl]));
      });
      if (parsed.records.length > 5) {
        preview.append(el('p', { className: 'muted', textContent: `…另外還有 ${parsed.records.length - 5} 筆` }));
      }
      save.disabled = false;
    }

    save.onclick = async () => {
      if (!parsed || !parsed.records.length) return;
      const importedAt = Date.now();
      parsed.records.forEach((r) => { r.importedAt = importedAt; });
      const existing = new Set(state.records.map((r) => r.id));
      const added = parsed.records.filter((r) => !existing.has(r.id)).length;
      await window.Store.saveRecords(parsed.records);   // 累加，不刪既有的「手動新增」
      await reload();
      closeOverlays();
      render();
      if (parsed.records.length === 1) openDetail(parsed.records[0].id);
      toast(`已新增 ${added} 筆${parsed.records.length - added ? `、更新 ${parsed.records.length - added} 筆` : ''}`);
      scheduleSync();
    };

    box.oninput = run;
    box.onpaste = () => setTimeout(run, 0);
    $('#editor').hidden = false;
    setTimeout(() => box.focus(), 50);
  }

  /* ---------------- 匯入 ---------------- */

  function logLine(text, cls) {
    $('#importLog').prepend(el('div', { className: cls || '', textContent: text }));
  }

  /** 匯入後秀前幾筆的欄位對照，讓使用者當場看得出有沒有跑錯格。 */
  function showPreview(filename, records) {
    const box = el('div', { className: 'import-preview' });
    box.append(el('h3', { textContent: `${filename.replace(/\.(pdf|csv)$/i, '')}　欄位檢查（前 ${Math.min(3, records.length)} 筆）` }));
    records.slice(0, 3).forEach((r) => {
      const dl = el('dl');
      const rows = [
        ['公司名稱', r.company + (r.aliases.length ? `（另有 ${r.aliases.join('、')}）` : '')],
        ['統編', r.taxId], ['分級', r.grade], ['成立年', r.founded],
        ['資本額', r.capital], ['電話', r.phoneRaw.replace(/\n/g, ' / ')],
        ['負責人', r.owner], ['KEYMAN', r.keyman], ['產業別', r.industry],
        ['下次聯絡', r.nextDate || ''], ['最近聯絡', r.lastDate || ''],
        ['地址', r.address],
        ['訪談內容', (r.notesRaw || '').replace(/\n/g, ' ').slice(0, 60) + ((r.notesRaw || '').length > 60 ? '…' : '')],
      ];
      rows.forEach(([k, v]) => {
        dl.append(el('dt', { textContent: k }), el('dd', {
          textContent: v || '（空白）',
          className: v ? '' : 'is-blank',
        }));
      });
      box.append(dl);
    });
    box.append(el('p', { className: 'muted', textContent: '對照一下內容有沒有放錯欄位。有錯的話把這段截圖給我，我再調整。' }));
    $('#importLog').prepend(box);
  }

  /*
   * 匯入時遇到已經在名單裡的公司要怎麼辦。
   *
   * 客戶的 id 是「檔名＋公司名＋統編」算出來的，所以同一家公司出現在不同檔案裡，
   * 會變成兩張各自獨立的卡片。名單越匯越多，同一家公司就散在好幾處，
   * 打過的紀錄在這張、新的資料在那張。
   *
   * 比對優先用統一編號：那是唯一且不會有寫法差異的。沒有統編才退回公司名稱，
   * 並且把「台／臺」正規化——登記一律用「臺」，但名單上兩種都有。
   */
  const dedupeKey = (r) => {
    const taxId = String(r.taxId || '').replace(/\D/g, '');
    if (taxId.length === 8) return `tax:${taxId}`;
    const name = String(r.company || '').replace(/\s+/g, '').replace(/台/g, '臺');
    return name ? `name:${name}` : '';
  };

  /**
   * 找出這批要匯入的資料裡，有哪些公司已經在名單上。
   * 同一份來源檔的舊資料不算——那些本來就會被整份換掉。
   */
  function findImportDuplicates(incoming, sourceName) {
    const index = new Map();
    state.records.forEach((rec) => {
      if (rec.source === sourceName) return;
      const key = dedupeKey(rec);
      if (key && !index.has(key)) index.set(key, rec);
    });
    const hits = [];
    incoming.forEach((r) => {
      const key = dedupeKey(r);
      const old = key ? index.get(key) : null;
      if (old) hits.push({ incoming: r, old, byTaxId: key.startsWith('tax:') });
    });
    return hits;
  }

  /**
   * 問使用者要怎麼處理重複的，回傳 'overwrite' | 'keep' | 'skip' | null（取消）。
   *
   * 沒有預設幫他決定，因為三種做法的後果差很多，而且覆蓋會動到他手動改過的內容。
   */
  function askDuplicatePolicy(filename, hits) {
    return new Promise((resolve) => {
      const edited = hits.filter(({ old }) => {
        const st = state.userStates.get(old.id);
        return st && st.edits && Object.keys(st.edits).length;
      }).length;
      const logged = hits.filter(({ old }) =>
        state.logs.some((l) => l.recordId === old.id)).length;

      const host = $('#editorBody');
      host.textContent = '';
      host.append(el('h2', { textContent: '有重複的公司' }));
      host.append(el('p', { className: 'muted',
        textContent: `${filename} 裡有 ${hits.length} 家公司已經在名單上。要怎麼處理？` }));

      const facts = el('div', { className: 'rule-result' });
      facts.append(el('p', { className: 'rule-note',
        textContent: `比對方式：${hits.filter((h) => h.byTaxId).length} 筆靠統一編號、`
          + `${hits.filter((h) => !h.byTaxId).length} 筆靠公司名稱。` }));
      if (logged) {
        facts.append(el('p', { className: 'rule-note',
          textContent: `其中 ${logged} 筆有通話紀錄——不管選哪一種，通話紀錄都會保留。` }));
      }
      if (edited) {
        facts.append(el('p', { className: 'rule-verdict is-fail',
          textContent: `其中 ${edited} 筆你曾經手動修改過欄位。選「覆蓋」的話，`
            + '那些修改會被新檔案的內容取代。' }));
      }
      hits.slice(0, 5).forEach(({ incoming, old }) => {
        facts.append(el('div', { className: 'import-preview' }, [
          el('strong', { textContent: incoming.company }),
          el('p', { className: 'rule-note',
            textContent: `名單上的來源：${old.source}　→　新檔案：${filename}` }),
        ]));
      });
      if (hits.length > 5) {
        facts.append(el('p', { className: 'rule-note', textContent: `※ 以上只列前 5 筆。` }));
      }
      host.append(facts);

      const pick = (value, label, hint, primary) => {
        const btn = el('button', { className: `btn${primary ? ' btn-primary' : ''}`, type: 'button', textContent: label });
        btn.onclick = () => { $('#editor').hidden = true; resolve(value); };
        host.append(el('div', {}, [
          el('div', { className: 'card-actions' }, [btn]),
          el('p', { className: 'rule-note', textContent: hint }),
        ]));
      };
      pick('overwrite', '以新檔案覆蓋', '同一家公司只留一張卡片，內容以新檔案為準。通話紀錄保留。', true);
      pick('keep', '兩邊都留著', '新檔案的資料另外新增一筆。同一家公司會有兩張卡片。');
      pick('skip', '略過重複的', '名單上已經有的就不動，只匯入新的公司。');

      const cancel = el('button', { className: 'btn', type: 'button', textContent: '取消匯入' });
      cancel.onclick = () => { $('#editor').hidden = true; resolve(null); };
      host.append(el('div', { className: 'card-actions' }, [cancel]));

      $('#editor').hidden = false;
    });
  }

  /*
   * 讀 Excel，回傳跟 CSV 一樣的「列陣列」，後面共用同一條解析流程。
   *
   * 只讀第一個工作表——公司匯出的名單只有一張。日期格用 cellDates 讓 SheetJS
   * 直接給 Date 物件再自己轉成 YYYY/MM/DD：不這樣做的話拿到的是 Excel 內部的
   * 序號（45914 之類）或跟著電腦語系走的字串，兩種都會讓日期解析失敗。
   */
  async function readXlsx(file) {
    if (!window.XLSX) throw new Error('Excel 解析元件沒有載入');
    const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
    const pad = (n) => String(n).padStart(2, '0');
    return raw.map((row) => row.map((v) => {
      if (v instanceof Date) return `${v.getFullYear()}/${pad(v.getMonth() + 1)}/${pad(v.getDate())}`;
      return v == null ? '' : String(v);
    }));
  }

  async function importFiles(files) {
    const wanted = [...files].filter((f) => /\.(pdf|csv|xlsx|xls)$/i.test(f.name)
      || f.type === 'application/pdf' || f.type === 'text/csv');
    if (!wanted.length) { logLine('沒有偵測到 PDF、CSV 或 Excel 檔案', 'err'); return; }

    for (const file of wanted) {
      const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
      const isXlsx = /\.xlsx?$/i.test(file.name);
      logLine(`⏳ 解析 ${file.name} …`);
      try {
        let rows;
        let pages = 1;
        let pageStarts = [0];
        let mode = 'csv';
        if (isXlsx) {
          rows = await readXlsx(file);
        } else if (isCsv) {
          rows = window.Normalize.parseCsv(await file.text());
          /*
           * 經濟部的登記清冊一次四千多筆，但真正要打的只有一小撮。
           * 整份匯進來只會把名單淹掉，所以先問條件再匯。
           */
        }
        if ((isCsv || isXlsx) && window.Normalize.isGovRegistry(rows)) {
          const picked = await askGovFilter(file.name, rows);
          if (!picked) { logLine(`已取消 ${file.name}`); continue; }
          rows = picked;
        }
        if (!isCsv && !isXlsx) {
          const buffer = await file.arrayBuffer();
          const parsed = await window.PdfTable.parsePdf(buffer, (done, total) => {
            $('#importLog').firstChild.textContent = `⏳ 解析 ${file.name} … 第 ${done}/${total} 頁`;
          });
          ({ rows, pages, pageStarts, mode } = parsed);
        }
        /*
         * 資本額單位。公司匯出的 xlsx 是「元」，名單慣例是「仟元」，差一千倍。
         * 只在看起來像元的時候問，看起來已經是仟元就不打擾。
         */
        {
          const found = window.Normalize.detectHeader(rows);
          if (found && window.Normalize.capitalLooksLikeYuan(rows, found.map)) {
            const sample = String((rows[found.index + 1] || [])[found.map.capital] || '');
            const yes = confirm(`${file.name} 的資本額看起來是「元」（例如 ${sample}），`
              + '但名單用的是「仟元」。\n\n要換算成仟元再匯入嗎？\n（選取消 = 照原值匯入）');
            if (yes) {
              const n = window.Normalize.convertCapitalToThousands(rows, found.map);
              logLine(`資本額已由元換算成仟元（${n} 筆）`);
            }
          }
        }
        const { records, header, skipped, shift, repaired } =
          window.Normalize.toRecords(rows, file.name, { pageStarts });
        if (!header) {
          logLine(`⚠️ ${file.name}：找不到「公司名稱／電話」等欄位標題，請確認這是名單表格。`, 'err');
          continue;
        }
        if (!records.length) {
          logLine(`⚠️ ${file.name}：讀到表頭但沒有資料列。`, 'err');
          continue;
        }
        const importedAt = Date.now();
        records.forEach((r) => { r.importedAt = importedAt; });

        /*
         * 重複處理要在刪掉同名來源之前比對：比對的對象是「現在名單上的其他來源」，
         * 順序反過來的話會把剛刪掉的也算進去。
         */
        let toSave = records;
        let dupNote = '';
        const hits = findImportDuplicates(records, file.name);
        if (hits.length) {
          const policy = await askDuplicatePolicy(file.name, hits);
          if (!policy) { logLine(`已取消 ${file.name}`); continue; }
          const byIncoming = new Map(hits.map((h) => [h.incoming, h]));
          if (policy === 'skip') {
            toSave = records.filter((r) => !byIncoming.has(r));
            dupNote = `，略過 ${hits.length} 筆重複`;
          } else if (policy === 'overwrite') {
            // 沿用舊的 id，通話紀錄才會繼續掛在同一筆上
            hits.forEach(({ incoming, old }) => { incoming.id = old.id; });
            const ids = hits.map(({ old }) => old.id);
            await window.Store.deleteRecordsById(ids);
            // 手動修改過的內容會蓋掉新檔案的值，既然選了覆蓋就要清掉
            for (const id of ids) {
              const st = state.userStates.get(id);
              if (st && st.edits) await saveState(id, { edits: undefined, editsAt: Date.now() });
            }
            dupNote = `，覆蓋 ${hits.length} 筆重複`;
          } else {
            dupNote = `，另外新增 ${hits.length} 筆重複的公司`;
          }
        }

        await window.Store.deleteSource(file.name, { keepTombstone: false });   // 同名重匯 = 更新
        await window.Store.saveRecords(toSave);
        logLine(
          `✅ ${file.name}：${isXlsx ? 'Excel' : isCsv ? 'CSV' : `${pages} 頁`} → ${records.length} 筆客戶`
          + `${dupNote}`
          + `${skipped ? `（略過 ${skipped} 個空列）` : ''}`
          + `${mode === 'heuristic' ? '（此檔沒有表格框線，欄位為推測結果）' : ''}`,
          'ok'
        );
        if (shift) logLine(`🔧 偵測到整份表格欄位平移 ${shift > 0 ? '+' : ''}${shift} 格，已自動校正。`);
        if (repaired) logLine(`🔧 有 ${repaired} 筆的部分欄位內容對不上欄位標題，已依內容重新歸位。`);
        showPreview(file.name, records);
      } catch (err) {
        console.error(err);
        logLine(`❌ ${file.name}：${err && err.message ? err.message : '解析失敗'}`, 'err');
      }
    }
    await reload();
    render();
    scheduleSync();
  }

  /* ---------------- 匯出 ---------------- */

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportCsv() {
    const head = ['公司名稱', '關係企業', '統編', '分級', '成立年', '資本額(仟元)', '電話', '負責人',
      'KEYMAN', '產業別', '縣市', '地址', '下次聯絡日', '最近聯絡日', '洽談狀態', '名單來源',
      '我的通話紀錄', 'PDF訪談內容'];
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [head.map(esc).join(',')];
    allViews().forEach((r) => {
      const mine = state.logs.filter((l) => l.recordId === r.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((l) => `${dateLabel(l.date)} [${OUTCOME_LABEL[l.outcome] || ''}] ${l.text}`)
        .join('\n');
      lines.push([r.company, r.aliases.join('、'), r.taxId, r.grade, r.founded, r.capital,
        r.phoneRaw, r.owner, r.keyman, r.industry, r.city, r.address,
        r.nextDate ? dateLabel(r.nextDate) : '', r.lastDate ? dateLabel(r.lastDate) : '',
        OUTCOME_LABEL[r.outcome] || r.outcome, r.source, mine, r.notesRaw].map(esc).join(','));
    });
    download(`電話推廣名單_${todayISO()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }

  /* ---------------- 雲端同步 ---------------- */

  let syncTimer = null;

  function setSyncButton(stateName, title) {
    const btn = $('#btnSync');
    btn.hidden = !window.DriveSync.isConfigured();
    btn.classList.toggle('is-busy', stateName === 'busy');
    btn.classList.toggle('is-error', stateName === 'error');
    btn.textContent = stateName === 'busy' ? '⋯' : '⟳';
    btn.title = title || '與雲端硬碟同步';
  }

  async function showSyncTime() {
    const at = await window.Store.getMeta('lastSyncAt');
    if (at) setSyncButton('idle', `上次同步 ${new Date(at).toLocaleString('zh-TW')}`);
    else setSyncButton('idle', '尚未同步過');
    return at;
  }

  /**
   * @param {{interactive?:boolean, quiet?:boolean}} [opts]
   *   interactive：允許跳出 Google 授權視窗（使用者主動按的時候才可以）
   *   quiet：失敗時不要吵使用者
   */
  async function runSync(opts) {
    const { interactive = false, quiet = false } = opts || {};
    if (!window.DriveSync.isConfigured()) {
      if (!quiet) toast('請先到「雲端同步設定」填入 Google 用戶端 ID');
      return null;
    }
    setSyncButton('busy');
    try {
      const result = await window.DriveSync.sync({ interactive });
      await reload();
      render();
      await showSyncTime();
      if (!quiet) {
        const g = result.gained;
        const gained = [
          g.records > 0 ? `名單 +${g.records}` : '',
          g.logs > 0 ? `通話紀錄 +${g.logs}` : '',
        ].filter(Boolean).join('、');
        toast(result.firstTime ? '已建立雲端同步檔' : (gained ? `同步完成（${gained}）` : '同步完成，沒有新資料'));
      }
      const status = $('#syncStatus');
      if (status) status.textContent = `上次同步：${new Date().toLocaleString('zh-TW')}`;
      return result;
    } catch (err) {
      console.error(err);
      setSyncButton('error', String(err.message || err));
      if (!quiet) toast(`同步失敗：${err.message || err}`);
      const status = $('#syncStatus');
      if (status && !quiet) status.textContent = `同步失敗：${err.message || err}`;
      return null;
    }
  }

  /** 記完通話後過幾秒自動推上去，不要每按一次就打一次 API。 */
  function scheduleSync() {
    if (!window.DriveSync.isConfigured()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => runSync({ quiet: true }), 4000);
  }

  /* ---------------- 版本檢查 ---------------- */

  /*
   * 靜態主機連 index.html 本身都會被快取，所以就算資源網址帶了版本號，
   * 使用者還是可能停在舊版、看不到新功能。這裡另外抓一個永不快取的
   * version.json 來比對；不一致就提示更新，並用帶參數的網址重新載入，
   * 強迫瀏覽器重新抓 index.html。
   */
  /*
   * 檢查有沒有新版本。
   *
   * @param {boolean} loud 使用者自己按「檢查更新」時為 true，已是最新版也要回報。
   *   自動檢查時保持安靜——每次開啟都跳「已是最新版」很吵。
   *
   * 會做這件事是因為使用者多次遇到「我明明更新了，但畫面沒變」。實際上是
   * 瀏覽器拿快取的舊檔，而從畫面上完全看不出自己跑的是哪一版，只能瞎猜。
   */
  async function checkForUpdate(loud) {
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) { if (loud) toast('連不到伺服器，無法檢查更新'); return; }
      const data = await res.json();
      if (!data || !data.version || data.version === APP_VERSION) {
        if (loud) toast(`已經是最新版（${APP_VERSION}）`);
        return;
      }

      const bar = $('#updateBar');
      bar.hidden = false;
      if (loud) toast(`有新版本 ${data.version}，目前是 ${APP_VERSION}`);
      $('#btnUpdate').onclick = () => {
        // 換一個沒看過的網址，瀏覽器才會重新抓 index.html 而不是用快取
        location.replace(`${location.pathname}?v=${encodeURIComponent(data.version)}`);
      };
      $('#btnUpdateLater').onclick = () => { bar.hidden = true; };
    } catch (err) {
      // 以 file:// 開啟或離線時抓不到，忽略即可
    }
  }

  /* ---------------- 啟動 ---------------- */

  async function reload() {
    touch();
    const [records, logs, states] = await Promise.all([
      window.Store.allRecords(), window.Store.allLogs(), window.Store.allStates(),
    ]);
    state.records = records;
    state.logs = logs;
    state.userStates = new Map(states.map((s) => [s.recordId, s]));
  }

  function wireEvents() {
    let searchTimer = null;
    $('#search').oninput = (e) => {
      const value = e.target.value;
      clearTimeout(searchTimer);
      // 每打一個字就重算幾百筆會頓，等使用者停一下再算
      searchTimer = setTimeout(() => {
        state.search = value;
        state.limit = PAGE_SIZE;
        render();
      }, 120);
    };
    $('#sortBy').onchange = (e) => { state.sort = e.target.value; render(); };
    $('#hideBlocked').onchange = (e) => { state.hideBlocked = e.target.checked; render(); };
    $('#btnMore').onclick = () => { state.limit += PAGE_SIZE; renderList(); };
    $('#fltIndustry').oninput = (e) => { state.filters.industry = e.target.value.trim(); state.limit = PAGE_SIZE; render(); };
    // 聯絡時程的兩個日期框：手動改了就不再對應任何快速鍵
    const dueFrom = el('input', { type: 'date', id: 'dueFrom' });
    const dueTo = el('input', { type: 'date', id: 'dueTo' });
    $('#fltDueRange').append(
      el('label', {}, [el('span', { className: 'muted', textContent: '從' }), dueFrom]),
      el('label', {}, [el('span', { className: 'muted', textContent: '到' }), dueTo])
    );
    const onDueInput = () => {
      state.filters.due = 'custom';
      state.filters.dueNone = false;
      state.filters.dueFrom = dueFrom.value || '';
      state.filters.dueTo = dueTo.value || '';
      state.limit = PAGE_SIZE;
      render();
    };
    dueFrom.oninput = onDueInput;
    dueTo.oninput = onDueInput;
    $('#btnResetFilters').onclick = () => {
      // 就地清空，不要換掉整個 state.filters 物件：chip 的 onclick 抓的是 Set 的參照，
      // 一旦換成新物件，按鈕改到的就是被丟掉的舊 Set，按下去完全沒反應。
      Object.values(state.filters).forEach((v) => { if (v instanceof Set) v.clear(); });
      applyDueQuick('');
      state.filters.industry = '';
      $('#fltIndustry').value = '';
      state.limit = PAGE_SIZE;
      render();
    };

    $('#btnFilters').onclick = () => {
      const open = $('#filters').classList.toggle('is-open');
      $('#btnFilters').setAttribute('aria-expanded', String(open));
      $('#btnFilters').textContent = open ? '篩選 ▴' : '篩選 ▾';
    };

    $('#tabs').onclick = (e) => {
      const btn = e.target.closest('.tab');
      if (!btn || btn.id === 'btnFilters') return;
      state.tab = btn.dataset.tab;
      state.limit = PAGE_SIZE;
      [...$('#tabs').children].forEach((b) => b.classList.toggle('is-active', b === btn));
      render();
    };

    $('#btnImport').onclick = () => { $('#importer').hidden = false; };
    $('#btnSync').onclick = () => runSync({ interactive: true });
    $('#btnSaveClientId').onclick = async () => {
      const id = $('#clientId').value.trim();
      if (!id) { toast('請貼上 Google 用戶端 ID'); return; }
      if (!/\.apps\.googleusercontent\.com$/.test(id)) {
        toast('用戶端 ID 看起來不對，應該以 .apps.googleusercontent.com 結尾');
        return;
      }
      window.DriveSync.setClientId(id);
      setSyncButton('idle');
      await runSync({ interactive: true });
    };
    $('#btnSyncSignOut').onclick = () => {
      window.DriveSync.signOut();
      toast('已登出，下次同步會重新要求授權');
    };
    $('#btnPick').onclick = () => $('#filePick').click();
    $('#filePick').onchange = (e) => {
      const files = [...e.target.files];
      // 清空選擇，否則再選同一個檔案更新名單時不會觸發 change
      e.target.value = '';
      importFiles(files);
    };

    const dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.remove('is-over');
    }));
    dz.addEventListener('drop', (e) => importFiles(e.dataTransfer.files));

    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) closeOverlays();
      if (!e.target.closest('#menu') && !e.target.closest('#btnMenu')) $('#menu').hidden = true;
    });
    $('#btnMenu').onclick = () => { $('#menu').hidden = !$('#menu').hidden; };
    $('#menu').onclick = async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      $('#menu').hidden = true;
      if (act === 'export-csv') exportCsv();
      if (act === 'export-json') {
        download(`電話推廣名單備份_${todayISO()}.json`,
          JSON.stringify(await window.Store.exportAll()), 'application/json');
      }
      if (act === 'import-json') $('#jsonPick').click();
      if (act === 'theme') {
        const now = document.body.dataset.theme;
        const next = now === 'dark' ? 'light' : 'dark';
        document.body.dataset.theme = next;
        document.documentElement.dataset.theme = next;
        localStorage.setItem('theme', next);
      }
      if (act === 'sync-now') runSync({ interactive: true });
      if (act === 'sync-setup') {
        $('#clientId').value = window.DriveSync.clientId();
        $('#syncSetup').hidden = false;
        showSyncTime().then((at) => {
          $('#syncStatus').textContent = at
            ? `上次同步：${new Date(at).toLocaleString('zh-TW')}`
            : '尚未同步過';
        });
      }
      if (act === 'new-customer') openNewCustomer();
      if (act === 'paste-customer') openPasteImport();
      if (act === 'fix-address') { await repairStrayAddresses(); return; }
      if (act === 'registry') { openRegistryUpdate(); return; }
      if (act === 'followup') { await repairFollowUps(); return; }
      if (act === 'check-update') { await checkForUpdate(true); return; }
      if (act === 'check-names') { await reviewCompanyNames(); return; }
      if (act === 'manage') {
        const sources = [...new Set(state.records.map((r) => r.source))];
        if (!sources.length) { toast('目前沒有已匯入的名單'); return; }
        const name = prompt(`目前已匯入：\n${sources.join('\n')}\n\n輸入要刪除的檔名（留空取消）：`);
        if (name && sources.includes(name.trim())) {
          const n = await window.Store.deleteSource(name.trim());
          await reload(); render();
          toast(`已刪除 ${name.trim()}（${n} 筆）`);
        }
      }
      if (act === 'wipe') {
        const synced = window.DriveSync.isConfigured();
        const total = state.records.length;
        const logs = state.logs.length;
        if (!total && !logs) { toast('名單已經是空的'); return; }
        const ok1 = confirm(`確定要清空所有名單嗎？\n\n共 ${total} 筆客戶、${logs} 則通話紀錄。`
          + (synced ? '\n\n你有開雲端同步：清除會傳到所有裝置，雲端那份也會一起清掉。' : '')
          + '\n\n此動作無法復原。按確定後會先自動下載一份備份。');
        if (!ok1) return;
        // 不可逆又會傳到所有裝置的動作，先留一份備份再動手
        download(`電話推廣名單備份_清空前_${todayISO()}.json`,
          JSON.stringify(await window.Store.exportAll()), 'application/json');
        const ok2 = confirm('備份已開始下載。\n\n再確認一次：真的要清空全部名單嗎？');
        if (!ok2) return;
        const gone = await window.Store.wipe();
        await reload(); render();
        toast(`已清除 ${gone.records} 筆客戶、${gone.logs} 則通話紀錄`);
        // 立刻同步，讓墓碑上雲端；不然要等下一次自動同步，中間別台裝置會先把舊資料推上去
        if (synced) runSync({ quiet: true });
      }
    };
    $('#jsonPick').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const incoming = JSON.parse(await file.text());
        if (!incoming || !Array.isArray(incoming.records)) throw new Error('備份檔格式不正確');
        const merged = window.DriveSync.mergeDumps(await window.Store.exportAll(), incoming);
        await window.Store.replaceAll(merged);
        await reload(); render();
        toast(`已合併備份：共 ${merged.records.length} 筆客戶、${merged.logs.length} 則通話紀錄`);
      } catch (err) {
        toast(`還原失敗：${err.message}`);
      }
      e.target.value = '';
    };

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeOverlays();
      if (e.key === '/' && document.activeElement !== $('#search')) {
        e.preventDefault();
        $('#search').focus();
      }
    });
  }

  async function init() {
    const saved = localStorage.getItem('theme');
    if (saved) {
      document.body.dataset.theme = saved;
      document.documentElement.dataset.theme = saved;
    }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = `assets/vendor/pdfjs/pdf.worker.min.js?v=${APP_VERSION}`;
    $('#menuVersion').textContent = `版本 ${APP_VERSION}`;
    wireEvents();
    await reload();
    render();
    if (window.DriveSync.isConfigured()) {
      await showSyncTime();
      runSync({ quiet: true });          // 背景靜默同步，失敗就等使用者自己按
    }
    prebuildRules();
    checkForUpdate(false);
    /*
     * 切回這個分頁時再檢查一次。
     *
     * 原本只在載入時檢查，但手機上把網站加到主畫面之後常常是同一個分頁一直開著，
     * 那就永遠不會再檢查——更新了也不知道。
     */
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) checkForUpdate(false);
    });
    if (!state.records.length) $('#importer').hidden = false;
  }

  init().catch((err) => {
    console.error(err);
    toast(`初始化失敗：${err.message}`);
  });
})();
