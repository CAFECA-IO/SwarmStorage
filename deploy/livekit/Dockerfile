# Info: (20261106 - Luphia) LiveKit + 初始化 / 憑證管理腳本 (建置時複製，不需掛載主機檔案)
FROM livekit/livekit-server:v1.13.11
COPY init.sh livekit-entrypoint.sh /opt/drophere/
ENTRYPOINT ["/bin/sh", "/opt/drophere/livekit-entrypoint.sh"]
