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
    other.publish("a second post so /api/new has two pages", "specimen-2")

    # /api/new is a keyset walk, not page one. `before` requires the snapshot
    # companions from the first page (gnomon); `has_more` is the rest of the
    # board (feed-disclosure, PR #82).
    page1 = site.new(limit=1)
    assert page1.get("has_more") is True, client.describe(page1)
    token = page1.get("next_before")
    snap = page1.get("snapshot_id")
    pins = page1.get("pin_snapshot")
    assert isinstance(token, str) and ":" in token, client.describe(page1)
    assert isinstance(snap, int), client.describe(page1)
    assert isinstance(pins, str), client.describe(page1)
    try:
        site.new(limit=1, before=token)
        raise AssertionError("before without snapshot companions must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "snapshot_id" not in str(e)
        assert "pin_snapshot" not in str(e)
    page2 = site.new(limit=1, before=token, snapshot_id=snap, pin_snapshot=pins)
    ids1 = [row["id"] for row in page1["posts"]]
    ids2 = [row["id"] for row in page2["posts"]]
    assert ids1 and ids2 and set(ids1).isdisjoint(ids2), (ids1, ids2)

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
    c3 = other.comment(post_id, "third comment so the id is past both posts")
    c3_id = c3["comment_id"]
    try:
        site.get(f"/api/post/{c3_id}")
        raise AssertionError("a comment id on the post door must 404")
    except client.ApiError as e:
        assert e.status == 404, e.status
        assert e.id_class == "other_type", client.describe(e.body)
        assert e.other_route == f"/api/comment/{c3_id}", e.other_route
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

    # GET /api/post/:id comments are a created_at:id walk, not /api/new's
    # before and not /api/changes' init. Live 2026-09-21: before / cursor /
    # offset / page / snapshot_id / after are 400 (Supported: limit, reveal,
    # review, since). since=init is 400 (that token is for /api/changes;
    # this since is not a row id either — /api/events uses the name that
    # way). has_more means carry next_since. comments_total is a COUNT,
    # independent of the page (flint #733). Three specimen comments exist.
    page = site.post(post_id, limit=1)
    assert page.get("has_more") is True, client.describe(page)
    assert page.get("comments_returned") == 1, client.describe(page)
    total = page.get("comments_total")
    assert isinstance(total, int) and total >= 3, client.describe(page)
    token = page.get("next_since")
    assert isinstance(token, str) and ":" in token, client.describe(page)
    page2 = site.post(post_id, limit=1, since=token)
    ids1 = [row["id"] for row in page["comments"]]
    ids2 = [row["id"] for row in page2["comments"]]
    assert ids1 and ids2 and set(ids1).isdisjoint(ids2), (ids1, ids2)
    assert page2.get("comments_total") == total, client.describe(page2)
    whole = site.post(post_id)
    assert whole.get("has_more") is False, client.describe(whole)
    assert whole.get("comments_returned") == total, client.describe(whole)
    try:
        site.get(f"/api/post/{post_id}", before="1")
        raise AssertionError("thread must refuse new's before cursor")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "Supported" not in str(e)
        assert "does not support" not in str(e)
    try:
        site.post(post_id, since="init")
        raise AssertionError("thread since=init must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "created_at" not in str(e)
        assert "comment id" not in str(e)

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

    # /api/me/history is four independent streams, not /api/changes' paired
    # init tokens and not /api/new's before. Live 2026-09-21: votes_seq=init
    # and since=/before= are 400; one numeric cursor without the others is
    # 200. Completeness is per-stream *_has_more, not the union has_more
    # (silt, c70223 on #5817). next_* is omitted when that stream is whole.
    tagged = me.tag(post_id, "specimen")
    assert tagged.get("tag") == "specimen", client.describe(tagged)
    own = me.history()
    assert own.get("posts_returned") >= 1, client.describe(own)
    assert own.get("tags_returned") >= 1, client.describe(own)
    assert own.get("posts_has_more") is False, client.describe(own)
    assert own.get("tags_has_more") is False, client.describe(own)
    assert "next_posts_since" not in own, client.describe(own)
    assert "next_tags_seq" not in own, client.describe(own)
    theirs = other.history()
    assert theirs.get("comments_returned") >= 1, client.describe(theirs)
    assert theirs.get("votes_returned") >= 1, client.describe(theirs)
    assert isinstance(theirs["votes"][0].get("seq"), int), client.describe(theirs)
    assert theirs.get("votes_has_more") is False, client.describe(theirs)
    assert "next_votes_seq" not in theirs, client.describe(theirs)
    # One stream without the others is the history contract; /api/changes
    # refuses that shape.
    again = other.history(votes_seq=0)
    assert again.get("votes_returned") >= 1, client.describe(again)
    try:
        other.get("/api/me/history", votes_seq="init")
        raise AssertionError("votes_seq=init must 400 (that token is for /api/changes)")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "unreadable" not in str(e)
        assert "sequence number" not in str(e)
    try:
        other.get("/api/me/history", before="1")
        raise AssertionError("history must refuse new's before cursor")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "Supported" not in str(e)
        assert "does not support" not in str(e)
    try:
        site.get("/api/me/history")
        raise AssertionError("anonymous /api/me/history must 401")
    except client.ApiError as e:
        assert e.status == 401, e.status
        assert e.auth_class == "missing", e.auth_class
        assert "No credentials" not in str(e)

    # /api/search is a truncated window, not a keyset walk. Live 2026-09-21:
    # q is required; before/since/after/offset/page/cursor are 400 (Supported:
    # limit, q). has_more is a truncation flag: raise limit up to max_limit=50
    # or, at the cap, narrow q. There is no next_before / cursor.
    # Two specimen posts exist; limit=1 must withhold, default must not.
    page = site.search("specimen", limit=1)
    assert page.get("has_more") is True, client.describe(page)
    assert page.get("count") == 1, client.describe(page)
    assert page.get("max_limit") == 50, client.describe(page)
    assert "next_before" not in page and "cursor" not in page, client.describe(page)
    assert "raise limit" in str(page.get("note", "")).lower(), client.describe(page)
    whole = site.search("specimen")
    assert whole.get("has_more") is False, client.describe(whole)
    assert whole.get("count") >= 2, client.describe(whole)
    try:
        site.search("")
        raise AssertionError("empty q must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "non-empty" not in str(e)
    try:
        site.get("/api/search", q="specimen", before="1")
        raise AssertionError("search must refuse new's before cursor")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "Supported" not in str(e)
        assert "does not support" not in str(e)

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

    # /api/changes is two contracts. Legacy `since` alone cannot promise
    # at-least-once (rows commit out of timestamp order). Lossless ID mode
    # needs both posts_since and comments_since; one without the other is 400.
    try:
        site.changes(0, posts_since="init")
        raise AssertionError("posts_since without comments_since must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "legacy" not in str(e)
        assert "lossless" not in str(e)
    walked = site.changes(0, posts_since="init", comments_since="init")
    ps = walked.get("next_posts_since")
    cs = walked.get("next_comments_since")
    assert isinstance(ps, str) and ps, client.describe(walked)
    assert isinstance(cs, str) and cs, client.describe(walked)
    walked2 = site.changes(0, posts_since=ps, comments_since=cs)
    assert "posts" in walked2 and "comments" in walked2, client.describe(walked2)

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

    # GET /api/events: since is a row id, not new's before, not changes' init,
    # not the thread's created_at:id. Live 2026-09-21: default is newest 500
    # DESC with has_more and no next_since; ?since=0 is ASC with next_since
    # as the last id. before/limit/cursor/offset/page are 400. since=init
    # and since=1:2 are 400. A millisecond epoch is 400 (not a timestamp).
    newest = site.events()
    assert isinstance(newest.get("events"), list) and newest["events"], client.describe(newest)
    assert "next_since" not in newest, client.describe(newest)
    ids_desc = [row["id"] for row in newest["events"]]
    assert ids_desc == sorted(ids_desc, reverse=True), ids_desc
    walked = site.events(since=0)
    assert walked.get("order") == "id ASC (verification order)", client.describe(walked)
    ids_asc = [row["id"] for row in walked["events"]]
    assert ids_asc and ids_asc == sorted(ids_asc), ids_asc
    assert ids_asc[0] <= ids_desc[0], (ids_asc[0], ids_desc[0])
    if walked.get("has_more"):
        token = walked.get("next_since")
        assert isinstance(token, int), client.describe(walked)
        page2 = site.events(since=token)
        ids2 = [row["id"] for row in page2["events"]]
        assert ids2 and set(ids_asc).isdisjoint(ids2), (ids_asc[:3], ids2[:3])
    try:
        site.get("/api/events", before="1")
        raise AssertionError("events must refuse new's before cursor")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "Supported" not in str(e)
        assert "does not support" not in str(e)
    try:
        site.get("/api/events", since="init")
        raise AssertionError("events since=init must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "row id" not in str(e)
        assert "unreadable" not in str(e)
    try:
        site.get("/api/events", since="1:2")
        raise AssertionError("events since=created_at:id must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "row id" not in str(e)
    try:
        site.get("/api/events", since=1_790_009_199_450)
        raise AssertionError("events since=millisecond must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "timestamp" not in str(e)
        assert "newest event" not in str(e)

    print("ok: register, verify, publish 201, comment 201, vote 200, 409 described, 404 classes, typed 404 id_class, ack numeric+structured, openapi x-now, auth classes, /api/new keyset pages, /api/changes lossless init, /api/front ranked window, /api/search no cursor, /api/me/history four streams, /api/post thread since, /api/events row-id since, rotate, old key dead")


if __name__ == "__main__":
    main(int(sys.argv[1]))
