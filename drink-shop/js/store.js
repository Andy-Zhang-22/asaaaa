/*
 * 存取瀏覽器的 localStorage：菜單（老闆改過的）、訂單、設定。
 * 全部只存在這台裝置的瀏覽器裡，不會上傳任何地方；要換裝置就用「備份／還原」。
 */
(function (global) {
  'use strict';

  const KEY = {
    menu: 'drinkshop.menu',
    orders: 'drinkshop.orders',
    seq: 'drinkshop.seq', // { date: 'YYYY-MM-DD', n: 12 } 每天從 1 號重新編
  };

  function read(key, fallback) {
    try {
      const raw = global.localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }
  function write(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 私密模式或滿了 */ }
  }

  /** 本地日期 YYYY-MM-DD（不用 toISOString，那是 UTC，晚上會跳到隔天） */
  function dateKey(d) {
    const x = d ? new Date(d) : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  }

  const store = {
    dateKey,

    // ---- 菜單 ----
    loadMenu() {
      const saved = read(KEY.menu, null);
      return saved && Array.isArray(saved.categories) ? saved : global.DrinkMenu.defaults();
    },
    saveMenu(menu) { write(KEY.menu, menu); },
    resetMenu() {
      try { global.localStorage.removeItem(KEY.menu); } catch (e) { /* ignore */ }
      return global.DrinkMenu.defaults();
    },

    // ---- 訂單 ----
    loadOrders() { return read(KEY.orders, []); },
    saveOrders(orders) { write(KEY.orders, orders); },
    /** 今天的下一個單號 */
    nextOrderNo() {
      const today = dateKey();
      const seq = read(KEY.seq, { date: '', n: 0 });
      const n = seq.date === today ? seq.n + 1 : 1;
      write(KEY.seq, { date: today, n });
      return n;
    },
    addOrder(order) {
      const orders = store.loadOrders();
      orders.push(order);
      store.saveOrders(orders);
      return order;
    },
    updateOrder(id, patch) {
      const orders = store.loadOrders();
      const idx = orders.findIndex((o) => o.id === id);
      if (idx < 0) return null;
      orders[idx] = Object.assign({}, orders[idx], patch);
      store.saveOrders(orders);
      return orders[idx];
    },

    // ---- 備份 ----
    exportAll() {
      return { app: 'drink-shop', exportedAt: new Date().toISOString(), menu: store.loadMenu(), orders: store.loadOrders(), seq: read(KEY.seq, null) };
    },
    importAll(data) {
      if (!data || data.app !== 'drink-shop') throw new Error('這不是飲料店系統的備份檔');
      if (data.menu) write(KEY.menu, data.menu);
      if (Array.isArray(data.orders)) {
        // 合併：同 id 的不重複
        const have = new Map(store.loadOrders().map((o) => [o.id, o]));
        data.orders.forEach((o) => { if (o && o.id) have.set(o.id, o); });
        const merged = [...have.values()].sort((a, b) => (a.time < b.time ? -1 : 1));
        store.saveOrders(merged);
      }
      if (data.seq) {
        const cur = read(KEY.seq, { date: '', n: 0 });
        if (data.seq.date === cur.date && data.seq.n > cur.n) write(KEY.seq, data.seq);
        else if (data.seq.date > cur.date) write(KEY.seq, data.seq);
      }
    },
    clearOrders() { write(KEY.orders, []); },
  };

  global.DrinkStore = store;
})(typeof window !== 'undefined' ? window : globalThis);
