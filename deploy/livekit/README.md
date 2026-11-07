# 房間視訊會議：共用 LiveKit 部署

DropHere 房間通話與 Hills（M4 會議）共用同一套自架 LiveKit SFU。每個房間最多 50 人同時通話。

```
瀏覽器 (DropHere) ──① 入場憑證──▶ DropHere API ── 房間存取檢查 (聊天 token：密碼、到期)
        │                                │
        │                                └─ LiveKit API：建立房間 (drophere-<房號>)、人數、管理、結束
        │
        └──② wss 信令 + UDP 媒體──▶ LiveKit SFU ◀── Hills (hills-call 發放憑證，房間 hills-<id>)
                                         │
                                         └─③ webhook (人數變更) ──▶ DropHere / Hills
```

## 1. 主機與網路

| 項目 | 建議 |
|------|------|
| 主機 | 4–8 vCPU、8 GB RAM、1 Gbps 網卡；影音流量大，建議與 relay.cafeca.io 分開 |
| 頻寬 | 一個 50 人滿房約進 100 Mbps、出 150–200 Mbps（依開鏡頭人數而定） |
| 網域 | `livekit.cafeca.io`（信令，wss）、`turn.cafeca.io`（TURN/TLS） |

防火牆：

| 埠 | 協定 | 用途 |
|----|------|------|
| 80 | TCP | Let's Encrypt 驗證（HTTP-01） |
| 443 | TCP | `wss://livekit.cafeca.io`（Caddy → 7880） |
| 7881 | TCP | 媒體的 TCP 備援 |
| 7882 | UDP | 媒體（單一埠多工） |
| 5349 | TCP | TURN/TLS（公司網路只允許 TLS 時） |
| 3478 | UDP | TURN/UDP |

主機上已有服務佔用 443 或 80 時：

- `LIVEKIT_PORT` 改成其他埠（例如 7443），連線網址會變成 `wss://livekit.cafeca.io:7443`；只允許 443 對外連線的網路將無法加入通話。
- `ACME_HTTP_PORT` 改成其他埠（例如 8080），並在佔用 80 的服務把 `livekit.cafeca.io`、`turn.cafeca.io` 的 `/.well-known/acme-challenge/` 轉送到 `127.0.0.1:8080`（Let's Encrypt 一定從外部連到 80 埠驗證）。

7880（LiveKit HTTP）只供本機 Caddy 使用，防火牆不要對外開放。**不要**讓 Cloudflare 等 HTTP 代理擋在 LiveKit 前面：媒體是 UDP，代理不會轉送。

## 2. 安裝

API key / secret 與 TLS 憑證**全部自動產生**，不需手動填寫或放置憑證檔：

```bash
cd deploy/livekit
cp env.example .env        # 只需填網域 (LIVEKIT_DOMAIN、TURN_DOMAIN) 與 ACME_EMAIL
docker compose up -d --build
curl -s https://livekit.cafeca.io          # 回傳 OK
```

| 服務 | 做什麼 |
|------|--------|
| `livekit-init` | 第一次執行時以 `/dev/urandom` 隨機產生三組 API key / secret（48 字元），存在 `livekit-config` volume；之後每次啟動依 `.env` 重新產生 `livekit.yaml`、`Caddyfile` 與各服務的連線設定，金鑰沿用 |
| `caddy` | 在 443（`LIVEKIT_PORT`）提供 wss 信令，並自動向 Let's Encrypt 申請、續期 `LIVEKIT_DOMAIN` 與 `TURN_DOMAIN` 的憑證 |
| `livekit` | 從 Caddy 的憑證目錄取得 TURN/TLS 憑證後啟動；憑證尚未取得時先以不含 TURN 的設定啟動，取得後立即切換；之後續期的憑證在 `CERT_RELOAD_HOUR_UTC`（預設 20 = 台灣凌晨 4 點）重新啟動載入，避免白天中斷通話 |

只使用 named volume、不掛載主機檔案，在遠端 Docker context 也能部署（與 Hills 的 relay / mailbox 相同做法）。

### 取得各服務的設定

```bash
docker compose run --rm livekit-init show drophere   # DropHere 的 .env.local 內容
docker compose run --rm livekit-init show hills      # Hills hills-call
```

