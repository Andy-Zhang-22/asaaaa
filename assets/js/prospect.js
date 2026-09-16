/*
 * 延伸名單：從已經跟中租往來過的客戶，長出可以打的新線索。
 *
 * 為什麼線索要從自己的名單長出來，而不是去外面撈：
 *
 * 業務要的是「可以立刻撥的電話」。政府的商工登記沒有電話欄位，104 那類來源
 * 這邊也連不上。但使用者手上這 800 多筆，電話本來就在裡面——只是從來沒有人
 * 把「這家跟中租有往來」跟「那家還沒接觸」之間的關係連起來。
 *
 * 三種延伸方式，強度由高到低：
 *
 *   1. 同一位負責人的其他公司。中小企業老闆名下有兩三家公司是常態，其中一家
 *      已經在跟中租做，另一家就是最熱的線索——人已經認識你們了。
 *   2. 同產業同區域。已經成交的產業＋區域組合代表這個打法有效，同一格子裡
 *      還沒接觸的就值得排前面。
 *   3. 訪談內容裡提到、但名單上沒有的公司。這類沒有電話，要另外查，所以排最後。
 *
 * 前兩類的公司本來就在名單裡，電話、地址、分級全都是現成的。
 */
(function (global) {
  'use strict';

  const clean = (v) => String(v || '').replace(/\s+/g, '').trim();

  /** 這筆是不是「跟中租往來過」。判斷寬鬆一點：任一個訊號成立就算。 */
  function isSeed(r) {
    if (r.relations && r.relations.internal && r.relations.internal.length) return true;
    return r.dealingKind === 'active';
  }

  /** 可以打嗎：有號碼、沒有被標成禁止推廣。 */
  function callable(r) {
    return !r.blocked && r.phones && r.phones.length > 0;
  }

  /*
   * 排序分數。
   * 優先區域是使用者自己定的首要目標，權重給最高；其次是分級與資本額落在
   * 微企處範疇（那是他實際承作的甜蜜點）。分數只用來排序，不隱藏任何東西。
   */
  function score(r, reasonKind) {
    let n = 0;
    if (reasonKind === 'owner') n += 50;          // 同一位老闆最熱
    if (reasonKind === 'cluster') n += 20;
    if (r.territory === '優先區域') n += 30;
    else if (r.territory === '服務範圍') n += 10;
    if (r.grade === 'A') n += 15;
    else if (r.grade === 'B') n += 8;
    if (r.scale === '微企範疇') n += 10;
    if (r.outcome === 'new') n += 12;              // 從沒打過的優先
    return n;
  }

  /**
   * @param {Array} views 全部客戶（已經套過編輯的 view 物件）
   * @returns {{seeds:Array, owner:Array, cluster:Array, mentioned:Array, stats:object}}
   */
  function build(views) {
    const seeds = views.filter(isSeed);
    const seedIds = new Set(seeds.map((r) => r.id));

    // ---- 1. 同一位負責人的其他公司 ----
    const ownerIndex = new Map();
    views.forEach((r) => {
      [r.owner, r.keyman].forEach((who) => {
        const key = clean(who);
        // 一兩個字的多半是「陳先生」這種代稱，當成同一人會誤判
        if (key.length < 2 || key.length > 8) return;
        if (!ownerIndex.has(key)) ownerIndex.set(key, []);
        ownerIndex.get(key).push(r);
      });
    });

    const owner = [];
    const seenOwner = new Set();
    seeds.forEach((seed) => {
      [seed.owner, seed.keyman].forEach((who) => {
        const key = clean(who);
        if (key.length < 2 || key.length > 8) return;
        (ownerIndex.get(key) || []).forEach((r) => {
          if (r.id === seed.id || seedIds.has(r.id) || seenOwner.has(r.id)) return;
          if (!callable(r)) return;
          seenOwner.add(r.id);
          owner.push({ r, kind: 'owner', via: seed,
            why: `負責人「${key}」名下的另一家公司，${seed.company} 已經在跟中租往來` });
        });
      });
    });

    // ---- 2. 同產業同區域 ----
    const cellOf = (r) => `${clean(r.industry)}|${clean(r.city)}${clean(r.district)}`;
    const hotCells = new Map();
    seeds.forEach((r) => {
      if (!clean(r.industry) || !clean(r.city)) return;
      const cell = cellOf(r);
      if (!hotCells.has(cell)) hotCells.set(cell, []);
      hotCells.get(cell).push(r);
    });

    const cluster = [];
    views.forEach((r) => {
      if (seedIds.has(r.id) || seenOwner.has(r.id)) return;
      if (!callable(r)) return;
      if (r.dealingKind === 'active') return;     // 已經有人在做了
      if (!clean(r.industry) || !clean(r.city)) return;
      const peers = hotCells.get(cellOf(r));
      if (!peers || !peers.length) return;
      cluster.push({ r, kind: 'cluster', via: peers[0],
        why: `${clean(r.city)}${clean(r.district)}的${clean(r.industry)}，同區同業的 ${peers[0].company} 已經在往來`
          + (peers.length > 1 ? `（共 ${peers.length} 家）` : '') });
    });

    // ---- 3. 訪談內容裡提到、名單上沒有的公司 ----
    const known = new Set();
    views.forEach((r) => {
      known.add(clean(r.company));
      (r.aliases || []).forEach((a) => known.add(clean(a)));
    });
    const mentionedMap = new Map();
    const NAME_IN_TEXT = /[一-龥A-Za-z0-9]{2,12}(?:股份有限公司|有限公司|企業社|工程行|實業社|商行|營造廠)/g;
    seeds.forEach((seed) => {
      const text = String(seed.notesRaw || '');
      let m;
      NAME_IN_TEXT.lastIndex = 0;
      while ((m = NAME_IN_TEXT.exec(text)) !== null) {
        const name = clean(m[0]);
        if (known.has(name) || mentionedMap.has(name)) continue;
        mentionedMap.set(name, { name, via: seed });
      }
    });
    const mentioned = [...mentionedMap.values()];

    const rank = (list) => list
      .map((x) => ({ ...x, score: score(x.r, x.kind) }))
      .sort((a, b) => b.score - a.score);

    return {
      seeds,
      owner: rank(owner),
      cluster: rank(cluster),
      mentioned,
      stats: {
        total: views.length,
        seeds: seeds.length,
        owner: owner.length,
        cluster: cluster.length,
        mentioned: mentioned.length,
      },
    };
  }

  global.Prospect = { build, isSeed, callable, score };
})(window);
