// whatsapp.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const { generateReply } = require('./ai');

const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const REINIT_COOLDOWN_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 60_000;

let currentState = 'starting';
let lastQr = '';
let reinitNotBefore = 0;
let client;
let botWid = null;       // id do bot (para detectar menções)
let botPushName = 'Brynix - BOT';

function getLastQr() {
  return lastQr;
}

async function sendAlert(payload) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    const body = typeof payload === 'string' ? { text: payload } : (payload || { text: '⚠️ Alerta' });
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (_) {}
}

function buildClient() {
  return new Client({
    authStrategy: new LocalAuth({ clientId: 'brynix-bot', dataPath: SESSION_PATH }),
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
    if (client) try { await client.destroy(); } catch (_) {}
  } catch (err) {
    console.error('[WA] Erro ao destruir cliente:', err);
  }

  client = buildClient();
  wireEvents(client);
  client.initialize();
}

function shouldRespondInGroup(msg, text) {
  // regras:
  // 1) comandos iniciados com /
  // 2) menção direta ao bot (@Nome) — checamos via mentionedIds
  const startsWithSlash = text.startsWith('/');
  const mentioned = (msg.mentionedIds || []).includes(botWid);
  return startsWithSlash || mentioned;
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
    try {
      botWid = c.info?.wid?._serialized || null;
      botPushName = c.info?.pushname || 'Brynix - BOT';
      console.log(`[WA] Cliente pronto ✅ | botWid=${botWid} | nome="${botPushName}"`);
    } catch (_) {}
    sendAlert('✅ BOT Brynix online e pronto.');
  });

  c.on('change_state', (state) => {
    currentState = state || currentState;
    console.log('[WA] Estado alterado:', currentState);
  });

  c.on('disconnected', (reason) => {
    currentState = 'disconnected';
    console.error('[WA] Desconectado:', reason);
    sendAlert(`❌ BOT Brynix desconectado. Motivo: ${reason || 'não informado'}`);
    safeReinit(`disconnected:${reason || 'unknown'}`);
  });

  // ----------------- mensagens -----------------
  c.on('message', async (msg) => {
    try {
      // ignorar conteúdos não-texto
      if (msg.type && msg.type !== 'chat') return;

      const text = (msg.body || '').trim();
      const isGroup = msg.from.endsWith('@g.us');

      // Em grupo: *só responde quando /comando ou menção ao bot*
      if (isGroup) {
        if (!botWid) {
          // se ainda não temos o wid do bot, tente pegar do client
          botWid = c.info?.wid?._serialized || botWid;
        }
        const allowed = shouldRespondInGroup(msg, text);
        if (!allowed) {
          console.log(`[WA][grupo] Ignorado (sem menção/sem /): "${text}"`);
          return;
        }
      }

      console.log(`[WA] Mensagem recebida de ${msg.from} (${isGroup ? 'grupo' : '1:1'}): "${text}"`);

      // comandos disponíveis (mocks por enquanto)
      const triggers = ['/ajuda', '/status', '/tarefas', '/hoje'];

      const reply = await generateReply(text, {
        isGroup,
        botName: botPushName,
        triggers,
      });

      await msg.reply(reply);
      console.log(`[WA] Resposta enviada para ${msg.from}: "${(reply || '').slice(0, 140)}${reply && reply.length > 140 ? '…' : ''}"`);
    } catch (err) {
      console.error('[WA] Erro ao processar/enviar resposta:', err);
      try { await msg.reply('Tive um problema técnico agora há pouco. Pode reenviar?'); } catch (_) {}
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
      }
    } catch (err) {
      console.error('[WA] Watchdog erro:', err);
      safeReinit('watchdog-error');
    }
  }, WATCHDOG_INTERVAL_MS);
}

module.exports = { initWhatsApp, getLastQr };
