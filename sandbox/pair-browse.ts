// Auto-pair the browse extension with the relay at sandbox boot.
//
// Flow:
//   1. wait for Chromium's CDP endpoint (--remote-debugging-port=9222)
//   2. if already paired, exit
//   3. run `browse pair`, read the one-time code
//   4. open the extension settings page via CDP and fill code + click Connect
//   5. verify via `browse status --json`
//
// Idempotent; safe to run on every boot.

const HOME = "/home/user"
const EXT_ID = process.env.BROWSE_EXT_ID ?? "lojchoakeilecchdlgcpblpieghlpnmk"
const CDP = "http://127.0.0.1:9222"
const env = { ...process.env, HOME, DISPLAY: process.env.DISPLAY ?? ":99" }

const log = (...a: any[]) => console.log(`[pair-browse]`, ...a)

async function status(): Promise<any | null> {
  try {
    const p = Bun.spawn(["browse", "status", "--json"], { env, stdout: "pipe", stderr: "ignore" })
    const out = await new Response(p.stdout).text()
    return JSON.parse(out)
  } catch {
    return null
  }
}

function isConnected(s: any): boolean {
  if (!s) return false
  return (
    s.connected === true ||
    s.pairingState === "connected" ||
    s.extension?.connected === true ||
    s.extension?.pairingState === "connected"
  )
}

async function waitForCDP(ms = 30000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return true
    } catch {}
    await Bun.sleep(500)
  }
  return false
}

class CDPClient {
  ws: WebSocket
  id = 0
  pending = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>()
  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data))
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!
        this.pending.delete(m.id)
        if (m.error) p.rej(new Error(JSON.stringify(m.error)))
        else p.res(m.result)
      }
    }
  }
  open() {
    return new Promise<void>((res, rej) => {
      this.ws.onopen = () => res()
      this.ws.onerror = (e) => rej(e)
    })
  }
  send(method: string, params: any = {}) {
    return new Promise<any>((res, rej) => {
      const id = ++this.id
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  close() {
    try { this.ws.close() } catch {}
  }
}

async function pageTarget() {
  const list = await fetch(`${CDP}/json`).then((r) => r.json())
  return list.find((t: any) => t.type === "page") ?? list[0]
}

function fillExpression(code: string) {
  return `(async () => {
    const code = ${JSON.stringify(code)};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let input, btn;
    for (let i = 0; i < 80; i++) {
      const inputs = [...document.querySelectorAll('input')];
      input = inputs.find((el) => (el.placeholder || '').trim() === 'XXXX-XXXX')
           || inputs.find((el) => /pair/i.test(el.placeholder || ''));
      const buttons = [...document.querySelectorAll('button')];
      btn = buttons.find((b) => /^(connect|pair)$/i.test((b.textContent || '').trim()));
      if (input && btn) break;
      await sleep(100);
    }
    if (!input) return { ok: false, reason: 'input not found' };
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, code);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.value = code;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
    if (!btn) return { ok: false, reason: 'button not found', value: input.value };
    btn.click();
    return { ok: true, value: input.value, button: (btn.textContent || '').trim() };
  })()`
}

async function pairOnce(code: string) {
  const target = await pageTarget()
  if (!target) throw new Error("no CDP page target")
  const c = new CDPClient(target.webSocketDebuggerUrl)
  await c.open()
  await c.send("Page.enable")
  await c.send("Page.navigate", { url: `chrome-extension://${EXT_ID}/settings.html` })
  await Bun.sleep(1200)
  const r = await c.send("Runtime.evaluate", {
    expression: fillExpression(code),
    awaitPromise: true,
    returnByValue: true,
  })
  c.close()
  return r?.result?.value
}

async function getPairCode(): Promise<string> {
  const p = Bun.spawn(["browse", "pair"], { env, stdout: "pipe", stderr: "pipe" })
  const reader = p.stdout.getReader()
  let buf = ""
  const end = Date.now() + 15000
  while (Date.now() < end) {
    const { value, done } = await reader.read()
    if (done) break
    buf += new TextDecoder().decode(value)
    const m = buf.match(/[0-9A-Z]{4}-[0-9A-Z]{4}/)
    if (m) return m[0]
  }
  throw new Error(`no pairing code: ${buf.slice(0, 200)}`)
}

async function waitConnected(ms = 30000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (isConnected(await status())) return true
    await Bun.sleep(1000)
  }
  return false
}

async function main() {
  if (isConnected(await status())) {
    log("already paired")
    return
  }
  if (!(await waitForCDP())) {
    log("CDP endpoint not available; skip")
    return
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const code = await getPairCode()
      log(`attempt ${attempt}: code ${code}`)
      const result = await pairOnce(code)
      log("fill result:", JSON.stringify(result))
      if (await waitConnected(30000)) {
        log("paired")
        return
      }
    } catch (err) {
      log(`attempt ${attempt} failed:`, String(err))
    }
  }
  log("could not pair")
}

await main()