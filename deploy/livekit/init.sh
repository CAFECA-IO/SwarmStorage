#!/bin/sh
# Info: (20261106 - Luphia)
# 共用 LiveKit 的初始化：第一次執行時隨機產生各服務的 API key / secret，之後沿用
# 每次啟動依 .env 重新產生 livekit.yaml、Caddyfile 與給 DropHere / Hills 的連線設定
#
#   init.sh                 產生 (或更新) 設定
#   init.sh show drophere   印出 DropHere 的 .env.local 內容 (hills 同理)
#   init.sh rotate drophere 重新產生某一組金鑰 (drophere | hills | webhook)
set -eu
umask 077

CONFIG_DIR=${CONFIG_DIR:-/config}
SECRETS="$CONFIG_DIR/secrets.env"

# Info: (20261106 - Luphia) 只含英數字，避免 YAML / shell 跳脫問題
random() {
  head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"
}

new_secrets() {
  case "$1" in
    drophere) echo "DROPHERE_API_KEY=API$(random 13)" ; echo "DROPHERE_API_SECRET=$(random 48)" ;;
    hills)    echo "HILLS_API_KEY=API$(random 13)" ; echo "HILLS_API_SECRET=$(random 48)" ;;
    webhook)  echo "WEBHOOK_API_KEY=API$(random 13)" ; echo "WEBHOOK_API_SECRET=$(random 48)" ;;
    *) echo "unknown key set: $1 (drophere | hills | webhook)" >&2; exit 1 ;;
  esac
}

ensure_secrets() {
  mkdir -p "$CONFIG_DIR"
  if [ ! -s "$SECRETS" ]; then
    { new_secrets drophere; new_secrets hills; new_secrets webhook; } > "$SECRETS"
    echo "[init] 已產生新的 API key / secret（保存在 config volume，重新部署時沿用）"
  fi
}

show() {
  case "${1:-}" in
    drophere|hills) cat "$CONFIG_DIR/$1.env" ;;
    *) echo "usage: init.sh show drophere|hills" >&2; exit 1 ;;
  esac
}

rotate() {
  ensure_secrets
  name=${1:-}
  prefix=$(echo "$name" | tr 'a-z' 'A-Z')
  new_secrets "$name" > "$SECRETS.new"
  grep -v "^${prefix}_API_" "$SECRETS" >> "$SECRETS.new"
  mv "$SECRETS.new" "$SECRETS"
  echo "[init] 已重新產生 $name 的金鑰；請執行 docker compose restart livekit 套用，並更新使用這組金鑰的服務 (show 取得新設定)"
}

case "${1:-}" in
  show) show "${2:-}"; exit 0 ;;
  rotate) rotate "${2:-}" ;;
esac

: "${LIVEKIT_DOMAIN:?請在 .env 設定 LIVEKIT_DOMAIN (例如 livekit.cafeca.io)}"
TURN_DOMAIN=${TURN_DOMAIN:-}
MAX_PARTICIPANTS=${MAX_PARTICIPANTS:-50}
# Info: (20261108 - Luphia) wss 信令預設使用 443；HTTP 埠用於 Let's Encrypt HTTP-01 驗證
LIVEKIT_PORT=${LIVEKIT_PORT:-443}
ACME_HTTP_PORT=${ACME_HTTP_PORT:-80}
case "$LIVEKIT_PORT" in ''|*[!0-9]*) echo "LIVEKIT_PORT 必須是數字" >&2; exit 1 ;; esac
case "$ACME_HTTP_PORT" in ''|*[!0-9]*) echo "ACME_HTTP_PORT 必須是數字" >&2; exit 1 ;; esac
for reserved in 7880 7881 7882 3478 5349; do
  [ "$LIVEKIT_PORT" = "$reserved" ] && { echo "LIVEKIT_PORT 與 LiveKit 內部使用的 $reserved 衝突" >&2; exit 1; }
done
if [ "$LIVEKIT_PORT" = "$ACME_HTTP_PORT" ]; then
  echo "LIVEKIT_PORT 與 ACME_HTTP_PORT 不可相同" >&2
  exit 1
fi
if [ "$LIVEKIT_PORT" = 443 ]; then
  PUBLIC_URL="wss://$LIVEKIT_DOMAIN"
else
  PUBLIC_URL="wss://$LIVEKIT_DOMAIN:$LIVEKIT_PORT"
fi
ensure_secrets
# shellcheck disable=SC1090
. "$SECRETS"

