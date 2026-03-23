-- Opening Lines table — stores first-seen Pinnacle odds per game
-- UPSERT with ON CONFLICT DO NOTHING preserves the true opening line
CREATE TABLE IF NOT EXISTS opening_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  game_id TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  game_date DATE NOT NULL,
  pinnacle_home_odds DECIMAL,
  pinnacle_away_odds DECIMAL,
  pinnacle_total DECIMAL,
  draftkings_home_odds DECIMAL,
  draftkings_away_odds DECIMAL,
  fanduel_home_odds DECIMAL,
  fanduel_away_odds DECIMAL,
  recorded_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_opening_lines_game_id ON opening_lines (game_id);
