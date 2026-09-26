/*
 * 紅茶洋行 菜單資料（預設值）。
 *
 * 價格照店內菜單抄：L = 700c.c.、XL = 1000c.c.。
 * 只有 L 的品項（紅茶三號、特調、熱飲…）XL 就是 null，點餐時不會出現 XL 按鈕。
 * 老闆在「菜單設定」改過的價格存在瀏覽器裡，會蓋過這份預設值；按「恢復預設」就回到這裡。
 *
 * 寫成 (function (global) {...})(window) 是為了讓 Node 測試用同一份檔案。
 */
(function (global) {
  'use strict';

  const item = (id, name, L, XL, tags) => ({ id, name, price: { L, XL: XL == null ? null : XL }, tags: tags || [] });

  const DEFAULT_MENU = {
    shopName: '紅茶洋行',
    sizes: [
      { id: 'L', name: 'L', cc: 700 },
      { id: 'XL', name: 'XL', cc: 1000 },
    ],
    sugar: ['全糖', '半糖', '微糖', '無糖'],
    ice: ['正常冰', '少冰', '微冰', '去冰'],
    toppings: [
      { id: 'coconut', name: '椰果', price: 10 },
      { id: 'boba', name: '波霸', price: 10 },
      { id: 'pudding', name: '布丁', price: 5 },
      { id: 'grass', name: '仙草凍', price: 5 },
    ],
    // 來店 買5送1：每滿 6 杯，最便宜的那杯免費（加料照算）
    promo: { enabled: true, buy: 5, free: 1 },
    categories: [
      { id: 'barley', name: '麥茶系列', items: [
        item('barley-1', '麥仔茶', 25, 30, ['推']),
        item('barley-2', '麥香紅茶', 30, 35),
        item('barley-3', '麥香冬瓜', 30, 35),
        item('barley-4', '麥茶豆漿', 40, 45),
        item('barley-5', '麥茶牛奶', 50, 55),
      ] },
      { id: 'black', name: '紅茶系列', items: [
        item('black-1', '古早味紅茶冰', 25, 30, ['推']),
        item('black-2', '冬瓜紅茶', 30, 35),
        item('black-3', '波霸紅茶冰', 35, 40),
        item('black-4', '椰果紅茶冰', 35, 40),
        item('black-5', '豆漿紅茶', 40, 45, ['推']),
        item('black-6', '微檸檬紅茶', 35, 40),
        item('black-7', '重檸檬紅茶', 45, 50, ['推']),
        item('black-8', '紅茶冰淇淋', 50, 55, ['推']),
        item('black-9', '紅茶牛奶', 50, 55, ['推']),
        item('black-10', '紅茶三號（波霸+布丁+冰淇淋）', 55, null),
      ] },
      { id: 'green-oolong', name: '青茶系列', items: [
        item('qing-1', '翠玉青茶', 25, 30),
        item('qing-2', '冬瓜青茶', 30, 35),
        item('qing-3', '青梅青茶', 35, 40, ['新']),
      ] },
      { id: 'green', name: '綠茶系列', items: [
        item('green-1', '金萱綠茶', 25, 30),
        item('green-2', '冬瓜綠茶', 30, 35),
        item('green-3', '青梅綠茶', 35, 40, ['新']),
        item('green-4', '梅子綠茶', 35, 40),
        item('green-5', '鮮奶綠茶', 50, 55),
        item('green-6', '綠茶多多', 50, 55, ['推']),
      ] },
      { id: 'oolong', name: '輕烏龍系列', items: [
        item('oolong-1', '鐵觀音輕烏龍', 25, 30, ['新']),
        item('oolong-2', '檸檬烏龍', 35, 40, ['新']),
        item('oolong-3', '青梅烏龍', 35, 40, ['新']),
        item('oolong-4', '鮮奶烏龍', 50, 55, ['新']),
      ] },
      { id: 'honey', name: '蜂蜜系列', items: [
        item('honey-1', '蜂蜜茶', 35, 40, ['新']),
        item('honey-2', '蜂蜜綠茶', 40, 45, ['新']),
        item('honey-3', '蜂蜜檸檬', 45, 50, ['新']),
      ] },
      { id: 'passion', name: '百香果原汁', items: [
        item('passion-1', '百香果綠茶', 50, 55),
        item('passion-2', '百香蜂蜜', 50, 55),
        item('passion-3', '百香紅茶', 50, 55),
        item('passion-4', '百香冬瓜', 50, 55),
      ] },
      { id: 'milk', name: '奶茶系列', items: [
        item('milk-1', '奶茶', 35, 40),
        item('milk-2', '奶綠', 35, 40),
        item('milk-3', '波霸奶茶', 45, 50),
        item('milk-4', '椰果奶茶', 45, 50),
        item('milk-5', '雙Q奶茶', 45, 50),
        item('milk-6', '布丁奶茶', 40, 45),
        item('milk-7', '仙草凍奶茶', 40, 45),
        item('milk-8', '黑糖奶茶', 45, null),
        item('milk-9', '巧克力可可', 45, null),
        item('milk-10', '阿華田', 45, null),
      ] },
      { id: 'wintermelon', name: '冬瓜仙干系列', items: [
        item('wm-1', '仙草干茶', 25, 30),
        item('wm-2', '古早味冬瓜茶', 25, 30, ['推']),
        item('wm-3', '仙草干冬瓜', 30, 35, ['推']),
        item('wm-4', '回憶仙草蜜', 30, 35),
        item('wm-5', '冬瓜仙草凍', 30, 35),
        item('wm-6', '冬瓜椰果', 35, 40),
        item('wm-7', '微檸檬冬瓜茶', 35, 40, ['推']),
        item('wm-8', '重檸檬冬瓜茶', 45, 50),
        item('wm-9', '仙草干鮮奶', 50, 55),
        item('wm-10', '冬瓜鮮奶', 50, 55),
      ] },
      { id: 'brew', name: '熬煮系列', items: [
        item('brew-1', '酸梅湯', 40, 45),
      ] },
      { id: 'special', name: '特調系列', items: [
        item('special-1', '番茄梅', 45, 40, ['新']),
        item('special-2', '番茄多多', 55, 40, ['新']),
      ] },
      { id: 'hot', name: '熱飲系列', hot: true, items: [
        item('hot-1', '熱黑糖奶茶', 45, null),
        item('hot-2', '黑糖薑茶', 45, null),
        item('hot-3', '桂圓薑母', 45, null),
        item('hot-4', '桂圓紅棗', 45, null),
        item('hot-5', '熱巧克力可可', 45, null),
        item('hot-6', '熱阿華田', 45, null),
        item('hot-7', '桂圓奶茶', 50, null),
        item('hot-8', '薑汁熱鮮奶', 55, null),
      ] },
    ],
  };

  global.DrinkMenu = {
    DEFAULT_MENU,
    /** 深拷貝一份預設菜單，給「恢復預設」或初始化用 */
    defaults() { return JSON.parse(JSON.stringify(DEFAULT_MENU)); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