輸出含 secret，只貼到對應服務的設定，不要提交到 repo 或貼到聊天室。

金鑰分配（key ID 為隨機的 `API…` 字串）：

| 金鑰 | 持有者 | 用途 |
|------|--------|------|
| drophere | DropHere | 簽發入場憑證、呼叫 LiveKit API |
| hills | hills-call | 同上（Hills 的房間） |
| webhook | DropHere、Hills | 驗證 LiveKit webhook（LiveKit 只能設定一組） |

### 撤換金鑰

任一服務外洩時只需撤換它自己的那組：

```bash
docker compose run --rm livekit-init rotate drophere   # drophere | hills | webhook
docker compose restart livekit
docker compose run --rm livekit-init show drophere     # 更新 DropHere 的 .env.local 後重新啟動 DropHere
```

### 修改網域或其他設定

```bash
vi .env
docker compose up -d && docker compose restart caddy livekit
```

### 備份

`livekit-config` volume 保存金鑰；遺失時重新部署會產生新金鑰，需要更新 DropHere / Hills 的設定。`caddy-data` 保存憑證，遺失時會自動重新申請。

## 3. DropHere 設定

把 `show drophere` 的輸出寫入 DropHere 專案根目錄的 `.env.local`（已被 `.gitignore` 忽略），重新啟動 `npm run swarm`。未設定 `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` 時，房間不顯示通話按鈕。

| API | 說明 |
|-----|------|
| `GET /api/v1/room/:id/call` | 是否啟用、目前人數、上限 |
| `POST /api/v1/room/:id/call/token` | 入場憑證（需聊天 token；人數已滿回傳 `CONFLICT`） |
| `POST /api/v1/room/:id/call/moderate` | 房主：`{ identity, action: 'mute' \| 'remove' }` |
| `POST /api/v1/livekit/webhook` | LiveKit 事件，更新房間內顯示的通話人數 |

規則：

- 必須先進入房間（通過密碼、未到期）才能取得入場憑證；身分使用房間內的匿名代號，名稱沿用聊天暱稱。
- 入場憑證有效期不超過房間到期時間（最長 6 小時）；房間到期或被清除時，DropHere 呼叫 LiveKit 結束通話。
- 只開放鏡頭、麥克風、螢幕分享；文字訊息仍走房間聊天，不開放 LiveKit data channel。
- 房主可關閉他人麥克風、請人離開通話。
- 不錄影；媒體只經過 LiveKit 轉發，未啟用端對端加密（之後可評估 LiveKit E2EE）。

## 4. 50 人會議的做法

- 上傳端 simulcast（180p / 360p / 720p），沒人看的畫質層暫停編碼（dynacast）。
- 只訂閱畫面上看得到的影像（adaptiveStream）；分頁顯示：手機 4 格、平板 6 格、桌機 9 格、大螢幕 16 格。說話的人自動移到第一頁。
- 有人分享螢幕時，螢幕放大，其他人改為下方縮圖列。
- 超過 5 人時，加入時預設靜音。

## 5. 上線前壓力測試

在**正式主機以外**的機器執行（測試工具本身很吃 CPU 與頻寬）：

```bash
lk load-test --url wss://livekit.cafeca.io --api-key <drophere key> --api-secret <drophere secret> \
  --room drophere-loadtest --video-publishers 10 --audio-publishers 50 --subscribers 40 \
  --video-resolution high --duration 2m
```

同時觀察主機 CPU（`docker stats`）與網卡流量（`nload` 或 Prometheus `livekit_packet_bytes`）。每個房間必須放在同一個節點上；房間數增加時，加開節點並設定 Redis 讓多個節點組成叢集。

## 6. Hills 端（M4）

依 Hills technical-design-m2-m5 §6：`hills-call` 以組織憑證鏈換取 `hills` key 簽發的入場憑證，房間名稱使用 `hills-` 前綴 + blake3(orgId ‖ meetingId)。設定以 `show hills` 取得（已含 `LIVEKIT_ROOM_PREFIX=hills-`）；webhook 以 webhook 金鑰驗證，略過 `drophere-` 開頭的房間。決策 D10 / 提案 P3 需在 Hills 決策表確認後再實作。
