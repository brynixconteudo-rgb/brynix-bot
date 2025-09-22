// whatsapp.js
// Bot WhatsApp Brynix: IA + Anexos → Google Drive + LOG no Sheets + watchdog.
// Requer: GOOGLE_SA_JSON, GOOGLE_DRIVE_ROOT_FOLDER_ID, (opcional) LINKS_DB_PATH, ALERT_WEBHOOK_URL.

const fs = require('node:fs');
const path = require('node:path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { generateReply } = require('./ai');
const { uploadBuffer } = require('./drive');
const { appendLog } = require('./sheets');

// =====================
// Configurações
// =====================
const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const REINIT_COOLDOWN_MS = 30_000; // evitar loop de reinit
const WATCHDOG_INTERVAL_MS = 60_000;

let currentState = 'starting';
let lastQr = '';
let reinitNotBefore = 0;
let client;
let selfId = null; // id do próprio bot (para detectar menções)

// =====================
// Utils
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

/** Lê o mapeamento de grupo → sheetId de um JSON simples no disco (opcional). */
function loadLinksDb() {
  const p = process.env.LINKS_DB_PATH;
  if (!p) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const json = JSON.parse(raw || '{}');
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

/** Tenta resolver o sheetId para um chatId usando o arquivo de links e/ou env fallback. */
function resolveSheetIdForChat(chatId) {
  // 1) arquivo JSON { "<groupId>": "<sheetId>", ... }
  const db = loadLinksDb();
  if (db && db[chatId]) return db[chatId];

  // 2) fallback “geral” (se você quiser um default temporário)
  if (process.env.PROJECT_SHEET_ID) return process.env.PROJECT_SHEET_ID;

  return null;
}

/** Reinicializa o cliente com cooldown. */
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

// =====================
// Client
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
    selfId = c.info?.wid?._serialized || null;
    console.log('[WA] Cliente pronto ✅', selfId ? `(selfId: ${selfId})` : '');
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

  // --------------------
  // Mensagens
  // --------------------
  c.on('message', async (msg) => {
    try {
      const chat = await msg.getChat();
      const isGroup = chat?.isGroup;
      const authorName = msg._data?.notifyName || '';

      // 1) ANEXOS → Drive + LOG
      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia(); // { data(base64), mimetype, filename }
          if (media && media.data) {
            const buffer = Buffer.from(media.data, 'base64');
            const ext = (media.mimetype && media.mimetype.split('/')[1]) || 'bin';
            const filename = (media.filename && media.filename.trim()) || `arquivo-${Date.now()}.${ext}`;

            const projectName = (isGroup && chat?.name) ? chat.name : 'Projeto';
            const upload = await uploadBuffer({
              projectName,
              filename,
              mimetype: media.mimetype,
              buffer
            });

            // tenta registrar LOG no Sheets (se mapeado)
            const sheetId = isGroup ? resolveSheetIdForChat(chat.id._serialized) : resolveSheetIdForChat(msg.from);
            if (sheetId) {
              try {
                await appendLog(sheetId, {
                  tipo: 'Upload',
                  autor: authorName,
                  mensagem: `Upload recebido no grupo "${projectName}"`,
                  arquivo: filename,
                  link: upload.webViewLink || upload.webContentLink || '',
                  obs: ''
                });
              } catch (e) {
                console.error('[LOG] Falha ao registrar no Sheets:', e?.message || e);
              }
            }

            const link = upload.webViewLink || upload.webContentLink || '';
            const confirm =
              `📎 *Arquivo recebido*\n` +
              `• Nome: ${filename}\n` +
              (isGroup ? `• Projeto: ${projectName}\n` : '') +
              (link ? `• Acesso: ${link}\n` : '• Acesso: (restrito ao Drive)\n') +
              `\n✅ Salvo na pasta do mês do projeto.`;
            await msg.reply(confirm);
            console.log(`[WA] Upload ok (${filename}) ${link ? '→ link enviado' : ''}`);
            // Não continua para IA se era só anexo:
            return;
          }
        } catch (e) {
          console.error('[WA] Erro ao processar anexo:', e);
          await msg.reply('❌ Tive um problema ao salvar seu arquivo no Drive. Pode reenviar em instantes?');
          return;
        }
      }

      // 2) TEXTO → IA (regras de grupo x 1:1)
      const body = (msg.body || '').trim();
      const isCommand = body.startsWith('/');
      let mentioned = false;

      if (isGroup && selfId) {
        try {
          const mentions = await msg.getMentions();
          mentioned = Array.isArray(mentions) && mentions.some(m => m.id?._serialized === selfId);
        } catch (_) {}
      }

      // Em grupo: só responde se for mencionado ou comando:
      if (isGroup && !isCommand && !mentioned) {
        // silencia para não poluir conversa
        return;
      }

      // Chama IA
      const reply = await generateReply(body, {
        from: msg.from,
        pushName: authorName,
        isGroup,
        groupName: isGroup ? chat?.name : undefined
      });

      await msg.reply(reply);
      console.log(`[WA] Resposta (IA) enviada para ${msg.from}: "${(reply || '').slice(0, 120)}..."`);
    } catch (err) {
      console.error('[WA] Erro ao processar mensagem:', err);
      try { await msg.reply('Tive um problema técnico agora há pouco. Pode reenviar sua mensagem?'); } catch (_) {}
      sendAlert(`❗ Erro ao responder mensagem: ${err?.message || err}`);
    }
  });
}

// =====================
// Inicialização pública
// =====================
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
      } catch (_) {}
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
