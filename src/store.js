// Armazenamento simples em JSON: pedaços, inventário, moedas, wishlist e perks de cada usuário.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import {
  PERKS,
  DAILY_REWARD,
  DAILY_MISSION,
  DUPLICATE_SELL_RATE,
  guessReward,
  outsideCompletionBonus,
  wishlistCompletionBonus,
  wishlistSlots,
  valueOf,
} from './economy.js';

const DB_FILE = path.resolve('data', 'players.json');

let db = { users: {} };
try {
  db = JSON.parse(readFileSync(DB_FILE, 'utf8'));
} catch {
  // primeiro uso
}

function save() {
  mkdirSync(path.dirname(DB_FILE), { recursive: true });
  // grava num arquivo temporário e renomeia, pra não corromper se o bot cair no meio
  writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2));
  renameSync(DB_FILE + '.tmp', DB_FILE);
}

function user(userId) {
  const u = (db.users[userId] ??= {});
  // preenche campos novos para jogadores antigos
  u.pieces ??= {};
  u.inventory ??= {};
  u.correct ??= 0;
  u.coins ??= 0;
  u.wishlist ??= [];
  u.perks ??= {};
  u.daily ??= { lastClaimAt: 0, streak: 0 };
  return u;
}

function dailyMission(u, now = Date.now()) {
  const date = new Date(now).toISOString().slice(0, 10);
  if (u.mission?.date !== date) {
    u.mission = { date, progress: 0, completed: false };
  }
  return u.mission;
}

export function getDailyMission(userId, now = Date.now()) {
  const u = user(userId);
  const mission = dailyMission(u, now);
  save();
  return { ...mission, target: DAILY_MISSION.target, reward: DAILY_MISSION.reward };
}

export function claimDailyReward(userId, now = Date.now()) {
  const u = user(userId);
  const { lastClaimAt, streak: previousStreak } = u.daily;
  const availableAt = lastClaimAt + DAILY_REWARD.cooldownMs;

  if (now < availableAt) return { ok: false, availableAt };

  const streak = lastClaimAt && now - lastClaimAt <= DAILY_REWARD.streakWindowMs
    ? Math.min(previousStreak + 1, DAILY_REWARD.maxStreak)
    : 1;
  const reward = DAILY_REWARD.base + DAILY_REWARD.streakBonus * (streak - 1);

  u.daily = { lastClaimAt: now, streak };
  u.coins += reward;
  save();
  return { ok: true, reward, streak, balance: u.coins, availableAt: now + DAILY_REWARD.cooldownMs };
}

export function sellDuplicateCard(userId, character) {
  const u = user(userId);
  const id = String(character.id);
  const copies = u.inventory[id] ?? 0;
  if (copies === 0) return { ok: false, reason: 'not_owned' };
  if (copies < 2) return { ok: false, reason: 'keep_last' };

  const earned = Math.round(valueOf(character) * DUPLICATE_SELL_RATE);
  u.inventory[id] = copies - 1;
  u.coins += earned;
  save();
  return { ok: true, earned, copies: u.inventory[id], balance: u.coins };
}

export function exchangeCards(userAId, characterA, userBId, characterB) {
  if (userAId === userBId) return { ok: false, reason: 'same_user' };
  if (String(characterA.id) === String(characterB.id)) return { ok: false, reason: 'same_character' };

  const userA = user(userAId);
  const userB = user(userBId);
  const characterAId = String(characterA.id);
  const characterBId = String(characterB.id);

  if (!(userA.inventory[characterAId] > 0) || !(userB.inventory[characterBId] > 0)) {
    return { ok: false, reason: 'card_unavailable' };
  }

  userA.inventory[characterAId]--;
  userB.inventory[characterBId]--;
  if (userA.inventory[characterAId] === 0) delete userA.inventory[characterAId];
  if (userB.inventory[characterBId] === 0) delete userB.inventory[characterBId];
  userA.inventory[characterBId] = (userA.inventory[characterBId] ?? 0) + 1;
  userB.inventory[characterAId] = (userB.inventory[characterAId] ?? 0) + 1;
  save();
  return { ok: true };
}

/**
 * Registra um acerto.
 * - Personagem na wishlist: ganha 1 pedaço; com todos os pedaços entra no inventário + bônus de 100% do valor.
 * - Fora da wishlist: cada acerto dá moedas; com todos os pedaços ganha bônus de 50% do valor (não vai pro inventário).
 */
export function recordCorrectGuess(userId, character, piecesToComplete) {
  const u = user(userId);
  const mission = dailyMission(u);
  const id = String(character.id);
  const inWishlist = u.wishlist.includes(id);
  u.correct++;

  let earned = inWishlist ? 0 : guessReward(character);
  let pieces = (u.pieces[id] ?? 0) + 1;
  const completed = pieces >= piecesToComplete;

  if (completed) {
    delete u.pieces[id];
    pieces = piecesToComplete;
    if (inWishlist) {
      u.inventory[id] = (u.inventory[id] ?? 0) + 1;
      earned += wishlistCompletionBonus(character);
    } else {
      earned += outsideCompletionBonus(character);
    }
  } else {
    u.pieces[id] = pieces;
  }

  mission.progress = Math.min(mission.progress + 1, DAILY_MISSION.target);
  let missionReward = 0;
  if (mission.progress >= DAILY_MISSION.target && !mission.completed) {
    mission.completed = true;
    missionReward = DAILY_MISSION.reward;
  }

  u.coins += earned + missionReward;
  save();
  return {
    inWishlist,
    pieces,
    completed,
    earned,
    balance: u.coins,
    copies: u.inventory[id] ?? 0,
    mission: {
      progress: mission.progress,
      target: DAILY_MISSION.target,
      completed: mission.completed,
      reward: missionReward,
    },
  };
}

export function addToWishlist(userId, characterId) {
  const u = user(userId);
  const id = String(characterId);
  if (u.wishlist.includes(id)) return { ok: false, reason: 'already' };
  if (u.wishlist.length >= wishlistSlots(u)) return { ok: false, reason: 'full', slots: wishlistSlots(u) };
  u.wishlist.push(id);
  save();
  return { ok: true, used: u.wishlist.length, slots: wishlistSlots(u) };
}

export function removeFromWishlist(userId, characterId) {
  const u = user(userId);
  const index = u.wishlist.indexOf(String(characterId));
  if (index === -1) return false;
  u.wishlist.splice(index, 1);
  save();
  return true;
}

export function buyPerk(userId, perkId) {
  const u = user(userId);
  const perk = PERKS[perkId];
  const level = u.perks[perkId] ?? 0;
  if (level >= perk.maxLevel) return { ok: false, reason: 'max' };
  const cost = perk.cost(level + 1);
  if (u.coins < cost) return { ok: false, reason: 'coins', cost, balance: u.coins };
  u.coins -= cost;
  u.perks[perkId] = level + 1;
  save();
  return { ok: true, level: level + 1, cost, balance: u.coins };
}

// Todos os IDs de personagens nas wishlists desses usuários (com repetição, se mais de um quiser o mesmo)
export function wishlistIdsOf(userIds) {
  return userIds.flatMap((id) => db.users[id]?.wishlist ?? []);
}

export function getUser(userId) {
  return user(userId);
}

export function ranking(limit = 10) {
  return Object.keys(db.users)
    .map((id) => {
      const u = user(id);
      return {
        id,
        cards: Object.values(u.inventory).reduce((a, b) => a + b, 0),
        coins: u.coins,
        correct: u.correct,
      };
    })
    .sort((a, b) => b.cards - a.cards || b.coins - a.coins || b.correct - a.correct)
    .slice(0, limit);
}
