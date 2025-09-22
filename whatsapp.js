// whatsapp.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const { generateReply } = require('./ai');
const { initGP } = require('./gp');

const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const REINIT_COOLDOWN_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 60_000;

let currentState = 'starting';
let lastQr = '';
let reinitNotBefore = 0;
let client;

function getLastQr() {
  return lastQr;
}

async function sendAlert(payload) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) {
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

function buildClient() {
  return new Client({
    authStrategy: new LocalAuth({
      clientId: 'brynix-bot',
      dataPath: SESSION_PATH,
    }),
    puppeteer: {
      headless: true,
      timeout: 60_000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
      ],
    },
    restartOnAuthFail: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 5_000,
  });
}

async function safeReinit(reason = 'unknown') {
  const now = Date.now();
  if (now < reinitNotBefore) {
    console.log(`[WA] Reinit ignorado (cooldown). Motivo: ${reason}`);
    return;
  }
  reinitNotBefore = now + REINIT_COOLDOWN_MS;

  try {
    console.log(`[WA] Reinicializando cliente. Motivo: ${reason}`);
    if (client) {
      try {
        await client.destroy();
      } catch (_) {}
    }
  } catch (err) {
    console.error('[WA] Erro ao destruir cliente:', err);
  }

  client = buildClient();
  wireEvents(client);
  client.initialize();
}

function wireEvents(c) {
  c.on('qr', (qr) => {
    lastQr = qr;
    currentState = 'qr';
    console.log('[WA] QR gerado. Abra /wa-qr para escanear.');
    sendAlert('🔄 BOT Brynix requer novo pareamento: abra /wa-qr e escaneie o código.');
  });

  c.on('authenticated', () => {
    console.log('[WA] Autenticado');
  });

  c.on('auth_failure', (m) => {
    console.error('[WA] Falha de autenticação:', m);
    sendAlert(`⚠️ Falha de autenticação do BOT Brynix: ${m || 'motivo não informado'}`);
    safeReinit('auth_failure');
  });

  c.on('ready', async () => {
    currentState = 'ready';
    console.log('[WA] Cliente pronto ✅');
    sendAlert('✅ BOT Brynix online e pronto.');

    // 🔗 LIGA O MODO GP (agenda lembretes diários do projeto)
    try {
      await initGP(c);
      console.log('[WA] GP conectado.');
    } catch (e) {
      console.warn('[WA] GP não iniciou:', e?.message || e);
    }
  });

  c.on('change_state', (state) => {
    currentState = state || currentState;
    console.log('[WA] Estado alterado:', currentState);
  });

  c.on('loading_screen', (percent, message) => {
    console.log(`[WA] loading_screen: ${percent}% - ${message}`);
  });

  c.on('disconnected', (reason) => {
    currentState = 'disconnected';
    console.error('[WA] Desconectado:', reason);
    sendAlert(`❌ BOT Brynix desconectado. Motivo: ${reason || 'não informado'}`);
    safeReinit(`disconnected:${reason || 'unknown'}`);
  });

  // IA (mensagens 1:1 e em grupos)
  c.on('message', async (msg) => {
    try {
      console.log(`[WA] Mensagem recebida de ${msg.from}: "${msg.body}"`);

      const reply = await generateReply(msg.body, {
        from: msg.from,
        pushName: msg._data?.notifyName,
      });

      await msg.reply(reply);
      console.log(`[WA] Resposta (IA) enviada para ${msg.from}: "${reply}"`);
    } catch (err) {
      console.error('[WA] Erro ao processar/enviar resposta (IA):', err);
      try {
        await msg.reply('Tive um problema técnico agora há pouco. Pode reenviar sua mensagem?');
      } catch (_) {}
      sendAlert(`❗ Erro ao responder mensagem: ${err?.message || err}`);
    }
  });
}

function initWhatsApp(app) {
  client = buildClient();
  wireEvents(client);

  if (app && app.get) {
    app.get('/wa-status', async (_req, res) => {
      let state = currentState;
      try {
        const s = await client.getState().catch(() => null);
        if (s) state = s;
      } catch (_) {}
      res.json({ status: state });
    });
  }

  client.initialize();

  setInterval(async () => {
    try {
      const s = await client.getState().catch(() => null);
      if (!s || s === 'CONFLICT' || s === 'UNPAIRED' || s === 'UNLAUNCHED') {
        console.log(`[WA] Watchdog: estado crítico (${s || 'null'}) → reinit`);
        sendAlert(`⏰ Watchdog: estado do BOT é "${s || 'null'}". Tentando reinicializar.`);
        safeReinit(`watchdog:${s || 'null'}`);
      } else if (currentState !== 'ready' && s === 'CONNECTED') {
        currentState = 'ready';
      } else {
        console.log(`[WA] Estado ok (${s || currentState})`);
      }
    } catch (err) {
      console.error('[WA] Watchdog erro:', err);
      safeReinit('watchdog-error');
    }
  }, WATCHDOG_INTERVAL_MS);
}

module.exports = { initWhatsApp, getLastQr };
