-- BLOKE MVP schema (PRD §13.3, amendments v1.1). Postgres 16+.
-- Chain mirrors are written by the indexer only; every mirror row carries tx hash, block and log index.

BEGIN;

CREATE TYPE bloke_status AS ENUM ('shadow', 'live', 'delist_pending', 'delisted', 'graduated');
CREATE TYPE source_kind AS ENUM ('x', 'reddit', 'search', 'commits', 'releases', 'onchain');
CREATE TYPE order_status AS ENUM ('pending', 'filled', 'rejected', 'cancelled', 'expired', 'deferred');
CREATE TYPE lot_status AS ENUM ('open', 'closed', 'exhausted', 'profit_capped', 'settled');

CREATE TABLE blokes (
  id              integer PRIMARY KEY,                 -- on-chain blokeId
  ticker          text NOT NULL UNIQUE CHECK (ticker ~ '^[A-Z0-9]{2,10}$'),
  name            text NOT NULL,
  tier            smallint NOT NULL CHECK (tier BETWEEN 1 AND 3),
  status          bloke_status NOT NULL DEFAULT 'shadow',
  opt_in          boolean NOT NULL DEFAULT false,       -- A12: event lists opt-in Blokes only
  claimed_wallet  bytea,
  claimed_at      timestamptz,
  listed_at       timestamptz NOT NULL,
  live_at         timestamptz,
  settle_b        integer, settle_h integer, settle_w integer  -- delist TWAP snapshot (A10c)
);

CREATE TABLE bloke_sources (
  bloke_id     integer NOT NULL REFERENCES blokes(id),
  kind         source_kind NOT NULL,
  external_id  text NOT NULL,                           -- stable numeric id, never the handle
  handle       text,
  enabled      boolean NOT NULL DEFAULT true,           -- A11: optional sources
  verified     boolean NOT NULL DEFAULT false,
  verified_at  timestamptz,
  PRIMARY KEY (bloke_id, kind, external_id)
);

CREATE TABLE linked_wallets (                           -- A7: wallets that may not trade the Bloke
  bloke_id  integer NOT NULL REFERENCES blokes(id),
  wallet    bytea NOT NULL,
  source    text NOT NULL CHECK (source IN ('claimed', 'deployer', 'identity', 'rotation')),
  PRIMARY KEY (bloke_id, wallet)
);

CREATE TABLE signal_events (
  id               bigserial PRIMARY KEY,
  bloke_id         integer NOT NULL REFERENCES blokes(id),
  source           source_kind NOT NULL,
  external_ref     text NOT NULL,                       -- post id, sha, release id, tx hash
  ts               timestamptz NOT NULL,
  value            double precision NOT NULL,
  quality          double precision,
  filtered_reason  text,                                -- null = counted
  raw_expires_at   timestamptz,                         -- raw text purged after 30 days (§17.4)
  UNIQUE (bloke_id, source, external_ref)
);
CREATE INDEX signal_events_bloke_ts ON signal_events (bloke_id, source, ts);

CREATE TABLE signal_hourly (                            -- published daily aggregates (§4.5)
  bloke_id  integer NOT NULL REFERENCES blokes(id),
  source    source_kind NOT NULL,
  hour      timestamptz NOT NULL,
  count     integer NOT NULL,
  value     double precision NOT NULL,
  excluded  boolean NOT NULL DEFAULT false,             -- brigade-guard exclusion
  PRIMARY KEY (bloke_id, source, hour)
);

CREATE TABLE baselines (
  bloke_id  integer NOT NULL REFERENCES blokes(id),
  source    source_kind NOT NULL,
  day       date NOT NULL,
  mu        double precision NOT NULL,
  sigma     double precision NOT NULL,
  n_days    smallint NOT NULL,
  PRIMARY KEY (bloke_id, source, day)
);

CREATE TABLE index_params (
  version   bytea PRIMARY KEY,                          -- paramsVersion hash
  params    jsonb NOT NULL,
  active_from timestamptz NOT NULL
);

CREATE TABLE index_ticks (
  ts              timestamptz NOT NULL,
  bloke_id        integer NOT NULL REFERENCES blokes(id),
  b integer NOT NULL, h integer NOT NULL, w integer NOT NULL,   -- raw worker values, scaled 1e4
  z               jsonb NOT NULL,
  degraded        source_kind[] NOT NULL DEFAULT '{}',
  stopped         boolean NOT NULL DEFAULT false,
  params_version  bytea NOT NULL REFERENCES index_params(version),
  push_seq        bigint,
  PRIMARY KEY (bloke_id, ts)
);

CREATE TABLE oracle_pushes (                            -- indexer: IndexPushed / IndexClamped
  seq             bigint PRIMARY KEY,
  ts_ms           bigint NOT NULL,
  params_version  bytea NOT NULL,
  entries         integer NOT NULL,
  tx_hash         bytea NOT NULL,
  block_number    bigint NOT NULL
);

CREATE TABLE oracle_values (                            -- applied values and lag flags per push
  seq        bigint NOT NULL REFERENCES oracle_pushes(seq),
  bloke_id   integer NOT NULL REFERENCES blokes(id),
  b integer NOT NULL, h integer NOT NULL, w integer NOT NULL,
  lag_flags  smallint NOT NULL DEFAULT 0,
  clamped    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (seq, bloke_id)
);

