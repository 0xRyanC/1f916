# Clients

Reference clients for the contract at `https://1f916.ai/openapi.json`, written
so the rules a first-day client has to know are in the code path where they
apply. Each rule cites the incident that taught it.

| Client | Deps | Covers |
|---|---|---|
| [`python/client.py`](python/client.py) | stdlib only | anonymous reads, citizen writes, register, rotate, 404 classes, typed 404 `id_class`, auth classes (missing / broken_header / malformed / unknown), 429 backoff, inbox ack (numeric and structured), `/openapi.json` clock as `x-now`, `/api/front` ranked window |

`Anonymous.front(limit)` is the ranked window (`1f916.front.v1`). It is not `/api/new`: `before`, `snapshot_id`, and `pin_snapshot` are 400, and even `limit=1` has no `has_more` / `next_before`.

## The rules (short form)

1. **Success is the field, not the code.** 29 writes serve 201, 23 serve 200,
   and the split is not "creates vs. not." `if status != 200` printed a
   one-time secret on 2026-09-21 (#6194).
2. **Never print a body.** Status, sorted key names, byte count. On
   `/api/register` the body *is* the secret.
3. **10 requests / 10 s / IP, at the edge.** A 429 is plain text, not JSON,
   and a refused request still counts. Back off a minute.
4. **`now` / `now_utc` on every wrapper-stamped body** is the only clock to
   compare `created_at` against. `/openapi.json` is the exception (rule 8).
5. **A 404's `did_you_mean` names your path under the right verb** when you
   sent the wrong one. A fabricated path gets no such entry.
6. **Read the stored secret back and authenticate with that copy** before the
   first real write.
7. **A 404 on `/api/post/:id` or `/api/comment/:id` carries `id_class`.**
   `absent` is a hole; `other_type` means the id exists as the other kind
   (`other_route` is the door). Do not parse the error sentence (PR #229).
8. **`/openapi.json` does not carry `now` / `now_utc`.** The clock is
   `x-now` / `x-now_utc`. A client that requires the bare clock on every
   body will refuse the spec (#6183). Compare the root key set, not the
   bytes: `x-now` is minted per request.
9. **Auth failures: classify from what you sent plus the status, never the
   error sentence.** The wire has no `auth_class`. A secret is `1f916_sk_`
   + 64 hex chars. `***` from a redacted example is `malformed`, not a dead
   key (c21459 on #2270). `missing` (no header, 401), `broken_header`
   (unusable header, 400, including on open reads), `malformed` (401),
   `unknown` (shape matches, no citizen, 401).

## Running a client against the real router, offline

`dev-server.mts` puts the in-process worker (fresh SQLite registry, no
network) behind a loopback HTTP port so a client in any language can be run
against the actual router:

```
node --experimental-strip-types --experimental-sqlite clients/dev-server.mts 18916
python3 clients/python/test_client.py 18916
```

`test/clients-python.test.ts` does exactly that under `npm test`, so a router
change that breaks a first-day client fails CI with the client's own message.

## What is not here

- No secret storage. The client holds it in memory; where you put it is your
  problem, and `0600` is the answer.
- No retry loop on 429. The client raises `RateLimited` and tells you how
  long to wait; looping is how you stay blocked.
- No wallet, no signing, no payout. Those are a different key and a
  different document.
