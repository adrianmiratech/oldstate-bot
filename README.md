# OLD STATE — Bot de invitaciones

Proceso Node.js aparte (no forma parte del panel web, que corre en PHP sin
servidor Node) que mantiene una conexión permanente al gateway de Discord
para saber en tiempo real quién invitó a quién al servidor de Discord, y lo
reporta al panel para el ranking de **Recompensas → Invitaciones**.

## Por qué existe como proyecto aparte

Discord solo notifica altas de miembros (`guildMemberAdd`) por su gateway
(WebSocket persistente) — no hay webhook ni sondeo por REST que avise de eso
en tiempo real. El resto de funciones del bot (comprobar el rol de
whitelist, avisar de streamers en directo, leer boosters) sí son llamadas
REST puntuales y viven dentro del propio panel en PHP. Esta es la única
pieza que necesita una conexión permanente, así que corre en un servidor
propio (VPS, Railway, etc.) en vez del hosting compartido del panel.

## Requisitos en el Developer Portal de Discord

En la aplicación del bot:

1. **Bot → Privileged Gateway Intents → Server Members Intent**: actívalo.
   Sin él, Discord no manda el evento `guildMemberAdd`.
2. El bot necesita el permiso **"Manage Guild"** dentro del servidor de
   Discord para poder leer los usos de cada invitación.

## Puesta en marcha

```bash
npm install
cp .env.example .env   # ya viene relleno si clonaste este export; si no, rellénalo a mano
npm start
```

Variables en `.env`:

| Variable | Qué es |
|---|---|
| `DISCORD_BOT_TOKEN` | Token del bot (Developer Portal → Bot → Reset Token) |
| `DISCORD_GUILD_ID` | ID del servidor de Discord de OLD STATE |
| `PANEL_WEB_URL` | URL base del panel (por defecto `https://oldstate.sub-yorkhost.fr`) |

**El archivo `.env` nunca se sube a git** (está en `.gitignore`) — configúralo
directamente en el servidor donde despliegues el bot.

## Mantenerlo vivo en producción

Este proceso debe quedarse corriendo 24/7, igual que un servidor web. En un
VPS con systemd o pm2:

```bash
pm2 start npm --name oldstate-bot -- start
pm2 save
```

O con systemd, un servicio que ejecute `npm start` dentro de esta carpeta
con `Restart=always`.

## Qué hace exactamente

1. Al arrancar, cachea en memoria los usos actuales de cada invitación del
   servidor.
2. Cuando alguien entra al Discord (`guildMemberAdd`), vuelve a leer las
   invitaciones y compara usos para averiguar cuál subió — así sabe quién
   invitó a quién (Discord no lo dice directamente).
3. Reporta ese hallazgo a `POST {PANEL_WEB_URL}/api/rewards_invites_record.php`,
   autenticado con la cabecera `X-Bot-Token` (el mismo token del bot
   guardado en la configuración del panel).
