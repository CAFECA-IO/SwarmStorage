# SwarmStorage
Private IPFS Storage Cluster

## Prepare Environment
- Docker
- Node.js 22

## Start Service
```shell
# start IPFS
docker compose up -d
npm run swarm
```

# Laria
## How it works
1. 當檔案上傳後先進行一次加密，加密後檔案大小為 4 MB 整數倍
2. 將加密的檔案進行 Reed-Solomon (8, 5) 分片
3. 將分片散佈到不同的機器上（答對分片指定區段 hash 值可領取保存獎勵）
4. 建立檔案 metadata 並保管於倉庫
