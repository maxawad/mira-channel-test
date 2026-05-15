/**
 * Structured event shipper for the Mira Claude Code plugin.
 *
 * Events are buffered in-process and POSTed in batches to the Mira backend
 * (`/telemetry/plugin-events`) whenever a connection to the iOS app is active
 * — that's when we know which user these events belong to and have a JWT to
 * authenticate with. While disconnected, events queue up in a bounded buffer
 * and either flush on next connect or are dropped on overflow.
 *
 * Failure mode is intentionally silent: nothing about this pipeline should
 * crash or stall the plugin's primary job (relaying chat to Claude Code).
 * `/tmp/mira.log` remains the source-of-truth local log.
 */
export type EventLevel = 'info' | 'warn' | 'error'

export type EventConnection = {
  userId: string
  accessToken: string
  backendBaseUrl: string
}

export type EmittedEvent = {
  ts: string
  kind: string
  level: EventLevel
  device_id?: string
  plugin_pid?: number
  payload: Record<string, unknown>
}

type ShipperOptions = {
  /** Console/file logger, so we can mirror failures into /tmp/mira.log. */
  log: (msg: string, extra?: unknown) => void
  /** Maximum events to keep in the in-memory queue while disconnected. */
  maxQueueSize?: number
  /** How often to flush when there's data + an active connection. */
  flushIntervalMs?: number
  /** Maximum events per outbound batch. */
  maxBatchSize?: number
  /** Optional override for fetch (tests). */
  fetchFn?: typeof fetch
}

export class PluginEventShipper {
  private buffer: EmittedEvent[] = []
  private connection: EventConnection | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private flushing = false
  private readonly maxQueueSize: number
  private readonly flushIntervalMs: number
  private readonly maxBatchSize: number
  private readonly log: ShipperOptions['log']
  private readonly fetchFn: typeof fetch
  private readonly pid: number
  private deviceId: string | undefined

  constructor(opts: ShipperOptions) {
    this.log = opts.log
    this.maxQueueSize = opts.maxQueueSize ?? 1_000
    this.flushIntervalMs = opts.flushIntervalMs ?? 2_000
    this.maxBatchSize = opts.maxBatchSize ?? 100
    this.fetchFn = opts.fetchFn ?? fetch
    this.pid = process.pid
  }

  /** Start the periodic flush loop. Safe to call once at boot. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.flush()
    }, this.flushIntervalMs)
    // Don't keep the event loop alive just for the flush timer.
    // Bun/Node return a Timer with .unref(); web's setInterval returns a number.
    const t = this.timer as unknown as { unref?: () => void }
    if (typeof t.unref === 'function') t.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Identify the local device so events can be correlated across reinstalls. */
  setDeviceId(deviceId: string | undefined): void {
    this.deviceId = deviceId
  }

  /** Update the authenticated connection. Call with `null` on /disconnect. */
  setConnection(conn: EventConnection | null): void {
    this.connection = conn
    if (conn) {
      // Connect just happened; opportunistically flush any queued events.
      void this.flush()
    }
  }

  /** Enqueue a structured event. Never throws. */
  emit(kind: string, payload: Record<string, unknown> = {}, level: EventLevel = 'info'): void {
    const event: EmittedEvent = {
      ts: new Date().toISOString(),
      kind,
      level,
      device_id: this.deviceId,
      plugin_pid: this.pid,
      payload,
    }
    if (this.buffer.length >= this.maxQueueSize) {
      // Drop the oldest event to bound memory; mirror to file log so the loss is visible.
      this.buffer.shift()
      this.log(`events: queue overflow, dropping oldest (queue=${this.maxQueueSize})`)
    }
    this.buffer.push(event)
  }

  /** Force a flush, e.g. on shutdown. */
  async flush(): Promise<void> {
    if (this.flushing) return
    if (!this.connection) return
    if (this.buffer.length === 0) return

    this.flushing = true
    try {
      while (this.buffer.length > 0 && this.connection) {
        const batch = this.buffer.splice(0, this.maxBatchSize)
        const conn = this.connection
        const url = `${conn.backendBaseUrl}/telemetry/plugin-events`
        try {
          const resp = await this.fetchFn(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${conn.accessToken}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ events: batch }),
          })
          if (!resp.ok) {
            const body = await resp.text().catch(() => '')
            this.log(
              `events: ship failed status=${resp.status} dropped=${batch.length} body=${body.slice(0, 200)}`,
            )
            // Don't requeue — if the backend is rejecting our shape we'd just spin.
          }
        } catch (err) {
          // Network error: requeue *this batch only* at the head, stop flushing
          // until the next interval; preserves order and avoids spamming.
          this.buffer = batch.concat(this.buffer)
          this.log(`events: ship network error msg=${(err as Error).message} retry_next_tick=true`)
          break
        }
      }
    } finally {
      this.flushing = false
    }
  }
}
