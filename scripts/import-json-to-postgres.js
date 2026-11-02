import { readFile } from 'node:fs/promises';
import { applySchema, createDatabaseClient } from './lib/database.js';

const sourcePath = new URL('../data/players.json', import.meta.url);
const client = createDatabaseClient();

function nonNegativeInteger(value, label, fallback = 0) {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} precisa ser um número inteiro não negativo.`);
  }
  return parsed;
}

function entriesOfCounts(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} precisa ser um objeto.`);
  }
  return Object.entries(value).map(([id, count]) => {
    if (!id) throw new Error(`${label} contém um ID vazio.`);
    return [id, nonNegativeInteger(count, `${label}.${id}`)];
  }).filter(([, count]) => count > 0);
}

function validateSource(source) {
  if (!source || !source.users || typeof source.users !== 'object' || Array.isArray(source.users)) {
    throw new Error('O JSON precisa conter um objeto "users".');
  }

  const players = Object.entries(source.users).map(([discordId, rawUser]) => {
    if (!discordId || !rawUser || typeof rawUser !== 'object' || Array.isArray(rawUser)) {
      throw new Error(`Registro de usuário inválido: ${discordId || '(ID vazio)'}.`);
    }
    const wishlist = rawUser.wishlist ?? [];
    const perks = rawUser.perks ?? {};
    if (!Array.isArray(wishlist) || !perks || typeof perks !== 'object' || Array.isArray(perks)) {
      throw new Error(`Wishlist ou perks inválidos para ${discordId}.`);
    }
    const daily = rawUser.daily ?? {};
    const mission = rawUser.mission ?? {};
    const missionDate = mission.date ?? null;
    if (missionDate !== null && (typeof missionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(missionDate))) {
      throw new Error(`Data de missão inválida para ${discordId}.`);
    }

    return {
      discordId,
      correct: nonNegativeInteger(rawUser.correct, `${discordId}.correct`),
      coins: nonNegativeInteger(rawUser.coins, `${discordId}.coins`),
      dailyLastClaimAt: nonNegativeInteger(daily.lastClaimAt, `${discordId}.daily.lastClaimAt`),
      dailyStreak: nonNegativeInteger(daily.streak, `${discordId}.daily.streak`),
      missionDate,
      missionProgress: nonNegativeInteger(mission.progress, `${discordId}.mission.progress`),
      missionCompleted: Boolean(mission.completed),
      pieces: entriesOfCounts(rawUser.pieces ?? {}, `${discordId}.pieces`),
      inventory: entriesOfCounts(rawUser.inventory ?? {}, `${discordId}.inventory`).map(([id]) => [id, 1]),
      wishlist: wishlist.map((id) => {
        if (typeof id !== 'string' && typeof id !== 'number') {
          throw new Error(`ID inválido na wishlist de ${discordId}.`);
        }
        return String(id);
      }),
      perks: Object.entries(perks).map(([id, level]) => [id, nonNegativeInteger(level, `${discordId}.perks.${id}`)])
        .filter(([, level]) => level > 0),
    };
  });

  const owners = new Map();
  for (const player of players) {
    for (const [characterId] of player.inventory) {
      const characterOwners = owners.get(characterId) ?? new Set();
      characterOwners.add(player.discordId);
      owners.set(characterId, characterOwners);
    }
  }
  const conflicts = [...owners].filter(([, characterOwners]) => characterOwners.size > 1).map(([id]) => id);
  if (conflicts.length) {
    throw new Error(`Há personagem(ns) em mais de uma coleção (${conflicts.join(', ')}). Resolva os donos no JSON antes de importar.`);
  }

  return players;
}

async function importPlayer(player) {
  await client.query(
    `INSERT INTO players
      (discord_id, correct, coins, daily_last_claim_at, daily_streak,
       mission_date, mission_progress, mission_completed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      player.discordId,
      player.correct,
      player.coins,
      player.dailyLastClaimAt,
      player.dailyStreak,
      player.missionDate,
      player.missionProgress,
      player.missionCompleted,
    ],
  );

  for (const [characterId, pieces] of player.pieces) {
    await client.query('INSERT INTO player_pieces (discord_id, character_id, pieces) VALUES ($1, $2, $3)', [player.discordId, characterId, pieces]);
  }
  for (const [characterId, copies] of player.inventory) {
    await client.query('INSERT INTO player_inventory (discord_id, character_id, copies) VALUES ($1, $2, $3)', [player.discordId, characterId, copies]);
  }
  for (const [position, characterId] of player.wishlist.entries()) {
    await client.query('INSERT INTO player_wishlist (discord_id, character_id, position) VALUES ($1, $2, $3)', [player.discordId, characterId, position]);
  }
  for (const [perkId, level] of player.perks) {
    await client.query('INSERT INTO player_perks (discord_id, perk_id, level) VALUES ($1, $2, $3)', [player.discordId, perkId, level]);
  }
}

try {
  const contents = await readFile(sourcePath, 'utf8');
  const players = validateSource(JSON.parse(contents));
  await client.connect();
  await applySchema(client);
  await client.query('BEGIN');
  await client.query('LOCK TABLE players IN ACCESS EXCLUSIVE MODE');
  const { rows: [{ count }] } = await client.query('SELECT COUNT(*)::int AS count FROM players');
  if (count !== 0) {
    throw new Error('O banco já contém jogadores. A importação foi cancelada para não sobrescrever dados.');
  }
  for (const player of players) await importPlayer(player);
  await client.query('COMMIT');
  console.log(`Importação concluída: ${players.length} jogador(es).`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Importação cancelada:', error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
