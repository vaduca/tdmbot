// Regras da economia: raridade/valor por rank, recompensas e custo dos perks.

// Rank = posição no AniList por favoritos (1 = mais favoritado). Quanto melhor o rank, maior o valor.
export const RARITIES = [
  { maxRank: 10, name: 'Lendário', emoji: '🟨', value: 1000, drawWeight: 1 },
  { maxRank: 30, name: 'Épico', emoji: '🟪', value: 600, drawWeight: 2 },
  { maxRank: 60, name: 'Raro', emoji: '🟦', value: 300, drawWeight: 4 },
  { maxRank: 100, name: 'Incomum', emoji: '🟩', value: 150, drawWeight: 6 },
  { maxRank: Infinity, name: 'Comum', emoji: '⬜', value: 80, drawWeight: 8 },
];

export const COIN = '🪙';
export const coins = (n) => `${COIN} **${n.toLocaleString('pt-BR')}** TDM Coins`;

export const DAILY_REWARD = {
  base: 100,
  streakBonus: 25,
  maxStreak: 7,
  cooldownMs: 24 * 60 * 60 * 1000,
  streakWindowMs: 48 * 60 * 60 * 1000,
};

export function rarityOf(character) {
  return RARITIES.find((r) => character.rank <= r.maxRank);
}

export const drawWeightOf = (character) => rarityOf(character).drawWeight;

export const valueOf = (character) => rarityOf(character).value;

// Acerto fora da wishlist: 10% do valor por pedaço
export const guessReward = (character) => Math.round(valueOf(character) * 0.1);
// Completou os pedaços fora da wishlist: bônus de 50% do valor
export const outsideCompletionBonus = (character) => Math.round(valueOf(character) * 0.5);
// Completou um personagem da wishlist: bônus de 100% do valor
export const wishlistCompletionBonus = (character) => valueOf(character);

// Perks que podem ser comprados com TDM Coins
export const PERKS = {
  wishlist: {
    name: 'Wishlist',
    emoji: '⭐',
    description: 'Cada nível dá +1 vaga na wishlist (base 8, máximo 16).',
    baseSlots: 8,
    maxLevel: 8,
    // Nível 1 custa 300 e cada nível seguinte +150: 300, 450, 600 … 1350
    cost: (nextLevel) => 300 + 150 * (nextLevel - 1),
  },
};

export const wishlistSlots = (user) => PERKS.wishlist.baseSlots + (user.perks.wishlist ?? 0);