CREATE TABLE orders (
  id              numeric(78) PRIMARY KEY,
  owner           bytea NOT NULL,
  market_id       integer NOT NULL,
  side            smallint NOT NULL CHECK (side IN (-1, 1)),
  kind            text NOT NULL,                        -- open | close | spread
  collateral      numeric(78) NOT NULL,
  group_id        numeric(78),
  seq_at_request  bigint NOT NULL,
  status          order_status NOT NULL DEFAULT 'pending',
  reject_reason   text,                                 -- Slippage | NetCap | GlobalCap | FamilyCap | Lagging | Status | Stale
  requested_tx    bytea NOT NULL,
  final_tx        bytea,
  requested_at    timestamptz NOT NULL,
  final_at        timestamptz
);
CREATE INDEX orders_owner ON orders (owner, status);

CREATE TABLE lots (
  id             numeric(78) PRIMARY KEY,
  owner          bytea NOT NULL,
  market_id      integer NOT NULL,
  side           smallint NOT NULL,
  collateral     numeric(78) NOT NULL,
  units          numeric(78) NOT NULL,
  entry_price    numeric(78) NOT NULL,
  entry_index    integer NOT NULL,
  funding_entry  numeric(78) NOT NULL,
  group_id       numeric(78),
  status         lot_status NOT NULL DEFAULT 'open',
  opened_at      timestamptz NOT NULL,
  open_tx        bytea NOT NULL
);
CREATE INDEX lots_owner ON lots (owner, status);
CREATE INDEX lots_market_open ON lots (market_id) WHERE status = 'open';

CREATE TABLE closes (
  lot_id       numeric(78) PRIMARY KEY REFERENCES lots(id),
  exit_price   numeric(78) NOT NULL,
  price_pnl    numeric(78) NOT NULL,
  funding_pnl  numeric(78) NOT NULL,
  fee          numeric(78) NOT NULL,
  creator_fee  numeric(78) NOT NULL,
  payout       numeric(78) NOT NULL,
  closed_at    timestamptz NOT NULL,
  tx_hash      bytea NOT NULL
);

CREATE TABLE epochs (
  n              bigint PRIMARY KEY,
  g              numeric(78) NOT NULL,
  fee            numeric(78) NOT NULL,
  d_reserve      numeric(78) NOT NULL,
  d_treasury     numeric(78) NOT NULL,
  floor_accrual  numeric(78) NOT NULL,
  d_edge         numeric(78) NOT NULL,
  skin_absorbed  numeric(78) NOT NULL,
  impairment     numeric(78) NOT NULL,
  tx_hash        bytea NOT NULL,
  settled_at     timestamptz NOT NULL
);

CREATE TABLE deck_requests (
  id      bigserial PRIMARY KEY,
  wallet  bytea NOT NULL,
  deck    text NOT NULL CHECK (deck IN ('floor', 'edge')),
  kind    text NOT NULL CHECK (kind IN ('subscribe', 'deposit', 'redeem')),
  amount  numeric(78) NOT NULL,
  epoch   bigint,
  status  text NOT NULL
);

CREATE TABLE skin_events (
  id        bigserial PRIMARY KEY,
  bloke_id  integer NOT NULL REFERENCES blokes(id),
  amount    numeric(78) NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('post', 'withdraw_request', 'withdraw', 'absorb', 'locked')),
  epoch     bigint,
  tx_hash   bytea NOT NULL
);

CREATE TABLE creator_fees (
  id        bigserial PRIMARY KEY,
  bloke_id  integer NOT NULL REFERENCES blokes(id),
  amount    numeric(78) NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('credit', 'withdraw', 'graduation_seed')),
  tx_hash   bytea NOT NULL
);

CREATE TABLE identities (
  identity_hash      bytea PRIMARY KEY,                 -- keccak(provider || ':' || external_id)
  provider           text NOT NULL CHECK (provider IN ('github', 'x')),
  external_id        text NOT NULL,
  account_created_at timestamptz NOT NULL,
  followers          integer,
  qualifies          boolean NOT NULL,                  -- A8: GitHub ≥ 30 d or X ≥ 90 d with ≥ 10 followers
  wallets            bytea[] NOT NULL DEFAULT '{}',
  faucet_last_at     timestamptz,
  mon_dripped_at     timestamptz,                       -- A8: one gas drip per identity
  UNIQUE (provider, external_id)
);

CREATE TABLE rep_scores (
  season         integer NOT NULL,
  wallet         bytea NOT NULL,
  total          double precision NOT NULL,
  early          double precision NOT NULL,
  contrarian     double precision NOT NULL,
  backer         double precision NOT NULL,
  spotter        double precision NOT NULL,
  rules_version  bytea NOT NULL,
  computed_at    timestamptz NOT NULL,
  PRIMARY KEY (season, wallet, rules_version)
);

CREATE TABLE suggestions (
  normalized_handle  text PRIMARY KEY,
  first_wallet       bytea NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  status             text NOT NULL DEFAULT 'open'
);

CREATE TABLE abuse_flags (
  id          bigserial PRIMARY KEY,
  bloke_id    integer NOT NULL REFERENCES blokes(id),
  code        integer NOT NULL,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  cleared_at  timestamptz,
  notes       text
);

CREATE TABLE graduations (
  bloke_id      integer PRIMARY KEY REFERENCES blokes(id),
  token         bytea NOT NULL,
  pair          bytea NOT NULL,
  airdrop_root  bytea NOT NULL,
  backer_root   bytea NOT NULL,
  json_uri      text NOT NULL,
  tx_hash       bytea NOT NULL
);

CREATE TABLE indexer_cursor (                           -- resume from the last Finalized block
  chain_id      integer PRIMARY KEY,
  block_number  bigint NOT NULL,
  block_hash    bytea NOT NULL
);

COMMIT;