# --- Info: (20261106 - Luphia) LiveKit 設定 ---
render_livekit() {
  turn_enabled=$1
  cat <<EOF
# Info: (20261106 - Luphia) 由 init.sh 依 .env 產生，請勿手動修改
port: 7880
log_level: info

rtc:
  tcp_port: 7881
  udp_port: 7882
EOF
  if [ -n "${NODE_IP:-}" ]; then
    printf '  use_external_ip: false\n  node_ip: %s\n' "$NODE_IP"
  else
    printf '  use_external_ip: true\n'
  fi
  if [ "$turn_enabled" = true ]; then
    cat <<EOF

turn:
  enabled: true
  domain: $TURN_DOMAIN
  tls_port: 5349
  udp_port: 3478
  cert_file: /run/livekit/turn.crt
  key_file: /run/livekit/turn.key
EOF
  fi
  cat <<EOF

keys:
  $DROPHERE_API_KEY: $DROPHERE_API_SECRET
  $HILLS_API_KEY: $HILLS_API_SECRET
  $WEBHOOK_API_KEY: $WEBHOOK_API_SECRET

room:
  empty_timeout: 300
  max_participants: $MAX_PARTICIPANTS
EOF
  if [ -n "${DROPHERE_WEBHOOK_URL:-}${HILLS_WEBHOOK_URL:-}" ]; then
    printf '\nwebhook:\n  api_key: %s\n  urls:\n' "$WEBHOOK_API_KEY"
    [ -n "${DROPHERE_WEBHOOK_URL:-}" ] && printf '    - %s\n' "$DROPHERE_WEBHOOK_URL"
    [ -n "${HILLS_WEBHOOK_URL:-}" ] && printf '    - %s\n' "$HILLS_WEBHOOK_URL"
  fi
  if [ -n "${PROMETHEUS_PORT:-}" ]; then
    printf '\nprometheus:\n  port: %s\n' "$PROMETHEUS_PORT"
  fi
}

render_livekit true > "$CONFIG_DIR/livekit.yaml.tmp" && mv "$CONFIG_DIR/livekit.yaml.tmp" "$CONFIG_DIR/livekit.yaml"
# Info: (20261106 - Luphia) TURN 憑證尚未取得時使用的版本
render_livekit false > "$CONFIG_DIR/livekit.noturn.yaml.tmp" && mv "$CONFIG_DIR/livekit.noturn.yaml.tmp" "$CONFIG_DIR/livekit.noturn.yaml"
printf '%s' "$TURN_DOMAIN" > "$CONFIG_DIR/turn_domain"

# --- Info: (20261106 - Luphia) Caddy：wss 信令的 TLS，並替 TURN 網域取得憑證 ---
# Info: (20261108 - Luphia) 預設在 443 提供 wss；改用其他埠時，TLS-ALPN 驗證 (必須走 443) 會關閉，只用 HTTP-01
is_local() {
  case "$1" in localhost|*.localhost|127.*) return 0 ;; *) return 1 ;; esac
}
tls_block() {
  is_local "$1" && return 0
  [ "$LIVEKIT_PORT" = 443 ] && return 0
  printf '\ttls {\n\t\tissuer acme {\n'
  [ -n "${ACME_EMAIL:-}" ] && printf '\t\t\temail %s\n' "$ACME_EMAIL"
  printf '\t\t\tdisable_tlsalpn_challenge\n\t\t}\n\t}\n'
}
{
  printf '{\n\thttp_port %s\n\thttps_port %s\n' "$ACME_HTTP_PORT" "$LIVEKIT_PORT"
  # Info: (20261108 - Luphia) 使用 443 時沿用 Caddy 預設的簽發流程 (Let's Encrypt，失敗時改用 ZeroSSL)
  if [ "$LIVEKIT_PORT" = 443 ] && [ -n "${ACME_EMAIL:-}" ]; then printf '\temail %s\n' "$ACME_EMAIL"; fi
  printf '}\n\n'
  printf '%s {\n' "$LIVEKIT_DOMAIN"
  tls_block "$LIVEKIT_DOMAIN"
  printf '\treverse_proxy 127.0.0.1:7880\n}\n'
  if [ -n "$TURN_DOMAIN" ]; then
    printf '\n%s {\n' "$TURN_DOMAIN"
    tls_block "$TURN_DOMAIN"
    printf '\trespond "TURN" 200\n}\n'
  fi
} > "$CONFIG_DIR/Caddyfile"

# --- Info: (20261106 - Luphia) 給各服務的連線設定 ---
{
  echo "# DropHere：寫入專案根目錄的 .env.local"
  echo "LIVEKIT_URL=$PUBLIC_URL"
  echo "LIVEKIT_API_KEY=$DROPHERE_API_KEY"
  echo "LIVEKIT_API_SECRET=$DROPHERE_API_SECRET"
  echo "LIVEKIT_WEBHOOK_API_KEY=$WEBHOOK_API_KEY"
  echo "LIVEKIT_WEBHOOK_API_SECRET=$WEBHOOK_API_SECRET"
  echo "CALL_MAX_PARTICIPANTS=$MAX_PARTICIPANTS"
} > "$CONFIG_DIR/drophere.env"
{
  echo "# Hills hills-call (M4)"
  echo "LIVEKIT_URL=$PUBLIC_URL"
  echo "LIVEKIT_API_KEY=$HILLS_API_KEY"
  echo "LIVEKIT_API_SECRET=$HILLS_API_SECRET"
  echo "LIVEKIT_WEBHOOK_API_KEY=$WEBHOOK_API_KEY"
  echo "LIVEKIT_WEBHOOK_API_SECRET=$WEBHOOK_API_SECRET"
  echo "LIVEKIT_ROOM_PREFIX=hills-"
} > "$CONFIG_DIR/hills.env"

# Info: (20261106 - Luphia) Caddy 與 LiveKit 以非 root 以外的身分讀取時也能使用
chmod 644 "$CONFIG_DIR/Caddyfile" "$CONFIG_DIR/turn_domain"
echo "[init] 設定已更新：$PUBLIC_URL${TURN_DOMAIN:+，TURN/TLS $TURN_DOMAIN:5349}"
echo "[init] 取得 DropHere 設定：docker compose run --rm livekit-init show drophere"
