# Always Listening — Claude Code channel

A Claude Code channel plugin that bridges chat from the Always Listening G1 iOS app into a local Claude Code session.

When the iOS app's "Claude Code" toggle is ON, every message the user sends from the app POSTs to `http://127.0.0.1:3141/api/chat` on your laptop. This plugin runs as an MCP channel inside Claude Code, receives the POST, pushes the message into the active Claude Code session as a `<channel source="alwayslistening" chat_id="...">` tag, and waits. When Claude calls the `reply` tool, the response is delivered back to the iOS app.

## Install

This is a development-stage channel, so it isn't on Anthropic's approved allowlist. You'll start Claude Code with `--dangerously-load-development-channels` to load it.

1. Add this directory as a local marketplace, then install the plugin:

   ```sh
   claude
   # inside the Claude Code session:
   /plugin marketplace add /Users/caineardayfio/alwayslistening-claude-channel
   /plugin install alwayslistening@alwayslistening-marketplace
   ```

2. Quit, then relaunch Claude Code with the development-channels flag:

   ```sh
   claude --dangerously-load-development-channels plugin:alwayslistening@alwayslistening-marketplace
   ```

   Confirm the prompt. Claude Code will spawn `server.ts` over stdio and the HTTP listener will start on `127.0.0.1:3141` automatically. You don't run `bun` yourself.

3. In the iOS app, open Settings → Claude Code → toggle **Local Integration** ON.

4. Send a message from the app. It will appear in your Claude Code session as a `<channel>` tag. Claude responds by calling the `reply` tool, and the text shows up back in the app.

## Test from curl (no iOS app needed)

With Claude Code running per step 2 above, in another terminal:

```sh
curl -X POST http://127.0.0.1:3141/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"speaker":0,"content":"hello from curl"}],"user_local_time":"now","user_timezone":"UTC","location":null}'
```

The request blocks until Claude calls `reply` (timeout 120s). The response body is `{"text": "...", "sources": [], "debug": null}`, matching the format the iOS app expects.

## Structure

```
.claude-plugin/marketplace.json          # marketplace catalog
plugins/alwayslistening/
  .claude-plugin/plugin.json             # plugin manifest, declares mcpServers
  server.ts                              # MCP channel + Bun HTTP listener
  package.json                           # @modelcontextprotocol/sdk
```
