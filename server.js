require('dotenv').config();
const express = require('express');
const cors = require('cors');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');

// ---------------------------------------------------------------------------
// Simple in-memory message cache.
//
// WHY THIS EXISTS:
//   WhatsApp uses the Signal Protocol for end-to-end encryption. When a
//   session is reset or a new linked device appears, WhatsApp's servers send
//   Baileys a "retry" request asking it to re-deliver recent messages so the
//   new session can decrypt them. Baileys handles this by calling getMessage()
//   with the original message key.
//
//   If getMessage() returns a hard-coded fallback (e.g. { conversation: 'hello' })
//   that fallback text is what gets delivered to the user — producing the
//   mysterious "hello" messages visible in the screenshot.
//
//   makeInMemoryStore (used in a previous fix attempt) solved this correctly
//   but was removed from @whiskeysockets/baileys in later versions, crashing
//   Render on startup with "makeInMemoryStore is not a function".
//
//   This plain Map replicates the only part of makeInMemoryStore we actually
//   need: storing a sent message by ID so retries can look it up.
//   Returning undefined (not a fallback string) when a key is missing tells
//   Baileys to skip the retry cleanly instead of sending garbage.
// ---------------------------------------------------------------------------
const msgCache = new Map();
const MSG_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — enough for any retry window

const app = express();
const PORT = process.env.PORT || 5001;

let isClientReady = false;
let latestQR = '';
let sock;

app.use(cors());
app.use(express.json());

function formatWhatsAppNumber(mobile) {
  const digits = String(mobile).replace(/\D/g, '');
  let number = digits;
  if (number.length === 10) {
    number = `91${number}`;
  }
  return `${number}@s.whatsapp.net`;
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const { version } = await fetchLatestBaileysVersion();
  console.log(`[WHATSAPP] Booting with WA version: ${version.join('.')}`);

  const waVersion = version || [2, 3000, 1033893291];

  sock = makeWASocket({
    version: waVersion,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'error' }),
    browser: Browsers.macOS('Chrome'),

    // -------------------------------------------------------------------------
    // getMessage — called by Baileys when WhatsApp requests a message retry.
    // We look up our cache by message ID.
    //   - HIT:  returns the original { conversation: '...' } → correct retry
    //   - MISS: returns undefined → Baileys skips the retry cleanly, no "hello"
    // -------------------------------------------------------------------------
    getMessage: async (key) => {
      return msgCache.get(key.id) ?? undefined;
    },

    // Render-friendly options — keep the socket lightweight
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    keepAliveIntervalMs: 30000,
    fireInitQueries: false,
    ignoreAllBroadcasts: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('[WHATSAPP] New QR Code generated. Visit /qr to scan.');
      latestQR = await qrcode.toDataURL(qr);
    }

    if (connection === 'close') {
      isClientReady = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log(
          `[WHATSAPP] Connection dropped (Code: ${statusCode}). Reconnecting in 5 seconds...`
        );
        sock?.ev?.removeAllListeners();
        setTimeout(() => connectToWhatsApp(), 5000);
      } else {
        console.log('[WHATSAPP] Logged out. Delete auth_info_baileys folder and restart.');
        latestQR = '';
      }
    } else if (connection === 'open') {
      isClientReady = true;
      latestQR = '';
      console.log('[WHATSAPP] Client is successfully connected and ready!');
    }
  });
}

connectToWhatsApp();

process.on('unhandledRejection', (reason) => console.error('[UNHANDLED REJECTION]', reason));
process.on('uncaughtException', (err) => console.error('[UNCAUGHT EXCEPTION]', err));

// --- EXPRESS ROUTES ---

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', whatsappReady: isClientReady });
});

app.get('/qr', (_req, res) => {
  if (isClientReady) {
    return res.send(
      '<h2 style="text-align:center;margin-top:50px;font-family:sans-serif;">✅ WhatsApp is successfully connected!</h2>'
    );
  }
  if (!latestQR) {
    return res.send(
      '<h2 style="text-align:center;margin-top:50px;font-family:sans-serif;">⏳ Generating QR code... Please refresh in a few seconds.</h2>'
    );
  }
  res.send(`
    <html>
      <body style="font-family:sans-serif;text-align:center;margin-top:50px;background:#f0f2f5;">
        <h2>📱 Scan this QR Code with WhatsApp</h2>
        <p>Open WhatsApp → Linked Devices → Link a Device</p>
        <div style="display:flex;justify-content:center;margin-top:30px;">
          <img src="${latestQR}" alt="WhatsApp QR Code"
               style="box-shadow:0 4px 6px rgba(0,0,0,.1);border-radius:10px;border:20px solid white;" />
        </div>
      </body>
    </html>
  `);
});

app.post('/send-message', async (req, res) => {
  const { mobile, message } = req.body;

  if (!isClientReady) {
    return res.status(503).json({ message: 'WhatsApp client not ready. Please scan QR.' });
  }
  if (!mobile || !message) {
    return res.status(400).json({ message: 'mobile and message are required' });
  }

  try {
    const formattedNumber = formatWhatsAppNumber(mobile);
    const sentMsg = await sock.sendMessage(formattedNumber, { text: message });

    // -------------------------------------------------------------------------
    // Cache the sent message so that if WhatsApp requests a retry
    // (due to a session reset), Baileys can return the correct text instead
    // of whatever the fallback used to be ("hello").
    //
    // Structure mirrors what getMessage() must return: { conversation: string }
    // TTL keeps Render's RAM healthy on the free tier.
    // -------------------------------------------------------------------------
    if (sentMsg?.key?.id) {
      const content = { conversation: message };
      msgCache.set(sentMsg.key.id, content);
      setTimeout(() => msgCache.delete(sentMsg.key.id), MSG_CACHE_TTL_MS);
    }

    return res.status(200).json({ message: 'Message sent successfully', to: formattedNumber });
  } catch (err) {
    console.error('[WHATSAPP] Send failed:', err.message);
    return res.status(500).json({ message: 'Failed to send message', error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`WhatsApp microservice running on port ${PORT}`);
});