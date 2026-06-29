/**
 * WhatsApp MD Bot - Main Entry Point
 */
process.env.PUPPETEER_SKIP_DOWNLOAD = 'true';
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';
process.env.PUPPETEER_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || '/tmp/puppeteer_cache_disabled';

const { initializeTempSystem } = require('./utils/tempManager');
const { startCleanup } = require('./utils/cleanup');
initializeTempSystem();
startCleanup();
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

const forbiddenPatternsConsole = [
  'closing session',
  'closing open session',
  'sessionentry',
  'prekey bundle',
  'pendingprekey',
  '_chains',
  'registrationid',
  'currentratchet',
  'chainkey',
  'ratchet',
  'signal protocol',
  'ephemeralkeypair',
  'indexinfo',
  'basekey'
];

console.log = (...args) => {
  const message = args.map(a => typeof a === 'string' ? a : typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ').toLowerCase();
  if (!forbiddenPatternsConsole.some(pattern => message.includes(pattern))) {
    originalConsoleLog.apply(console, args);
  }
};

console.error = (...args) => {
  const message = args.map(a => typeof a === 'string' ? a : typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ').toLowerCase();
  if (!forbiddenPatternsConsole.some(pattern => message.includes(pattern))) {
    originalConsoleError.apply(console, args);
  }
};

console.warn = (...args) => {
  const message = args.map(a => typeof a === 'string' ? a : typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ').toLowerCase();
  if (!forbiddenPatternsConsole.some(pattern => message.includes(pattern))) {
    originalConsoleWarn.apply(console, args);
  }
};

// Now safe to load libraries
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const handler = require('./handler');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');

// ===== 🆕 NEW FEATURE: Anti-View-Once =====
const { downloadContentFromMessage, getContentType } = require('@whiskeysockets/baileys');

async function handleAntiViewOnce(sock, message) {
  try {
    if (!message.message) return;
    const vv = message.message.viewOnceMessageV2 || message.message.viewOnceMessage;
    if (!vv) return;
    
    const content = vv.message;
    const mtype = Object.keys(content).find(t =>
      ['imageMessage', 'videoMessage', 'audioMessage'].includes(t)
    );
    if (!mtype) return;

    const media = content[mtype];
    const stream = await downloadContentFromMessage(media, mtype.replace('Message', ''));
    let buf = Buffer.from([]);
    for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);

    const payload = {};
    if (mtype === 'imageMessage') { payload.image = buf; payload.caption = media.caption || ''; }
    else if (mtype === 'videoMessage') { payload.video = buf; payload.caption = media.caption || ''; }
    else if (mtype === 'audioMessage') { payload.audio = buf; payload.ptt = !!media.ptt; }

    await sock.sendMessage(message.key.remoteJid, payload, { quoted: message.key });
    console.log('[AV] View-once captured:', mtype);
  } catch (e) {
    // Silent fail - don't spam logs
  }
}
// ===== END ANTI-VIEW-ONCE =====

// ===== 🆕 NEW FEATURE: Emoji Cycling Animation =====
const emojiCategories = {
  love: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💗', '💖', '💝', '💕', '💓', '💞', '💘', '🫶', '🥰', '😍'],
  smile: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '🥰', '😘', '😋', '😛', '😜', '🤪'],
  sad: ['😢', '😭', '😿', '🥺', '😔', '😞', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥱'],
  angry: ['😠', '😡', '🤬', '👿', '💢', '🗯️', '💥', '🔥', '😤', '😣'],
  party: ['🎉', '🎊', '🎈', '🎁', '🥳', '🎂', '🍾', '🥂', '🎶', '🎵', '💃', '🕺', '✨', '🌟', '🎆', '🎇', '🧨'],
  fire: ['🔥', '💥', '✨', '⭐', '🌟', '💫', '🎇', '🎆', '🧨', '⚡'],
  wave: ['👋', '🙋', '🖐️', '✋', '🤚', '🤙', '👐', '🙌', '👏', '🤝'],
  laugh: ['😂', '🤣', '😹', '😆', '😁', '😄', '😃', '🤭', '😜', '😛', '🤪'],
  cry: ['😭', '😢', '🥺', '😿', '😔', '😞', '😟', '😕', '🙁', '☹️'],
  food: ['🍕', '🍔', '🌭', '🥪', '🌮', '🌯', '🥙', '🧆', '🥗', '🍟', '🍗', '🥩', '🍖', '🥓', '🍳', '🧇', '🥞', '🍝', '🍜', '🍣']
};

async function sendEmojiCycle(sock, jid, emojis, interval = 700, quoted = null) {
  try {
    const sentMsg = await sock.sendMessage(jid, { text: emojis[0] }, { quoted });
    const key = sentMsg.key;
    for (let i = 1; i < emojis.length; i++) {
      await new Promise(resolve => setTimeout(resolve, interval));
      await sock.sendMessage(jid, { text: emojis[i], edit: key });
    }
    return key;
  } catch (e) {
    console.error('[EmojiCycle] Error:', e.message);
  }
}
// ===== END EMOJI CYCLING =====

// ===== 🆕 NEW FEATURE: Auto-Status Reply =====
const statusReplies = [
  'Nice status! 🔥',
  'Love this! 💯',
  'Awesome status! ✨',
  'Cool! 😎',
  'Great vibe! 🙌'
];

async function handleStatusReply(sock, msg) {
  try {
    if (!config.autoStatusReply) return;
    if (!msg.key.remoteJid?.includes('status@broadcast')) return;
    if (msg.key.fromMe) return;
    
    const reply = statusReplies[Math.floor(Math.random() * statusReplies.length)];
    await sock.sendMessage(msg.key.remoteJid, { text: reply }, { quoted: msg.key });
    console.log('[Status] Auto-replied to status');
  } catch (e) {
    // Silent
  }
}
// ===== END AUTO-STATUS REPLY =====

// ===== 🆕 NEW FEATURE: Auto-Welcome for Groups =====
async function handleGroupWelcome(sock, update) {
  try {
    if (!config.autoWelcome) return;
    const { id, participants, action } = update;
    if (action !== 'add') return;
    
    for (const participant of participants) {
      const welcomeText = `👋 Welcome *@${participant.split('@')[0]}* to the group!\n\nPlease read the group rules and enjoy! 🎉`;
      await sock.sendMessage(id, { 
        text: welcomeText,
        mentions: [participant]
      });
      console.log('[Welcome] New member joined:', participant.split('@')[0]);
    }
  } catch (e) {
    // Silent
  }
}
// ===== END AUTO-WELCOME =====

// Remove Puppeteer cache (if some dependency downloaded Chromium into ~/.cache/puppeteer)
function cleanupPuppeteerCache() {
  try {
    const home = os.homedir();
    const cacheDir = path.join(home, '.cache', 'puppeteer');

    if (fs.existsSync(cacheDir)) {
      console.log('🧹 Removing Puppeteer cache at:', cacheDir);
      fs.rmSync(cacheDir, { recursive: true, force: true });
      console.log('✅ Puppeteer cache removed');
    }
  } catch (err) {
    console.error('⚠️ Failed to cleanup Puppeteer cache:', err.message || err);
  }
}
// Optimized in-memory store with hard limits (Map-based for better memory management)
const store = {
  messages: new Map(), // Use Map instead of plain object
  maxPerChat: 20, // Limit to 20 messages per chat

  bind: (ev) => {
    ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        if (!msg.key?.id) continue;

        const jid = msg.key.remoteJid;
        if (!store.messages.has(jid)) {
          store.messages.set(jid, new Map());
        }

        const chatMsgs = store.messages.get(jid);
        chatMsgs.set(msg.key.id, msg);

        // Aggressive cleanup per chat - keep only recent messages
        if (chatMsgs.size > store.maxPerChat) {
          // Remove oldest message (first entry in Map)
          const oldestKey = chatMsgs.keys().next().value;
          chatMsgs.delete(oldestKey);
        }
      }
    });
  },

  loadMessage: async (jid, id) => {
    return store.messages.get(jid)?.get(id) || null;
  }
};

