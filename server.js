require('dotenv').config();
const express = require('express');
const cors = require('cors');
// FIX 1: Import fetchLatestBaileysVersion
const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');

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

  // FIX 2: Dynamically pull the absolute latest WhatsApp Web version
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[WHATSAPP] Booting with WA version: ${version.join('.')}`);

  // FIX 3: Add a fallback hardcoded version specifically known to bypass the 405 error
  const waVersion = version || [2, 3000, 1033893291];

  sock = makeWASocket({
    version: waVersion, // <--- THIS IS THE MAGIC KEY
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'error' }),
    browser: ['Windows', 'Chrome', '110.0.5481.177'],
    getMessage: async () => undefined
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
        console.log(`[WHATSAPP] Connection dropped (Code: ${statusCode}). Reconnecting in 5 seconds...`);
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

app.get('/qr', (req, res) => {
  if (isClientReady) {
    return res.send('<h2 style="text-align:center; margin-top:50px; font-family:sans-serif;">✅ WhatsApp is successfully connected!</h2>');
  }
  if (!latestQR) {
    return res.send('<h2 style="text-align:center; margin-top:50px; font-family:sans-serif;">⏳ Generating QR code... Please refresh in a few seconds.</h2>');
  }

  res.send(`
    <html>
      <body style="font-family: sans-serif; text-align: center; margin-top: 50px; background: #f0f2f5;">
        <h2>📱 Scan this QR Code with WhatsApp</h2>
        <p>Open WhatsApp > Linked Devices > Link a Device</p>
        <div style="display: flex; justify-content: center; margin-top: 30px;">
          <img src="${latestQR}" alt="WhatsApp QR Code" style="box-shadow: 0 4px 6px rgba(0,0,0,0.1); border-radius: 10px; border: 20px solid white;" />
        </div>
      </body>
    </html>
  `);
});

app.post('/send-message', async (req, res) => {
  const { mobile, message } = req.body;

  if (!isClientReady) return res.status(503).json({ message: 'WhatsApp client not ready. Please scan QR.' });
  if (!mobile || !message) return res.status(400).json({ message: 'mobile and message required' });

  try {
    const formattedNumber = formatWhatsAppNumber(mobile);
    await sock.sendMessage(formattedNumber, { text: message });
    return res.status(200).json({ message: 'Message sent successfully', to: formattedNumber });
  } catch (err) {
    console.error('[WHATSAPP] Send failed:', err.message);
    return res.status(500).json({ message: 'Failed to send message', error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`WhatsApp microservice running on port ${PORT}`);
});
