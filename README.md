# care-api（Care Matching 照護媒合的 Node.js 後端）

從 haiglobals-api（`haiglobals-node-functions`，分支 `feat/care-ecpay`）分出來的 care 專用後端：綠界金流（儲值／訂閱／退款／回呼）、推播（FCM／APNs 來電與一般通知）、翻譯（LibreTranslate）、帳號刪除。
每支 API 一個檔案：`src/functions/<name>.ts`，`default export` 為 handler；`src/server.ts` 啟動時自動掃描 `functions/`，免登記。路徑 `/functions/v1/<name>`（App 用）或 `/<name>`（本機測試）。

管理方式照 Higlobal：**repo 只有 `main`**，測試與正式環境「只差 `.env`」；一個容器 `care-api`，平常單獨測某支 API，測完再更新進容器。

## 本機開發與單支 API 測試

```bash
cp .env.example .env        # 填 staging 的值（SUPABASE_URL=https://api-staging.haiglobals.com …）
npm install
npm run dev                 # tsx watch，http://127.0.0.1:9100
curl -s http://127.0.0.1:9100/hello
curl -s -X POST http://127.0.0.1:9100/functions/v1/send-notification -H "Authorization: Bearer <service_role 或 CRON_PUSH_SECRET>" -H "Content-Type: application/json" -d '{"to_user_id":"…","title":"t","body":"b","route":"schedule"}'
npm run typecheck && npm run lint
```

`.env` 的 `ENVIRONMENT` 要和 `SUPABASE_URL` 對得上（staging ↔ api-staging、production ↔ api），別讓測試程式碼打到正式庫。

## 部署（server `hejijun@osmile`，目錄 `/srv/staging/carematching/apps/care-api`）

同 Higlobal 的 `git pull` + restart，只是 restart 換成 docker compose（原始碼會 bake 進 image，改檔一定要 `--build`）：

```bash
# 1. 本機：測完 push 到 GitHub main
git add … && git commit -m "…" && git push

# 2. server：拉下來、重建、看 log
ssh hejijun@osmile
cd /srv/staging/carematching/apps/care-api
git pull --ff-only
docker compose up -d --build
docker logs -f --tail 100 care-api
curl -s http://127.0.0.1:9100/hello
```

容器只綁 `127.0.0.1:9100`，對外由 host Caddy（`/etc/caddy/tenants.d/carematching/care.caddy`）以 `carematching.haiglobals.com`／`ecpay.care-matching.com` 反向代理。
`.env` 與 `secrets/`（APNs `.p8`）留在 server 目錄、唯讀掛進容器，不進 image、不進 git。

切到正式環境時：改 server 上的 `.env`（正式 Supabase key、綠界正式商店與端點、`APNS_ENV=production`、新的 `CRON_PUSH_SECRET`），`docker compose up -d`，再把 DB `care_push_config.cron_key` 與三個推播函式（`push_notify`、`dispatch_due_care_reminders`、`push_on_guarantee_arrears`）內的網址對齊。

## 與資料庫的關係

care 資料在 schema `pro_care_matching`（`_shared_care/db.ts` 的 `CARE_DB_SCHEMA`，PostgREST 需帶 `Accept-Profile`／`Content-Profile`）。
特權 RPC（`admin_*`、`push_notify`、`try_claim_push_idem`、`dispatch_due_care_reminders`）只開給 `service_role`；本服務用 service_role key 呼叫，App 端不可直接呼叫。

## 來源與歷史

2026-09-02 以 server 上實際運行的版本建立 repo：= haiglobals-api `feat/care-ecpay` `412c6e0` 全部檔案 + 只存在 server 的 4 支 care function（`send-notification`、`send-call-push`、`send-call-cancel`、`translate`）。
`src/functions/haiglobals-*` 與 `src/_shared_haiglobals/` 是從 haiglobals 帶過來的共用碼，care 只用到 `_shared/ecpay_*`、`_shared/env.ts` 與 `_shared_care/`；未來可再精簡。
