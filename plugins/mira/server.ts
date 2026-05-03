#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import localtunnel from 'localtunnel'
import { createHash } from 'crypto'
import { hostname } from 'os'
import { appendFileSync } from 'fs'

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

log(`boot pid=${process.pid} port=${PORT} log=${LOG_FILE}`)

// Derive a stable subdomain from the machine hostname so the URL is consistent
// across restarts (best-effort — localtunnel falls back to random if taken).
const SUBDOMAIN = 'al-' + createHash('md5').update(hostname()).digest('hex').slice(0, 8)

let tunnelUrl: string | null = null

type Pending = {
  resolve: (value: { text: string }) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()
let nextId = 1

const mcp = new Server(
  { name: 'mira', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions:
      'Messages from the Mira iOS app arrive as <channel source="mira" chat_id="..."> tags. ' +
      'The body of the tag is the user\'s spoken/typed message. ' +
      'To respond to the user, call the `reply` tool with the chat_id from the tag and the text you want to send back. ' +
      'The user is on a mobile device and cannot see your terminal output, so you MUST call `reply` to communicate with them. ' +
      'Keep replies concise and conversational unless they ask for detail. ' +
      'When the user asks for the tunnel URL, endpoint URL, or Mira setup info, call the `help` tool — do NOT search memory or files.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  log('mcp list_tools')
  return {
  tools: [
    {
      name: 'reply',
      description:
        'Send a reply back to the Mira iOS app. Use the chat_id from the inbound <channel> tag.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'The chat_id from the inbound channel tag' },
          text: { type: 'string', description: 'The reply to send to the user' },
        },
        required: ['chat_id', 'text'],
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
    const url = tunnelUrl ?? '(tunnel not ready yet — try again in a few seconds)'
    return {
      content: [
        {
          type: 'text',
          text:
            `Mira tunnel URL: ${url}\n\n` +
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
  const { chat_id, text } = req.params.arguments as { chat_id: string; text: string }
  const p = pending.get(chat_id)
  if (!p) {
    log(`reply NO-MATCH chat_id=${chat_id} pending=${[...pending.keys()].join(',')}`)
    return {
      content: [
        { type: 'text', text: `No pending request for chat_id=${chat_id} (it may have timed out).` },
      ],
      isError: true,
    }
  }
  clearTimeout(p.timer)
  pending.delete(chat_id)
  log(`reply OK chat_id=${chat_id} text_len=${text?.length ?? 0}`)
  p.resolve({ text })
  return { content: [{ type: 'text', text: 'sent' }] }
})

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
      return Response.json({ status: 'ok', pending: pending.size })
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
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

      const chatId = `c${nextId++}`
      const meta: Record<string, string> = { chat_id: chatId }
      if (typeof body?.user_local_time === 'string') meta.user_local_time = body.user_local_time
      if (typeof body?.user_timezone === 'string') meta.user_timezone = body.user_timezone

      log(`chat IN chat_id=${chatId} text=${JSON.stringify(userText.slice(0, 200))}`)

      const responsePromise = new Promise<{ text: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(chatId)
          log(`chat TIMEOUT chat_id=${chatId} after ${REQUEST_TIMEOUT_MS}ms`)
          reject(new Error('timeout'))
        }, REQUEST_TIMEOUT_MS)
        pending.set(chatId, { resolve, reject, timer })
      })

      try {
        log(`mcp notify → notifications/claude/channel chat_id=${chatId}`)
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: { content: userText, meta },
        })
        log(`mcp notify ✓ chat_id=${chatId}`)
      } catch (err) {
        pending.delete(chatId)
        log(`mcp notify FAILED chat_id=${chatId} err=${(err as Error).message}`)
        return Response.json(
          { error: { message: `failed to push to claude code: ${(err as Error).message}` } },
          { status: 500 },
        )
      }

      try {
        const reply = await responsePromise
        log(`chat OUT chat_id=${chatId} text_len=${reply.text.length}`)
        return Response.json({ text: reply.text, sources: [], debug: null })
      } catch (err) {
        log(`chat ERR chat_id=${chatId} err=${(err as Error).message}`)
        return Response.json(
          { error: { message: (err as Error).message } },
          { status: 504 },
        )
      }
    }

    return new Response('not found', { status: 404 })
  },
})

log(`http listener up on http://127.0.0.1:${PORT}`)

async function openTunnel() {
  try {
    log(`tunnel opening subdomain=${SUBDOMAIN}`)
    const tunnel = await localtunnel({ port: PORT, subdomain: SUBDOMAIN })
    tunnelUrl = tunnel.url
    const got = new URL(tunnel.url).hostname.split('.')[0]
    log(`tunnel up url=${tunnelUrl} requested=${SUBDOMAIN} got=${got} match=${got === SUBDOMAIN}`)

    tunnel.on('error', (err) => {
      log(`tunnel error: ${err.message} — reconnecting in 5s`)
      tunnelUrl = null
      setTimeout(openTunnel, 5_000)
    })

    tunnel.on('close', () => {
      log('tunnel closed — reconnecting in 5s')
      tunnelUrl = null
      setTimeout(openTunnel, 5_000)
    })
  } catch (err) {
    log(`tunnel open FAILED: ${(err as Error).message} — retrying in 10s`)
    setTimeout(openTunnel, 10_000)
  }
}

openTunnel()
