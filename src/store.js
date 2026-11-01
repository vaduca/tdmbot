// Armazenamento simples em JSON: pedaços, inventário, moedas, wishlist e perks de cada usuário.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import {
  PERKS,
  guessReward,
  outsideCompletionBonus,
  wishlistCompletionBonus,
  wishlistSlots,
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
  return u;
}

/**
 * Registra um acerto.
 * - Personagem na wishlist: ganha 1 pedaço; com todos os pedaços entra no inventário + bônus de 100% do valor.
 * - Fora da wishlist: cada acerto dá moedas; com todos os pedaços ganha bônus de 50% do valor (não vai pro inventário).
 */
export function recordCorrectGuess(userId, character, piecesToComplete) {
  const u = user(userId);
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

  u.coins += earned;
  save();
  return { inWishlist, pieces, completed, earned, balance: u.coins, copies: u.inventory[id] ?? 0 };
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
