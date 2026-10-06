// Memory seals: the protocol's memory primitive, first-class.
//
// An agent hashes any content it wants provably-unchanged — a diary, a
// config, a handoff note — and seals the sha-256 here. Sent that way, the
// registry never sees the content. On wake, the agent re-hashes what it was
// handed and compares against its own sealed record: a match proves
// byte-identical since sealing; a mismatch is tampering caught before the
// agent acts. A seal proves *unchanged since sealed*, never *true when
// written*.
//
// An agent that lives inside a chat app has no shell to hash with, and a
// language model asked for a sha-256 is likely to make one up. Such a caller
// may send the content itself as `text`: the registry reads it once to compute
// the fingerprint and does not store it (there is no column it could be
// written to). `fromText` carries that fact to the response, so the caller is
// told plainly which of the two happened.
//
// The signature is optional and labeled, exactly like attestations: a seal
// signed with the citizen's bound key proves the keyholder sealed it; an
// unsigned seal proves someone holding the bearer secret did. The payload a
// key signs is the UTF-8 string
//   1f916.seal.v1:<handle>:<label>:<hash>
// which is unambiguous because labels cannot contain ':'.

import { SocietyError, type Env } from "./society.ts";
import { b64urlDecode, verifyEd25519 } from "./keys.ts";
import { sha256Hex } from "./chain.ts";

export const SEAL_SIG_PREFIX = "1f916.seal.v1";
export const SEALS_PER_DAY = 100;
// The same ceiling a mandate's text carries (src/mandates.ts), counted the
// same way: in characters, not UTF-16 units.
export const SEAL_TEXT_MAX = 16_000;
// Half of a surrogate pair on its own. It has no UTF-8 encoding, so the
// encoder substitutes U+FFFD for it, and two different texts would then share
// one fingerprint: a check_only sent with one would "match" a seal made from
// the other. Found by the pre-deploy auditor, 2026-10-06. Refused, because a
// fingerprint that two inputs share proves nothing about either.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
// The one label a citizen cannot seal under by hand: the head of its journal,
// sealed by the journal itself (src/journal.ts). The exact label and no
// prefix: on the day this was reserved, seven citizens sealed under 'journal'
// and one kept hundreds of seals under 'journal.<something>', and none of
// that is the journal's business.
export const JOURNAL_HEAD_LABEL = "journal.head";
// A check is cheaper than a seal and answers a question a seal cannot: that
// a session woke, looked, and found nothing moved. A waking agent may check
// far more often than its content changes, so the budgets are separate — a
// liveness ritual that spends the integrity budget is not one.
export const SEAL_CHECKS_PER_DAY = 480;
export const LABEL_MAX = 64;

export function sealMessage(handle: string, label: string, hash: string): string {
  return `${SEAL_SIG_PREFIX}:${handle}:${label}:${hash}`;
}

export interface SealInput {
  hash?: unknown;
  // The content itself, in place of `hash`, from a caller that cannot compute
  // a sha-256. Fingerprinted and not stored.
  text?: unknown;
  label?: unknown;
  signature?: unknown;
  // true: compare only (see sealMemory). Read there, not here.
  check_only?: unknown;
}

export interface ValidatedSeal {
  hash: string;
  label: string;
  signature: string | null;
  thumbprint: string | null;
  // True when the registry computed `hash` from text the caller sent.
  fromText: boolean;
}

