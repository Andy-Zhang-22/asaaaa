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

    /**
     * 刪掉單一筆客戶，連同他的通話紀錄與追蹤狀態。
     *
     * 一樣要留墓碑：只從這台刪掉的話，下次同步會從另一台原封不動地救回來，
     * 使用者會以為刪除功能壞了。墓碑的時間戳也讓重新匯入同一份 PDF 時，
     * 比墓碑新的資料可以正常回來（那是使用者自己又匯入的，不是同步救回來的）。
     */
    /**
     * 匯入時覆蓋用：只把舊的那筆客戶資料刪掉，通話紀錄與追蹤狀態留著。
     *
     * 跟 deleteRecord 的差別就在這裡——那個是使用者真的要刪掉這家公司，
     * 連紀錄一起清；這個是同一家公司換一份新資料，紀錄必須繼續掛在同一個 id 上。
     * 也不留墓碑，否則新資料存進去會被同步當成「已刪除」而消失。
     */
    async deleteRecordsById(ids) {
      await tx('records', 'readwrite', (store) => ids.forEach((id) => store.delete(id)));
      return ids.length;
    },

    async deleteRecord(id) {
      await tx('records', 'readwrite', (store) => store.delete(id));

      const logs = await api.allLogs();
      const mine = logs.filter((l) => l.recordId === id);
      await tx('logs', 'readwrite', (store) => mine.forEach((l) => store.delete(l.logId)));
      for (const l of mine) { if (l.uid) await api.addTombstone('logs', l.uid); }

      await tx('state', 'readwrite', (store) => store.delete(id));
      await api.addTombstone('records', id);
      return mine.length;
    },

    addLog(log) {
      const row = { uid: newUid(), createdAt: Date.now(), ...log };
      return tx('logs', 'readwrite', (store) => req2promise(store.add(row)));
    },

    /**
     * 修改已經存下的通話紀錄。
     *
     * 保留原本的 uid 與 createdAt：uid 是同步時判斷「這是同一筆」的依據，
     * 換掉的話別台裝置會當成新的一筆，結果變兩則。改動時間另外記在 updatedAt，
     * 讓同步端知道哪一邊比較新。
     */
    async updateLog(logId, patch) {
      const row = await tx('logs', 'readonly', (store) => req2promise(store.get(logId)));
      if (!row) return null;
      const next = { ...row, ...patch, logId: row.logId, uid: row.uid,
        createdAt: row.createdAt, updatedAt: Date.now() };
      await tx('logs', 'readwrite', (store) => store.put(next));
      return next;
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

    /**
     * 讀單一筆追蹤狀態。
     *
     * 寫入前要先讀這一筆最新的內容再合併，不能只靠記憶體裡的副本：背景在跑的
     * 商工登記更新、另一個分頁、同步完成後的重載都會改到同一列，拿舊副本整列
     * 覆寫回去，中間別人寫的欄位（例如剛連好的關係企業）就這樣沒了。
     */
    getState(recordId) {
      return tx('state', 'readonly', (store) => req2promise(store.get(recordId)));
    },

    setMeta(key, value) {
      return tx('meta', 'readwrite', (store) => store.put({ key, value }));
    },

    async getMeta(key) {
      const row = await tx('meta', 'readonly', (store) => req2promise(store.get(key)));
      return row ? row.value : undefined;
    },

    async addTombstone(kind, key) {
      const all = (await api.getMeta('tombstones')) || { logs: {}, sources: {}, records: {} };
      all[kind] = all[kind] || {};
      all[kind][key] = Date.now();
      await api.setMeta('tombstones', all);
      return all;
    },

    async getTombstones() {
      const all = (await api.getMeta('tombstones')) || {};
      // 每加一種墓碑都要記得列在這裡。漏掉的話墓碑存得進去卻永遠傳不出去，
      // 刪除在本機看起來成功，同步一次就被另一台原封不動地救回來。
      return { logs: all.logs || {}, sources: all.sources || {}, records: all.records || {} };
    },

    /** 直接覆寫成合併後的結果（同步用），不留墓碑。 */
    /*
     * 會跟著同步的設定（商工登記的代理網址、資料集網址、鏡像、每天自動更新）。
     * 這些原本只存在各台裝置的 localStorage，在電腦上設定好、手機打開還是空的，
     * 使用者看到的是「這台不能用、那台可以」。存一份到 meta 跟著雲端走，
     * 合併時同一個鍵取比較新的，套用時再寫回 localStorage（registry.js 讀的地方）。
     */
    async setSetting(key, value) {
      const all = (await api.getMeta('settings')) || {};
      all[key] = { v: value || '', at: Date.now() };
      await api.setMeta('settings', all);
      try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch (e) { /* 無痕模式 */ }
    },

    applySettings(settings) {
      Object.entries(settings || {}).forEach(([key, entry]) => {
        if (!entry || typeof entry !== 'object') return;
        try { if (entry.v) localStorage.setItem(key, entry.v); else localStorage.removeItem(key); } catch (e) { /* 無痕模式 */ }
      });
    },

    async replaceAll(dump) {
      if (dump.settings) { await api.setMeta('settings', dump.settings); api.applySettings(dump.settings); }
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
      const [records, logs, states, tombstones, settings] = await Promise.all([
        api.allRecords(), api.allLogs(), api.allStates(), api.getTombstones(), api.getMeta('settings'),
      ]);
      return {
        version: 2,
        exportedAt: new Date().toISOString(),
        records, logs, states, tombstones, settings: settings || {},
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

    /*
     * 清空所有名單，而且要能傳到其他裝置。
     *
     * 舊版是把四個 store 全部 clear()，包括 meta。這在有開雲端同步時是錯的：
     * 同步是「聯集」合併，本機清空之後下一次同步會把雲端那份整個合併回來，
     * 看起來就像清除失效；而 meta 裡的墓碑和 driveFileId 也一起被清掉，
     * 等於把唯一能把「刪除」傳出去的機制也砍了。
     *
     * 正確做法是走既有的墓碑機制：每個來源、每則通話紀錄各留一個墓碑，
     * 再清掉資料。meta 不動——墓碑要留著才傳得出去，同步設定也要留著。
     * 之後匯入的新名單 importedAt 會比墓碑新，照常存活，跟重新匯入同一份 PDF 的
     * 行為一致。
     */
    async wipe() {
      const [records, logs] = await Promise.all([api.allRecords(), api.allLogs()]);
      const all = (await api.getMeta('tombstones')) || { logs: {}, sources: {}, records: {} };
      const now = Date.now();
      all.sources = all.sources || {};
      all.logs = all.logs || {};
      new Set(records.map((r) => r.source)).forEach((src) => { if (src) all.sources[src] = now; });
      logs.forEach((l) => { if (l.uid) all.logs[l.uid] = now; });
      await api.setMeta('tombstones', all);
      await tx(['records', 'logs', 'state'], 'readwrite', (a, b, c) => {
        a.clear(); b.clear(); c.clear();
      });
      return { records: records.length, logs: logs.length };
    },
  };

  api.newUid = newUid;
  global.Store = api;
})(window);
