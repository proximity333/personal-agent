# Phase 0 · POC 执行清单

> 状态：Draft
> 最后更新：2026-11-27
> 目标：在正式开发前，用约 1 周打穿 5 个高风险点 + 1 个端到端场景，产出 **Go / No-Go** 决策。
> 关联：`docs/ARCHITECTURE.md` §10

---

## 0. 总则

- 每个验证项独立可跑，**先分项打穿，再合并（P0-E2E）**。
- 每项都有明确的**通过标准**（量化）和**失败退路**。
- 全程在**自托管沙箱（agent-sandbox，E2B 协议）**里进行；命令仅为示意，**以当前所用 SDK / CLI 版本为准**。
- 任一"阻塞项"失败且无退路 → 触发 No-Go 评审（见 §6）。

---

## 1. 前置准备

### 1.1 账号与基础环境
- [ ] 一个 **Kubernetes 1.28+** 集群，已部署 **agent-sandbox**（`kubectl apply -n agent-sandbox -f install.yaml`），并通过 Ingress 或 port-forward 暴露 API；配置 `E2B_API_URL` / `E2B_DOMAIN` / `E2B_API_KEY`（**务必改掉默认 admin token**）。
- [ ] 一个自定义**沙箱模板镜像**（容器镜像 + 模板元数据），预装：
  - [ ] `envd`（**硬性要求**，监听 49983；arm64 用 E2B 产物 `envd/v0.10.2/arm64/envd`，启动加 `-isnotfc -no-cgroups`）
  - [ ] `browse` CLI 二进制（**固定版本**）
  - [ ] Chromium（有头，跑在 Xvfb 虚拟显示上）
  - [ ] browse extension（预装到 profile）
  - [ ] Xvfb + noVNC（如 6080），供用户看屏/接管
  - [ ] `agent-runtime` 依赖（Node/Bun + `@opencode/sdk`）
  - [ ] 固定 `XDG_DATA_HOME`、浏览器 profile 目录到持久路径
- [ ] 模板注册：`templates.json` 指定 image + `port`（envd 49983），必要时配预热池。
- [ ] 一个本地"驱动脚手架"：用 E2B SDK 创建/连接沙箱、跑命令、取 noVNC 路由（`https://6080-<id>.<domain>` 或 `/sandboxes/router/<id>/6080`）。

### 1.2 关键配置（镜像层写死）
- [ ] `OPENCODE_BROWSER_AUTO_UPDATE=off`（禁止每沙箱随机自更新）
- [ ] browse 版本 pin（如镜像内锁定 `@opencode/browse@x.y.z`）
- [ ] relay token 预置；extension 预配对（避免每次手动输配对码）
- [ ] OpenCode 配置模板：`mcp.servers.browse = { type: "local", command: [".../browse","mcp"] }`

### 1.3 快速自检
- [ ] `browse status` 在沙箱内显示：relay 正常、extension 已连接、已配对。
- [ ] 沙箱内 Chromium 能通过 noVNC 看到画面。

---

## 2. 风险验证项

### P0-1 · `chrome.debugger` 在自托管沙箱桌面的稳定性
**风险**：browse 依赖 `chrome.debugger` 驱动 Chromium；在 Xvfb/桌面上可能出现断连、扩展被"调试条"干扰、headless 不兼容。

**步骤**
1. 沙箱内启动 Chromium（有头，跑 Xvfb）并预装/配对 extension。
2. 启动 `browse` relay，确认 extension 已连接（`browse status`）。
3. 用 browse 对 2–3 个真实站点连续执行：`navigate → snapshot → click → fill → screenshot` 循环。
4. 跑较长一段（≥ 20 步 / ≥ 10 分钟），期间穿插页面跳转与新标签。
5. 观察 relay 日志（`~/.local/state/browse/logs/relay.log`）与 extension 状态。

**通过标准**
- 连续 20 步操作**无断连**、无"浏览器未响应"、无扩展掉线。
- 页面跳转/新标签后 tab id 保持稳定；快照/截图始终可用。
- relay 日志无异常重连风暴。

**失败排查 / 退路**
- headless 兼容问题 → 强制走 **Xvfb + 有头**。
- 扩展权限/调试条导致中断 → 调整启动参数、确认策略安装扩展。
- 仍不稳 → 评估 Playwright MCP 作为备选浏览器层（牺牲 browse 的 handoff 原生体验）。

---

### P0-2 · noVNC 用户操作与 CDP 并发（handoff 闭环）
**风险**：agent 通过 CDP 操作，用户通过 noVNC（X11 输入）操作同一个 Chromium；两者可能冲突，且 handoff 卡片需用户真实点击才生效。

