const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

async function start() {
  console.log('=== APEX MINIMAL WHATSAPP AUTH TEST ===');

  const { state, saveCreds } =
    await useMultiFileAuthState('./session');

  console.log(
    'Registered session:',
    state.creds.registered
  );

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on(
    'connection.update',
    async (update) => {
      const {
        connection,
        lastDisconnect,
        qr,
      } = update;

      console.log(
        'connection.update:',
        {
          connection,
          hasQR: !!qr,
        }
      );

      if (qr) {
        console.log('');
        console.log('==============================');
        console.log('WHATSAPP QR RECEIVED');
        console.log('Scan with:');
        console.log(
          'WhatsApp > Linked devices > Link a device'
        );
        console.log('==============================');
        console.log('');

        qrcode.generate(qr, {
          small: true,
        });
      }

      if (connection === 'open') {
        console.log('');
        console.log('✅ WHATSAPP CONNECTED');
        console.log(
          'Logged in as:',
          sock.user?.id
        );
        console.log('');
      }

      if (connection === 'close') {
        let statusCode;

        try {
          statusCode =
            new Boom(
              lastDisconnect?.error
            ).output.statusCode;
        } catch {
          statusCode = undefined;
        }

        console.log('');
        console.log('=== CONNECTION CLOSED ===');
        console.log(
          'Status code:',
          statusCode
        );
        console.log(
          'Full error:',
          lastDisconnect?.error
        );
        console.log(
          'Error message:',
          lastDisconnect?.error?.message
        );
        console.log(
          'Error stack:',
          lastDisconnect?.error?.stack
        );
        console.log('=========================');
        console.log('');

        const loggedOut =
          statusCode ===
          DisconnectReason.loggedOut;

        if (!loggedOut) {
          console.log(
            'Retrying in 10 seconds...'
          );

          setTimeout(
            start,
            10000
          );
        } else {
          console.log(
            'Session logged out.'
          );
        }
      }
    }
  );
}

start().catch((err) => {
  console.error(
    'STARTUP FAILURE:',
    err
  );
});
