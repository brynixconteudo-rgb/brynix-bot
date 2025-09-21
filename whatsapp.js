// whatsapp.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const { generateReply } = require('./ai');

let currentState = 'starting';
let lastQr = ''; // mantém o último QR gerado em memória

function getLastQr() {
  return lastQr;
}

/**
 * Envia alerta para o webhook (Zapier ou similar), se configurado.
 * Aceita string ou objeto (automaticamente transformado em { text }).
 */
async function sendAlert(payload) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) {
    // sem webhook configurado, apenas loga
    console.log('ℹ️ ALERT_WEBHOOK_URL não configurada; alerta:', payload);
    return;
  }
  try {
    const body =
      typeof payload === 'string'
        ? { text: payload }
        : payload || { text: '⚠️ Alerta sem conteúdo' };

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log('🚨 Alerta enviado com sucesso.');
  } catch (err) {
    console.error('❌ Erro ao enviar alerta para webhook:', err);
  }
}

function initWhatsApp(app) {
  // opções pensadas para maior resiliência
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'brynix-bot' }),
    // em ambientes serverless, vale manter headless e os args abaixo
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
    restartOnAuthFail: true,              // tenta reiniciar se a auth falhar
    takeoverOnConflict: true,             // toma posse em caso de sessão concorrente
    takeoverTimeoutMs: 5_000,             // tempo para tomar posse
  });

  // ---------- Eventos do cliente ----------
  client.on('qr', (qr) => {
    lastQr = qr;
    currentState = 'qr';
    console.log('[WA] QR gerado. Abra /wa-qr para escanear.');
    // opcional: alerta de que é necessário reescanear
    sendAlert('🔄 BOT Brynix requer novo pareamento: abra /wa-qr e escaneie o código.');
  });

  client.on('authenticated', () => {
    console.log('[WA] Autenticado');
  });

  client.on('auth_failure', (m) => {
    console.error('[WA] Falha de autenticação:', m);
    sendAlert(`⚠️ Falha de autenticação do BOT Brynix: ${m || 'motivo não informado'}`);
  });

  client.on('ready', () => {
    currentState = 'ready';
    console.log('[WA] Cliente pronto ✅');
    sendAlert('✅ BOT Brynix online e pronto.');
  });

  client.on('change_state', (state) => {
    currentState = state || currentState;
    console.log('[WA] Estado alterado:', currentState);
  });

  client.on('disconnected', (reason) => {
    currentState = 'disconnected';
    console.error('[WA] Desconectado:', reason);
    sendAlert(`❌ BOT Brynix desconectado. Motivo: ${reason || 'não informado'}`);

    // tenta reconectar com leve backoff
    setTimeout(() => {
      try {
        console.log('[WA] Tentando reinicializar sessão...');
        client.initialize();
      } catch (err) {
        console.error('[WA] Erro ao reinicializar:', err);
      }
    }, 5_000);
  });

  // ---------- Mensagens ----------
client.on('message', async (msg) => {
  try {
    console.log(`[WA] Mensagem recebida de ${msg.from}: "${msg.body}"`);

    // Chama a IA
    const reply = await generateReply(msg.body, {
      from: msg.from,
      pushName: msg._data?.notifyName
    });

    // Responde no WhatsApp
    await msg.reply(reply);
    console.log(`[WA] Resposta (IA) enviada para ${msg.from}: "${reply}"`);
  } catch (err) {
    console.error('[WA] Erro ao processar/enviar resposta (IA):', err);
    await msg.reply('Tive um problema técnico agora há pouco. Pode reenviar sua mensagem?');
  }
});

  // ---------- Health endpoint ----------
  if (app && app.get) {
    app.get('/wa-status', (_req, res) => {
      res.json({ status: currentState });
    });
  }

  client.initialize();

  // ---------- Watchdog simples ----------
  // Se por algum motivo ficar "preso" fora do ready por muito tempo, avisa.
  setInterval(() => {
    if (currentState !== 'ready') {
      console.log(`[WA] Estado atual: ${currentState} (watchdog)`);
      // evite alertar demais: só alerta se estiver de fato problemático
      if (['disconnected', 'error', 'conflict'].includes(currentState)) {
        sendAlert(`⏰ Watchdog: estado do BOT é "${currentState}". Verifique /wa-qr se necessário.`);
      }
    }
  }, 60_000); // a cada 60s
}

module.exports = { initWhatsApp, getLastQr };
