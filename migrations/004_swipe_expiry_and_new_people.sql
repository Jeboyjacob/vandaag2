-- Een ja blijft minstens N uur staan en 's avonds tot de volgende ochtend 10:00 (Amsterdamse tijd).
CREATE FUNCTION swipe_expires_at(created TIMESTAMPTZ, min_hours INT) RETURNS TIMESTAMPTZ AS $$
  SELECT GREATEST(
    created + make_interval(hours => min_hours),
    (date_trunc('day', created AT TIME ZONE 'Europe/Amsterdam') + interval '10 hours'
       + CASE WHEN (created AT TIME ZONE 'Europe/Amsterdam')::time >= time '10:00' THEN interval '1 day' ELSE interval '0' END
    ) AT TIME ZONE 'Europe/Amsterdam')
$$ LANGUAGE sql IMMUTABLE;

-- Wanneer iemand voor het laatst de melding "nieuwe mensen" kreeg (maximaal één per dag).
ALTER TABLE users ADD COLUMN last_new_people_notice_at TIMESTAMPTZ;
