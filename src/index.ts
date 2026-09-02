import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  TextChannel,
  Events,
} from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID || '532676295939850250';

const STREAMS = [
  { username: "Bruno", bearerToken: "FSIauhwiuasdhiufhiusah913274y1273" },
  { username: "Jão", bearerToken: "eae" },
  { username: "Andre", bearerToken: "asdasdasdasdasdasdasdasdas" },
  { username: "Fernandes", bearerToken: "IPC" },
  { username: "Soave", bearerToken: "SODFGNDFGJUNDSFGJSDN43814871" },
  { username: "Fab", bearerToken: "sddse6cyrene" },
  { username: "Vitor", bearerToken: "Teste" },
  { username: "Thiago", bearerToken: "billibilli" },
];

const POLL_INTERVAL_MS = 15_000;
const BASE_URL = 'https://b.siobud.com';

if (!TOKEN) {
  console.error('❌ Error: DISCORD_TOKEN is missing in .env');
  process.exit(1);
}

if (STREAMS.length === 0) {
  console.error('❌ Error: No streams configured in STREAMS array.');
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
  messageId: string | null;
  consecutiveMisses: number;
}

const streamTracker = new Map<string, StreamState>();

for (const stream of STREAMS) {
  streamTracker.set(stream.bearerToken, {
    isLive: false,
    messageId: null,
    consecutiveMisses: 0,
  });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

/**
 * Checks if a stream is live by checking the SSE status event
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

    // Connect to the SSE endpoint to get the real-time status JSON
    const sseUrl = `${BASE_URL}${location.replace('/api/whep/', '/api/sse/')}`;
    const sseRes = await fetch(sseUrl, {
      signal: AbortSignal.timeout(3000),
    });

    if (!sseRes.ok || !sseRes.body) {
      return false;
    }

    const reader = sseRes.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {}); // Close reader immediately

    if (!value) return false;

    const chunk = new TextDecoder().decode(value);

    // Extract JSON payload from "data: {...}"
    const match = chunk.match(/data:\s*(\{.*\})/);
    if (match && match[1]) {
      const data = JSON.parse(match[1]);
      return Boolean(data.isOnline);
    }

    return false;
  } catch {
    return false;
  } finally {
    // Always clean up the WHEP session
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
 * Polling loop for all stream keys
 */
async function pollStreams(channel: TextChannel) {
  for (const stream of STREAMS) {
    const key = stream.bearerToken;
    const state = streamTracker.get(key);
    if (!state) continue;

    const isLive = await checkStreamStatus(key);

    if (isLive) {
      state.consecutiveMisses = 0;

      if (!state.isLive) {
        state.isLive = true;
        const watchUrl = `${BASE_URL}/${encodeURIComponent(key)}`;
        const username = stream.username;

        const embed = new EmbedBuilder()
          .setTitle(`🟢 ${username} is now LIVE!`)
          .setURL(watchUrl)
          .setDescription(`Watch the stream directly on Broadcast Box: [Click here to Watch](${watchUrl})`)
          .setColor('#0ddb29')
          .addFields(
            { name: 'Streamer', value: username, inline: true },
            { name: 'Stream Key', value: `\`${key}\``, inline: true },
            { name: 'Platform', value: 'Broadcast Box', inline: true }
          )
          .setTimestamp();

        try {
          const sentMessage = await channel.send({ embeds: [embed] });
          state.messageId = sentMessage.id;
          console.log(`[LIVE] ${username} (${key}) is live. Alert posted (Message ID: ${sentMessage.id})`);
        } catch (err) {
          console.error(`Failed to send alert for ${username} (${key}):`, err);
        }
      }
    } else {
      if (state.isLive) {
        state.consecutiveMisses++;

        // Debounce: requires 2 consecutive offline checks (~30s) before deleting alert
        if (state.consecutiveMisses >= 2) {
          state.isLive = false;
          console.log(`[OFFLINE] ${stream.username} (${key}) has ended.`);

          if (state.messageId) {
            try {
              const msg = await channel.messages.fetch(state.messageId);
              if (msg) {
                await msg.delete();
                console.log(`[CLEANUP] Deleted live alert message for ${stream.username}`);
              }
            } catch (err) {
              console.warn(`Could not delete message for ${stream.username} (might already be deleted):`, err);
            } finally {
              state.messageId = null;
            }
          }
          state.consecutiveMisses = 0;
        }
      }
    }
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`🤖 Logged in as ${client.user?.tag}!`);
  console.log(`👀 Monitoring streamers: ${STREAMS.map((s) => `${s.username} (${s.bearerToken})`).join(', ')}`);

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel || !(channel instanceof TextChannel)) {
      console.error(`❌ Channel ID ${CHANNEL_ID} is not a valid text channel.`);
      process.exit(1);
    }

    console.log(`📡 Connected to target channel: #${channel.name}`);

    // Send startup notification to Discord showing configured streamers
    const onlineEmbed = new EmbedBuilder()
      .setTitle('🟢 Stream Monitor Online')
      .setDescription(
        `Bot is now monitoring **${STREAMS.length}** streamer(s):\n` +
          STREAMS.map((s) => `• **${s.username}** (\`${s.bearerToken}\`)`).join('\n')
      )
      .setColor('#57F287')
      .setTimestamp();

    await channel.send({ embeds: [onlineEmbed] });

    // Initial check and start polling loop
    await pollStreams(channel);
    setInterval(() => pollStreams(channel), POLL_INTERVAL_MS);
  } catch (err) {
    console.error('Error on startup:', err);
  }
});

client.login(TOKEN);