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

  const MICRO_CAPITAL_LIMIT = 10000;    // 微企客戶資本額上限（仟元）
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
    const isMicroScale = capital > 0 && capital <= MICRO_CAPITAL_LIMIT;
    if (capital > 0) {
      push(isMicroScale ? 'ok' : 'warn', isMicroScale
        ? `資本額 ${fmt(capital)} 仟元 ≤ ${fmt(MICRO_CAPITAL_LIMIT)} 仟元，屬【微型企業營業處】客戶範疇（不受行業別限制）。`
        : `資本額 ${fmt(capital)} 仟元 超過 ${fmt(MICRO_CAPITAL_LIMIT)} 仟元，不屬微企處客戶範疇。`);
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
  }];

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
    shareSplit, routeCustomer, SHARE_SCENARIOS,
    EXCLUDING, CONTROLLED_COLLATERAL, IRREGULAR_METHODS,
    MICRO_CAPITAL_LIMIT, MICRO_CREDIT_LIMIT, MICRO_SHARE_CAP, MICRO_MIN_SPREAD,
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
