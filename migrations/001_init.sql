-- Initial schema for the dating app.

CREATE TABLE users (
  id                         BIGSERIAL PRIMARY KEY,
  email                      TEXT NOT NULL,
  password_hash              TEXT NOT NULL,
  display_name               TEXT NOT NULL,
  birthdate                  DATE NOT NULL,
  bio                        TEXT NOT NULL DEFAULT '',
  gender                     TEXT CHECK (gender IN ('vrouw', 'man', 'non-binair')),
  pref_genders               TEXT[],            -- NULL = geen voorkeur (iedereen)
  pref_age_min               INT CHECK (pref_age_min IS NULL OR pref_age_min >= 18),
  pref_age_max               INT CHECK (pref_age_max IS NULL OR pref_age_max >= 18),
  role                       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status                     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  profile_hidden             BOOLEAN NOT NULL DEFAULT FALSE,   -- door beheer verborgen
  -- Liveness (gezichtscheck) via externe dienst. 'dev_bypass' is NOOIT een verificatie.
  liveness_status            TEXT NOT NULL DEFAULT 'not_started'
                             CHECK (liveness_status IN ('not_started', 'pending', 'passed', 'failed', 'dev_bypass')),
  liveness_provider          TEXT,
  liveness_reference         TEXT,
  liveness_checked_at        TIMESTAMPTZ,
  -- Leeftijdsverificatie via externe dienst. Een ingevulde geboortedatum is GEEN verificatie.
  age_verification_status    TEXT NOT NULL DEFAULT 'unverified'
                             CHECK (age_verification_status IN ('unverified', 'pending', 'verified', 'failed')),
  age_verification_provider  TEXT,
  age_verification_reference TEXT,
  age_verified_at            TIMESTAMPTZ,
  video_key                  TEXT,
  video_mime                 TEXT,
  video_size_bytes           BIGINT,
  video_uploaded_at          TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (pref_age_min IS NULL OR pref_age_max IS NULL OR pref_age_min <= pref_age_max)
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE password_reset_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session store used by connect-pg-simple
CREATE TABLE session (
  sid    VARCHAR NOT NULL PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX session_expire_idx ON session (expire);

CREATE TABLE swipes (
  id          BIGSERIAL PRIMARY KEY,
  swiper_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL CHECK (direction IN ('left', 'right')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (swiper_id, target_id),
  CHECK (swiper_id <> target_id)
);
CREATE INDEX swipes_target_idx ON swipes (target_id, direction);

CREATE TABLE matches (
  id          BIGSERIAL PRIMARY KEY,
  user_a      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_day   DATE NOT NULL,                -- kalenderdag in Europe/Amsterdam
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_a < user_b),
  UNIQUE (user_a, user_b)
);

CREATE TABLE blocks (
  blocker_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

-- Locaties worden uitsluitend door de beheerder ingevoerd. Er worden geen locaties meegeleverd.
CREATE TABLE venues (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('bar', 'restaurant')),
  street_address  TEXT NOT NULL,
  postcode        TEXT NOT NULL,
  city            TEXT NOT NULL DEFAULT 'Amsterdam',
  neighborhood    TEXT NOT NULL DEFAULT '',
  website         TEXT NOT NULL DEFAULT '',
  -- {"1":{"open":"17:00","close":"01:00"}, ...}; ISO-weekdag 1=maandag; ontbrekende dag = gesloten
  opening_hours   JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_note     TEXT NOT NULL DEFAULT '',   -- waar/wanneer de gegevens gecontroleerd zijn
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE date_plans (
  id                BIGSERIAL PRIMARY KEY,
  match_id          BIGINT NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE,
  day               DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'collecting' CHECK (status IN
                    ('collecting', 'no_overlap', 'proposed', 'confirmed', 'cancelled', 'ended_unsafe', 'expired')),
  round             INT NOT NULL DEFAULT 1,
  proposal_version  INT NOT NULL DEFAULT 0,
  proposed_start    TIMESTAMPTZ,
  venue_id          BIGINT REFERENCES venues(id),
  confirmed_at      TIMESTAMPTZ,
  closed_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  closed_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE time_choices (
  plan_id     BIGINT NOT NULL REFERENCES date_plans(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  round       INT NOT NULL,
  slot_start  TIMESTAMPTZ NOT NULL,
  rank        INT NOT NULL CHECK (rank >= 1),
  PRIMARY KEY (plan_id, user_id, round, slot_start),
  UNIQUE (plan_id, user_id, round, rank)
);

CREATE TABLE availability_submissions (
  plan_id       BIGINT NOT NULL REFERENCES date_plans(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  round         INT NOT NULL,
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, user_id, round)
);

-- Bevestiging hoort bij één specifieke versie van het voorstel (tijd + locatie).
CREATE TABLE date_confirmations (
  plan_id            BIGINT NOT NULL REFERENCES date_plans(id) ON DELETE CASCADE,
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposal_version   INT NOT NULL,
  confirmed_start    TIMESTAMPTZ NOT NULL,
  confirmed_venue_id BIGINT NOT NULL REFERENCES venues(id),
  terms_version      TEXT NOT NULL,
  noshow_fee_cents   INT NOT NULL,
  terms_accepted_at  TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, user_id, proposal_version)
);

CREATE TABLE date_events (
  id          BIGSERIAL PRIMARY KEY,
  plan_id     BIGINT NOT NULL REFERENCES date_plans(id) ON DELETE CASCADE,
  user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX date_events_plan_idx ON date_events (plan_id, created_at);

CREATE TABLE notifications (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  link          TEXT,
  email_status  TEXT NOT NULL DEFAULT 'skipped'
                CHECK (email_status IN ('skipped', 'not_configured', 'dev_logged', 'sent', 'failed')),
  email_error   TEXT,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE reports (
  id                BIGSERIAL PRIMARY KEY,
  reporter_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reported_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('profile', 'video', 'unsafe_date')),
  reason            TEXT NOT NULL,
  details           TEXT NOT NULL DEFAULT '',
  plan_id           BIGINT REFERENCES date_plans(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  action_taken      TEXT,
  admin_note        TEXT,
  handled_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  handled_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE noshow_reports (
  id                BIGSERIAL PRIMARY KEY,
  plan_id           BIGINT REFERENCES date_plans(id) ON DELETE SET NULL,
  reporter_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reported_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  -- kopie van de afspraak, zodat het dossier blijft bestaan
  scheduled_start   TIMESTAMPTZ NOT NULL,
  venue_name        TEXT NOT NULL,
  venue_address     TEXT NOT NULL,
  fee_cents         INT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'reported'
                    CHECK (status IN ('reported', 'disputed', 'upheld', 'rejected')),
  -- Er wordt pas geld geïnd na keuze betaalprovider en vastgestelde no-show-regels.
  payment_status    TEXT NOT NULL DEFAULT 'not_collected'
                    CHECK (payment_status IN ('not_collected', 'pending', 'paid', 'failed', 'waived')),
  payment_reference TEXT,
  dispute_text      TEXT,
  disputed_at       TIMESTAMPTZ,
  admin_note        TEXT,
  decided_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  decided_at        TIMESTAMPTZ,
  reported_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_id, reporter_id)
);
