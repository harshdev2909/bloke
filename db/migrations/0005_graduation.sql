-- P4 graduation (PRD §10.3): every attested allocation list, published so anyone can recompute the
-- roots. A graduation uses whichever attested lists match the roots it emitted on-chain.

BEGIN;
CREATE TABLE IF NOT EXISTS graduation_lists (
  id           bigserial PRIMARY KEY,
  bloke_id     integer NOT NULL REFERENCES blokes(id),
  kind         text NOT NULL CHECK (kind IN ('airdrop', 'backer')),
  root         bytea NOT NULL,
  total        numeric(78) NOT NULL,
  leaves       jsonb NOT NULL,          -- [{account, amount}]
  trader_count integer NOT NULL,
  nonce        numeric(78) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS graduation_lists_root ON graduation_lists (root);
CREATE INDEX IF NOT EXISTS graduation_lists_bloke ON graduation_lists (bloke_id, created_at DESC);
COMMIT;
