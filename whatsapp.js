// whatsapp.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

let lastQr = null;
let client = null;

function initWhatsApp(app) {
  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'brynix-bot' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', (qr) => {
    lastQr = qr;
    console.log('📱 QR atualizado – acesse /wa-qr para escanear.');
  });

  client.on('authenticated', () => console.log('🔐 WhatsApp autenticado.'));
  client.on('ready', () => console.log('✅ WhatsApp READY.'));
  client.on('disconnected', (reason) => {
    console.log('⚠️ WhatsApp desconectado:', reason);
    // tenta reiniciar
    client.initialize();
  });

  // Resposta simples para teste
  client.on('message', async (msg) => {
    if (/^oi\b/i.test(msg.body)) {
      await msg.reply('Olá! 👋 Bot BRYNIX aqui. Já estou ouvindo você.');
    }
  });

  client.initialize();

  // Rota para ver o QR Code como imagem PNG
  app.get('/wa-qr', async (req, res) => {
    if (!lastQr) {
      return res
        .status(202)
        .send('QR ainda não gerado. Atualize em alguns segundos…');
    }
    try {
      const dataUrl = await qrcode.toDataURL(lastQr);
      const img = Buffer.from(dataUrl.split(',')[1], 'base64');
      res.set('Content-Type', 'image/png');
      res.send(img);
    } catch (err) {
      console.error(err);
      res.status(500).send('Falha ao gerar QR.');
    }
  });

  // Rota de status simples
  app.get('/wa-status', (req, res) => {
    const status = client?.info
      ? 'connected'
      : lastQr
      ? 'qr_available'
      : 'starting';
    res.json({ status });
  });
}

module.exports = { initWhatsApp };
