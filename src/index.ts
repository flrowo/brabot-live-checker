import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  TextChannel,
  Events,
  Message,
} from 'discord.js';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

const TOKEN = process.env.DISCORD_TOKEN;
const FERIADOS_API_KEY = process.env.FERIADOS_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID || '532676295939850250';
const PREFIX = '!';
const DATA_FILE = path.join(__dirname, 'data.json');

const DEFAULT_STREAMS = [
  { username: "Bruno", bearerToken: "FSIauhwiuasdhiufhiusah913274y1273" },
  { username: "Jão", bearerToken: "eae" },
  { username: "Andre", bearerToken: "asdasdasdasdasdasdasdasdas" },
  { username: "Fernandes", bearerToken: "IPC" },
  { username: "Soave", bearerToken: "SODFGNDFGJUNDSFGJSDN43814871" },
  { username: "Fab", bearerToken: "sddse6cyrene" },
  { username: "Vitor", bearerToken: "Teste" },
  { username: "Thiago", bearerToken: "billibilli" },
];

let STREAMS: Array<{ username: string; bearerToken: string }> = [];

const POLL_INTERVAL_MS = 60_000;
const BASE_URL = 'https://b.siobud.com';

if (!TOKEN) {
  console.error('❌ Error: DISCORD_TOKEN is missing in .env');
  process.exit(1);
}

// Minimal standard WebRTC SDP Offer to probe WHEP playback
const PROBE_SDP = [
  'v=0',
  'o=- 1234567890 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'a=msid-semantic: WMS',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 0.0.0.0',
  'a=rtcp:9 IN IP4 0.0.0.0',
  'a=ice-ufrag:probeufrag',
  'a=ice-pwd:probepasswordprobepassword01',
  'a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00',
  'a=setup:actpass',
  'a=mid:0',
  'a=recvonly',
  'a=rtcp-mux',
  'a=rtpmap:111 opus/48000/2',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP4 0.0.0.0',
  'a=rtcp:9 IN IP4 0.0.0.0',
  'a=ice-ufrag:probeufrag',
  'a=ice-pwd:probepasswordprobepassword01',
  'a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00',
  'a=setup:actpass',
  'a=mid:1',
  'a=recvonly',
  'a=rtcp-mux',
  'a=rtpmap:96 H264/90000',
  '',
].join('\r\n');

interface StreamState {
  isLive: boolean;
  consecutiveMisses: number;
}

interface StorageData {
  messageId: string | null;
  streams: Array<{ username: string; bearerToken: string }>;
}

interface Command {
  name: string;
  description: string;
  usage: string;
  execute: (message: Message, args: string[]) => Promise<void>;
}

const streamTracker = new Map<string, StreamState>();
const commands = new Map<string, Command>();
let dashboardMessage: Message | null = null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/**
 * Storage helpers
 */
async function loadData(): Promise<StorageData> {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    const initialData: StorageData = {
      messageId: null,
      streams: DEFAULT_STREAMS,
    };
    await saveData(initialData);
    return initialData;
  }
}

async function saveData(data: StorageData): Promise<void> {
  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save data.json:', err);
  }
}

function initStreamState(token: string) {
  if (!streamTracker.has(token)) {
    streamTracker.set(token, {
      isLive: false,
      consecutiveMisses: 0,
    });
  }
}

/**
 * Checks if a stream is live via SSE
 */
async function checkStreamStatus(streamKey: string): Promise<boolean> {
  let location: string | null = null;

  try {
    const res = await fetch(`${BASE_URL}/api/whep`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${streamKey}`,
        'Content-Type': 'application/sdp',
      },
      body: PROBE_SDP,
      signal: AbortSignal.timeout(5000),
    });

    if (res.status !== 201 && res.status !== 200) {
      return false;
    }

    location = res.headers.get('Location');
    if (!location) return false;

    const sseUrl = `${BASE_URL}${location.replace('/api/whep/', '/api/sse/')}`;
    const sseRes = await fetch(sseUrl, {
      signal: AbortSignal.timeout(3000),
    });

    if (!sseRes.ok || !sseRes.body) {
      return false;
    }

    const reader = sseRes.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});

    if (!value) return false;

    const chunk = new TextDecoder().decode(value);
    const match = chunk.match(/data:\s*(\{.*\})/);
    if (match && match[1]) {
      const data = JSON.parse(match[1]);
      return Boolean(data.isOnline);
    }

    return false;
  } catch {
    return false;
  } finally {
    if (location) {
      const deleteUrl = location.startsWith('http') ? location : `${BASE_URL}${location}`;
      fetch(deleteUrl, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${streamKey}` },
      }).catch(() => {});
    }
  }
}

