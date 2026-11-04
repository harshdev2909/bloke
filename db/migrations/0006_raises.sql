-- Raises (amendment A18): one row per raise, one per commitment/refund event.

BEGIN;
CREATE TABLE IF NOT EXISTS raises (
  id          bigint PRIMARY KEY,                 -- on-chain raise id
  bloke_id    integer NOT NULL REFERENCES blokes(id),
  person      bytea NOT NULL,
  goal        numeric(78) NOT NULL,
  min_commit  numeric(78) NOT NULL,
  raised      numeric(78) NOT NULL DEFAULT 0,
  opened_at   timestamptz NOT NULL,
  deadline    timestamptz NOT NULL,
  state       text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'succeeded', 'cancelled', 'withdrawn')),
  tx_hash     bytea NOT NULL
);
CREATE INDEX IF NOT EXISTS raises_bloke ON raises (bloke_id, id DESC);

CREATE TABLE IF NOT EXISTS raise_events (
  id        bigserial PRIMARY KEY,
  raise_id  bigint NOT NULL REFERENCES raises(id),
  wallet    bytea NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('commit', 'refund')),
  amount    numeric(78) NOT NULL,
  at        timestamptz NOT NULL,
  tx_hash   bytea NOT NULL
);
CREATE INDEX IF NOT EXISTS raise_events_raise ON raise_events (raise_id);
CREATE INDEX IF NOT EXISTS raise_events_wallet ON raise_events (wallet);
COMMIT;
