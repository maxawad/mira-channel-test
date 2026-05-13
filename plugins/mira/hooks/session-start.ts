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
  canShowTunnelUrl,
  CHANNELS_REQUIRED_MESSAGE,
  checkPluginUpdateState,
  TUNNEL_BLOCKED_MESSAGE,
} from '../plugin_update'

const URL_FILE = `${process.env.HOME}/.mira-mcp/tunnel.url`
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

// When channels are active the URL will arrive via channel notification — skip
// the polling loop so we output the placeholder fast and win the race.
let url = ''
let tunnelError = ''
if (!channelsActive) {
  for (let i = 0; i < 12 && !url; i++) {
    url = (await Bun.file(URL_FILE).text().catch(() => '')).trim()
    tunnelError = (await Bun.file(ERROR_FILE).text().catch(() => '')).trim()
    if (!url && !tunnelError) await Bun.sleep(500)
  }
}

const agentPrompt = (await Bun.file(AGENT_FILE).text().catch(() => '')).trim()

let systemMessage: string
try {
  const state = await checkPluginUpdateState({ pluginRoot: PLUGIN_ROOT })
  if (!canShowTunnelUrl(state)) {
    systemMessage = TUNNEL_BLOCKED_MESSAGE
  } else if (!channelsActive) {
    systemMessage = CHANNELS_REQUIRED_MESSAGE
  } else {
    systemMessage = 'Mira tunnel warming up — URL on its way…'
  }
} catch {
  systemMessage = channelsActive
    ? 'Mira tunnel warming up — URL on its way…'
    : CHANNELS_REQUIRED_MESSAGE
}

console.log(JSON.stringify({
  systemMessage,
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: agentPrompt,
  },
}))
