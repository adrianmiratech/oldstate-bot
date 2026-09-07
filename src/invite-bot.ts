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
 * 5. Anti-@everyone: si alguien sin rol de staff menciona a @everyone/@here,
 *    se borra el mensaje, se avisa por DM y queda registrado.
 * 6. Vigilante de otro bot: comprueba cada 5 min si WATCHED_BOT_ID ("Old
 *    State 2000") está desconectado -- si lo detecta, lo deja registrado y
 *    avisa por DM a WATCHDOG_DM_ID.
 * 7. Reportes de bugs: cada mensaje en BUG_REPORT_CHANNEL_ID crea un bug de
 *    verdad en /panel/bugs (reaccionando con 🐛 al mensaje original).
 * 8. Comando /prioridad (solo staff): otorga o quita un nivel de cola
 *    prioritaria a un usuario, dando/quitando el rol real de Discord.
 * 9. Roster de staff en vivo + sync entre dos servidores: GUILD_ID y
 *    SECOND_GUILD_ID tienen los mismos roles de staff/encargados por
 *    nombre (IDs distintos en cada uno). Si alguien tiene uno de esos
 *    roles en un servidor pero no en el otro, se le añade el que le falta
 *    automáticamente; y se mantiene editado un único embed en
 *    ROSTER_CHANNEL_ID con quién tiene cada rol ahora mismo (unión de los
 *    dos servidores). Se actualiza al momento con cada cambio de rol/salida
 *    en cualquiera de los dos servidores, y además cada 5 minutos como
 *    refresco de seguridad. El ID del mensaje se guarda en el panel
 *    (bot_state.php) para sobrevivir a un reinicio del bot sin duplicarlo.
 *    El bot necesita estar invitado a AMBOS servidores para esto, con su
 *    rol por encima de todos los roles de ROSTER_ROLE_NAMES en los dos.
 *
 * Arranque: copia .env.example a .env, rellena los valores, y
 * `npm install && npm start`. En producción, mantenlo vivo con un gestor
 * de procesos (pm2, systemd, screen...).
 *
 * Requiere en el Developer Portal de Discord (Bot → Privileged Gateway
 * Intents): **"Server Members Intent"**, **"Message Content Intent"** y
 * **"Presence Intent"** (esta última nueva, necesaria para el vigilante del
 * otro bot -- actívala en el Developer Portal o el bot no arrancará).
 * Permisos dentro del servidor: "Manage Guild" (invitaciones), "Manage
 * Roles" (con el rol del bot POR ENCIMA del rol de whitelist, y por encima
 * de todos los roles del roster en los dos servidores), "Manage Messages"
 * (borrar spam/menciones) y "Add Reactions".
 */
import "dotenv/config";
import {
  ChannelType,
  Client,
  Collection,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Invite,
  type Message,
  type PartialGuildMember,
  type PartialMessage,
  type VoiceState,
} from "discord.js";

// Color de marca de Old State, usado en todos los embeds del bot (pedido
// por el usuario: "todos los mensajes que envie el bot deben ser con embed").
const BRAND_COLOR = 0xf2732e;

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const WEB_URL = process.env.PANEL_WEB_URL ?? "https://oldstate.sub-yorkhost.fr";
const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID ?? "1508924270447689873";
const VERIFY_ROLE_ID = process.env.VERIFY_ROLE_ID ?? "1508918751918166291";
const NO_WHITELIST_ROLE_ID = process.env.NO_WHITELIST_ROLE_ID ?? "1508923770277199942";
const WATCHED_BOT_ID = process.env.WATCHED_BOT_ID ?? "1522364759767515368"; // "Old State 2000"
const WATCHDOG_DM_ID = process.env.WATCHDOG_DM_ID ?? "761217833451257876";
const BUG_REPORT_CHANNEL_ID = process.env.BUG_REPORT_CHANNEL_ID ?? "1508918753977434234";
// Canal donde vive el embed de "quién tiene cada rol" (ver ROSTER_ROLE_NAMES
// más abajo) -- puede estar en cualquiera de los dos servidores, solo hace
// falta que el bot esté invitado ahí con permiso para enviar/editar
// mensajes en ese canal. Sin configurar, la función no hace nada.
const ROSTER_CHANNEL_ID = process.env.ROSTER_CHANNEL_ID ?? "1511363696964800563";
// Segundo servidor de Discord a comparar con GUILD_ID para el roster y la
// sincronización de roles de staff -- pedido por el usuario: si alguien
// tiene un rol de staff en uno de los dos servidores pero no en el otro,
// se le añade el que le falte automáticamente.
const SECOND_GUILD_ID = process.env.SECOND_GUILD_ID ?? "1381245443505393705";
// Logo de staff para el embed del roster, alojado en el propio panel web.
const ROSTER_LOGO_URL = process.env.ROSTER_LOGO_URL ?? "https://oldstate.sub-yorkhost.fr/old_staff.png";
// Azul de marca del logo de staff (distinto del BRAND_COLOR naranja
// general, para que el roster se distinga a simple vista).
const ROSTER_COLOR = 0x1e3fae;