// Optimized message deduplication (Set-based, no timestamps needed)
const processedMessages = new Set();

// Aggressive cleanup - clear every 5 minutes
setInterval(() => {
  processedMessages.clear();
}, 5 * 60 * 1000); // Every 5 minutes

// Custom Pino logger with suppression for Baileys noise
const createSuppressedLogger = (level = 'silent') => {
  const forbiddenPatterns = [
    'closing session',
    'closing open session',
    'sessionentry',
    'prekey bundle',
    'pendingprekey',
    '_chains',
    'registrationid',
    'currentratchet',
    'chainkey',
    'ratchet',
    'signal protocol',
    'ephemeralkeypair',
    'indexinfo',
    'basekey',
    'sessionentry',
    'ratchetkey'
  ];

  let logger;
  try {
    logger = pino({
      level,
      // Fallback transport without pino-pretty (in case not installed)
      transport: process.env.NODE_ENV === 'production' ? undefined : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          ignore: 'pid,hostname'
        }
      },
      customLevels: {
        trace: 0,
        debug: 1,
        info: 2,
        warn: 3,
        error: 4,
        fatal: 5
      },
      // Redact sensitive fields
      redact: ['registrationId', 'ephemeralKeyPair', 'rootKey', 'chainKey', 'baseKey']
    });
  } catch (err) {
    // Fallback to basic pino without transport
    logger = pino({ level });
  }

  // Wrap log methods to filter
  const originalInfo = logger.info.bind(logger);
  logger.info = (...args) => {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').toLowerCase();
    if (!forbiddenPatterns.some(pattern => msg.includes(pattern))) {
      originalInfo(...args);
    }
  };
  logger.debug = () => { }; // Fully disable debug
  logger.trace = () => { }; // Fully disable trace
  return logger;
};

