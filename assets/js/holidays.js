/*
 * 台灣的行事曆：哪幾天不上班。
 *
 * 「三天後回電」如果剛好落在連假，那通電話就等於沒排到——人家公司沒人，業務自己
 * 也在放假。所以排下次聯絡日、設回撥提醒的時候要自動跳過假日。
 *
 * 資料是政府行政機關辦公日曆表（人事行政總處每年公告）的整理版，只留兩種特例：
 *   off  = 平日放假（國定假日、補假、連假中間的彈性放假）
 *   work = 週末補班（為了連假調移的上班日，那天要上班）
 * 週六日本來就不上班，不用一天一天列，省掉九成的資料量。
 *
 * 每年年底人事行政總處公告隔年行事曆時要補一年進來。沒有資料的年份不猜，只避開
 * 週末，畫面上也會講明「那一年的行事曆還沒更新」，不要讓使用者以為網站幫他避開
 * 了國定假日。
 */
(function (global) {
  'use strict';

  const DATA = {
    2025: {
      off: {
        '2025-01-01': '開國紀念日',
        '2025-01-27': '小年夜',
        '2025-01-28': '農曆除夕',
        '2025-01-29': '春節',
        '2025-01-30': '春節',
        '2025-01-31': '春節',
        '2025-02-28': '和平紀念日',
        '2025-04-03': '補假',
        '2025-04-04': '兒童節及民族掃墓節',
        '2025-05-30': '補假',
        '2025-09-29': '補假',
        '2025-10-06': '中秋節',
        '2025-10-10': '國慶日',
        '2025-10-24': '補假',
        '2025-12-25': '行憲紀念日',
      },
      work: ['2025-02-08'],
    },
    2026: {
      off: {
        '2026-01-01': '開國紀念日',
        '2026-02-16': '農曆除夕',
        '2026-02-17': '春節',
        '2026-02-18': '春節',
        '2026-02-19': '春節',
        '2026-02-20': '補假',
        '2026-02-27': '補假',
        '2026-04-03': '補假',
        '2026-04-06': '補假',
        '2026-05-01': '勞動節',
        '2026-06-19': '端午節',
        '2026-09-25': '中秋節',
        '2026-09-28': '孔子誕辰紀念日/教師節',
        '2026-10-09': '補假',
        '2026-10-26': '補假',
        '2026-12-25': '行憲紀念日',
      },
      work: [],
    },
    2027: {
      off: {
        '2027-01-01': '開國紀念日',
        '2027-02-04': '小年夜',
        '2027-02-05': '農曆除夕',
        '2027-02-08': '春節',
        '2027-02-09': '補假',
        '2027-02-10': '補假',
        '2027-03-01': '補假',
        '2027-04-05': '清明節',
        '2027-04-06': '補假',
        '2027-04-30': '補假',
        '2027-06-09': '端午節',
        '2027-09-15': '中秋節',
        '2027-09-28': '孔子誕辰紀念日/教師節',
        '2027-10-11': '補假',
        '2027-10-25': '臺灣光復暨金門古寧頭大捷紀念日',
        '2027-12-24': '補假',
        '2027-12-31': '補假',
      },
      work: [],
    },
  };

  const YEARS = Object.keys(DATA).map(Number);
  const MIN_YEAR = Math.min.apply(null, YEARS);
  const MAX_YEAR = Math.max.apply(null, YEARS);

  const yearOf = (iso) => Number(String(iso || '').slice(0, 4));
  /** 這個日期的年份有沒有行事曆資料；沒有的話只能避開週末。 */
  const covered = (iso) => { const y = yearOf(iso); return y >= MIN_YEAR && y <= MAX_YEAR; };

  const WEEK_LABEL = ['日', '一', '二', '三', '四', '五', '六'];
  const dayOfWeek = (iso) => new Date(`${iso}T00:00:00`).getDay();   // 0=日 6=六

  /** 這天放假就回傳名稱（週末回「週六」「週日」），要上班回空字串。 */
  function holidayName(iso) {
    if (!iso) return '';
    const y = DATA[yearOf(iso)];
    if (y && y.work.indexOf(iso) >= 0) return '';      // 補班日：週末也要上班
    if (y && y.off[iso]) return y.off[iso];
    const d = dayOfWeek(iso);
    return (d === 0 || d === 6) ? `週${WEEK_LABEL[d]}` : '';
  }

  const isWorkday = (iso) => !holidayName(iso);
  const weekLabel = (iso) => WEEK_LABEL[dayOfWeek(iso)];

  const addDays = (iso, n) => {
    const d = new Date(`${iso}T00:00:00`);
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  /**
   * 往後找到第一個上班日；已經是上班日就原樣回傳。
   * 一天一天往後找，所以整串連假都會跳過，不是只加一天。
   * @param {string} iso yyyy-mm-dd
   * @returns {{iso:string, moved:boolean, from:string, reason:string, covered:boolean}}
   */
  function nextWorkday(iso) {
    const from = String(iso || '');
    const reason = holidayName(from);
    let out = from;
    // 14 天足夠跨過最長的連假（春節九天）；跑不完就是資料怪了，不要無限迴圈
    for (let i = 0; i < 14 && holidayName(out); i++) out = addDays(out, 1);
    return { iso: out, moved: out !== from, from, reason, covered: covered(from) };
  }

  global.Holidays = { holidayName, isWorkday, weekLabel, nextWorkday, covered, addDays, MIN_YEAR, MAX_YEAR, DATA };
})(window);
