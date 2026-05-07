#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { openTunnel, getTunnelUrl, getTunnelError, getTunnelMode, isTunnelRunning } from './cloudflare'
import { join } from 'path'
import { homedir } from 'os'

const PORT = Number(process.env.MIRA_PORT ?? 3141)
const REQUEST_TIMEOUT_MS = 120_000

const LOG_FILE = process.env.MIRA_LOG ?? '/tmp/mira.log'
function log(msg: string, extra?: unknown) {
  const line =
    `[${new Date().toISOString()}] ${msg}` +
    (extra !== undefined ? ` ${safeStringify(extra)}` : '') +
    '\n'
  // stderr also goes to Claude Code's debug log when run with --debug
  process.stderr.write(line)
  try {
    appendFileSync(LOG_FILE, line)
  } catch {
    // best-effort; never crash on logging
  }
}
function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function sessionMarkdownPath(userDir: string, session: BackendSession): string {
  const title =
    (session.title?.trim() || 'untitled')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  const date = (session.start_time ?? 'unknown-date').slice(0, 10)
  return join(userDir, `${session.id}-${title}-${date}.md`)
}

async function syncConversationsToMarkdown() {
  if (!connection) return
  const listRes = await backendGet('/messages/list')
  if (!listRes.ok) {
    const body = await listRes.text().catch(() => '')
    log(`conversation sync backend error status=${listRes.status} body=${body.slice(0, 200)}`)
    return
  }
  const data = (await listRes.json()) as { sessions: BackendSession[] }
  const sessions = data.sessions ?? []
  const userDir = join(homedir(), '.mira', connection.userId)
  mkdirSync(userDir, { recursive: true })
  for (const session of sessions) {
    const path = sessionMarkdownPath(userDir, session)
    if (existsSync(path)) {
      continue
    }
    const detailRes = await backendGet(
      `/messages/sessions/${encodeURIComponent(session.id)}?include_messages=true`,
    )
    if (!detailRes.ok) {
      const body = await detailRes.text().catch(() => '')
      log(`session sync failed id=${session.id} status=${detailRes.status} body=${body.slice(0, 200)}`)
      continue
    }
    const detail = (await detailRes.json()) as BackendSessionDetail
    const messages = detail.messages ?? []
    const markdown = [
      `# ${detail.title?.trim() || '(untitled)'}`,
      '',
      `Session ID: ${detail.id}`,
      `Time: ${detail.start_time ?? '(no start time)'} -> ${detail.end_time ?? '(no end time)'}`,
      detail.summary?.trim() ? `Summary: ${detail.summary.trim()}` : null,
      '',
      '## Transcript',
      '',
      ...messages.map((m) => `[${m.timestamp}] speaker ${m.speaker}: ${m.text}`),
      '',
    ].filter(Boolean).join('\n')
    writeFileSync(path, markdown, 'utf8')
  }
  log(`conversation sync OK user_id=${connection.userId} sessions=${sessions.length}`)
}

log(`boot pid=${process.pid} port=${PORT} log=${LOG_FILE}`)

type Pending = {
  resolve: (response: ChatResponse) => void
  reject: (error: ChatClosedError) => void
  timer: ReturnType<typeof setTimeout>
}

type ChatCloseReason = 'timeout' | 'superseded'

type ChatResponse = {
  text: string
  sources: unknown[]
  debug: null
}

class ChatClosedError extends Error {
  constructor(readonly reason: ChatCloseReason) {
    super(reason)
    this.name = 'ChatClosedError'
  }
}

let active: Pending | null = null
const pendingPermissions = new Set<string>()
const encoder = new TextEncoder()

async function denyAllPendingPermissions() {
  if (pendingPermissions.size === 0) return
  log(`denying ${pendingPermissions.size} stale permissions`)
  for (const id of pendingPermissions) {
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: id, behavior: 'deny' },
    })
  }
  pendingPermissions.clear()
}

function closeActive(reason: ChatCloseReason) {
  const p = active
  if (!p) return
  active = null
  clearTimeout(p.timer)
  p.reject(new ChatClosedError(reason))
}

function resetTimeout() {
  const p = active
  if (!p) return
  clearTimeout(p.timer)
  p.timer = setTimeout(() => {
    log(`chat TIMEOUT after ${REQUEST_TIMEOUT_MS}ms`)
    closeActive('timeout')
  }, REQUEST_TIMEOUT_MS)
}

function sseSend(controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
}

function openPendingChat(): { entry: Pending; response: Promise<ChatResponse> } {
  let entry!: Pending
  const response = new Promise<ChatResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (active === entry) {
        log(`chat TIMEOUT after ${REQUEST_TIMEOUT_MS}ms`)
        closeActive('timeout')
      }
    }, REQUEST_TIMEOUT_MS)
    entry = { resolve, reject, timer }
    active = entry
  })
  response.catch(() => undefined)
  return { entry, response }
}

