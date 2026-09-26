/*
 * 計價：一杯多少錢、一張單多少錢、買5送1 怎麼折。
 *
 * 純函式，不碰畫面也不碰 localStorage，所以 Node 測試可以直接跑。
 *
 * 一條 line（購物車裡的一列）長這樣：
 *   { itemId, name, size: 'L'|'XL', sugar, ice, toppings: ['boba', ...], qty, note }
 * 單價 = 該尺寸價格 + 加料合計。
 *
 * 買5送1：每滿 (buy+free) 杯送 free 杯，送的是最便宜的（以茶本身的價格算，加料照收）。
 */
(function (global) {
  'use strict';

  function findItem(menu, itemId) {
    for (const cat of menu.categories) {
      const it = cat.items.find((i) => i.id === itemId);
      if (it) return { item: it, category: cat };
    }
    return null;
  }

  function toppingPrice(menu, toppingIds) {
    const ids = toppingIds || [];
    return ids.reduce((sum, id) => {
      const t = menu.toppings.find((x) => x.id === id);
      return sum + (t ? Number(t.price) || 0 : 0);
    }, 0);
  }

  /** 茶本身的價格（不含加料）。找不到品項或該尺寸沒賣 → null */
  function basePrice(menu, itemId, size) {
    const found = findItem(menu, itemId);
    if (!found) return null;
    const p = found.item.price[size];
    return (p == null || p === '') ? null : Number(p);
  }

  /** 一杯的單價（含加料） */
  function unitPrice(menu, line) {
    const base = basePrice(menu, line.itemId, line.size);
    if (base == null) return null;
    return base + toppingPrice(menu, line.toppings);
  }

  /**
   * 整張單的金額。
   * @returns {{ cups, subtotal, discount, freeCups, total, lines: [{...line, unit, base, amount}] }}
   */
  function summarize(menu, lines, opts) {
    const promo = Object.assign({ enabled: true, buy: 5, free: 1 }, menu.promo || {}, opts || {});
    const priced = lines.map((line) => {
      const base = basePrice(menu, line.itemId, line.size) || 0;
      const unit = base + toppingPrice(menu, line.toppings);
      const qty = Math.max(0, Number(line.qty) || 0);
      return Object.assign({}, line, { base, unit, qty, amount: unit * qty });
    });
    const cups = priced.reduce((n, l) => n + l.qty, 0);
    const subtotal = priced.reduce((n, l) => n + l.amount, 0);

    let freeCups = 0;
    let discount = 0;
    const group = (Number(promo.buy) || 0) + (Number(promo.free) || 0);
    if (promo.enabled && group > 0 && Number(promo.free) > 0) {
      freeCups = Math.floor(cups / group) * Number(promo.free);
      // 把每一杯攤開、依茶價由低到高排，最便宜的 freeCups 杯免費
      const eachCup = [];
      priced.forEach((l) => { for (let i = 0; i < l.qty; i++) eachCup.push(l.base); });
      eachCup.sort((a, b) => a - b);
      discount = eachCup.slice(0, freeCups).reduce((n, p) => n + p, 0);
    }
    return { cups, subtotal, discount, freeCups, total: subtotal - discount, lines: priced };
  }

  /** 把一杯的規格印成一行字，給製作單／訂單列表用 */
  function describeLine(menu, line) {
    const parts = [];
    const found = findItem(menu, line.itemId);
    const hot = found && found.category.hot;
    if (line.size) parts.push(line.size);
    if (line.sugar) parts.push(line.sugar);
    if (!hot && line.ice) parts.push(line.ice);
    if (hot) parts.push('熱');
    (line.toppings || []).forEach((id) => {
      const t = menu.toppings.find((x) => x.id === id);
      parts.push('+' + (t ? t.name : id));
    });
    if (line.note) parts.push('備註：' + line.note);
    return parts.join(' / ');
  }

  global.DrinkPricing = { findItem, toppingPrice, basePrice, unitPrice, summarize, describeLine };
})(typeof window !== 'undefined' ? window : globalThis);
