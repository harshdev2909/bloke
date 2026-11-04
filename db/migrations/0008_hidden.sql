-- Operator-hidden Blokes (test listings, abandoned demos): still on chain and still indexed, but
-- left out of the floor, raises and archetype counts.

BEGIN;
ALTER TABLE blokes ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
COMMIT;
