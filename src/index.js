import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  Colors,
  MessageFlags,
} from 'discord.js';
import { loadCharacters, randomCharacter, getCharacter, isCorrectGuess } from './characters.js';
import { addPiece, getUser, ranking } from './store.js';

const {
  DISCORD_TOKEN,
  GUILD_ID,
  CHARACTER_POOL_SIZE = '150',
  ROUND_SECONDS = '30',
  PIECES_TO_COMPLETE = '4',
} = process.env;

const ROUND_MS = Number(ROUND_SECONDS) * 1000;
const PIECES = Number(PIECES_TO_COMPLETE);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // precisa estar ativado no Developer Portal
  ],
});

// Uma rodada por canal ao mesmo tempo
const activeRounds = new Set();

const commands = [
  new SlashCommandBuilder().setName('jogar').setDescription('Mostra um personagem: adivinhe o nome completo!'),
  new SlashCommandBuilder()
    .setName('inventario')
    .setDescription('Mostra as cartas completas no inventário')
    .addUserOption((o) => o.setName('usuario').setDescription('Ver o inventário de outra pessoa')),
  new SlashCommandBuilder().setName('progresso').setDescription('Mostra os pedaços de cartas que você está juntando'),
  new SlashCommandBuilder().setName('ranking').setDescription('Quem tem mais cartas no servidor'),
];

function pieceBar(pieces) {
  return '🟩'.repeat(pieces) + '⬜'.repeat(PIECES - pieces);
}

// Dica: iniciais de cada palavra, ex.: "Monkey D. Luffy" -> "M\_\_\_\_\_ D. L\_\_\_\_"
function initialsHint(name) {
  return name
    .split(' ')
    .map((w) => w[0] + w.slice(1).replace(/[^\s.\-']/g, '\\_'))
    .join('  ');
}

async function handlePlay(interaction) {
  const channelId = interaction.channelId;
  if (activeRounds.has(channelId)) {
    return interaction.reply({ content: '⏳ Já tem uma rodada rolando neste canal!', flags: MessageFlags.Ephemeral });
  }

  const character = randomCharacter();
  activeRounds.add(channelId);

  const embed = new EmbedBuilder()
    .setTitle('❓ Quem é este personagem?')
    .setDescription(`Digite o **nome completo** no chat!\nVocê tem **${ROUND_SECONDS}s**.`)
    .addFields({ name: '📺 Anime', value: character.anime })
    .setImage(character.image)
    .setColor(Colors.Blurple)
    .setFooter({ text: `Cada acerto vale 1 pedaço • ${PIECES} pedaços = carta no inventário` });

  await interaction.reply({ embeds: [embed] });

  const collector = interaction.channel.createMessageCollector({
    filter: (m) => !m.author.bot,
    time: ROUND_MS,
  });

  const hintTimer = setTimeout(() => {
    interaction.channel
      .send(`💡 **Dica:** ${initialsHint(character.name)}`)
      .catch(() => {});
  }, ROUND_MS / 2);

  collector.on('collect', async (message) => {
    if (!isCorrectGuess(character, message.content)) return;
    collector.stop('acerto');

    const result = addPiece(message.author.id, character.id, PIECES);
    const win = new EmbedBuilder()
      .setThumbnail(character.image)
      .setColor(result.completed ? Colors.Gold : Colors.Green);

    if (result.completed) {
      win
        .setTitle(`🎉 Carta completa: ${character.name}!`)
        .setDescription(
          `${message.author} juntou todos os pedaços e **${character.name}** entrou para o inventário!` +
            (result.copies > 1 ? `\nAgora você tem **${result.copies}** cópias.` : ''),
        )
        .addFields({ name: 'Pedaços', value: pieceBar(PIECES) });
    } else {
      win
        .setTitle(`✅ Acertou: ${character.name}`)
        .setDescription(`${message.author} ganhou 1 pedaço de **${character.name}**!`)
        .addFields({ name: 'Pedaços', value: `${pieceBar(result.pieces)} (${result.pieces}/${PIECES})` });
    }

    await message.reply({ embeds: [win] });
  });

  collector.on('end', async (_collected, reason) => {
    clearTimeout(hintTimer);
    activeRounds.delete(channelId);
    if (reason === 'acerto') return;

    const lose = new EmbedBuilder()
      .setTitle('⌛ Tempo esgotado!')
      .setDescription(`Era **${character.name}** (${character.anime}).`)
      .setThumbnail(character.image)
      .setColor(Colors.Red);
    await interaction.channel.send({ embeds: [lose] }).catch(() => {});
  });
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
  const entries = Object.entries(getUser(interaction.user.id).pieces);
  if (entries.length === 0) {
    return interaction.reply({ content: 'Nenhum pedaço em andamento. Use `/jogar`!', flags: MessageFlags.Ephemeral });
  }

  const lines = entries
    .sort((a, b) => b[1] - a[1])
    .map(([id, pieces]) => {
      const c = getCharacter(id);
      return `${pieceBar(pieces)} **${c?.name ?? `#${id}`}** (${pieces}/${PIECES})`;
    });

  const embed = new EmbedBuilder()
    .setTitle('🧩 Pedaços em andamento')
    .setDescription(lines.join('\n').slice(0, 4000))
    .setColor(Colors.Green);

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleRanking(interaction) {
  const top = ranking(10);
  if (top.length === 0) return interaction.reply('Ninguém jogou ainda!');

  const medals = ['🥇', '🥈', '🥉'];
  const lines = top.map(
    (r, i) => `${medals[i] ?? `**${i + 1}.**`} <@${r.id}> — ${r.cards} carta(s), ${r.correct} acerto(s)`,
  );

  await interaction.reply({
    embeds: [new EmbedBuilder().setTitle('🏆 Ranking').setDescription(lines.join('\n')).setColor(Colors.Gold)],
    allowedMentions: { users: [] },
  });
}

const handlers = {
  jogar: handlePlay,
  inventario: handleInventory,
  progresso: handleProgress,
  ranking: handleRanking,
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
