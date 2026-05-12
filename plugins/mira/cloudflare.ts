import { mkdirSync, writeFileSync, unlinkSync } from 'fs'

const CLOUDFLARED_DIR = `${process.env.HOME}/.mira-mcp`
const CLOUDFLARED_PATH = `${CLOUDFLARED_DIR}/cloudflared`
// Persisted on disk so the SessionStart hook can read the current tunnel URL
// without talking to the MCP server.
const TUNNEL_URL_FILE = `${CLOUDFLARED_DIR}/tunnel.url`

let tunnelUrl: string | null = null
let tunnelError: string | null = null

export const getTunnelUrl = () => tunnelUrl
export const getTunnelError = () => tunnelError

function clearTunnelUrlFile(log: (msg: string) => void) {
  try {
    unlinkSync(TUNNEL_URL_FILE)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code && code !== 'ENOENT') {
      log(`tunnel.url unlink failed: ${(err as Error).message}`)
    }
  }
}

function writeTunnelUrlFile(url: string, log: (msg: string) => void) {
  try {
    mkdirSync(CLOUDFLARED_DIR, { recursive: true })
    writeFileSync(TUNNEL_URL_FILE, url)
  } catch (err) {
    log(`tunnel.url write failed: ${(err as Error).message}`)
  }
}

async function ensureCloudflared(log: (msg: string) => void): Promise<string> {
  if (await Bun.file(CLOUDFLARED_PATH).exists()) return CLOUDFLARED_PATH
  log('downloading cloudflared (first run)...')
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const os = process.platform === 'darwin' ? 'darwin' : 'linux'
  const ext = os === 'darwin' ? '.tgz' : ''
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${os}-${arch}${ext}`
  await Bun.spawn(['mkdir', '-p', CLOUDFLARED_DIR]).exited
  if (os === 'darwin') {
    await Bun.spawn(['sh', '-c', `curl -sL ${url} | tar xz -C ${CLOUDFLARED_DIR}`]).exited
  } else {
    await Bun.spawn(['sh', '-c', `curl -sL ${url} -o ${CLOUDFLARED_PATH} && chmod +x ${CLOUDFLARED_PATH}`]).exited
  }
  log('cloudflared downloaded')
  return CLOUDFLARED_PATH
}

type ProvisionResponse = { hostname: string; token: string }

type ProvisionOptions = {
  deviceId: string
  deviceLabel: string
  backendBaseUrl: string
  log: (msg: string) => void
}

async function fetchProvisionedTunnel(opts: ProvisionOptions): Promise<ProvisionResponse | null> {
  try {
    const res = await fetch(`${opts.backendBaseUrl}/tunnels/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: opts.deviceId,
        device_label: opts.deviceLabel,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      opts.log(`tunnel provision failed status=${res.status} body=${body.slice(0, 200)}`)
      return null
    }
    const data = (await res.json()) as ProvisionResponse
    if (!data?.hostname || !data?.token) {
      opts.log(`tunnel provision malformed response`)
      return null
    }
    return data
  } catch (err) {
    opts.log(`tunnel provision error: ${(err as Error).message}`)
    return null
  }
}

export async function openProvisionedTunnel(opts: ProvisionOptions): Promise<void> {
  clearTunnelUrlFile(opts.log)

  const provisioned = await fetchProvisionedTunnel(opts)
  if (provisioned) {
    opts.log(`tunnel provisioned hostname=${provisioned.hostname}`)
  }

  if (!provisioned) {
    tunnelError = 'Could not provision tunnel from backend. Reconnect to retry.'
    return
  }

  const binary = await ensureCloudflared(opts.log)
  const url = `https://${provisioned.hostname}`
  tunnelUrl = url
  tunnelError = null
  writeTunnelUrlFile(url, opts.log)

  opts.log(`tunnel opening (provisioned) hostname=${provisioned.hostname}`)
  const proc = Bun.spawn(
    [binary, 'tunnel', 'run', '--token', provisioned.token],
    {
      stderr: 'pipe',
      stdout: 'pipe',
      onExit: (_, code) => {
        opts.log(`cloudflared exited code=${code}`)
        tunnelUrl = null
        tunnelError = 'Tunnel closed. Restart the plugin to reconnect.'
        clearTunnelUrlFile(opts.log)
      },
    },
  )

  ;(async () => {
    const decoder = new TextDecoder()
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      opts.log(`cloudflared stderr ${decoder.decode(chunk).trim()}`)
    }
  })()

  const killChild = () => {
    try { proc.kill() } catch { /* best-effort */ }
  }
  process.once('exit', killChild)
  process.once('SIGTERM', killChild)
  process.once('SIGINT', killChild)
}
