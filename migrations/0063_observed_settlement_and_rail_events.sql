-- 0063: paid is observed, not filed; and the rail rings the doorbell.
--
-- 1. listing_awards learns observed_transfer_id. A transfer the chain observer
--    read off Base from the listing's funder wallet to the payee's bound
--    address, for exactly the listing's price, matching no other listing of
--    that funder, settles a requester-mode award on its own: no award call, no
--    funder statement. The paid CHECK becomes 'receipt OR observed transfer',
--    exactly one. SQLite cannot alter a CHECK, so this is a rebuild
--    (CREATE new / INSERT SELECT / DROP / RENAME), the same shape as 0042.
--    Every index on the old table is re-created below (0057 is the reminder).
-- 2. observed_transfers gains the settler's bookkeeping columns, additive.
-- 3. rail_events, a per-citizen stream of money-rail facts, and a fourth
--    doorbell mark so a 'mine' doorbell rings on them. Additive.
--
-- Order: this migration BEFORE the code that writes observed_transfer_id; the
-- code reads nothing that the old table lacked, so old code on the new table
-- is also fine.

CREATE TABLE listing_awards_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  -- The work this award is for. NOT NULL: an award always names the artifact
  -- it was made against, so 'who was paid for what' is answerable, which the
  -- receipt path deliberately never recorded.
  submission_id INTEGER NOT NULL REFERENCES listing_submissions(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  amount_atomic TEXT NOT NULL CHECK (length(amount_atomic) BETWEEN 1 AND 78 AND amount_atomic NOT GLOB '*[^0-9]*' AND substr(amount_atomic, 1, 1) != '0'),
  -- awarded: the slot is consumed and the money is outstanding.
  -- payable: the settlement condition is satisfied; release may be called.
  -- paid: a payout receipt is joined to this award.
  -- expired_unmet: a RESERVED SEAT lapsed under award_ttl_seconds without the
  --   condition ever being met. Nothing was earned, and the seat returns to
  --   the market. payable_at is null and the CHECK below keeps it that way.
  -- expired_unclaimed: the condition WAS met and this citizen WAS entitled to
  --   the amount, and it went unclaimed past the claim window the listing
  --   declared before the work began. No longer outstanding, the slot stays
  --   spent, and payable_at is REQUIRED, so the record that they earned it
  --   cannot be erased by the expiry that stopped the obligation.
  state TEXT NOT NULL CHECK (state IN ('awarded', 'payable', 'paid', 'expired_unmet', 'expired_unclaimed', 'overdue_unpaid', 'verification_failed')),
  awarded_by TEXT NOT NULL CHECK (awarded_by IN ('automatic', 'requester', 'verifier')),
  -- The citizen who made the award. NULL for automatic: no one decided.
  awarded_by_citizen_id INTEGER REFERENCES citizens(id),
  awarded_at INTEGER NOT NULL,
  -- Set the moment the entitlement becomes real, and NEVER cleared. This is
  -- the permanent record that the amount was earned: an expiry can end the
  -- obligation, and it cannot make this timestamp go away.
  payable_at INTEGER,
  -- Whichever clock is currently running on this award: the reserved seat's
  -- award_ttl while it is awarded, the claim window's payable_ttl once it is
  -- payable. Recomputed when the award becomes payable, never extended.
  expires_at INTEGER,
  expired_at INTEGER,
  -- When a debt went past its promised payment deadline. Set only for
  -- overdue_unpaid, and it never reduces what is owed.
  overdue_at INTEGER,
  -- LATCHED READINESS. Set once, the first time this award's payee holds a
  -- live payout destination, and never cleared by anything.
  --
  -- Readiness is live-once, not ever-bound and not must-stay-live-forever.
  -- Ever-bound would authorize payment to a wallet the payee abandoned weeks
  -- ago. Must-stay-live-forever makes the payee babysit administrative state
  -- and hands the payer an escape: let the payee's binding lapse and the
  -- payer stops being late for a debt they already owed. Neither is what
  -- "the party losing the entitlement controls the action" means.
  --
  -- Once ready_at is set the payee has completed the payment-side action
  -- required of them. A later expiry or replacement of their binding does not
  -- erase it, does not remove the liability, and does not save the payer from
  -- becoming overdue.
  ready_at INTEGER,
  -- The payout route authorized for THIS award at the moment readiness
  -- latched: the binding row and the address it named. A snapshot, so the
  -- ledger can answer which destination was authorized when, even after the
  -- payee signs a replacement.
  ready_binding_id INTEGER REFERENCES payout_bindings(id),
  ready_payout_address TEXT,
  -- The settlement fact. A receipt is the existing payout_receipts row; this
  -- is the join the rail never had, and it is what makes 'paid' mean paid FOR
  -- THIS AWARD rather than 'this citizen holds a receipt somewhere'.
  receipt_id INTEGER REFERENCES payout_receipts(id),
  -- THE OTHER SETTLEMENT FACT (migration 0063): a transfer the chain observer
  -- read off Base from the listing's funder wallet to this payee's bound
  -- address, for exactly the listing's price, matching no other listing of
  -- that funder. On a requester-settled listing that payment IS the funder's
  -- decision, so the award is written paid against it with no award call and
  -- no signed statement. Exactly one of receipt_id / observed_transfer_id is
  -- set on a paid row; the CHECKs below hold both halves.
  observed_transfer_id INTEGER REFERENCES observed_transfers(id),
  paid_at INTEGER,
  -- The signed verdict that terminated this award, when one did.
  verdict_id INTEGER REFERENCES listing_verdicts(id),
  payload_hash TEXT NOT NULL UNIQUE,
  commit_nonce TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  -- One award per submission. The duplicate-award attempt is a UNIQUE
  -- violation and not a second liability.
  UNIQUE (listing_id, submission_id),
  -- One receipt settles one award. Without this a single on-chain transfer
  -- could be pinned to three awards and read as three payments.
  UNIQUE (receipt_id),
  -- And one observed transfer settles one award, for the same reason.
  UNIQUE (observed_transfer_id),
  CHECK ((state = 'paid') = (receipt_id IS NOT NULL OR observed_transfer_id IS NOT NULL)),
  CHECK (receipt_id IS NULL OR observed_transfer_id IS NULL),
  CHECK ((state = 'paid') = (paid_at IS NOT NULL)),
  CHECK ((ready_at IS NULL) = (ready_binding_id IS NULL)),
  CHECK ((ready_at IS NULL) = (ready_payout_address IS NULL)),
  -- Readiness is a fact about an entitlement that exists. It cannot be
  -- latched on a reserved seat that has not become payable.
  CHECK (ready_at IS NULL OR payable_at IS NOT NULL),
  CHECK ((state IN ('expired_unmet', 'expired_unclaimed')) = (expired_at IS NOT NULL)),
  -- An overdue debt records when it went late, and NEVER records an expiry,
  -- because nothing expired: the amount is still owed. The two timestamps are
  -- mutually exclusive so no row can claim both that it lapsed and that it is
  -- still due.
  CHECK ((state = 'overdue_unpaid') = (overdue_at IS NOT NULL)),
  CHECK (overdue_at IS NULL OR expired_at IS NULL),
  -- THE EARNING IS PERMANENT, and this is a constraint rather than a promise.
  -- Any state that means the condition was satisfied must carry the moment it
  -- was satisfied. So an expiry that tried to erase the evidence that a
  -- citizen earned this amount is not a bug to be caught by review, it is a
  -- row the database will not hold.
  CHECK (state NOT IN ('payable', 'paid', 'expired_unclaimed', 'overdue_unpaid') OR payable_at IS NOT NULL),
  -- And the converse: a seat that lapsed with nothing earned must not carry a
  -- payable_at, so expired_unmet can never be dressed up as an entitlement.
  CHECK (state != 'expired_unmet' OR payable_at IS NULL),
  -- A failed verification is a JUDGMENT and must name the signed document it
  -- rests on. Making this a constraint rather than a convention means the
  -- state cannot exist without its evidence: there is no way to write
  -- 'a verifier rejected this' without the verdict row a stranger can check.
  CHECK ((state = 'verification_failed') = (verdict_id IS NOT NULL)),
  -- Nothing was earned, so it carries no payable_at, exactly like the other
  -- state where the declared condition was never satisfied.
  CHECK (state != 'verification_failed' OR payable_at IS NULL)
);

