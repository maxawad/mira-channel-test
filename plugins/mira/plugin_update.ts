const MARKETPLACE_NAME = 'mira-marketplace'
const PLUGIN_NAME = 'mira'
const UPSTREAM_COMPARE_URL =
  'https://api.github.com/repos/big-halo/mira-claude-channel/compare'
const DEFAULT_UPDATE_CHECK_TIMEOUT_MS = 1_000

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
    const result = Bun.spawnSync(
      ['claude', 'plugin', 'update', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`],
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
  status: string | null
}

/** Show the tunnel URL only when the plugin is not stale (latest version = auto-update is working). */
export function canShowTunnelUrl(state: UpdateState): boolean {
  return !state.stale
}

export const CHANNELS_REQUIRED_MESSAGE =
  'Mira bridge not fully active — restart Claude with:\n' +
  '  claude --dangerously-load-development-channels plugin:mira@mira-marketplace\n' +
  '(or use the `mira` alias if you have it :)'

export function pluginCacheVersion(root: string): string | null {
  const parts = root.split(/[\\/]+/).filter(Boolean)
  for (let i = 0; i < parts.length - 3; i++) {
    if (
      parts[i] === 'cache' &&
      parts[i + 1] === MARKETPLACE_NAME &&
      parts[i + 2] === PLUGIN_NAME
    ) {
      const version = parts[i + 3]
      if (/^[0-9a-f]{7,40}$/i.test(version)) return version
    }
  }
  return null
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'mira-claude-channel',
      },
      signal: controller.signal,
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
  const localVersion = pluginCacheVersion(pluginRoot)
  if (!localVersion) {
    return {
      checkedAt: Date.now(),
      stale: false,
      localVersion: null,
      status: 'unknown_local_version',
    }
  }

  const compareUrl =
    `${UPSTREAM_COMPARE_URL}/${encodeURIComponent(localVersion)}...main`
  const res = await fetchWithTimeout(compareUrl, timeoutMs)
  if (!res.ok) {
    throw new Error(`github_compare_http_${res.status}`)
  }

  const data = await res.json() as { status?: unknown }
  const status = typeof data.status === 'string' ? data.status : 'unknown'
  return {
    checkedAt: Date.now(),
    stale: status === 'ahead' || status === 'diverged',
    localVersion,
    status,
  }
}

export function appendUpdateNotice(text: string, state: UpdateState): string {
  if (!state.stale || text.includes(UPDATE_NOTICE)) return text
  return `${text.trimEnd()}\n\n${UPDATE_NOTICE}`
}

