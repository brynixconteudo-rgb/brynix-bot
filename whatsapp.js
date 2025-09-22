// whatsapp.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const { generateReply } = require('./ai');
const { getLink, setLink, removeLink } = require('./group-links');

const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const REINIT_COOLDOWN_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 60_000;

let currentState = 'starting';
let lastQr = '';
let reinitNotBefore = 0;
let client;

// ---------------- Utils ----------------
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
      try { await client.destroy(); } catch (_) {}
    }
  } catch (err) {
    console.error('[WA] Erro ao destruir cliente:', err);
  }

  client = buildClient();
  wireEvents(client);
  client.initialize();
}

// ---------------- Comandos de grupo ----------------
function parseCommand(text) {
  if (!text) return null;
  const t = text.trim();

  if (!t.startsWith('/')) return null;

  // formatos aceitos:
  // /setup <spreadsheetId>
  // /setup <spreadsheetId> | <Nome do Projeto>
  // /unlink
  // /link?
  const cmd = t.split(' ')[0].toLowerCase();

  if (cmd === '/setup') {
    const rest = t.slice('/setup'.length).trim();
    if (!rest) return { cmd: 'setup', error: 'Faltou o spreadsheetId.' };

    let spreadsheetId = rest;
    let projectName = '';

    // suporta separador " | "
    if (rest.includes('|')) {
      const [idPart, namePart] = rest.split('|');
      spreadsheetId = (idPart || '').trim();
      projectName = (namePart || '').trim();
    }

    if (!spreadsheetId) return { cmd: 'setup', error: 'SpreadsheetId inválido.' };
    return { cmd: 'setup', spreadsheetId, projectName };
  }

  if (cmd === '/unlink') return { cmd: 'unlink' };
  if (cmd === '/link?' || cmd === '/link') return { cmd: 'link?' };

  return { cmd: 'unknown' };
}

function userMentionedMe(msg) {
  // Em grupos, mensagem tem `mentionedIds`
  try {
    const mentions = msg.mentionedIds || [];
    return mentions.includes(client.info.wid._serialized);
  } catch {
    return false;
  }
}

// ---------------- Eventos ----------------
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

  // ------------- Mensagens -------------
  c.on('message', async (msg) => {
    try {
      const text = (msg.body || '').trim();
      const from = msg.from || '';
      const isGroup = from.endsWith('@g.us');

      // 1) Se for grupo: só respondo se for comando OU se fui mencionado
      let isCommand = false;
      let parsed = null;

      if (isGroup) {
        parsed = parseCommand(text);
        isCommand = !!parsed;

        if (!isCommand && !userMentionedMe(msg)) {
          // ignora conversa entre humanos
          return;
        }
      }

      // 2) Trata comandos de grupo
      if (isGroup && isCommand) {
        if (parsed.cmd === 'setup') {
          if (parsed.error) {
            await msg.reply(`❗ ${parsed.error}\nExemplo:\n/setup 1xX...abc | Pirâmide Imóveis`);
            return;
          }
          const link = await setLink(from, parsed.spreadsheetId, parsed.projectName);
          await msg.reply(
            `✅ Projeto vinculado!\n• Planilha: ${link.spreadsheetId}\n• Nome: ${link.projectName || '(não informado)'}`
          );
          return;
        }

        if (parsed.cmd === 'unlink') {
          await removeLink(from);
          await msg.reply('🗑️ Vínculo com planilha removido para este grupo.');
          return;
        }

        if (parsed.cmd === 'link?') {
          const link = await getLink(from);
          if (!link) {
            await msg.reply('ℹ️ Este grupo ainda não está vinculado a nenhuma planilha. Use:\n/setup <spreadsheetId> | <Nome opcional>');
          } else {
            await msg.reply(`🔗 Vínculo atual:\n• Planilha: ${link.spreadsheetId}\n• Nome: ${link.projectName || '(não informado)'}\n• Atualizado: ${link.updatedAt}`);
          }
          return;
        }

        if (parsed.cmd === 'unknown') {
          await msg.reply('🤖 Comando não reconhecido. Use /setup, /link? ou /unlink.');
          return;
        }
      }

      // 3) Fluxo de IA (1:1 sempre; em grupo só se mencionado/foi comando acima)
      console.log(`[WA] Mensagem recebida de ${from}: "${text}"`);

      // (no futuro) você pode recuperar o link do grupo e passar como contexto pra IA
      // const link = isGroup ? (await getLink(from)) : null;

      const reply = await generateReply(text, {
        from,
        pushName: msg._data?.notifyName,
        isGroup,
      });

      await msg.reply(reply);
      console.log(`[WA] Resposta (IA) enviada para ${from}: "${reply}"`);
    } catch (err) {
      console.error('[WA] Erro ao processar/enviar resposta (IA):', err);
      try {
        await msg.reply('Tive um problema técnico agora há pouco. Pode reenviar sua mensagem?');
      } catch (_) {}
      sendAlert(`❗ Erro ao responder mensagem: ${err?.message || err}`);
    }
  });
}

// ---------------- Inicialização ----------------
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
