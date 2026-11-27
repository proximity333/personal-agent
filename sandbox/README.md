# Desktop 沙箱镜像（agent-sandbox · E2B 协议 · linux/arm64）

目标：在 agent-sandbox 上提供一个**带桌面 + Chromium + browse + noVNC** 的沙箱模板，供每个用户独占使用。

## 镜像内容
- 基底：`ghcr.io/agent-sandbox/sandbox-base-node:latest`（Node 22 + **envd 0.2.10**，监听 `49983`）
- 桌面栈：`Xvfb` + `x11vnc` + `noVNC`（`6080`）
- 浏览器：`Chromium`（arm64）+ `browse` extension（`--load-extension=/opt/browse-extension`）
- browse：`browse serve`（relay，`127.0.0.1:19988`）
- 入口：`sandbox/start-desktop.sh` 依次启动 envd → Xvfb → VNC/noVNC → relay → Chromium

## 前置
- 集群是 **linux/arm64**（当前实例 `0.8.4-arm64` 已确认）
- 能构建并推送镜像到 `ghcr.io/proximity333/*`
- 集群能拉取该镜像（包设为 public，或配置 imagePullSecret）

## 构建方式

### A) GitHub Actions（推荐，免本地 Docker）
1. 在本仓库执行 `git init` 并推到一个 GitHub 仓库（**public** 更省事：Actions 免费、包默认 public，K8s 免拉取凭证）。
2. 打开仓库 **Actions → build-desktop → Run workflow**。
3. 完成后镜像在 `ghcr.io/proximity333/agent-desktop:latest`。

工作流见 `.github/workflows/build-desktop.yml`（QEMU 交叉构建 arm64；首次较慢）。

### B) 本地构建（Apple Silicon）
```bash
brew install colima docker
colima start --arch aarch64 --cpu 4 --memory 8

# 需要带 write:packages 的 GitHub PAT
echo "$GHCR_PAT" | docker login ghcr.io -u proximity333 --password-stdin

docker buildx create --use --name desktop-builder 2>/dev/null || true
docker buildx build --platform linux/arm64 \
  -f sandbox/Dockerfile.desktop \
  -t ghcr.io/proximity333/agent-desktop:latest --push .
```

## 注册模板（不要覆盖现有模板！）

`POST /api/v1/config/templates` 是**整表替换**，务必先 GET、追加、再 POST：

```bash
BASE=https://sandbox.98297469.xyz
TOKEN=<你的 SYSTEM_TOKEN>

# 1) 取现有模板（data 是一段 JSON 字符串，需要二次解析）
curl -s -H "X-API-Key: $TOKEN" $BASE/api/v1/config/templates \
  | jq -r '.data' | jq . > /tmp/tpl.json

# 2) 追加 desktop（若已存在同名则替换）
jq -s '(.[0] | map(select(.name != "desktop"))) + [.[1]]' \
  /tmp/tpl.json sandbox/templates.desktop.json > /tmp/tpl2.json

# 3) 整表写回
curl -s -X POST $BASE/api/v1/config/templates \
  -H "X-API-Key: $TOKEN" -H "Content-Type: application/json" \
  --data @/tmp/tpl2.json
```

## 创建并访问

```bash
# 创建（E2B 协议）
curl -s -X POST $BASE/e2b/v1/sandboxes \
  -H "Content-Type: application/json" -H "X-API-Key: $TOKEN" \
  -d '{"templateID":"desktop","timeout":1800,"metadata":{"name":"desk-1"}}'
```

拿到 `sandboxID` 后，noVNC 地址（**path 形式**，已实测可用）：

```
https://sandbox.98297469.xyz/sandboxes/router/<sandboxID>/6080/vnc.html?autoconnect=1&resize=scale
```

> 注意：`https://6080-<sandboxID>.<domain>/` 子域名形式在本实例**不可用**（无泛域名 TLS），请用上面的 path 形式；路径必须以 `/` 结尾。

## browse 一次性配对

首次启动后，Chromium 里已加载 browse 扩展，但尚未与 relay 配对：

1. 在沙箱内执行 `browse pair`，得到一个 `XXXX-XXXX` 配对码；
2. 通过 noVNC 打开 Chromium 的扩展选项页（工具栏扩展 → browse → Options / 或 "Pair with a code"）；
3. 输入配对码并 Connect。

配对密钥存于持久化的 Chromium profile（`/home/user/.config/chromium`），**只需配一次**，之后自动重连。

## 已知风险 / 待验证
- [ ] **browse 在 linux-arm64**：安装脚本 allowlist 含 `linux-arm64`，但需实测 release 是否真提供该 target 的二进制。
- [ ] **Chromium arm64**：Debian trixie 的 `chromium` 包在 arm64 是否完整可用。
- [ ] **gVisor**：Chromium 在 gVisor 下可能需要 `--no-sandbox`/`--disable-gpu`（本镜像已加）。先不加 `runtimeClassName: gvisor` 跑通，再切换验证。
- [ ] **WebSocket**：noVNC 经 Cloudflare + per-port 路由的 WS 是否稳定。
- [ ] **安全**：容器内 `x11vnc -nopw` 仅用于 POC；对外前必须加鉴权（Ingress/VNC 密码）。

## 资源建议
模板默认 `cpu 0.5 / mem 1Gi`（limit 2 / 4Gi）。桌面 Chromium 的实际内存建议先按 2Gi request 起步，按观测再调。