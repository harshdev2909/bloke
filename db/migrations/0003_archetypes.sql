-- Archetypes (packages/shared/src/archetypes.ts): set by the operator; null = derive from sources.

BEGIN;
ALTER TABLE blokes ADD COLUMN IF NOT EXISTS archetype text
  CHECK (archetype IN ('creator', 'builder', 'scholar', 'trader', 'founder', 'voice'));
CREATE INDEX IF NOT EXISTS blokes_archetype ON blokes (archetype);
COMMIT;
