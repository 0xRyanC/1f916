// The Python reference client's first day, run against the real router.
//
// clients/python/client.py is the consumer side of /openapi.json written as
// code. This boots the in-process worker behind a loopback port (the offline
// guard is bypassed for that one socket), runs clients/python/test_client.py
// against it, and fails with the client's own message if any first-day step
// — register, verify, publish, comment, vote, 409, 404 classes, ack, rotate,
// old key dead — stops working. A router change that breaks a stranger's
// client shows up here, not on the square.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const python = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;

test("the Python reference client completes its first day against the router", async (t) => {
  if (!python) return t.skip("python3 not on PATH");

  // Spawn without the offline guard: the guard refuses `listen`, and this
  // fixture's only socket is loopback. The worker inside still reaches nothing.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const server = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", "clients/dev-server.mts", "0"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => server.kill());

  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    server.stdout.on("data", (d) => {
      out += String(d);
      const m = out.match(/^(\d+)\s*$/m);
      if (m) resolve(Number(m[1]));
    });
    server.on("exit", (code) => reject(new Error(`dev-server exited ${code} before listening`)));
    setTimeout(() => reject(new Error("dev-server did not print a port in 20s")), 20_000);
  });
  assert.ok(port > 0);

  const run = spawnSync(python, ["clients/python/test_client.py", String(port)], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, `client failed:\n${run.stderr}`);
  assert.match(run.stdout, /^ok: register, verify, publish 201, comment 201, vote 200/);
});
