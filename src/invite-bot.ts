/**
 * Bot de invitaciones de OLD STATE — proceso aparte, siempre encendido,
 * que mantiene una conexión de gateway con Discord para saber en tiempo
 * real quién entró al servidor de Discord y con qué invitación, y lo
 * reporta al panel web para el ranking de "Recompensas → Invitaciones".
 *
 * Por qué un proceso aparte y no una ruta más del panel (que vive en PHP,
 * sin proceso persistente): Discord solo notifica altas de miembros
 * (`guildMemberAdd`) por su gateway (WebSocket persistente) — no hay
 * webhook ni sondeo por REST que avise de eso en tiempo real. El resto del
 * bot (comprobar rol de whitelist, mandar avisos de streamers, leer
 * boosters...) sí es REST puro y vive dentro del propio backend PHP; esto
 * es la única pieza que necesita gateway, por eso corre aparte, en tu
 * propio VPS, sin depender del hosting compartido del panel.
 *
 * Arranque: copia .env.example a .env, rellena los valores, y
 * `npm install && npm start`. En producción, mantenlo vivo con un gestor
 * de procesos (pm2, systemd, screen...).
 *
 * Requiere en el Developer Portal de Discord (Bot → Privileged Gateway
 * Intents): "Server Members Intent" activado — sin él, Discord no manda
 * `guildMemberAdd`. El bot también necesita el permiso "Manage Guild" en
 * el servidor para poder leer los usos de cada invitación.
 */
import "dotenv/config";
import {
  Client,
  Collection,
  GatewayIntentBits,
  type GuildMember,
  type Invite,
} from "discord.js";

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const WEB_URL = process.env.PANEL_WEB_URL ?? "https://oldstate.sub-yorkhost.fr";

function log(msg: string): void {
  console.log(`[invite-bot] ${msg}`);
}

if (!BOT_TOKEN || !GUILD_ID) {
  log("Falta DISCORD_BOT_TOKEN o DISCORD_GUILD_ID en el .env — saliendo.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
  ],
});

// code -> usos, cacheado en memoria para poder saber qué invitación subió
// de uso cuando entra alguien nuevo (Discord no lo dice directamente).
let inviteCache = new Collection<string, number>();

async function refreshInviteCache(): Promise<void> {
  const guild = await client.guilds.fetch(GUILD_ID!);
  const invites = await guild.invites.fetch();
  inviteCache = new Collection(invites.map((inv) => [inv.code, inv.uses ?? 0]));
}

async function recordJoin(inviterDiscordId: string, invitedDiscordId: string, inviteCode: string): Promise<void> {
  try {
    const res = await fetch(`${WEB_URL}/api/rewards_invites_record.php`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bot-Token": BOT_TOKEN!,
      },
      body: JSON.stringify({ inviterDiscordId, invitedDiscordId, inviteCode }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      log(`el panel rechazó el registro (HTTP ${res.status}) para invitación ${inviteCode}`);
    }
  } catch (err) {
    log(`no se pudo contactar con el panel: ${(err as Error).message}`);
  }
}

client.once("clientReady", async () => {
  log(`conectado como ${client.user?.tag}`);
  await refreshInviteCache();
  log(`${inviteCache.size} invitaciones cacheadas`);
});

client.on("inviteCreate", (invite: Invite) => {
  inviteCache.set(invite.code, invite.uses ?? 0);
});

client.on("inviteDelete", (invite: Invite) => {
  inviteCache.delete(invite.code);
});

client.on("guildMemberAdd", async (member: GuildMember) => {
  if (member.guild.id !== GUILD_ID) return;

  let usedInvite: Invite | null = null;
  try {
    const guild = await client.guilds.fetch(GUILD_ID!);
    const invites = await guild.invites.fetch();
    for (const invite of invites.values()) {
      const before = inviteCache.get(invite.code) ?? 0;
      const after = invite.uses ?? 0;
      if (after > before) {
        usedInvite = invite;
        break;
      }
    }
    inviteCache = new Collection(invites.map((inv) => [inv.code, inv.uses ?? 0]));
  } catch (err) {
    log(`error comprobando invitaciones tras la entrada de ${member.id}: ${(err as Error).message}`);
    return;
  }

  if (!usedInvite || !usedInvite.inviter) {
    log(`${member.id} entró pero no se pudo determinar qué invitación usó (¿enlace de vanity URL o invitación de un solo uso ya borrada?)`);
    return;
  }

  log(`${member.id} entró invitado por ${usedInvite.inviter.id} (código ${usedInvite.code})`);
  await recordJoin(usedInvite.inviter.id, member.id, usedInvite.code);
});

client.login(BOT_TOKEN);
