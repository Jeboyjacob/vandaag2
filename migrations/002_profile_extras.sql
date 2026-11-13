-- Profielvragen, interesses en talen
ALTER TABLE users
  ADD COLUMN prompts   JSONB  NOT NULL DEFAULT '[]'::jsonb,   -- [{"key":"openingszin","answer":"..."}]
  ADD COLUMN interests TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN languages TEXT[] NOT NULL DEFAULT '{}';

-- Alleen bars en koffieplekken. Bestaande restaurants worden uit de lijst gehaald (niet fysiek verwijderd,
-- zodat oude afspraken verwijzingen houden).
UPDATE venues SET active = FALSE, deleted_at = COALESCE(deleted_at, now()) WHERE kind = 'restaurant';
ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_kind_check;
ALTER TABLE venues ADD CONSTRAINT venues_kind_check CHECK (kind IN ('bar', 'koffie')) NOT VALID;
