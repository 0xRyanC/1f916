import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { listingClockPreview } from "../src/listing-clock-preview.ts";
import { listingPreimageFor } from "../src/society.ts";
import { validateSettlement } from "../src/settlement.ts";
import { validate } from "./helpers/json-schema.ts";
import { QUERY_PARAMS } from "../src/query-params.ts";

const expiry = Math.floor(Date.now() / 1000) + 14 * 86400;
const timeout = 604800;

test("null or omitted submission deadline warns, using the actual default requester clock", () => {
  for (const q of [{}, { submission_deadline: null }]) {
    const p = listingClockPreview(q, expiry);
    assert.equal(p.mode, "observe");
    assert.equal(p.requester_timeout_seconds, timeout);
    assert.equal(p.decision_room_seconds, null);
    assert.match(p.warnings.join(" "), /No separate submission_deadline/);
  }
});

test("one second short and zero room warn; exact room and larger do not", () => {
  for (const gap of [0, timeout - 1, timeout, timeout + 1]) {
    const p = listingClockPreview({ submission_deadline: String(expiry - gap) }, expiry);
    assert.equal(p.decision_room_seconds, gap);
    assert.equal(p.warnings.length, gap < timeout ? 1 : 0);
  }
  const p = listingClockPreview({ submission_deadline: String(expiry - 3600), requester_timeout_seconds: "3600" }, expiry);
  assert.deepEqual(p.warnings, []);
});

test("other modes do not inherit requester warnings; malformed inputs are not reassuring previews", () => {
  for (const settlement_mode of ["automatic", "verifier"]) {
    const p = listingClockPreview({ settlement_mode }, expiry);
    assert.deepEqual(p.warnings, []);
    assert.equal(p.requester_timeout_seconds, null);
  }
  for (const q of [{ settlement_mode: "typo" }, { submission_deadline: "NaN" }, { submission_deadline: "1.5" }, { requester_timeout_seconds: "" }, { requester_timeout_seconds: "3599" }])
    assert.throws(() => listingClockPreview(q, expiry));
});

test("warning leaves short-window posting validation and proposed inputs unchanged", () => {
  const q = Object.freeze({ submission_deadline: String(expiry - 1), requester_timeout_seconds: String(timeout) });
  assert.equal(listingClockPreview(q, expiry).warnings.length, 1);
  const validated = validateSettlement({ max_awards: 1, settlement_mode: "requester", submission_deadline: Number(q.submission_deadline), requester_timeout_seconds: timeout }, expiry);
  assert.equal(validated.submissionDeadline, expiry - 1);
  assert.equal(validated.requesterTimeoutSeconds, timeout);
});

test("preimage serves warning without changing signable bytes or amount; response schema accepts it", async () => {
  const q = { handle: "clock-audit", title: "Clock preview", amount_atomic: "1000000", verifier_price_atomic: null, max_verifiers: null, expiry: String(expiry) };
  const before = await listingPreimageFor(q);
  const after = await listingPreimageFor({ ...q, submission_deadline: String(expiry - 3600) });
  assert.equal(after.preimage, before.preimage);
  assert.equal(after.total_needed_atomic, before.total_needed_atomic);
  assert.equal(after.clock_preview.warnings.length, 1);
  const schema = JSON.parse(readFileSync(new URL("../schemas/listings-preimage.json", import.meta.url), "utf8"));
  assert.deepEqual(validate(schema, { now: Date.now(), now_utc: new Date().toISOString(), ...after }), []);
  assert.notDeepEqual(validate(schema, { now: Date.now(), now_utc: new Date().toISOString(), ...after, clock_preview: { ...after.clock_preview, mode: "enforce" } }), []);
});

test("public query contract accepts and routes every preview input", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const route = source.slice(source.indexOf('if (path === "/api/listings/preimage"'), source.indexOf('const withdrawMatch'));
  for (const name of ["settlement_mode", "submission_deadline", "requester_timeout_seconds"]) {
    assert.ok(QUERY_PARAMS["/api/listings/preimage"].includes(name));
    assert.ok(route.includes(`${name}: url.searchParams.get("${name}")`));
  }
});
