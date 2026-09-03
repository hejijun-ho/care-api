# care-api（Care Matching 照護媒合的 Node.js 後端）

從 haiglobals-api（`haiglobals-node-functions`，分支 `feat/care-ecpay`）分出來的 care 專用後端：綠界金流（儲值／訂閱／退款／回呼）、推播（FCM／APNs 來電與一般通知）、翻譯（LibreTranslate）、帳號刪除。
每支 API 一個檔案：`src/functions/<name>.ts`，`default export` 為 handler；`src/server.ts` 啟動時自動掃描 `functions/`，免登記。路徑 `/functions/v1/<name>`（App 用）或 `/<name>`（本機測試）。

管理方式照 Higlobal：**repo 只有 `main`**，測試與正式環境「只差 `.env`」，兩個目錄各自 `git pull`、各跑一個容器：

| | 目錄（server） | 容器 | 埠 | 對外網址 |
|---|---|---|---|---|
| 測試 | `/srv/staging/carematching/apps/care-api` | `care-api-staging` | 127.0.0.1:9100 | `carematching.haiglobals.com`、`ecpay.care-matching.com` |
| 正式 | `/srv/production/carematching/apps/care-api` | `care-api` | 127.0.0.1:9101 | `api.care-matching.com` |

各目錄的 `.env` 除了應用設定，還帶三個給 docker-compose 的變數：`CARE_API_PROJECT`（專案／容器名）、`CARE_API_IMAGE`（`care-api:staging` / `care-api:prod`，一定要分開）、`CARE_API_HOST_PORT`。

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

# 2. server：測試目錄先拉下來、重建、看 log
ssh hejijun@osmile
cd /srv/staging/carematching/apps/care-api
git pull --ff-only
docker compose up -d --build
docker logs -f --tail 100 care-api-staging
curl -s -X POST http://127.0.0.1:9100/functions/v1/hello -H 'Content-Type: application/json' -d '{}'

# 3. 測完再上正式（同樣兩行）
cd /srv/production/carematching/apps/care-api
git pull --ff-only && docker compose up -d --build
docker logs --tail 50 care-api
```

容器只綁 127.0.0.1，對外由 host Caddy（`/etc/caddy/tenants.d/carematching/care.caddy`）反向代理。
`.env` 與 `secrets/`（APNs `.p8`）留在 server 目錄、唯讀掛進容器，不進 image、不進 git。
Docker Hub 偶爾逾時會讓 `--build` 失敗：舊 image 還在，先 `docker compose up -d --no-build` 把服務拉起來，稍後再 build。

推播用的 care-api 網址由各環境資料庫的 `care_push_config`（`k='notify_url'`）決定，`cron_key` 則要等於該環境 `.env` 的 `CRON_PUSH_SECRET`。`scripts/switch-env.sh` 是單容器時期的切換工具，現在留作備援。

## 與資料庫的關係

care 資料在 schema `pro_care_matching`（`_shared_care/db.ts` 的 `CARE_DB_SCHEMA`，PostgREST 需帶 `Accept-Profile`／`Content-Profile`）。
特權 RPC（`admin_*`、`push_notify`、`try_claim_push_idem`、`dispatch_due_care_reminders`）只開給 `service_role`；本服務用 service_role key 呼叫，App 端不可直接呼叫。

## 來源與歷史

2026-09-02 以 server 上實際運行的版本建立 repo：= haiglobals-api `feat/care-ecpay` `412c6e0` 全部檔案 + 只存在 server 的 4 支 care function（`send-notification`、`send-call-push`、`send-call-cancel`、`translate`）。
`src/functions/haiglobals-*` 與 `src/_shared_haiglobals/` 是從 haiglobals 帶過來的共用碼，care 只用到 `_shared/ecpay_*`、`_shared/env.ts` 與 `_shared_care/`；未來可再精簡。
