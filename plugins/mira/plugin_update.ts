import { join } from 'path'
import { readFileSync } from 'fs'

const MARKETPLACE_NAME = 'mira-marketplace'
const PLUGIN_NAME = 'mira'
const REMOTE_PACKAGE_BASE_URL =
  'https://api.github.com/repos/big-halo/mira-claude-channel/contents/plugins/mira/package.json'
const DEFAULT_UPDATE_CHECK_TIMEOUT_MS = 3_000

export const UPDATE_NOTICE =
  'Plugin update required: /plugin → Marketplaces → mira-marketplace → update to latest + enable auto-update, then run /reload-plugins'

export const TUNNEL_BLOCKED_MESSAGE =
  'Mira tunnel URL: not available — plugin update required.\n' +
  'To get your URL: /plugin → Marketplaces → mira-marketplace → update to latest + enable auto-update, then run /reload-plugins'

export const AUTO_UPDATE_RELOAD_MESSAGE =
  'Mira plugin was out of date — auto-updated in the background.\n' +
  'Run /reload-plugins now to apply the update and get your tunnel URL.'

export type AutoUpdateResult = { ok: true } | { ok: false; reason: string }

export function autoUpdatePlugin(): AutoUpdateResult {
  try {
    const claudeBin =
      process.env.CLAUDE_BIN ??
      `${process.env.HOME}/.local/bin/claude`
    const result = Bun.spawnSync(
      [claudeBin, 'plugin', 'update', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    if (result.exitCode === 0) return { ok: true }
    const stderr = new TextDecoder().decode(result.stderr).trim()
    return { ok: false, reason: stderr || `exit ${result.exitCode}` }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

export type UpdateState = {
  checkedAt: number
  stale: boolean
  localVersion: string | null
  remoteVersion: string | null
}

/** Show the tunnel URL only when the plugin is not stale. */
export function canShowTunnelUrl(state: UpdateState): boolean {
  return !state.stale
}

export const CHANNELS_REQUIRED_MESSAGE =
  'Mira bridge not fully active — restart Claude with:\n' +
  '  claude --dangerously-load-development-channels plugin:mira@mira-marketplace\n' +
  '(or use the `mira` alias if you have it :)'

function localPluginVersion(pluginRoot: string): string | null {
  // server.ts lives at plugin root; hooks live one level deeper in hooks/
  const candidates = [
    join(pluginRoot, 'package.json'),
    join(pluginRoot, '..', 'package.json'),
  ]
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8'))
      if (typeof pkg.version === 'string') return pkg.version
    } catch { /* try next */ }
  }
  return null
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function checkPluginUpdateState({
  pluginRoot,
  timeoutMs = DEFAULT_UPDATE_CHECK_TIMEOUT_MS,
}: {
  pluginRoot: string
  timeoutMs?: number
}): Promise<UpdateState> {
  const localVersion = localPluginVersion(pluginRoot)

  const res = await fetchWithTimeout(`${REMOTE_PACKAGE_BASE_URL}?t=${Date.now()}`, timeoutMs)
  if (!res.ok) throw new Error(`remote_package_http_${res.status}`)

  const data = await res.json() as { content?: string; version?: unknown }
  let remoteVersion: string | null = null
  if (typeof data.content === 'string') {
    // GitHub API returns base64-encoded file content
    const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
    const pkg = JSON.parse(decoded) as { version?: unknown }
    remoteVersion = typeof pkg.version === 'string' ? pkg.version : null
  } else if (typeof data.version === 'string') {
    remoteVersion = data.version
  }

  const stale =
    localVersion !== null &&
    remoteVersion !== null &&
    localVersion !== remoteVersion

  return { checkedAt: Date.now(), stale, localVersion, remoteVersion }
}

export function appendUpdateNotice(text: string, state: UpdateState): string {
  if (!state.stale || text.includes(UPDATE_NOTICE)) return text
  return `${text.trimEnd()}\n\n${UPDATE_NOTICE}`
}
