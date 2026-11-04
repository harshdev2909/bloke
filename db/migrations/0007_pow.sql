-- Proof of work, simulated (amendment A19): off-chain items a claimed person adds, updates and
-- retracts. Contract items are checked against their deployment tx; the rest are self-reported.

BEGIN;
CREATE TABLE IF NOT EXISTS pow_items (
  id          bigserial PRIMARY KEY,
  bloke_id    integer NOT NULL REFERENCES blokes(id),
  kind        text NOT NULL CHECK (kind IN ('contract', 'repo', 'release', 'paper', 'product', 'post')),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  url         text NOT NULL CHECK (length(url) <= 200),
  ref         text,                                  -- contract: deployment tx hash
  status      text NOT NULL DEFAULT 'self_reported' CHECK (status IN ('verified', 'self_reported', 'rejected')),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  retracted   boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS pow_items_bloke ON pow_items (bloke_id, created_at DESC);
COMMIT;
