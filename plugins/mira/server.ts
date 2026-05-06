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
  controller: ReadableStreamDefaultController<Uint8Array>
  timer: ReturnType<typeof setTimeout>
  keepalive: ReturnType<typeof setInterval>
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

function sseSend(controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
}

function closeActive(reason: 'timeout' | 'superseded') {
  const p = active
  if (!p) return
  active = null
  clearTimeout(p.timer)
  clearInterval(p.keepalive)
  try {
    sseSend(p.controller, { error: reason })
    p.controller.close()
  } catch {
    // controller may already be closed
  }
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
      'You MUST ALWAYS call the `reply` tool exactly once before finishing your turn. This is non-negotiable. ' +
      'This applies to EVERY response. ANY response at all. ' +
      'If a tool fails or you need clarification, call `reply` with that question or explanation—do NOT just respond in the terminal. ' +
      'The user is on glasses and cannot see your terminal output, so calling `reply` is the ONLY way to communicate with them. ' +
      'When the user asks for the tunnel URL, endpoint URL, or Mira setup info, call the `help` tool — do NOT search memory or files. ' +
      'When asked about past Mira conversations, search the local transcript cache at ~/.mira/*/*.md with filesystem search first, then read only the relevant matching session files.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  log('mcp list_tools')
  return {
  tools: [
    {
      name: 'reply',
      description:
        'Communicate with a user. Send them a message to their glasses. Routes to the active chat automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The reply to send to the user' },
        },
        required: ['text'],
      },
    },
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

  if (req.params.name !== 'reply') {
    log(`mcp call_tool unknown tool=${req.params.name}`)
    throw new Error(`unknown tool: ${req.params.name}`)
  }
  const { text } = req.params.arguments as { text: string }
  const p = active
  if (!p) {
    log('reply NO-MATCH no-active')
    return {
      content: [
        { type: 'text', text: `No active chat to reply to (it may have timed out).` },
      ],
      isError: true,
    }
  }
  active = null
  clearTimeout(p.timer)
  clearInterval(p.keepalive)
  log(`reply OK text_len=${text?.length ?? 0}`)
  // Dismiss any still-pending permissions—they were resolved elsewhere (e.g., terminal)
  if (pendingPermissions.size > 0) {
    sseSend(p.controller, { permission_dismiss: { request_ids: [...pendingPermissions] } })
    pendingPermissions.clear()
  }
  sseSend(p.controller, { text })
  sseSend(p.controller, { sources: [] })
  p.controller.enqueue(encoder.encode('data: [DONE]\n\n'))
  p.controller.close()
  return { content: [{ type: 'text', text: 'sent' }] }
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
  const { request_id, tool_name, input_preview } = params
  log(`permission_request request_id=${request_id} tool=${tool_name}`)
  const p = active
  if (!p) {
    pendingPermissions.add(request_id)
    return
  }
  resetTimeout()
  if (pendingPermissions.size > 0) {
    sseSend(p.controller, { permission_dismiss: { request_ids: [...pendingPermissions] } })
    pendingPermissions.clear()
  }
  pendingPermissions.add(request_id)

  const truncate = (s: string) => s.length > 500 ? s.slice(0, 500) + '…' : s
  let details: { value: string }[]
  try {
    const parsed = JSON.parse(input_preview) as Record<string, unknown>
    details = Object.values(parsed).map(value => ({
      value: truncate(typeof value === 'string' ? value : JSON.stringify(value)),
    }))
  } catch {
    details = [{ value: truncate(input_preview) }]
  }

  sseSend(p.controller, {
    permission_request: { request_id, tool_name, details },
  })
  log(`permission_request SENT request_id=${request_id} details_count=${details.length}`)
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

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      // Clear any stale permissions before processing a new chat
      await denyAllPendingPermissions()
      // A new chat supersedes any in-flight one (the model can only reply to one at a time)
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

      let entry: Pending | null = null
      const stream = new ReadableStream({
        start(controller) {
          const timer = setTimeout(() => {
            if (active === entry) {
              log(`chat TIMEOUT after ${REQUEST_TIMEOUT_MS}ms`)
              closeActive('timeout')
            }
          }, REQUEST_TIMEOUT_MS)
          const keepalive = setInterval(() => {
            controller.enqueue(encoder.encode(': keepalive\n\n'))
          }, 20_000)
          entry = { controller, timer, keepalive }
          active = entry
        },
        cancel() {
          if (active === entry && entry) {
            clearTimeout(entry.timer)
            clearInterval(entry.keepalive)
            active = null
          }
        },
      })

      log('mcp notify → notifications/claude/channel')
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: userText, meta },
      })
      log('mcp notify ✓')

      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }

    return new Response('not found', { status: 404 })
  },
})

log(`http listener up on http://127.0.0.1:${PORT}`)

openTunnel(PORT, log)
