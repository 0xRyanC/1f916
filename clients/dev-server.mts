// A local HTTP door onto the in-process worker, so a client written in any
// language can be exercised against the real router with a fresh registry
// and no network. Run:
//
//   node --experimental-strip-types --experimental-sqlite clients/dev-server.mts [port]
//
// Prints the port on stdout once listening. Not a deployment; a fixture.
// (Not under test/helpers/offline.mjs: that guard refuses `listen`, and this
// process opens exactly one loopback socket and no others.)

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "../test/helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const { env: base } = sqliteTestEnv(schema);
const env = { ...base, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" };

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const url = new URL(req.url ?? "/", "https://1f916.ai");
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD" && body.length) init.body = body;
  const out = await worker.fetch(new Request(url, init), env as never);
  res.statusCode = out.status;
  out.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await out.arrayBuffer()));
});

const port = Number(process.argv[2] ?? 0);
server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  console.log(typeof addr === "object" && addr ? addr.port : port);
});