/**
 * Creates the single dashboard embed representing all monitored streams
 */
function buildDashboardEmbed(): EmbedBuilder {
  const anyLive = Array.from(streamTracker.values()).some((s) => s.isLive);

  const streamLines = STREAMS.map((stream) => {
    const state = streamTracker.get(stream.bearerToken);
    const isLive = state?.isLive ?? false;
    const watchUrl = `${BASE_URL}/${encodeURIComponent(stream.bearerToken)}`;

    if (isLive) {
      return `🟢 [**${stream.username}**](${watchUrl}) - \`${stream.bearerToken}\``;
    }
    return `⚫ **${stream.username}** - \`${stream.bearerToken}\``;
  }).join('\n');

  return new EmbedBuilder()
    .setTitle('📺 Broadcast Box')
    .setURL(BASE_URL)
    .setDescription(streamLines || 'No streams configured.')
    .setColor(anyLive ? '#0ddb29' : '#2b2b2b')
    .setTimestamp();
}

/**
 * Polls status for all streams and updates the dashboard message
 */
async function pollStreams(channel: TextChannel) {
  await Promise.all(
    STREAMS.map(async (stream) => {
      const key = stream.bearerToken;
      const state = streamTracker.get(key);
      if (!state) return;

      const isLive = await checkStreamStatus(key);

      if (isLive) {
        state.consecutiveMisses = 0;
        state.isLive = true;
      } else if (state.isLive) {
        state.consecutiveMisses++;
        if (state.consecutiveMisses >= 2) {
          state.isLive = false;
          state.consecutiveMisses = 0;
        }
      }
    })
  );

  const embed = buildDashboardEmbed();

  try {
    if (dashboardMessage) {
      await dashboardMessage.edit({ embeds: [embed] });
    } else {
      dashboardMessage = await channel.send({ embeds: [embed] });
      await saveData({ messageId: dashboardMessage.id, streams: STREAMS });
    }
  } catch (err) {
    console.warn('Could not edit dashboard message, recreating next cycle...', err);
    dashboardMessage = null;
  }
}

/**
 * Resolves the message to track on startup
 */
async function resolveDashboardMessage(channel: TextChannel, savedMessageId: string | null): Promise<Message> {
  if (savedMessageId) {
    try {
      const msg = await channel.messages.fetch(savedMessageId);
      if (msg) return msg;
    } catch {
      console.warn(`Stored message ID (${savedMessageId}) not found in channel.`);
    }
  }

  try {
    const recentMessages = await channel.messages.fetch({ limit: 1 });
    const lastMessage = recentMessages.first();
    if (lastMessage && lastMessage.author.id === client.user?.id) {
      console.log(`Reusing last channel message (${lastMessage.id}) as dashboard.`);
      return lastMessage;
    }
  } catch (err) {
    console.warn('Failed to fetch recent channel messages:', err);
  }

  console.log('No reusable dashboard message found. Sending a new one.');
  const initialEmbed = buildDashboardEmbed();
  return await channel.send({ embeds: [initialEmbed] });
}

/**
 * Command Registration
 */
function registerCommand(cmd: Command) {
  commands.set(cmd.name.toLowerCase(), cmd);
}

registerCommand({
  name: 'help',
  description: 'Shows this list of available commands.',
  usage: `${PREFIX}help`,
  execute: async (message) => {
    const embed = new EmbedBuilder()
      .setTitle('📖 Broadcast Box Commands')
      .setColor('#0099ff')
      .setDescription(
        Array.from(commands.values())
          .map((c) => `**\`${c.usage}\`**\n${c.description}`)
          .join('\n\n')
      )
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  },
});

