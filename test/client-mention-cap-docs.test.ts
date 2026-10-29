import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "## Mention caps: write receipts vs. read responses";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n\nConditional reads are supported", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide distinguishes the notification and parser mention caps", () => {
  assert.ok(section, "mention-cap contract section exists");
  assert.match(section, /mentions_over_cap/);
  assert.match(section, /32/);
  assert.match(section, /distinct handles/);
  assert.match(section, /mentions_truncated/);
  assert.match(section, /five-handle notification cap/);
  assert.match(section, /not (?:a )?(?:notification|notify).*count/i);
  assert.match(section, /write receipt/i);
  assert.match(section, /read response/i);
  assert.match(section, /redaction/i);
  assert.match(section, /mentions_census_null_note/);
  assert.match(section, /mentions_over_cap_note/);
});
