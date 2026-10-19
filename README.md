# ProFit Health

本專案保留 HTML 前端、Express 5、serverless-http、Netlify Functions、Netlify Database PostgreSQL 與自訂 JWT 登入。

## 專案位置

- `public/`：所有現有 HTML 頁面與圖片；頁面網址未改變。
- `server/`：原始 Express API、資料庫介面與首次初始化流程。
- `netlify/functions/api.mjs`：Netlify 原生 Request／Response Function 包裝與 `/api/*` 路由轉接。
- `netlify/database/migrations/`：由 Netlify 平台管理的資料庫 migration。

Netlify 使用 `npm run build` 驗證前端腳本與連結，發佈目錄為 `public`，Functions 目錄為 `netlify/functions`。安裝依賴使用 `npm ci`。

## 初始化與安全

`JWT_SECRET` 與 `SETUP_KEY` 沿用既有 Netlify 設定，必須可供 Functions 使用。請勿將任何金鑰或密碼寫入原始碼、文件或版本控制。

資料庫優先透過 `@netlify/database` 取得 Netlify 執行期提供的 `NETLIFY_DB_URL`，避免舊的 `DATABASE_URL` 覆蓋 Preview 隔離資料庫。API 採用 Netlify 原生 Request／Response Function 介面；Netlify Database 不支援舊的 Lambda 相容 Function 介面。原生請求會轉接至既有 Express／serverless-http 處理流程，保留 JSON 解析、JWT、角色權限及 API 網址。代理程式的資料庫檢查連線可能是唯讀，不能用它作為可寫入的 Function 執行期連線。

首次使用時開啟 `/setup.html`，輸入既有初始化金鑰、管理員 Email 與自行選擇的測試密碼。初始化以同一筆交易建立三角色帳號與展示資料；再次執行會回傳 HTTP 409，不會覆蓋既有資料。帳號密碼只以 bcrypt 雜湊儲存，登入與權限檢查仍使用 JWT 與資料庫角色。

已套用的 `0001_initial` 不可修改、刪除或重新命名。未來若需要變更 schema，請新增 migration，由 Netlify 部署流程套用；不要手動重設 production 資料庫。

## Preview 驗證

先使用非 production 的 Preview 與隔離資料庫進行驗證，再決定是否發佈 production。若專案啟用 Netlify 存取保護，開啟 Preview 時須使用具有專案權限的 Netlify 帳號登入；HTML 的平台登入頁不是 API JSON 回應。

本次修復的測試範圍與實際部署限制記錄於 `.netlify/results.md`。

## 登入與註冊問題

註冊僅在資料庫確認 Email 重複時回傳 HTTP 409 與 `EMAIL_ALREADY_EXISTS`。登入／註冊頁會切換至登入並保留 Email，須使用原帳號密碼；重新註冊不會更換密碼，本專案目前沒有自助密碼重設功能。

資料庫連線、寫入權限或資料表異常會回傳 HTTP 503，不再誤報 Email 已存在或密碼錯誤。登入及註冊的資料庫錯誤紀錄只包含錯誤代碼，不包含原始連線資訊或使用者輸入。若 API 回傳 HTML 存取保護頁而非 JSON，前端會另外提示先完成 Netlify 存取驗證。

## 專家與學員配對

管理員在「管理員 Dashboard」選擇學員與專家建立配對，並可在「目前配對」清單中結束或恢復指導。只有配對中（active）的專家能查看該學員的運動明細、健康紀錄與目標，指派任務、給予回饋並回覆提問；結束指導後專家即無法再存取。學員若配對多位專家，提問時可選擇要詢問的專家。

## 管理員帳號

管理員只能由 `/setup.html` 建立或升級，註冊頁建立的帳號一律是學員。`0002_promote_admin_account` migration 會在資料庫中完全沒有管理員時，把先前以註冊頁建立、名稱為「admin／Admin」的帳號升級為管理員（密碼不變）。之後若要更換管理員，請使用 `/setup.html` 的「重設管理員帳密」。配對前，管理員須先在「專家資料維護」新增至少一位專家。

## 課程購買、綠界刷卡、QR Code 核銷與發票

- 管理員在「課程管理」（`/admin_courses.html`）上架兩種課程：**堂數課程**（例如教練 1 對 1 十堂 NT$1,000，可設定有效天數與負責專家）與**講座／活動**（例如營養講座，可設定時間、地點與名額）。
- 學員在「購買課程」（`/courses.html`）選擇課程與發票方式（會員載具、手機條碼、捐贈、公司統編）後，導向綠界信用卡付款頁。付款結果以綠界伺服器通知（`/api/ecpay/notify`）為準，學員返回網站時也會主動向綠界查詢作為備援；綠界後台「模擬付款」（`SimulatePaid=1`）依綠界規範只記錄、不變更訂單狀態。
- 付款成功後自動建立票券並向綠界 B2C 電子發票開立發票；失敗時可在「銷售統計」重新開立或作廢。
- 學員在「我的課程」（`/my_courses.html`）出示 QR Code。QR Code 為 10 分鐘有效的簽章代碼，每個只能核銷一次。管理員與負責專家在「QR Code 核銷」（`/checkin.html`）用手機相機掃描，確認後扣 1 堂或完成入場；管理員可撤銷誤刷並退回堂數。
- 「銷售統計」（`/admin_sales.html`）提供銷貨收入（含稅／未稅／稅額）、近 12 個月趨勢、各課程售出與堂數使用率、近 30 天核銷次數、訂單與發票清單及 CSV 匯出。

