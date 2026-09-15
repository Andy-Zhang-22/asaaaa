/*
 * store.js — 以 IndexedDB 保存名單、通話紀錄與追蹤狀態。
 * 所有資料只存在這台裝置的瀏覽器裡，不會送到任何伺服器。
 */
(function (global) {
  'use strict';

  const DB_NAME = 'telemarketing-db';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('records')) {
          db.createObjectStore('records', { keyPath: 'id' }).createIndex('source', 'source');
        }
        if (!db.objectStoreNames.contains('logs')) {
          const logs = db.createObjectStore('logs', { keyPath: 'logId', autoIncrement: true });
          logs.createIndex('recordId', 'recordId');
        }
        if (!db.objectStoreNames.contains('state')) {
          db.createObjectStore('state', { keyPath: 'recordId' });
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

  const api = {
    async saveRecords(records) {
      await tx('records', 'readwrite', (store) => {
        records.forEach((r) => store.put(r));
      });
      return records.length;
    },

    allRecords() {
      return tx('records', 'readonly', (store) => req2promise(store.getAll()));
    },

    async deleteSource(source) {
      const all = await api.allRecords();
      const ids = all.filter((r) => r.source === source).map((r) => r.id);
      await tx('records', 'readwrite', (store) => ids.forEach((id) => store.delete(id)));
      return ids.length;
    },

    addLog(log) {
      return tx('logs', 'readwrite', (store) => req2promise(store.add(log)));
    },

    deleteLog(logId) {
      return tx('logs', 'readwrite', (store) => store.delete(logId));
    },

    allLogs() {
      return tx('logs', 'readonly', (store) => req2promise(store.getAll()));
    },

    setState(state) {
      return tx('state', 'readwrite', (store) => store.put(state));
    },

    allStates() {
      return tx('state', 'readonly', (store) => req2promise(store.getAll()));
    },

    setMeta(key, value) {
      return tx('meta', 'readwrite', (store) => store.put({ key, value }));
    },

    async getMeta(key) {
      const row = await tx('meta', 'readonly', (store) => req2promise(store.get(key)));
      return row ? row.value : undefined;
    },

    async exportAll() {
      const [records, logs, states] = await Promise.all([
        api.allRecords(), api.allLogs(), api.allStates(),
      ]);
      return { version: 1, exportedAt: new Date().toISOString(), records, logs, states };
    },

    async importAll(dump) {
      if (!dump || !Array.isArray(dump.records)) throw new Error('備份檔格式不正確');
      await tx(['records', 'logs', 'state'], 'readwrite', (records, logs, state) => {
        records.clear(); logs.clear(); state.clear();
        dump.records.forEach((r) => records.put(r));
        (dump.logs || []).forEach((l) => logs.put(l));
        (dump.states || []).forEach((s) => state.put(s));
      });
    },

    async wipe() {
      await tx(['records', 'logs', 'state', 'meta'], 'readwrite', (a, b, c, d) => {
        a.clear(); b.clear(); c.clear(); d.clear();
      });
    },
  };

  global.Store = api;
})(window);
