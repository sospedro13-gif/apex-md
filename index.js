// ============================================================
//  APEX-MD  ·  Main Entry Point
//  WhatsApp Multi-Device Bot — 2026 Edition
//  Built on @whiskeysockets/baileys
// ============================================================

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  Browsers,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const qrcode = require('qrcode-terminal');

const config = require('./config');
const logger = require('./lib/logger');
const db = require('./lib/database');
const { handleMessage, loadCommands } = require('./lib/handler');

console.log(`
╔══════════════════════════════════════════╗
║       ⚡  APEX-MD  WhatsApp Bot  ⚡       ║
║         v${config.BOT_VERSION}  |  2026 Edition          ║
║   The most advanced MD bot ever built    ║
╚══════════════════════════════════════════╝
`);

let reconnectTimer = null;
let starting = false;

async function startBot() {
  if (starting) return;
  starting = true;

  try {
    loadCommands();

    // MongoDB failure is non-fatal.
    // APEX falls back to memory until we configure MongoDB later.
    await db.connect();

    if (!fs.existsSync(config.SESSION_DIR)) {
      fs.mkdirSync(config.SESSION_DIR, { recursive: true });
    }

    const { state, saveCreds } =
      await useMultiFileAuthState(config.SESSION_DIR);

    const { version } = await fetchLatestBaileysVersion();

    logger.info(
      `[Boot] Using WhatsApp Web v${version.join('.')}`
    );

    const sock = makeWASocket({
      version,

      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(
          state.keys,
          pino({ level: 'silent' })
        ),
      },

      // We handle QR through connection.update below.
      printQRInTerminal: false,

      // IMPORTANT:
      // Ubuntu/Chrome identifies this as WEB_BROWSER.
      browser: Browsers.ubuntu('Chrome'),

      logger: pino({ level: 'silent' }),

      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: true,

      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 250,
    });

    starting = false;

    sock.ev.on('connection.update', async (update) => {
      const {
        connection,
        lastDisconnect,
        qr,
      } = update;

      if (qr) {
        console.log('\n');
        console.log('============================================');
        console.log('📱 WHATSAPP QR CODE READY');
        console.log('Open WhatsApp on the BOT account:');
        console.log('Linked Devices → Link a Device');
        console.log('Then scan the QR below.');
        console.log('============================================\n');

        qrcode.generate(qr, {
          small: true,
        });
      }

      if (connection === 'connecting') {
        logger.info('[Connection] Connecting to WhatsApp...');
      }

      if (connection === 'open') {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        logger.info(
          `[Connection] ✅ APEX-MD ONLINE — ${sock.user?.id}`
        );

        try {
          if (config.OWNER_NUMBER) {
            await sock.sendMessage(
              config.OWNER_NUMBER + '@s.whatsapp.net',
              {
                text:
                  `⚡ *APEX-MD Online!*\n` +
                  `Version: ${config.BOT_VERSION}\n` +
                  `Prefix: ${config.BOT_PREFIX}\n` +
                  `Mode: ${config.PUBLIC_MODE ? 'Public' : 'Private'}\n\n` +
                  `Type ${config.BOT_PREFIX}help to see commands.`,
              }
            );
          }
        } catch (err) {
          logger.warn(
            `[Owner Message] Could not send startup message: ${err.message}`
          );
        }
      }

      if (connection === 'close') {
        let statusCode;
        let reason;

        try {
          const boom = new Boom(lastDisconnect?.error);
          statusCode = boom.output?.statusCode;
          reason =
            boom.output?.payload?.message ||
            boom.output?.payload?.error;
        } catch {
          statusCode =
            lastDisconnect?.error?.output?.statusCode;

          reason =
            lastDisconnect?.error?.message ||
            lastDisconnect?.error?.output?.payload?.error;
        }

        console.log('\n========== WHATSAPP DISCONNECT ==========');
        console.log('Status code:', statusCode);
        console.log('Reason:', reason);
        console.log(
          'Raw error:',
          lastDisconnect?.error?.message ||
          String(lastDisconnect?.error || 'Unknown')
        );
        console.log('=========================================\n');

        const loggedOut =
          statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          logger.error(
            '[Connection] WhatsApp logged this session out.'
          );

          logger.error(
            '[Connection] A fresh session will be required.'
          );

          return;
        }

        logger.warn(
          `[Connection] Closed. Code: ${statusCode} | Reason: ${reason}`
        );

        if (!reconnectTimer) {
          logger.info(
            '[Connection] Reconnecting in 5 seconds...'
          );

          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            startBot();
          }, 5000);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on(
      'group-participants.update',
      async (event) => {
        const {
          id,
          participants,
          action,
        } = event;

        if (!['add', 'remove'].includes(action)) {
          return;
        }

        const groupData =
          await db.getGroup(id);

        for (const jid of participants) {
          const name = jid.split('@')[0];

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

            await sock.sendMessage(id, {
              text: welcome,
              mentions: [jid],
            });
          }

          if (
            action === 'remove' &&
            groupData.goodbye
          ) {
            await sock.sendMessage(id, {
              text:
                `👋 @${name} has left the group.`,
              mentions: [jid],
            });
          }
        }
      }
    );

    sock.ev.on(
      'messages.upsert',
      async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
          if (!msg.message) continue;

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
                if (body.includes(key)) {
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

    sock.ev.on(
      'messages.delete',
      async () => {
        if (!config.ANTI_DELETE) {
          return;
        }

        logger.info(
          '[AntiDelete] A message was deleted.'
        );
      }
    );

    return sock;

  } catch (err) {
    starting = false;

    console.error('\n========== STARTUP ERROR ==========');
    console.error(err);
    console.error('===================================\n');

    logger.error(
      `[FATAL] ${err?.stack || err}`
    );

    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startBot();
      }, 5000);
    }
  }
}

startBot();
