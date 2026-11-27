# Gateway（单用户 MVP）

一个 Bun 服务，负责：

1. 确保一个 `desktop` 沙箱在 agent-sandbox 上运行；
2. 把模型 provider 配置写入沙箱的 `~/.config/opencode/opencode.json`；
3. 在沙箱内启动 `agent-runtime`；
4. 向前端返回 **noVNC URL** 与 **agent WebSocket URL**。

前端是 `public/index.html`：左侧对话，右侧嵌入 noVNC。

## 运行

```bash
export SANDBOX_API_KEY=<SYSTEM_TOKEN>
export PROVIDER_BASE_URL=https://<gateway>/v1
export PROVIDER_API_KEY=<key>
# 可选
export MODEL=cb2/deepseek-v4.1-flash
export PROVIDER_ID=cb2
export PROVIDER_MODELS=deepseek-v4.1-flash,mimo-v2.6-pro
export PORT=8787

bun run src/server.ts
# 打开 http://localhost:8787
```

开发时可复用已存在的沙箱（不新建）：

```bash
export SANDBOX_ID=<existing-running-sandbox-id>
export AGENT_PORT=4097
```

## API

- `POST /api/session` → `{ sandboxID, name, vncUrl, agentWsUrl, runtime }`
- `GET /api/health` → `{ ok, sandbox }`

## 同源 noVNC 代理（重要）

网关把 `/vnc/*` 反代到沙箱的 `6080`（HTTP + WebSocket），前端 iframe 用 `/vnc/vnc.html`，避免跨域嵌入问题。

两个关键坑：
1. **Bun 的 `fetch` 会自动解压上游响应**，反代时**必须删掉 `content-length`**（以及 `content-encoding`），否则浏览器按压缩后的长度截断 HTML，末尾的内联 module 不执行 → noVNC 卡在加载页。
2. **`Bun.serve` 默认 10s idle 超时**会掐断长连接；需设置 `idleTimeout: 255`。

## 说明 / 限制

- **模型配置走配置文件**，不用 E2B `envVars`（实测不进 PID 1）。
- 沙箱内无 `CAP_KILL`：`agent-runtime` 若已在目标端口运行则复用；换配置需新建沙箱或换端口。
- 单用户：沙箱名 `single-<ts>`，进程内复用；重启网关可能新建沙箱。
- 前端直连 `wss://…/sandboxes/router/<id>/<port>/`（平台路由已支持 WS）。
- 生产化还需要：配对自动化、鉴权、pause/resume、多租户路由。