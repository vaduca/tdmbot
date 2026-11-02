// Persistência PostgreSQL para moedas, coleção, wishlist, progresso e perks.
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import {
  PERKS,
  DAILY_REWARD,
  DAILY_MISSION,
  CARD_SELL_RATE,
  guessReward,
  outsideCompletionBonus,
  wishlistCompletionBonus,
  wishlistSlots,
  valueOf,
} from './economy.js';

const pool = new Pool(
  process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {},
);

export async function initializeStore() {
  const schema = await readFile(new URL('./database/schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
}

pool.on('error', (error) => {
  console.error('Erro inesperado na conexão com PostgreSQL:', error);
});

async function ensurePlayer(client, userId) {
  await client.query('INSERT INTO players (discord_id) VALUES ($1) ON CONFLICT (discord_id) DO NOTHING', [String(userId)]);
}

async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function lockPlayer(client, userId) {
  await ensurePlayer(client, userId);
  const { rows: [player] } = await client.query(
    `SELECT discord_id, correct, coins, daily_last_claim_at, daily_streak,
            to_char(mission_date, 'YYYY-MM-DD') AS mission_date,
            mission_progress, mission_completed
     FROM players WHERE discord_id = $1 FOR UPDATE`,
    [String(userId)],
  );
  return player;
}

export async function getDailyMission(userId, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  return transaction(async (client) => {
    await ensurePlayer(client, userId);
    const { rows: [player] } = await client.query(
      `SELECT to_char(mission_date, 'YYYY-MM-DD') AS mission_date,
              mission_progress, mission_completed
       FROM players WHERE discord_id = $1 FOR UPDATE`,
      [String(userId)],
    );
    if (player.mission_date !== today) {
      await client.query(
        `UPDATE players SET mission_date = $2, mission_progress = 0,
                            mission_completed = FALSE, updated_at = NOW()
         WHERE discord_id = $1`,
        [String(userId), today],
      );
      return { date: today, progress: 0, completed: false, target: DAILY_MISSION.target, reward: DAILY_MISSION.reward };
    }
    return {
      date: today,
      progress: player.mission_progress,
      completed: player.mission_completed,
      target: DAILY_MISSION.target,
      reward: DAILY_MISSION.reward,
    };
  });
}

export async function claimDailyReward(userId, now = Date.now()) {
  return transaction(async (client) => {
    const player = await lockPlayer(client, userId);
    const lastClaimAt = Number(player.daily_last_claim_at);
    const availableAt = lastClaimAt + DAILY_REWARD.cooldownMs;
    if (now < availableAt) return { ok: false, availableAt };

    const previousStreak = player.daily_streak;
    const streak = lastClaimAt && now - lastClaimAt <= DAILY_REWARD.streakWindowMs
      ? Math.min(previousStreak + 1, DAILY_REWARD.maxStreak)
      : 1;
    const reward = DAILY_REWARD.base + DAILY_REWARD.streakBonus * (streak - 1);
    const balance = Number(player.coins) + reward;
    await client.query(
      `UPDATE players SET daily_last_claim_at = $2, daily_streak = $3,
                          coins = coins + $4, updated_at = NOW()
       WHERE discord_id = $1`,
      [String(userId), now, streak, reward],
    );
    return { ok: true, reward, streak, balance, availableAt: now + DAILY_REWARD.cooldownMs };
  });
}

export async function sellCard(userId, character) {
  return transaction(async (client) => {
    const characterId = String(character.id);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [characterId]);
    const player = await lockPlayer(client, userId);
    const { rows: [card] } = await client.query(
      'SELECT copies FROM player_inventory WHERE discord_id = $1 AND character_id = $2 FOR UPDATE',
      [String(userId), characterId],
    );
    const copies = card?.copies ?? 0;
    if (copies === 0) return { ok: false, reason: 'not_owned' };
    const earned = Math.round(valueOf(character) * CARD_SELL_RATE);
    await client.query('DELETE FROM player_inventory WHERE discord_id = $1 AND character_id = $2', [String(userId), characterId]);
    await client.query('UPDATE players SET coins = coins + $2, updated_at = NOW() WHERE discord_id = $1', [String(userId), earned]);
    return { ok: true, earned, copies: 0, balance: Number(player.coins) + earned };
  });
}

export async function exchangeCards(userAId, characterA, userBId, characterB) {
  const idA = String(userAId);
  const idB = String(userBId);
  const characterAId = String(characterA.id);
  const characterBId = String(characterB.id);
  if (idA === idB) return { ok: false, reason: 'same_user' };
  if (characterAId === characterBId) return { ok: false, reason: 'same_character' };

  return transaction(async (client) => {
    for (const characterId of [characterAId, characterBId].sort()) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [characterId]);
    }
    const orderedIds = [idA, idB].sort();
    for (const id of orderedIds) await ensurePlayer(client, id);
    await client.query('SELECT discord_id FROM players WHERE discord_id = ANY($1::text[]) ORDER BY discord_id FOR UPDATE', [orderedIds]);

    const { rows } = await client.query(
      `SELECT discord_id, character_id, copies FROM player_inventory
       WHERE (discord_id = $1 AND character_id = $2)
          OR (discord_id = $3 AND character_id = $4)
       FOR UPDATE`,
      [idA, characterAId, idB, characterBId],
    );
    const copiesA = rows.find((row) => row.discord_id === idA && row.character_id === characterAId)?.copies ?? 0;
    const copiesB = rows.find((row) => row.discord_id === idB && row.character_id === characterBId)?.copies ?? 0;
    if (copiesA < 1 || copiesB < 1) return { ok: false, reason: 'card_unavailable' };

    for (const [ownerId, cardId] of [[idA, characterAId], [idB, characterBId]]) {
      await client.query('DELETE FROM player_inventory WHERE discord_id = $1 AND character_id = $2', [ownerId, cardId]);
    }
    await client.query(
      'INSERT INTO player_inventory (discord_id, character_id, copies) VALUES ($1, $2, 1)',
      [idA, characterBId],
    );
    await client.query(
      'INSERT INTO player_inventory (discord_id, character_id, copies) VALUES ($1, $2, 1)',
      [idB, characterAId],
    );
    return { ok: true };
  });
}

