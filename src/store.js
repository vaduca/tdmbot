// Armazenamento simples em JSON: pedaços em progresso e inventário de cada usuário.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';

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
  return (db.users[userId] ??= { pieces: {}, inventory: {}, correct: 0 });
}

/**
 * Dá 1 pedaço do personagem ao usuário.
 * Retorna { pieces, completed, copies } — completed=true quando a carta entrou no inventário.
 */
export function addPiece(userId, characterId, piecesToComplete) {
  const u = user(userId);
  u.correct++;
  const pieces = (u.pieces[characterId] ?? 0) + 1;

  if (pieces >= piecesToComplete) {
    delete u.pieces[characterId];
    u.inventory[characterId] = (u.inventory[characterId] ?? 0) + 1;
    save();
    return { pieces: piecesToComplete, completed: true, copies: u.inventory[characterId] };
  }

  u.pieces[characterId] = pieces;
  save();
  return { pieces, completed: false, copies: u.inventory[characterId] ?? 0 };
}

export function getUser(userId) {
  return user(userId);
}

export function ranking(limit = 10) {
  return Object.entries(db.users)
    .map(([id, u]) => ({
      id,
      cards: Object.values(u.inventory).reduce((a, b) => a + b, 0),
      correct: u.correct,
    }))
    .sort((a, b) => b.cards - a.cards || b.correct - a.correct)
    .slice(0, limit);
}
