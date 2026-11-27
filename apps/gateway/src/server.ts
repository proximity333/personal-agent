// Single-user gateway for the personal agent.
//
// Responsibilities:
//   - ensure a desktop sandbox exists (agent-sandbox / E2B API)
//   - write the per-user OpenCode config (model provider + browse MCP)
//   - start agent-runtime inside the sandbox
//   - hand the browser the noVNC URL and the agent WebSocket URL
//
// Run:
//   SANDBOX_API_KEY=... PROVIDER_BASE_URL=... PROVIDER_API_KEY=... bun run src/server.ts

const BASE = (process.env.SANDBOX_BASE_URL ?? "https://sandbox.98297469.xyz").replace(/\/$/, "")
const KEY = process.env.SANDBOX_API_KEY ?? ""
const TEMPLATE = process.env.SANDBOX_TEMPLATE ?? "desktop"
const TIMEOUT = Number(process.env.SANDBOX_TIMEOUT ?? 7200)
const FIXED_ID = process.env.SANDBOX_ID // dev: reuse an existing sandbox
const AGENT_PORT = Number(process.env.AGENT_PORT ?? 4097)
const VNC_PORT = Number(process.env.VNC_PORT ?? 6080)
const PORT = Number(process.env.PORT ?? 8787)

const MODEL = process.env.MODEL ?? "cb2/deepseek-v4.1-flash"
const PROVIDER_ID = process.env.PROVIDER_ID ?? "cb2"
const PROVIDER_NAME = process.env.PROVIDER_NAME ?? "CB2 Gateway"
const PROVIDER_BASE_URL = process.env.PROVIDER_BASE_URL ?? ""
const PROVIDER_API_KEY = process.env.PROVIDER_API_KEY ?? ""
const PROVIDER_MODELS = (process.env.PROVIDER_MODELS ?? "deepseek-v4.1-flash,mimo-v2.6-pro")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

if (!KEY) throw new Error("SANDBOX_API_KEY is required")
if (!PROVIDER_BASE_URL || !PROVIDER_API_KEY) {
  throw new Error("PROVIDER_BASE_URL and PROVIDER_API_KEY are required")
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "X-API-Key": KEY,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text, status: res.status }
  }
}

function asArray(body: any): any[] {
  const data = body?.data ?? body
  return Array.isArray(data) ? data : []
}

async function exec(name: string, command: string): Promise<string> {
  const body = await api(`/api/v1/terminal/sandbox/${encodeURIComponent(name)}`, {
    method: "POST",
    body: JSON.stringify({ command }),
  })
  return String(body?.data?.output ?? body?.error ?? "")
}

function opencodeConfig() {
  const models: Record<string, { name: string }> = {}
  for (const id of PROVIDER_MODELS) models[id] = { name: id }
  return {
    $schema: "https://opencode.ai/config.json",
    model: MODEL,
    providers: {
      [PROVIDER_ID]: {
        name: PROVIDER_NAME,
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: PROVIDER_BASE_URL, apiKey: PROVIDER_API_KEY },
        models,
      },
    },
    mcp: {
      servers: {
        browse: { type: "local", command: ["/usr/local/bin/browse", "mcp"] },
      },
    },
  }
}

async function writeConfig(name: string) {
  const json = JSON.stringify(opencodeConfig(), null, 2)
  const b64 = Buffer.from(json, "utf8").toString("base64")
  const out = await exec(
    name,
    `mkdir -p /home/user/.config/opencode && echo ${b64} | base64 -d > /home/user/.config/opencode/opencode.json && echo CONFIG_WRITTEN`,
  )
  if (!out.includes("CONFIG_WRITTEN")) throw new Error(`config write failed: ${out.slice(0, 300)}`)
}

async function findRunning(id: string) {
  const list = await api("/api/v1/sandbox")
  return asArray(list).find((x: any) => x.id === id && x.status === "running") ?? null
}