registerCommand({
  name: 'new-message',
  description: 'Spawns a new live dashboard message in this channel.',
  usage: `${PREFIX}new-message`,
  execute: async (message) => {
    const channel = message.channel as TextChannel;
    const embed = buildDashboardEmbed();
    dashboardMessage = await channel.send({ embeds: [embed] });
    await saveData({ messageId: dashboardMessage.id, streams: STREAMS });
    await message.react('✅');
    await pollStreams(channel);
  },
});

registerCommand({
  name: 'add-stream',
  description: 'Adds a new stream to monitor.',
  usage: `${PREFIX}add-stream <username> <bearerToken>`,
  execute: async (message, args) => {
    if (args.length < 2) {
      await message.reply(`❌ Usage: \`${PREFIX}add-stream <username> <bearerToken>\``);
      return;
    }

    const [username, bearerToken] = args;
    const existing = STREAMS.find((s) => s.bearerToken === bearerToken);
    if (existing) {
      await message.reply(`❌ Stream with token \`${bearerToken}\` already exists (${existing.username}).`);
      return;
    }

    STREAMS.push({ username, bearerToken });
    initStreamState(bearerToken);
    await saveData({ messageId: dashboardMessage?.id ?? null, streams: STREAMS });

    await message.reply(`✅ Added stream for **${username}**.`);
    if (message.channel.id === CHANNEL_ID) {
      await pollStreams(message.channel as TextChannel);
    }
  },
});

registerCommand({
  name: 'remove-stream',
  description: 'Removes a stream by username or token.',
  usage: `${PREFIX}remove-stream <username|bearerToken>`,
  execute: async (message, args) => {
    if (args.length < 1) {
      await message.reply(`❌ Usage: \`${PREFIX}remove-stream <username|bearerToken>\``);
      return;
    }

    const target = args[0];
    const index = STREAMS.findIndex(
      (s) => s.bearerToken === target || s.username.toLowerCase() === target.toLowerCase()
    );

    if (index === -1) {
      await message.reply(`❌ No stream found matching \`${target}\`.`);
      return;
    }

    const [removed] = STREAMS.splice(index, 1);
    streamTracker.delete(removed.bearerToken);
    await saveData({ messageId: dashboardMessage?.id ?? null, streams: STREAMS });

    await message.reply(`✅ Removed stream **${removed.username}**.`);
    if (message.channel.id === CHANNEL_ID) {
      await pollStreams(message.channel as TextChannel);
    }
  },
});

interface ApiHoliday {
  data: string;
  nome: string;
  tipo: string;
  descricao?: string;
  bancario?: boolean;
}

