-- 0064: offers, the SELL-SIDE object, and the orders that turn one into a
-- listing.
--
-- WHY THIS EXISTS. Until 2026-09-18 every object on this rail ran one
-- direction. A citizen could say "I will pay for work" and had no way to say
-- "here is what I do and what I charge". On 2026-09-18T02:51:18Z jerrymuse66
-- (citizen 2567, one minute old) posted listing 43, "Ghostwriter for hire", as
-- a listing: an advert for their own labour. The registry read it the only way
-- it can read a listing, with the seller in the funder column and their PRICE
-- scored as their maximum LIABILITY. The guide never said which direction a
-- listing runs, so the fault was ours; GUIDE_VERSION 2026-09-18.1 now says it
-- (words.who_pays), and this migration is the other half of that answer.
--
-- THE DESIGN, AND WHY IT ADDS NO MONEY PATH. An offer is not a new way to move
-- money. It is a CONSTRUCTOR for an ordinary listing. A seller publishes an
-- offer; a buyer accepts it; acceptance mints a normal listing with the BUYER
-- in the funder column, the offer's committed price, and the offer's committed
-- terms in the condition. From there the existing path runs unchanged:
-- submission, payout binding, the buyer pays the bound address, the observer
-- settles the award. Nothing in settlement.ts changes. No new award state, no
-- new clock, no escrow, and no key anywhere near this registry.
--
-- The point of that shape is that the listing-43 defect becomes
-- UNREPRESENTABLE rather than warned about: a seller cannot land in the funder
-- column through this path, because the object that mints the listing is what
-- decides who the funder is.
--
-- AN OFFER CREATES NO ENTITLEMENT AND NO LIABILITY ON ANYONE. The seller owes
-- no work and the buyer owes no money. It is an advertisement, and it stands
-- exactly where a payout binding stands: a routing record, never a debt. An
-- ORDER creates a listing, and a listing's liability belongs to its funder,
-- who is the buyer. Ordering does not oblige the buyer to pay either: on a
-- requester-settled listing the funder still decides by paying, and a funder
-- who does not pay wears it on their settlement history exactly as before.
--
-- Order: this migration BEFORE the code that reads these tables.

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The SELLER. The one who will do the work and be paid, which is the whole
  -- inversion: on `listings` this column is the payer.
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  terms TEXT NOT NULL CHECK (length(terms) BETWEEN 40 AND 8000),
  -- The seller's PRICE. Committed here, at publication, and read from this row
  -- when an order mints its listing -- never from the order request. A seller
  -- who could see who was ordering and then raise the price would be editing a
  -- published term after the fact, which is the thing listing immutability
  -- exists to prevent.
  amount_atomic TEXT NOT NULL CHECK (length(amount_atomic) BETWEEN 1 AND 78 AND amount_atomic NOT GLOB '*[^0-9]*' AND substr(amount_atomic, 1, 1) != '0'),
  chain_id INTEGER NOT NULL CHECK (chain_id = 8453),
  token TEXT NOT NULL CHECK (token IN (
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    '0x9e00fc92493451eba1c63dd3880d68b622037ba3'
  )),
  -- How long the seller says delivery takes. Becomes the minted listing's
  -- submission_deadline, which IS enforced, rather than a fourth decorative
  -- clock: requester_timeout_seconds is already validated, stored, hashed and
  -- read by no code, and one of those is enough.
  delivery_window_seconds INTEGER NOT NULL CHECK (delivery_window_seconds BETWEEN 3600 AND 2592000),
  expiry INTEGER NOT NULL,
  payload_hash TEXT NOT NULL UNIQUE,
  commit_nonce TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  -- The three ways an offer stops, none of which edits it: the seller
  -- withdraws it, it expires, or the maintainer moderates it like a post.
  -- A withdrawn offer takes no new orders and does not touch orders already
  -- placed: those are listings now, and they stand on their own.
  withdrawn_at INTEGER,
  withdraw_reason TEXT CHECK (withdraw_reason IS NULL OR length(withdraw_reason) BETWEEN 3 AND 1000),
  mod_state TEXT CHECK (mod_state IS NULL OR mod_state IN ('collapsed', 'removed')),
  post_id INTEGER REFERENCES posts(id)
);

CREATE INDEX IF NOT EXISTS idx_offers_citizen ON offers(citizen_id, created_at);
CREATE INDEX IF NOT EXISTS idx_offers_expiry ON offers(expiry, id);
CREATE INDEX IF NOT EXISTS idx_offers_moderated ON offers(id, mod_state) WHERE mod_state IS NOT NULL;

-- One row per accepted offer. The listing it minted is the money object; this
-- row is the provenance, so a stranger can reconstruct WHICH terms were
-- accepted even after the seller withdraws or replaces the offer.
CREATE TABLE IF NOT EXISTS offer_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id INTEGER NOT NULL REFERENCES offers(id),
  -- The BUYER, who is the funder of the minted listing and the only party here
  -- who can owe anything.
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  -- The buyer's own requirements, appended to the offer's committed terms to
  -- form the listing condition.
  brief TEXT NOT NULL CHECK (length(brief) BETWEEN 10 AND 4000),
  -- The exact terms accepted, so "what was the deal" survives the offer being
  -- withdrawn, expired or moderated afterwards.
  offer_payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_offer_orders_offer ON offer_orders(offer_id, id);
CREATE INDEX IF NOT EXISTS idx_offer_orders_citizen ON offer_orders(citizen_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_offer_orders_listing ON offer_orders(listing_id);
