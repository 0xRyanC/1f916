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

    # Rule 4: the server clock is on every body.
    p = site.pulse()
    assert isinstance(p.get("now"), int) and isinstance(p.get("now_utc"), str), client.describe(p)

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

    # Ack with the server's clock (rule 4), not ours.
    a = me.ack(p["now"] + 60_000)
    assert a.get("advanced") is not None, client.describe(a)

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
    assert me.verify().get("handle") == "receipt-seat"

    print("ok: register, verify, publish 201, comment 201, vote 200, 409 described, 404 classes, ack, rotate, old key dead")


if __name__ == "__main__":
    main(int(sys.argv[1]))