export async function recordCorrectGuess(userId, character, piecesToComplete) {
  return transaction(async (client) => {
    const id = String(userId);
    const characterId = String(character.id);
    // Serializa disputas pelo mesmo personagem, inclusive quando ainda não há linha de inventário.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [characterId]);
    const player = await lockPlayer(client, userId);
    const today = new Date().toISOString().slice(0, 10);
    const missionProgress = player.mission_date === today ? player.mission_progress : 0;
    const missionAlreadyCompleted = player.mission_date === today && player.mission_completed;

    const { rows: [owner] } = await client.query(
      'SELECT discord_id FROM player_inventory WHERE character_id = $1 FOR UPDATE',
      [characterId],
    );

    if (owner) {
      const progress = Math.min(missionProgress + 1, DAILY_MISSION.target);
      const missionReward = progress >= DAILY_MISSION.target && !missionAlreadyCompleted ? DAILY_MISSION.reward : 0;
      const missionCompleted = missionAlreadyCompleted || missionReward > 0;
      const earned = guessReward(character);
      const balance = Number(player.coins) + earned + missionReward;
      await client.query(
        `UPDATE players SET correct = correct + 1, coins = coins + $2,
                            mission_date = $3, mission_progress = $4,
                            mission_completed = $5, updated_at = NOW()
         WHERE discord_id = $1`,
        [id, earned + missionReward, today, progress, missionCompleted],
      );
      return {
        alreadyOwned: true,
        ownerId: owner.discord_id,
        inWishlist: false,
        pieces: 0,
        completed: false,
        earned,
        balance,
        copies: 0,
        mission: { progress, target: DAILY_MISSION.target, completed: missionCompleted, reward: missionReward },
      };
    }

    const { rowCount: wishlistCount } = await client.query(
      'SELECT 1 FROM player_wishlist WHERE discord_id = $1 AND character_id = $2',
      [id, characterId],
    );
    const inWishlist = wishlistCount > 0;
    const { rows: [pieceRow] } = await client.query(
      'SELECT pieces FROM player_pieces WHERE discord_id = $1 AND character_id = $2 FOR UPDATE',
      [id, characterId],
    );
    let pieces = (pieceRow?.pieces ?? 0) + 1;
    const completed = pieces >= piecesToComplete;
    let earned = inWishlist ? 0 : guessReward(character);

    if (completed) {
      pieces = piecesToComplete;
      await client.query('DELETE FROM player_pieces WHERE discord_id = $1 AND character_id = $2', [id, characterId]);
      if (inWishlist) {
        earned += wishlistCompletionBonus(character);
        await client.query(
          'INSERT INTO player_inventory (discord_id, character_id, copies) VALUES ($1, $2, 1)',
          [id, characterId],
        );
      } else {
        earned += outsideCompletionBonus(character);
      }
    } else {
      await client.query(
        `INSERT INTO player_pieces (discord_id, character_id, pieces) VALUES ($1, $2, $3)
         ON CONFLICT (discord_id, character_id) DO UPDATE SET pieces = EXCLUDED.pieces`,
        [id, characterId, pieces],
      );
    }

    const progress = Math.min(missionProgress + 1, DAILY_MISSION.target);
    const missionReward = progress >= DAILY_MISSION.target && !missionAlreadyCompleted ? DAILY_MISSION.reward : 0;
    const missionCompleted = missionAlreadyCompleted || missionReward > 0;
    const balance = Number(player.coins) + earned + missionReward;
    await client.query(
      `UPDATE players SET correct = correct + 1, coins = coins + $2,
                          mission_date = $3, mission_progress = $4,
                          mission_completed = $5, updated_at = NOW()
       WHERE discord_id = $1`,
      [id, earned + missionReward, today, progress, missionCompleted],
    );
    const { rows: [inventoryRow] } = await client.query(
      'SELECT copies FROM player_inventory WHERE discord_id = $1 AND character_id = $2',
      [id, characterId],
    );
    return {
      inWishlist,
      alreadyOwned: false,
      pieces,
      completed,
      earned,
      balance,
      copies: inventoryRow?.copies ?? 0,
      mission: { progress, target: DAILY_MISSION.target, completed: missionCompleted, reward: missionReward },
    };
  });
}

