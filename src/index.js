import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  Colors,
  MessageFlags,
} from 'discord.js';
import {
  loadCharacters,
  allCharacters,
  getCharacter,
  isCorrectGuess,
  searchCharacters,
} from './characters.js';
import {
  recordCorrectGuess,
  getUser,
  ranking,
  addToWishlist,
  removeFromWishlist,
  buyPerk,
  wishlistIdsOf,
} from './store.js';
import {
  PERKS,
  rarityOf,
  drawWeightOf,
  valueOf,
  coins,
  wishlistSlots,
} from './economy.js';

const {
  DISCORD_TOKEN,
  GUILD_ID,
  CHARACTER_POOL_SIZE = '300',
  ROUND_SECONDS = '30',
  PIECES_TO_COMPLETE = '4',
  WISHLIST_BOOST = '0.35',
} = process.env;

const ROUND_MS = Number(ROUND_SECONDS) * 1000;
const PIECES = Number(PIECES_TO_COMPLETE);
const RECENT_PLAYER_MS = 30 * 60 * 1000;
const DEFAULT_ROUNDS = 3;
const MAX_ROUNDS = 5;
const RECENT_CHARACTER_LIMIT = 10;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // precisa estar ativado no Developer Portal
  ],
});

// Uma rodada por canal ao mesmo tempo
const activeRounds = new Set();

// Quem jogou recentemente em cada canal: channelId -> Map(userId -> último horário)
const recentPlayers = new Map();
// IDs dos personagens sorteados recentemente em cada canal.
const recentCharacters = new Map();

function markPlayer(channelId, userId) {
  if (!recentPlayers.has(channelId)) recentPlayers.set(channelId, new Map());
  recentPlayers.get(channelId).set(userId, Date.now());
}

function activePlayers(channelId) {
  const players = recentPlayers.get(channelId);
  if (!players) return [];
  for (const [id, time] of players) if (Date.now() - time > RECENT_PLAYER_MS) players.delete(id);
  return [...players.keys()];
}

// Com chance WISHLIST_BOOST, sorteia alguém das wishlists de quem jogou neste canal nos últimos 30 min.
// Quanto mais jogadores querem o mesmo personagem, maior a chance dele.
function drawCharacter(channelId) {
  const pool = allCharacters();
  if (!pool.length) throw new Error('Não há personagens carregados para sortear.');

  let history = recentCharacters.get(channelId) ?? [];
  let available = pool.filter((character) => !history.includes(String(character.id)));

  // Quando o pool for menor que o histórico, inicia um novo ciclo sem bloquear o jogo.
  if (!available.length) {
    history = [];
    available = pool;
  }

  const availableIds = new Set(available.map((character) => String(character.id)));
  if (Math.random() < Number(WISHLIST_BOOST)) {
    const wanted = wishlistIdsOf(activePlayers(channelId))
      .filter((id) => availableIds.has(String(id)))
      .map(getCharacter)
      .filter(Boolean);
    if (wanted.length) {
      const character = weightedCharacter(wanted);
      rememberCharacter(channelId, history, character);
      return character;
    }
  }

  const character = weightedCharacter(available);
  rememberCharacter(channelId, history, character);
  return character;
}

function weightedCharacter(characters) {
  const totalWeight = characters.reduce((total, character) => total + drawWeightOf(character), 0);
  let choice = Math.random() * totalWeight;

  for (const character of characters) {
    choice -= drawWeightOf(character);
    if (choice < 0) return character;
  }

  return characters[characters.length - 1];
}

function rememberCharacter(channelId, history, character) {
  history.push(String(character.id));
  recentCharacters.set(channelId, history.slice(-RECENT_CHARACTER_LIMIT));
}

