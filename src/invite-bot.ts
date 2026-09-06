/**
 * Bot de OLD STATE — proceso aparte, siempre encendido, que mantiene una
 * conexión de gateway con Discord. Hace dos cosas que solo se pueden hacer
 * con esa conexión permanente (no valen webhooks/REST puntuales):
 *
 * 1. Invitaciones: sabe en tiempo real quién entró al servidor de Discord y
 *    con qué invitación (`guildMemberAdd`, sin webhook/sondeo posible), y lo
 *    reporta al panel web para el ranking de "Recompensas → Invitaciones".
 * 2. Verificación por mensaje: si alguien manda un "." en el canal
 *    VERIFY_CHANNEL_ID, le da el rol de whitelist y reacciona al mensaje
 *    con 👍 — un aceptar-normativa simplificado.
 *
 * El resto del bot (comprobar rol de whitelist desde el panel, avisos de
 * streamers, leer boosters...) sí es REST puro y vive dentro del propio
 * backend PHP; esto es la única pieza que necesita gateway, por eso corre
 * aparte, en tu propio VPS, sin depender del hosting compartido del panel.
 *
 * Arranque: copia .env.example a .env, rellena los valores, y
 * `npm install && npm start`. En producción, mantenlo vivo con un gestor
 * de procesos (pm2, systemd, screen...).
 *
 * Requiere en el Developer Portal de Discord (Bot → Privileged Gateway
 * Intents): **"Server Members Intent"** (sin él, Discord no manda
 * `guildMemberAdd`) y **"Message Content Intent"** (sin él, no se puede
 * leer si un mensaje es exactamente "."). El bot también necesita, dentro
 * del servidor: permiso "Manage Guild" (leer usos de invitación), "Manage
 * Roles" con su propio rol posicionado POR ENCIMA del rol de whitelist en
 * la jerarquía (si no, Discord rechaza la asignación), y permiso para
 * añadir reacciones en el canal de verificación.
 */
import "dotenv/config";
import {
  Client,
  Collection,
  GatewayIntentBits,
  type GuildMember,
  type Invite,
  type Message,
} from "discord.js";

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const WEB_URL = process.env.PANEL_WEB_URL ?? "https://oldstate.sub-yorkhost.fr";
const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID ?? "1508924270447689873";
const VERIFY_ROLE_ID = process.env.VERIFY_ROLE_ID ?? "1508918751918166291";
const NO_WHITELIST_ROLE_ID = process.env.NO_WHITELIST_ROLE_ID ?? "1508923770277199942";

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
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
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

client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;
  if (message.channelId !== VERIFY_CHANNEL_ID) return;
  if (message.content.trim() !== ".") return;
  if (!message.guild) return;

  try {
    const member = await message.guild.members.fetch(message.author.id);
    await member.roles.add(VERIFY_ROLE_ID);
    if (member.roles.cache.has(NO_WHITELIST_ROLE_ID)) {
      await member.roles.remove(NO_WHITELIST_ROLE_ID);
    }
    await message.react("👍");
    log(`verificación: ${message.author.id} recibió el rol de whitelist (y se le quitó "No whitelist") en el canal ${VERIFY_CHANNEL_ID}`);
  } catch (err) {
    log(`no se pudo verificar a ${message.author.id}: ${(err as Error).message}`);
  }
});

client.login(BOT_TOKEN);
