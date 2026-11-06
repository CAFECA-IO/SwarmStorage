#!/bin/sh
# Info: (20261106 - Luphia)
# 啟動 LiveKit 並管理 TURN/TLS 憑證：
# - 憑證由 Caddy 自動向 Let's Encrypt 申請 (caddy-data volume，唯讀掛載於 /caddy)
# - 憑證取得前以不含 TURN 的設定啟動，取得後切換
# - Caddy 續期後於 CERT_RELOAD_HOUR_UTC (預設 20 = 台灣凌晨 4 點) 重新啟動 LiveKit 載入新憑證，避免白天中斷通話
set -eu

CONFIG_DIR=${CONFIG_DIR:-/config}
CADDY_DIR=${CADDY_DIR:-/caddy}
RUN_DIR=/run/livekit
CHECK_INTERVAL=${CERT_CHECK_INTERVAL:-600}
RELOAD_HOUR=${CERT_RELOAD_HOUR_UTC:-20}
FIRST_WAIT=${CERT_FIRST_WAIT:-300}

[ -s "$CONFIG_DIR/livekit.yaml" ] || { echo "[livekit] 找不到設定，livekit-init 是否已執行？" >&2; exit 1; }
TURN_DOMAIN=$(cat "$CONFIG_DIR/turn_domain" 2>/dev/null || true)
mkdir -p "$RUN_DIR"

find_cert() {
  [ -n "$TURN_DOMAIN" ] || return 0
  find "$CADDY_DIR" -type f -path "*/certificates/*/$TURN_DOMAIN/$TURN_DOMAIN.$1" 2>/dev/null | head -n 1
}

cert_sum() {
  crt=$(find_cert crt)
  key=$(find_cert key)
  [ -n "$crt" ] && [ -n "$key" ] && cat "$crt" "$key" | cksum | cut -d' ' -f1
}

install_cert() {
  cp "$(find_cert crt)" "$RUN_DIR/turn.crt"
  cp "$(find_cert key)" "$RUN_DIR/turn.key"
  chmod 600 "$RUN_DIR/turn.key"
}

# Info: (20261106 - Luphia) 第一次啟動時等待 Caddy 取得憑證
if [ -n "$TURN_DOMAIN" ]; then
  waited=0
  while [ -z "$(cert_sum || true)" ] && [ "$waited" -lt "$FIRST_WAIT" ]; do
    [ "$waited" -eq 0 ] && echo "[livekit] 等待 Caddy 取得 $TURN_DOMAIN 的憑證…"
    sleep 5
    waited=$((waited + 5))
  done
fi

active_sum=""
pid=""

start() {
  current=$(cert_sum || true)
  if [ -n "$current" ]; then
    install_cert
    active_sum=$current
    config="$CONFIG_DIR/livekit.yaml"
  else
    active_sum=""
    config="$CONFIG_DIR/livekit.noturn.yaml"
    [ -n "$TURN_DOMAIN" ] && echo "[livekit] 尚未取得 TURN 憑證，暫時不啟用 TURN/TLS"
  fi
  /livekit-server --config "$config" &
  pid=$!
}

stop() {
  [ -n "$pid" ] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  pid=""
}

trap 'stop; exit 0' TERM INT

start
elapsed=0
while :; do
  sleep 5 &
  wait $! || true
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null && code=0 || code=$?
    echo "[livekit] livekit-server 結束 (exit $code)" >&2
    exit "$code"
  fi
  elapsed=$((elapsed + 5))
  [ "$elapsed" -ge "$CHECK_INTERVAL" ] || continue
  elapsed=0

  latest=$(cert_sum || true)
  [ -n "$latest" ] && [ "$latest" != "$active_sum" ] || continue
  # Info: (20261106 - Luphia) 第一次取得憑證立即套用；續期則等到低峰時段
  if [ -z "$active_sum" ] || [ "$(date -u +%H | sed 's/^0//')" = "$RELOAD_HOUR" ]; then
    echo "[livekit] 套用新的 TURN 憑證並重新啟動"
    stop
    start
  fi
done
