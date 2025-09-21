// whatsapp.js
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { generateReply, summarizeLog } = require('./ai');
const {
  setGroupConfig, getGroupConfig,
  appendLog, readRecentLog, notifyZap, saveMediaToDisk
} = require('./gp');

const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const REINIT_COOLDOWN_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 60_000;

let currentState = 'starting';
let lastQr = '';
let reinitNotBefore = 0;
let client;

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

function getLastQr() { return lastQr; }

async function sendAlert(payload) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) { console.log('ℹ️ ALERT_WEBHOOK_URL não configurada; alerta:', payload); return; }
  try {
    const body = typeof payload === 'string' ? { text: payload } : (payload || { text: '⚠️ Alerta sem conteúdo' });
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    console.log('🚨 Alerta enviado com sucesso.');
  } catch (err) {
    console.error('❌ Erro ao enviar alerta para webhook:', err);
  }
}

function buildClient() {
  return new Client({
    authStrategy: new LocalAuth({ clientId: 'brynix-bot', dataPath: SESSION_PATH }),
    puppeteer: {
      headless: true, timeout: 60_000,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process'],
    },
    restartOnAuthFail: true, takeoverOnConflict: true, takeoverTimeoutMs: 5_000,
  });
}

async function safeReinit(reason='unknown') {
  const now = Date.now();
  if (now < reinitNotBefore) { console.log(`[WA] Reinit ignorado (cooldown). Motivo: ${reason}`); return; }
  reinitNotBefore = now + REINIT_COOLDOWN_MS;
  try { if (client) { try { await client.destroy(); } catch (_) {} } } catch (e) { console.error('[WA] destroy err:', e); }
  client = buildClient();
  wireEvents(client);
  client.initialize();
}

