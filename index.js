// ============================================================
//  APEX-MD  ·  Main Entry Point
//  WhatsApp Multi-Device Bot — 2026 Edition
//  Built on @whiskeysockets/baileys
// ============================================================

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');

const config = require('./config');
const logger = require('./lib/logger');
const db = require('./lib/database');
const { handleMessage, loadCommands } = require('./lib/handler');

// ── Splash screen ────────────────────────────────────────────
console.log(`
╔══════════════════════════════════════════╗
║       ⚡  APEX-MD  WhatsApp Bot  ⚡       ║
║         v${config.BOT_VERSION}  |  2026 Edition          ║
║   The most advanced MD bot ever built    ║
╚══════════════════════════════════════════╝
`);

// ── Bootstrap ────────────────────────────────────────────────
async function startBot() {

  // Load command modules
  loadCommands();

  // Connect to database
  await db.connect();

  // Ensure session directory exists
  if (!fs.existsSync(config.SESSION_DIR)) {
    fs.mkdirSync(config.SESSION_DIR, { recursive: true });
  }

  // Baileys authentication state
  const { state, saveCreds } =
    await useMultiFileAuthState(config.SESSION_DIR);

  // ──────────────────────────────────────────────────────────
  // PIN WHATSAPP WEB VERSION
  // Avoid automatic version-fetch failure on Railway
  // ──────────────────────────────────────────────────────────
  const version = [2, 3000, 1042466098];

  logger.info(
    `[Boot] Using WhatsApp Web v${version.join('.')}`
  );

  // ── Create socket ─────────────────────────────────────────
  const sock = makeWASocket({
    version,

    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(
        state.keys,
        pino({ level: 'silent' })
      ),
    },

    printQRInTerminal: false,

    logger: pino({
      level: 'silent',
    }),

    browser: [
      'APEX-MD',
      'Chrome',
      '120.0.0',
    ],

    markOnlineOnConnect: true,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
  });

  // ── QR / CONNECTION ───────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {

    const {
      connection,
      lastDisconnect,
      qr,
    } = update;

    // Show QR code
    if (qr) {
      console.log(
        '\n📱 Scan this QR code with WhatsApp:\n' +
        'Linked Devices > Link a device\n'
      );

      qrcode.generate(qr, {
        small: true,
      });
    }

    // Connection closed
    if (connection === 'close') {

      const code =
        lastDisconnect?.error?.output?.statusCode;

      const reason =
        lastDisconnect?.error?.output?.payload?.error;

      const loggedOut =
        code === DisconnectReason.loggedOut;

      logger.warn(
        `[Connection] Closed. Code: ${code} | Reason: ${reason}`
      );

      if (loggedOut) {

        logger.error(
          '[Connection] Logged out! Delete ./session folder and restart.'
        );

        process.exit(1);

      } else {

        logger.info(
          '[Connection] Reconnecting in 5s...'
        );

        setTimeout(startBot, 5000);
      }
    }

    // Successfully connected
    if (connection === 'open') {

      logger.info(
        `[Connection] ✅ APEX-MD is online! Logged in as ${sock.user?.id}`
      );

      await sock.sendMessage(
        config.OWNER_NUMBER + '@s.whatsapp.net',
        {
          text:
            `⚡ *APEX-MD Online!*\n` +
            `Version: ${config.BOT_VERSION}\n` +
            `Prefix: ${config.BOT_PREFIX}\n` +
            `Mode: ${
              config.PUBLIC_MODE
                ? 'Public'
                : 'Private'
            }\n\n` +
            `Type ${config.BOT_PREFIX}help to see commands.`,
        }
      ).catch(() => {});
    }
  });

  // ── Save credentials ──────────────────────────────────────
  sock.ev.on(
    'creds.update',
    saveCreds
  );

  // ── Group participant events ──────────────────────────────
  sock.ev.on(
    'group-participants.update',
    async (event) => {

      const {
        id,
        participants,
        action,
      } = event;

      if (
        !['add', 'remove'].includes(action)
      ) {
        return;
      }

      const groupData =
        await db.getGroup(id);

      for (const jid of participants) {

        const name =
          jid.split('@')[0];

        const meta =
          await sock
            .groupMetadata(id)
            .catch(() => null);

        if (
          action === 'add' &&
          groupData.welcome
        ) {

          const welcome =
            (
              groupData.welcomeMsg ||
              `Welcome to {group}, @{user}! 👋`
            )
              .replace(
                '{group}',
                meta?.subject || 'the group'
              )
              .replace(
                '{user}',
                name
              );

          await sock.sendMessage(
            id,
            {
              text: welcome,
              mentions: [jid],
            }
          );
        }

        if (
          action === 'remove' &&
          groupData.goodbye
        ) {

          await sock.sendMessage(
            id,
            {
              text:
                `👋 @${name} has left the group.`,
              mentions: [jid],
            }
          );
        }
      }
    }
  );

  // ── Incoming messages ─────────────────────────────────────
  sock.ev.on(
    'messages.upsert',
    async ({ messages, type }) => {

      if (type !== 'notify') {
        return;
      }

      for (const msg of messages) {

        if (!msg.message) {
          continue;
        }

        if (
          isJidBroadcast(
            msg.key.remoteJid || ''
          )
        ) {
          continue;
        }

        if (msg.key.fromMe) {
          continue;
        }

        // Check custom auto-responses
        try {

          const arModule =
            require(
              './commands/business/autorespond'
            );

          const responses =
            arModule.getResponses?.();

          if (responses) {

            const body =
              (
                msg.message.conversation ||
                msg.message
                  .extendedTextMessage
                  ?.text ||
                ''
              )
                .toLowerCase()
                .trim();

            for (
              const key of responses.keys()
            ) {

              if (
                body.includes(key)
              ) {

                await sock.sendMessage(
                  msg.key.remoteJid,
                  {
                    text:
                      responses.get(key),
                  },
                  {
                    quoted: msg,
                  }
                );

                return;
              }
            }
          }

        } catch {}

        await handleMessage(
          sock,
          msg
        );
      }
    }
  );

  // ── Anti-delete ───────────────────────────────────────────
  sock.ev.on(
    'messages.delete',
    async (item) => {

      if (!config.ANTI_DELETE) {
        return;
      }

      logger.info(
        '[AntiDelete] A message was deleted.'
      );
    }
  );

  return sock;
}

// ── Start ────────────────────────────────────────────────────
startBot().catch((err) => {

  logger.error(
    '[FATAL]',
    err
  );

  console.error(
    '[FATAL FULL ERROR]',
    err
  );

  process.exit(1);
});
