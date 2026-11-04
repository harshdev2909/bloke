-- API layer (PRD §13.3–13.4): chart history, attestation audit, reports, faucet relays.

BEGIN;

-- Applied oracle values per push, for charts (1 m / 5 m / 1 h buckets) and 1 h change.
ALTER TABLE oracle_values ADD COLUMN IF NOT EXISTS ts timestamptz;
CREATE INDEX IF NOT EXISTS oracle_values_bloke_ts ON oracle_values (bloke_id, ts DESC);

-- Identities: show the handle; allow the staging-only `test` provider used by integration tests.
ALTER TABLE identities ADD COLUMN IF NOT EXISTS handle text;
ALTER TABLE identities DROP CONSTRAINT IF EXISTS identities_provider_check;
ALTER TABLE identities ADD CONSTRAINT identities_provider_check CHECK (provider IN ('github', 'x', 'test'));
CREATE INDEX IF NOT EXISTS identities_wallets ON identities USING gin (wallets);

CREATE TABLE IF NOT EXISTS attestations (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('faucet', 'claim', 'sources', 'graduation')),
  wallet      bytea NOT NULL,
  bloke_id    integer REFERENCES blokes(id),
  nonce       numeric(78),
  expiry      timestamptz NOT NULL,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attestations_wallet ON attestations (wallet, created_at DESC);

CREATE TABLE IF NOT EXISTS faucet_relays (
  id             bigserial PRIMARY KEY,
  identity_hash  bytea NOT NULL REFERENCES identities(identity_hash),
  wallet         bytea NOT NULL,
  tx_hash        bytea NOT NULL,
  drip_tx_hash   bytea,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('abuse', 'removal')),
  bloke_id    integer REFERENCES blokes(id),
  wallet      bytea,
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'closed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Lots carry the market's leg/bloke for cheap portfolio queries.
CREATE INDEX IF NOT EXISTS orders_market ON orders (market_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS closes_closed_at ON closes (closed_at DESC);

COMMIT;
