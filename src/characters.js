// Busca personagens populares no AniList (API pública, sem chave) e guarda em cache local.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const CACHE_FILE = path.resolve('data', 'characters.json');
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

const QUERY = `
query ($page: Int) {
  Page(page: $page, perPage: 50) {
    characters(sort: FAVOURITES_DESC) {
      id
      name { full alternative }
      image { large }
      media(perPage: 1, sort: POPULARITY_DESC) {
        nodes { title { romaji english } }
      }
    }
  }
}`;

let pool = [];

// A lista vem ordenada por favoritos, então a posição é o rank (1 = mais favoritado)
const withRanks = (characters) => characters.map((c, i) => ({ ...c, rank: i + 1 }));

async function fetchPage(page) {
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { page } }),
  });
  if (!res.ok) throw new Error(`AniList respondeu ${res.status}`);
  const json = await res.json();
  return json.data.Page.characters;
}

export async function loadCharacters(poolSize) {
  try {
    const cached = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    if (Date.now() - cached.fetchedAt < CACHE_MAX_AGE_MS && cached.characters.length >= poolSize) {
      pool = withRanks(cached.characters.slice(0, poolSize));
      return pool;
    }
  } catch {
    // sem cache ainda
  }

  const pages = Math.ceil(poolSize / 50);
  const characters = [];
  for (let page = 1; page <= pages; page++) {
    const raw = await fetchPage(page);
    for (const c of raw) {
      if (!c.name?.full || !c.image?.large || c.image.large.includes('default')) continue;
      const media = c.media.nodes[0]?.title;
      characters.push({
        id: c.id,
        name: c.name.full,
        alternatives: (c.name.alternative ?? []).filter(Boolean),
        image: c.image.large,
        anime: media ? media.english || media.romaji : 'Desconhecido',
      });
    }
  }

  await mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), characters }, null, 2));
  pool = withRanks(characters.slice(0, poolSize));
  return pool;
}

export function allCharacters() {
  return pool;
}

// Busca para o autocomplete: nome ou anime contendo o texto digitado
export function searchCharacters(query, limit = 25) {
  const q = normalize(query);
  return pool
    .filter((c) => !q || normalize(`${c.name} ${c.anime}`).includes(q))
    .slice(0, limit);
}

export function randomCharacter() {
  return pool[Math.floor(Math.random() * pool.length)];
}

export function getCharacter(id) {
  return pool.find((c) => c.id === Number(id));
}

// Normaliza: minúsculas, sem acentos, sem pontuação, espaços únicos.
export function normalize(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Palavras do nome em ordem alfabética, ignorando iniciais soltas ("D." em "Monkey D. Luffy")
const nameKey = (s) =>
  normalize(s)
    .split(' ')
    .filter((w) => w.length > 1)
    .sort()
    .join(' ');

// Aceita o nome completo em qualquer ordem (ex.: "Luffy Monkey" ou "Monkey D. Luffy")
// e nomes alternativos do AniList com 2+ palavras — apelidos de uma palavra só não contam.
export function isCorrectGuess(character, guess) {
  const g = nameKey(guess);
  if (!g) return false;
  const alternatives = character.alternatives.filter((n) => nameKey(n).includes(' '));
  return [character.name, ...alternatives].some((n) => nameKey(n) === g);
}
