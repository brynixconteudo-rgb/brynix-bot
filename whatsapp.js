// whatsapp.js
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { generateReply } = require('./ai');

// =====================
// Configurações
// =====================
const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const REINIT_COOLDOWN_MS = 30_000;       // não tentar reiniciar mais de 1x a cada 30s
const WATCHDOG_INTERVAL_MS = 60_000;     // verificação a cada 60s
const DB_FILE = path.join(process.env.WA_SESSION_PATH || '/var/data', 'botdb.json');

let currentState = 'starting';
let lastQr = ''; // QR em memória (servido em /wa-qr)
let reinitNotBefore = 0;
let client;

// =====================
// “Banco” simples por grupo (persistido)
// =====================
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    }
  } catch {}
  return { chats: {} }; // { chats: { [chatId]: { mode: 'concierge'|'project', memory: [] } } }
}
function saveDB(db) {
  try {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('[DB] Falha ao salvar DB:', e);
  }
}
const db = loadDB();

function getChatConfig(chatId) {
  db.chats[chatId] ??= { mode: 'concierge', memory: [] };
  return db.chats[chatId];
}
function setChatMode(chatId, mode) {
  const cfg = getChatConfig(chatId);
  cfg.mode = mode;
  saveDB(db);
}

// =====================
// Webhook de alerta (Zapier) opcional
// =====================
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
// Client builder e ciclo de vida
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
      try { await client.destroy(); } catch {}
    }
  } catch (err) {
    console.error('[WA] Erro ao destruir cliente:', err);
  }

  client = buildClient();
  wireEvents(client);
  client.initialize();
}

function shouldRespondInGroup(text, msg, myId) {
  const t = (text || '').toLowerCase().trim();
  // 1) menção direta ao bot?
  if (msg.mentionedIds && msg.mentionedIds.includes(myId)) return true;
  // 2) prefixo bot:
  if (t.startsWith('bot:') || t.startsWith('@bot')) return true;
  // 3) palavras-chave leves
  const keys = ['@brynix', 'brynix', 'assistente', 'bot'];
  return keys.some(k => t.includes(k));
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
      const chat = await msg.getChat();
      const contact = await msg.getContact();
      const text = msg.body || '';
      const isGroup = chat.isGroup;

      // Só fala em grupo quando chamado
      if (isGroup) {
        const me = await c.getNumberId(contact.number).catch(() => null);
        // melhor forma de pegar o ID do bot:
        const meId = c.info?.wid?._serialized;

        if (!shouldRespondInGroup(text, msg, meId)) {
          return; // silencioso
        }
      }

      // Comandos de modo (só em grupo)
      if (isGroup) {
        const lower = text.toLowerCase().trim();
        if (lower.includes('/mode project')) {
          setChatMode(chat.id._serialized, 'project');
          await msg.reply('Modo **PROJETO** ativado para este grupo ✅');
          return;
        }
        if (lower.includes('/mode concierge')) {
          setChatMode(chat.id._serialized, 'concierge');
          await msg.reply('Modo **CONCIERGE** (padrão) ativado para este grupo ✅');
          return;
        }
      }

      // Persona por chat
      const chatId = chat.id._serialized;
      const { mode } = getChatConfig(chatId);
      console.log(`[WA] (${isGroup ? 'GROUP' : '1:1'}) ${chatId} | mode=${mode} | from=${msg.from} | "${text}"`);

      // Chama a IA com persona dinâmica
      const reply = await generateReply(text, {
        from: msg.from,
        pushName: msg._data?.notifyName,
        isGroup,
        mode, // 'concierge' | 'project'
        chatTitle: isGroup ? chat.name : undefined,
      });

      await msg.reply(reply);
      console.log(`[WA] Resposta (IA) enviada para ${msg.from}: "${reply}"`);
    } catch (err) {
      console.error('[WA] Erro ao processar/enviar resposta (IA):', err);
      try {
        await msg.reply('Tive um problema técnico agora há pouco. Pode reenviar sua mensagem?');
      } catch {}
      sendAlert(`❗ Erro ao responder mensagem: ${err?.message || err}`);
    }
  });
}

// =====================
// API pública para server.js
// =====================
function getLastQr() {
  return lastQr;
}

function initWhatsApp(app) {
  client = buildClient();
  wireEvents(client);

  // Health
  if (app && app.get) {
    app.get('/wa-status', async (_req, res) => {
      let state = currentState;
      try {
        const s = await client.getState().catch(() => null);
        if (s) state = s;
      } catch {}
      res.json({ status: state });
    });
  }

  client.initialize();

  // Watchdog
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
