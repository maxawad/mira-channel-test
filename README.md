# Mira Claude Code Channel

Mira Claude Code Channel is a plugin that lets you talk to a Claude Code session on your own computer from the Mira iOS app (the companion app for Mira glasses). You type or speak in the app, the message shows up in Claude Code, and Claude's answer is sent back to your phone.

## What it does

- Runs as a Claude Code "channel" plugin (an MCP server) and listens for chat requests on port 3141.
- Pushes each incoming app message into the active Claude Code session as a `<channel source="mira">` message.
- Uses Claude Code hooks (`Stop`, `PreToolUse`, `PostToolUse`, `SessionStart`) to stream status, tool activity, permission prompts and the final answer back to the app as server-sent events.
- Can open a Cloudflare tunnel so the phone can reach your computer when it is not on the same network.
- Checks for plugin updates and sends basic plugin telemetry events.

## Tech stack

- TypeScript, run with [Bun](https://bun.sh)
- `@modelcontextprotocol/sdk` and `zod`
- Claude Code plugin and marketplace format, with `cloudflared` for the optional tunnel

## Status

Prototype and test repository. It works as a development-stage plugin, but it needs three things outside this repo: Claude Code, the Mira iOS app, and the Mira backend (the tunnel setup and telemetry call the Mira staging backend). It cannot be tried as a static web page. The repository also includes copies of the Claude Code documentation (`channels.md`, `hooksinfo.md`, `plugininfo.md`) that the plugin was built against. That documentation belongs to Anthropic.

## Configuration

All settings are optional environment variables. See `.env.example`.

- `MIRA_TELEMETRY_URL`: where plugin events are posted. Defaults to `http://localhost:8000/telemetry/plugin-events`.
- `MIRA_HOME`: folder for plugin state. Defaults to `~/.mira-mcp`.
- `MIRA_SSE_HEARTBEAT_MS`: keep-alive interval for streaming responses. Defaults to 2000.

The plugin listens on all network interfaces on port 3141, so only run it on networks you trust.

## Install and run

Requirements: Claude Code, Bun, and optionally `cloudflared` (`brew install cloudflared` on macOS).

This is a development-stage channel, so it isn't on Anthropic's approved allowlist. You'll start Claude Code with `--dangerously-load-development-channels` to load it.

1. Add the marketplace, then install the plugin:

   ```sh
   claude
   # inside the Claude Code session:
   /plugin marketplace add big-halo/mira-claude-channel
   /plugin install mira@mira-marketplace
   ```

   Optional, but recommended: enable plugin auto-updates for this marketplace.
   Third-party marketplaces are not auto-updated by default.

   ```text
   /plugin → Marketplaces → mira-marketplace → Enable auto-update
   ```

   This marketplace intentionally does not set an explicit plugin `version`, so
   Claude Code uses the plugin source's git commit SHA for update detection.
   When the `main` branch changes, the next marketplace auto-update can install
   the new plugin cache. If Claude Code reports that a plugin updated, run
   `/reload-plugins` or restart the session.

2. Quit, then relaunch Claude Code with the development-channels flag:

   ```sh
   claude --dangerously-load-development-channels plugin:mira@mira-marketplace
   ```

   Confirm the prompt. Claude Code will spawn `server.ts` over stdio and the HTTP listener will start on `127.0.0.1:3141` automatically. You don't run `bun` yourself.

3. In the iOS app, open Settings → Claude Code → toggle **Local Integration** ON.

4. Send a message from the app. It will appear in your Claude Code session as a `<channel>` tag. Claude responds normally, and the `Stop` hook sends the final assistant message back to the app.

## Test from curl (no iOS app needed)

With Claude Code running per step 2 above, in another terminal:

```sh
curl -X POST http://127.0.0.1:3141/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"speaker":0,"content":"hello from curl"}],"user_local_time":"now","user_timezone":"UTC","location":null}'
```

The request opens an SSE response until Claude's `Stop` hook forwards the final assistant message (timeout 120s). The stream emits `{"text": "..."}`, `{"sources": []}`, then `[DONE]`, matching the format the iOS app expects.

## Structure

```
.claude-plugin/marketplace.json          # marketplace catalog
plugins/mira/
  .claude-plugin/plugin.json             # plugin manifest, declares mcpServers
  server.ts                              # MCP channel + Bun HTTP listener
  package.json                           # @modelcontextprotocol/sdk
```

## Credits

Built by Max Awad and the Mira team. The Claude Code plugin and channel format is by Anthropic.