未設定環境變數時使用綠界官方公開的**測試環境**特店資料（金流 3002607、電子發票 2000132），不會實際扣款。測試卡號 4311-9522-2222-2222，有效期限填未來日期，安全碼任意，簡訊驗證碼 1234。正式上線時設定 `ECPAY_MODE=production`，並在 Netlify 環境變數設定 `ECPAY_MERCHANT_ID`、`ECPAY_HASH_KEY`、`ECPAY_HASH_IV`、`ECPAY_INVOICE_MERCHANT_ID`、`ECPAY_INVOICE_HASH_KEY`、`ECPAY_INVOICE_HASH_IV`（請勿寫入原始碼）。若網站網址需固定，可設定 `SITE_BASE_URL`。

## 運動手錶同步（Strava / Apple 捷徑）

學員在「運動紀錄」頁的「連結運動手錶」區塊設定。匯入的紀錄以來源與外部編號去重，重複同步只會更新、不會重複新增。

**Strava**：到 strava.com/settings/api 建立應用程式，「Authorization Callback Domain」填網站網域（例如 `nancy-profit-health.netlify.app`），再於 Netlify 環境變數設定 `STRAVA_CLIENT_ID` 與 `STRAVA_CLIENT_SECRET`（請勿寫入原始碼）並重新部署。部署後由管理員在「管理員 Dashboard」按「啟用自動同步（Webhook）」，學員在 Strava 完成運動後就會自動匯入；未啟用 Webhook 時，學員開啟運動紀錄頁也會自動補同步。Strava token 以 AES-256-GCM 加密儲存，金鑰由 `JWT_SECRET` 衍生，更換 `JWT_SECRET` 後學員需要重新連結。

**Apple 捷徑**：學員產生個人上傳金鑰（資料庫只存雜湊），在 iPhone「捷徑」App 以 POST JSON 呼叫 `/api/shortcut/upload`，標頭 `Authorization: Bearer <金鑰>`。欄位：`steps`、`exercise_minutes`、`active_calories`、`heart_rate`、`distance_km`、`date`（yyyy-MM-dd，預設台灣時間今天），以及選填的 `workouts` 陣列（`type`、`start`、`duration` 分鐘、`calories`、`heart_rate`、`distance_km`）。每天一筆「Apple Watch 每日活動」，會扣除同一天已上傳的體能訓練，避免重複計算。

## 匯出專案至 GitHub

發布最新版本後，以管理員帳號登入 `admin_dashboard.html`，點選「下載完整專案 ZIP」。此下載沿用管理員驗證，不會公開後端原始碼。解壓縮後，將檔案上傳至 GitHub 儲存庫，讓 `package.json` 和 `netlify.toml` 位於最外層。

壓縮檔包含目前版本的前端、後端、套件鎖定檔、部署設定及全部資料庫 migration，不包含線上資料庫資料、環境變數、安裝套件或本機狀態。每次建置都會重新產生此版本的壓縮檔；本機也可執行 `npm run package:source`，輸出位於 `server/exports/nancy-profit-health-source.zip`。

## 專家出勤與薪資試算

管理員可在「專家資料維護」新增專家時，選擇兼職時薪、固定月薪或按堂計酬，並設定金額；此設定存入台灣時間的當月份。既有專家與其他月份可由「出勤與薪資」頁分別設定，每月資料獨立保存，未設定月份不會自動套用其他月份的薪資。

專家從後台進入「出勤與薪資」上下班打卡，只能查看自己的薪資及出勤；管理員可查看所有專家，修改所選月份的計薪方式、金額及確認授課堂數。重複上班打卡受到資料庫唯一索引保護，未上班不能下班，打卡時間以伺服器為準。

時薪試算採已完成班次的實際工時，跨月班次按 Asia/Taipei 月界分攤，未下班班次不計入工時，休息時間不自動扣除。工時畫面顯示至小數點後兩位，金額依完整工時計算並四捨五入至小數點後兩位。固定月薪採整月設定金額，按堂計酬採管理員確認堂數乘以單堂金額，不使用學員核銷次數。試算不含到離職比例、請假扣款、加班、保險與稅金，也不執行匯款。出勤清單顯示所選月份及未結束班次，最多最近 500 筆；薪資彙總不受此清單上限影響。

新增的 `0005_expert_payroll` migration 由部署平台自動套用，既有四份 migration 保持不變。可使用 `node --test test/payroll.test.cjs` 驗證角色隔離、打卡狀態、跨月工時、三種計薪方式與建立專家時的薪資設定；測試使用獨立的暫存 PostgreSQL 相容資料庫，不連線至網站資料庫。
