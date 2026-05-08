#!/usr/bin/env bun
// SessionStart hook: surface the current Mira tunnel URL.
// The URL is persisted by cloudflare.ts to ~/.mira-mcp/tunnel.url whenever
// cloudflared finishes publishing a quick tunnel. We poll briefly because
// SessionStart fires before the MCP server (and therefore the tunnel) is up.

const URL_FILE = `${process.env.HOME}/.mira-mcp/tunnel.url`

let url = ''
for (let i = 0; i < 12 && !url; i++) {
  url = (await Bun.file(URL_FILE).text().catch(() => '')).trim()
  if (!url) await Bun.sleep(500)
}

console.log(JSON.stringify({
  systemMessage: url ? `Mira Tunnel URL (paste this in the Mira app under Integrations > Claude Code): ${url}` : `Mira tunnel: still starting up…`,
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext:
      `Hey, I'm your co-founder. I'm talking to you on my smart glasses, so always respond to me in just one or two sentences. Never respond to me with more than three sentences.`,
  },
}))