async function createSandbox(): Promise<any> {
  const name = `single-${Date.now().toString(36)}`
  try {
    await fetch(`${BASE}/e2b/v1/sandboxes`, {
      method: "POST",
      headers: { "X-API-Key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ templateID: TEMPLATE, timeout: TIMEOUT, metadata: { name } }),
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    // creation can exceed Cloudflare's timeout; the platform keeps creating
  }

  for (let i = 0; i < 60; i++) {
    const list = await api("/api/v1/sandbox")
    const row = asArray(list).find(
      (x: any) => x.metadata?.name === name && x.status === "running",
    )
    if (row) return row
    await sleep(2000)
  }
  throw new Error("sandbox creation timed out")
}

let current: any = null

async function ensureSandbox() {
  if (FIXED_ID) {
    const row = await findRunning(FIXED_ID)
    if (row) {
      current = row
      return row
    }
    throw new Error(`SANDBOX_ID ${FIXED_ID} is not running`)
  }
  if (current) {
    const row = await findRunning(current.id)
    if (row) return row
  }
  current = await createSandbox()
  return current
}

async function waitForPairing(name: string, ms = 60000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const out = await exec(name, `export HOME=/home/user; browse status --json 2>/dev/null`)
    try {
      const j = JSON.parse(out.trim())
      if (j?.connected === true || j?.pairingState === "connected") return true
    } catch {}
    await sleep(3000)
  }
  return false
}

async function ensureRuntime(name: string): Promise<string> {
  const script = `export HOME=/home/user
if curl -sf -m 1 http://127.0.0.1:${AGENT_PORT}/ >/dev/null; then
  echo AGENT_UP
else
  setsid env HOME=/home/user AGENT_RUNTIME_PORT=${AGENT_PORT} /usr/local/bin/bun run /opt/agent-runtime/src/index.ts >>/tmp/agent-runtime.log 2>&1 < /dev/null &
  sleep 3
  if curl -sf -m 2 http://127.0.0.1:${AGENT_PORT}/ >/dev/null; then echo AGENT_STARTED; else echo AGENT_FAILED; tail -20 /tmp/agent-runtime.log; fi
fi`
  const out = await exec(name, script)
  if (!out.includes("AGENT_UP") && !out.includes("AGENT_STARTED")) {
    throw new Error(`agent-runtime failed to start: ${out.slice(0, 500)}`)
  }
  return out.includes("AGENT_STARTED") ? "started" : "up"
}

function urls(sb: any) {
  const host = new URL(BASE).host
  return {
    // same-origin proxy so noVNC can be embedded reliably
    vncUrl: `/vnc/vnc.html?autoconnect=1&resize=scale`,
    agentWsUrl: `wss://${host}/sandboxes/router/${sb.id}/${AGENT_PORT}/`,
  }
}

const PUBLIC = new URL("../public/", import.meta.url)

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req, srv) {
    const url = new URL(req.url)
    try {
      if (url.pathname === "/api/health") {
        return Response.json({ ok: true, sandbox: current?.name ?? null })
      }
      if (url.pathname === "/api/session" && req.method === "POST") {
        const sb = await ensureSandbox()
        const pairing = await waitForPairing(sb.name)
        await writeConfig(sb.name)
        const runtime = await ensureRuntime(sb.name)
        const u = urls(sb)
        return Response.json({
          sandboxID: sb.id,
          name: sb.name,
          pairing,
          runtime,
          ...u,
        })
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(Bun.file(new URL("index.html", PUBLIC)), {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      }
      // Same-origin proxy for noVNC (HTTP assets + WebSocket).
      if (url.pathname === "/vnc" || url.pathname.startsWith("/vnc/")) {
        const id = current?.id
        if (!id) return new Response("no session", { status: 503 })
        const rest = url.pathname.slice(4) || "/"
        const upstream = `${BASE}/sandboxes/router/${id}/${VNC_PORT}${rest}${url.search}`
        if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
          const ok = srv.upgrade(req, { data: { upstream: upstream.replace(/^http/, "ws") } })
          return ok ? (undefined as unknown as Response) : new Response("upgrade failed", { status: 500 })
        }
        const headers = new Headers(req.headers)
        headers.delete("host")
        headers.delete("connection")
        headers.delete("upgrade")
        const res = await fetch(upstream, { method: req.method, headers, body: req.body })
        const out = new Headers(res.headers)
        for (const k of ["content-encoding", "content-length", "transfer-encoding", "connection"]) out.delete(k)
        return new Response(res.body, { status: res.status, headers: out })
      }
      return new Response("not found", { status: 404 })
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 })
    }
  },
  websocket: {
    perMessageDeflate: false,
    open(ws: any) {
      const up = new WebSocket(ws.data.upstream)
      up.binaryType = "arraybuffer"
      ws.data.up = up
      up.onmessage = (e: any) => {
        try { ws.send(e.data) } catch {}
      }
      up.onclose = () => { try { ws.close() } catch {} }
      up.onerror = () => { try { ws.close() } catch {} }
    },
    message(ws: any, msg: any) {
      const up = ws.data.up
      if (up && up.readyState === 1) up.send(msg)
    },
    close(ws: any) {
      try { ws.data.up?.close() } catch {}
    },
  },
})

console.log(`[gateway] listening on http://localhost:${PORT}  (sandbox ${BASE})`)