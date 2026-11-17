/**
 * builtlore serve: the canvas with editing turned on.
 *
 * Scans the project, serves the canvas on localhost, and writes every edit to
 * builtlore.edits.yaml (then refreshes builtlore.json and .builtlore/map.html,
 * so the files on disk always match what you see).
 *
 * Local only: binds to 127.0.0.1, and every write needs a per-session token
 * sent in a custom header, so other websites open in the browser cannot write.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { renderDocs } from "../docs/index.js";
import { renderHtml } from "../render/html.js";
import { applyEdits, loadEdits, saveEdit, type EditPatch } from "./edits.js";
import { scanProject, writeHtml, writeJson, type Config } from "./scan.js";
import type { BuiltMap } from "./types.js";

export interface ServeHandle {
  url: string;
  server: Server;
  root: string;
}

export async function serveProject(path: string, opts: Partial<Config> & { port?: number } = {}): Promise<ServeHandle> {
  const { port, ...config } = opts;
  const scanned = await scanProject(path, config);
  const root = scanned.root;
  const raw: BuiltMap = scanned.raw;
  let map: BuiltMap = scanned.map;
  const token = randomBytes(16).toString("hex");

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(renderHtml(map, { edit: { token } }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/docs") {
        // The documentation as `builtlore docs` would write it now, with the latest edits.
        const docs = await renderDocs(map);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(docs.html);
        return;
      }
      if (req.method === "GET" && url.pathname === "/builtlore.json") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(map));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/edit") {
        if (req.headers["x-builtlore-token"] !== token) {
          res.writeHead(403).end("Forbidden");
          return;
        }
        const patch = validatePatch(JSON.parse(await body(req)));
        saveEdit(root, patch, raw);
        map = applyEdits(raw, loadEdits(root));
        writeJson(root, map);
        writeHtml(root, map);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404).end("Not found");
    } catch (err) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end((err as Error).message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port ?? 4321, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return { url: `http://127.0.0.1:${actualPort}/`, server, root };
}

function validatePatch(p: unknown): EditPatch {
  const o = p as { target?: unknown; id?: unknown; fields?: unknown };
  if (!o || typeof o.id !== "string" || !o.id || !o.fields || typeof o.fields !== "object") throw new Error("Invalid edit");
  if (!["project", "step", "feature", "glossary", "role", "status"].includes(o.target as string)) throw new Error("Invalid edit target");
  for (const v of Object.values(o.fields as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 20000) throw new Error("Text too long");
  }
  return o as EditPatch;
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("Request too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
