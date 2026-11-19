import { SocietyError } from "./society.ts";
import { DEFAULT_REQUESTER_TIMEOUT_SECONDS } from "./settlement.ts";

export interface ListingClockQuery {
  settlement_mode?: string | null;
  submission_deadline?: string | null;
  requester_timeout_seconds?: string | null;
}

// Observe only. These proposed clocks do not enter the wallet signing preimage,
// change posted terms, create liability, or change submission/award acceptance.
export function listingClockPreview(q: ListingClockQuery, expiry: number) {
  const mode = q.settlement_mode ?? "requester";
  if (!["requester", "automatic", "verifier"].includes(mode))
    throw new SocietyError(400, "settlement_mode must be requester, automatic or verifier");
  const deadline = q.submission_deadline == null ? null : Number(q.submission_deadline);
  if (deadline !== null && (!Number.isSafeInteger(deadline) || deadline <= 0))
    throw new SocietyError(400, "submission_deadline must be a positive unix timestamp in seconds");
  const timeout = q.requester_timeout_seconds == null
    ? DEFAULT_REQUESTER_TIMEOUT_SECONDS : Number(q.requester_timeout_seconds);
  if (!Number.isSafeInteger(timeout) || timeout < 3600 || timeout > 2592000)
    throw new SocietyError(400, "requester_timeout_seconds must be whole seconds from 3600 to 2592000");
  const gap = deadline === null ? null : expiry - deadline;
  const warnings: string[] = [];
  if (mode === "requester") {
    if (deadline === null) warnings.push("No separate submission_deadline is proposed. Work can arrive until listing expiry, when new awards also stop; requester_timeout_seconds does not extend expiry. Consider a separate submission deadline and a later expiry before committing immutable terms.");
    else if (gap! < timeout) warnings.push(`Only ${gap} seconds separate the proposed submission_deadline from listing expiry, less than requester_timeout_seconds (${timeout}). New awards stop at expiry; the requester clock does not extend it. Consider an earlier submission deadline or later expiry before committing immutable terms.`);
  }
  return {
    mode: "observe" as const,
    settlement_mode: mode,
    submission_deadline: deadline,
    listing_expiry: expiry,
    requester_timeout_seconds: mode === "requester" ? timeout : null,
    decision_room_seconds: gap,
    warnings,
    note: "Advisory comparison of proposed clocks only, not approval or complete posting validation. Warnings do not reject a listing or create an award, payment or liability. These preview fields are not added to the wallet signing preimage; submit the intended terms separately when posting. No warning is not a guarantee that a decision or award will occur.",
  };
}