// Main connection function
async function startBot() {
  const sessionFolder = `./${config.sessionName}`;
  const sessionFile = path.join(sessionFolder, 'creds.json');

  // Check if sessionID is provided and process AURAEN! format session
  if (config.sessionID && config.sessionID.startsWith('AURAEN!')) {
    try {
      const [header, b64data] = config.sessionID.split('!');

      if (header !== 'AURAEN' || !b64data) {
        throw new Error("❌ Invalid session format. Expected 'AURAEN!.....'");
      }

      const cleanB64 = b64data.replace('...', '');
      const compressedData = Buffer.from(cleanB64, 'base64');
      const decompressedData = zlib.gunzipSync(compressedData);

      // Ensure session folder exists
      if (!fs.existsSync(sessionFolder)) {
        fs.mkdirSync(sessionFolder, { recursive: true });
      }

      // Write decompressed session data to creds.json
      fs.writeFileSync(sessionFile, decompressedData, 'utf8');
      console.log('📡 Session : 🔑 Retrieved from AURAEN Session');

    } catch (e) {
      console.error('📡 Session : ❌ Error processing AURAEN session:', e.message);
      // Continue with normal QR flow if session processing fails
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const { version } = await fetchLatestBaileysVersion();

  // Use suppressed logger for socket
  const suppressedLogger = createSuppressedLogger('silent');

  const sock = makeWASocket({
    version, // explicit WA Web version negotiated with the server
    logger: suppressedLogger,
    printQRInTerminal: false,
    // Use a common desktop browser signature
    browser: ['Chrome', 'Windows', '10.0'],
    auth: state,
    // Memory optimization: prevent loading old messages into RAM
    syncFullHistory: false,
    downloadHistory: false,
    markOnlineOnConnect: false,
    getMessage: async () => undefined // Don't load messages from store
  });

  // Bind store to socket
  store.bind(sock.ev);

  // Watchdog for inactive socket (Baileys bug fix)
  let lastActivity = Date.now();
  const INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  // Update on every message
  sock.ev.on('messages.upsert', () => {
    lastActivity = Date.now();
  });

  // Check every 5 min
  const watchdogInterval = setInterval(async () => {
    if (Date.now() - lastActivity > INACTIVITY_TIMEOUT && sock.ws.readyState === 1) { // WebSocket open but inactive
      console.log('⚠️ No activity detected. Forcing reconnect...');
      await sock.end(undefined, undefined, { reason: 'inactive' });
      clearInterval(watchdogInterval);
      setTimeout(() => startBot(), 5000); // Slightly longer delay
    }
  }, 5 * 60 * 1000); // Every 5 min check

  // Clear on close/open
  sock.ev.on('connection.update', (update) => {
    const { connection } = update;
    if (connection === 'open') {
      lastActivity = Date.now(); // Reset on open
    } else if (connection === 'close') {
      clearInterval(watchdogInterval);
    }
  });

  // Connection update handler
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n\n📱 Scan this QR code with WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message || 'Unknown error';

      // Suppress verbose error output for common stream errors (515, etc.)
      if (statusCode === 515 || statusCode === 503 || statusCode === 408) {
        console.log(`⚠️ Connection closed (${statusCode}). Reconnecting...`);
      } else {
        console.log('Connection closed due to:', errorMessage, '\nReconnecting:', shouldReconnect);
      }

      if (shouldReconnect) {
        setTimeout(() => startBot(), 3000);
      }
    } else if (connection === 'open') {
      console.log('\n✅ Bot connected successfully!');
      console.log(`📱 Bot Number: ${sock.user.id.split(':')[0]}`);
      console.log(`🤖 Bot Name: ${config.botName}`);
      console.log(`⚡ Prefix: ${config.prefix}`);
      const ownerNames = Array.isArray(config.ownerName) ? config.ownerName.join(',') : config.ownerName;
      console.log(`👑 Owner: ${ownerNames}\n`);
      console.log('Bot is ready to receive messages!\n');

      // Set bot status
      if (config.autoBio) {
        await sock.updateProfileStatus(`${config.botName} | Active 24/7`);
      }

      // Initialize anti-call feature
      handler.initializeAntiCall(sock);

      // Cleanup old chats (keep only active ones, e.g., last touched <1 day)
      const now = Date.now();
      for (const [jid, chatMsgs] of store.messages.entries()) {
        const timestamps = Array.from(chatMsgs.values()).map(m => m.messageTimestamp * 1000 || 0);
        if (timestamps.length > 0 && now - Math.max(...timestamps) > 24 * 60 * 60 * 1000) { // 1 day old chat
          store.messages.delete(jid);
        }
      }
      console.log(`🧹 Store cleaned. Active chats: ${store.messages.size}`);
    }
  });

  // Credentials update handler
  sock.ev.on('creds.update', saveCreds);

  // System JID filter - checks if JID is from broadcast/status/newsletter
  const isSystemJid = (jid) => {
    if (!jid) return true;
    return jid.includes('@broadcast') ||
      jid.includes('status.broadcast') ||
      jid.includes('@newsletter') ||
      jid.includes('@newsletter.');
  };

  // Messages handler - Process only new messages
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    // Only process "notify" type (new messages), skip "append" (old messages from history)
    if (type !== 'notify') return;

    // Process messages in the array
    for (const msg of messages) {
      // Skip if message is invalid or missing key
      if (!msg.message || !msg.key?.id) continue;

      const from = msg.key.remoteJid;
      if (!from) {
        continue;
      }

      // System message filter - ignore broadcast/status/newsletter messages
      if (isSystemJid(from)) {
        continue; // Silently ignore system messages
      }

      // Deduplication: Skip if message has already been processed
      const msgId = msg.key.id;
      if (processedMessages.has(msgId)) continue;

      // Timestamp validation: Only process messages within last 5 minutes
      const MESSAGE_AGE_LIMIT = 5 * 60 * 1000; // 5 minutes in milliseconds
      let messageAge = 0;
      if (msg.messageTimestamp) {
        messageAge = Date.now() - (msg.messageTimestamp * 1000);
        if (messageAge > MESSAGE_AGE_LIMIT) {
          // Message is too old, skip processing
          continue;
        }
      }

      // Mark message as processed
      processedMessages.add(msgId);

      // ===== 🆕 ANTI-VIEW-ONCE: Run FIRST before anything else =====
      handleAntiViewOnce(sock, msg).catch(() => {});
      
      // ===== 🆕 AUTO-STATUS REPLY =====
      handleStatusReply(sock, msg).catch(() => {});

      // ===== 🆕 EMOJI COMMAND HANDLER =====
      const messageText = 
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        '';

      if (messageText.startsWith(config.prefix)) {
        const args = messageText.slice(config.prefix.length).trim().split(/ +/);
        const cmd = args.shift()?.toLowerCase();

        // Emoji cycling commands
        if (cmd === 'love' || cmd === 'heart') {
          sendEmojiCycle(sock, from, emojiCategories.love, 700, msg.key);
          continue;
        } else if (cmd === 'smile') {
          sendEmojiCycle(sock, from, emojiCategories.smile, 700, msg.key);
          continue;
        } else if (cmd === 'sad') {
          sendEmojiCycle(sock, from, emojiCategories.sad, 700, msg.key);
          continue;
        } else if (cmd === 'angry') {
          sendEmojiCycle(sock, from, emojiCategories.angry, 700, msg.key);
          continue;
        } else if (cmd === 'party') {
          sendEmojiCycle(sock, from, emojiCategories.party, 700, msg.key);
          continue;
        } else if (cmd === 'fire') {
          sendEmojiCycle(sock, from, emojiCategories.fire, 700, msg.key);
          continue;
        } else if (cmd === 'wave') {
          sendEmojiCycle(sock, from, emojiCategories.wave, 700, msg.key);
          continue;
        } else if (cmd === 'laugh') {
          sendEmojiCycle(sock, from, emojiCategories.laugh, 700, msg.key);
          continue;
        } else if (cmd === 'cry') {
          sendEmojiCycle(sock, from, emojiCategories.cry, 700, msg.key);
          continue;
        } else if (cmd === 'food') {
          sendEmojiCycle(sock, from, emojiCategories.food, 700, msg.key);
          continue;
        } else if (cmd === 'emoji') {
          const category = args[0]?.toLowerCase() || 'love';
          if (emojiCategories[category]) {
            sendEmojiCycle(sock, from, emojiCategories[category], 700, msg.key);
          } else {
            sock.sendMessage(from, { 
              text: `❌ Category "${category}" not found.\n\nAvailable: ${Object.keys(emojiCategories).join(', ')}` 
            }, { quoted: msg.key });
          }
          continue;
        }
      }

      // Store message FIRST (before processing)
      if (msg.key && msg.key.id) {
        if (!store.messages.has(from)) {
          store.messages.set(from, new Map());
        }
        const chatMsgs = store.messages.get(from);
        chatMsgs.set(msg.key.id, msg);

        // Cleanup: Keep only last 20 per chat (reduced from 200)
        if (chatMsgs.size > store.maxPerChat) {
          // Remove oldest messages
          const sortedIds = Array.from(chatMsgs.entries())
            .sort((a, b) => (a[1].messageTimestamp || 0) - (b[1].messageTimestamp || 0))
            .map(([id]) => id);
          for (let i = 0; i < sortedIds.length - store.maxPerChat; i++) {
            chatMsgs.delete(sortedIds[i]);
          }
        }
      }

      // Process command IMMEDIATELY (don't block on other operations)
      handler.handleMessage(sock, msg).catch(err => {
        if (!err.message?.includes('rate-overlimit') &&
          !err.message?.includes('not-authorized')) {
          console.error('Error handling message:', err.message);
        }
      });

      // Do other operations in background (non-blocking)
      setImmediate(async () => {
        if (config.autoRead && from.endsWith('@g.us')) {
          try {
            await sock.readMessages([msg.key]);
          } catch (e) {
            // Silently handle
          }
        }
        if (from.endsWith('@g.us')) {
          try {
            const groupMetadata = await handler.getGroupMetadata(sock, msg.key.remoteJid);
            if (groupMetadata) {
              await handler.handleAntilink(sock, msg, groupMetadata);
            }
          } catch (error) {
            // Silently handle
          }
        }
      });
    }
  });

  // Message receipt updates (silently handled, no logging)
  sock.ev.on('message-receipt.update', () => {
    // Silently handle receipt updates
  });

  // Message updates (silently handled, no logging)
  sock.ev.on('messages.update', () => {
    // Silently handle message updates
  });

  // Group participant updates (join/leave)
  sock.ev.on('group-participants.update', async (update) => {
    await handler.handleGroupUpdate(sock, update);
    // ===== 🆕 AUTO-WELCOME =====
    await handleGroupWelcome(sock, update);
  });

  // Handle errors - suppress common stream errors
  sock.ev.on('error', (error) => {
    const statusCode = error?.output?.statusCode;
    // Suppress verbose output for common stream errors
    if (statusCode === 515 || statusCode === 503 || statusCode === 408) {
      // These are usually temporary connection issues, handled by reconnection
      return;
    }
    console.error('Socket error:', error.message || error);
  });

  return sock;
}
// Start the bot
console.log('🚀 Starting WhatsApp MD Bot...\n');
console.log(`📦 Bot Name: ${config.botName}`);
console.log(`⚡ Prefix: ${config.prefix}`);
const ownerNames = Array.isArray(config.ownerName) ? config.ownerName.join(',') : config.ownerName;
console.log(`👑 Owner: ${ownerNames}\n`);

