#!/usr/bin/env bash
# switch-env.sh — 把唯一的 care-api 容器切到 staging 或 production（只換 .env，程式碼與 image 不變）。
#
#   ./scripts/switch-env.sh production   # .env.production -> .env，重啟容器
#   ./scripts/switch-env.sh staging      # .env.staging    -> .env，重啟容器
#
# 前提：目錄裡有 .env.production / .env.staging（都在 .gitignore，只存在 server）。
# 切到 production 前會擋下任何還標著 TODO-PROD 的欄位（例如綠界正式商店金鑰還沒填）。
set -euo pipefail

TARGET="${1:-}"
case "$TARGET" in
  production|staging) ;;
  *) echo "用法: $0 production|staging"; exit 2 ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SRC=".env.$TARGET"
[ -f "$SRC" ] || { echo "ERROR: 找不到 $SRC"; exit 1; }

if [ "$TARGET" = "production" ] && grep -q "TODO-PROD" "$SRC"; then
  echo "ERROR: $SRC 還有 TODO-PROD 未填的欄位："
  grep -n -A1 "TODO-PROD" "$SRC" | sed 's/=.*/=…/'
  exit 1
fi

env_value() { grep -E "^$2=" "$1" | tail -n 1 | cut -d= -f2- | tr -d '"\r'; }
ENVIRONMENT_VALUE="$(env_value "$SRC" ENVIRONMENT)"
SUPABASE_URL_VALUE="$(env_value "$SRC" SUPABASE_URL)"
case "$ENVIRONMENT_VALUE:$SUPABASE_URL_VALUE" in
  production:https://api.haiglobals.com*) ;;
  staging:https://api-staging.haiglobals.com*) ;;
  *) echo "ERROR: $SRC 的 ENVIRONMENT=$ENVIRONMENT_VALUE 與 SUPABASE_URL=$SUPABASE_URL_VALUE 對不上"; exit 1 ;;
esac

if [ -f .env ]; then
  BACKUP=".env.bak.$(date +%Y%m%d-%H%M%S)"
  cp .env "$BACKUP"
  echo "已備份目前的 .env -> $BACKUP"
fi
install -m 600 "$SRC" .env
echo "已套用 $SRC -> .env（ENVIRONMENT=$ENVIRONMENT_VALUE, SUPABASE_URL=$SUPABASE_URL_VALUE）"

docker compose up -d --force-recreate
sleep 5
echo "--- health:"
curl -s -m 10 -X POST http://127.0.0.1:9100/functions/v1/hello -H 'Content-Type: application/json' -d '{}' | head -c 160; echo
docker logs --tail 5 care-api 2>&1 | cut -c1-160
echo
echo "提醒：切到 production 後，正式庫 care_push_config.cron_key 必須等於這份 .env 的 CRON_PUSH_SECRET，controller 也要換成正式 .env。"