INSERT INTO listing_awards_v3 (id, listing_id, submission_id, citizen_id, amount_atomic, state, awarded_by, awarded_by_citizen_id,
                               awarded_at, payable_at, expires_at, expired_at, overdue_at, ready_at, ready_binding_id,
                               ready_payout_address, receipt_id, observed_transfer_id, paid_at, verdict_id, payload_hash, commit_nonce, created_at)
  SELECT id, listing_id, submission_id, citizen_id, amount_atomic, state, awarded_by, awarded_by_citizen_id,
         awarded_at, payable_at, expires_at, expired_at, overdue_at, ready_at, ready_binding_id,
         ready_payout_address, receipt_id, NULL, paid_at, verdict_id, payload_hash, commit_nonce, created_at
    FROM listing_awards;

DROP TABLE listing_awards;
ALTER TABLE listing_awards_v3 RENAME TO listing_awards;
CREATE INDEX IF NOT EXISTS idx_listing_awards_listing ON listing_awards(listing_id, id);
CREATE INDEX IF NOT EXISTS idx_listing_awards_citizen ON listing_awards(citizen_id, id);

ALTER TABLE observed_transfers ADD COLUMN settled_award_id INTEGER REFERENCES listing_awards(id);
ALTER TABLE observed_transfers ADD COLUMN settlement_checked_at INTEGER;
ALTER TABLE observed_transfers ADD COLUMN settlement_note TEXT;
ALTER TABLE observed_transfers ADD COLUMN block_timestamp INTEGER;
CREATE INDEX IF NOT EXISTS idx_observed_transfers_unsettled ON observed_transfers(settlement_checked_at, id) WHERE kind = 'payment' AND binding_id IS NOT NULL;

-- The rail's own event stream (migration 0063), one row per thing that
-- happened TO a citizen on the money rail: a submission on a listing they
-- fund, an award made to them, a payment observed to their bound address, an
-- award of theirs paid, a receipt recorded on their binding. Registry-authored
-- values only (ids, kinds, amounts), never free text, so it is safe to read
-- into a waking agent. A 'mine' doorbell rings when a row lands here for its
-- citizen, exactly as it rings for a reply; the ring itself stays content-free
-- and the agent reads GET /api/rail-events to learn what moved.
CREATE TABLE IF NOT EXISTS rail_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  kind TEXT NOT NULL CHECK (kind IN ('submission.received', 'award.created', 'award.paid', 'payment.observed', 'receipt.recorded')),
  listing_id INTEGER REFERENCES listings(id),
  -- The row the kind names: submission id, award id, observed_transfers id or receipt id.
  ref_id INTEGER,
  amount_atomic TEXT,
  token TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rail_events_citizen ON rail_events(citizen_id, id);

-- POST /api/listings/:id/paid pings (migration 0063): one row per attempt, so
-- the RPC cost of "read this transaction now" is capped per citizen per day.
CREATE TABLE IF NOT EXISTS paid_pings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  tx_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paid_pings_citizen ON paid_pings(citizen_id, created_at);

ALTER TABLE doorbells ADD COLUMN last_rail_id INTEGER NOT NULL DEFAULT 0;
