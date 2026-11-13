-- Automatische bevestiging, voorstel van de app zelf, buurt + afstand

ALTER TABLE date_plans
  ADD COLUMN suggested      BOOLEAN       NOT NULL DEFAULT FALSE,     -- voorstel is door de app bedacht (geen overlap)
  ADD COLUMN suggest_count  INT           NOT NULL DEFAULT 0,         -- hoeveel app-voorstellen al gedaan
  ADD COLUMN rejected_slots TIMESTAMPTZ[] NOT NULL DEFAULT '{}';      -- tijden waar iemand "past niet" op zei

-- Bij automatische bevestiging klikt niemand op akkoord; dan zijn deze velden leeg.
ALTER TABLE date_confirmations ALTER COLUMN terms_version DROP NOT NULL;
ALTER TABLE date_confirmations ALTER COLUMN noshow_fee_cents DROP NOT NULL;
ALTER TABLE date_confirmations ALTER COLUMN terms_accepted_at DROP NOT NULL;

ALTER TABLE users
  ADD COLUMN neighborhood    TEXT,
  ADD COLUMN max_distance_km INT CHECK (max_distance_km IS NULL OR (max_distance_km BETWEEN 1 AND 50));

-- Buurten met een ongeveer-middelpunt (zelfde lijst als src/lib/neighborhoods.js)
CREATE TABLE neighborhoods (key TEXT PRIMARY KEY, name TEXT NOT NULL, lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL);
INSERT INTO neighborhoods (key, name, lat, lng) VALUES
  ('centrum', 'Centrum', 52.373, 4.893),
  ('jordaan', 'Jordaan', 52.3745, 4.88),
  ('de-pijp', 'De Pijp', 52.3547, 4.894),
  ('oud-zuid', 'Oud-Zuid', 52.353, 4.87),
  ('oost', 'Oost', 52.36, 4.925),
  ('indische-buurt', 'Indische Buurt', 52.364, 4.944),
  ('noord', 'Noord', 52.391, 4.93),
  ('nieuw-west', 'Nieuw-West', 52.366, 4.82),
  ('west', 'West', 52.377, 4.86),
  ('zuidoost', 'Zuidoost', 52.315, 4.974),
  ('zuid', 'Zuid / Buitenveldert', 52.33, 4.88),
  ('ijburg', 'IJburg', 52.355, 5.01);

CREATE FUNCTION neighborhood_km(a TEXT, b TEXT) RETURNS DOUBLE PRECISION AS $$
  SELECT 6371 * 2 * asin(sqrt(power(sin(radians(y.lat - x.lat) / 2), 2)
         + cos(radians(x.lat)) * cos(radians(y.lat)) * power(sin(radians(y.lng - x.lng) / 2), 2)))
    FROM neighborhoods x, neighborhoods y WHERE x.key = a AND y.key = b
$$ LANGUAGE sql STABLE;
