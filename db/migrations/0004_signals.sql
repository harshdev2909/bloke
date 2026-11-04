-- P3 signal ingestion (amendment A16). The new enum value is not used elsewhere in this file:
-- Postgres allows ADD VALUE in a transaction but not using the value before it commits.
ALTER TYPE source_kind ADD VALUE IF NOT EXISTS 'hn' BEFORE 'commits';

-- Per (Bloke, source account) collector state: cursors, ETags, health. A source whose collector
-- hasn't succeeded recently is degraded in the index (PRD §4.4).
CREATE TABLE IF NOT EXISTS collector_state (
  bloke_id     integer NOT NULL REFERENCES blokes(id),
  source       source_kind NOT NULL,
  external_id  text NOT NULL,
  state        jsonb NOT NULL DEFAULT '{}',
  ok_at        timestamptz,
  error        text,
  error_at     timestamptz,
  PRIMARY KEY (bloke_id, source, external_id)
);
