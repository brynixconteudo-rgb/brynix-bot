// whatsapp.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const { generateReply } = require('./ai');

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

// Logs em memória por chat (curto, suficiente p/ summary leve)
const chatLogs = new Map(); // chatId -> [{type, text, ts}]
const chatMeta = new Map(); // chatId -> { projectName, milestones: [] }

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

function appendLog(chatId, entry) {
  const arr = chatLogs.get(chatId) || [];
  arr.push({ ...entry, ts: Date.now() });
  // mantém no máx 200 itens por chat (leve)
  if (arr.length > 200) arr.shift();
  chatLogs.set(chatId, arr);
}

function lastEntries(chatId, n = 30) {
  const arr = chatLogs.get(chatId) || [];
  return arr.slice(-n);
}

// =====================
// Cliente WhatsApp
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

function helpCard() {
  return (
`*Comandos*  
• */setup* – definir nome do projeto e marcos  
• */summary* – sumário do período (com base no que foi registrado)  
• */note <texto>* – registrar nota rápida  
• */doc <descrição>* – registrar documento (meta)  
• */remind <hora> <texto>* – lembrete rápido (ack)

Dica: também aceito “help”, “menu”, “o que você faz?”.  
Quando não usar comandos, respondo normalmente com IA.`
  );
}

async function handleSummary(chatId, msg) {
  const meta = chatMeta.get(chatId) || {};
  const entries = lastEntries(chatId, 40);

  if (!entries.length) {
    return 'Não tenho eventos suficientes para resumir ainda. Use */note*, */doc* e depois chame */summary*.';
  }

  // Monta um prompt curtinho para a IA resumir os eventos
  const bullets = entries.map(e => {
    const dt = new Date(e.ts).toLocaleString('pt-BR');
    return `- [${dt}] ${e.type.toUpperCase()}: ${e.text}`;
  }).join('\n');

  const context = [
    meta.projectName ? `Projeto: ${meta.projectName}` : null,
    meta.milestones?.length ? `Marcos: ${meta.milestones.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  const ask = `Resuma de forma executiva os itens abaixo (máx 6 bullets) e traga próximos passos claros. 
Se fizer sentido, inclua % de avanço *somente* se houver evidência no texto.  
${context ? `\n${context}\n` : ''}

Itens:
${bullets}`;

  const out = await generateReply(ask, { from: chatId });
  return out;
}

// Comandos naturais (sem barra) que disparam o help
function looksLikeHelp(s) {
  const t = s.toLowerCase();
  return (
    t === 'help' ||
    t === 'menu' ||
    t.includes('o que você faz') ||
    t.includes('o que vc faz') ||
    t.includes('comandos')
  );
}

// Roteador de comandos (retorna string de resposta ou null)
async function commandRouter(chatId, body) {
  const text = (body || '').trim();
  const lower = text.toLowerCase();

  if (looksLikeHelp(lower) || lower.startsWith('/help')) {
    return helpCard();
  }

  if (lower.startsWith('/setup')) {
    // /setup Nome do Projeto | marco1 ; marco2 ; marco3
    const raw = text.slice(6).trim();
    const [pNamePart, milestonesPart] = raw.split('|').map(s => (s || '').trim());
    const meta = chatMeta.get(chatId) || { projectName: '', milestones: [] };
    if (pNamePart) meta.projectName = pNamePart;
    if (milestonesPart) {
      meta.milestones = milestonesPart
        .split(/;|,/)
        .map(s => s.trim())
        .filter(Boolean);
    }
    chatMeta.set(chatId, meta);

    return `Configuração ok ✅ 
*Projeto:* ${meta.projectName || '—'}
*Marcos:* ${meta.milestones?.length ? meta.milestones.join(', ') : '—'}

Use */note* e */doc* para registrar fatos; depois */summary* faz um resumo executivo.`;
  }

  if (lower.startsWith('/note')) {
    const content = text.slice(5).trim();
    if (!content) return 'Use */note <texto>* para registrar uma nota.';
    appendLog(chatId, { type: 'note', text: content });
    return 'Nota registrada 📝';
  }

  if (lower.startsWith('/doc')) {
    const content = text.slice(4).trim();
    if (!content) return 'Use */doc <descrição>* para registrar um documento (meta).';
    appendLog(chatId, { type: 'doc', text: content });
    return 'Documento registrado 📎 (meta).';
  }

  if (lower.startsWith('/summary')) {
    return await handleSummary(chatId, text);
  }

  if (lower.startsWith('/remind')) {
    // Stub: apenas registra para compor o summary (sem agendar real)
    const content = text.slice(7).trim();
    appendLog(chatId, { type: 'remind', text: content || '(lembrete)' });
    return 'Lembrete anotado ⏰ (ack).';
  }

  // não é comando
  return null;
}

function wireEvents(c) {
  c.on('qr', (qr) => {
    lastQr = qr;
    currentState = 'qr';
    console.log('[WA] QR gerado. Abra /wa-qr para escanear.');
    sendAlert('🔄 BOT Brynix requer novo pareamento: abra /wa-qr e escaneie o código.');
  });

  c.on('authenticated', () => console.log('[WA] Autenticado'));

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

  c.on('disconnected', (reason) => {
    currentState = 'disconnected';
    console.error('[WA] Desconectado:', reason);
    sendAlert(`❌ BOT Brynix desconectado. Motivo: ${reason || 'não informado'}`);
    safeReinit(`disconnected:${reason || 'unknown'}`);
  });

  // Mensagens (grupos e 1:1)
  c.on('message', async (msg) => {
    try {
      const chat = await msg.getChat();
      const chatId = chat.id._serialized;
      const text = (msg.body || '').trim();

      // 1) roteia comandos (com ou sem barra help/menu)
      const routed = await commandRouter(chatId, text);
      if (routed) {
        await msg.reply(routed);
        // loga o “evento” para ajudar no summary
        appendLog(chatId, { type: 'cmd', text });
        return;
      }

      // 2) se não for comando e a mensagem for “ajuda natural”
      if (looksLikeHelp(text)) {
        await msg.reply(helpCard());
        appendLog(chatId, { type: 'cmd', text: '/help (natural)' });
        return;
      }

      // 3) fluxo normal -> IA
      appendLog(chatId, { type: 'msg', text });
      const reply = await generateReply(text, {
        from: msg.from,
        pushName: msg._data?.notifyName,
      });

      await msg.reply(reply);
      appendLog(chatId, { type: 'ia', text: reply });
    } catch (err) {
      console.error('[WA] Erro ao processar mensagem:', err);
      try { await msg.reply('Tive um problema técnico agora há pouco. Pode reenviar sua mensagem?'); } catch (_) {}
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
        console.log('[WA] Estado ok (CONNECTED)');
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
