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
const BASE_URL = 'https://b.siobud.com';

const DEFAULT_STREAMS = [
  { username: 'Bruno', bearerToken: 'FSIauhwiuasdhiufhiusah913274y1273' },
  { username: 'Jão', bearerToken: 'eae' },
  { username: 'Andre', bearerToken: 'asdasdasdasdasdasdasdasdas' },
  { username: 'Fernandes', bearerToken: 'IPC' },
  { username: 'Soave', bearerToken: 'SODFGNDFGJUNDSFGJSDN43814871' },
  { username: 'Fab', bearerToken: 'sddse6cyrene' },
  { username: 'Vitor', bearerToken: 'Teste' },
  { username: 'Thiago', bearerToken: 'billibilli' },
];

let STREAMS: Array<{ username: string; bearerToken: string }> = [];

if (!TOKEN) {
  console.error('❌ Error: DISCORD_TOKEN is missing in .env');
  process.exit(1);
}

// Minimal standard WebRTC SDP Offer to initiate WHEP playback
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

interface ActiveStreamSession {
  abortController: AbortController;
  currentLocation: string | null;
}

const streamTracker = new Map<string, StreamState>();
const activeSessions = new Map<string, ActiveStreamSession>();
const commands = new Map<string, Command>();

let dashboardMessage: Message | null = null;
let activeChannel: TextChannel | null = null;
let updateDebounceTimeout: NodeJS.Timeout | null = null;

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
    streamTracker.set(token, { isLive: false });
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
 * Updates the Discord dashboard message
 */
async function updateDashboard(channel: TextChannel) {
  const embed = buildDashboardEmbed();
  try {
    if (dashboardMessage) {
      await dashboardMessage.edit({ embeds: [embed] });
    } else {
      dashboardMessage = await channel.send({ embeds: [embed] });
      await saveData({ messageId: dashboardMessage.id, streams: STREAMS });
    }
  } catch (err) {
    console.warn('Could not edit dashboard message, recreating on next update...', err);
    dashboardMessage = null;
  }
}

/**
 * Debounced dashboard updater to protect against Discord API rate limits
 */
function triggerDashboardUpdate() {
  if (updateDebounceTimeout) return;
  updateDebounceTimeout = setTimeout(async () => {
    updateDebounceTimeout = null;
    if (activeChannel) {
      await updateDashboard(activeChannel);
    }
  }, 1500);
}

function handleStatusChange(token: string, isLive: boolean) {
  const state = streamTracker.get(token);
  if (!state) return;

  if (state.isLive !== isLive) {
    state.isLive = isLive;
    triggerDashboardUpdate();
  }
}

/**
 * Long-lived SSE worker for a single stream with automatic reconnect
 */
