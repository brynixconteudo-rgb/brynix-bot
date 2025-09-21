// server.js
const express = require('express');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const { initWhatsApp, getLastQr } = require('./whatsapp');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health
app.get('/', (_req, res) => res.send('BRYNIX WhatsApp Bot up ✅'));

// QR como PNG
app.get('/wa-qr', async (_req, res) => {
  try {
    const qr = getLastQr();
    if (!qr) return res.status(503).send('QR ainda não gerado. Atualize em alguns segundos.');
    const png = await QRCode.toBuffer(qr, { type: 'png', margin: 1, scale: 6 });
    res.type('image/png').send(png);
  } catch (e) {
    console.error('[WA] Erro ao gerar QR:', e);
    res.status(500).send('Erro ao gerar QR');
  }
});

initWhatsApp(app);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Servidor rodando na porta ${port}`));
