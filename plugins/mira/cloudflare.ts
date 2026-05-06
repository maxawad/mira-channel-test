import { mkdirSync, writeFileSync, unlinkSync } from 'fs'

const CLOUDFLARED_DIR = `${process.env.HOME}/.mira-mcp`
const CLOUDFLARED_PATH = `${CLOUDFLARED_DIR}/cloudflared`
const TOKEN_PATH = `${CLOUDFLARED_DIR}/cloudflared.token`
const CONFIGURED_URL_PATH = `${CLOUDFLARED_DIR}/cloudflared.url`
// Persisted on disk so out-of-process consumers (e.g. SessionStart hooks)
// can read the current tunnel URL without talking to the MCP server.
export const TUNNEL_URL_FILE = `${CLOUDFLARED_DIR}/tunnel.url`

let tunnelUrl: string | null = null
let tunnelError: string | null = null
let tunnelMode: 'quick' | 'named' = 'quick'
let tunnelRunning = false

export const getTunnelUrl = () => tunnelUrl
export const getTunnelError = () => tunnelError
export const getTunnelMode = () => tunnelMode
export const isTunnelRunning = () => tunnelRunning

async function readOptionalFile(path: string): Promise<string | null> {
  const value = (await Bun.file(path).text().catch(() => '')).trim()
  return value || null
}

async function readTunnelToken(): Promise<string | null> {
  return (
    process.env.MIRA_CLOUDFLARED_TOKEN?.trim() ||
    process.env.CLOUDFLARED_TUNNEL_TOKEN?.trim() ||
    await readOptionalFile(TOKEN_PATH)
  )
}

async function readConfiguredTunnelUrl(): Promise<string | null> {
  return (
    process.env.MIRA_TUNNEL_URL?.trim() ||
    process.env.CLOUDFLARED_TUNNEL_URL?.trim() ||
    await readOptionalFile(CONFIGURED_URL_PATH)
  )
}

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

export async function openTunnel(port: number, log: (msg: string) => void): Promise<void> {
  // Wipe any stale URL from a prior run before we have a new one.
  clearTunnelUrlFile(log)

  const binary = await ensureCloudflared(log)
  const token = await readTunnelToken()
  const configuredUrl = await readConfiguredTunnelUrl()

  if (configuredUrl) {
    tunnelUrl = configuredUrl
    writeTunnelUrlFile(configuredUrl, log)
  }

  const args = token
    ? ['tunnel', 'run', '--token', token]
    : ['tunnel', '--url', `http://127.0.0.1:${port}`]
  tunnelMode = token ? 'named' : 'quick'
  tunnelError = token && !configuredUrl
    ? `Named Cloudflare tunnel is starting, but no public URL is configured. Set MIRA_TUNNEL_URL or write ${CONFIGURED_URL_PATH}.`
    : null

  log(`tunnel opening (cloudflared ${tunnelMode} tunnel)`)
  const proc = Bun.spawn([binary, ...args], {
    stderr: 'pipe',
    stdout: 'pipe',
    onExit: (_, code) => {
      log(`cloudflared exited code=${code}`)
      tunnelRunning = false
      tunnelUrl = null
      tunnelError = 'Tunnel closed. Restart the plugin to reconnect.'
      clearTunnelUrlFile(log)
    },
  })
  tunnelRunning = true

  ;(async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      const text = decoder.decode(chunk)
      buffer += text
      log(`cloudflared stderr ${text.trim()}`)
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (match && !tunnelUrl) {
        tunnelUrl = match[0]
        tunnelError = null
        writeTunnelUrlFile(tunnelUrl, log)
        log(`tunnel up url=${tunnelUrl}`)
      }
      if (tunnelMode === 'named' && /Registered tunnel connection|Connection .* registered|Starting tunnel/i.test(buffer)) {
        tunnelError = configuredUrl
          ? null
          : `Named Cloudflare tunnel is running. Set MIRA_TUNNEL_URL or write ${CONFIGURED_URL_PATH} so Claude can show the app endpoint.`
      }
    }
  })()
}