// Proactively delete Puppeteer cache so it doesn't fill disk on panels
cleanupPuppeteerCache();

startBot().catch(err => {
  console.error('Error starting bot:', err);
  process.exit(1);
});
// Handle process termination
process.on('uncaughtException', (err) => {
  // Handle ENOSPC errors gracefully without crashing
  if (err.code === 'ENOSPC' || err.errno === -28 || err.message?.includes('no space left on device')) {
    console.error('⚠️ ENOSPC Error: No space left on device. Attempting cleanup...');
    const { cleanupOldFiles } = require('./utils/cleanup');
    cleanupOldFiles();
    console.warn('⚠️ Cleanup completed. Bot will continue but may experience issues until space is freed.');
    return; // Don't crash, just log and continue
  }
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (err) => {
  // Handle ENOSPC errors gracefully
  if (err.code === 'ENOSPC' || err.errno === -28 || err.message?.includes('no space left on device')) {
    console.warn('⚠️ ENOSPC Error in promise: No space left on device. Attempting cleanup...');
    const { cleanupOldFiles } = require('./utils/cleanup');
    cleanupOldFiles();
    console.warn('⚠️ Cleanup completed. Bot will continue but may experience issues until space is freed.');
    return; // Don't crash, just log and continue
  }

  // Don't spam console with rate limit errors
  if (err.message && err.message.includes('rate-overlimit')) {
    console.warn('⚠️ Rate limit reached. Please slow down your requests.');
    return;
  }
  console.error('Unhandled Rejection:', err);
});
// Export store for use in commands
module.exports = { store };