async function runStreamSseWorker(token: string, session: ActiveStreamSession) {
  while (!session.abortController.signal.aborted) {
    let location: string | null = null;
    try {
      const res = await fetch(`${BASE_URL}/api/whep`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/sdp',
        },
        body: PROBE_SDP,
        signal: AbortSignal.any([session.abortController.signal, AbortSignal.timeout(10000)]),
      });

      if (!res.ok) {
        handleStatusChange(token, false);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      location = res.headers.get('Location');
      session.currentLocation = location;
      if (!location) {
        handleStatusChange(token, false);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      const ssePath = location.replace('/api/whep/', '/api/sse/');
      const sseUrl = location.startsWith('http') ? ssePath : `${BASE_URL}${ssePath}`;

      const sseRes = await fetch(sseUrl, {
        signal: session.abortController.signal,
      });

      if (!sseRes.ok || !sseRes.body) {
        handleStatusChange(token, false);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!session.abortController.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) {
            const payload = trimmed.slice(5).trim();
            try {
              const data = JSON.parse(payload);
              if (typeof data.isOnline === 'boolean') {
                handleStatusChange(token, data.isOnline);
              }
            } catch {
              // Ignore unparseable SSE lines
            }
          }
        }
      }
    } catch {
      handleStatusChange(token, false);
    } finally {
      if (location) {
        const deleteUrl = location.startsWith('http') ? location : `${BASE_URL}${location}`;
        fetch(deleteUrl, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
        session.currentLocation = null;
      }
    }

    if (!session.abortController.signal.aborted) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function startMonitoringStream(token: string) {
  if (activeSessions.has(token)) return;

  const session: ActiveStreamSession = {
    abortController: new AbortController(),
    currentLocation: null,
  };
  activeSessions.set(token, session);
  runStreamSseWorker(token, session);
}

function stopMonitoringStream(token: string) {
  const session = activeSessions.get(token);
  if (!session) return;

  session.abortController.abort();
  if (session.currentLocation) {
    const deleteUrl = session.currentLocation.startsWith('http')
      ? session.currentLocation
      : `${BASE_URL}${session.currentLocation}`;
    fetch(deleteUrl, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
  activeSessions.delete(token);
  streamTracker.delete(token);
}

function cleanupAllSessions() {
  for (const [token, session] of activeSessions.entries()) {
    session.abortController.abort();
    if (session.currentLocation) {
      const deleteUrl = session.currentLocation.startsWith('http')
        ? session.currentLocation
        : `${BASE_URL}${session.currentLocation}`;
      fetch(deleteUrl, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
  }
  activeSessions.clear();
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
 * Holiday Helpers
 */
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

/* Commands */
commands.set('help', {
  name: 'help',
  description: 'Shows this list of available commands.',
  usage: `${PREFIX}help`,
  execute: async (message) => {
    const uniqueCommands = Array.from(new Set(commands.values()));
    const embed = new EmbedBuilder()
      .setTitle('📖 Broadcast Box Commands')
      .setColor('#0099ff')
      .setDescription(uniqueCommands.map((c) => `**\`${c.usage}\`**\n${c.description}`).join('\n\n'))
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  },
});

commands.set('new-message', {
  name: 'new-message',
  description: 'Spawns a new live dashboard message in this channel.',
  usage: `${PREFIX}new-message`,
  execute: async (message) => {
    const channel = message.channel as TextChannel;
    activeChannel = channel;
    const embed = buildDashboardEmbed();
    dashboardMessage = await channel.send({ embeds: [embed] });
    await saveData({ messageId: dashboardMessage.id, streams: STREAMS });
    await message.react('✅');
    await updateDashboard(channel);
  },
});

commands.set('add-stream', {
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
    startMonitoringStream(bearerToken);
    await saveData({ messageId: dashboardMessage?.id ?? null, streams: STREAMS });

    await message.reply(`✅ Added stream for **${username}**.`);
    if (activeChannel) {
      await updateDashboard(activeChannel);
    }
  },
});

commands.set('remove-stream', {
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
    stopMonitoringStream(removed.bearerToken);
    await saveData({ messageId: dashboardMessage?.id ?? null, streams: STREAMS });

    await message.reply(`✅ Removed stream **${removed.username}**.`);
    if (activeChannel) {
      await updateDashboard(activeChannel);
    }
  },
});

const holidayCommand: Command = {
  name: 'holiday',
  description: 'Mostra o próximo feriado em São Paulo (capital).',
  usage: `${PREFIX}holiday | ${PREFIX}next-holiday`,
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
};

commands.set('holiday', holidayCommand);
commands.set('next-holiday', holidayCommand);

/**
 * Startup
 */
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

    activeChannel = channel;
    console.log(`📡 Connected to target channel: #${channel.name}`);

    dashboardMessage = await resolveDashboardMessage(channel, savedData.messageId);
    await saveData({ messageId: dashboardMessage.id, streams: STREAMS });

    // Start persistent SSE listeners for all registered streams
    STREAMS.forEach((s) => startMonitoringStream(s.bearerToken));
    await updateDashboard(channel);
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

process.on('SIGINT', () => {
  cleanupAllSessions();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanupAllSessions();
  process.exit(0);
});

client.login(TOKEN);