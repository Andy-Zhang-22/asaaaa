/*
 * 飲料店點餐系統的畫面程式。
 *
 * 四個分頁：點餐（選品項 → 選規格 → 這一單 → 結帳 → 製作單）、訂單（今天賣了哪些、作廢、補印）、
 * 報表（營業額、杯數、賣最好的、時段）、菜單設定（改價、售完、加料、活動、備份）。
 * 計價全在 pricing.js，這裡只管畫面與存取。
 */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const el = (tag, attrs, ...children) => {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    children.flat().forEach((c) => { if (c != null) node.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return node;
  };
  const money = (n) => '$' + Number(n || 0).toLocaleString('zh-TW');
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  let toastTimer = null;
  function toast(msg) {
    let t = $('.toast');
    if (!t) { t = el('div', { class: 'toast' }); document.body.append(t); }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
  }

  const Menu = window.DrinkMenu;
  const Pricing = window.DrinkPricing;
  const Store = window.DrinkStore;

  const state = {
    menu: Store.loadMenu(),
    cart: [],
    cat: null,
    reportRange: 'today',
  };

  // ============ 分頁 ============
  function showTab(name) {
    $$('.tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    ['pos', 'orders', 'report', 'menu'].forEach((t) => { $('#tab-' + t).hidden = t !== name; });
    if (name === 'orders') renderOrders();
    if (name === 'report') renderReport();
    if (name === 'menu') renderMenuEditor();
    window.scrollTo(0, 0);
  }
  $$('.tabs [role="tab"]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ============ 點餐：系列與品項 ============
  function renderCats() {
    const cats = state.menu.categories;
    if (!cats.some((c) => c.id === state.cat)) state.cat = cats[0] ? cats[0].id : null;
    const wrap = $('#cats');
    wrap.replaceChildren(...cats.map((c) => el('button', {
      type: 'button', 'aria-selected': String(c.id === state.cat), text: c.name,
      onclick: () => { state.cat = c.id; renderCats(); renderItems(); },
    })));
    $('#shopName').textContent = state.menu.shopName || '飲料店';
    document.title = `${state.menu.shopName || '飲料店'} 點餐系統`;
  }

  function renderItems() {
    const cat = state.menu.categories.find((c) => c.id === state.cat);
    const wrap = $('#items');
    if (!cat) { wrap.replaceChildren(el('p', { class: 'muted', text: '還沒有品項，到「菜單設定」新增。' })); return; }
    wrap.replaceChildren(...cat.items.map((it) => {
      const tags = [...(it.tags || []).map((t) => el('span', { class: 'tag tag-' + t, text: t })), it.soldout ? el('span', { class: 'tag tag-售完', text: '售完' }) : null];
      const price = it.price.XL == null
        ? el('div', { class: 'price' }, 'L ', el('b', { text: it.price.L }))
        : el('div', { class: 'price' }, 'L ', el('b', { text: it.price.L }), '　XL ', el('b', { text: it.price.XL }));
      return el('button', {
        type: 'button', class: 'item' + (it.soldout ? ' soldout' : ''), disabled: !!it.soldout,
        onclick: () => openItem(it, cat),
      }, el('div', { class: 'name' }, tags, it.name), price);
    }));
  }

  // ============ 點餐：選規格 ============
  const dlgItem = $('#dlgItem');
  let pick = null;

  function openItem(item, cat) {
    pick = { item, cat, size: 'L', sugar: state.menu.sugar[0], ice: cat.hot ? null : state.menu.ice[0], toppings: new Set(), qty: 1, note: '' };
    $('#dlgItemName').textContent = item.name;
    $('#optNote').value = '';
    renderPick();
    dlgItem.showModal();
  }

  function chips(container, options, isOn, onPick) {
    const box = $('.chips', container);
    box.replaceChildren(...options.map((o) => el('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(isOn(o)), onclick: () => { onPick(o); renderPick(); },
    }, o.label, o.sub ? el('small', { text: ' ' + o.sub }) : null)));
  }

  function renderPick() {
    const m = state.menu;
    const sizes = m.sizes.filter((s) => pick.item.price[s.id] != null);
    if (!sizes.some((s) => s.id === pick.size)) pick.size = sizes[0] ? sizes[0].id : 'L';
    chips($('#optSize'), sizes.map((s) => ({ id: s.id, label: s.name, sub: `${s.cc}cc $${pick.item.price[s.id]}` })), (o) => o.id === pick.size, (o) => { pick.size = o.id; });
    $('#optSize').hidden = sizes.length <= 1;
    chips($('#optSugar'), m.sugar.map((s) => ({ id: s, label: s })), (o) => o.id === pick.sugar, (o) => { pick.sugar = o.id; });
    $('#optIce').hidden = !!pick.cat.hot;
    if (!pick.cat.hot) chips($('#optIce'), m.ice.map((s) => ({ id: s, label: s })), (o) => o.id === pick.ice, (o) => { pick.ice = o.id; });
    chips($('#optTop'), m.toppings.map((t) => ({ id: t.id, label: t.name, sub: `+${t.price}` })), (o) => pick.toppings.has(o.id),
      (o) => { if (pick.toppings.has(o.id)) pick.toppings.delete(o.id); else pick.toppings.add(o.id); });
    $('#optTop').hidden = m.toppings.length === 0;
    $('#qtyVal').textContent = pick.qty;
    const unit = Pricing.unitPrice(m, { itemId: pick.item.id, size: pick.size, toppings: [...pick.toppings] }) || 0;
    $('#optPrice').textContent = pick.qty > 1 ? `${money(unit)} × ${pick.qty} = ${money(unit * pick.qty)}` : money(unit);
  }

  $('#qtyMinus').addEventListener('click', () => { pick.qty = Math.max(1, pick.qty - 1); renderPick(); });
  $('#qtyPlus').addEventListener('click', () => { pick.qty = Math.min(99, pick.qty + 1); renderPick(); });
  $('#optNote').addEventListener('input', (e) => { pick.note = e.target.value.trim(); });
  $('#btnAddLine').addEventListener('click', () => {
    const line = { itemId: pick.item.id, name: pick.item.name, size: pick.size, sugar: pick.sugar, ice: pick.ice, toppings: [...pick.toppings], qty: pick.qty, note: pick.note };
    // 一模一樣的規格就合併數量
    const same = state.cart.find((l) => l.itemId === line.itemId && l.size === line.size && l.sugar === line.sugar && l.ice === line.ice
      && l.note === line.note && l.toppings.join() === line.toppings.join());
    if (same) same.qty += line.qty; else state.cart.push(line);
    dlgItem.close();
    renderCart();
    toast(`已加入 ${line.name} ×${line.qty}`);
  });
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  // ============ 點餐：這一單 ============
  function renderCart() {
    const m = state.menu;
    const sum = Pricing.summarize(m, state.cart);
    const wrap = $('#cartLines');
    if (!state.cart.length) {
      wrap.replaceChildren(el('div', { class: 'cart-empty', text: '點左邊的品項開始點餐' }));
    } else {
      wrap.replaceChildren(...sum.lines.map((l, i) => el('div', { class: 'cart-line' },
        el('div', {}, el('div', {}, el('b', { text: l.name })), el('div', { class: 'spec', text: Pricing.describeLine(m, l) })),
        el('div', { class: 'amt', text: money(l.amount) }),
        el('div', { class: 'qty' },
          el('button', { type: 'button', text: '−', onclick: () => { if (--state.cart[i].qty <= 0) state.cart.splice(i, 1); renderCart(); } }),
          el('span', { text: l.qty }),
          el('button', { type: 'button', text: '＋', onclick: () => { state.cart[i].qty++; renderCart(); } })),
        el('div', { class: 'right' }, el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '刪除', onclick: () => { state.cart.splice(i, 1); renderCart(); } })),
      )));
    }
    const totals = $('#cartTotals');
    const rows = [];
    if (sum.discount > 0) {
      rows.push(el('span', { class: 'muted', text: `小計（${sum.cups} 杯）` }), el('span', { class: 'right', text: money(sum.subtotal) }));
      rows.push(el('span', { class: 'muted', text: `買${m.promo.buy}送${m.promo.free}，送 ${sum.freeCups} 杯` }), el('span', { class: 'right', text: '−' + money(sum.discount) }));
    }
    rows.push(el('span', { class: 'grand', text: `合計 ${sum.cups} 杯` }), el('span', { class: 'grand right', text: money(sum.total) }));
    totals.replaceChildren(...rows);

    const has = state.cart.length > 0;
    $('#payBox').hidden = !has;
    $('#btnCheckout').disabled = !has;
    $('#cartBar').hidden = !has;
    $('#cartBarText').textContent = `${sum.cups} 杯`;
    $('#cartBarTotal').textContent = money(sum.total);
    if (has) renderCashQuick(sum.total);
    renderChange();
  }

  function renderCashQuick(total) {
    const opts = [['剛好', total]];
    [50, 100, 200, 500, 1000].filter((v) => v >= total).forEach((v) => opts.push([`$${v}`, v]));
    // 湊整：往上到下一個 50、100
    const up50 = Math.ceil(total / 50) * 50; const up100 = Math.ceil(total / 100) * 100;
    if (up50 !== total && !opts.some((o) => o[1] === up50)) opts.splice(1, 0, [`$${up50}`, up50]);
    if (up100 !== total && !opts.some((o) => o[1] === up100)) opts.splice(2, 0, [`$${up100}`, up100]);
    $('#cashQuick').replaceChildren(...opts.map(([label, v]) => el('button', {
      type: 'button', class: 'btn btn-sm', text: label, onclick: () => { $('#cashIn').value = v; renderChange(); },
    })));
  }

  function renderChange() {
    const total = Pricing.summarize(state.menu, state.cart).total;
    const cash = Number($('#cashIn').value);
    const out = $('#changeOut');
    if (!$('#cashIn').value) { out.textContent = '—'; out.classList.remove('short'); return; }
    const diff = cash - total;
    out.textContent = diff < 0 ? `還差 ${money(-diff)}` : money(diff);
    out.classList.toggle('short', diff < 0);
  }
  $('#cashIn').addEventListener('input', renderChange);
  $('#btnClearCart').addEventListener('click', () => { if (!state.cart.length || confirm('清空這一單？')) { state.cart = []; $('#cashIn').value = ''; renderCart(); } });
  $('#cartBar').addEventListener('click', () => $('#cartPanel').scrollIntoView({ behavior: 'smooth' }));

  $('#btnCheckout').addEventListener('click', () => {
    if (!state.cart.length) return;
    const m = state.menu;
    const sum = Pricing.summarize(m, state.cart);
    const cashRaw = $('#cashIn').value;
    const cash = cashRaw === '' ? sum.total : Number(cashRaw);
    if (cash < sum.total && !confirm(`收的現金 ${money(cash)} 少於應收 ${money(sum.total)}，還是要結帳？`)) return;
    const now = new Date();
    const order = {
      id: `${Store.dateKey(now)}-${now.getTime().toString(36)}`,
      no: Store.nextOrderNo(),
      time: now.toISOString(),
      date: Store.dateKey(now),
      lines: sum.lines.map((l) => ({ itemId: l.itemId, name: l.name, category: (Pricing.findItem(m, l.itemId) || { category: {} }).category.name || '',
        size: l.size, sugar: l.sugar, ice: l.ice, toppings: l.toppings, note: l.note, qty: l.qty, base: l.base, unit: l.unit, amount: l.amount, spec: Pricing.describeLine(m, l) })),
      cups: sum.cups, subtotal: sum.subtotal, discount: sum.discount, freeCups: sum.freeCups, total: sum.total,
      cash, change: cash - sum.total, voided: false,
    };
    Store.addOrder(order);
    state.cart = [];
    $('#cashIn').value = '';
    renderCart();
    showTicket(order);
  });

  // ============ 製作單 ============
  function showTicket(order) {
    const t = $('#ticket');
    t.replaceChildren(
      el('h3', { text: `${state.menu.shopName || ''}　#${order.no}` }),
      el('div', { class: 'meta' }, el('span', { text: `${order.date} ${hm(order.time)}` }), el('span', { text: `${order.cups} 杯` })),
      el('ol', {}, ...order.lines.map((l) => el('li', {},
        el('div', { class: 'n' }, `${l.name} ×${l.qty}`),
        el('div', { class: 's', text: l.spec }),
      ))),
      el('div', { class: 'tot' },
        order.discount > 0 ? el('div', { class: 'muted', text: `小計 ${money(order.subtotal)}　買${state.menu.promo.buy}送${state.menu.promo.free} −${money(order.discount)}` }) : null,
        el('div', {}, '合計 ', el('b', { text: money(order.total) })),
        el('div', { class: 'muted', text: `收現 ${money(order.cash)}　找零 ${money(order.change)}` }),
      ),
    );
    $('#dlgTicket').showModal();
  }
  $('#btnPrint').addEventListener('click', () => window.print());

  // ============ 訂單 ============
  $('#ordersDate').value = Store.dateKey();
  $('#ordersDate').addEventListener('change', renderOrders);
  $('#ordersToday').addEventListener('click', () => { $('#ordersDate').value = Store.dateKey(); renderOrders(); });

  function renderOrders() {
    const date = $('#ordersDate').value || Store.dateKey();
    const orders = Store.loadOrders().filter((o) => o.date === date).sort((a, b) => b.no - a.no);
    const live = orders.filter((o) => !o.voided);
    $('#ordersSummary').textContent = orders.length
      ? `${live.length} 單 ・ ${live.reduce((n, o) => n + o.cups, 0)} 杯 ・ ${money(live.reduce((n, o) => n + o.total, 0))}`
      : '這天沒有訂單';
    $('#ordersList').replaceChildren(...orders.map((o) => el('details', { class: 'order' + (o.voided ? ' voided' : '') },
      el('summary', {},
        el('span', { class: 'no', text: `#${o.no}` }),
        el('span', { class: 'muted', text: hm(o.time) }),
        el('span', { class: 'muted', text: `${o.cups} 杯` }),
        el('span', { class: 'sum', text: money(o.total) }),
      ),
      el('div', { class: 'body' },
        el('ul', {}, ...o.lines.map((l) => el('li', {}, el('b', { text: `${l.name} ×${l.qty}` }), ' ', el('span', { class: 'muted', text: l.spec }), ' ', el('span', { class: 'nowrap', text: money(l.amount) })))),
        o.discount > 0 ? el('div', { class: 'muted', text: `小計 ${money(o.subtotal)}，活動折 ${money(o.discount)}` }) : null,
        el('div', { class: 'muted', text: `收現 ${money(o.cash)}，找零 ${money(o.change)}` }),
        el('div', { class: 'row', style: 'margin-top:8px' },
          el('button', { type: 'button', class: 'btn btn-sm', text: '補印製作單', onclick: () => showTicket(o) }),
          el('button', { type: 'button', class: 'btn btn-sm', text: '再點一次', onclick: () => { state.cart = o.lines.map((l) => ({ itemId: l.itemId, name: l.name, size: l.size, sugar: l.sugar, ice: l.ice, toppings: l.toppings || [], qty: l.qty, note: l.note || '' })); renderCart(); showTab('pos'); } }),
          el('span', { class: 'grow' }),
          o.voided
            ? el('button', { type: 'button', class: 'btn btn-sm', text: '取消作廢', onclick: () => { Store.updateOrder(o.id, { voided: false }); renderOrders(); } })
            : el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: '作廢', onclick: () => { if (confirm(`作廢 #${o.no}？報表就不會算這一單。`)) { Store.updateOrder(o.id, { voided: true }); renderOrders(); } } }),
        ),
      ),
    )));
  }

  // ============ 報表 ============
  function rangeDates(kind) {
    const today = Store.dateKey();
    const d = new Date();
    if (kind === 'today') return [today, today];
    if (kind === 'yesterday') { d.setDate(d.getDate() - 1); const y = Store.dateKey(d); return [y, y]; }
    if (kind === 'week') { const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return [Store.dateKey(d), today]; }
    if (kind === 'month') return [today.slice(0, 8) + '01', today];
    return [$('#reportFrom').value || today, $('#reportTo').value || today];
  }
  $$('#reportRange .chip').forEach((b) => b.addEventListener('click', () => {
    state.reportRange = b.dataset.range;
    $$('#reportRange .chip').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('#reportCustom').hidden = state.reportRange !== 'custom';
    if (state.reportRange === 'custom' && !$('#reportFrom').value) { $('#reportFrom').value = Store.dateKey(); $('#reportTo').value = Store.dateKey(); }
    renderReport();
  }));
  $('#reportFrom').addEventListener('change', renderReport);
  $('#reportTo').addEventListener('change', renderReport);

  function reportOrders() {
    const [from, to] = rangeDates(state.reportRange);
    return Store.loadOrders().filter((o) => !o.voided && o.date >= from && o.date <= to);
  }

  function table(headers, rows) {
    return el('table', {},
      el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { class: h.num ? 'num' : '', text: h.label })))),
      el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c, i) => el('td', { class: headers[i].num ? 'num' : '' }, c))))));
  }

  function renderReport() {
    const orders = reportOrders();
    const cups = orders.reduce((n, o) => n + o.cups, 0);
    const revenue = orders.reduce((n, o) => n + o.total, 0);
    const discount = orders.reduce((n, o) => n + (o.discount || 0), 0);
    $('#reportStats').replaceChildren(
      el('div', { class: 'stat' }, el('div', { class: 'v', text: money(revenue) }), el('div', { class: 'k', text: '營業額' })),
      el('div', { class: 'stat' }, el('div', { class: 'v', text: orders.length }), el('div', { class: 'k', text: '單數' })),
      el('div', { class: 'stat' }, el('div', { class: 'v', text: cups }), el('div', { class: 'k', text: '杯數' })),
      el('div', { class: 'stat' }, el('div', { class: 'v', text: orders.length ? money(Math.round(revenue / orders.length)) : '—' }), el('div', { class: 'k', text: '平均每單' })),
      el('div', { class: 'stat' }, el('div', { class: 'v', text: money(discount) }), el('div', { class: 'k', text: '活動送出' })),
    );

    const byItem = new Map(); const byCat = new Map(); const byHour = new Array(24).fill(0); const byTop = new Map();
    orders.forEach((o) => {
      const h = new Date(o.time).getHours();
      byHour[h] += o.cups;
      o.lines.forEach((l) => {
        const key = l.name;
        const it = byItem.get(key) || { name: key, qty: 0, amount: 0, L: 0, XL: 0 };
        it.qty += l.qty; it.amount += l.amount; it[l.size] = (it[l.size] || 0) + l.qty;
        byItem.set(key, it);
        const cat = byCat.get(l.category || '其他') || { name: l.category || '其他', qty: 0, amount: 0 };
        cat.qty += l.qty; cat.amount += l.amount; byCat.set(cat.name, cat);
        (l.toppings || []).forEach((tid) => {
          const t = state.menu.toppings.find((x) => x.id === tid);
          const name = t ? t.name : tid;
          byTop.set(name, (byTop.get(name) || 0) + l.qty);
        });
      });
    });
    const items = [...byItem.values()].sort((a, b) => b.qty - a.qty || b.amount - a.amount);
    $('#reportItems').replaceChildren(items.length
      ? table([{ label: '品項' }, { label: '杯數', num: true }, { label: 'L', num: true }, { label: 'XL', num: true }, { label: '金額', num: true }],
        items.map((i) => [i.name, i.qty, i.L || 0, i.XL || 0, money(i.amount)]))
      : el('p', { class: 'muted', text: '這段期間沒有訂單' }));
    const cats = [...byCat.values()].sort((a, b) => b.amount - a.amount);
    $('#reportCats').replaceChildren(cats.length
      ? table([{ label: '系列' }, { label: '杯數', num: true }, { label: '金額', num: true }, { label: '佔比', num: true }],
        cats.map((c) => [c.name, c.qty, money(c.amount), revenue ? Math.round(c.amount / revenue * 100) + '%' : '—']))
      : el('p', { class: 'muted', text: '—' }));
    const maxH = Math.max(1, ...byHour);
    const hours = byHour.map((n, h) => [h, n]).filter(([, n]) => n > 0);
    $('#reportHours').replaceChildren(...(hours.length ? hours.flatMap(([h, n]) => [
      el('span', { text: `${pad(h)}:00` }),
      el('div', { class: 'bar', style: `width:${Math.round(n / maxH * 100)}%` }),
      el('span', { class: 'num', text: n }),
    ]) : [el('p', { class: 'muted', text: '—' })]));
    const tops = [...byTop.entries()].sort((a, b) => b[1] - a[1]);
    $('#reportToppings').replaceChildren(tops.length
      ? table([{ label: '加料' }, { label: '次數', num: true }], tops.map(([n, q]) => [n, q]))
      : el('p', { class: 'muted', text: '—' }));
  }

  function download(name, text, type) {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('#btnExportCsv').addEventListener('click', () => {
    const orders = reportOrders();
    const q = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
    const rows = [['日期', '時間', '單號', '品項', '系列', '尺寸', '糖', '冰', '加料', '備註', '數量', '單價', '金額', '整單折扣', '整單合計']];
    orders.forEach((o) => o.lines.forEach((l, i) => rows.push([o.date, hm(o.time), o.no, l.name, l.category, l.size, l.sugar, l.ice || '', (l.toppings || []).map((t) => (state.menu.toppings.find((x) => x.id === t) || { name: t }).name).join('+'), l.note || '', l.qty, l.unit, l.amount, i === 0 ? o.discount : '', i === 0 ? o.total : ''])));
    const [from, to] = rangeDates(state.reportRange);
    download(`營業明細_${from}_${to}.csv`, '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  });

  // ============ 菜單設定 ============
  function saveMenu() { Store.saveMenu(state.menu); renderCats(); renderItems(); }
  const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

  function renderMenuEditor() {
    const m = state.menu;
    $('#setShopName').value = m.shopName || '';
    $('#setPromoBuy').value = m.promo.buy;
    $('#setPromoFree').value = m.promo.free;
    $('#setPromoEnabled').value = m.promo.enabled ? '1' : '0';

    $('#setToppings').replaceChildren(table([{ label: '名稱' }, { label: '加價', num: true }, { label: '' }],
      m.toppings.map((t, i) => [
        el('input', { type: 'text', value: t.name, onchange: (e) => { t.name = e.target.value.trim() || t.name; saveMenu(); } }),
        el('input', { type: 'number', value: t.price, min: 0, onchange: (e) => { t.price = Number(e.target.value) || 0; saveMenu(); } }),
        el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: '刪除', onclick: () => { if (confirm(`刪除加料「${t.name}」？`)) { m.toppings.splice(i, 1); saveMenu(); renderMenuEditor(); } } }),
      ])),
      el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { type: 'button', class: 'btn btn-sm', text: '＋ 新增加料', onclick: () => {
        const name = prompt('加料名稱？'); if (!name) return;
        const price = Number(prompt('加價多少？', '10')) || 0;
        m.toppings.push({ id: 't' + Date.now().toString(36), name: name.trim(), price }); saveMenu(); renderMenuEditor();
      } })));

    const box = $('#setItems');
    box.replaceChildren(...m.categories.map((cat, ci) => el('div', {},
      el('div', { class: 'cat-head' },
        el('input', { type: 'text', value: cat.name, onchange: (e) => { cat.name = e.target.value.trim() || cat.name; saveMenu(); } }),
        el('label', { class: 'nowrap', style: 'font-size:13px' }, el('input', { type: 'checkbox', checked: !!cat.hot, onchange: (e) => { cat.hot = e.target.checked; saveMenu(); } }), ' 熱飲（不選冰量）'),
        el('span', { class: 'grow' }),
        el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: '↑', title: '往上移', disabled: ci === 0, onclick: () => { m.categories.splice(ci - 1, 0, m.categories.splice(ci, 1)[0]); saveMenu(); renderMenuEditor(); } }),
        el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: '↓', title: '往下移', disabled: ci === m.categories.length - 1, onclick: () => { m.categories.splice(ci + 1, 0, m.categories.splice(ci, 1)[0]); saveMenu(); renderMenuEditor(); } }),
        el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: '刪除系列', onclick: () => { if (confirm(`刪除「${cat.name}」整個系列（${cat.items.length} 項）？`)) { m.categories.splice(ci, 1); saveMenu(); renderMenuEditor(); } } }),
      ),
      table([{ label: '品名' }, { label: 'L', num: true }, { label: 'XL', num: true }, { label: '標籤' }, { label: '售完' }, { label: '' }],
        cat.items.map((it, ii) => [
          el('input', { type: 'text', value: it.name, onchange: (e) => { it.name = e.target.value.trim() || it.name; saveMenu(); } }),
          el('input', { type: 'number', value: it.price.L, min: 0, onchange: (e) => { it.price.L = Number(e.target.value) || 0; saveMenu(); } }),
          el('input', { type: 'number', value: it.price.XL == null ? '' : it.price.XL, min: 0, placeholder: '無', onchange: (e) => { it.price.XL = numOrNull(e.target.value); saveMenu(); } }),
          el('select', { onchange: (e) => { it.tags = e.target.value ? [e.target.value] : []; saveMenu(); } },
            ...[['', '無'], ['推', '推薦'], ['新', '新品']].map(([v, l]) => el('option', { value: v, selected: (it.tags || [])[0] === v || (!v && !(it.tags || []).length), text: l }))),
          el('input', { type: 'checkbox', checked: !!it.soldout, onchange: (e) => { it.soldout = e.target.checked; saveMenu(); } }),
          el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: '刪除', onclick: () => { if (confirm(`刪除「${it.name}」？`)) { cat.items.splice(ii, 1); saveMenu(); renderMenuEditor(); } } }),
        ])),
      el('div', { class: 'row', style: 'margin-top:6px' }, el('button', { type: 'button', class: 'btn btn-sm', text: '＋ 新增品項', onclick: () => {
        const name = prompt(`在「${cat.name}」新增品項，名稱？`); if (!name) return;
        const L = Number(prompt('L 價格？', '30')) || 0;
        const xl = prompt('XL 價格？（只賣 L 就留空）', String(L + 5));
        cat.items.push({ id: cat.id + '-' + Date.now().toString(36), name: name.trim(), price: { L, XL: numOrNull(xl) }, tags: [] });
        saveMenu(); renderMenuEditor();
      } })),
    )));
  }
  $('#setShopName').addEventListener('change', (e) => { state.menu.shopName = e.target.value.trim() || '飲料店'; saveMenu(); });
  $('#setPromoBuy').addEventListener('change', (e) => { state.menu.promo.buy = Math.max(1, Number(e.target.value) || 1); saveMenu(); });
  $('#setPromoFree').addEventListener('change', (e) => { state.menu.promo.free = Math.max(0, Number(e.target.value) || 0); saveMenu(); });
  $('#setPromoEnabled').addEventListener('change', (e) => { state.menu.promo.enabled = e.target.value === '1'; saveMenu(); renderCart(); });
  $('#btnAddCat').addEventListener('click', () => {
    const name = prompt('新系列名稱？'); if (!name) return;
    state.menu.categories.push({ id: 'c' + Date.now().toString(36), name: name.trim(), items: [] });
    saveMenu(); renderMenuEditor();
  });
  $('#btnResetMenu').addEventListener('click', () => {
    if (!confirm('把菜單、價格、加料、活動全部恢復成預設？你改過的都會不見（訂單不受影響）。')) return;
    state.menu = Store.resetMenu(); saveMenu(); renderMenuEditor(); renderCart(); toast('已恢復預設菜單');
  });
  $('#btnClearOrders').addEventListener('click', () => {
    if (!confirm('清除所有訂單與報表資料？建議先下載備份。')) return;
    if (!confirm('真的要清除？這個動作無法復原。')) return;
    Store.clearOrders(); toast('訂單已清除');
  });
  $('#btnBackup').addEventListener('click', () => {
    download(`飲料店備份_${Store.dateKey()}.json`, JSON.stringify(Store.exportAll(), null, 1), 'application/json');
  });
  $('#btnRestore').addEventListener('click', () => $('#restoreFile').click());
  $('#restoreFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try {
      Store.importAll(JSON.parse(await file.text()));
      state.menu = Store.loadMenu();
      saveMenu(); renderMenuEditor(); renderCart();
      toast('備份已還原');
    } catch (err) { alert('還原失敗：' + err.message); }
  });

  // ============ 啟動 ============
  renderCats();
  renderItems();
  renderCart();
})();