function responseToSse(response: Promise<ChatResponse>) {
  return new ReadableStream({
    async start(controller) {
      try {
        const payload = await response
        sseSend(controller, { text: payload.text })
        sseSend(controller, { sources: payload.sources })
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } catch (err) {
        const message = err instanceof ChatClosedError ? err.reason : 'failed'
        sseSend(controller, { error: message })
      } finally {
        controller.close()
      }
    },
  })
}

function cancelPendingChat(entry: Pending) {
  if (active !== entry) return
  active = null
  clearTimeout(entry.timer)
  entry.resolve({ text: '', sources: [], debug: null })
}

type Connection = {
  userId: string
  accessToken: string
  backendBaseUrl: string
  connectedAt: number
}
let connection: Connection | null = null

const mcp = new Server(
  { name: 'mira', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      tools: {},
    },
    instructions:
      'Messages from the Mira iOS app arrive as <channel source="mira"> tags. ' +
      'The body of the tag is the user\'s spoken/typed message. ' +
      'Respond normally in your final assistant message; Mira sends that message to the glasses automatically when the turn stops. ' +
      'The user is on glasses and cannot see your terminal output, so put user-facing text in your final assistant message. ' +
      'When the user asks for the tunnel URL, endpoint URL, or Mira setup info, call the `help` tool — do NOT search memory or files. ' +
      'When asked about past memories or conversations, search the local transcript cache at ~/.mira/*/*.md with filesystem search first, then read only the relevant matching session files.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  log('mcp list_tools')
  return {
    tools: [
      {
        name: 'help',
        description:
          'Returns the public tunnel URL for the Mira iOS app, plus setup help. Call this when the user asks for their endpoint URL, asks how to set this up, or says messages from the app aren\'t reaching Claude.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }
})

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  log(`mcp call_tool name=${req.params.name}`, req.params.arguments)

  if (req.params.name === 'help') {
    const tunnelUrl = getTunnelUrl()
    const tunnelError = getTunnelError()
    const tunnelMode = getTunnelMode()
    let statusLine: string
    if (tunnelUrl) {
      statusLine = `Mira tunnel URL: ${tunnelUrl}`
    } else if (tunnelMode === 'named' && isTunnelRunning()) {
      statusLine =
        'Mira named Cloudflare tunnel is running, but no public URL is configured in MIRA_TUNNEL_URL.'
    } else if (tunnelError) {
      statusLine = `Tunnel unavailable: ${tunnelError}`
    } else {
      statusLine = 'Mira tunnel URL: (tunnel not ready yet — try again in a few seconds)'
    }
    return {
      content: [
        {
          type: 'text',
          text:
            `${statusLine}\n\n` +
            `To use a named Cloudflare tunnel, set MIRA_CLOUDFLARED_TOKEN and MIRA_TUNNEL_URL before starting Claude Code.\n\n` +
            `If messages from the iOS app aren't reaching Claude, restart Claude Code with:\n` +
            `  claude --dangerously-load-development-channels plugin:mira@mira-marketplace\n` +
            `That flag is required for Claude Code to surface inbound channel notifications from this plugin.`,
        },
      ],
    }
  }

  log(`mcp call_tool unknown tool=${req.params.name}`)
  throw new Error(`unknown tool: ${req.params.name}`)
})

// Permission relay: Claude Code asks user for approval
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const { request_id, tool_name } = params
  log(`permission_request request_id=${request_id} tool=${tool_name}`)
  const p = active
  if (!p) {
    pendingPermissions.add(request_id)
    return
  }
  resetTimeout()
  pendingPermissions.add(request_id)
  log(`permission_request QUEUED request_id=${request_id}`)
})

// MARK: - Backend transcript helpers

type BackendSession = {
  id: string
  title?: string | null
  summary?: string | null
  summary_generated?: boolean
  start_time?: string | null
  end_time?: string | null
  share_token?: string | null
}

type BackendMessage = {
  id: string
  text: string
  speaker: number
  timestamp: string
  is_final: boolean
}

type BackendSessionDetail = BackendSession & {
  messages?: BackendMessage[]
  message_count?: number
}

async function backendGet(path: string): Promise<Response> {
  if (!connection) throw new Error('not connected')
  const url = `${connection.backendBaseUrl}${path}`
  return fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      Accept: 'application/json',
    },
  })
}

