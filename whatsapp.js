// whatsapp.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

let wa = {
  client: null,
  status: 'booting',   // booting | qr | ready | auth | disconnected | error
  lastQR: null,
};

function initWhatsApp(app) {
  wa.client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true,
    },
  });

  // Eventos do cliente
  wa.client.on('qr', (qr) => {
    wa.status = 'qr';
    wa.lastQR = qr;
    console.log('[WA] QR atualizado. Abra /wa-qr para escanear.');
  });

  wa.client.on('ready', () => {
    wa.status = 'ready';
    console.log('[WA] Cliente pronto ✅');
  });

  wa.client.on('authenticated', () => {
    wa.status = 'auth';
    console.log('[WA] Autenticado');
  });

  wa.client.on('disconnected', (reason) => {
    wa.status = 'disconnected';
    console.log('[WA] Desconectado:', reason);
  });

  wa.client.on('message', async (msg) => {
    // Auto-resposta simples só pra validar
    if (msg.body?.toLowerCase().includes('oi')) {
      await msg.reply('Olá! 👋 Aqui é o Bot da BRYNIX, já estou funcionando.');
    }
  });

  wa.client.initialize();

  // ---------- ROTAS ----------
  // QR em PNG
  app.get('/wa-qr', async (_req, res) => {
    try {
      if (!wa.lastQR) return res.status(503).send(`QR ainda não disponível. Status: ${wa.status}`);
      const png = await qrcode.toBuffer(wa.lastQR, { width: 300, margin: 1 });
      res.type('png').send(png);
    } catch (e) {
      console.error(e);
      res.status(500).send('Erro ao gerar QR');
    }
  });

  // Status da sessão
  app.get('/wa-status', (_req, res) => {
    res.json({ status: wa.status });
  });

  // Enviar mensagem: { "to":"+5511999999999", "text":"Olá" }
  app.post('/wa-send', async (req, res) => {
    try {
      if (wa.status !== 'ready' && wa.status !== 'auth') {
        return res.status(409).json({ ok: false, message: `Cliente não está pronto. Status: ${wa.status}` });
      }
      const to = (req.body.to || '').replace(/[^\d+]/g, '');
      const text = req.body.text || '';
      if (!to || !text) return res.status(400).json({ ok: false, message: 'Informe "to" e "text".' });

      // formato JID do WhatsApp
      const jid = `${to.replace('+', '')}@c.us`;
      await wa.client.sendMessage(jid, text);
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });
}

module.exports = { initWhatsApp };
