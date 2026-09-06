/**
 * Bot de OLD STATE — proceso aparte, siempre encendido, que mantiene una
 * conexión de gateway con Discord. Hace lo que solo se puede hacer con esa
 * conexión permanente (no valen webhooks/REST puntuales, eso vive en el
 * backend PHP en discord.php):
 *
 * 1. Invitaciones: quién entró al Discord y con qué invitación
 *    (`guildMemberAdd`), reportado al ranking de "Recompensas → Invitaciones".
 * 2. Verificación por mensaje: un "." en VERIFY_CHANNEL_ID da el rol de
 *    whitelist (y quita "No whitelist") + reacción 👍.
 * 3. Vigilancia total: registra en la web (tabla discord_events) cada
 *    entrada, salida, cambio de rol, entrada/salida/cambio de canal de voz
 *    y borrado de mensajes — todo lo que pasa en el servidor.
 * 4. Moderación automática: detecta spam/flood (muchos mensajes seguidos
 *    del mismo usuario en poco tiempo), borra esos mensajes, avisa al
 *    usuario por DM de que se ha registrado la infracción, y lo deja
 *    registrado como suceso de moderación.
 *
 * Arranque: copia .env.example a .env, rellena los valores, y
 * `npm install && npm start`. En producción, mantenlo vivo con un gestor
 * de procesos (pm2, systemd, screen...).
 *
 * Requiere en el Developer Portal de Discord (Bot → Privileged Gateway
 * Intents): **"Server Members Intent"** y **"Message Content Intent"**.
 * Permisos dentro del servidor: "Manage Guild" (invitaciones), "Manage
 * Roles" (con el rol del bot POR ENCIMA del rol de whitelist), "Manage
 * Messages" (borrar spam) y "Add Reactions".
 */
import "dotenv/config";
import {
  ChannelType,
  Client,
  Collection,
  GatewayIntentBits,
  Partials,
  type GuildMember,
  type Invite,
  type Message,
  type PartialGuildMember,
  type PartialMessage,
  type VoiceState,
} from "discord.js";

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const WEB_URL = process.env.PANEL_WEB_URL ?? "https://oldstate.sub-yorkhost.fr";
const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID ?? "1508924270447689873";
const VERIFY_ROLE_ID = process.env.VERIFY_ROLE_ID ?? "1508918751918166291";
const NO_WHITELIST_ROLE_ID = process.env.NO_WHITELIST_ROLE_ID ?? "1508923770277199942";

// ----- Moderación: umbrales de spam/flood -----
const SPAM_WINDOW_MS = 6000; // ventana de tiempo
const SPAM_MESSAGE_THRESHOLD = 5; // mensajes seguidos en esa ventana = flood

