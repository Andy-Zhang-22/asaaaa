# 政府資料來源探測結果

探測時間：2026-09-16T04:35:15.322Z
樣本統編：22099131

| 來源 | 狀態 | Content-Type | CORS | 大小 |
|---|---|---|---|---|
| findbiz-queryinit | 403 | text/plain | (沒有這個標頭) | 105 |
| gcis-od-company | 403 | text/plain | (沒有這個標頭) | 107 |
| gcis-od-company-cors | 403 | text/plain | (沒有這個標頭) | 107 |
| gcis-report-city | 403 | text/plain | (沒有這個標頭) | 107 |

## 各來源細節

### 商工登記公示資料查詢服務（使用者指定的網址）

- 網址：`https://findbiz.nat.gov.tw/fts/query/QueryBar/queryInit.do`
- 用途：這是給人操作的查詢畫面，預期拿到 HTML；要看它有沒有擋程式存取、需不需要 session。
- 結果：403
- CORS 標頭：(沒有這個標頭)

```
Host not in allowlist: findbiz.nat.gov.tw. Add this host to your network egress settings to allow access.
```

### 商工行政資料開放平臺：公司登記基本資料 API

- 網址：`https://data.gcis.nat.gov.tw/od/data/api/5F64D864-61CB-4D0D-8AD9-492047CC1EA6?%24format=json&%24filter=Business_Accounting_NO%20eq%2022099131&%24skip=0&%24top=1`
- 用途：官方開放資料，跟 findbiz 同一份來源。這是最該優先用的正規管道。
- 結果：403
- CORS 標頭：(沒有這個標頭)

```
Host not in allowlist: data.gcis.nat.gov.tw. Add this host to your network egress settings to allow access.
```

### 同上，但檢查 CORS 標頭（決定能不能直接從瀏覽器呼叫）

- 網址：`https://data.gcis.nat.gov.tw/od/data/api/5F64D864-61CB-4D0D-8AD9-492047CC1EA6?%24format=json&%24filter=Business_Accounting_NO%20eq%2022099131&%24skip=0&%24top=1`
- 用途：有 Access-Control-Allow-Origin 的話，網站就能自己查，不必經過這個排程。
- 結果：403
- CORS 標頭：(沒有這個標頭)

```
Host not in allowlist: data.gcis.nat.gov.tw. Add this host to your network egress settings to allow access.
```

### 公司變更登記（增資）縣市統計查詢頁

- 網址：`https://serv.gcis.nat.gov.tw/pub/cmpy/reportCity.jsp`
- 用途：使用者先前指定的增資名單來源。要看它是靜態頁還是要帶查詢參數。
- 結果：403
- CORS 標頭：(沒有這個標頭)

```
Host not in allowlist: serv.gcis.nat.gov.tw. Add this host to your network egress settings to allow access.
```