// Roles reales de "Cola Prioritaria LVL 1/2/3" -- otorgados por el comando
// /prioridad (los permisos del panel se leen de estos mismos roles, así
// que conceder uno aquí ya da la prioridad de verdad, sin tocar la web).
const PRIORITY_ROLE_IDS: Record<"1" | "2" | "3", string> = {
  "1": "1543967621945491486",
  "2": "1543967686105505862",
  "3": "1543967775800688681",
};

// ----- Moderación: umbrales de spam/flood -----
const SPAM_WINDOW_MS = 6000; // ventana de tiempo
const SPAM_MESSAGE_THRESHOLD = 5; // mensajes seguidos en esa ventana = flood
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // cada cuanto se comprueba el otro bot

// Escalera de staff real (Helper LVL 1 hacia arriba) -- quien tenga uno de
// estos roles esta "autorizado" para mencionar a @everyone/@here.
const STAFF_ROLE_IDS = new Set([
  "1508918751960240210", // Helper LVL 1
  "1508918751960240211", // Helper LVL 2
  "1508926280173879296", // Helper LVL 3
  "1508918751960240212", // Moderador
  "1508918751960240213", // Administrador
  "1525596060775350464", // Jefe de Staff
  "1508918751960240215", // Direccion
  "1525672932179837039", // "*"
  "1508918751960240216", // CEO
]);

function log(msg: string): void {
  console.log(`[oldstate-bot] ${msg}`);
}

// ===== Roster en vivo + sincronización de roles de staff entre servidores =====
//
// Pedido por el usuario a partir de un mensaje que mandaba a mano y quedaba
// desactualizado. Dos servidores distintos (GUILD_ID y SECOND_GUILD_ID)
// tienen los mismos puestos de staff/encargados pero, para varios, con un
// NOMBRE DE ROL DISTINTO en cada servidor -- por eso cada entrada lleva el
// nombre exacto en cada uno (comprobado a mano contra los roles reales de
// los dos servidores, confirmado por el usuario). `nameB: null` = ese
// puesto no existe en el servidor B, así que no se sincroniza -- solo se
// muestra lo que haya en A. El orden de esta lista es el orden en que
// aparecen las líneas del embed.
interface RosterRoleDef {
  label: string;
  nameA: string;
  nameB: string | null;
}

const ROSTER_ROLES: RosterRoleDef[] = [
  { label: "CEO", nameA: "CEO", nameB: "CEO" },
  { label: "Direccion", nameA: "Direccion", nameB: "Direccion" },
  { label: "Jefe de Staff", nameA: "Jefe de Staff", nameB: "Jefe de Staff" },
  { label: "Administrador", nameA: "Administrador", nameB: "Administrador" },
  { label: "Moderador", nameA: "Moderador", nameB: "Moderador" },
  { label: "Helper LVL 3", nameA: "Helper LVL 3", nameB: "Helper LVL 3" },
  { label: "Helper LVL 2", nameA: "Helper LVL 2", nameB: "Helper LVL 2" },
  { label: "Helper LVL 1", nameA: "Helper LVL 1", nameB: "Helper LVL 1" },
  { label: "Developer", nameA: "Developer", nameB: "Equipo developer" },
  { label: "Encargado/a negocios", nameA: "Encargado/a negocios", nameB: "Encargado Comercios" },
  { label: "Encargado/a ilícitos", nameA: "Encargado/a ilícitos", nameB: "Encargado Ilicitos" },
  { label: "Encargado/a marketing", nameA: "Encargado/a marketing", nameB: "Encargado Marketing" },
  { label: "Encargado/a streamers", nameA: "Encargado/a streamers", nameB: "Encargado Streamers" },
  { label: "Encargado/a entrevistadores", nameA: "Encargado/a entrevistadores", nameB: "Encargado entrevistador" },
  { label: "Encargado/a economía", nameA: "Encargado/a economía", nameB: "Encargado Economia" },
  { label: "Encargado SAPD", nameA: "Encargado SAPD", nameB: "Encargado SAPD" },
  { label: "Encargado DOJ", nameA: "Encargado DOJ", nameB: null },
  { label: "Encargado SAED", nameA: "Encargado SAED", nameB: "Encargado SAED" },
];
// Todos los nombres de rol que intervienen en el roster, en CUALQUIERA de
// los dos servidores -- usado solo para detectar rápido si un cambio de
// rol cualquiera (de cualquier persona, en cualquiera de los dos
// servidores) afecta al roster y hace falta recalcularlo.
const ROSTER_ROLE_NAME_SET = new Set(
  ROSTER_ROLES.flatMap((r) => [r.nameA, r.nameB]).filter((n): n is string => n !== null)
);
const ROSTER_STATE_KEY = "roster_message_id";
const ROSTER_SYNC_INTERVAL_MS = 5 * 60 * 1000; // refresco periódico de seguridad, además del en vivo