function toIsoDate(ddmmyyyy: string): string {
  const [day, month, year] = ddmmyyyy.split('/');
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function formatHolidayDate(dateStr: string): string {
  const [d, m, y] = dateStr.split('/').map(Number);
  const date = new Date(y, m - 1, d);
  const weekday = date.toLocaleDateString('pt-BR', { weekday: 'long' });
  return `${dateStr} (${weekday.charAt(0).toUpperCase() + weekday.slice(1)})`;
}

async function fetchCityHolidays(year: number): Promise<ApiHoliday[]> {
  const res = await fetch(`https://feriadosapi.com/api/v1/feriados/cidade/3550308?ano=${year}&facultativos=true`, {
    headers: { Authorization: `Bearer ${FERIADOS_API_KEY}`, 'X-API-Key': FERIADOS_API_KEY || '' },
  });
  if (!res.ok) throw new Error(`API returned HTTP ${res.status}`);
  const data = await res.json();
  return data.feriados || [];
}

function deduplicateAndFilterFuture(holidays: ApiHoliday[], todayIso: string): ApiHoliday[] {
  const deduped = new Map<string, ApiHoliday>();
  for (const h of holidays) {
    if (toIsoDate(h.data) <= todayIso) continue;
    const existing = deduped.get(h.data);
    if (!existing || (existing.tipo === 'FACULTATIVO' && h.tipo !== 'FACULTATIVO')) {
      deduped.set(h.data, h);
    }
  }
  return Array.from(deduped.values()).sort((a, b) => toIsoDate(a.data).localeCompare(toIsoDate(b.data)));
}

registerCommand({
  name: 'feriado',
  description: 'Mostra o próximo feriado em São Paulo (capital).',
  usage: `${PREFIX}feriado`,
  execute: async (message) => {
    if (!FERIADOS_API_KEY) {
      await message.reply('❌ `FERIADOS_API_KEY` não está configurada no `.env`.');
      return;
    }

    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date());

      const year = parseInt(parts.find((p) => p.type === 'year')!.value, 10);
      const month = parts.find((p) => p.type === 'month')!.value;
      const day = parts.find((p) => p.type === 'day')!.value;
      const todayIso = `${year}-${month}-${day}`;

      let upcoming = deduplicateAndFilterFuture(await fetchCityHolidays(year), todayIso);

      const needsNextYear =
        upcoming.length === 0 || (upcoming[0].tipo === 'FACULTATIVO' && !upcoming.some((h) => h.tipo !== 'FACULTATIVO'));

      if (needsNextYear) {
        upcoming = [...upcoming, ...deduplicateAndFilterFuture(await fetchCityHolidays(year + 1), todayIso)];
      }

      if (upcoming.length === 0) {
        await message.reply('Nenhum próximo feriado encontrado.');
        return;
      }

      const selected: ApiHoliday[] = [upcoming[0]];
      if (upcoming[0].tipo === 'FACULTATIVO') {
        const nextOfficial = upcoming.find((h, idx) => idx > 0 && h.tipo !== 'FACULTATIVO');
        if (nextOfficial) selected.push(nextOfficial);
      }

      const embed = new EmbedBuilder()
        .setTitle(selected.length > 1 ? '🗓️ Próximos Feriados' : '🗓️ Próximo Feriado')
        .setColor('#0099ff')
        .setTimestamp();

      for (const h of selected) {
        const title = `${h.nome} - ${formatHolidayDate(h.data)}`;
        const details = [`**Tipo:** ${h.tipo}`, h.bancario ? '🏦 *Feriado Bancário*' : null, h.descricao || null]
          .filter(Boolean)
          .join('\n');
        embed.addFields({ name: title, value: details });
      }

      await message.reply({ embeds: [embed] });
    } catch (err) {
      console.error('Failed to fetch holiday data:', err);
      await message.reply('❌ Ocorreu um erro ao consultar os feriados.');
    }
  },
});

client.once(Events.ClientReady, async () => {
  console.log(`🤖 Logged in as ${client.user?.tag}!`);

  const savedData = await loadData();
  STREAMS = savedData.streams;
  STREAMS.forEach((s) => initStreamState(s.bearerToken));

  console.log(`👀 Monitoring streamers: ${STREAMS.map((s) => `${s.username} (${s.bearerToken})`).join(', ')}`);

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel || !(channel instanceof TextChannel)) {
      console.error(`❌ Channel ID ${CHANNEL_ID} is not a valid text channel.`);
      process.exit(1);
    }

    console.log(`📡 Connected to target channel: #${channel.name}`);

    dashboardMessage = await resolveDashboardMessage(channel, savedData.messageId);
    await saveData({ messageId: dashboardMessage.id, streams: STREAMS });

    await pollStreams(channel);
    setInterval(() => pollStreams(channel), POLL_INTERVAL_MS);
  } catch (err) {
    console.error('Error on startup:', err);
  }
});

/**
 * Message command dispatcher
 */
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const commandName = args.shift()?.toLowerCase();

  if (!commandName) return;

  const command = commands.get(commandName);
  if (!command) return;

  try {
    await command.execute(message, args);
  } catch (err) {
    console.error(`Error executing command !${commandName}:`, err);
    await message.reply('❌ An error occurred while executing this command.');
  }
});

client.login(TOKEN);