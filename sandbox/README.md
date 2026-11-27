# Desktop 沙箱镜像（agent-sandbox · E2B 协议）

在 agent-sandbox 上提供一个**带桌面 + Chromium + noVNC** 的每用户沙箱模板。以下结论均已在实例上实测。

## 实例与实测结论

| 项 | 结论 |
|---|---|
| 实例 | `https://sandbox.98297469.xyz`，version `0.8.4-arm64` |
| 鉴权 | **`X-API-Key`**（文档写的 `Authorization: Bearer` 在这版不生效；E2B SDK 用 `X-API-Key`） |
| 节点架构 | **aarch64**；官方 `sandbox-base` 镜像为 **amd64-only**，靠 binfmt 模拟，且并非每个节点都装了 binfmt |
| 端口路由 | ✅ **path 形式**：`https://<host>/sandboxes/router/<sandboxID>/<port>/`（HTTP 200 + WebSocket 101） |
| 子域名路由 | ❌ `https://<port>-<sandboxID>.<domain>/` 不可用 |
| 桌面栈 | ✅ `envd / Xvfb / x11vnc / websockify / browse / Chromium` 实测全部运行 |

> 结论：**构建原生 arm64 镜像**，不要依赖 binfmt 模拟。amd64 路径会随机在部分节点报 `exec format error`。

## 镜像

两个 Dockerfile：

- **`Dockerfile.desktop.arm64`（主用，原生 arm64）**
  - base：`python:3.12-slim-trixie`
  - envd：`https://storage.googleapis.com/e2b-artifact-binaries/envd/v0.10.2/arm64/envd`
    （E2B 按架构发布；agent-sandbox 自带的 0.2.10 只有 amd64）
  - 启动参数：`envd -isnotfc -no-cgroups -port 49983`（普通容器需要 `-isnotfc`）
  - Chromium(arm64) + Xvfb + x11vnc + noVNC(6080) + browse(0.1.5) + extension
- **`Dockerfile.desktop`（备用，amd64）**
  - base 官方 `sandbox-base`（amd64）
  - 仅在具备 binfmt 的节点上可用

## 构建（GitHub Actions，arm64 原生）

工作流：`.github/workflows/build-desktop.yml`

- `runs-on: ubuntu-24.04-arm`
- `file: sandbox/Dockerfile.desktop.arm64`
- `platforms: linux/arm64`
- **`provenance: false` / `sbom: false`** —— 关键：默认会产出 OCI index（含 attestation），arm64 节点可能报 `no matching manifest`；单 manifest 更稳。
- 产物：`ghcr.io/proximity333/agent-desktop:arm64`

触发：仓库 **Actions → build-desktop → Run workflow**。约 3～4 分钟。

本地构建（可选，Apple Silicon）：

```bash
brew install colima docker
colima start --arch aarch64 --cpu 4 --memory 8
docker buildx create --use --name desktop-builder 2>/dev/null || true
docker buildx build --platform linux/arm64 \
  -f sandbox/Dockerfile.desktop.arm64 \
  -t ghcr.io/proximity333/agent-desktop:arm64 --push .
```

## 注册模板（整表替换，务必先 GET 再 POST）

`POST /api/v1/config/templates` 是**整表替换**，直接 POST 单个条目会清掉其它模板：

```bash
BASE=https://sandbox.98297469.xyz
TOKEN=<你的 SYSTEM_TOKEN>

curl -s -H "X-API-Key: $TOKEN" $BASE/api/v1/config/templates \
  | jq -r '.data' | jq . > /tmp/tpl.json

jq -s '(.[0] | map(select(.name != "desktop"))) + [.[1]]' \
  /tmp/tpl.json sandbox/templates.desktop.json > /tmp/tpl2.json

curl -s -X POST $BASE/api/v1/config/templates \
  -H "X-API-Key: $TOKEN" -H "Content-Type: application/json" \
  --data @/tmp/tpl2.json
```

`templates.desktop.json` 关键字段：`image=…:arm64`、`port=6080`、`resources`。

## 创建沙箱

```bash
curl -s -X POST $BASE/e2b/v1/sandboxes \
  -H "Content-Type: application/json" -H "X-API-Key: $TOKEN" \
  -d '{"templateID":"desktop","timeout":1800,"metadata":{"name":"desk-1"}}'
```

注意：
- 创建请求会等沙箱就绪，可能被 **Cloudflare 524** 打断；**沙箱仍会继续创建**，不要重复创建。
- 用原生列表接口轮询：

```bash
curl -s -H "X-API-Key: $TOKEN" $BASE/api/v1/sandbox \
  | jq -c '(.data // .)[]? | select(.metadata.name=="desk-1") | {id,status}'
```

## 访问 noVNC

```
https://sandbox.98297469.xyz/sandboxes/router/<sandboxID>/6080/vnc.html?autoconnect=1&resize=scale
```

- 路径**必须以 `/` 结尾**，否则 301。
- 子域名形式（`6080-<id>.<domain>`）不可用。
- HTTP 与 WebSocket 均经 Cloudflare，实测 200 / 101。

## browse 状态与配对

- relay 监听 `127.0.0.1:19988`；容器内 Chromium 已加载 browse 扩展。
- **VNC / 桌面本身不需要配对。**
- 但要让 browse **真正驱动浏览器**，扩展必须与 relay 做**一次性配对**（写入持久 profile）。**当前按决定暂缓。**
- `browse status` 若以不同用户/令牌运行，可能误报 `Relay: not running`（实际端口在监听）；以启动 relay 的同一用户查询为准。

## 已知待办

- [ ] browse 扩展配对 + `chrome.debugger` 稳定性实测
- [ ] 浏览器 profile 持久化（pause → resume 登录态不掉）
- [ ] gVisor `RuntimeClass` 下运行 Chromium
- [ ] OpenCode + `agent-runtime` + `mcp.servers.browse`
- [ ] 前端「对话 + noVNC」整合
- [ ] 安全：`x11vnc -nopw` 与 Chromium `--no-sandbox` 均为 POC 配置，对外前必须加鉴权/隔离

## 资源建议

模板默认 `cpu 0.5 / mem 1Gi`（limit 2 / 4Gi）。桌面 Chromium 实测建议 **request ≥ 2Gi** 起步，按观测调整。