export async function addToWishlist(userId, characterId) {
  return transaction(async (client) => {
    await lockPlayer(client, userId);
    const id = String(userId);
    const character = String(characterId);
    const { rows } = await client.query(
      'SELECT character_id FROM player_wishlist WHERE discord_id = $1 ORDER BY position',
      [id],
    );
    if (rows.some((row) => row.character_id === character)) return { ok: false, reason: 'already' };
    const slots = wishlistSlots({ perks: await getPerks(client, id) });
    if (rows.length >= slots) return { ok: false, reason: 'full', slots };
    const { rows: [positionRow] } = await client.query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM player_wishlist WHERE discord_id = $1',
      [id],
    );
    await client.query(
      'INSERT INTO player_wishlist (discord_id, character_id, position) VALUES ($1, $2, $3)',
      [id, character, positionRow.position],
    );
    return { ok: true, used: rows.length + 1, slots };
  });
}

async function getPerks(client, userId) {
  const { rows } = await client.query('SELECT perk_id, level FROM player_perks WHERE discord_id = $1', [userId]);
  return Object.fromEntries(rows.map((row) => [row.perk_id, row.level]));
}

export async function removeFromWishlist(userId, characterId) {
  return transaction(async (client) => {
    await lockPlayer(client, userId);
    const { rowCount } = await client.query(
      'DELETE FROM player_wishlist WHERE discord_id = $1 AND character_id = $2',
      [String(userId), String(characterId)],
    );
    return rowCount > 0;
  });
}

