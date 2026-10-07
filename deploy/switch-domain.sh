#!/usr/bin/env bash
# One-off: move SongTransfer from song.7227.org to songtransfer.net.
# Run on the server as root AFTER the DNS A record points here and
# AFTER deploy/update.sh has pulled the commit that contains this file:
#   bash /var/www/songtransfer/deploy/switch-domain.sh
set -euo pipefail

DOMAIN=songtransfer.net
SERVER_IP=216.23.121.166
APP_DIR=/var/www/songtransfer
SITE=/etc/nginx/sites-available/songtransfer
ENV_FILE=/etc/songtransfer.env
WEBROOT=/var/www/letsencrypt
TEMP_SITE=/etc/nginx/sites-enabled/zz-songtransfer-acme
STAMP=$(date +%Y%m%d-%H%M%S)

[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行（sudo bash $0）。" >&2; exit 1; }

# ---- 1. DNS must already point here --------------------------------------
resolve() { getent ahostsv4 "$1" | awk 'NR==1 {print $1}'; }
apex_ip=$(resolve "$DOMAIN" || true)
if [ "$apex_ip" != "$SERVER_IP" ]; then
  echo "$DOMAIN 目前解析到「${apex_ip:-无记录}」，还不是 $SERVER_IP。" >&2
  echo "在域名商那里加 A 记录 @ → $SERVER_IP，生效后再运行。" >&2
  exit 1
fi
CERT_ARGS=(-d "$DOMAIN")
if [ "$(resolve "www.$DOMAIN" || true)" = "$SERVER_IP" ]; then
  CERT_ARGS+=(-d "www.$DOMAIN")
  echo "==> $DOMAIN 和 www.$DOMAIN 都已指向本机"
else
  echo "==> $DOMAIN 已指向本机（www 没有解析，证书只签主域名）"
fi

# ---- 2. Certificate (webroot, so certbot never edits nginx config) ---------
if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  echo "==> 证书已存在，跳过申请"
else
  echo "==> 临时开放 $DOMAIN 的证书验证路径"
  mkdir -p "$WEBROOT"
  cat > "$TEMP_SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;
    location ^~ /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 404; }
}
EOF
  trap 'rm -f "$TEMP_SITE"; nginx -t >/dev/null 2>&1 && systemctl reload nginx' EXIT
  nginx -t
  systemctl reload nginx

  echo "==> 申请证书"
  certbot certonly --webroot -w "$WEBROOT" "${CERT_ARGS[@]}" \
    --non-interactive --keep-until-expiring

  rm -f "$TEMP_SITE"
  trap - EXIT
fi

# ---- 3. Nginx: new primary site, old domain redirects ----------------------
echo "==> 更新 Nginx 配置（原配置备份为 $SITE.bak-$STAMP）"
cp -a "$SITE" "$SITE.bak-$STAMP"
cp "$APP_DIR/deploy/nginx.conf" "$SITE"
if ! nginx -t; then
  echo "新配置检查失败，已恢复原配置。" >&2
  cp -a "$SITE.bak-$STAMP" "$SITE"
  exit 1
fi
systemctl reload nginx

# ---- 4. APP_URL --------------------------------------------------------------
echo "==> 更新 APP_URL（原文件备份为 $ENV_FILE.bak-$STAMP）"
cp -a "$ENV_FILE" "$ENV_FILE.bak-$STAMP"
if grep -q '^APP_URL=' "$ENV_FILE"; then
  sed -i "s|^APP_URL=.*|APP_URL=https://$DOMAIN|" "$ENV_FILE"
else
  echo "APP_URL=https://$DOMAIN" >> "$ENV_FILE"
fi
grep '^APP_URL=' "$ENV_FILE"

echo "==> 重启服务"
systemctl restart songtransfer songtransfer-worker

# ---- 5. Check ------------------------------------------------------------------
sleep 3
code=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/auth/status" || true)
old=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "https://song.7227.org/" || true)
echo "    https://$DOMAIN/api/auth/status → $code"
echo "    https://song.7227.org/ → $old"

cat <<EOF

完成。还剩一步要在浏览器里做：
  Spotify Developer Dashboard → 你的应用 → Settings → Redirect URIs
  添加：https://$DOMAIN/api/auth/callback
之后在新域名上重新连接一次 Spotify（旧域名的登录 Cookie 不会带过来）。
后台任务和数据库不受影响。
EOF
