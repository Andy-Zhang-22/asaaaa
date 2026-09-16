/*
 * store.js — 以 IndexedDB 保存名單、通話紀錄與追蹤狀態。
 * 所有資料只存在這台裝置的瀏覽器裡，不會送到任何伺服器。
 */
(function (global) {
  'use strict';

  const DB_NAME = 'telemarketing-db';
  const DB_VERSION = 2;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        const tx = req.transaction;
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
        // v2：通話紀錄改用跨裝置唯一的 uid，autoIncrement 的 logId 在兩台裝置上會撞號
        if (ev.oldVersion < 2 && db.objectStoreNames.contains('logs')) {
          const logs = tx.objectStore('logs');
          logs.openCursor().onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) return;
            const row = cursor.value;
            if (!row.uid) {
              row.uid = newUid();
              cursor.update(row);
            }
            cursor.continue();
          };
          if (!logs.indexNames.contains('uid')) logs.createIndex('uid', 'uid', { unique: false });
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

  /** 跨裝置唯一的識別碼，合併時用它判斷是不是同一筆。 */
  function newUid() {
    if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

    async deleteSource(source, { keepTombstone = true } = {}) {
      const all = await api.allRecords();
      const ids = all.filter((r) => r.source === source).map((r) => r.id);
      await tx('records', 'readwrite', (store) => ids.forEach((id) => store.delete(id)));
      if (keepTombstone && ids.length) await api.addTombstone('sources', source);
      return ids.length;
    },

    addLog(log) {
      const row = { uid: newUid(), createdAt: Date.now(), ...log };
      return tx('logs', 'readwrite', (store) => req2promise(store.add(row)));
    },

    async deleteLog(logId) {
      const row = await tx('logs', 'readonly', (store) => req2promise(store.get(logId)));
      await tx('logs', 'readwrite', (store) => store.delete(logId));
      // 留下墓碑，否則下次同步會把它從別台裝置救回來
      if (row && row.uid) await api.addTombstone('logs', row.uid);
    },

    allLogs() {
      return tx('logs', 'readonly', (store) => req2promise(store.getAll()));
    },

    setState(state) {
      // updatedAt 是合併時判斷「誰比較新」的依據
      return tx('state', 'readwrite', (store) => store.put({ updatedAt: Date.now(), ...state }));
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

    async addTombstone(kind, key) {
      const all = (await api.getMeta('tombstones')) || { logs: {}, sources: {} };
      all[kind] = all[kind] || {};
      all[kind][key] = Date.now();
      await api.setMeta('tombstones', all);
      return all;
    },

    async getTombstones() {
      const all = (await api.getMeta('tombstones')) || {};
      return { logs: all.logs || {}, sources: all.sources || {} };
    },

    /** 直接覆寫成合併後的結果（同步用），不留墓碑。 */
    async replaceAll(dump) {
      await tx(['records', 'logs', 'state'], 'readwrite', (records, logs, state) => {
        records.clear(); logs.clear(); state.clear();
        (dump.records || []).forEach((r) => records.put(r));
        (dump.logs || []).forEach((l) => {
          const row = { ...l };
          delete row.logId;          // 讓本機重新配號，避免兩台裝置的流水號互撞
          logs.add(row);
        });
        (dump.states || []).forEach((st) => state.put(st));
      });
      if (dump.tombstones) await api.setMeta('tombstones', dump.tombstones);
    },

    async exportAll() {
      const [records, logs, states, tombstones] = await Promise.all([
        api.allRecords(), api.allLogs(), api.allStates(), api.getTombstones(),
      ]);
      return {
        version: 2,
        exportedAt: new Date().toISOString(),
        records, logs, states, tombstones,
      };
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

  api.newUid = newUid;
  global.Store = api;
})(window);
