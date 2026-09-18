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

  /* ---------------- 業績與淨收益分享試算 ---------------- */

  /** 微型企業營業處分享業績的單戶上限（仟元）。 */
  const MICRO_SHARE_CAP = 16000;

  const SHARE_SCENARIOS = {
    'general-cross': {
      label: '一般案件協銷（一般組之間）',
      period: '自核准日起一年內',
      origin: 0.7, partner: 0.3, partnerLabel: '協銷單位',
    },
    'general-transfer': {
      label: '一般客戶移交（一般組之間）',
      period: '自移交日起二年內',
      origin: 0.6, partner: 0.4, partnerLabel: '移交單位',
    },
    'micro-cross': {
      label: '微企處協銷予非微企單位／微企科間協銷',
      period: '自核准日起一年內',
      origin: 0.7, partner: 0.3, partnerLabel: '微型企業營業處',
      cap: MICRO_SHARE_CAP,
      note: '分享業績額，不適用協銷獎金。',
    },
    'micro-transfer-active-first': {
      label: '微企主動移交　第一筆案件',
      period: '不受二年期限之限制（得至少辦理二次業績分享）',
      origin: 0.5, partner: 0.5, partnerLabel: '微型企業營業處',
      cap: MICRO_SHARE_CAP,
    },
    'micro-transfer-active-rest': {
      label: '微企主動移交　後續案件',
      period: '不受二年期限之限制（得至少辦理二次業績分享）',
      origin: 0.6, partner: 0.4, partnerLabel: '微型企業營業處',
      cap: MICRO_SHARE_CAP,
    },
    'micro-transfer-passive': {
      label: '微企被動移交',
      period: '自移轉日起二年內',
      origin: 0.6, partner: 0.4, partnerLabel: '微型企業營業處',
      cap: MICRO_SHARE_CAP,
    },
  };

  /**
   * 算出雙方的業績與淨收益分享金額。
   * @param {{scenario:string, amount:number, profit:number}} input 金額單位皆為仟元
   */
  function shareSplit(input) {
    const spec = SHARE_SCENARIOS[input.scenario];
    if (!spec) return null;
    const amount = Number(input.amount) || 0;
    const profit = Number(input.profit) || 0;

    const rawPartnerAmount = amount * spec.partner;
    const capped = spec.cap !== undefined && rawPartnerAmount > spec.cap;
    const partnerAmount = capped ? spec.cap : rawPartnerAmount;

    return {
      spec,
      originRatio: spec.origin,
      partnerRatio: spec.partner,
      originAmount: amount - partnerAmount,
      partnerAmount,
      rawPartnerAmount,
      capped,
      originProfit: profit * spec.origin,
      partnerProfit: profit * spec.partner,
    };
  }

  /* ---------------- 客戶歸屬與承作單位判定 ---------------- */

  // 微企範疇：資本額未達 5,000 仟元（不含 5,000）。規範原文寫 10,000 仟元（含），
  // 但使用者 2026/09 重新定義為 5,000 仟元以下不含，網站的判定以這個為準；下方規範摘錄照原文保留。
  const MICRO_CAPITAL_LIMIT = 5000;     // 微企客戶資本額門檻（仟元，未達才算）
  const LARGE_CAPITAL_LIMIT = 500000;   // 大企部客戶資本額下限（仟元，含）
  const MICRO_CREDIT_LIMIT = 7000;      // 微企單戶授信往來總額上限（仟元）
  const MICRO_MIN_SPREAD = 9;           // 一般組承作 7,000 仟元以下案件的 Spread 下限（%）
  const HANDOVER_MIN_LEASE = 10000;     // 微企移交一般組後的單筆最低起租金額（仟元）
  const PASSIVE_MIN_YIELD = 10;         // 被動移交後一般組新案實質收益率下限（%）

  /**
   * 依行銷規範判斷這個客戶該由誰承作、要不要協銷或移交。
   * 回傳一串提醒，level 分為 ok／warn／block。
   */
  function routeCustomer(input) {
    const capital = Number(input.capital) || 0;
    const exposure = Number(input.exposure) || 0;
    const spread = input.spread === '' || input.spread === undefined ? null : Number(input.spread);
    const notes = [];
    const push = (level, text) => notes.push({ level, text });

    // 一、行銷區域
    if (input.sameRegion === false) {
      push('block', '客戶登記地址不屬於本行銷區，依【一般組】行銷規範第(三)項，一律採「協銷」辦理，'
        + '並須至「業務跨區申覆協銷作業系統」提出申請，經雙方主管簽核同意。'
        + '（符合申覆變更歸屬條件者不在此限）');
    }
    if (input.ownerElsewhere) {
      push('block', '客戶之實質負責人已歸屬其他單位，同樣一律採「協銷」辦理。');
    }

    // 二、微企 vs 一般組
    const isMicroScale = capital > 0 && capital < MICRO_CAPITAL_LIMIT;
    if (capital > 0) {
      push(isMicroScale ? 'ok' : 'warn', isMicroScale
        ? `資本額 ${fmt(capital)} 仟元 未達 ${fmt(MICRO_CAPITAL_LIMIT)} 仟元，屬【微型企業營業處】客戶範疇（不受行業別限制）。`
        : `資本額 ${fmt(capital)} 仟元 達 ${fmt(MICRO_CAPITAL_LIMIT)} 仟元（含）以上，不屬微企處客戶範疇。`);
    }

    // 三、授信額度上限與移交門檻
    if (exposure > 0) {
      if (exposure <= MICRO_CREDIT_LIMIT) {
        push('ok', `單戶累計往來 ${fmt(exposure)} 仟元，在微企處授信上限 ${fmt(MICRO_CREDIT_LIMIT)} 仟元（含）以內。`
          + '（計算可排除供行部新購設備、存貨擔保融資、不動產融資專案處之本金餘額）');
      } else if (input.currentUnit === '微企處') {
        push('block', `單戶起租金額合計本餘 ${fmt(exposure)} 仟元 已超過 ${fmt(MICRO_CREDIT_LIMIT)} 仟元，`
          + '微企處應「主動辦理移交」改由一般組服務，並由原承作單位陪同承接單位共同拜訪客戶。');
        push('warn', `移交一般組後三個月內必須送件，並於批覆書有效期限（三個月）內完成起租，`
          + `單筆最低起租金額門檻為 ${fmt(HANDOVER_MIN_LEASE)} 仟元（含）；逾期則案件歸還微企處。`
          + '（不論是否分次撥動皆須符合）');
      } else {
        push('ok', `單戶累計往來 ${fmt(exposure)} 仟元 超過微企處上限，屬一般組服務範圍。`);
      }
    }

    // 四、收益率控管
    if (input.currentUnit === '一般組' && exposure > 0 && exposure <= MICRO_CREDIT_LIMIT) {
      if (spread === null) {
        push('warn', `一般組承作單一客戶統編累計往來 ${fmt(MICRO_CREDIT_LIMIT)} 仟元（含）以下之案件，`
          + `Spread 不得低於 ${MICRO_MIN_SPREAD}%（不含）。請填入本案 Spread 以檢核。`);
      } else if (spread <= MICRO_MIN_SPREAD) {
        push('block', `本案 Spread ${spread}% 未高於 ${MICRO_MIN_SPREAD}%，`
          + '依收益率控管規範第(一)項，應協銷予微企處承作。');
      } else {
        push('ok', `本案 Spread ${spread}% 高於 ${MICRO_MIN_SPREAD}%，符合收益率控管規範第(一)項。`);
      }
    }

    // 五、舊戶交叉的實質收益率控管
    if (input.counterpartOldCustomer && exposure > 0 && exposure <= MICRO_CREDIT_LIMIT) {
      push('warn', '申戶本身或關聯企業為「另一方（一般組／微企處）」之舊戶，且單一統編累計往來 ≤700 萬，'
        + '兩項條件同時成立：本案「實質收益率」不得低於雙方二年內已起租案件之最低實質收益率。'
        + '（OSF 及微企協銷案件不納入控管）送件後由審查協助確認並提供該最低收益率。');
    }

    // 六、被動移交後的收益率下限
    if (input.handoverType === '被動移交') {
      push('warn', `被動移交後，一般組承作新案之實質收益率不得低於 ${PASSIVE_MIN_YIELD}%，`
        + '或不得低於微企處最後一筆起租案件之「實質收益率扣減 2%」之標準。'
        + '未符合者應報請業務總經理核准；原核決權限屬業務總經理者，須請總經理核准。');
    } else if (input.handoverType === '主動移交') {
      push('ok', '主動移交後，新案承作之收益率不設限，惟仍應符合既有相關規範。');
    }

    if (!notes.length) push('ok', '依目前填入的條件，沒有觸發特別的行銷區域或收益率限制。');
    return notes;
  }

  /* ---------------- 規章內容 ---------------- */

  const SHARE_COLUMNS = ['單　位', '業績（LF 受讓金額）', '淨收益（LF 毛利）'];

  const RULES = [{
    id: 'principal-repayment-4',
    title: '案件償還本金管理辦法　第四條',
    summary: '純信用或非不動產／股票／基金／債券擔保的案件，還款採頭小尾大或不規則還款者，每 6 個月至少要累計償還起租本金 10%。',
    sections: [
      { type: 'article', heading: '第四條',
        text: '純信用案件，或徵提之擔保品非屬不動產、股票、基金或債券之案件，其還款方式採「頭小尾大」或「不規則還款」者，'
          + '應以每6個月至少累計償還起租本金10%為原則，前項案件之承作期間超過五年者，應先經審查處主管同意後始得送件。' },
      { type: 'article', heading: '第九條（例外）',
        text: '本金餘額降至10%（含）以下時，得不受相對應之每六個月至少累計償還金比例限制。' },
      { type: 'list', heading: '認定方式（與風管確認）', highlight: true, items: [
        '擔保品僅限縮不動產（不論是否認列擔保值、順位）、股票、基金或債券可排除，其餘徵提擔保品（如動產）皆須入列管制。',
        '「每6個月至少累計償還起租本金10%」係指從起租至結束（5年內皆管制），皆須每6個月至少累計償還起租本金10%。',
        '第九條另規範，本金餘額降至10%（含）以下時，得不受相對應之每六個月至少累計償還金比例限制。',
      ] },
    ],
    tool: 'principal-checker',
  }, {
    id: 'share-principle',
    title: '案件協銷及客戶移交　業績及淨收益分享原則',
    source: '行銷區域劃分規範',
    summary: '本金依起租單位認列。協銷分享一年、移交分享二年；微企處另有專屬比例與單戶 16,000 仟元上限。',
    sections: [
      { type: 'note', text: '本金依起租單位認列。' },
      { type: 'table', heading: '一、案件協銷：分享期間自核准日起一年內',
        columns: SHARE_COLUMNS,
        rows: [['起租單位', '70%', '70%'], ['協銷單位', '30%', '30%']] },
      { type: 'table', heading: '二、客戶移交：分享期間自移交日起二年內',
        columns: SHARE_COLUMNS,
        rows: [['起租單位', '60%', '60%'], ['移交單位', '40%', '40%']] },
      { type: 'article', heading: '三、【微型企業營業處】協銷分享原則　(一)',
        text: '微型企業營業處協銷予非微企單位及微型企業科間之協銷：分享業績額，不適用協銷獎金。' },
      { type: 'table', heading: '1. 案件協銷：分享期間自核准日起一年內',
        columns: SHARE_COLUMNS,
        rows: [
          ['起租單位', '70%', '70%'],
          ['微型企業營業處', '30%（單戶上限 16,000 仟元）', '30%（同傳統業績比例）'],
        ] },
      { type: 'table', heading: '2. 客戶移交：分享期間自移轉日起二年內',
        columns: SHARE_COLUMNS,
        rows: [
          ['起租單位', '50% 或 60%（視主被動移交而定）', '50% 或 60%（視主被動移交而定）'],
          ['微企處　主動移交', '第一筆案件 50%，其後續案件 40%（單戶上限 16,000 仟元）', '40%（同傳統業績比例）'],
          ['微企處　被動移交', '40%（單戶上限 16,000 仟元）', '40%（同傳統業績比例）'],
        ],
        note: '註：主動移交案件得至少辦理二次業績分享，且分享期間不受二年期限之限制；'
          + '第一筆案件分享比例為 50%，其後續案件之分享比例為 40%。' },
    ],
    tool: 'share-calculator',
  }, {
    id: 'micro-marketing',
    title: '【微型企業營業處】行銷規範',
    source: '行銷區域劃分規範　第 13 頁',
    summary: '資本額 10,000 仟元以下為微企客戶範疇；單戶授信上限 7,000 仟元，超過即應主動移交一般組。',
    sections: [
      { type: 'ordered', heading: '', items: [
        '客戶資本額：原則小於 10,000 仟元（含）以下之營利事業，不受行業別限制。',
        '授信額度上限：單戶（微企單位內往來之客戶，含關係人企業）最高往來總額為 7,000 仟元（含）以內。'
          + '授信額度計算可排除「供行部新購設備案件之本金餘額」、「存貨擔保融資之本金餘額」、「不動產融資專案處之本金餘額」。',
        '微企單位內，若關企為微企其他單位舊戶，送件前應向原歸屬單位申覆並取得同意；惟若認定屬同一實質負責人，則應以協銷辦理。',
        '微企處已往來之客戶，若一般組擬承作，得依規定辦理客戶移交程序。該移交須經微企處處級主管同意；'
          + '惟微企處處級主管得視個案情形，敘明理由予以否決。微企單位於受理申請後，應於五個工作日內回覆意見，'
          + '逾期未回覆者，視為同意辦理移交。如雙方處級主管對移交案意見不一致時，應提報「爭議案件委員會」裁決。',
        '如單戶起租金額合計本餘已超過 7,000 仟元，微企處應主動辦理移交，改由一般組服務。'
          + '移交作業應兼顧客戶體驗，由原承作單位（微企處／一般組）陪同承接單位（一般組／微企處）共同進行客戶拜訪，'
          + '並以「公司內部服務升級、交由適切之業務單位承接」之專業說明與客戶溝通，確保客戶感受良好且獲得充分重視。'
          + '移交過程中，嚴禁對外揭露或表現內部業務分歧或衝突情事。',
        '微企移交一般組後三個月內必須送件，並於批覆書有效期限（三個月內）完成起租，'
          + '單筆最低起租金額門檻為 10,000 仟元（含），若逾期則案件歸還微企處。（不論是否分次撥動，皆需符合此項門檻限制）',
        '一般組已往來客戶，若營業規模縮減得協銷案件予微企處，並辦理客戶移轉。',
      ] },
    ],
  }, {
    id: 'yield-control',
    title: '一般組及微企處之收益率控管規範',
    source: '行銷區域劃分規範　第 16 頁',
    summary: '一般組要做 7,000 仟元以下的案子，Spread 必須高於 9%，否則應協銷予微企處。',
    sections: [
      { type: 'ordered', heading: '', items: [
        '一般組承作單一客戶統編之累計往來總額 7,000 仟元（含）以下之案件，「Spread」不得低於 9%（不含），'
          + '未符合者應協銷予微企處承作。',
        '一般組及微企處欲往來之申戶，若同時符合下列二項條件者，該件承作之「實質收益率」不得低於雙方二年內'
          + '已起租案件之最低實質收益率：1. 申戶本身或其關聯企業屬「另一方（一般組或微企處）」之舊戶者。'
          + '2. 單一客戶統編之「累計往來金額 ≤ 700 萬」時（含本次核准額度）。'
          + '（註：OSF 及微企協銷案件不納入控管）',
        '不符上述規範者，後送件單位須向前起租單位進行申覆作業（選取跨區申覆：其他原因），'
          + '並於說明欄中註明違反業務報價收益率辦法並揭露本案申請收益率，由總經理核決。',
        '業務送件後，由審查協助確認申戶或申戶關企是否為「一般組／微企處」之舊戶，'
          + '並提供二年內一般組及微企處之起租案件最低收益率予業務參考。',
        '微企移交案件之收益率控管：'
          + '【主動移交】移交後新案承作之收益率不設限，惟仍應符合既有相關規範。'
          + '【被動移交】移交後一般組承作新案之實質收益率，不得低於 10%，'
          + '或不得低於微企處最後一筆起租案件之「實質收益率扣減 2%」之標準。'
          + '如實質收益率未符合前述規範，應報請業務總經理核准；則原核決權限屬業務總經理者，則須請總經理核准。',
      ] },
    ],
  }, {
    id: 'region-attribution',
    title: '行銷區域劃分與客戶歸屬',
    source: '行銷區域劃分規範　第 2 頁',
    summary: '客戶依「公司登記地址」劃分行銷區；跨區推廣一律協銷。申覆後 180 天未起租即歸還原單位。',
    sections: [
      { type: 'ordered', heading: '四、若因業務需求及符合下列狀況者，可透由申覆，變更客戶歸屬', items: [
        '公司所登記之營業地址無人辦公，僅為登記之用，實際辦公地點在另一行銷區者。',
        '公司所登記之營業地址雖有人辦公，但主要財務人員或負責人在另一行銷區者，'
          + '且需檢附金融徵信中心往來銀行記錄資料（認定標準以申請移轉時可調閱之最新金融徵信中心資料內，'
          + '該公司在該行銷區之金融機構中所申請之總額度，是否佔所有金融機構總額度之 80%（含）以上為判定依據）。',
        '申覆後六個月（180 天）內未起租者，該客戶歸屬原單位（得再次申覆）。',
        '經申覆且起租者，本餘結束後超過六個月（180 天）則該客戶歸屬原單位（得再次申覆）。',
      ], note: '註 1：若被申覆方同意申覆，則無強制規定須檢附上述文件。　'
        + '註 2：依行銷區域劃分規範精神，上述申覆無需業績分享。' },
      { type: 'ordered', heading: '五、客戶變更公司登記地址歸屬原則', items: [
        '新戶：自變更登記地址核准日起，依新地址變更歸屬單位。',
        '舊戶：歸屬原承辦單位，惟本餘結束後超過六個月（180 天）則依新地址變更歸屬單位。',
      ] },
      { type: 'ordered', heading: '貳、各區處行銷規範　一、【一般組】行銷規範', items: [
        '一般組為：北一分處、北二分處、中區分處及南區分處轄下各分公司。',
        '客戶依「公司登記地址」劃分行銷區，原則上分公司間及同分公司內不得跨區推廣。',
        '若推廣到非所屬行銷區之客戶，或客戶之實質負責人已歸屬其他單位時，一律採「協銷」辦理，'
          + '惟符合上述壹條第四項第(一)、(二)款狀況者不在此限。'
          + '並由推廣單位至「業務跨區申覆協銷作業系統」提出申請，經雙方主管簽核同意後，系統通知企金行銷管理科。',
      ] },
    ],
    tool: 'unit-router',
  }, {
    id: 'branch-areas',
    title: '各分公司行銷區域劃分表',
    source: '行銷區域劃分規範　第 3～4 頁（四、區域劃分）',
    summary: '各分公司行銷區域如下表；【 】內是共同區，申覆以該行銷區的原始歸屬單位為被申覆對象（見附表一）。名單上每筆客戶的詳細頁會依登記地址標出所屬分公司。',
    sections: [
      { type: 'table', heading: '北一分處', columns: ['分公司', '行銷區域'], rows: [
        ['城中', '臺北市：中正區、中山區、大安區、萬華區。'],
        ['城東', '臺北市：松山區、信義區、南港區、文山區。新北市：汐止、深坑。'],
        ['城北', '基隆市：全區。臺北市：士林區、北投區、內湖區、大同區。新北市：金山、萬里、石門、三芝。【城北、新莊分公司共同區：淡水】'],
        ['新北', '【新北、中和分公司共同區：板橋、中和、永和、土城、三峽、鶯歌、新店、烏來】'],
        ['中和', '【新北、中和分公司共同區：板橋、中和、永和、土城、三峽、鶯歌、新店、烏來】'],
      ] },
      { type: 'table', heading: '北二分處', columns: ['分公司', '行銷區域'], rows: [
        ['新莊', '新北市：樹林、三重、新莊、泰山、林口、蘆洲、五股、八里。【城北、新莊分公司共同區：淡水】'],
        ['桃園', '桃園縣：中壢、新屋、觀音、大溪、復興、大園、蘆竹、桃園、龜山、八德。【桃園、新竹分公司共同區：平鎮、龍潭、楊梅】'],
        ['新竹', '新竹市、新竹縣：全區。苗栗縣：竹南、頭份、三灣、南庄、獅潭、後龍、苗栗、造橋、頭屋。【桃園、新竹分公司共同區：平鎮、龍潭、楊梅】'],
        ['宜花（宜蘭一科、二科）', '新北市：瑞芳、平溪、雙溪、貢寮、坪林、石碇。宜蘭縣：全區。'],
        ['宜花（花蓮一科、二科）', '花蓮縣：全區。【高屏、花蓮一科、花蓮二科共同區：台東縣全區】'],
      ] },
      { type: 'table', heading: '中區分處', columns: ['分公司', '行銷區域'], rows: [
        ['北台中', '台中市：神岡、大雅、后里、豐原、潭子、石岡、東勢、新社、和平。【北台中、南台中分公司共同區：中區、東區、西區、南區、北區、西屯區、南屯區、北屯區】【北台中、中彰分公司共同區：苗栗縣－通霄、苑裡、公館、大湖、泰安、銅鑼、三義、西湖、卓蘭】'],
        ['南台中', '台中市：烏日、大里、太平、霧峰。【北台中、南台中分公司共同區：中區、東區、西區、南區、北區、西屯區、南屯區、北屯區】'],
        ['中彰', '台中市：大甲、大安、清水、梧棲、沙鹿、外埔、大肚、龍井。彰化縣：彰化市、和美鎮、鹿港鎮、伸港鄉、線西鄉、福興鄉。【北台中、中彰分公司共同區：苗栗縣－通霄、苑裡、公館、大湖、泰安、銅鑼、三義、西湖、卓蘭】'],
        ['彰化', '彰化縣：員林市、溪湖鎮、二林鎮、田中鎮、北斗鎮、花壇鄉、芬園鄉、大村鄉、永靖鄉、秀水鄉、埔心鄉、埔鹽鄉、大城鄉、芳苑鄉、竹塘鄉、社頭鄉、二水鄉、田尾鄉、埤頭鄉、溪州鄉。南投縣：全區。【彰化、嘉義分公司共同區：雲林縣－二崙、土庫、斗六、台西、四湖、西螺、東勢、林內、虎尾、崙背、麥寮、莿桐、褒忠】'],
      ] },
      { type: 'table', heading: '南區分處', columns: ['分公司', '行銷區域'], rows: [
        ['嘉義', '嘉義市、嘉義縣：全區。雲林縣：口湖、大埤、元長、斗南、水林、北港、古坑。【彰化、嘉義分公司共同區：雲林縣－二崙、土庫、斗六、台西、四湖、西螺、東勢、林內、虎尾、崙背、麥寮、莿桐、褒忠】'],
        ['府城', '臺南市：新營、鹽水、白河、柳營、後壁、東山、麻豆、下營、六甲、官田、佳里、學甲、西港、七股、將軍、北門、善化、安定。【府城、台南分公司共同區：安南、東區、南區、北區、中西區、安平、永康】'],
        ['台南', '臺南市：大內、玉井、楠西、南化、山上、新市、左鎮、新化、歸仁、仁德、關廟、龍崎。【府城、台南分公司共同區：安南、東區、南區、北區、中西區、安平、永康】'],
        ['北高雄', '高雄市：大社、大樹、仁武、內門、六龜、永安、田寮、甲仙、杉林、岡山、阿蓮、美濃、茄萣、那瑪夏(三民鄉)、茂林、桃源、梓官、鳥松、湖內、路竹、旗山、橋頭、燕巢、彌陀。【北高雄、南高雄共同區：三民、左營、前金、楠梓、鼓山、鹽埕、苓雅、新興、旗津】'],
        ['南高雄', '高雄市：小港、前鎮。【北高雄、南高雄共同區：三民、左營、前金、楠梓、鼓山、鹽埕、苓雅、新興、旗津】【南高雄、高屏共同區：大寮、林園、鳳山】'],
        ['高屏', '屏東縣全區。【南高雄、高屏共同區：大寮、林園、鳳山】【高屏、花蓮一科、花蓮二科共同區：台東縣全區】【高屏一科、二科】台灣地區全區之存貨擔保融資，僅限承作倉儲置放地為台中(含)以南且經我方認可之倉儲公司。'],
      ] },
      { type: 'table', heading: '共同區域', columns: ['區域', '說明'], rows: [
        ['澎湖縣、金門縣、連江縣、南海諸島、釣魚台列嶼', '全公司共同區域，不屬任一分公司。'],
      ] },
    ],
  }, {
    id: 'common-areas',
    title: '附表一：共同區域與被申覆單位',
    source: '行銷區域劃分規範　第 5 頁（附表一）',
    summary: '共同區的客戶要申覆時，以該區的原始歸屬單位為被申覆對象；標「擇任一方」的可參考 EIP 拜訪紀錄歸屬。',
    sections: [
      { type: 'table', heading: '', columns: ['共同區域', '被申覆單位'], rows: [
        ['新北：淡水', '城北分公司'],
        ['新北：板橋、永和', '新北分公司'],
        ['新北：中和、三峽、鶯歌', '中和分公司'],
        ['新北：土城、新店、烏來', '新北分公司／中和分公司（擇任一方，可參考 EIP 拜訪紀錄歸屬）'],
        ['桃園：平鎮、龍潭、楊梅', '桃園分公司'],
        ['台中：中區、東區、西區、南區、北區、西屯區、南屯區、北屯區', '北台中分公司／南台中分公司（擇任一方，可參考 EIP 拜訪紀錄歸屬）'],
        ['苗栗：通霄、苑裡、公館、大湖、泰安、銅鑼、三義、西湖、卓蘭', '北台中分公司'],
        ['雲林：二崙、斗六、台西、西螺、林內、崙背、麥寮、莿桐、褒忠', '彰化分公司'],
        ['雲林：土庫、四湖、東勢、虎尾', '嘉義分公司'],
        ['台南：安南、北區、永康', '府城分公司'],
        ['台南：東區、中西區、南區、安平', '台南分公司'],
        ['高雄：三民、左營、前金、楠梓、鼓山、鹽埕', '北高雄分公司'],
        ['高雄：苓雅、新興、旗津、大寮、林園、鳳山', '南高雄分公司'],
        ['台東縣全區', '高屏分公司'],
      ] },
    ],
  }, {
    id: 'inventory-finance',
    title: '存貨擔保融資',
    source: '行銷區域劃分規範　第 5 頁（五）',
    summary: '高屏一科、二科的專屬業務，可承作全台灣的存貨擔保融資，但倉儲須在台中（含）以南且經我方認可。',
    sections: [
      { type: 'ordered', heading: '', items: [
        '【高屏一科、二科】專屬業務；可承作台灣地區全區之存貨擔保融資，惟僅限承作倉儲置放地為台中(含)以南且經我方認可之倉儲公司。',
        '係指客戶與本公司往來分期（售後買回、三方買賣註）、資金貸與他人或銀行策略聯盟，並提供客戶所有置放於本公司或雙方指定倉儲公司之存貨（農、畜、漁產品或原物料…等）讓與本公司以擔保契約履行之往來方式。',
        '高屏一科、二科已往來之舊戶，需再往來存貨擔保融資業務，不需向其他企金單位申覆或報備。若該舊戶同時為其他企金單位舊戶且為其他企金單位先往來者，高屏一科、二科僅可往來存貨擔保融資業務，且需先向原歸屬單位報備。',
        '客戶為新戶者，高屏一科、二科欲往來存貨擔保融資，不需向其他企金單位申覆或報備。',
      ], note: '註：三方買賣，仍須回歸存貨擔保架構，客戶須為所有權人，並置放於我方認可之倉儲公司經驗貨完成後始得撥款。發票可由供應商開給中租，中租再開給客戶。' },
    ],
  }, {
    id: 'osf-cases',
    title: 'OSF 案件',
    source: '行銷區域劃分規範　第 5 頁（六）',
    summary: 'OSF 案件的申戶（境外法人）仍受單一歸屬規範，以申戶母公司的公司登記地址認定行銷區。',
    sections: [
      { type: 'ordered', heading: '', items: [
        'OSF 案件之申戶（境外法人）仍受單一歸屬之規範。',
        '以申戶母公司（保證公司）（資本額五億元以下）之「公司登記地址」來認定……（第 5 頁至此截斷，後續條文在第 6 頁，尚未提供）',
      ] },
    ],
  }];

  /* ---------------- 依登記地址查所屬分公司 ---------------- */

  /*
   * 上面那張表的資料版。district 一律寫規範上的寫法（沒有區／鄉／鎮／市字尾的就不帶），
   * 比對時兩種都試。city 用「臺」；桃園縣是規範上的舊寫法，這裡直接寫桃園市。
   * common 是共同區：branches 列出共用的分公司，appealTo 是附表一的被申覆單位。
   */
  const BRANCH_AREAS = [
    { division: '北一分處', branch: '城中', areas: { 臺北市: ['中正區', '中山區', '大安區', '萬華區'] } },
    { division: '北一分處', branch: '城東', areas: { 臺北市: ['松山區', '信義區', '南港區', '文山區'], 新北市: ['汐止', '深坑'] } },
    { division: '北一分處', branch: '城北', areas: { 基隆市: 'all', 臺北市: ['士林區', '北投區', '內湖區', '大同區'], 新北市: ['金山', '萬里', '石門', '三芝'] } },
    { division: '北二分處', branch: '新莊', areas: { 新北市: ['樹林', '三重', '新莊', '泰山', '林口', '蘆洲', '五股', '八里'] } },
    { division: '北二分處', branch: '桃園', areas: { 桃園市: ['中壢', '新屋', '觀音', '大溪', '復興', '大園', '蘆竹', '桃園', '龜山', '八德'] } },
    { division: '北二分處', branch: '新竹', areas: { 新竹市: 'all', 新竹縣: 'all', 苗栗縣: ['竹南', '頭份', '三灣', '南庄', '獅潭', '後龍', '苗栗', '造橋', '頭屋'] } },
    { division: '北二分處', branch: '宜花（宜蘭一科、二科）', areas: { 新北市: ['瑞芳', '平溪', '雙溪', '貢寮', '坪林', '石碇'], 宜蘭縣: 'all' } },
    { division: '北二分處', branch: '宜花（花蓮一科、二科）', areas: { 花蓮縣: 'all' } },
    { division: '中區分處', branch: '北台中', areas: { 臺中市: ['神岡', '大雅', '后里', '豐原', '潭子', '石岡', '東勢', '新社', '和平'] } },
    { division: '中區分處', branch: '南台中', areas: { 臺中市: ['烏日', '大里', '太平', '霧峰'] } },
    { division: '中區分處', branch: '中彰', areas: { 臺中市: ['大甲', '大安', '清水', '梧棲', '沙鹿', '外埔', '大肚', '龍井'], 彰化縣: ['彰化市', '和美鎮', '鹿港鎮', '伸港鄉', '線西鄉', '福興鄉'] } },
    { division: '中區分處', branch: '彰化', areas: { 彰化縣: ['員林市', '溪湖鎮', '二林鎮', '田中鎮', '北斗鎮', '花壇鄉', '芬園鄉', '大村鄉', '永靖鄉', '秀水鄉', '埔心鄉', '埔鹽鄉', '大城鄉', '芳苑鄉', '竹塘鄉', '社頭鄉', '二水鄉', '田尾鄉', '埤頭鄉', '溪州鄉'], 南投縣: 'all' } },
    { division: '南區分處', branch: '嘉義', areas: { 嘉義市: 'all', 嘉義縣: 'all', 雲林縣: ['口湖', '大埤', '元長', '斗南', '水林', '北港', '古坑'] } },
    { division: '南區分處', branch: '府城', areas: { 臺南市: ['新營', '鹽水', '白河', '柳營', '後壁', '東山', '麻豆', '下營', '六甲', '官田', '佳里', '學甲', '西港', '七股', '將軍', '北門', '善化', '安定'] } },
    { division: '南區分處', branch: '台南', areas: { 臺南市: ['大內', '玉井', '楠西', '南化', '山上', '新市', '左鎮', '新化', '歸仁', '仁德', '關廟', '龍崎'] } },
    { division: '南區分處', branch: '北高雄', areas: { 高雄市: ['大社', '大樹', '仁武', '內門', '六龜', '永安', '田寮', '甲仙', '杉林', '岡山', '阿蓮', '美濃', '茄萣', '那瑪夏', '三民鄉', '茂林', '桃源', '梓官', '鳥松', '湖內', '路竹', '旗山', '橋頭', '燕巢', '彌陀'] } },
    { division: '南區分處', branch: '南高雄', areas: { 高雄市: ['小港', '前鎮'] } },
    { division: '南區分處', branch: '高屏', areas: { 屏東縣: 'all' } },
  ];
  const COMMON_AREAS = [
    { branches: ['城北', '新莊'], city: '新北市', districts: ['淡水'], appealTo: '城北分公司' },
    { branches: ['新北', '中和'], city: '新北市', districts: ['板橋', '永和'], appealTo: '新北分公司' },
    { branches: ['新北', '中和'], city: '新北市', districts: ['中和', '三峽', '鶯歌'], appealTo: '中和分公司' },
    { branches: ['新北', '中和'], city: '新北市', districts: ['土城', '新店', '烏來'], appealTo: '新北分公司／中和分公司（擇任一方，可參考 EIP 拜訪紀錄）' },
    { branches: ['桃園', '新竹'], city: '桃園市', districts: ['平鎮', '龍潭', '楊梅'], appealTo: '桃園分公司' },
    { branches: ['北台中', '南台中'], city: '臺中市', districts: ['中區', '東區', '西區', '南區', '北區', '西屯區', '南屯區', '北屯區'], appealTo: '北台中分公司／南台中分公司（擇任一方，可參考 EIP 拜訪紀錄）' },
    { branches: ['北台中', '中彰'], city: '苗栗縣', districts: ['通霄', '苑裡', '公館', '大湖', '泰安', '銅鑼', '三義', '西湖', '卓蘭'], appealTo: '北台中分公司' },
    { branches: ['彰化', '嘉義'], city: '雲林縣', districts: ['二崙', '斗六', '台西', '西螺', '林內', '崙背', '麥寮', '莿桐', '褒忠'], appealTo: '彰化分公司' },
    { branches: ['彰化', '嘉義'], city: '雲林縣', districts: ['土庫', '四湖', '東勢', '虎尾'], appealTo: '嘉義分公司' },
    { branches: ['府城', '台南'], city: '臺南市', districts: ['安南', '北區', '永康'], appealTo: '府城分公司' },
    { branches: ['府城', '台南'], city: '臺南市', districts: ['東區', '中西區', '南區', '安平'], appealTo: '台南分公司' },
    { branches: ['北高雄', '南高雄'], city: '高雄市', districts: ['三民', '左營', '前金', '楠梓', '鼓山', '鹽埕'], appealTo: '北高雄分公司' },
    { branches: ['北高雄', '南高雄'], city: '高雄市', districts: ['苓雅', '新興', '旗津'], appealTo: '南高雄分公司' },
    { branches: ['南高雄', '高屏'], city: '高雄市', districts: ['大寮', '林園', '鳳山'], appealTo: '南高雄分公司' },
    { branches: ['高屏', '花蓮一科', '花蓮二科'], city: '臺東縣', districts: 'all', appealTo: '高屏分公司' },
  ];
  const SHARED_CITIES = ['澎湖縣', '金門縣', '連江縣'];
  const DIVISION_OF = {};
  BRANCH_AREAS.forEach((b) => { DIVISION_OF[b.branch] = b.division; });

  /**
   * 依登記地址的縣市、行政區找所屬分公司。
   * 回傳 { kind: 'branch'|'common'|'shared'|'', division, branches, appealTo, label }。
   * 行政區用規範上的寫法比對：帶字尾（龜山區）與不帶字尾（龜山）都認。
   */
  function branchOf(city, district) {
    const c = String(city || '').replace(/^台/, '臺');
    const d = String(district || '');
    const bare = d.replace(/[區鄉鎮市]$/, '');
    const hit = (list) => list === 'all' || list.some((x) => x === d || x === bare || x.replace(/[區鄉鎮市]$/, '') === bare);
    if (!c) return { kind: '', label: '' };
    if (SHARED_CITIES.includes(c)) return { kind: 'shared', label: '全公司共同區域（不屬任一分公司）' };
    for (const cm of COMMON_AREAS) {
      if (cm.city === c && hit(cm.districts)) {
        return { kind: 'common', branches: cm.branches, appealTo: cm.appealTo,
          division: DIVISION_OF[cm.branches[0]] || '',
          label: `${cm.branches.join('、')}分公司共同區（申覆對象：${cm.appealTo}）` };
      }
    }
    for (const b of BRANCH_AREAS) {
      const list = b.areas[c];
      if (list && hit(list)) {
        return { kind: 'branch', branches: [b.branch], division: b.division,
          label: `${b.branch}分公司（${b.division}）` };
      }
    }
    return { kind: '', label: '' };
  }

  /* ---------------- 規則之間怎麼串起來（分析） ---------------- */

  const ANALYSIS = {
    title: '這幾條規則怎麼串起來',
    intro: '這幾條看起來各自獨立，實際上是一套互相咬合的機制：'
      + '「資本額」決定客戶屬誰、「7,000 仟元」決定誰能做、「收益率」決定一般組能不能碰、'
      + '「分享比例」決定業績算誰的。打電話前先跑過這條流程，可以避免案子送到一半才發現該協銷。',
    flow: [
      { step: '1', title: '這個客戶是誰的？', text:
        '依「公司登記地址」劃分行銷區。不是自己的區，或客戶的實質負責人已歸屬其他單位 → 一律協銷，'
        + '並到「業務跨區申覆協銷作業系統」申請、雙方主管簽核。'
        + '例外是符合申覆變更歸屬的兩種狀況（登記地無人辦公、或財務人員／負責人在他區且金融徵信總額度佔比 ≥80%）。' },
      { step: '2', title: '該由一般組還是微企處做？', text:
        '看兩個不同的數字，不要搞混：客戶「資本額」≤ 10,000 仟元 → 屬微企處客戶範疇；'
        + '單戶（含關係人企業）「累計往來總額」≤ 7,000 仟元 → 在微企處的授信上限內。'
        + '前者看客戶規模，後者看往來金額。' },
      { step: '3', title: '一般組想做小案子，代價是收益率', text:
        '一般組承作累計往來 7,000 仟元（含）以下的案件，Spread 必須高於 9%（不含 9%），'
        + '否則應協銷予微企處。換句話說，7,000 仟元以下是微企處的地盤，一般組要碰就得把收益率拉上去。' },
      { step: '4', title: '客戶做大了就要交出去', text:
        '單戶起租金額合計本餘超過 7,000 仟元，微企處應「主動」辦理移交給一般組。'
        + '移交後三個月內必須送件、批覆書三個月有效期內完成起租，且單筆最低起租 10,000 仟元，逾期歸還微企處。' },
      { step: '5', title: '業績怎麼分', text:
        '協銷分享一年、移交分享二年，本金一律依起租單位認列。'
        + '一般組之間：協銷 70/30、移交 60/40。微企處：協銷 70/30、移交視主被動為 50/50 或 60/40，'
        + '且微企處分享的業績額有單戶 16,000 仟元的上限。' },
    ],
    thresholds: {
      title: '門檻速查',
      columns: ['數字', '意義', '出處'],
      rows: [
        ['10,000 仟元', '客戶資本額上限——在這個數字以下才屬微企處客戶範疇', '微企處行銷規範 (一)'],
        ['7,000 仟元', '微企處單戶授信往來總額上限；也是一般組 Spread 管制的分界', '微企處行銷規範 (二)、收益率控管 (一)'],
        ['7,000 仟元', '微企處單戶本餘超過此數 → 應主動移交一般組', '微企處行銷規範 (五)'],
        ['10,000 仟元', '微企移交一般組後的單筆最低起租金額門檻', '微企處行銷規範 (六)'],
        ['16,000 仟元', '微型企業營業處分享業績額的單戶上限', '分享原則 三、(一)'],
        ['9%', '一般組承作 7,000 仟元以下案件的 Spread 下限（不含）', '收益率控管 (一)'],
        ['10%', '被動移交後一般組新案實質收益率下限', '收益率控管 (五)'],
        ['扣減 2%', '被動移交後的另一個標準：微企處最後一筆起租案件實質收益率扣減 2%', '收益率控管 (五)'],
        ['80%', '申覆變更歸屬時，該行銷區金融機構總額度須佔比達此標準', '行銷區域劃分 四、(二)'],
        ['180 天', '申覆後未起租、或本餘結束後，客戶歸屬回原單位的期限', '行銷區域劃分 四、(三)(四)、五、(二)'],
        ['5 個工作日', '微企單位受理移交申請後的回覆期限，逾期視為同意', '微企處行銷規範 (四)'],
        ['3 個月', '微企移交一般組後的送件期限與批覆書有效期', '微企處行銷規範 (六)'],
        ['1 年 / 2 年', '協銷／移交的業績分享期間', '分享原則 一、二'],
      ],
    },
    findings: [
      { level: 'key', title: '主動移交對微企處明顯有利，值得留意',
        text: '主動移交：業績第一筆 50%、其後 40%，得至少辦理二次分享，且不受二年期限；'
          + '移交後一般組承作新案的收益率不設限。被動移交：業績固定 40%、受二年期限，'
          + '且一般組承作新案的實質收益率被綁在 10% 或「微企處最後一筆扣減 2%」。'
          + '同樣是把客戶交出去，主動與被動的差別在分享次數、期限與對承接方的限制。' },
      { level: 'key', title: '7,000 與 10,000 之間有一段空隙',
        text: '微企處本餘超過 7,000 仟元就要移交一般組，但一般組承接後「單筆最低起租 10,000 仟元」。'
          + '若客戶的需求金額落在 7,000～10,000 仟元之間，移交過去可能做不起來，三個月後又退回微企處。'
          + '實務上這段區間的案子要先想清楚怎麼處理。' },
      { level: 'warn', title: '淨收益比例在微企移交的表格裡不一致',
        text: '「客戶移交」表中起租單位的淨收益寫「50% 或 60%（視主被動移交而定）」，'
          + '但微企處那一列不論主動或被動，淨收益都寫「40%（同傳統業績比例）」。'
          + '若微企處固定 40%，起租單位應固定 60%，與「50% 或 60%」矛盾。'
          + '合理的讀法是「同傳統業績比例」意指淨收益比照業績比例（主動第一筆 50%、其餘 40%），'
          + '試算工具即依此計算，但送件前建議向行銷管理科確認。' },
      { level: 'warn', title: 'Spread 9% 是「不得低於 9%（不含）」',
        text: '條文寫「不得低於 9%（不含）」，也就是剛好 9% 並不符合，必須高於 9%。'
          + '檢核工具依此認定，等於 9% 會被判定為應協銷予微企處。' },
      { level: 'note', title: '授信額度可以扣掉三種本金餘額',
        text: '計算單戶 7,000 仟元上限時，可排除「供行部新購設備案件」、「存貨擔保融資」、'
          + '「不動產融資專案處」三種本金餘額。判斷客戶是否超限時記得先扣，不要用毛額直接判斷。' },
      { level: 'note', title: '關係人企業與實質負責人都會牽動歸屬',
        text: '授信額度上限是以「單戶含關係人企業」計算；微企單位內若關企是其他單位舊戶要先申覆，'
          + '但若屬同一實質負責人則只能協銷。一般組這邊，客戶的實質負責人已歸屬其他單位也一律協銷。'
          + '所以打電話前值得先查一下客戶的關係企業。' },
      { level: 'note', title: '逾期視為同意，是微企處要注意的地方',
        text: '一般組申請移交微企處客戶時，微企單位五個工作日內沒回覆就「視為同意辦理移交」。'
          + '這是少數會因為不作為而喪失權利的條款。' },
    ],
  };

  global.Rules = {
    RULES, ANALYSIS, evaluate, assessControl, buildCheckpoints, parseSchedule, fmt,
    shareSplit, routeCustomer, SHARE_SCENARIOS, branchOf, BRANCH_AREAS, COMMON_AREAS,
    EXCLUDING, CONTROLLED_COLLATERAL, IRREGULAR_METHODS,
    MICRO_CAPITAL_LIMIT, LARGE_CAPITAL_LIMIT, MICRO_CREDIT_LIMIT, MICRO_SHARE_CAP, MICRO_MIN_SPREAD,
  };

  /* ---------------- 畫面 ---------------- */

  const el = (tag, props, children) => {
    const node = Object.assign(document.createElement(tag), props || {});
    (children || []).forEach((c) => c && node.append(c));
    return node;
  };

  const field = (label, control, hint) => el('label', { className: 'rule-field' }, [
    el('span', { textContent: label }),
    control,
    hint ? el('small', { textContent: hint }) : null,
  ]);

  const select = (options, value) => {
    const node = el('select');
    options.forEach((opt) => {
      const [val, label] = Array.isArray(opt) ? opt : [opt, opt];
      node.append(el('option', { value: String(val), textContent: label }));
    });
    if (value !== undefined) node.value = String(value);
    return node;
  };

  const num = (input) => Number(String(input.value).replace(/[^\d.-]/g, '')) || 0;

  function table(columns, rows, opts) {
    const node = el('table', { className: `rule-table ${(opts && opts.className) || ''}` });
    node.append(el('thead', {}, [el('tr', {}, columns.map((c) => el('th', { textContent: c })))]));
    node.append(el('tbody', {}, rows.map((r) => el('tr', {}, r.map((cell, i) => el(
      i === 0 ? 'th' : 'td', { textContent: String(cell), scope: i === 0 ? 'row' : undefined }
    ))))));
    return node;
  }

  /* ---------------- 工具一：償還本金檢核（既有） ---------------- */

  const COLLATERAL_OPTIONS = ['純信用（無擔保品）', ...EXCLUDING, ...CONTROLLED_COLLATERAL];
  const METHOD_OPTIONS = ['本息平均攤還', '本金平均攤還', ...IRREGULAR_METHODS];
  const FREQ_OPTIONS = [[1, '月繳'], [3, '季繳'], [6, '半年繳'], [12, '年繳']];

  function principalChecker() {
    const box = el('div', { className: 'rule-checker' }, [el('h3', { textContent: '案件檢核' })]);
    const form = el('div', { className: 'rule-form' });

    const principal = el('input', { type: 'text', inputMode: 'numeric', placeholder: '例如 5,000,000' });
    const months = el('input', { type: 'number', min: '1', placeholder: '例如 60' });
    const method = select(METHOD_OPTIONS, '頭小尾大');
    const freq = select(FREQ_OPTIONS, 1);

    const collateralBox = el('div', { className: 'chips' });
    const chosen = new Set(['純信用（無擔保品）']);
    COLLATERAL_OPTIONS.forEach((name) => {
      const chip = el('button', { className: 'chip', type: 'button', textContent: name });
      chip.setAttribute('aria-pressed', chosen.has(name) ? 'true' : 'false');
      chip.onclick = () => {
        if (name === '純信用（無擔保品）') { chosen.clear(); chosen.add(name); }
        else {
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
      placeholder: '每期償還本金，一行一期（也可以用逗號或空白分隔）',
    });
    const fillEven = el('button', { className: 'btn btn-tiny', type: 'button', textContent: '填入平均攤還' });
    fillEven.onclick = () => {
      const total = num(principal);
      const count = Math.floor((Number(months.value) || 0) / (Number(freq.value) || 1));
      if (!total || !count) return;
      schedule.value = Array(count).fill(Math.round(total / count)).join('\n');
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
      el('span', { textContent: '還款計畫' }), schedule,
      el('div', { className: 'card-actions' }, [fillEven]),
    ]));

    const result = el('div', { className: 'rule-result' });
    box.append(result);

    function run() {
      const input = {
        principal: num(principal),
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
      out.notes.forEach((n) => result.append(el('p', { className: 'rule-note', textContent: `※ ${n}` })));
      if (!out.control.controlled) return;
      if (!input.principal || !input.months) {
        result.append(el('p', { className: 'muted', textContent: '填入起租本金與承作期間後即可檢核各期。' }));
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
      const LABEL = { pass: '通過', short: '不足', waived: '免檢核（餘額≤10%）' };
      const node = table(['檢核點', '應累計償還', '實際累計償還', '本金餘額', '結果'],
        out.checkpoints.map((c) => [`第 ${c.month} 個月`, fmt(c.required), fmt(c.actual), fmt(c.balance),
          c.status === 'short' ? `不足 ${fmt(c.shortfall)}` : LABEL[c.status]]));
      [...node.querySelectorAll('tbody tr')].forEach((tr, i) => {
        tr.className = `row-${out.checkpoints[i].status}`;
      });
      result.append(node);
    }

    [principal, months, schedule].forEach((i) => { i.oninput = run; });
    [method, freq].forEach((i) => { i.onchange = run; });
    run();
    return box;
  }

  /* ---------------- 工具二：業績與淨收益分享試算 ---------------- */

  function shareCalculator() {
    const box = el('div', { className: 'rule-checker' }, [el('h3', { textContent: '分享比例試算' })]);
    const scenario = select(Object.entries(SHARE_SCENARIOS).map(([k, v]) => [k, v.label]), 'general-cross');
    const amount = el('input', { type: 'text', inputMode: 'numeric', placeholder: '例如 5,000' });
    const profit = el('input', { type: 'text', inputMode: 'numeric', placeholder: '例如 600' });

    box.append(el('div', { className: 'rule-form' }, [
      field('情境', scenario),
      field('LF 受讓金額（仟元）', amount),
      field('LF 毛利（仟元）', profit, '淨收益分享的計算基礎'),
    ]));
    const result = el('div', { className: 'rule-result' });
    box.append(result);

    function run() {
      const out = shareSplit({ scenario: scenario.value, amount: num(amount), profit: num(profit) });
      result.textContent = '';
      if (!out) return;
      result.append(el('p', { className: 'rule-verdict is-ok' }, [
        el('strong', { textContent: out.spec.label }),
        document.createTextNode(`　分享期間：${out.spec.period}`),
      ]));
      if (out.spec.note) result.append(el('p', { className: 'rule-note', textContent: `※ ${out.spec.note}` }));
      if (out.capped) {
        result.append(el('p', { className: 'rule-note',
          textContent: `※ 依比例應分享 ${fmt(out.rawPartnerAmount)} 仟元，超過單戶上限 `
            + `${fmt(MICRO_SHARE_CAP)} 仟元，已以上限計算。` }));
      }
      result.append(table(['單　位', '業績比例', '業績（仟元）', '淨收益比例', '淨收益（仟元）'], [
        ['起租單位', `${Math.round(out.originRatio * 100)}%`, fmt(out.originAmount),
          `${Math.round(out.originRatio * 100)}%`, fmt(out.originProfit)],
        [out.spec.partnerLabel, `${Math.round(out.partnerRatio * 100)}%`, fmt(out.partnerAmount),
          `${Math.round(out.partnerRatio * 100)}%`, fmt(out.partnerProfit)],
      ]));
      result.append(el('p', { className: 'muted',
        textContent: '本金依起租單位認列。淨收益依「同傳統業績比例」比照業績比例計算，'
          + '與表格中「50% 或 60%」的寫法一致；送件前建議向行銷管理科確認。' }));
    }

    scenario.onchange = run;
    [amount, profit].forEach((i) => { i.oninput = run; });
    run();
    return box;
  }

  /* ---------------- 工具三：承作單位與協銷／移交判定 ---------------- */

  function unitRouter() {
    const box = el('div', { className: 'rule-checker' }, [el('h3', { textContent: '承作單位與協銷／移交判定' })]);
    const capital = el('input', { type: 'text', inputMode: 'numeric', placeholder: '例如 5,000' });
    const exposure = el('input', { type: 'text', inputMode: 'numeric', placeholder: '例如 6,000' });
    const spread = el('input', { type: 'text', inputMode: 'decimal', placeholder: '例如 9.5' });
    const currentUnit = select(['新戶', '一般組', '微企處'], '新戶');
    const handoverType = select(['不適用', '主動移交', '被動移交'], '不適用');
    const sameRegion = select([['true', '是'], ['false', '否']], 'true');
    const ownerElsewhere = select([['false', '否'], ['true', '是']], 'false');
    const counterpart = select([['false', '否'], ['true', '是']], 'false');

    box.append(el('div', { className: 'rule-form' }, [
      field('客戶資本額（仟元）', capital),
      field('單戶累計往來總額（仟元）', exposure, '含關係人企業與本次核准額度'),
      field('本案 Spread（%）', spread),
      field('目前歸屬', currentUnit),
      field('登記地址在本行銷區', sameRegion),
      field('實質負責人已歸屬他單位', ownerElsewhere),
      field('申戶或關企為另一方舊戶', counterpart),
      field('移交方式', handoverType),
    ]));
    const result = el('div', { className: 'rule-result' });
    box.append(result);

    function run() {
      const notes = routeCustomer({
        capital: num(capital),
        exposure: num(exposure),
        spread: spread.value.trim() === '' ? '' : num(spread),
        currentUnit: currentUnit.value,
        sameRegion: sameRegion.value === 'true',
        ownerElsewhere: ownerElsewhere.value === 'true',
        counterpartOldCustomer: counterpart.value === 'true',
        handoverType: handoverType.value === '不適用' ? '' : handoverType.value,
      });
      result.textContent = '';
      const CLS = { ok: 'is-ok', warn: 'is-warn', block: 'is-fail' };
      notes.forEach((n) => result.append(el('p', { className: `rule-verdict ${CLS[n.level]}`, textContent: n.text })));
    }

    [capital, exposure, spread].forEach((i) => { i.oninput = run; });
    [currentUnit, handoverType, sameRegion, ownerElsewhere, counterpart].forEach((i) => { i.onchange = run; });
    run();
    return box;
  }

  const TOOLS = {
    'principal-checker': principalChecker,
    'share-calculator': shareCalculator,
    'unit-router': unitRouter,
  };

  /* ---------------- 規則頁 ---------------- */

  function renderSection(section) {
    if (section.type === 'note') return el('p', { className: 'rule-note-plain', textContent: section.text });
    if (section.type === 'table') {
      const wrap = el('div', { className: 'rule-article' }, [
        section.heading ? el('h3', { textContent: section.heading }) : null,
        table(section.columns, section.rows, { className: 'rule-table-share' }),
        section.note ? el('p', { className: 'muted', textContent: section.note }) : null,
      ]);
      return wrap;
    }
    if (section.type === 'list' || section.type === 'ordered') {
      const list = el(section.type === 'ordered' ? 'ol' : 'ul');
      section.items.forEach((t) => list.append(el('li', { textContent: t })));
      return el('div', { className: `rule-article${section.highlight ? ' rule-clarify' : ''}` }, [
        section.heading ? el('h3', { textContent: section.heading }) : null,
        list,
        section.note ? el('p', { className: 'muted', textContent: section.note }) : null,
      ]);
    }
    return el('div', { className: 'rule-article' }, [
      section.heading ? el('h3', { textContent: section.heading }) : null,
      el('p', { textContent: section.text }),
    ]);
  }

  function renderAnalysis() {
    const card = el('article', { className: 'rule-card rule-analysis' }, [
      el('h2', { textContent: ANALYSIS.title }),
      el('p', { className: 'rule-summary', textContent: ANALYSIS.intro }),
    ]);

    const flow = el('ol', { className: 'rule-flow' });
    ANALYSIS.flow.forEach((s) => flow.append(el('li', {}, [
      el('strong', { textContent: s.title }),
      el('p', { textContent: s.text }),
    ])));
    card.append(flow);

    card.append(el('h3', { className: 'rule-subhead', textContent: ANALYSIS.thresholds.title }));
    card.append(el('div', { className: 'rule-defer' }, [
      table(ANALYSIS.thresholds.columns, ANALYSIS.thresholds.rows, { className: 'rule-table-thresholds' }),
    ]));

    card.append(el('h3', { className: 'rule-subhead', textContent: '重點與需要確認的地方' }));
    ANALYSIS.findings.forEach((f) => card.append(el('div', { className: `rule-finding level-${f.level}` }, [
      el('strong', { textContent: f.title }),
      el('p', { textContent: f.text }),
    ])));
    return card;
  }

  /**
   * 三個工具加起來有幾十個表單元件，一次全部建好會讓第一次打開規則頁停頓。
   * 改成捲到附近才建——反正要用工具本來就得先捲下去。
   */
  function lazyTool(card, build) {
    const holder = el('div', { className: 'rule-tool-holder' });
    card.append(holder);
    let done = false;
    const make = () => {
      if (done) return;
      done = true;
      holder.classList.add('is-ready');
      holder.append(build());
    };
    if (typeof IntersectionObserver !== 'function') { make(); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { make(); io.disconnect(); }
    }, { rootMargin: '400px' });
    io.observe(holder);
  }

  function render(host) {
    host.textContent = '';
    host.append(renderAnalysis());
    RULES.forEach((rule) => {
      const card = el('article', { className: 'rule-card' }, [
        el('h2', { textContent: rule.title }),
        rule.source ? el('p', { className: 'rule-source', textContent: rule.source }) : null,
        el('p', { className: 'rule-summary', textContent: rule.summary }),
      ]);
      rule.sections.forEach((section) => card.append(renderSection(section)));
      if (rule.tool && TOOLS[rule.tool]) lazyTool(card, TOOLS[rule.tool]);
      host.append(card);
    });
  }

  global.Rules.render = render;
})(window);
