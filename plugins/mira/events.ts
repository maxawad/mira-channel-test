/**
 * Structured event shipper for the Mira Claude Code plugin.
 *
 * Events are buffered in-process and POSTed in batches to the Mira backend.
 * Flushes opportunistically on connect, on disconnect, and on shutdown.
 * Silent on failure — never crashes the plugin.
 */
const TELEMETRY_URL = 'https://glass-staging.thebighalo.com/telemetry/plugin-events'

export type EventLevel = 'info' | 'warn' | 'error'

export type EventConnection = {
  userId: string
  accessToken: string
}

export type EmittedEvent = {
  ts: string
  kind: string
  level: EventLevel
  plugin_pid?: number
  payload: Record<string, unknown>
}

type ShipperOptions = {
  log: (msg: string) => void
  maxQueueSize?: number
  maxBatchSize?: number
  fetchFn?: typeof fetch
}

export class PluginEventShipper {
  private buffer: EmittedEvent[] = []
  private connection: EventConnection | null = null
  private flushing = false
  private readonly maxQueueSize: number
  private readonly maxBatchSize: number
  private readonly log: ShipperOptions['log']
  private readonly fetchFn: typeof fetch

  constructor(opts: ShipperOptions) {
    this.log = opts.log
    this.maxQueueSize = opts.maxQueueSize ?? 1_000
    this.maxBatchSize = opts.maxBatchSize ?? 100
    this.fetchFn = opts.fetchFn ?? fetch
  }

  setConnection(conn: EventConnection | null): void {
    this.connection = conn
    if (conn) void this.flush()
  }

  emit(kind: string, payload: Record<string, unknown> = {}, level: EventLevel = 'info'): void {
    if (this.buffer.length >= this.maxQueueSize) {
      this.buffer.shift()
      this.log(`events: queue overflow, dropping oldest`)
    }
    this.buffer.push({ ts: new Date().toISOString(), kind, level, plugin_pid: process.pid, payload })
  }

  async flush(): Promise<void> {
    if (this.flushing || !this.connection || this.buffer.length === 0) return
    this.flushing = true
    try {
      while (this.buffer.length > 0 && this.connection) {
        const batch = this.buffer.splice(0, this.maxBatchSize)
        const conn = this.connection
        try {
          const resp = await this.fetchFn(TELEMETRY_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${conn.accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ events: batch }),
          })
          if (!resp.ok) {
            const body = await resp.text().catch(() => '')
            this.log(`events: ship failed status=${resp.status} body=${body.slice(0, 200)}`)
          }
        } catch (err) {
          this.buffer = batch.concat(this.buffer)
          this.log(`events: network error ${(err as Error).message}`)
          break
        }
      }
    } finally {
      this.flushing = false
    }
  }
}
