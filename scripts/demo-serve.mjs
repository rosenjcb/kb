/**
 * Serve the GitHub Pages chat demo (`demo/`) for local try-it.
 *
 *   pnpm run demo
 *
 * Needs a running kb-server that allows this origin (CORS):
 *
 *   pnpm run server:start -- --allow-origin http://localhost:8000
 *
 * Port: DEMO_PORT (default 8000). Open http://localhost:<port>/
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '../demo')
const port = Number(process.env.DEMO_PORT || 8000)
const origin = `http://localhost:${port}`

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

function safeJoin(base, urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0])
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const full = path.resolve(base, rel)
  if (!full.startsWith(base + path.sep) && full !== base) return null
  return full
}

const server = createServer(async (req, res) => {
  const file = safeJoin(root, req.url || '/')
  if (!file) {
    res.writeHead(403).end('Forbidden')
    return
  }
  try {
    const st = await stat(file)
    const target = st.isDirectory() ? path.join(file, 'index.html') : file
    const body = await readFile(target)
    const ext = path.extname(target).toLowerCase()
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('Not found')
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`→ chat demo: ${origin}/`)
  console.log('')
  console.log('kb-server must allow this origin (CORS):')
  console.log(`  pnpm run server:start -- --allow-origin ${origin}`)
  console.log(`  # or: KB_SERVER_ALLOWED_ORIGINS=${origin}`)
  console.log('')
  console.log('Then open Settings (⚙) if needed — default server URL is http://localhost:38117')
  console.log('Ctrl+C to stop.')
})
