/*
 * crm-store.js — 徵信資料的資料層（IndexedDB；客戶管理頁已移除，customers 等表留著相容備份）。
 * 客戶、貸款案件、跟進紀錄、徵信資料都只存在這台裝置的瀏覽器裡。
 */
(function (global) {
  'use strict';

  const DB_NAME = 'crm-db';
  const DB_VERSION = 1;
  const STORES = ['customers', 'cases', 'notes', 'dossiers', 'meta'];
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('customers')) {
          const s = db.createObjectStore('customers', { keyPath: 'id' });
          s.createIndex('taxId', 'taxId');
          s.createIndex('leadId', 'leadId');
        }
        if (!db.objectStoreNames.contains('cases')) {
          db.createObjectStore('cases', { keyPath: 'id' }).createIndex('customerId', 'customerId');
        }
        if (!db.objectStoreNames.contains('notes')) {
          db.createObjectStore('notes', { keyPath: 'id' }).createIndex('customerId', 'customerId');
        }
        if (!db.objectStoreNames.contains('dossiers')) {
          db.createObjectStore('dossiers', { keyPath: 'id' }).createIndex('customerId', 'customerId');
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(storeNames, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
      const stores = Array.isArray(storeNames)
        ? storeNames.map((n) => t.objectStore(n))
        : [t.objectStore(storeNames)];
      result = fn(...stores);
      if (result && typeof result.then === 'function') {
        result.then((v) => { result = v; }, reject);
      }
    }));
  }

  const req2promise = (r) => new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

  const uid = () => (global.crypto && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  const all = (name) => tx(name, 'readonly', (s) => req2promise(s.getAll()));
  const put = (name, obj) => tx(name, 'readwrite', (s) => s.put(obj)).then(() => obj);
  const del = (name, id) => tx(name, 'readwrite', (s) => s.delete(id));

  const api = {
    uid,

    allCustomers: () => all('customers'),
    allCases: () => all('cases'),
    allNotes: () => all('notes'),

    saveCustomer(c) {
      const now = Date.now();
      if (!c.id) c.id = uid();
      if (!c.createdAt) c.createdAt = now;
      c.updatedAt = now;
      return put('customers', c);
    },
    saveCustomers(list) {
      const now = Date.now();
      return tx('customers', 'readwrite', (s) => list.forEach((c) => {
        if (!c.id) c.id = uid();
        if (!c.createdAt) c.createdAt = now;
        c.updatedAt = now;
        s.put(c);
      })).then(() => list.length);
    },
    /** 刪客戶時連同案件與跟進紀錄一起清掉。 */
    deleteCustomer(id) {
      return tx(['customers', 'cases', 'notes'], 'readwrite', (customers, cases, notes) => {
        customers.delete(id);
        const purge = (store) => {
          const idx = store.index('customerId');
          idx.openCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
            const cur = e.target.result;
            if (cur) { cur.delete(); cur.continue(); }
          };
        };
        purge(cases);
        purge(notes);
      });
    },

    saveCase(k) {
      const now = Date.now();
      if (!k.id) k.id = uid();
      if (!k.createdAt) k.createdAt = now;
      k.updatedAt = now;
      return put('cases', k);
    },
    deleteCase: (id) => del('cases', id),

    saveNote(n) {
      if (!n.id) n.id = uid();
      if (!n.createdAt) n.createdAt = Date.now();
      return put('notes', n);
    },
    deleteNote: (id) => del('notes', id),

    allDossiers: () => all('dossiers'),
    async getDossier(id) {
      return tx('dossiers', 'readonly', (s) => req2promise(s.get(id)));
    },
    saveDossier(d) {
      const now = Date.now();
      if (!d.id) d.id = uid();
      if (!d.createdAt) d.createdAt = now;
      d.updatedAt = now;
      return put('dossiers', d);
    },
    deleteDossier: (id) => del('dossiers', id),

    setMeta: (key, value) => put('meta', { key, value }),
    async getMeta(key) {
      const row = await tx('meta', 'readonly', (s) => req2promise(s.get(key)));
      return row ? row.value : undefined;
    },

    async exportAll() {
      const [customers, cases, notes, dossiers] = await Promise.all([
        api.allCustomers(), api.allCases(), api.allNotes(), api.allDossiers(),
      ]);
      return { app: 'crm', version: 1, exportedAt: new Date().toISOString(), customers, cases, notes, dossiers };
    },

    /** merge=true 時不清空，同 id 覆蓋，其餘新增。 */
    async importAll(dump, merge) {
      if (!dump || !Array.isArray(dump.customers)) throw new Error('備份檔格式不正確（找不到 customers）');
      await tx(['customers', 'cases', 'notes', 'dossiers'], 'readwrite', (customers, cases, notes, dossiers) => {
        if (!merge) { customers.clear(); cases.clear(); notes.clear(); dossiers.clear(); }
        dump.customers.forEach((c) => customers.put(c));
        (dump.cases || []).forEach((k) => cases.put(k));
        (dump.notes || []).forEach((n) => notes.put(n));
        (dump.dossiers || []).forEach((d) => dossiers.put(d));
      });
    },

    wipe() {
      return tx(STORES, 'readwrite', (...stores) => stores.forEach((s) => s.clear()));
    },
  };

  global.CrmStore = api;
})(window);