function isRosterGuild(guildId: string): boolean {
  return guildId === GUILD_ID || guildId === SECOND_GUILD_ID;
}

async function getBotState(key: string): Promise<string | null> {
  try {
    const res = await fetch(`${WEB_URL}/api/bot_state.php?key=${encodeURIComponent(key)}`, {
      headers: { "X-Bot-Token": BOT_TOKEN! },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { value: string | null };
    return data.value;
  } catch (err) {
    log(`no se pudo leer el estado del bot ("${key}"): ${(err as Error).message}`);
    return null;
  }
}

async function setBotState(key: string, value: string): Promise<void> {
  try {
    await fetch(`${WEB_URL}/api/bot_state.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bot-Token": BOT_TOKEN! },
      body: JSON.stringify({ key, value }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    log(`no se pudo guardar el estado del bot ("${key}"): ${(err as Error).message}`);
  }
}

interface RosterHolder {
  /** ID del rol en el servidor B (el del canal del roster), o null si ese
   * puesto no tiene equivalente ahí -- se usa para la mención real del
   * encabezado de cada línea del embed. */
  roleBId: string | null;
  users: Set<string>;
}

/**
 * Para cada puesto de ROSTER_ROLES, compara quién tiene el rol A en el
 * servidor A y el rol B (su equivalente, si existe) en el servidor B. Si a
 * alguien le falta en uno de los dos, se le añade ahí mismo. Devuelve, por
 * `label`, la unión de quién tiene ya cualquiera de los dos roles (tras
 * sincronizar) junto con el ID del rol B para la mención del embed.
 */
async function syncStaffRolesAndCollect(
  guildA: import("discord.js").Guild,
  guildB: import("discord.js").Guild
): Promise<Map<string, RosterHolder>> {
  const holders = new Map<string, RosterHolder>();

  for (const { label, nameA, nameB } of ROSTER_ROLES) {
    const roleA = guildA.roles.cache.find((r) => r.name === nameA) ?? null;
    const roleB = nameB ? guildB.roles.cache.find((r) => r.name === nameB) ?? null : null;
    holders.set(label, { roleBId: roleB?.id ?? null, users: new Set() });

    const idsWithA = roleA ? new Set(roleA.members.keys()) : new Set<string>();
    const idsWithB = roleB ? new Set(roleB.members.keys()) : new Set<string>();
    const union = new Set([...idsWithA, ...idsWithB]);

    for (const userId of union) {
      holders.get(label)!.users.add(userId);

      const hasA = idsWithA.has(userId);
      const hasB = idsWithB.has(userId);
      if (hasA === hasB) continue; // ya coincide en los dos (o no aplica porque nameB es null)

      if (!hasB && roleB) {
        const memberB = guildB.members.cache.get(userId);
        if (memberB) {
          try {
            await memberB.roles.add(roleB);
            log(`sync de staff: "${label}" añadido a ${userId} en ${guildB.id} (lo tenía en ${guildA.id}).`);
          } catch (err) {
            log(`no se pudo añadir "${label}" a ${userId} en ${guildB.id}: ${(err as Error).message}`);
          }
        }
      } else if (!hasA && roleA) {
        const memberA = guildA.members.cache.get(userId);
        if (memberA) {
          try {
            await memberA.roles.add(roleA);
            log(`sync de staff: "${label}" añadido a ${userId} en ${guildA.id} (lo tenía en ${guildB.id}).`);
          } catch (err) {
            log(`no se pudo añadir "${label}" a ${userId} en ${guildA.id}: ${(err as Error).message}`);
          }
        }
      }
    }
  }

  return holders;
}

function buildRosterEmbed(holders: Map<string, RosterHolder>): EmbedBuilder {
  // Mención real de rol (`<@&id>`) en vez de texto "@Nombre" -- pedido por
  // el usuario: se ve como una mención de verdad (la píldora de color de
  // Discord) pero, al ir dentro de un embed y no en el texto del mensaje,
  // Discord nunca la notifica a nadie. Si ese puesto no tiene rol en el
  // servidor del canal (Encargado DOJ), se deja el nombre en negrita.
  const lines = ROSTER_ROLES.map(({ label }) => {
    const holder = holders.get(label);
    const heading = holder?.roleBId ? `<@&${holder.roleBId}>` : `**${label}**`;
    const ids = [...(holder?.users ?? [])];
    const mentions = ids.length > 0 ? ids.map((id) => `<@${id}>`).join(" ") : "*Nadie*";
    return `${heading}\n${mentions}`;
  });

  return new EmbedBuilder()
    .setColor(ROSTER_COLOR)
    .setAuthor({ name: "OLD STATE STAFF", iconURL: ROSTER_LOGO_URL })
    .setTitle("📋 Roster de staff")
    .setDescription(lines.join("\n\n"))
    .setThumbnail(ROSTER_LOGO_URL)
    .setFooter({ text: "Última actualización" })
    .setTimestamp();
}

let rosterUpdateQueued = false;
let rosterUpdateRunning = false;

async function updateRosterMessage(): Promise<void> {
  if (!ROSTER_CHANNEL_ID || !SECOND_GUILD_ID) return;
  // Evita solapar dos actualizaciones a la vez si llegan varios cambios de
  // rol seguidos -- la que estaba en curso ya recoge el estado más nuevo,
  // así que basta con relanzar una vez más al terminar.
  if (rosterUpdateRunning) {
    rosterUpdateQueued = true;
    return;
  }
  rosterUpdateRunning = true;

  try {
    const guildA = await client.guilds.fetch(GUILD_ID!);
    const guildB = await client.guilds.fetch(SECOND_GUILD_ID);
    await guildA.members.fetch();
    await guildB.members.fetch();

    const holders = await syncStaffRolesAndCollect(guildA, guildB);
    const embed = buildRosterEmbed(holders);

    const channel = await client.channels.fetch(ROSTER_CHANNEL_ID);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      log(`ROSTER_CHANNEL_ID (${ROSTER_CHANNEL_ID}) no es un canal de texto válido o el bot no tiene acceso.`);
      return;
    }

    const existingId = await getBotState(ROSTER_STATE_KEY);
    if (existingId) {
      try {
        const existing = await channel.messages.fetch(existingId);
        await existing.edit({ embeds: [embed] });
        return;
      } catch {
        log(`el mensaje del roster (${existingId}) ya no existe -- se crea uno nuevo.`);
      }
    }

    const sent = await channel.send({ embeds: [embed] });
    await setBotState(ROSTER_STATE_KEY, sent.id);
  } catch (err) {
    log(`no se pudo actualizar el roster: ${(err as Error).message}`);
  } finally {
    rosterUpdateRunning = false;
    if (rosterUpdateQueued) {
      rosterUpdateQueued = false;
      updateRosterMessage();
    }
  }
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
    GatewayIntentBits.GuildPresences,
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

// ===== Comandos de barra (slash commands) =====

const COMMANDS = [
  new SlashCommandBuilder()
    .setName("prioridad")
    .setDescription("Otorga un nivel de cola prioritaria a un usuario")
    .addUserOption((opt) => opt.setName("usuario").setDescription("Usuario a modificar").setRequired(true))
    .addStringOption((opt) =>
      opt
        .setName("nivel")
        .setDescription("Nivel de prioridad")
        .setRequired(true)
        .addChoices(
          { name: "Nivel 1", value: "1" },
          { name: "Nivel 2", value: "2" },
          { name: "Nivel 3", value: "3" },
          { name: "Quitar prioridad", value: "0" }
        )
    )
    .toJSON(),
];

async function registerSlashCommands(): Promise<void> {
  try {
    const rest = new REST().setToken(BOT_TOKEN!);
    const appId = client.application!.id;
    await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID!), { body: COMMANDS });
    log("comandos de barra registrados");
  } catch (err) {
    log(`no se pudieron registrar los comandos de barra: ${(err as Error).message}`);
  }
}

function isStaffMember(member: GuildMember): boolean {
  return [...member.roles.cache.keys()].some((id) => STAFF_ROLE_IDS.has(id));
}

async function handlePrioridadCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !interaction.member) return;
  const invoker = interaction.member as GuildMember;
  if (!isStaffMember(invoker)) {
    await interaction.reply({ content: "No tienes permiso para usar este comando.", ephemeral: true });
    return;
  }

  const targetUser = interaction.options.getUser("usuario", true);
  const nivel = interaction.options.getString("nivel", true) as "0" | "1" | "2" | "3";

  try {
    const targetMember = await interaction.guild.members.fetch(targetUser.id);
    for (const roleId of Object.values(PRIORITY_ROLE_IDS)) {
      if (targetMember.roles.cache.has(roleId)) {
        await targetMember.roles.remove(roleId);
      }
    }
    if (nivel !== "0") {
      await targetMember.roles.add(PRIORITY_ROLE_IDS[nivel]);
    }

    const label = nivel === "0" ? "sin prioridad" : `Nivel ${nivel}`;
    await interaction.reply({
      content: `${targetUser} ahora tiene: **${label}**.`,
      ephemeral: false,
    });

    logEvent("bot.command_prioridad", {
      actorDiscordId: invoker.id,
      targetDiscordId: targetUser.id,
      guildId: interaction.guild.id,
      details: { nivel },
      message: `${invoker.user.tag} usó /prioridad sobre ${targetUser.tag}: ${label}.`,
    });
  } catch (err) {
    log(`fallo en /prioridad: ${(err as Error).message}`);
    await interaction.reply({ content: "No se pudo completar la acción.", ephemeral: true });
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "prioridad") {
    await handlePrioridadCommand(interaction);
  }
});

client.once("clientReady", async () => {
  log(`conectado como ${client.user?.tag}`);
  await registerSlashCommands();
  await refreshInviteCache();
  log(`${inviteCache.size} invitaciones cacheadas`);
  if (ROSTER_CHANNEL_ID && SECOND_GUILD_ID) {
    await updateRosterMessage();
    // Refresco periódico de seguridad además del en vivo -- pedido por el
    // usuario ("la lista debe actualizarse frecuentemente"), por si algún
    // evento de rol se pierde o el bot estuvo caído un momento.
    setInterval(updateRosterMessage, ROSTER_SYNC_INTERVAL_MS);
  }
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

// Roster: dedicado y separado del logging de arriba porque este SÍ debe
// reaccionar a los dos servidores (GUILD_ID y SECOND_GUILD_ID), no solo a
// GUILD_ID.
client.on("guildMemberRemove", (member: GuildMember | PartialGuildMember) => {
  if (!isRosterGuild(member.guild.id)) return;
  const hadRosterRole = member.roles?.cache?.some((role) => ROSTER_ROLE_NAME_SET.has(role.name)) ?? false;
  if (hadRosterRole) {
    updateRosterMessage();
  }
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

// Roster: dedicado y separado del logging de arriba porque este SÍ debe
// reaccionar a los dos servidores (GUILD_ID y SECOND_GUILD_ID), no solo a
// GUILD_ID.
client.on("guildMemberUpdate", (oldMember: GuildMember | PartialGuildMember, newMember: GuildMember) => {
  if (!isRosterGuild(newMember.guild.id)) return;

  const oldRoles = oldMember.roles?.cache ?? new Collection();
  const newRoles = newMember.roles.cache;
  const rosterRoleChanged = [...newRoles.values(), ...oldRoles.values()].some(
    (role) => ROSTER_ROLE_NAME_SET.has(role.name) && newRoles.has(role.id) !== oldRoles.has(role.id)
  );
  if (rosterRoleChanged) {
    updateRosterMessage();
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

// ===== Reportes de bugs: cada mensaje en el canal crea un bug en la web =====

client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;
  if (message.channelId !== BUG_REPORT_CHANNEL_ID) return;
  if (!message.content.trim()) return;

  try {
    const res = await fetch(`${WEB_URL}/api/bug_report_from_discord.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bot-Token": BOT_TOKEN! },
      body: JSON.stringify({
        discordId: message.author.id,
        displayName: message.member?.displayName ?? message.author.username,
        content: message.content,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      await message.react("🐛");
    } else {
      log(`el panel rechazó el bug reportado por ${message.author.id} (HTTP ${res.status})`);
    }
  } catch (err) {
    log(`no se pudo crear el bug reportado por ${message.author.id}: ${(err as Error).message}`);
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
    await dm.send({
      embeds: [
        new EmbedBuilder()
          .setColor(BRAND_COLOR)
          .setTitle("⚠️ Infracción de spam/flood")
          .setDescription(
            `Se ha registrado una infracción por spam/flood en tu cuenta en OLD STATE (canal <#${message.channelId}>). ` +
            "Tus mensajes han sido borrados. Evita enviar muchos mensajes seguidos en poco tiempo."
          ),
      ],
    });
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

// ===== Anti-@everyone de usuarios no autorizados =====

client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;
  if (!message.guild || message.guild.id !== GUILD_ID) return;
  if (!message.mentions.everyone) return;

  const memberRoles = message.member?.roles.cache;
  const isStaff = memberRoles ? [...memberRoles.keys()].some((id) => STAFF_ROLE_IDS.has(id)) : false;
  if (isStaff) return;

  try {
    await message.delete();
  } catch (err) {
    log(`no se pudo borrar la mención de @everyone de ${message.author.id}: ${(err as Error).message}`);
  }

  try {
    const dm = await message.author.createDM();
    await dm.send({
      embeds: [
        new EmbedBuilder()
          .setColor(BRAND_COLOR)
          .setTitle("⚠️ Mención no autorizada")
          .setDescription(
            "Se ha registrado una mención no autorizada a @everyone/@here en tu cuenta en OLD STATE. Tu mensaje ha sido borrado."
          ),
      ],
    });
  } catch (err) {
    log(`no se pudo avisar por DM a ${message.author.id}: ${(err as Error).message}`);
  }

  logEvent("moderation.unauthorized_mention", {
    actorDiscordId: message.author.id,
    channelId: message.channelId,
    guildId: message.guild.id,
    message: `${message.author.tag} intentó mencionar a @everyone/@here sin autorización en <#${message.channelId}>.`,
  });
});

// ===== Vigilante de otro bot (ej. "Old State 2000") =====

let watchedBotOnline = true;

async function checkWatchedBot(): Promise<void> {
  try {
    const guild = await client.guilds.fetch(GUILD_ID!);
    const member = await guild.members.fetch({ user: WATCHED_BOT_ID, force: true });
    const status = member.presence?.status ?? "offline";
    const isOnline = status !== "offline";

    if (!isOnline && watchedBotOnline) {
      logEvent("bot.watchdog_offline", {
        targetDiscordId: WATCHED_BOT_ID,
        guildId: GUILD_ID,
        message: `El bot "Old State 2000" (${WATCHED_BOT_ID}) ha sido detectado como desconectado.`,
      });
      try {
        const owner = await client.users.fetch(WATCHDOG_DM_ID);
        const dm = await owner.createDM();
        await dm.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xe14b3c)
              .setTitle("🔴 Bot desconectado")
              .setDescription("El bot **Old State 2000** ha sido detectado como desconectado. Revísalo para su corrección."),
          ],
        });
      } catch (err) {
        log(`no se pudo avisar por DM al owner del vigilante: ${(err as Error).message}`);
      }
    } else if (isOnline && !watchedBotOnline) {
      logEvent("bot.watchdog_online", {
        targetDiscordId: WATCHED_BOT_ID,
        guildId: GUILD_ID,
        message: `El bot "Old State 2000" (${WATCHED_BOT_ID}) ha vuelto a conectarse.`,
      });
    }
    watchedBotOnline = isOnline;
  } catch (err) {
    log(`no se pudo comprobar el estado del bot vigilado: ${(err as Error).message}`);
  }
}

client.once("clientReady", () => {
  setTimeout(checkWatchedBot, 10000);
  setInterval(checkWatchedBot, WATCHDOG_INTERVAL_MS);
});

client.login(BOT_TOKEN);
