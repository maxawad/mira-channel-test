
const CLOUDFLARED_MISSING_MESSAGE =
  'cloudflared not found on PATH. Install it with `brew install cloudflared` (macOS) ' +
  'or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/, then reconnect.'

let tunnelUrl: string | null = null
let tunnelError: string | null = null

export const getTunnelUrl = () => tunnelUrl
export const getTunnelError = () => tunnelError

function findCloudflared(): string | null {
  // Prefer a vendored copy at ~/.mira-mcp/cloudflared(.exe) — useful on Windows
  // where users typically don't have cloudflared on PATH.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.'
  const vendored =
    process.platform === 'win32'
      ? `${home}\\.mira-mcp\\cloudflared.exe`
      : `${home}/.mira-mcp/cloudflared`
  if (Bun.spawnSync([vendored, '--version']).exitCode === 0) return vendored

  const lookup = process.platform === 'win32' ? 'where' : 'which'
  const result = Bun.spawnSync([lookup, 'cloudflared'])
  if (result.exitCode !== 0) return null
  const path = new TextDecoder().decode(result.stdout).trim().split(/\r?\n/)[0]
  return path || null
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
      opts.log(`tunnel provision failed status=${res.status} body=${body}`)
      return null
    }
    const data = (await res.json()) as ProvisionResponse
    if (!data?.hostname || !data?.token) {
      opts.log(`tunnel provision malformed response`)
      return null
    }
    return data
  } catch (err) {
    opts.log(`tunnel provision error: ${(err as Error).stack ?? (err as Error).message}`)
    return null
  }
}

export async function openProvisionedTunnel(opts: ProvisionOptions): Promise<void> {
  const provisioned = await fetchProvisionedTunnel(opts)
  if (provisioned) {
    opts.log(`tunnel provisioned hostname=${provisioned.hostname}`)
  }

  if (!provisioned) {
    tunnelError = 'Could not provision tunnel from backend. Reconnect to retry.'
    return
  }

  const binary = findCloudflared()
  if (!binary) {
    opts.log('cloudflared not found on PATH')
    tunnelError = CLOUDFLARED_MISSING_MESSAGE
    return
  }
  opts.log(`cloudflared found at ${binary}`)
  tunnelUrl = `https://${provisioned.hostname}`
  tunnelError = null

  opts.log(`tunnel opening (provisioned) url=${tunnelUrl} hostname=${provisioned.hostname}`)
  const proc = Bun.spawn(
    [binary, 'tunnel', 'run', '--token', provisioned.token],
    {
      stderr: 'pipe',
      stdout: 'pipe',
      onExit: (_, code) => {
        opts.log(`cloudflared exited code=${code}`)
        tunnelUrl = null
        tunnelError = 'Tunnel closed. Restart the plugin to reconnect.'
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
