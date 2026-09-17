// Per-client request limit, applied before any route runs and so before any
// database read (2026-09-17, owner's decision).
//
// Measured over the hour before it shipped: 580 distinct clients; the median
// client's busiest minute was 1 request; 6 of 580 exceeded roughly 100 requests
// in 100 seconds, the busiest a single bot at ~3 per second sustained. The owner
// asked whether a normal agent would ever exceed 100 per 100 seconds; none did.
// Cloudflare's rate-limit binding supports only 10- or 60-second windows, so the
// limit is the same average expressed as 60 per 60 seconds.
//
// KEYING. Cloudflare's documentation warns that an IP address can be shared by
// many valid users, and hosted agents do share them. So an authenticated request
// counts against its API token (hashed; the token itself is never used as a key),
// and only an anonymous request counts against its IP. A looser per-IP backstop
// also applies to authenticated requests, so rotating made-up tokens cannot
// multiply the allowance.
//
// WHAT IT IS NOT. The binding's counters are per Cloudflare location and
// "permissive, eventually consistent" by design: it is a backstop against
// runaway clients, not an exact quota, and nothing here should be read as one.
//
// EXEMPT: the maintainer, recognised by the SHA-256 of its token
// (MAINTAINER_SECRET_SHA256, a Worker secret) or by its egress addresses
// (RATE_LIMIT_EXEMPT_IPS, comma-separated, a Worker secret). CF-Connecting-IP is
// set by Cloudflare, not by the client, so the address exemption cannot be
// spoofed. The maintenance patrol and this Mac share one home address and read
// in bursts of up to 91 requests a minute, which is why the address matters.
//
// With no binding configured (tests, local dev) this does nothing.

export const RATE_LIMIT = {
  requests: 60,
  period_seconds: 60,
  backstop_requests_per_ip: 600,
} as const;

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RateLimitEnv {
  RATE_LIMITER?: RateLimiter;
  RATE_LIMITER_IP_BACKSTOP?: RateLimiter;
  MAINTAINER_SECRET_SHA256?: string;
  RATE_LIMIT_EXEMPT_IPS?: string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The refusal to serve when a request is over its limit, or null. Returned as a
// body plus headers rather than a Response so the router sends it through the
// same json() every other answer uses: the CORS header a browser client needs to
// READ a 429 at all, Cache-Control: no-store, and the in-band clock. A
// hand-built Response here was an opaque CORS failure to every browser client
// on /api/* (pre-deploy auditor, 2026-09-17).
export interface RateLimitRefusal {
  status: 429;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export async function rateLimited(request: Request, env: RateLimitEnv): Promise<RateLimitRefusal | null> {
  if (!env.RATE_LIMITER) return null;
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const exemptIps = (env.RATE_LIMIT_EXEMPT_IPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (exemptIps.includes(ip)) return null;

  const auth = request.headers.get("Authorization");
  const token = auth && auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  let key: string;
  let keyedBy: "token" | "ip";
  if (token) {
    const hash = await sha256Hex(token);
    if (env.MAINTAINER_SECRET_SHA256 && hash === env.MAINTAINER_SECRET_SHA256.trim().toLowerCase()) return null;
    key = `t:${hash.slice(0, 32)}`;
    keyedBy = "token";
    if (env.RATE_LIMITER_IP_BACKSTOP) {
      const backstop = await env.RATE_LIMITER_IP_BACKSTOP.limit({ key: `ip:${ip}` });
      if (!backstop.success) return tooMany("ip", RATE_LIMIT.backstop_requests_per_ip);
    }
  } else {
    key = `ip:${ip}`;
    keyedBy = "ip";
  }
  const { success } = await env.RATE_LIMITER.limit({ key });
  return success ? null : tooMany(keyedBy, RATE_LIMIT.requests);
}

function tooMany(keyedBy: "token" | "ip", limit: number): RateLimitRefusal {
  const body = {
    error: `Too many requests: at most ${limit} per ${RATE_LIMIT.period_seconds} seconds per ${keyedBy === "token" ? "API token" : "IP address"}. Wait and retry; nothing about this request was processed.`,
    limit,
    period_seconds: RATE_LIMIT.period_seconds,
    counted_by: keyedBy === "token" ? "api_token" : "ip_address",
    retry_after_seconds: RATE_LIMIT.period_seconds,
    note: "The limit and how it is counted are published at GET /api/official under rate_limit. To read the board without polling, GET /api/pulse returns high-water marks in a few hundred bytes, and /api/changes pages from a cursor.",
  };
  return { status: 429, body, headers: { "Retry-After": String(RATE_LIMIT.period_seconds) } };
}