function log(msg: string): void {
  console.log(`[oldstate-bot] ${msg}`);
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
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

// ===== Registro central: todo evento del servidor se manda a la web =====

interface EventPayload {
  actorDiscordId?: string | null;
  targetDiscordId?: string | null;
  channelId?: string | null;
  guildId?: string | null;
  details?: Record<string, unknown> | null;
  message?: string | null;
}

async function logEvent(type: string, payload: EventPayload = {}): Promise<void> {
  try {
    const res = await fetch(`${WEB_URL}/api/discord_events_record.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bot-Token": BOT_TOKEN! },
      body: JSON.stringify({ type, ...payload }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      log(`el panel rechazó el registro del suceso "${type}" (HTTP ${res.status})`);
    }
  } catch (err) {
    log(`no se pudo registrar el suceso "${type}": ${(err as Error).message}`);
  }
}

// ===== Invitaciones (quién invitó a quién) =====

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

  logEvent("member.join", {
    targetDiscordId: member.id,
    guildId: member.guild.id,
    message: `${member.user.tag} se unió al servidor.`,
  });

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

// ===== Vigilancia: salidas y cambios de rol =====

client.on("guildMemberRemove", (member: GuildMember | PartialGuildMember) => {
  if (member.guild.id !== GUILD_ID) return;
  logEvent("member.leave", {
    targetDiscordId: member.id,
    guildId: member.guild.id,
    message: `${member.user?.tag ?? member.id} salió del servidor.`,
  });
});

client.on("guildMemberUpdate", (oldMember: GuildMember | PartialGuildMember, newMember: GuildMember) => {
  if (newMember.guild.id !== GUILD_ID) return;

  const oldRoles = oldMember.roles?.cache ?? new Collection();
  const newRoles = newMember.roles.cache;

  for (const [roleId, role] of newRoles) {
    if (!oldRoles.has(roleId)) {
      logEvent("member.role_added", {
        targetDiscordId: newMember.id,
        guildId: newMember.guild.id,
        details: { roleId, roleName: role.name },
        message: `${newMember.user.tag} recibió el rol "${role.name}".`,
      });
    }
  }
  for (const [roleId, role] of oldRoles) {
    if (!newRoles.has(roleId)) {
      logEvent("member.role_removed", {
        targetDiscordId: newMember.id,
        guildId: newMember.guild.id,
        details: { roleId, roleName: role.name },
        message: `${newMember.user.tag} perdió el rol "${role.name}".`,
      });
    }
  }
});

// ===== Vigilancia: canales de voz =====

client.on("voiceStateUpdate", (oldState: VoiceState, newState: VoiceState) => {
  if (newState.guild.id !== GUILD_ID) return;
  const userId = newState.member?.id ?? oldState.member?.id ?? null;

  if (!oldState.channelId && newState.channelId) {
    logEvent("voice.join", {
      targetDiscordId: userId,
      channelId: newState.channelId,
      guildId: newState.guild.id,
    });
  } else if (oldState.channelId && !newState.channelId) {
    logEvent("voice.leave", {
      targetDiscordId: userId,
      channelId: oldState.channelId,
      guildId: oldState.guild.id,
    });
  } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    logEvent("voice.move", {
      targetDiscordId: userId,
      channelId: newState.channelId,
      guildId: newState.guild.id,
      details: { from: oldState.channelId, to: newState.channelId },
    });
  }
});

// ===== Vigilancia: mensajes borrados =====

client.on("messageDelete", (message: Message | PartialMessage) => {
  if (!message.guildId || message.guildId !== GUILD_ID) return;
  if (message.author?.bot) return;
  logEvent("message.delete", {
    actorDiscordId: message.author?.id ?? null,
    channelId: message.channelId,
    guildId: message.guildId,
    message: message.partial ? null : message.content?.slice(0, 500),
  });
});

// ===== Verificación por mensaje ("." -> rol de whitelist) =====

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

// ===== Moderación automática: spam / flood =====

// clave "canal:usuario" -> timestamps de sus últimos mensajes en ese canal
const recentMessages = new Map<string, number[]>();
// evita re-disparar en cada mensaje mientras se está procesando un flood
const punishedRecently = new Set<string>();

client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;
  if (!message.guild || message.guild.id !== GUILD_ID) return;
  if (message.channel.type !== ChannelType.GuildText) return;

  const key = `${message.channelId}:${message.author.id}`;
  const now = Date.now();
  const timestamps = (recentMessages.get(key) ?? []).filter((t) => now - t < SPAM_WINDOW_MS);
  timestamps.push(now);
  recentMessages.set(key, timestamps);

  if (timestamps.length < SPAM_MESSAGE_THRESHOLD) return;
  if (punishedRecently.has(key)) return;
  punishedRecently.add(key);
  recentMessages.delete(key);
  setTimeout(() => punishedRecently.delete(key), SPAM_WINDOW_MS);

  const channel = message.channel;
  const authorId = message.author.id;
  const authorTag = message.author.tag;

  try {
    const recent = await channel.messages.fetch({ limit: 50 });
    const offending = recent.filter(
      (m) => m.author.id === authorId && now - m.createdTimestamp < SPAM_WINDOW_MS * 2
    );
    if (offending.size > 1) {
      await channel.bulkDelete(offending, true);
    } else if (offending.size === 1) {
      await offending.first()?.delete();
    }
  } catch (err) {
    log(`no se pudieron borrar los mensajes de spam de ${authorId}: ${(err as Error).message}`);
  }

  try {
    const dm = await message.author.createDM();
    await dm.send(
      "Se ha registrado una infracción por spam/flood en tu cuenta en OLD STATE " +
      `(canal <#${message.channelId}>). Tus mensajes han sido borrados. Evita enviar muchos mensajes seguidos en poco tiempo.`
    );
  } catch (err) {
    log(`no se pudo avisar por DM a ${authorId}: ${(err as Error).message}`);
  }

  logEvent("moderation.spam_detected", {
    actorDiscordId: authorId,
    channelId: message.channelId,
    guildId: message.guild.id,
    details: { messageCount: timestamps.length, windowMs: SPAM_WINDOW_MS },
    message: `Flood detectado de ${authorTag} en <#${message.channelId}>: mensajes borrados y aviso enviado por DM.`,
  });
});

client.login(BOT_TOKEN);