export async function buyPerk(userId, perkId) {
  return transaction(async (client) => {
    const player = await lockPlayer(client, userId);
    const perk = PERKS[perkId];
    const perks = await getPerks(client, String(userId));
    const level = perks[perkId] ?? 0;
    if (level >= perk.maxLevel) return { ok: false, reason: 'max' };
    const cost = perk.cost(level + 1);
    const balance = Number(player.coins);
    if (balance < cost) return { ok: false, reason: 'coins', cost, balance };
    await client.query('UPDATE players SET coins = coins - $2, updated_at = NOW() WHERE discord_id = $1', [String(userId), cost]);
    await client.query(
      `INSERT INTO player_perks (discord_id, perk_id, level) VALUES ($1, $2, $3)
       ON CONFLICT (discord_id, perk_id) DO UPDATE SET level = EXCLUDED.level`,
      [String(userId), perkId, level + 1],
    );
    return { ok: true, level: level + 1, cost, balance: balance - cost };
  });
}

export async function wishlistIdsOf(userIds) {
  if (!userIds.length) return [];
  const { rows } = await pool.query(
    'SELECT character_id FROM player_wishlist WHERE discord_id = ANY($1::text[])',
    [userIds.map(String)],
  );
  return rows.map((row) => row.character_id);
}

export async function getUser(userId) {
  await ensurePlayer(pool, userId);
  const id = String(userId);
  const [playerResult, piecesResult, inventoryResult, wishlistResult, perksResult] = await Promise.all([
    pool.query(
      `SELECT correct, coins, daily_last_claim_at, daily_streak,
              to_char(mission_date, 'YYYY-MM-DD') AS mission_date,
              mission_progress, mission_completed
       FROM players WHERE discord_id = $1`,
      [id],
    ),
    pool.query('SELECT character_id, pieces FROM player_pieces WHERE discord_id = $1', [id]),
    pool.query('SELECT character_id, copies FROM player_inventory WHERE discord_id = $1', [id]),
    pool.query('SELECT character_id FROM player_wishlist WHERE discord_id = $1 ORDER BY position', [id]),
    pool.query('SELECT perk_id, level FROM player_perks WHERE discord_id = $1', [id]),
  ]);
  const player = playerResult.rows[0];
  return {
    pieces: Object.fromEntries(piecesResult.rows.map((row) => [row.character_id, row.pieces])),
    inventory: Object.fromEntries(inventoryResult.rows.map((row) => [row.character_id, row.copies])),
    correct: player.correct,
    coins: Number(player.coins),
    wishlist: wishlistResult.rows.map((row) => row.character_id),
    perks: Object.fromEntries(perksResult.rows.map((row) => [row.perk_id, row.level])),
    daily: { lastClaimAt: Number(player.daily_last_claim_at), streak: player.daily_streak },
    mission: { date: player.mission_date, progress: player.mission_progress, completed: player.mission_completed },
  };
}

export async function ranking(limit = 10) {
  const { rows } = await pool.query(
    `SELECT p.discord_id AS id, COALESCE(SUM(i.copies), 0)::int AS cards,
            p.coins, p.correct
     FROM players p LEFT JOIN player_inventory i ON i.discord_id = p.discord_id
     GROUP BY p.discord_id
     ORDER BY cards DESC, p.coins DESC, p.correct DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({ ...row, coins: Number(row.coins) }));
}

export async function characterOwnerCounts(characterIds) {
  if (!characterIds.length) return {};
  const { rows } = await pool.query(
    `SELECT character_id, COUNT(*)::int AS owners
     FROM player_inventory
     WHERE character_id = ANY($1::text[])
     GROUP BY character_id`,
    [characterIds.map(String)],
  );
  return Object.fromEntries(rows.map((row) => [row.character_id, row.owners]));
}
