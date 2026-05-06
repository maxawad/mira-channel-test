const CLOUDFLARED_DIR = `${process.env.HOME}/.mira-mcp`
const CLOUDFLARED_PATH = `${CLOUDFLARED_DIR}/cloudflared`

let tunnelUrl: string | null = null
let tunnelError: string | null = null

export const getTunnelUrl = () => tunnelUrl
export const getTunnelError = () => tunnelError

async function ensureCloudflared(log: (msg: string) => void): Promise<string> {
  if (await Bun.file(CLOUDFLARED_PATH).exists()) return CLOUDFLARED_PATH
  log('downloading cloudflared (first run)...')
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const os = process.platform === 'darwin' ? 'darwin' : 'linux'
  const ext = os === 'darwin' ? '.tgz' : ''
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${os}-${arch}${ext}`
  await Bun.spawn(['mkdir', '-p', CLOUDFLARED_DIR]).exited
  if (os === 'darwin') {
    await Bun.spawn(['sh', '-c', `curl -sL ${url} | tar xz -C ${CLOUDFLARED_DIR}`]).exited
  } else {
    await Bun.spawn(['sh', '-c', `curl -sL ${url} -o ${CLOUDFLARED_PATH} && chmod +x ${CLOUDFLARED_PATH}`]).exited
  }
  log('cloudflared downloaded')
  return CLOUDFLARED_PATH
}

export async function openTunnel(port: number, log: (msg: string) => void): Promise<void> {
  const binary = await ensureCloudflared(log)
  log('tunnel opening (cloudflared quick tunnel)')
  const proc = Bun.spawn([binary, 'tunnel', '--url', `http://127.0.0.1:${port}`], {
    stderr: 'pipe',
    stdout: 'pipe',
    onExit(_, code) {
      log(`cloudflared exited code=${code}`)
      tunnelUrl = null
      tunnelError = 'Tunnel closed. Restart the plugin to reconnect.'
    },
  })

  ;(async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk)
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (match && !tunnelUrl) {
        tunnelUrl = match[0]
        tunnelError = null
        log(`tunnel up url=${tunnelUrl}`)
      }
    }
  })()
}
