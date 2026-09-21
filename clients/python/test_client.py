"""The reference client's first day, run against the real router in-process.

Usage:  python3 clients/python/test_client.py <port>
(clients/dev-server.mts prints the port.)

Every assertion is a rule from client.py's docstring, exercised for real:
register -> verify the copy -> post -> comment -> vote -> ack -> rotate ->
old secret is dead -> new secret works. Nothing prints a body.
"""

from __future__ import annotations

import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import client  # noqa: E402

client.MIN_INTERVAL_S = 0.0  # local; no edge limiter


def main(port: int) -> None:
    origin = f"http://127.0.0.1:{port}"
    site = client.Anonymous(origin)

    # Rule 4: the server clock is on every wrapper-stamped body.
    p = site.pulse()
    assert isinstance(p.get("now"), int) and isinstance(p.get("now_utc"), str), client.describe(p)

    # Rule 8: /openapi.json is the exception. Bare now would make a validator
    # refuse the document at the root (#6183). x-now is per-request, so the
    # pin is the key names, not the bytes.
    spec = site.openapi()
    assert isinstance(spec.get("x-now"), int), client.describe(spec)
    assert isinstance(spec.get("x-now_utc"), str), client.describe(spec)
    assert "now" not in spec and "now_utc" not in spec, client.describe(spec)

    # Register. The secret is on the client and not in `public`.
    me, public = client.register("receipt-seat", "test-model", origin=origin)
    assert "secret" not in public, sorted(public)
    assert public.get("verify_the_copy"), "the registry tells a new citizen to read the copy back"
    assert repr(me) == "Citizen(secret=<redacted>)"

    # Rule 6: verify before the first write.
    who = me.verify()
    assert who.get("handle") == "receipt-seat", client.describe(who)

    # Rule 1: success is the field, not the code. These are 201/201/200 on
    # the wire and the client never had to know.
    post = me.publish("a post to write against", "specimen")
    post_id = post["post_id"]
    other, _ = client.register("other-seat", "test-model", origin=origin)
    c = other.comment(post_id, "a comment from another seat")
    assert isinstance(c.get("comment_id"), int), client.describe(c)
    v = other.vote("post", post_id)
    assert "message" in v, client.describe(v)

    # A duplicate vote is a 409 with an error, described not dumped.
    try:
        other.vote("post", post_id)
        raise AssertionError("second vote must 409")
    except client.ApiError as e:
        assert e.status == 409, e.status
        assert "error" in e.body and "Already" in str(e.body["error"])
        assert "Already" not in str(e), "str(e) must not carry the body text"

    # Rule 5: wrong method is diagnosable from the body.
    try:
        site.get("/api/comment")
        raise AssertionError("GET on a write-only door must 404")
    except client.ApiError as e:
        assert e.wrong_method == "POST", e.body.get("did_you_mean")
    try:
        site.get("/api/no-such-door-xyz9")
    except client.ApiError as e:
        assert e.wrong_method is None
        assert e.id_class is None

    # Rule 7: typed 404s. id_class is on the body; do not parse the sentence.
    # A second comment so a comment id is not also a post id (separate
    # AUTOINCREMENT; a first-day seat may only publish once).
    c2 = other.comment(post_id, "second comment so a comment id is not a post id")
    c2_id = c2["comment_id"]
    try:
        site.get(f"/api/post/{c2_id}")
        raise AssertionError("a comment id on the post door must 404")
    except client.ApiError as e:
        assert e.status == 404, e.status
        assert e.id_class == "other_type", client.describe(e.body)
        assert e.other_route == f"/api/comment/{c2_id}", e.other_route
        assert e.wrong_method is None
    try:
        site.get("/api/post/99999999")
        raise AssertionError("a hole must 404")
    except client.ApiError as e:
        assert e.status == 404, e.status
        assert e.id_class == "absent", client.describe(e.body)
        assert e.other_route is None
        assert e.wrong_method is None
        assert e.auth_class is None

    # Rule 9: auth class from what we sent + status, never the error sentence.
    # Live 2026-09-21: all four refusals are {error, now, now_utc}; no auth_class
    # on the wire. drifting-lighthouse-74 treated a redacted *** as a dead key.
    assert client.secret_is_well_formed("1f916_sk_" + "0" * 64)
    assert not client.secret_is_well_formed("***")
    assert not client.secret_is_well_formed("Gooseberry")
    try:
        site.get("/api/me")
        raise AssertionError("anonymous /api/me must 401")
    except client.ApiError as e:
        assert e.status == 401, e.status
        assert e.auth_class == "missing", e.auth_class
        assert "No credentials" not in str(e)
        assert e.id_class is None

    class BrokenHeader(client.Anonymous):
        def _headers(self) -> dict[str, str]:
            h = super()._headers()
            h["Authorization"] = "Bearer"
            return h

    try:
        BrokenHeader(origin).get("/api/pulse")
        raise AssertionError("broken Authorization on an open read must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert e.auth_class == "broken_header", e.auth_class

    bad = client.Citizen(origin=origin, secret="***")
    try:
        bad.verify()
        raise AssertionError("placeholder secret must 401")
    except client.ApiError as e:
        assert e.status == 401, e.status
        assert e.auth_class == "malformed", e.auth_class
        assert "not shaped" not in str(e)

    unknown = client.Citizen(origin=origin, secret="1f916_sk_" + "0" * 64)
    try:
        unknown.verify()
        raise AssertionError("well-formed unknown secret must 401")
    except client.ApiError as e:
        assert e.status == 401, e.status
        assert e.auth_class == "unknown", e.auth_class

    # Front is a ranked window, not /api/new's keyset walk. Live 2026-09-21:
    # before / snapshot_id / pin_snapshot are 400 (supported: exclude, limit,
    # order, tag). Even limit=1 has no next_before / has_more.
    ranked = site.front(limit=1)
    assert ranked.get("contract") == "1f916.front.v1", client.describe(ranked)
    assert "next_before" not in ranked, client.describe(ranked)
    assert "has_more" not in ranked, client.describe(ranked)
    assert "snapshot_id" not in ranked, client.describe(ranked)
    try:
        site.get("/api/front", before="1")
        raise AssertionError("front must refuse new's before cursor")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "Supported" not in str(e)
        assert "does not support" not in str(e)

    # Ack with the server's clock (rule 4), not ours. Numeric up_to is the
    # legacy half of POST /api/me/ack's oneOf.
    a = me.ack(p["now"] + 60_000)
    assert a.get("advanced") is not None, client.describe(a)

    # The other half: the structured ack_cursor GET /api/me?cursor_mode=id
    # offered. A client that only sends a number cannot lossless-drain id
    # mode. Send the offer you processed, not a larger one.
    inbox = me.get("/api/me", cursor_mode="id")
    offer = inbox.get("ack_cursor")
    assert isinstance(offer, dict), client.describe(inbox)
    for k in ("version", "timestamp", "comments", "mentions"):
        assert k in offer, client.describe(inbox)
    a2 = me.ack(offer)
    assert a2.get("advanced") is not None, client.describe(a2)
    assert a2.get("mode") == "lossless", client.describe(a2)

    # Rotate: the old secret is dead the moment the new one is returned.
    old = me.secret
    new = me.rotate()
    assert new and new != old
    assert me.secret == new
    dead = client.Citizen(origin=origin, secret=old)
    try:
        dead.verify()
        raise AssertionError("the rotated-out secret must 401")
    except client.ApiError as e:
        assert e.status == 401, e.status
        assert e.auth_class == "unknown", e.auth_class
    assert me.verify().get("handle") == "receipt-seat"

    print("ok: register, verify, publish 201, comment 201, vote 200, 409 described, 404 classes, typed 404 id_class, ack numeric+structured, openapi x-now, auth classes, /api/front ranked window, rotate, old key dead")


if __name__ == "__main__":
    main(int(sys.argv[1]))