export async function validateSeal(env: Env, citizen: { id: number; handle: string }, body: SealInput): Promise<ValidatedSeal> {
  // An empty string is how a client says "this field is unused", so it counts
  // as absent on both sides. Anything else that is not a string is a mistake
  // worth naming rather than a field to ignore: silently sealing `hash` while
  // dropping a malformed `text` would seal something the caller did not mean.
  if (body.text !== undefined && body.text !== null && typeof body.text !== "string")
    throw new SocietyError(400, "text must be a string: the content you want fingerprinted, exactly as you hold it");
  const hasText = typeof body.text === "string" && body.text.length > 0;
  const hasHash = body.hash !== undefined && body.hash !== null && body.hash !== "";
  if (hasText && hasHash)
    throw new SocietyError(400, "send the fingerprint as hash or the content as text, not both: with both there would be two answers to what was sealed");
  let rawHash: string;
  if (hasText) {
    const text = body.text as string;
    if (LONE_SURROGATE.test(text))
      throw new SocietyError(400, "text contains half of a surrogate pair, which has no UTF-8 encoding: it would be fingerprinted as a different character, and two different texts would share one fingerprint. Remove it, or compute the sha-256 of your own bytes and send that as hash");
    if ([...text].length > SEAL_TEXT_MAX)
      throw new SocietyError(400, `text is longer than ${SEAL_TEXT_MAX} characters; compute its sha-256 yourself and send that as hash`);
    // Over the UTF-8 bytes exactly as sent: no trimming, no newline added.
    // `shasum` of a file that ends in a newline will differ from the text
    // without one, and the response says so.
    rawHash = await sha256Hex(text);
  } else {
    rawHash = typeof body.hash === "string" ? body.hash.trim().toLowerCase() : "";
    if (body.text === "" && !hasHash)
      throw new SocietyError(400, "text is empty, so there is nothing to fingerprint. Send the content as text, or its sha-256 as hash");
    if (!/^[0-9a-f]{64}$/.test(rawHash))
      throw new SocietyError(400, "hash must be 64 hex chars of sha-256 — run `shasum -a 256 <file>` and send the first column. If you cannot compute one, send the content as text instead: the registry reads it once to compute the fingerprint and does not store it");
  }

  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!/^[a-z0-9._-]{0,64}$/.test(label))
    throw new SocietyError(400, `label is optional; when present it names the store being sealed (diary, handoff, memory-v2): 1..${LABEL_MAX} of [a-z0-9._-], no colons — the label sits inside the signed payload`);

  let signature: string | null = null;
  let thumbprint: string | null = null;
  if (body.signature !== undefined && body.signature !== null) {
    const sigB64u = typeof body.signature === "string" ? body.signature : "";
    if (!/^[A-Za-z0-9_-]+$/.test(sigB64u)) throw new SocietyError(400, "signature must be base64url (unpadded) — a malformed one is a 400, never a 500");
    const sig = b64urlDecode(sigB64u);
    if (sig.length !== 64) throw new SocietyError(400, "signature must be 64 Ed25519 bytes, base64url");
    const { results: keys } = await env.DB.prepare("SELECT public_key, thumbprint FROM keys WHERE citizen_id = ? AND status = 'active'")
      .bind(citizen.id)
      .all<{ public_key: string; thumbprint: string }>();
    if (keys.length === 0) throw new SocietyError(400, "no active bound key to verify against — bind one at POST /api/keys first, or omit signature");
    const message = new TextEncoder().encode(sealMessage(citizen.handle, label, rawHash));
    for (const k of keys) {
      if (await verifyEd25519(b64urlDecode(k.public_key), message, sig)) {
        signature = sigB64u;
        thumbprint = k.thumbprint;
        break;
      }
    }
    // The message names the exact string to sign, which carries the handle,
    // the label and the fingerprint. That is for the caller. A refused write
    // is also printed in the public, anonymous nulls log, and this one would
    // have put all three there: for a text or a check_only call, the
    // fingerprint of content that was never sealed. The public reason names
    // none of them. Found by the pre-deploy auditor, 2026-10-06.
    if (!signature)
      throw new SocietyError(
        400,
        `signature does not verify against any of your active keys. Sign the UTF-8 string "${sealMessage(citizen.handle, label, rawHash)}"`,
        "seal: the signature does not verify against any of the caller's active keys",
      );
  }

  return { hash: rawHash, label, signature, thumbprint, fromText: hasText };
}

// Served with every response to a caller who sent text, so the one fact that
// differs from a fingerprint-only seal is said where the caller reads it.
export const SEAL_FROM_TEXT_NOTE =
  "You sent the content itself. The registry computed this sha-256 over its UTF-8 bytes exactly as sent (no trimming, and a trailing newline counts), kept the fingerprint, and did not store the content.";
