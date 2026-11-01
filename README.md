# 🎴 Anime Card Bot

Bot de Discord em que um personagem de anime aparece num embed e os jogadores precisam digitar o **nome completo** no chat.
Cada acerto dá **1 pedaço** daquele personagem; com **4 pedaços** a carta entra no inventário.

Os personagens vêm do [AniList](https://anilist.co) (os mais favoritados), com imagem e anime de origem. A lista fica em cache em `data/characters.json` por 7 dias.

## Comandos

| Comando | O que faz |
|---|---|
| `/jogar` | Inicia uma rodada no canal (30s, com dica das iniciais na metade do tempo) |
| `/inventario [usuario]` | Mostra as cartas completas |
| `/progresso` | Mostra os pedaços que você está juntando (só você vê) |
| `/ranking` | Top 10 por cartas e acertos |

O palpite aceita o nome em qualquer ordem, sem acento/maiúsculas ("Luffy Monkey", "Monkey D. Luffy"). Só o primeiro nome não vale.

## Como configurar

1. Crie a aplicação em <https://discord.com/developers/applications> → **New Application**.
2. Aba **Bot**:
   - **Reset Token** e copie o token.
   - Ative **Message Content Intent** (obrigatório — o bot lê os palpites do chat).
3. Aba **OAuth2 → URL Generator**: marque `bot` e `applications.commands`; permissões `Send Messages`, `Embed Links`, `Read Message History`. Abra a URL gerada e adicione o bot ao seu servidor.
4. Copie `.env.example` para `.env` e preencha `DISCORD_TOKEN` e (recomendado) `GUILD_ID`
   (clique direito no servidor → Copiar ID; precisa do Modo Desenvolvedor ligado nas configurações do Discord).
5. Instale e rode (Node 18+):

```bash
npm install
```

```bash
npm start
```

## Configurações (`.env`)

- `CHARACTER_POOL_SIZE` — quantos personagens entram no jogo. Menos personagens = repetem mais = cartas completam mais rápido.
- `ROUND_SECONDS` — duração de cada rodada.
- `PIECES_TO_COMPLETE` — pedaços para completar uma carta (padrão 4).

## Estrutura

- `src/index.js` — comandos e lógica das rodadas
- `src/characters.js` — busca no AniList e checagem do nome
- `src/store.js` — pedaços e inventário salvos em `data/players.json`
