CREATE TABLE IF NOT EXISTS players (
  discord_id TEXT PRIMARY KEY,
  correct INTEGER NOT NULL DEFAULT 0 CHECK (correct >= 0),
  coins BIGINT NOT NULL DEFAULT 0 CHECK (coins >= 0),
  daily_last_claim_at BIGINT NOT NULL DEFAULT 0 CHECK (daily_last_claim_at >= 0),
  daily_streak SMALLINT NOT NULL DEFAULT 0 CHECK (daily_streak >= 0),
  mission_date DATE,
  mission_progress SMALLINT NOT NULL DEFAULT 0 CHECK (mission_progress >= 0),
  mission_completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS player_pieces (
  discord_id TEXT NOT NULL REFERENCES players(discord_id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  pieces INTEGER NOT NULL CHECK (pieces > 0),
  PRIMARY KEY (discord_id, character_id)
);

CREATE TABLE IF NOT EXISTS player_inventory (
  discord_id TEXT NOT NULL REFERENCES players(discord_id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  copies INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (discord_id, character_id)
);

-- Normaliza cópias antigas do mesmo dono; conflitos entre donos devem ser resolvidos antes da migração.
UPDATE player_inventory SET copies = 1 WHERE copies <> 1;
CREATE UNIQUE INDEX IF NOT EXISTS player_inventory_character_owner_idx ON player_inventory (character_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'player_inventory_single_copy'
      AND conrelid = 'player_inventory'::regclass
  ) THEN
    ALTER TABLE player_inventory
      ADD CONSTRAINT player_inventory_single_copy CHECK (copies = 1);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS player_wishlist (
  discord_id TEXT NOT NULL REFERENCES players(discord_id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (discord_id, character_id),
  UNIQUE (discord_id, position)
);

CREATE TABLE IF NOT EXISTS player_perks (
  discord_id TEXT NOT NULL REFERENCES players(discord_id) ON DELETE CASCADE,
  perk_id TEXT NOT NULL,
  level SMALLINT NOT NULL CHECK (level >= 0),
  PRIMARY KEY (discord_id, perk_id)
);