const commands = [
  new SlashCommandBuilder()
    .setName('jogar')
    .setDescription('Inicia uma sequência de rodadas: adivinhe os personagens!')
    .addIntegerOption((o) =>
      o
        .setName('quantidade')
        .setDescription(`Número de rodadas (padrão ${DEFAULT_ROUNDS}, máximo ${MAX_ROUNDS})`)
        .setMinValue(1)
        .setMaxValue(MAX_ROUNDS),
    ),
  new SlashCommandBuilder()
    .setName('inventario')
    .setDescription('Mostra as cartas completas no inventário')
    .addUserOption((o) => o.setName('usuario').setDescription('Ver o inventário de outra pessoa')),
  new SlashCommandBuilder().setName('progresso').setDescription('Mostra os pedaços de cartas que você está juntando'),
  new SlashCommandBuilder().setName('ranking').setDescription('Quem tem mais cartas no servidor'),
  new SlashCommandBuilder()
    .setName('saldo')
    .setDescription('Mostra suas TDM Coins')
    .addUserOption((o) => o.setName('usuario').setDescription('Ver o saldo de outra pessoa')),
  new SlashCommandBuilder()
    .setName('wishlist')
    .setDescription('Só personagens da wishlist entram no inventário')
    .addSubcommand((s) =>
      s
        .setName('ver')
        .setDescription('Mostra a wishlist')
        .addUserOption((o) => o.setName('usuario').setDescription('Ver a wishlist de outra pessoa')),
    )
    .addSubcommand((s) =>
      s
        .setName('adicionar')
        .setDescription('Adiciona um personagem à sua wishlist')
        .addStringOption((o) =>
          o.setName('personagem').setDescription('Nome do personagem').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('remover')
        .setDescription('Remove um personagem da sua wishlist')
        .addStringOption((o) =>
          o.setName('personagem').setDescription('Nome do personagem').setRequired(true).setAutocomplete(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName('perks')
    .setDescription('Melhorias compradas com TDM Coins')
    .addSubcommand((s) => s.setName('ver').setDescription('Mostra os perks e quanto custa o próximo nível'))
    .addSubcommand((s) =>
      s
        .setName('comprar')
        .setDescription('Compra o próximo nível de um perk')
        .addStringOption((o) =>
          o
            .setName('perk')
            .setDescription('Qual perk')
            .setRequired(true)
            .addChoices(...Object.entries(PERKS).map(([id, p]) => ({ name: p.name, value: id }))),
        ),
    ),
];

function pieceBar(pieces) {
  return '🟩'.repeat(pieces) + '⬜'.repeat(PIECES - pieces);
}

const rarityLabel = (c) => {
  const r = rarityOf(c);
  return `${r.emoji} ${r.name} • #${c.rank} • ${valueOf(c)} 🪙`;
};

// Dica: iniciais de cada palavra, ex.: "Monkey D. Luffy" -> "M\_\_\_\_\_ D. L\_\_\_\_"
function initialsHint(name) {
  return name
    .split(' ')
    .map((w) => w[0] + w.slice(1).replace(/[^\s.\-']/g, '\\_'))
    .join('  ');
}

function playRound(interaction, character) {
  const channelId = interaction.channelId;

  const embed = new EmbedBuilder()
    .setTitle('❓ Quem é este personagem?')
    .setDescription(`Digite o **nome completo** no chat!\nVocê tem **${ROUND_SECONDS}s**.`)
    .addFields({ name: '📺 Anime', value: character.anime })
    .setImage(character.image)
    .setColor(Colors.Blurple)
    .setFooter({ text: `⭐ Na sua wishlist: ${PIECES} pedaços = carta • Fora dela: cada acerto vira TDM Coins` });

  return interaction.channel.send({ embeds: [embed] }).then(() => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hintTimer);
      resolve(result);
    };

    const collector = interaction.channel.createMessageCollector({ filter: (m) => !m.author.bot, time: ROUND_MS });
    const hintTimer = setTimeout(() => {
      interaction.channel.send(`💡 **Dica:** ${initialsHint(character.name)}`).catch(() => {});
    }, ROUND_MS / 2);

    collector.on('collect', async (message) => {
      markPlayer(channelId, message.author.id); // quem chuta conta como jogador ativo
      if (!isCorrectGuess(character, message.content)) return;
      collector.stop('acerto');

      try {
        const result = recordCorrectGuess(message.author.id, character, PIECES);
        const win = new EmbedBuilder()
          .setThumbnail(character.image)
          .setColor(result.completed ? Colors.Gold : result.inWishlist ? Colors.Green : Colors.Yellow);

        if (result.completed && result.inWishlist) {
          win
            .setTitle(`🎉 Carta completa: ${character.name}!`)
            .setDescription(
              `${message.author} juntou todos os pedaços e **${character.name}** entrou para o inventário!` +
                (result.copies > 1 ? `\nAgora você tem **${result.copies}** cópias.` : '') +
                `\nBônus da wishlist (100%): ${coins(result.earned)}`,
            );
        } else if (result.completed) {
          win
            .setTitle(`💰 Pedaços completos: ${character.name}`)
            .setDescription(
              `${message.author} juntou todos os pedaços, mas **${character.name}** não está na wishlist.\n` +
                `Acerto + bônus de 50%: ${coins(result.earned)}`,
            );
        } else if (result.inWishlist) {
          win
            .setTitle(`⭐ Acertou: ${character.name}`)
            .setDescription(`${message.author} ganhou 1 pedaço de **${character.name}** (está na sua wishlist)!`);
        } else {
          win
            .setTitle(`✅ Acertou: ${character.name}`)
            .setDescription(
              `${message.author} ganhou ${coins(result.earned)}.\n` +
                `Adicione com \`/wishlist adicionar\` para os pedaços virarem carta.`,
            );
        }

        win.addFields(
          { name: 'Pedaços', value: `${pieceBar(result.pieces)} (${result.pieces}/${PIECES})`, inline: true },
          { name: 'Raridade', value: rarityLabel(character), inline: true },
        );
        win.setFooter({ text: `Saldo: ${result.balance.toLocaleString('pt-BR')} TDM Coins` });
        await message.reply({ embeds: [win] });
      } catch (error) {
        reject(error);
      }
    });

    collector.on('end', async (_collected, reason) => {
      if (reason === 'acerto') return finish('acerto');
      try {
        const lose = new EmbedBuilder()
          .setTitle('⌛ Tempo esgotado!')
          .setDescription(`Era **${character.name}** (${character.anime}).`)
          .setThumbnail(character.image)
          .setColor(Colors.Red);
        await interaction.channel.send({ embeds: [lose] });
        finish('tempo');
      } catch (error) {
        reject(error);
      }
    });
  }));
}

async function handlePlay(interaction) {
  const channelId = interaction.channelId;
  if (activeRounds.has(channelId)) {
    return interaction.reply({ content: '⏳ Já tem uma sessão de jogo rolando neste canal!', flags: MessageFlags.Ephemeral });
  }

  const rounds = interaction.options.getInteger('quantidade') ?? DEFAULT_ROUNDS;
  activeRounds.add(channelId);
  markPlayer(channelId, interaction.user.id);

  try {
    await interaction.reply({
      content: `🎮 ${interaction.user}, começando **${rounds} rodada(s)**. A próxima começa quando a atual terminar.`,
    });
    for (let i = 0; i < rounds; i++) {
      const character = drawCharacter(channelId);
      await playRound(interaction, character);
    }
    await interaction.channel.send(`🏁 Sessão concluída! Foram iniciadas **${rounds} rodada(s)**.`);
  } finally {
    activeRounds.delete(channelId);
  }
}

async function handleInventory(interaction) {
  const target = interaction.options.getUser('usuario') ?? interaction.user;
  const entries = Object.entries(getUser(target.id).inventory);

  if (entries.length === 0) {
    return interaction.reply({
      content: `${target.id === interaction.user.id ? 'Você ainda não tem' : `${target.username} ainda não tem`} nenhuma carta. Use \`/jogar\`!`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const lines = entries.map(([id, copies]) => {
    const c = getCharacter(id);
    const name = c ? `**${c.name}** — ${c.anime}` : `Personagem #${id}`;
    return `🃏 ${name}${copies > 1 ? ` (x${copies})` : ''}`;
  });

  let description = lines.join('\n');
  if (description.length > 4000) description = description.slice(0, 4000) + '\n…';

  const embed = new EmbedBuilder()
    .setTitle(`🎴 Inventário de ${target.username}`)
    .setDescription(description)
    .setColor(Colors.Gold)
    .setFooter({ text: `${entries.length} personagem(ns) diferentes` });

  // Mostra a imagem da primeira carta como capa
  const first = getCharacter(entries[0][0]);
  if (first) embed.setThumbnail(first.image);

  await interaction.reply({ embeds: [embed] });
}

async function handleProgress(interaction) {
  const u = getUser(interaction.user.id);
  const entries = Object.entries(u.pieces);
  if (entries.length === 0) {
    return interaction.reply({ content: 'Nenhum pedaço em andamento. Use `/jogar`!', flags: MessageFlags.Ephemeral });
  }

  const lines = entries
    .sort((a, b) => b[1] - a[1])
    .map(([id, pieces]) => {
      const c = getCharacter(id);
      const star = u.wishlist.includes(id) ? '⭐ ' : '';
      return `${pieceBar(pieces)} ${star}**${c?.name ?? `#${id}`}** (${pieces}/${PIECES})`;
    });

  const embed = new EmbedBuilder()
    .setTitle('🧩 Pedaços em andamento')
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: '⭐ = na wishlist (vira carta). Sem ⭐ = vira TDM Coins.' })
    .setColor(Colors.Green);

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleRanking(interaction) {
  const top = ranking(10);
  if (top.length === 0) return interaction.reply('Ninguém jogou ainda!');

  const medals = ['🥇', '🥈', '🥉'];
  const lines = top.map(
    (r, i) =>
      `${medals[i] ?? `**${i + 1}.**`} <@${r.id}> — ${r.cards} carta(s), ` +
      `${r.coins.toLocaleString('pt-BR')} 🪙, ${r.correct} acerto(s)`,
  );

  await interaction.reply({
    embeds: [new EmbedBuilder().setTitle('🏆 Ranking').setDescription(lines.join('\n')).setColor(Colors.Gold)],
    allowedMentions: { users: [] },
  });
}

async function handleBalance(interaction) {
  const target = interaction.options.getUser('usuario') ?? interaction.user;
  const u = getUser(target.id);
  const embed = new EmbedBuilder()
    .setTitle(`🪙 Saldo de ${target.username}`)
    .setDescription(coins(u.coins))
    .addFields({ name: '⭐ Wishlist', value: `${u.wishlist.length}/${wishlistSlots(u)} vagas`, inline: true })
    .setColor(Colors.Yellow);
  await interaction.reply({ embeds: [embed] });
}

async function handleWishlist(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'ver') {
    const target = interaction.options.getUser('usuario') ?? interaction.user;
    const u = getUser(target.id);
    const slots = wishlistSlots(u);
    const lines = u.wishlist.map((id, i) => {
      const c = getCharacter(id);
      if (!c) return `${i + 1}. Personagem #${id} (fora do jogo atual)`;
      const pieces = u.pieces[id] ?? 0;
      return `${i + 1}. **${c.name}** — ${c.anime}\n   ${rarityLabel(c)} • ${pieceBar(pieces)}`;
    });
    for (let i = u.wishlist.length; i < slots; i++) lines.push(`${i + 1}. *vaga livre*`);

    const embed = new EmbedBuilder()
      .setTitle(`⭐ Wishlist de ${target.username} (${u.wishlist.length}/${slots})`)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: 'Mais vagas: /perks comprar Wishlist' })
      .setColor(Colors.Yellow);
    return interaction.reply({ embeds: [embed] });
  }

  const character = getCharacter(interaction.options.getString('personagem'));
  if (!character) {
    return interaction.reply({
      content: '❌ Personagem não encontrado. Escolha um nome da lista que aparece enquanto você digita.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'adicionar') {
    const result = addToWishlist(interaction.user.id, character.id);
    if (!result.ok) {
      const content =
        result.reason === 'already'
          ? `**${character.name}** já está na sua wishlist.`
          : `❌ Sua wishlist está cheia (${result.slots} vagas). Remova alguém ou compre vagas com \`/perks comprar\`.`;
      return interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
    const embed = new EmbedBuilder()
      .setTitle(`⭐ ${character.name} entrou na wishlist`)
      .setDescription(`${character.anime}\n${rarityLabel(character)}`)
      .setThumbnail(character.image)
      .setFooter({ text: `${result.used}/${result.slots} vagas usadas` })
      .setColor(Colors.Yellow);
    return interaction.reply({ embeds: [embed] });
  }

  // remover
  const removed = removeFromWishlist(interaction.user.id, character.id);
  return interaction.reply({
    content: removed
      ? `🗑️ **${character.name}** saiu da sua wishlist. Os pedaços que você já tem continuam guardados.`
      : `**${character.name}** não está na sua wishlist.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handlePerks(interaction) {
  const sub = interaction.options.getSubcommand();
  const u = getUser(interaction.user.id);

  if (sub === 'ver') {
    const fields = Object.entries(PERKS).map(([id, perk]) => {
      const level = u.perks[id] ?? 0;
      const next =
        level >= perk.maxLevel ? '✅ Nível máximo' : `Próximo nível: ${perk.cost(level + 1).toLocaleString('pt-BR')} 🪙`;
      return {
        name: `${perk.emoji} ${perk.name} — nível ${level}/${perk.maxLevel}`,
        value: `${perk.description}\n${next}`,
      };
    });
    const embed = new EmbedBuilder()
      .setTitle('🛒 Perks')
      .setDescription(`Seu saldo: ${coins(u.coins)}`)
      .addFields(fields)
      .setColor(Colors.Purple);
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  // comprar
  const perkId = interaction.options.getString('perk');
  const perk = PERKS[perkId];
  const result = buyPerk(interaction.user.id, perkId);
  if (!result.ok) {
    const content =
      result.reason === 'max'
        ? `${perk.emoji} **${perk.name}** já está no nível máximo.`
        : `❌ Faltam TDM Coins: o próximo nível custa **${result.cost.toLocaleString('pt-BR')}** 🪙 e você tem **${result.balance.toLocaleString('pt-BR')}**.`;
    return interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }

  const extra = perkId === 'wishlist' ? `\nSua wishlist agora tem **${wishlistSlots(getUser(interaction.user.id))}** vagas.` : '';
  return interaction.reply(
    `${perk.emoji} ${interaction.user} comprou **${perk.name} nível ${result.level}** por ${coins(result.cost)}!${extra}`,
  );
}

// Sugestões enquanto o usuário digita o nome do personagem
async function handleAutocomplete(interaction) {
  const typed = interaction.options.getFocused();
  const sub = interaction.options.getSubcommand(false);
  let options = searchCharacters(typed);
  if (sub === 'remover') {
    const wishlist = getUser(interaction.user.id).wishlist;
    options = wishlist.map(getCharacter).filter((c) => c && options.includes(c));
  }
  await interaction.respond(
    options.slice(0, 25).map((c) => ({
      name: `${c.name} (${c.anime}) — ${rarityOf(c).name}`.slice(0, 100),
      value: String(c.id),
    })),
  );
}

const handlers = {
  jogar: handlePlay,
  inventario: handleInventory,
  progresso: handleProgress,
  ranking: handleRanking,
  saldo: handleBalance,
  wishlist: handleWishlist,
  perks: handlePerks,
};

const commandBody = commands.map((c) => c.toJSON());
const guildId = GUILD_ID?.trim();

client.once('clientReady', async () => {
  if (guildId) {
    const guild = client.guilds.cache.get(guildId);
    if (guild) await guild.commands.set(commandBody);
    else console.warn('⚠️ O bot ainda não está no servidor do GUILD_ID. Use o link de convite.');
  } else {
    await client.application.commands.set(commandBody);
  }
  console.log(`✅ Logado como ${client.user.tag}`);
});

// Registra os comandos na hora em que o bot é convidado para o servidor
client.on('guildCreate', async (guild) => {
  if (guild.id !== guildId) return;
  await guild.commands.set(commandBody);
  console.log(`✅ Comandos registrados em ${guild.name}`);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isAutocomplete()) {
    return handleAutocomplete(interaction).catch((err) => console.error(err));
  }
  if (!interaction.isChatInputCommand()) return;
  const handler = handlers[interaction.commandName];
  if (!handler) return;
  try {
    await handler(interaction);
  } catch (err) {
    console.error(err);
    const msg = { content: '❌ Deu algum erro ao executar o comando.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

console.log('Carregando personagens do AniList...');
const pool = await loadCharacters(Number(CHARACTER_POOL_SIZE));
console.log(`${pool.length} personagens carregados.`);
await client.login(DISCORD_TOKEN);
