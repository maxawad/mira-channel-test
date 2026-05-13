#!/usr/bin/env bun
// SessionStart hook: surface the current Mira tunnel URL.
//
// We also dump the Mira agent prompt (agents/mira.md) into additionalContext.
// The same prompt already loads via the agent file, but repeating it in the
// session context noticeably improves adherence — the model treats it as a
// live system instruction rather than just a definition. mira.md stays the
// single source of truth; edit it there and both paths pick up the change.

import { join } from 'path'
import {
  autoUpdatePlugin,
  AUTO_UPDATE_RELOAD_MESSAGE,
  canShowTunnelUrl,
  CHANNELS_REQUIRED_MESSAGE,
  checkPluginUpdateState,
  TUNNEL_BLOCKED_MESSAGE,
} from '../plugin_update'

const URL_FILE = `${process.env.HOME}/.mira-mcp/tunnel.url`
const ERROR_FILE = `${process.env.HOME}/.mira-mcp/tunnel.error`
const AGENT_FILE = join(import.meta.dir, '..', 'agents', 'mira.md')
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? join(import.meta.dir, '..')

function hasChannelsFlag(): boolean {
  try {
    let pid = process.ppid
    for (let i = 0; i < 8; i++) {
      const proc = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'ppid=,args='])
      const line = new TextDecoder().decode(proc.stdout).trim()
      if (!line) break
      if (line.includes('dangerously-load-development-channels')) return true
      const spaceIdx = line.indexOf(' ')
      if (spaceIdx < 0) break
      const ppid = parseInt(line.slice(0, spaceIdx).trim())
      if (!ppid || ppid === pid || ppid <= 1) break
      pid = ppid
    }
  } catch {}
  return false
}

const channelsActive = hasChannelsFlag()

// Poll for tunnel URL regardless of channels mode — embed it directly in the startup message.
let url = ''
let tunnelError = ''
for (let i = 0; i < 12 && !url && !tunnelError; i++) {
  url = (await Bun.file(URL_FILE).text().catch(() => '')).trim()
  tunnelError = (await Bun.file(ERROR_FILE).text().catch(() => '')).trim()
  if (!url && !tunnelError) await Bun.sleep(500)
}

const agentPrompt = (await Bun.file(AGENT_FILE).text().catch(() => '')).trim()

const tunnelLine = url
  ? `Mira tunnel URL (paste in Mira iOS app → Integrations → Claude Code):\n${url}`
  : tunnelError
    ? `Mira tunnel unavailable: ${tunnelError}`
    : `Mira tunnel still starting up…`

let systemMessage: string
try {
  const state = await checkPluginUpdateState({ pluginRoot: PLUGIN_ROOT })
  if (!canShowTunnelUrl(state)) {
    const updated = autoUpdatePlugin()
    const notice = updated.ok ? AUTO_UPDATE_RELOAD_MESSAGE : TUNNEL_BLOCKED_MESSAGE
    systemMessage = `${tunnelLine}\n\n${notice}`
  } else if (!channelsActive) {
    systemMessage = CHANNELS_REQUIRED_MESSAGE
  } else {
    systemMessage = `Mira is live — glasses connected, tunnel coming in hot 🫡\n\n${tunnelLine}`
  }
} catch {
  systemMessage = channelsActive
    ? `Mira is live — glasses connected, tunnel coming in hot 🫡\n\n${tunnelLine}`
    : CHANNELS_REQUIRED_MESSAGE
}

console.log(JSON.stringify({
  systemMessage,
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: agentPrompt,
  },
}))