**步骤**
1. 打开 noVNC 画面，确认为"可操作"（非 `view_only`）。
2. 让 agent 执行一个会触发 handoff 的流程（如需登录的站点）。
3. handoff 卡片出现时，**在 noVNC 画面里手动点击 Continue**。
4. 确认 agent 检测到后继续执行；过程中再让 agent 做几步操作。
5. 反向测试：agent 操作过程中，用户在 noVNC 点击/滚动，观察是否互相干扰、是否可平滑交接。

**通过标准**
- handoff 卡片能显示、能被 noVNC 真实点击、agent 能继续（闭环成立）。
- 交接前后无输入错乱、无 agent 卡死。
- `view_only` 可实时切换（仅看 ↔ 可操作）。

**失败排查 / 退路**
- 输入冲突 → 明确"控制权交接"时序（handoff 时暂停 agent 输入）。
- view_only 切换不实时 → 改走"进入 handoff 才临时开权限"的策略。

---

### P0-3 · 浏览器 profile 持久化（pause → resume 掉不掉登录）
**风险**：这是个人 agent 的灵魂。若 resume 后登录态丢失，体验崩塌。

**步骤**
1. 在沙箱 Chromium 里登录一个站点（手动或经 handoff）。
2. 确认已登录（刷新仍在登录态）。
3. 触发沙箱 `pause`（agent-sandbox pause / 或 snapshot）。
4. 等待一段时间后 `resume`（或从 snapshot 重建）。
5. 重新连接 noVNC，打开该站点，检查是否仍是登录态、cookie/localStorage 是否保留。

**通过标准**
- resume 后**无需重新登录**，直接进入已登录状态。
- 用户文件（`/workspace`）与 OpenCode session 均在。

**失败排查 / 退路**
- profile 路径被清理 → 将 profile 目录固定并纳入持久层/snapshot。
- 平台 pause 不清文件系统但清内存 → 依赖文件系统持久，不依赖内存。

---

### P0-4 · OpenCode SDK 在沙箱内跑通并调用 browse
**风险**：`@opencode/sdk` 进程内 host 在沙箱环境（Node/Bun）启动、事件流、MCP 连接是否顺畅。

**步骤**
1. 沙箱内启动 `agent-runtime`：`OpenCode.create({ location: { directory: "/workspace" } })`。
2. 建立会话，发送一条 prompt，确认收到 `events` 流（文本/工具调用事件）。
3. 配置 `mcp.servers.browse`，让 agent 执行一次 `tools.browse.*`（如打开网页并截图）。
4. 验证事件能通过自开 WS 端口推给网关侧脚手架。
5. 测试一次 permission 请求的弹出与批准回路（如需要）。

**通过标准**
- host 启动成功、`sessions.prompt` 正常、事件流连续。
- `tools.browse.*` 能被 agent 调用并返回结果（与 P0-1 联动）。
- WS 转发到"网关侧"延迟可接受（本地/近端 < 数百 ms）。

**失败排查 / 退路**
- SDK 运行时依赖缺失 → 补齐 Bun/Node 版本与依赖。
- MCP 连接失败 → 检查 `browse mcp` 路径、cwd、环境变量。
- 退路：改用"官方 server + `@opencode/client`"落点（见架构文档 §4.2 备选）。

---

### P0-5 · 版本 pin 与自动更新关闭
**风险**：browse 默认每小时自更新，多沙箱版本漂移会导致 MCP/relay 不兼容。

**步骤**
1. 镜像内固定 browse 版本；设置 `OPENCODE_BROWSER_AUTO_UPDATE=off`。
2. 启动 relay，观察日志确认**未**发起更新下载。
3. 重启沙箱多次，确认版本一致、无自动替换。
4. 验证 `browse status` 版本号与镜像 pin 一致。

**通过标准**
- 多次重启后版本始终一致；无自动更新行为。
- extension 与 relay 版本匹配、无"MCP server must restart"类错误。

---

## 3. 端到端合并场景（P0-E2E）

把上面几项串起来，跑一个真实任务：

1. 用户登录 → 网关创建/恢复沙箱 → 前端拿到 WS + noVNC URL。
2. 用户在对话里下指令："打开 X 网站，读取顶部内容，登录后进入设置页并截图。"
3. agent 通过 browse 打开网页、读取、截图（画面实时可见）。
4. 遇到登录 → handoff 卡片 → 用户在 noVNC 点 Continue 并完成登录。
5. agent 继续进入设置页、截图、回报结果。
6. 空闲触发 pause → 用户回来 resume → 确认**仍是登录态**并能继续对话。

**通过标准**：全链路无阻塞完成；对话、看屏、handoff、持久化四件事都成立。

---

## 4. 验收矩阵

| 编号 | 验证项 | 通过标准（摘要） | 结果 | 是否阻塞 |
|---|---|---|---|---|
| P0-1 | chrome.debugger 稳定性 | 20 步无断连 | ☐ | 是 |
| P0-2 | noVNC 操作 + CDP 并发 | handoff 闭环成立 | ☐ | 是 |
| P0-3 | profile 持久化 | resume 后不掉登录 | ☐ | 是 |
| P0-4 | OpenCode SDK 跑通 | 事件流 + browse 调用成功 | ☐ | 是 |
| P0-5 | 版本 pin | 重启版本一致、无自更新 | ☐ | 是 |
| P0-E2E | 端到端场景 | 全链路完成 | ☐ | 是 |

