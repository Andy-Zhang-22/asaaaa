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
      req.onsuccess = () => {
        const db = req.result;
        /*
         * 連線斷掉就把快取丟掉，下一次會重開。
         *
         * 這個連線原本是開一次用到分頁關掉為止。但瀏覽器會自己把它收掉——手機把
         * 網站擱在背景一陣子、系統要回收資源、或是另一個分頁要升級資料庫，都會。
         * 收掉之後 db.transaction() 每次都丟 InvalidStateError，而快取還留著那個
         * 死掉的連線，所以「存不進去」會一直持續到使用者自己重新整理為止——
         * 使用者回報的「儲存訪談紀錄失敗，重打一次還是失敗」就是這個。
         */
        db.onclose = () => { if (dbPromise === thisOpen) dbPromise = null; };
        db.onversionchange = () => {
          db.close();
          if (dbPromise === thisOpen) dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
    // 開失敗的 promise 不能留著：留著的話這一輩子每次呼叫都拿到同一個失敗
    const thisOpen = dbPromise;
    dbPromise.catch(() => { if (dbPromise === thisOpen) dbPromise = null; });
    return dbPromise;
  }

  function runTx(storeNames, mode, fn) {
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

  /** 連線死掉的徵兆。內容出錯（資料不合法之類）不算，那種重試也沒用。 */
  function connectionLost(err) {
    if (!err) return false;
    const name = err.name || '';
    const msg = String(err.message || '');
    return name === 'InvalidStateError' || name === 'UnknownError'
      || /clos(ing|ed)|connection|database is not open/i.test(msg);
  }

  /*
   * 連線斷了就重開再試一次。
   *
   * 重試是安全的：IndexedDB 的交易是全有全無，中途失敗一定整個回捲，
   * 不會留下寫到一半的東西，所以同一批動作再做一次不會變成兩筆。
   */
  function tx(storeNames, mode, fn) {
    return runTx(storeNames, mode, fn).catch((err) => {
      if (!connectionLost(err)) throw err;
      dbPromise = null;
      return runTx(storeNames, mode, fn);
    });
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

    /*
     * 刪掉一家客戶。
     *
     * 除了本來的 id 墓碑，再記一次「這家公司」的墓碑（統編＋公司名）。
     * id 墓碑只擋得住同一份名單裡的同一筆；使用者主動刪掉的公司，下次匯入
     * 另一份名單時會換一個 id，照樣整批回來。記公司本身才擋得住。
     *
     * 只在這裡記——deleteRecordsById（重匯覆蓋）跟 wipe（清空）都不記，
     * 那兩個不是「不要這家公司」的意思。
     */
    async deleteRecord(id) {
      const before = await tx('records', 'readonly', (store) => req2promise(store.get(id)));
      await tx('records', 'readwrite', (store) => store.delete(id));
      if (before) {
        for (const key of window.Normalize.companyKeys(before)) {
          await api.addTombstone('companies', key, { company: before.company, taxId: before.taxId || '' });
        }
      }

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
    /*
     * 找出那一則紀錄：先用 logId，找不到再用 uid。
     *
     * logId 是 IndexedDB 的自動編號，**同步過後會重新編號**（replaceAll 會把 logId
     * 拿掉讓本機重配，避免兩台裝置撞號）。所以畫面上拿在手裡的 logId 可能已經對不到
     * 任何一列了——使用者回報的「無法更新訪談紀錄」就是這個。
     * uid 才是跨裝置穩定的身分，logId 對不到就改用它。
     */
    async findLog(logId, uid) {
      if (logId !== undefined && logId !== null) {
        const row = await tx('logs', 'readonly', (store) => req2promise(store.get(logId)));
        if (row) return row;
      }
      if (!uid) return null;
      const all = await api.allLogs();
      return all.find((l) => l.uid === uid) || null;
    },

    /*
     * 找不到就丟錯，不要回 null。
     *
     * 原本是 return null 靜靜結束——呼叫端的 try/catch 不會觸發，畫面照樣跳
     * 「已更新這則紀錄」，但內容根本沒變。使用者看到的就是「改了，可是沒改到」。
     * 寫完再讀回來對一次，確定真的寫進去了。
     */
    async updateLog(logId, patch, uid) {
      const row = await api.findLog(logId, uid);
      if (!row) throw new Error('找不到這則紀錄（可能剛同步過，編號變了），請重新整理再試一次');
      const next = { ...row, ...patch, logId: row.logId, uid: row.uid,
        createdAt: row.createdAt, updatedAt: Date.now() };
      await tx('logs', 'readwrite', (store) => store.put(next));
      const back = await tx('logs', 'readonly', (store) => req2promise(store.get(row.logId)));
      if (!back || back.text !== next.text) throw new Error('寫得進去卻讀不回來');
      return next;
    },

    async deleteLog(logId, uid) {
      const row = await api.findLog(logId, uid);
      if (!row) throw new Error('找不到這則紀錄（可能剛同步過，編號變了），請重新整理再試一次');
      await tx('logs', 'readwrite', (store) => store.delete(row.logId));
      // 留下墓碑，否則下次同步會把它從別台裝置救回來
      if (row.uid) await api.addTombstone('logs', row.uid);
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

    /*
     * meta 值除了時間戳也可以帶一點資訊（info）。公司墓碑要能列出「你排除了哪幾家」
     * 讓使用者看得懂並且能收回，只存時間戳的話畫面上只剩 name:某某公司 這種鍵。
     * 舊資料是純數字，讀的地方都要能接受兩種形狀。
     */
    async addTombstone(kind, key, info) {
      const all = (await api.getMeta('tombstones')) || { logs: {}, sources: {}, records: {} };
      all[kind] = all[kind] || {};
      all[kind][key] = info ? { at: Date.now(), ...info } : Date.now();
      await api.setMeta('tombstones', all);
      return all;
    },

    /*
     * 一次補上多家公司的墓碑。
     *
     * addTombstone 一次只寫一個鍵，而每一次都要把整包 tombstones 讀出來再寫回去。
     * 經濟部的登記清冊一次四千多筆，靠舊墓碑認出好幾百家時就是好幾百趟
     * IndexedDB 來回，畫面會卡住。整包只讀一次、寫一次。
     */
    async addCompanyTombstones(list) {
      if (!list || !list.length) return 0;
      const all = (await api.getMeta('tombstones')) || {};
      all.companies = all.companies || {};
      const now = Date.now();
      let n = 0;
      list.forEach(({ key, company, taxId }) => {
        if (!key) return;
        all.companies[key] = { at: now, company: company || '', taxId: taxId || '' };
        n += 1;
      });
      if (n) await api.setMeta('tombstones', all);
      return n;
    },

    /*
     * 收回一家公司的排除（使用者明確表示還是要這家）。
     *
     * 不能直接把鍵刪掉：墓碑同步是「聯集」合併，這台刪掉之後下一次同步
     * 雲端那份又會把它加回來，收回等於沒收回，而且是無聲的。
     * 改成留著鍵、寫一筆比較新的「已收回」標記，合併時取新的就會贏。
     */
    async liftCompanyTombstones(keys, info, opts) {
      const all = (await api.getMeta('tombstones')) || {};
      all.companies = all.companies || {};
      const force = !!(opts && opts.force);
      let n = 0;
      keys.forEach((k) => {
        // force：舊版刪掉的沒有公司墓碑可以收回，但那張 id 墓碑照樣擋得住匯入，
        // 所以要主動留下「已收回」標記，比對時才蓋得過去
        if (!force && all.companies[k] === undefined) return;
        all.companies[k] = { at: Date.now(), lifted: true, ...(info || {}) };
        n += 1;
      });
      if (n) await api.setMeta('tombstones', all);
      return n;
    },

    async getTombstones() {
      const all = (await api.getMeta('tombstones')) || {};
      // 每加一種墓碑都要記得列在這裡。漏掉的話墓碑存得進去卻永遠傳不出去，
      // 刪除在本機看起來成功，同步一次就被另一台原封不動地救回來。
      return {
        logs: all.logs || {}, sources: all.sources || {}, records: all.records || {},
        companies: all.companies || {},
      };
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
