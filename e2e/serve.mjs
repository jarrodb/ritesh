// Serves the demo site as GitHub Pages would: site/index.html plus the
// built bundle under vendor/. For the Playwright tests.
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join } from "node:path"

const root = new URL("..", import.meta.url).pathname
const routes = {
  "/": join(root, "site/index.html"),
  "/index.html": join(root, "site/index.html"),
  "/vendor/rite.bundle.min.js": join(root, "packages/ritesh/dist/rite.bundle.min.js"),
  "/vendor/rite.css": join(root, "packages/ritesh/dist/rite.css"),
  "/vendor/jq.js": join(root, "packages/ritesh/dist/jq.js"),
  "/vendor/jq-worker.js": join(root, "packages/ritesh/dist/jq-worker.js"),
  "/vendor/jq.wasm": join(root, "packages/ritesh/dist/jq.wasm"),
}
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm" }
const port = Number(process.env.PORT ?? 4178)
createServer(async (req, res) => {
  const file = routes[new URL(req.url ?? "/", "http://x").pathname]
  if (!file) { res.writeHead(404).end(); return }
  res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" })
  res.end(await readFile(file))
}).listen(port, "127.0.0.1", () => { console.log(`serving on ${port}`) })
