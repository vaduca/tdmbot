# 🎴 Anime Card Bot

Bot de Discord em que um personagem de anime aparece num embed e os jogadores precisam digitar o **nome completo** no chat.
Cada acerto dá **1 pedaço** daquele personagem; com **4 pedaços** a carta entra no inventário.

Os personagens vêm do [AniList](https://anilist.co) (os mais favoritados), com imagem e anime de origem. A lista fica em cache em `data/characters.json` por 7 dias.

## Comandos

| Comando | O que faz |
|---|---|
| `/jogar [quantidade]` | Inicia uma sequência de 1 a 5 rodadas (padrão 3; cada uma dura 30s, com dica na metade do tempo) |
| `/inventario [usuario]` | Mostra as cartas completas |
| `/progresso` | Mostra os pedaços que você está juntando (só você vê) |
| `/ranking` | Top 10 por cartas, moedas e acertos |
| `/saldo [usuario]` | Mostra as TDM Coins |
| `/diario` | Resgata TDM Coins uma vez a cada 24 horas; sequência de até 7 dias aumenta o prêmio |
| `/wishlist ver / adicionar / remover` | Gerencia a wishlist (o nome do personagem tem autocomplete) |
| `/perks ver / comprar` | Mostra e compra perks com TDM Coins |

## Wishlist e TDM Coins 🪙

- `/diario` concede 100 TDM Coins no primeiro resgate e +25 por dia consecutivo, até 250 no 7º dia. O resgate libera a cada 24 horas; após 48 horas sem resgatar, a sequência volta ao primeiro dia.

- Só personagens que estão na sua **wishlist** entram no inventário.
- Acertou alguém **da wishlist**: ganha 1 pedaço. Com 4 pedaços, a carta entra no inventário e você ganha um bônus de **100% do valor** do personagem.
- Acertou alguém **fora da wishlist**: cada acerto dá **10% do valor** em moedas. Com 4 pedaços, você ganha um bônus de **50% do valor** e o personagem não entra no inventário.
- Os pedaços continuam guardados se você tirar ou colocar o personagem na wishlist. O que vale é se ele está na wishlist no momento do 4º acerto.
- Em **35%** das rodadas, o personagem sai das wishlists de quem jogou naquele canal nos últimos 30 minutos (quem usou `/jogar` ou mandou palpite). Quanto mais jogadores querem o mesmo personagem, maior a chance dele. Ajuste com `WISHLIST_BOOST` no `.env`.
- O bot evita repetir os **10 personagens mais recentes por canal**. Esse histórico fica em memória e reinicia quando o bot é reiniciado.
- O sorteio favorece raridades comuns: cada personagem comum tem peso 8, incomum 6, raro 4, épico 2 e lendário 1. A mesma regra vale para personagens das wishlists.

### Valor por rank

O rank é a posição do personagem no AniList, ordenado por favoritos (o #1 é o mais favoritado).

| Rank | Raridade | Valor | Por acerto (fora da wishlist) | 4 pedaços fora da wishlist | 4 pedaços na wishlist |
|---|---|---|---|---|---|
| 1–10 | 🟨 Lendário | 1000 | 100 | +500 | +1000 + carta |
| 11–30 | 🟪 Épico | 600 | 60 | +300 | +600 + carta |
| 31–60 | 🟦 Raro | 300 | 30 | +150 | +300 + carta |
| 61–100 | 🟩 Incomum | 150 | 15 | +75 | +150 + carta |
| 101+ | ⬜ Comum | 80 | 8 | +40 | +80 + carta |

### Perks

| Perk | Efeito | Custo por nível |
|---|---|---|
| ⭐ Wishlist | +1 vaga (base 8, máx. 16) | 300, 450, 600, 750, 900, 1050, 1200, 1350 (total 6600) |

Para mudar valores, custos ou criar perks novos, edite `src/economy.js`.

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

- `CHARACTER_POOL_SIZE` — quantos personagens entram no jogo (padrão 300). Menos personagens = repetem mais = cartas completam mais rápido.
- `ROUND_SECONDS` — duração de cada rodada.
- `/jogar quantidade` — número de rodadas na sessão (padrão 3, máximo 5); as rodadas acontecem em sequência e mantêm o canal ocupado até a sessão terminar.
- `PIECES_TO_COMPLETE` — pedaços para completar uma carta (padrão 4).

## Estrutura

- `src/index.js` — comandos e lógica das rodadas
- `src/characters.js` — busca no AniList e checagem do nome
- `src/economy.js` — raridades, valores, recompensas diárias e perks
- `src/store.js` — pedaços, inventário, moedas, wishlist, sequência diária e perks salvos em `data/players.json`
