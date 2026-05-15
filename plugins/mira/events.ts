const TELEMETRY_URL = process.env.MIRA_TELEMETRY_URL ?? 'https://glass-staging.thebighalo.com/telemetry/plugin-events'

export type EventLevel = 'info' | 'warn' | 'error'
export type EventConnection = { userId: string; accessToken: string }
export type EmittedEvent = { ts: string; kind: string; level: EventLevel; plugin_pid?: number; payload: Record<string, unknown> }

export class PluginEventShipper {
  private buffer: EmittedEvent[] = []
  private connection: EventConnection | null = null

  setConnection(conn: EventConnection | null): void {
    this.connection = conn
    if (conn) void this.flush()
  }

  emit(kind: string, payload: Record<string, unknown> = {}, level: EventLevel = 'info'): void {
    this.buffer.push({ ts: new Date().toISOString(), kind, level, plugin_pid: process.pid, payload })
  }

  async flush(): Promise<void> {
    if (!this.connection || this.buffer.length === 0) return
    const batch = this.buffer.splice(0)
    const conn = this.connection
    try {
      await fetch(TELEMETRY_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${conn.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: batch }),
      })
    } catch { /* best-effort */ }
  }
}
