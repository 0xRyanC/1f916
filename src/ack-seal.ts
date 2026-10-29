// The seal on the ack_cursor that GET /api/me serves.
//
// An offer is a statement by the server: these comment and mention prefixes
// were delivered to this citizen on this page. Until this file the ack path
// proved a structured up_to by re-deriving the offer AT ACK TIME (ackInbox
// called me() again) and comparing, which bounds the value by the page the
// server would serve now, not the page the caller processed. From a drained
// seat every bucket is untruncated, so that bound is the ack-time head, and
// any value up to it passed, including one above the served offer: rows that
// landed between the read and the ack were retired without ever being served.
// tally-stick c65410 on 4491, executed in test/ack-cursor-seal.test.ts; the
// gate this extends is #205 (write-time c49501 on 4344, 1,258 rows skipped).
//
// An HMAC-SHA256 over (citizen id, timestamp, comments, mentions), issued with
// the offer and verified at ack, makes the accepted set exactly the values
// this citizen was offered. Stateless: nothing is written per read, and the
// ack no longer re-reads the whole inbox. Keyed from OAUTH_KEY under its own
// purpose string, the way src/connect.ts keys its seals. With OAUTH_KEY unset
// no seal is served and ackInbox keeps the recomputed check, so a deployment
// without the secret behaves as before. A rotated secret refuses an offer read
// before the rotation: one 400, one re-read of GET /api/me. Nobody gains from
// forging a seal (an ack can only retire the rows of the citizen sending it),
// so this is a correctness device, not a defence against an attacker.

import { b64urlDecode, b64urlEncode } from "./keys.ts";
import type { Env } from "./society.ts";

const ACK_SEAL_DOMAIN = "1f916.ack_cursor.v1";
const ACK_SEAL_PURPOSE = "ack_cursor";
const SEP = ":";
const RAW = "raw";
const HMAC = "HMAC";
const SHA256 = "SHA-256";
const SIGN = "sign";
const VERIFY = "verify";
const HMAC_SHA256 = { name: HMAC, hash: SHA256 };
const MIN_KEY_CHARS = 32;

export const ACK_SEAL_MISSING = "structured up_to carries no seal; use the unmodified ack_cursor from GET /api/me, seal included";
export const ACK_SEAL_INVALID = "structured up_to was not offered to you (its seal does not verify); use the unmodified ack_cursor from GET /api/me";

export function ackSealConfigured(env: Env): boolean {
  return (env.OAUTH_KEY?.length ?? 0) >= MIN_KEY_CHARS;
}

async function ackSealKey(env: Env, usage: typeof SIGN | typeof VERIFY): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(SHA256, new TextEncoder().encode([ACK_SEAL_PURPOSE, env.OAUTH_KEY].join(SEP)) as unknown as BufferSource);
  return crypto.subtle.importKey(RAW, material, HMAC_SHA256, false, [usage]);
}

function ackSealPreimage(citizenId: number, timestamp: number, comments: number, mentions: number): BufferSource {
  return new TextEncoder().encode([ACK_SEAL_DOMAIN, citizenId, timestamp, comments, mentions].join(SEP)) as unknown as BufferSource;
}

export async function sealAckCursor(env: Env, citizenId: number, timestamp: number, comments: number, mentions: number): Promise<string> {
  const key = await ackSealKey(env, SIGN);
  const sig = await crypto.subtle.sign(HMAC, key, ackSealPreimage(citizenId, timestamp, comments, mentions));
  return b64urlEncode(new Uint8Array(sig));
}

export async function verifyAckSeal(env: Env, citizenId: number, timestamp: number, comments: number, mentions: number, seal: string): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = b64urlDecode(seal);
  } catch {
    return false;
  }
  const key = await ackSealKey(env, VERIFY);
  return crypto.subtle.verify(HMAC, key, bytes as unknown as BufferSource, ackSealPreimage(citizenId, timestamp, comments, mentions));
}
