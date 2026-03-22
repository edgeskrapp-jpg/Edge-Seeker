-- EdgeSKR: pick_results table
-- Run this in the Supabase SQL editor to create the pick tracking table.

CREATE TABLE IF NOT EXISTS pick_results (
  id             UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL    DEFAULT now(),
  pick_date      DATE                     NOT NULL,
  game           TEXT                     NOT NULL,
  pick           TEXT                     NOT NULL,
  bet_type       TEXT                     NOT NULL,
  odds           TEXT,
  edge           TEXT,
  grade          TEXT,
  confidence     INTEGER,
  rank           INTEGER,
  reasoning      TEXT,
  result         TEXT                     NOT NULL    DEFAULT 'pending',
  opening_odds   TEXT,
  wallet         TEXT,
  agent          TEXT
);

-- Enforce valid result values
ALTER TABLE pick_results
  ADD CONSTRAINT pick_results_result_check
  CHECK (result IN ('pending', 'win', 'loss', 'push'));

-- Index for fast date-range queries and per-wallet lookups
CREATE INDEX IF NOT EXISTS idx_pick_results_pick_date ON pick_results (pick_date DESC);
CREATE INDEX IF NOT EXISTS idx_pick_results_wallet    ON pick_results (wallet);
CREATE INDEX IF NOT EXISTS idx_pick_results_agent     ON pick_results (agent);
CREATE INDEX IF NOT EXISTS idx_pick_results_result    ON pick_results (result);
