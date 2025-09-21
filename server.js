// server.js
const express = require('express');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');

const { initWhatsApp, getLastQr } = require('./whatsapp');
const { refreshKB } = require('./ai');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health
app.get('/', (_req, res) => {
  res.send('BRYNIX WhatsApp Bot up ✅');
});

// QR como PNG
app.get('/wa-qr', async (_req, res) => {
  try {
    const qr = getLastQr();
    if (!qr) {
      return res
        .status(503)
        .send('QR ainda não gerado. Aguarde alguns segundos e atualize a página.');
    }
    const png = await QRCode.toBuffer(qr, { type: 'png', margin: 1, scale: 6 });
    res.type('image/png').send(png);
  } catch (e) {
    console.error('[WA] Erro ao gerar QR:', e);
    res.status(500).send('Erro ao gerar QR');
  }
});

// Força atualização do mini-KB (site da BRYNIX)
app.post('/kb-refresh', async (_req, res) => {
  try {
    const info = await refreshKB();
    res.json({ ok: true, ...info });
  } catch (e) {
    console.error('[KB] refresh erro:', e);
    res.status(500).json({ ok: false });
  }
});

// Inicializa o cliente do WhatsApp
initWhatsApp(app);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
