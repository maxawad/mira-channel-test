#!/usr/bin/env bun
// SessionStart hook: surface the current Mira tunnel URL.
//
// We also dump the Mira agent prompt (agents/mira.md) into additionalContext.
// The same prompt already loads via the agent file, but repeating it in the
// session context noticeably improves adherence — the model treats it as a
// live system instruction rather than just a definition. mira.md stays the
// single source of truth; edit it there and both paths pick up the change.

import { join } from 'path'
import { appendFileSync } from 'fs'
import { tmpdir } from 'os'
import {
  autoUpdatePlugin,
  AUTO_UPDATE_RELOAD_MESSAGE,
  canShowTunnelUrl,
  checkPluginUpdateState,
  TUNNEL_BLOCKED_MESSAGE,
} from '../plugin_update'

const AGENT_FILE = join(import.meta.dir, '..', 'agents', 'mira.md')
const LOG_FILE = join(tmpdir(), 'mira.log')

function log(msg: string) {
  try {
    appendFileSync(LOG_FILE, `[session-start] ${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

function inspectProcessWindows(pid: number): { ppid: number; cmd: string } | null {
  // Returns "<ParentProcessId>|||<CommandLine>" so we don't have to deal with
  // embedded newlines or PowerShell escapes inside a JS template literal.
  const script =
    '$p = Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '" -ErrorAction SilentlyContinue; ' +
    'if ($p) { Write-Output ("" + $p.ParentProcessId + "|||" + $p.CommandLine) }'
  const proc = Bun.spawnSync(['powershell', '-NoProfile', '-Command', script])
  const out = new TextDecoder().decode(proc.stdout).trim()
  if (!out) return null
  const sep = out.indexOf('|||')
  if (sep < 0) return null
  const ppid = parseInt(out.slice(0, sep).trim())
  const cmd = out.slice(sep + 3).trim()
  if (!ppid || !cmd) return null
  return { ppid, cmd }
}

function inspectProcessUnix(pid: number): { ppid: number; cmd: string } | null {
  const proc = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'ppid=,args='])
  const line = new TextDecoder().decode(proc.stdout).trim()
  if (!line) return null
  const spaceIdx = line.indexOf(' ')
  if (spaceIdx < 0) return null
  const ppid = parseInt(line.slice(0, spaceIdx).trim())
  const cmd = line.slice(spaceIdx + 1).trim()
  if (!ppid) return null
  return { ppid, cmd }
}

function hasChannelsFlagWindowsAnyProcess(): boolean {
  // Walking the parent tree from a hook child can miss claude.exe if Claude
  // Code wraps the hook in extra intermediate processes. Just look at every
  // process's command line — the flag is unique enough that a global match is
  // a safe positive signal.
  try {
    const script =
      'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ' +
      'Where-Object { $_.CommandLine -like "*dangerously-load-development-channels*" } | ' +
      'Select-Object -First 1 ProcessId'
    const proc = Bun.spawnSync(['powershell', '-NoProfile', '-Command', script])
    const out = new TextDecoder().decode(proc.stdout).trim()
    return out.length > 0
  } catch {
    return false
  }
}

function hasChannelsFlag(): boolean {
  try {
    let pid = process.ppid
    const inspect = process.platform === 'win32' ? inspectProcessWindows : inspectProcessUnix
    for (let i = 0; i < 8; i++) {
      const info = inspect(pid)
      if (!info) break
      if (info.cmd.includes('dangerously-load-development-channels')) return true
      if (!info.ppid || info.ppid === pid || info.ppid <= 1) break
      pid = info.ppid
    }
    if (process.platform === 'win32') return hasChannelsFlagWindowsAnyProcess()
  } catch {}
  return false
}

const channelsActive = hasChannelsFlag()
log(`channels-flag=${channelsActive}`)

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? join(import.meta.dir, '..')
const agentPrompt = (await Bun.file(AGENT_FILE).text().catch(() => '')).trim()

let systemMessage: string
if (!channelsActive) {
  systemMessage = 'Mira will not work — restart Claude with: claude --dangerously-load-development-channels plugin:mira@mira-marketplace'
} else {
  try {
    const state = await checkPluginUpdateState({ pluginRoot: PLUGIN_ROOT })
    if (!canShowTunnelUrl(state)) {
      const updated = autoUpdatePlugin()
      systemMessage = updated.ok ? AUTO_UPDATE_RELOAD_MESSAGE : TUNNEL_BLOCKED_MESSAGE
    } else {
      systemMessage = 'Mira is spinning up — tunnel coming in hot 🫡'
    }
  } catch {
    systemMessage = 'Mira is spinning up — tunnel coming in hot 🫡'
  }
}

console.log(JSON.stringify({
  systemMessage,
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: agentPrompt,
  },
}))