---

## 5. 时间盒与产出

| 阶段 | 内容 | 产出 |
|---|---|---|
| Day 1–2 | 环境（template、browse、扩展、配置）+ P0-5 | 可复用的沙箱镜像基线 |
| Day 2–3 | P0-1、P0-4（浏览器稳定性 + SDK） | 驱动脚手架 + 稳定性报告 |
| Day 3–4 | P0-2、P0-3（handoff 并发 + 持久化） | 交接/持久化结论 |
| Day 5 | P0-E2E 合并 + 验收矩阵 | Go/No-Go 结论 |

---

## 6. 决策门（Go / No-Go）

**Go 条件**（满足其一未过则不进 Phase 1）：
- P0-1 ~ P0-5 全部通过；P0-E2E 全链路成立。

**No-Go / 降级路径**：
- 若 browse 在沙箱内稳定性不达标 → 评估 **Playwright MCP** 替代（牺牲 handoff 原生体验，自己实现登录交还）。
- 若 agent-sandbox 的桌面/VNC 或端口路由能力受限 → 切 **E2B Cloud**（托管、microVM）或 **Daytona**。
- 若 SDK 进程内落点受阻 → 切"官方 server + `@opencode/client`"。

---

## 7. 现场需确认的不确定点

- [ ] 自托管桌面镜像是否允许 `--load-extension` / 策略预装扩展，并持久到 profile。
- [ ] 有头 vs headless：确认走 Xvfb + 有头是否满足 `chrome.debugger`。
- [ ] X11 输入（noVNC）与 CDP 输入并发时的具体行为与切换时序。
- [ ] noVNC `view_only` 切换的实时性与鉴权 URL 的安全边界。
- [ ] agent-sandbox 的 pause 是否保留进程内存（还是仅文件系统），以决定持久化只依赖文件系统。
- [ ] 模型出口代理在沙箱网络策略下是否可通（egress 白名单）。

---

## 8. 验证进展（2026-11-27）

| 项 | 状态 | 结论 |
|---|---|---|
| 实例连通 / 鉴权 | ✅ | `healthz` ok；API 用 **`X-API-Key`**；create / exec / delete 均通过 |
| 端口路由 | ✅ | path 形式 `…/sandboxes/router/<id>/<port>/`：HTTP 200 + **WS 101**；子域名形式不可用 |
| 模板注册 | ✅ | `desktop`（`port=6080`，image `…/agent-desktop:arm64`） |
| 沙箱创建 | ✅ | E2B API；注意 Cloudflare **524** 时沙箱仍在后台创建，改为轮询状态 |
| 桌面栈运行 | ✅ | `envd(0.10.2 arm64) / Xvfb / x11vnc / websockify / browse / Chromium` 全部在跑 |
| noVNC 画面 | ✅ | 容器内 Chromium 实时可见（截图确认，含 browse 扩展设置页） |
| 原生 arm64 镜像 | ✅ | 官方 base 为 **amd64-only**，binfmt 节点不一致 → 改原生 arm64 解决 `exec format error` |
| 浏览器 profile 持久化 | ⏳ | 未测（pause → resume） |
| browse 扩展配对 | ✅ | unpacked 扩展 ID 加入 `OPENCODE_BROWSER_EXTENSION_ORIGINS` 白名单后，用 xdotool 填入配对码完成 |
| `chrome.debugger` | ✅（初步） | `browse navigate https://example.com/` 成功；出现调试条与 Agents 标签组 |
| gVisor `RuntimeClass` 下运行 | ⏳ | 未测 |
| OpenCode + `agent-runtime` | ✅（启动） | Bun 1.4.5；WS 建 session 成功并收到 `session.created` 事件流 |
| `tools.browse.*` 由 agent 调用 | ⏳ | 需模型 key 后跑一次 prompt |
| 前端「对话 + noVNC」 | ⏳ | 未做 |

**关键教训**
- **镜像架构**：官方沙箱镜像只有 amd64；arm64 节点若缺 binfmt 会 `exec format error`。原生 arm64 镜像最稳。
- **buildx**：默认产出 OCI index（含 provenance attestation），部分节点会报 `no matching manifest`；用 `provenance/sbom=false` 产出**单 manifest**。
- **envd 版本**：agent-sandbox 自带 `0.2.10`（amd64）；arm64 用 E2B 的 `v0.10.2/arm64`，启动需 `-isnotfc -no-cgroups`。
- **路由**：noVNC 用 path 形式，路径结尾必须有 `/`；Cloudflare 下 HTTP 与 WebSocket 均正常。