function wireEvents(c) {
  c.on('qr', (qr) => { lastQr = qr; currentState='qr'; console.log('[WA] QR gerado. Abra /wa-qr para escanear.'); sendAlert('🔄 BOT Brynix requer novo pareamento: abra /wa-qr e escaneie o código.'); });
  c.on('authenticated', () => console.log('[WA] Autenticado'));
  c.on('auth_failure', (m) => { console.error('[WA] Falha de autenticação:', m); sendAlert(`⚠️ Falha de autenticação: ${m||'motivo não informado'}`); safeReinit('auth_failure'); });
  c.on('ready', () => { currentState='ready'; console.log('[WA] Cliente pronto ✅'); sendAlert('✅ BOT Brynix online e pronto.'); });
  c.on('change_state', (s) => { currentState = s || currentState; console.log('[WA] Estado alterado:', currentState); });
  c.on('loading_screen', (p, msg) => console.log(`[WA] loading_screen: ${p}% - ${msg}`));
  c.on('disconnected', (reason) => { currentState='disconnected'; console.error('[WA] Desconectado:', reason); sendAlert(`❌ BOT Brynix desconectado: ${reason||'n/i'}`); safeReinit(`disconnected:${reason||'unknown'}`); });

  // ========= Mensagens =========
  c.on('message', async (msg) => {
    try {
      const chat = await msg.getChat();
      const isGroup = chat.isGroup;
      const sender = await msg.getContact();
      const senderName = sender?.pushname || sender?.name || msg._data?.notifyName || msg.from;

      const baseLog = {
        groupId: isGroup ? chat.id._serialized : null,
        chatName: isGroup ? chat.name : null,
        sender: msg.from,
        senderName,
      };

      // Log leve de tudo (só em grupo) – ajuda no /summary
      if (isGroup) {
        if (msg.hasMedia) {
          appendLog(chat.id._serialized, { ...baseLog, type: 'media', caption: msg.caption || '' });
        } else {
          appendLog(chat.id._serialized, { ...baseLog, type: 'text', text: msg.body });
        }
      }

      // ====== Grupo (modo GP c/ comandos) ======
      if (isGroup) {
        // Comandos começam com '/'. Se não for comando, não responde em grupo.
        if (!String(msg.body || msg.caption || '').trim().startsWith('/')) return;

        const raw = (msg.body || msg.caption || '').trim();
        const [cmd, ...rest] = raw.split(' ');
        const argLine = raw.slice(cmd.length).trim();

        switch ((cmd || '').toLowerCase()) {
          case '/setup': {
            // formato: /setup <URL_sheet> | <Nome do Projeto>
            const [sheetUrlRaw, projRaw] = argLine.split('|').map(s => (s||'').trim());
            if (!sheetUrlRaw || !projRaw) {
              await msg.reply('Uso: /setup <URL_da_planilha> | <Nome do Projeto>');
              return;
            }
            setGroupConfig(chat.id._serialized, { sheetUrl: sheetUrlRaw, projectName: projRaw });
            await msg.reply(`Config salva!\nProjeto: *${projRaw}*\nSheet: ${sheetUrlRaw}`);
            await notifyZap('setup', { groupId: chat.id._serialized, projectName: projRaw, sheetUrl: sheetUrlRaw });
            break;
          }

          case '/who': {
            const cfg = getGroupConfig(chat.id._serialized);
            if (!cfg) { await msg.reply('Nenhuma configuração encontrada. Use: /setup <URL> | <Projeto>'); return; }
            await msg.reply(`Projeto: *${cfg.projectName || 'n/i'}*\nSheet: ${cfg.sheetUrl || 'n/i'}`);
            break;
          }

          case '/note': {
            const txt = argLine || '(sem texto)';
            appendLog(chat.id._serialized, { ...baseLog, type: 'note', text: txt });
            await msg.reply('Anotado ✅');
            await notifyZap('note', { groupId: chat.id._serialized, projectName: getGroupConfig(chat.id._serialized)?.projectName, text: txt, sender: senderName });
            break;
          }

          case '/doc': {
            if (!msg.hasMedia) { await msg.reply('Envie um **arquivo** com a legenda `/doc <título>`'); return; }
            const media = await msg.downloadMedia(); // { data (base64), mimetype, filename? }
            const title = argLine || 'documento';
            const stamp = Date.now();
            const file = saveMediaToDisk(chat.id._serialized, media, `${stamp}-${slugify(title)}`);
            appendLog(chat.id._serialized, { ...baseLog, type: 'doc', text: title, path: file });
            await msg.reply(`Documento recebido e salvo ✅\n${pathShort(file)}`);
            await notifyZap('doc', { groupId: chat.id._serialized, projectName: getGroupConfig(chat.id._serialized)?.projectName, title, path: file, mimetype: media.mimetype, sender: senderName });
            break;
          }

          case '/summary': {
            const cfg = getGroupConfig(chat.id._serialized) || {};
            const events = readRecentLog(chat.id._serialized, 1440); // 24h
            const text = await summarizeLog(events, cfg.projectName || chat.name || 'Projeto', 1440);
            await msg.reply(text);
            await notifyZap('summary', { groupId: chat.id._serialized, projectName: cfg.projectName, size: events.length });
            break;
          }

          default:
            await msg.reply('Comandos disponíveis: /setup | /who | /note | /doc | /summary');
        }
        return; // grupo – não cai no fluxo de IA padrão abaixo
      }

      // ====== 1:1 (fluxo IA atual) ======
      const reply = await generateReply(msg.body, { from: msg.from, pushName: senderName });
      await msg.reply(reply);
      console.log(`[WA] Resposta (IA) enviada para ${msg.from}: "${(reply||'').slice(0,120)}..."`);
    } catch (err) {
      console.error('[WA] Erro ao processar mensagem:', err);
      try { await msg.reply('Tive um problema técnico agora há pouco. Pode reenviar sua mensagem?'); } catch (_) {}
    }
  });
}

function pathShort(p) { return p.replace(/^\/var\/data\//, '/data/'); }
function slugify(s='') { return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }

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
