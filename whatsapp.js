// whatsapp.js
const { Client, LocalAuth } = require('whatsapp-web.js');

let currentState = 'starting';

function initWhatsApp(app) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'brynix-bot' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });

  // ---------- LOGS ÚTEIS ----------
  client.on('qr', (qr) => {
    console.log('[WA] QR gerado. Acesse /wa-qr para visualizar.');
    // se você já tem a rota /wa-qr renderizando o QR, está ok.
  });

  client.on('authenticated', () => {
    console.log('[WA] Autenticado');
  });

  client.on('auth_failure', (m) => {
    console.error('[WA] Falha de autenticação:', m);
  });

  client.on('ready', () => {
    currentState = 'ready';
    console.log('[WA] Cliente pronto ✅');
  });

  client.on('change_state', (state) => {
    currentState = state || currentState;
    console.log('[WA] Estado alterado:', currentState);
  });

  client.on('disconnected', (reason) => {
    currentState = 'disconnected';
    console.error('[WA] Desconectado:', reason);
  });

  // ---------- AQUI LOGAMOS AS MENSAGENS ----------
  client.on('message', async (msg) => {
    try {
      console.log(`[WA] Mensagem recebida de ${msg.from}: "${msg.body}"`);
      const texto = (msg.body || '').trim().toLowerCase();

      let reply;
      if (texto === 'oi') {
        reply = 'Olá! 👋 Aqui é o Bot da BRYNIX, pronto para ajudar.';
      } else {
        reply = 'Recebi sua mensagem, já já respondo com novidades 🚀';
      }

      await msg.reply(reply);
      console.log(`[WA] Resposta enviada para ${msg.from}: "${reply}"`);
    } catch (err) {
      console.error('[WA] Erro ao processar/enviar resposta:', err);
    }
  });

  // rota simples de status (opcional)
  if (app && app.get) {
    app.get('/wa-status', (_req, res) => {
      res.json({ status: currentState });
    });
  }

  client.initialize();
}

module.exports = { initWhatsApp };
