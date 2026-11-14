-- Eerste-keer-uitleg: wanneer iemand de drie schermpjes heeft gezien.
ALTER TABLE users ADD COLUMN intro_seen_at TIMESTAMPTZ;
