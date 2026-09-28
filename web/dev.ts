// Dev server: rebuilds the dashboard when src/ changes and proxies /api to the
// local Go backend, so the browser sees one origin and the session cookie works.
//
//   WEB_PORT=5173 GO_ORIGIN=http://127.0.0.1:8080 bun dev

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");
const upstream = process.env.GO_ORIGIN ?? "http://127.0.0.1:8080";
const port = Number(process.env.WEB_PORT ?? 5173);

async function stale(): Promise<boolean> {
  let built: number;
  try {
    built = (await stat(join(dist, "index.html"))).mtimeMs;
  } catch {
    return true;
  }
  const files = await readdir(src, { recursive: true });
  for (const f of files) {
    const p = join(src, String(f));
    if ((await stat(p)).mtimeMs > built) return true;
  }
  return false;
}

async function build(): Promise<void> {
  const r = await Bun.build({ entrypoints: [join(src, "index.html")], outdir: dist, target: "browser" });
  if (!r.success) {
    for (const log of r.logs) console.error(log);
    throw new Error("build failed");
  }
  console.log("rebuilt dist/");
}

async function serveFile(path: string, fallback: boolean): Promise<Response> {
  const file = Bun.file(join(dist, path));
  if (await file.exists()) {
    return new Response(file, { headers: { "cache-control": "no-store" } });
  }
  if (!fallback) return new Response("not found", { status: 404 });
  const index = Bun.file(join(dist, "index.html"));
  return new Response(index, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz" || url.pathname.startsWith("/api/")) {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
      return fetch(upstream + url.pathname + url.search, { method: req.method, headers: req.headers, body });
    }

    if (await stale()) await build();
    const rel = url.pathname === "/" || url.pathname === "" ? "index.html" : url.pathname.slice(1);
    return serveFile(rel, !rel.includes("."));
  },
});

console.log(`dashboard → http://localhost:${port}  (proxying ${upstream})`);
