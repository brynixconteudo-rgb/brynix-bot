// whatsapp.js
// Cliente WhatsApp NÃO OFICIAL para piloto (whatsapp-web.js)
// Imprime o QR no LOG (ASCII) para você escanear. Responde com lógica simples.
// IMPORTANTE: use número de teste. Não usar em produção final.

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

let WA_STATUS = 'starting';
let client;

/**
 * Inicializa o cliente WhatsApp e (opcionalmente) registra endpoints REST no Express.
 * @param {import('express').Express} app
 */
function initWhatsApp(app) {
  // Flags para Puppeteer funcionar no Render (sem sandbox)
  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'brynix-bot' }), // salva sessão em .wwebjs_auth/
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', (qr) => {
    WA_STATUS = 'qr_waiting';
    console.log('==== QR CODE GERADO (escaneie com o WhatsApp) ====');
    qrcode.generate(qr, { small: true });
    console.log('==== FIM QR ====');
  });

  client.on('ready', () => {
    WA_STATUS = 'ready';
    console.log('✅ WhatsApp conectado e pronto.');
  });

  client.on('authenticated', () => {
    console.log('🔐 Sessão autenticada.');
  });

  client.on('auth_failure', (msg) => {
    WA_STATUS = 'auth_failure';
    console.error('❌ Falha de autenticação:', msg);
  });

  client.on('disconnected', (reason) => {
    WA_STATUS = 'disconnected';
    console.error('⚠️ Desconectado:', reason);
    // Tenta reiniciar automaticamente
    setTimeout(() => client.initialize(), 5000);
  });

  // Resposta básica para teste
  client.on('message', async (msg) => {
    try {
      const text = (msg.body || '').trim().toLowerCase();

      if (text.includes('oi') || text.includes('olá') || text.includes('ola')) {
        await msg.reply('👋 Oi! Aqui é o *BOT da BRYNIX*. Estou em piloto para organizar tarefas do assessment.');
        return;
      }

      if (text.includes('status')) {
        await msg.reply(`🟢 Status atual: *${WA_STATUS}*`);
        return;
      }

      // Resposta padrão
      await msg.reply('✅ Recebi sua mensagem. Estamos em piloto — posso registrar recados e organizar próximos passos.');
    } catch (err) {
      console.error('Erro ao responder mensagem:', err);
    }
  });

  client.initialize();

  // Endpoints auxiliares (opcional)
  if (app) {
    app.get('/wa/status', (_req, res) => {
      res.json({ status: WA_STATUS });
    });

    // Envio de teste via HTTP: GET /wa/send?to=5511999999999&text=Hello
    app.get('/wa/send', async (req, res) => {
      try {
        const to = (req.query.to || '').replace(/\D/g, '');
        const text = req.query.text || 'Teste BRYNIX BOT';
        if (!to) return res.status(400).json({ error: 'Parâmetro "to" obrigatório. Use DDI+DDD+Número, ex: 5511999999999' });

        await client.sendMessage(`55${to}`.startsWith('55') ? `55${to}` : to, text); // aceita já com 55 ou sem
        return res.json({ ok: true });
      } catch (e) {
        console.error(e);
        return res.status(500).json({ error: String(e) });
      }
    });
  }
}

module.exports = { initWhatsApp };
