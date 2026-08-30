-- Go Ranking Analysis schema (PostgreSQL). Applied on every startup; all statements are
-- idempotent, so this also doubles as the project's migration mechanism.

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  date        TEXT,                 -- ISO YYYY-MM-DD, NULL for the seeded Open rows
  source_hash TEXT UNIQUE,          -- sha256 of the uploaded file; NULL for seeded rows
  imported_at TEXT
);

-- Two always-present containers for individually-entered standalone games (future path).
-- Seeded with explicit ids; events.id has no DEFAULT (see importTournament.ts, which
-- computes the next free id itself instead of relying on a sequence).
INSERT INTO events (id, name) VALUES (1, 'Open (Ranked)'), (2, 'Open (Unranked)')
  ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS players (
  id              SERIAL PRIMARY KEY,
  display_name    TEXT NOT NULL,        -- first-seen "First Last"
  normalized_name TEXT NOT NULL UNIQUE  -- trimmed + internal whitespace collapsed + lowercased
);

CREATE TABLE IF NOT EXISTS event_players (
  id           SERIAL PRIMARY KEY,
  event_id     INTEGER NOT NULL REFERENCES events(id),
  player_id    INTEGER REFERENCES players(id),  -- always set by the importer; remappable later
  og_key       TEXT NOT NULL,                   -- key used to reference this player in <Game>
  first_name   TEXT,
  last_name    TEXT,
  display_name TEXT NOT NULL,                   -- raw "First Last" from the file
  rank         TEXT,
  club         TEXT,
  country      TEXT,
  egf_pin      TEXT,
  UNIQUE (event_id, og_key)
);

CREATE INDEX IF NOT EXISTS idx_event_players_player_id ON event_players(player_id);
CREATE INDEX IF NOT EXISTS idx_event_players_event_id ON event_players(event_id);

CREATE TABLE IF NOT EXISTS games (
  id                     SERIAL PRIMARY KEY,
  event_id               INTEGER NOT NULL REFERENCES events(id),
  round_number           INTEGER,
  white_event_player_id  INTEGER NOT NULL REFERENCES event_players(id),
  black_event_player_id  INTEGER REFERENCES event_players(id),   -- NULL for a bye
  winner_event_player_id INTEGER REFERENCES event_players(id),   -- white or black; NULL otherwise
  is_game                INTEGER NOT NULL,                       -- 0/1
  result_type            TEXT NOT NULL,                          -- game|draw|forfeit|both_win|both_lose|bye|no_result
  result_raw             TEXT,
  handicap               INTEGER
);

CREATE INDEX IF NOT EXISTS idx_games_white ON games(white_event_player_id);
CREATE INDEX IF NOT EXISTS idx_games_black ON games(black_event_player_id);
CREATE INDEX IF NOT EXISTS idx_games_winner ON games(winner_event_player_id);
CREATE INDEX IF NOT EXISTS idx_games_event ON games(event_id);
