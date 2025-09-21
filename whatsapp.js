// whatsapp.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const { generateReply } = require('./ai');
const gp = require('./gp'); // <— importa como objeto, para usar gp.appendLog

// =====================
// Configurações
// =====================
const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const REINIT_COOLDOWN_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 60_000;

let currentState = 'starting';
let lastQr = '';
let reinitNotBefore = 0;
let client;

// =====================
// Utilitários
// =====================
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

// =====================
// Construção do cliente
// =====================
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
      try { await client.destroy(); } catch (_) {}
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

  c.on('ready', () => {
    currentState = 'ready';
    console.log('[WA] Cliente pronto ✅');
    sendAlert('✅ BOT Brynix online e pronto.');
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

  // ============ Mensagens ============
  c.on('message', async (msg) => {
    try {
      // ignora as mensagens do próprio bot
      if (msg.fromMe) return;

      const isGroup = msg.from?.endsWith('@g.us');
      const groupId = isGroup ? msg.from : null;

      // Em grupo, o autor vem em msg.author (ex.: 55xxxx@s.whatsapp.net)
      const authorId = isGroup
        ? (msg.author || msg._data?.author || '')
        : msg.from;

      const authorName =
        msg._data?.notifyName ||
        msg._data?.pushname ||
        msg._data?.sender?.pushname ||
        authorId;

      const body = (msg.body || '').trim();
      console.log(`[WA] Mensagem ${isGroup ? 'GRUPO' : 'DM'} de ${authorName}: "${body}"`);

      // 1) Log leve de mensagens de GRUPO (não falhar caso inexista)
      if (isGroup && gp && typeof gp.appendLog === 'function') {
        try {
          gp.appendLog(groupId, {
            author: authorName,
            authorId,
            body,
          });
        } catch (e) {
          console.error('[WA] Falha appendLog:', e?.message || e);
        }
      }

      // 2) Comandos simples (ex.: /help). Opcional: só em grupo.
      if (body.startsWith('/help')) {
        const menu =
          '*Comandos*\n' +
          '• /setup – definir nome do projeto e marcos\n' +
          '• /summary – sumário do período\n' +
          '• /note <texto> – registrar nota\n' +
          '• /doc <descrição> – registrar documento (meta)\n' +
          '• /remind <hora> <texto> – lembrete rápido\n';
        await msg.reply(menu);
        return;
      }

      // 3) IA (resposta normal em DM e grupo)
      const reply = await generateReply(body, {
        from: isGroup ? `${groupId}:${authorId}` : msg.from,
        pushName: authorName,
        isGroup,
      });

      await msg.reply(reply);
      console.log(`[WA] Resposta enviada para ${isGroup ? groupId : msg.from}.`);
    } catch (err) {
      console.error('[WA] Erro ao processar mensagem:', err);
      try {
        await msg.reply('Tive um problema técnico agora há pouco. Pode reenviar sua mensagem?');
      } catch (_) {}
    }
  });
}

// =====================
// Inicialização pública
// =====================
function initWhatsApp(app) {
  client = buildClient();
  wireEvents(client);

  if (app && app.get) {
    app.get('/wa-status', async (_req, res) => {
      let state = currentState;
      try {
        const s = await client.getState().catch(() => null);
        if (s) state = s;
      } catch {}
      res.json({ status: state });
    });

    app.get('/wa-qr', async (_req, res) => {
      try {
        const qr = getLastQr();
        if (!qr) return res.status(503).send('QR ainda não gerado.');
        const QRCode = require('qrcode');
        const png = await QRCode.toBuffer(qr, { type: 'png', margin: 1, scale: 6 });
        res.type('image/png').send(png);
      } catch (e) {
        console.error('[WA] Erro ao gerar QR:', e);
        res.status(500).send('Erro ao gerar QR');
      }
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
