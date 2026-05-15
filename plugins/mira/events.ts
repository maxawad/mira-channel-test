const TELEMETRY_URL = process.env.MIRA_TELEMETRY_URL ?? 'http://localhost:8000/telemetry/plugin-events'

export type EventLevel = 'info' | 'warn' | 'error'

export class PluginEventShipper {
  private deviceId: string | undefined
  private accessToken: string | undefined

  setDeviceId(id: string) { this.deviceId = id }
  setAccessToken(t: string | undefined) { this.accessToken = t }

  emit(kind: string, payload: Record<string, unknown> = {}, level: EventLevel = 'info'): void {
    const event = {
      ts: new Date().toISOString(),
      kind,
      level,
      device_id: this.deviceId,
      plugin_pid: process.pid,
      payload,
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`
    fetch(TELEMETRY_URL, { method: 'POST', headers, body: JSON.stringify({ events: [event] }) })
      .catch(() => { /* best-effort */ })
  }
}
