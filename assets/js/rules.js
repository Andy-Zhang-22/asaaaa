/*
 * rules.js — 公司規章與案件檢核工具。
 *
 * 條文原文照登，判斷邏輯獨立成純函式方便驗證。規則以陣列保存，之後要再加新的
 * 規章直接往 RULES 裡加即可。
 */
(function (global) {
  'use strict';

  /** 可排除管制的擔保品（第四條列舉）。 */
  const EXCLUDING = ['不動產', '股票', '基金', '債券'];
  /** 會被列入管制的擔保品。 */
  const CONTROLLED_COLLATERAL = ['動產（機器設備、車輛等）', '其他擔保品'];
  const IRREGULAR_METHODS = ['頭小尾大', '不規則還款'];

  const CHECK_MONTHS = 6;        // 每 6 個月一個檢核點
  const CHECK_RATIO = 0.1;       // 每個檢核點累計應償還起租本金 10%
  const CONTROL_LIMIT_MONTHS = 60;   // 管制範圍：5 年內
  const WAIVE_BALANCE_RATIO = 0.1;   // 第九條：本金餘額降至 10%（含）以下免檢核

  /* ---------------- 判斷邏輯（純函式） ---------------- */

  /**
   * 這件案子要不要受第四條管制。
   * @param {{method:string, collaterals:string[]}} input
   * @returns {{controlled:boolean, uncertain:boolean, reason:string}}
   */
  function assessControl(input) {
    const method = input.method || '';
    const collaterals = input.collaterals || [];

    if (!IRREGULAR_METHODS.includes(method)) {
      return {
        controlled: false,
        uncertain: false,
        reason: `還款方式為「${method || '未選擇'}」，非「頭小尾大」或「不規則還款」，不適用第四條。`,
      };
    }

    const pledged = collaterals.filter((c) => c !== '純信用（無擔保品）');
    const excluding = pledged.filter((c) => EXCLUDING.includes(c));
    const others = pledged.filter((c) => !EXCLUDING.includes(c));

    if (!pledged.length) {
      return { controlled: true, uncertain: false, reason: '純信用案件，且還款方式為頭小尾大／不規則還款，應受管制。' };
    }
    if (others.length && excluding.length) {
      // 條文寫「徵提之擔保品非屬不動產、股票、基金或債券」，同時徵提兩類時
      // 條文本身沒有明講，不自行認定，先以受管制處理並提醒確認
      return {
        controlled: true,
        uncertain: true,
        reason: `同時徵提可排除的擔保品（${excluding.join('、')}）與須管制的擔保品（${others.join('、')}）。`
          + '條文未明確規範混合徵提的情形，此處先以「受管制」呈現，送件前請向風管確認。',
      };
    }
    if (others.length) {
      return {
        controlled: true,
        uncertain: false,
        reason: `徵提之擔保品為 ${others.join('、')}，非屬不動產、股票、基金或債券，應受管制。`,
      };
    }
    return {
      controlled: false,
      uncertain: false,
      reason: `徵提之擔保品為 ${excluding.join('、')}，屬第四條列舉可排除者（不動產不論是否認列擔保值、順位），不受管制。`,
    };
  }

  /**
   * 依還款計畫算出每個 6 個月檢核點的達成情形。
   * @param {{principal:number, months:number, periodMonths:number, schedule:number[]}} input
   */
  function buildCheckpoints(input) {
    const principal = Number(input.principal) || 0;
    const months = Number(input.months) || 0;
    const periodMonths = Number(input.periodMonths) || 1;
    const schedule = input.schedule || [];
    if (principal <= 0 || months <= 0) return [];

    // 第 i 期（1 起算）的到期月份
    const paidBy = (month) => schedule.reduce(
      (sum, amount, i) => ((i + 1) * periodMonths <= month ? sum + (Number(amount) || 0) : sum), 0
    );

    const lastMonth = Math.min(months, CONTROL_LIMIT_MONTHS);
    const rows = [];
    for (let k = 1; k * CHECK_MONTHS <= lastMonth; k++) {
      const month = k * CHECK_MONTHS;
      const actual = paidBy(month);
      const balance = principal - actual;
      const required = Math.min(principal, principal * CHECK_RATIO * k);
      // 第九條：餘額降到 10%（含）以下就不受該檢核點的比例限制
      const waived = balance <= principal * WAIVE_BALANCE_RATIO + 1e-6;
      rows.push({
        index: k,
        month,
        required,
        actual,
        balance,
        shortfall: Math.max(0, required - actual),
        status: waived ? 'waived' : (actual + 1e-6 >= required ? 'pass' : 'short'),
      });
    }
    return rows;
  }

  /** 完整檢核：管制判定 + 檢核點 + 其他提醒。 */
  function evaluate(input) {
    const control = assessControl(input);
    const principal = Number(input.principal) || 0;
    const months = Number(input.months) || 0;
    const schedule = (input.schedule || []).map((n) => Number(n) || 0);
    const scheduleTotal = schedule.reduce((a, b) => a + b, 0);

    const notes = [];
    if (principal > 0 && schedule.length && Math.abs(scheduleTotal - principal) > Math.max(1, principal * 0.001)) {
      notes.push(`還款計畫合計 ${fmt(scheduleTotal)} 與起租本金 ${fmt(principal)} 不符，請確認是否漏列或多列期數。`);
    }
    if (months > CONTROL_LIMIT_MONTHS && control.controlled) {
      notes.push('承作期間超過五年，依第四條應先經「審查處主管同意」後始得送件。');
      notes.push('條文載明管制範圍為五年內，超過五年的部分如何檢核條文未明述，送件前請向風管確認。');
    }
    if (control.uncertain) notes.push('擔保品組合需向風管確認（見下方判定理由）。');

    const checkpoints = control.controlled ? buildCheckpoints(input) : [];
    const failed = checkpoints.filter((c) => c.status === 'short');

    return {
      control,
      checkpoints,
      failed,
      notes,
      scheduleTotal,
      passed: control.controlled ? failed.length === 0 : true,
    };
  }

  const fmt = (n) => (Number(n) || 0).toLocaleString('zh-TW', { maximumFractionDigits: 0 });

  /** 把使用者貼上的還款計畫轉成數字陣列，容許逗號、換行、空白、全形數字。 */
  function parseSchedule(text) {
    return String(text || '')
      .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
      .split(/[\n,、;；\s]+/)
      .map((piece) => piece.replace(/[^\d.]/g, ''))
      .filter((piece) => piece !== '')
      .map(Number)
      .filter((n) => Number.isFinite(n));
  }

  /* ---------------- 規則內容 ---------------- */

  const RULES = [{
    id: 'principal-repayment-4',
    title: '案件償還本金管理辦法　第四條',
    summary: '純信用或非不動產／股票／基金／債券擔保的案件，還款採頭小尾大或不規則還款者，每 6 個月至少要累計償還起租本金 10%。',
    articles: [{
      heading: '第四條',
      text: '純信用案件，或徵提之擔保品非屬不動產、股票、基金或債券之案件，其還款方式採「頭小尾大」或「不規則還款」者，'
        + '應以每6個月至少累計償還起租本金10%為原則，前項案件之承作期間超過五年者，應先經審查處主管同意後始得送件。',
    }, {
      heading: '第九條（例外）',
      text: '本金餘額降至10%（含）以下時，得不受相對應之每六個月至少累計償還金比例限制。',
    }],
    clarifications: [
      '擔保品僅限縮不動產（不論是否認列擔保值、順位）、股票、基金或債券可排除，其餘徵提擔保品（如動產）皆須入列管制。',
      '「每6個月至少累計償還起租本金10%」係指從起租至結束（5年內皆管制），皆須每6個月至少累計償還起租本金10%。',
      '第九條另規範，本金餘額降至10%（含）以下時，得不受相對應之每六個月至少累計償還金比例限制。',
    ],
    clarificationNote: '以上為與風管確認之認定方式。',
    hasChecker: true,
  }];

  global.Rules = {
    RULES, evaluate, assessControl, buildCheckpoints, parseSchedule, fmt,
    EXCLUDING, CONTROLLED_COLLATERAL, IRREGULAR_METHODS,
  };

  /* ---------------- 畫面 ---------------- */

  const el = (tag, props, children) => {
    const node = Object.assign(document.createElement(tag), props || {});
    (children || []).forEach((c) => c && node.append(c));
    return node;
  };

  const COLLATERAL_OPTIONS = ['純信用（無擔保品）', ...EXCLUDING, ...CONTROLLED_COLLATERAL];
  const METHOD_OPTIONS = ['本息平均攤還', '本金平均攤還', ...IRREGULAR_METHODS];
  const FREQ_OPTIONS = [['月繳', 1], ['季繳', 3], ['半年繳', 6], ['年繳', 12]];

  function checker(rule) {
    const box = el('div', { className: 'rule-checker' }, [el('h3', { textContent: '案件檢核' })]);
    const form = el('div', { className: 'rule-form' });

    const field = (label, control, hint) => el('label', { className: 'rule-field' }, [
      el('span', { textContent: label }),
      control,
      hint ? el('small', { textContent: hint }) : null,
    ]);

    const principal = el('input', { type: 'text', inputMode: 'numeric', placeholder: '例如 5,000,000' });
    const months = el('input', { type: 'number', min: '1', placeholder: '例如 60' });
    const method = el('select');
    METHOD_OPTIONS.forEach((m) => method.append(el('option', { value: m, textContent: m })));
    method.value = '頭小尾大';
    const freq = el('select');
    FREQ_OPTIONS.forEach(([label, value]) => freq.append(el('option', { value: String(value), textContent: label })));

    const collateralBox = el('div', { className: 'chips' });
    const chosen = new Set(['純信用（無擔保品）']);
    COLLATERAL_OPTIONS.forEach((name) => {
      const chip = el('button', { className: 'chip', type: 'button', textContent: name });
      chip.setAttribute('aria-pressed', chosen.has(name) ? 'true' : 'false');
      chip.onclick = () => {
        if (name === '純信用（無擔保品）') {
          chosen.clear();
          chosen.add(name);
        } else {
          chosen.delete('純信用（無擔保品）');
          chosen.has(name) ? chosen.delete(name) : chosen.add(name);
          if (!chosen.size) chosen.add('純信用（無擔保品）');
        }
        [...collateralBox.children].forEach((c) => {
          c.setAttribute('aria-pressed', chosen.has(c.textContent) ? 'true' : 'false');
        });
        run();
      };
      collateralBox.append(chip);
    });

    const schedule = el('textarea', {
      placeholder: '每期償還本金，一行一期（也可以用逗號或空白分隔）\n例如：\n50000\n50000\n120000',
    });
    const fillEven = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '填入平均攤還' });
    fillEven.onclick = () => {
      const total = Number(String(principal.value).replace(/[^\d.]/g, '')) || 0;
      const m = Number(months.value) || 0;
      const per = Number(freq.value) || 1;
      const count = Math.floor(m / per);
      if (!total || !count) return;
      const each = total / count;
      schedule.value = Array(count).fill(Math.round(each)).join('\n');
      run();
    };

    form.append(
      field('起租本金', principal, '單位不拘，與還款計畫一致即可'),
      field('承作期間（月）', months),
      field('還款方式', method),
      field('繳款頻率', freq),
    );
    box.append(form);
    box.append(el('div', { className: 'rule-field rule-field-wide' }, [
      el('span', { textContent: '徵提擔保品（可複選）' }), collateralBox,
    ]));
    box.append(el('div', { className: 'rule-field rule-field-wide' }, [
      el('span', { textContent: '還款計畫' }),
      schedule,
      el('div', { className: 'card-actions' }, [fillEven]),
    ]));

    const result = el('div', { className: 'rule-result' });
    box.append(result);

    function run() {
      const input = {
        principal: Number(String(principal.value).replace(/[^\d.]/g, '')) || 0,
        months: Number(months.value) || 0,
        periodMonths: Number(freq.value) || 1,
        method: method.value,
        collaterals: [...chosen],
        schedule: parseSchedule(schedule.value),
      };
      const out = evaluate(input);
      result.textContent = '';

      const verdictClass = !out.control.controlled ? 'is-ok'
        : (out.control.uncertain ? 'is-warn' : 'is-controlled');
      result.append(el('p', { className: `rule-verdict ${verdictClass}` }, [
        el('strong', { textContent: out.control.controlled ? '受第四條管制' : '不受第四條管制' }),
        document.createTextNode('　' + out.control.reason),
      ]));

      out.notes.forEach((note) => result.append(el('p', { className: 'rule-note', textContent: `※ ${note}` })));

      if (!out.control.controlled || !input.principal || !input.months) {
        if (out.control.controlled) {
          result.append(el('p', { className: 'muted', textContent: '填入起租本金與承作期間後即可檢核各期。' }));
        }
        return;
      }
      if (!input.schedule.length) {
        result.append(el('p', { className: 'muted', textContent: '填入還款計畫後即可檢核各期是否達標。' }));
        return;
      }

      result.append(el('p', {
        className: `rule-verdict ${out.passed ? 'is-ok' : 'is-fail'}`,
        textContent: out.passed
          ? '檢核結果：各檢核點皆符合每 6 個月累計償還起租本金 10% 之原則。'
          : `檢核結果：有 ${out.failed.length} 個檢核點未達標，需調整還款計畫。`,
      }));

      const table = el('table', { className: 'rule-table' });
      table.append(el('thead', {}, [el('tr', {}, [
        el('th', { textContent: '檢核點' }), el('th', { textContent: '應累計償還' }),
        el('th', { textContent: '實際累計償還' }), el('th', { textContent: '本金餘額' }),
        el('th', { textContent: '結果' }),
      ])]));
      const tbody = el('tbody');
      const LABEL = { pass: '通過', short: '不足', waived: '免檢核（餘額≤10%）' };
      out.checkpoints.forEach((c) => {
        tbody.append(el('tr', { className: `row-${c.status}` }, [
          el('td', { textContent: `第 ${c.month} 個月` }),
          el('td', { textContent: fmt(c.required) }),
          el('td', { textContent: fmt(c.actual) }),
          el('td', { textContent: fmt(c.balance) }),
          el('td', { textContent: c.status === 'short' ? `不足 ${fmt(c.shortfall)}` : LABEL[c.status] }),
        ]));
      });
      table.append(tbody);
      result.append(table);
    }

    [principal, months, schedule].forEach((input) => { input.oninput = run; });
    [method, freq].forEach((input) => { input.onchange = run; });
    run();
    return box;
  }

  /** 把規則頁畫到指定容器。 */
  function render(host) {
    host.textContent = '';
    RULES.forEach((rule) => {
      const card = el('article', { className: 'rule-card' }, [
        el('h2', { textContent: rule.title }),
        el('p', { className: 'rule-summary', textContent: rule.summary }),
      ]);
      rule.articles.forEach((article) => {
        card.append(el('div', { className: 'rule-article' }, [
          el('h3', { textContent: article.heading }),
          el('p', { textContent: article.text }),
        ]));
      });
      if (rule.clarifications && rule.clarifications.length) {
        const list = el('ol');
        rule.clarifications.forEach((text) => list.append(el('li', { textContent: text })));
        card.append(el('div', { className: 'rule-article rule-clarify' }, [
          el('h3', { textContent: '認定方式' }),
          list,
          rule.clarificationNote ? el('p', { className: 'muted', textContent: rule.clarificationNote }) : null,
        ]));
      }
      if (rule.hasChecker) card.append(checker(rule));
      host.append(card);
    });
  }

  global.Rules.render = render;
})(window);