await mcp.connect(new StdioServerTransport())
log('mcp stdio connected')

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const ua = req.headers.get('user-agent') ?? ''
    log(`http ${req.method} ${url.pathname} ua=${ua.slice(0, 60)}`)

    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ status: 'ok', active: active !== null })
    }

    if (req.method === 'POST' && url.pathname === '/connect') {
      let body: any
      try {
        body = await req.json()
      } catch {
        log('http /connect invalid json')
        return Response.json({ error: 'invalid json' }, { status: 400 })
      }
      const userId = (body?.user_id ?? '').toString().trim()
      const accessToken = (body?.access_token ?? '').toString().trim()
      const rawBackend = (body?.backend_base_url ?? '').toString().trim()
      if (!userId || !accessToken || !rawBackend) {
        log('http /connect missing fields')
        return Response.json(
          { error: 'user_id, access_token, and backend_base_url are required' },
          { status: 400 },
        )
      }
      let backendBaseUrl = rawBackend.replace(/\/+$/, '')
      try {
        const parsed = new URL(backendBaseUrl)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('protocol must be http(s)')
        }
      } catch (err) {
        log(`http /connect bad backend_base_url=${rawBackend} err=${(err as Error).message}`)
        return Response.json({ error: 'backend_base_url is not a valid URL' }, { status: 400 })
      }
      connection = {
        userId,
        accessToken,
        backendBaseUrl,
        connectedAt: Date.now(),
      }

      void syncConversationsToMarkdown().catch((err) => {
        log(`conversation sync failed: ${(err as Error).message}`)
      })

      log(`connect OK user_id=${userId} backend=${backendBaseUrl} token_len=${accessToken.length}`)
      return Response.json({
        status: 'connected',
        user_id: userId,
        plugin_version: '0.1.0',
      })
    }

    if (req.method === 'GET' && url.pathname === '/connect/status') {
      if (!connection) {
        return Response.json({ connected: false })
      }
      return Response.json({
        connected: true,
        user_id: connection.userId,
        connected_at: connection.connectedAt,
      })
    }

    if (req.method === 'POST' && url.pathname === '/disconnect') {
      const wasConnected = connection !== null
      const userId = connection?.userId
      connection = null
      log(`disconnect was_connected=${wasConnected} user_id=${userId ?? '(none)'}`)
      return Response.json({ status: 'disconnected' })
    }

    if (req.method === 'POST' && url.pathname === '/api/permission') {
      const body = await req.json() as { request_id?: string; response?: string }
      const { request_id, response } = body
      if (!request_id || !response) {
        return Response.json({ error: 'missing request_id or response' }, { status: 400 })
      }
      log(`permission_response request_id=${request_id} response=${response}`)
      pendingPermissions.delete(request_id)
      resetTimeout()
      const behavior =
        response === 'allow' ? 'allow' :
        response === 'allow_permanent' ? 'allow_always' :
        'deny'
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id, behavior },
      })
      return Response.json({ status: 'recorded' })
    }

    if (req.method === 'POST' && url.pathname === '/api/cancel-permissions') {
      await denyAllPendingPermissions()
      return Response.json({ status: 'cancelled' })
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      let body: any
      try {
        body = await req.json()
      } catch {
        log('http /api/stop invalid json')
        return Response.json({ status: 'ignored', reason: 'invalid_json' })
      }

      const text = (body?.last_assistant_message ?? '').toString()
      if (!text.trim()) {
        log('http /api/stop empty last_assistant_message')
        return Response.json({ status: 'ignored', reason: 'empty_message' })
      }

      const p = active
      if (!p) {
        log(`stop NO-MATCH no-active session=${body?.session_id ?? '(unknown)'}`)
        return Response.json({ status: 'ignored', reason: 'no_active_chat' })
      }

      active = null
      clearTimeout(p.timer)
      if (pendingPermissions.size > 0) {
        log(`clearing ${pendingPermissions.size} stale permissions on stop`)
        pendingPermissions.clear()
      }
      log(`stop OK text_len=${text.length}`)
      p.resolve({ text, sources: [], debug: null })
      return Response.json({ status: 'delivered' })
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      // Clear any stale permissions before processing a new chat
      await denyAllPendingPermissions()
      // A new chat supersedes any in-flight one (the model can only answer one at a time)
      closeActive('superseded')
      let body: any
      try {
        body = await req.json()
      } catch {
        log('http /api/chat invalid json')
        return new Response('invalid json', { status: 400 })
      }

      const messages: Array<{ speaker?: number; content?: string; text?: string }> =
        body?.messages ?? []
      const last = messages[messages.length - 1]
      const userText = (last?.content ?? last?.text ?? '').toString()
      if (!userText) {
        log('http /api/chat empty content', body)
        return Response.json({ error: { message: 'no message content' } }, { status: 400 })
      }

      const meta: Record<string, string> = {}
      if (typeof body?.user_local_time === 'string') meta.user_local_time = body.user_local_time
      if (typeof body?.user_timezone === 'string') meta.user_timezone = body.user_timezone

      log(`chat IN text=${JSON.stringify(userText.slice(0, 200))}`)

      const { entry, response } = openPendingChat()
      log('mcp notify → notifications/claude/channel')
      try {
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: { content: userText, meta },
        })
        log('mcp notify ✓')

        return new Response(responseToSse(response), {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      } catch (err) {
        cancelPendingChat(entry)
        log(`chat failed err=${(err as Error).message}`)
        return Response.json({ error: { message: 'failed to send message to Claude' } }, { status: 500 })
      }
    }

    return new Response('not found', { status: 404 })
  },
})

log(`http listener up on http://127.0.0.1:${PORT}`)

openTunnel(PORT, log)
