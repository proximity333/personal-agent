// agent-runtime: OpenCode SDK host + WebSocket gateway (sandbox side).
//
// MVP-0: boot OpenCode, expose events over WS, accept prompts.
// browse is wired as a local MCP server; press it via tools.browse.* (Code Mode).
//
// Env:
//   WORKSPACE           workspace dir (default /workspace)
//   AGENT_RUNTIME_PORT  WS/HTTP port (default 4096)
//   OPENCODE_MODEL      optional model id, e.g. "deepseek/deepseek-chat"

import { OpenCode } from "@opencode/sdk"

const directory = process.env.WORKSPACE ?? "/workspace"
const port = Number(process.env.AGENT_RUNTIME_PORT ?? 4096)
const model = process.env.OPENCODE_MODEL
const providerID = process.env.OPENCODE_PROVIDER_ID ?? "cb2"
const providerName = process.env.OPENCODE_PROVIDER_NAME ?? providerID
const baseURL = process.env.OPENCODE_BASE_URL
const apiKey = process.env.OPENCODE_API_KEY
const modelIDs = (process.env.OPENCODE_MODELS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
const browseBin = process.env.BROWSE_BIN ?? "/usr/local/bin/browse"

const providers: Record<string, unknown> = {}
if (baseURL && apiKey) {
  providers[providerID] = {
    name: providerName,
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL, apiKey },
    models: Object.fromEntries(modelIDs.map((id) => [id, { name: id }])),
  }
}

const opencode = await OpenCode.create({
  config: {
    ...(model ? { model } : {}),
    ...(Object.keys(providers).length ? { providers } : {}),
    mcp: {
      servers: {
        browse: {
          type: "local",
          command: [browseBin, "mcp"],
        },
      },
    },
  },
})

type Client = { send: (data: string) => void }
const clients = new Set<Client>()

// One global event subscription, broadcast to every connected client.
async function pumpEvents() {
  try {
    for await (const event of opencode.events.subscribe()) {
      const payload = JSON.stringify({ type: "event", event })
      for (const ws of clients) {
        try {
          ws.send(payload)
        } catch {
          clients.delete(ws)
        }
      }
    }
  } catch (err) {
    console.error("[agent-runtime] event stream ended:", err)
  }
}

const server = Bun.serve({
  port,
  fetch(req, srv) {
    if (srv.upgrade(req)) return undefined as unknown as Response
    return Response.json({ ok: true, service: "agent-runtime", port })
  },
  websocket: {
    async open(ws) {
      clients.add(ws as unknown as Client)
      try {
        const session = await opencode.sessions.create({
          location: { directory },
        })
        ws.send(JSON.stringify({ type: "session", sessionID: session.id }))
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", error: String(err) }))
      }
    },
    message(ws, raw) {
      void (async () => {
        try {
          const msg = JSON.parse(String(raw)) as {
            type?: string
            sessionID?: string
            text?: string
          }
          if (msg.type === "prompt" && msg.sessionID && msg.text) {
            await opencode.sessions.prompt({
              sessionID: msg.sessionID,
              text: msg.text,
            })
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", error: String(err) }))
        }
      })()
    },
    close(ws) {
      clients.delete(ws as unknown as Client)
    },
  },
})

void pumpEvents()
console.log(`[agent-runtime] listening on :${port}, workspace=${directory}`)
void server