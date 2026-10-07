#!/usr/bin/env bash
# Pull the latest main, rebuild and restart SongTransfer.
# Run on the server as root:  bash /var/www/songtransfer/deploy/update.sh
set -euo pipefail

APP_DIR=/var/www/songtransfer
NODE_BIN=/opt/node-v22.23.3/bin
BRANCH=main

[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行（sudo bash $0）。" >&2; exit 1; }
cd "$APP_DIR"
[ -d .git ] || {
  echo "$APP_DIR 不是 git 仓库，这个脚本没法用 git 更新。" >&2
  echo "先告诉 Claude 你平时是怎么把代码传到服务器的。" >&2
  exit 1
}

# Run every step as whoever owns the checkout, so file ownership stays as it is.
OWNER=$(stat -c %U "$APP_DIR")
as_owner() {
  sudo -u "$OWNER" env PATH="$NODE_BIN:$PATH" \
    npm_config_cache=/tmp/songtransfer-npm-cache NEXT_TELEMETRY_DISABLED=1 "$@"
}

echo "==> 拉取 $BRANCH（以 $OWNER 身份）"
as_owner git fetch origin "$BRANCH"
if ! as_owner git diff --quiet || ! as_owner git diff --cached --quiet; then
  echo "服务器上的代码有未提交的改动，已停止，避免覆盖：" >&2
  as_owner git status --short >&2
  exit 1
fi
BEFORE=$(as_owner git rev-parse --short HEAD)
as_owner git merge --ff-only "origin/$BRANCH"
AFTER=$(as_owner git rev-parse --short HEAD)
echo "    $BEFORE → $AFTER"

echo "==> 安装依赖"
as_owner npm ci --no-audit --no-fund

echo "==> 构建"
as_owner npm run build

echo "==> 重启服务"
systemctl restart songtransfer
# The worker stops gracefully (finishes in-flight requests, up to 110 s).
systemctl restart songtransfer-worker

echo "==> 检查网页服务"
for i in $(seq 1 20); do
  if curl -fsS -o /dev/null http://127.0.0.1:3002/; then
    echo "    正常运行（$AFTER）"
    systemctl --no-pager --lines=0 status songtransfer songtransfer-worker | grep -E "●|Active:"
    exit 0
  fi
  sleep 1
done
echo "网页服务 20 秒内没有响应，最近日志：" >&2
journalctl -u songtransfer -n 40 --no-pager >&2
exit 1
