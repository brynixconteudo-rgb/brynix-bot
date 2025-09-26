// whatsapp.js — versão com MENU INTERATIVO (ListMessage)
//
// Requisitos já existentes no projeto:
// - ai.js -> generateReply()
// - sheets.js -> extractSheetId(), readTasks(), buildStatusSummary()
// - drive.js -> saveIncomingMediaToDrive()
// - nlu.js -> INTENTS, parse(text)
//
// OBS: os botões "Buttons" estão sendo descontinuados pela API do WhatsApp.
// Aqui usamos apenas ListMessage, que é o padrão moderno e estável.

const { Client, LocalAuth, List } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const { generateReply } = require('./ai');
const { extractSheetId, readTasks, buildStatusSummary } = require('./sheets');
const { saveIncomingMediaToDrive } = require('./drive');
const { INTENTS, parse: parseNLU } = require('./nlu');

// ------------------------------------------------------
// Infra
// ------------------------------------------------------
const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const REINIT_COOLDOWN_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 60_000;

let currentState = 'starting';
let lastQr = '';
let reinitNotBefore = 0;
let client;

const muteMap = new Map();   // chatId -> boolean
const linkMap = new Map();   // chatId -> { sheetId, projectName }

const B = (s) => `*${s}*`;
const I = (s) => `_${s}_`;
const OK = '✅';
const WARN = '⚠️';
const NO = '❌';

// ------------------------------------------------------
// Util
// ------------------------------------------------------
function chunkText(text, limit = 3500) {
  if (!text) return [''];
  const out = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}
async function safeReply(msg, text) { for (const part of chunkText(text)) await msg.reply(part); }

function isGroupMsg(msg) { return msg.from?.endsWith('@g.us'); }
function getProjectLink(chatId) { return linkMap.get(chatId) || null; }
function setProjectLink(chatId, sheetId, projectName) { linkMap.set(chatId, { sheetId, projectName }); }

function wasBotMentioned(msg) {
  const txt = (msg.body || '').toLowerCase();
  const hasAt = txt.includes('@');
  const push = msg._data?.notifyName ? txt.includes(msg._data.notifyName.toLowerCase()) : false;
  return (msg.mentionedIds && msg.mentionedIds.length > 0) || hasAt || push;
}

function parseDateBR(s) {
  const m = (s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const d = +m[1], mo = +m[2] - 1, y = +m[3] + (m[3].length === 2 ? 2000 : 0);
  return new Date(y, mo, d);
}

// ------------------------------------------------------
// WhatsApp client
// ------------------------------------------------------
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

async function safeReinit(_reason = 'unknown') {
  const now = Date.now();
  if (now < reinitNotBefore) return;
  reinitNotBefore = now + REINIT_COOLDOWN_MS;
  try { if (client) try { await client.destroy(); } catch (_) {} } catch (_) {}
  client = buildClient(); wireEvents(client); client.initialize();
}

function getLastQr() { return lastQr; }

// ------------------------------------------------------
// MENU INTERATIVO
// ------------------------------------------------------
function buildInteractiveMenu(projectName) {
  const name = projectName || 'Projeto';
  const sections = [
    {
      title: 'Resumo do Projeto',
      rows: [
        { id: 'summary',    title: '📊 Resumo completo' },
        { id: 'summary_br', title: '⚡ Resumo curto' },
        { id: 'next',       title: '📅 Próximos (hoje/amanhã)' },
        { id: 'late',       title: '⏰ Atrasadas (top 8)' },
      ],
    },
    {
      title: 'Ações',
      rows: [
        { id: 'remind', title: '🔔 Disparar lembrete agora' },
        { id: 'note',   title: '📝 Registrar nota' },
        { id: 'who',    title: '👥 Participantes' },
      ],
    },
    {
      title: 'Configurações',
      rows: [
        { id: 'mute_on',  title: '🔕 Silenciar o bot' },
        { id: 'mute_off', title: '🔔 Voltar a falar' },
      ],
    },
  ];

  return new List(
    `Selecione uma opção para *${name}*:`,
    'Abrir opções',
    sections,
    `${name} — Menu`
  );
}

async function sendMenu(msg, link) {
  const list = buildInteractiveMenu(link?.projectName);
  await msg.reply(list);
}

// ------------------------------------------------------
// Handlers de Projeto (planilha)
// ------------------------------------------------------
async function handleSummaryComplete(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const card = buildStatusSummary(link.projectName, tasks);
    await safeReply(msg, card + `\n${I('Dica: use /menu para opções rápidas')}`);
  } catch (e) { console.error(e); await msg.reply(`${NO} Não consegui ler a planilha.`); }
}

async function handleSummaryBrief(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const total = tasks.length;
    const byStatus = tasks.reduce((acc, t) => {
      const s = (t.status || 'Sem status').trim();
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});
    const top = Object.entries(byStatus).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([s, n]) => `• ${s}: ${n}`).join('\n') || '• Sem dados';
    const atrasadas = tasks.filter(t => /atrasad/i.test(t.status || '')).length;
    const txt = [
      `${B(`${link.projectName} — Resumo Rápido`)}`,
      `Total de tarefas: ${total}`,
      top,
      `Atrasadas: ${atrasadas}`,
      I('Dica: /summary para o completo'),
    ].join('\n');
    await safeReply(msg, txt);
  } catch (e) { console.error(e); await msg.reply(`${NO} Não consegui gerar o resumo curto.`); }
}

async function handleNext(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const today = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const trunc = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    const due = tasks.filter(t => {
      const dt = parseDateBR(t.dataTermino || t.dataFim || '');
      if (!dt) return false;
      const od = trunc(dt);
      const td = trunc(today);
      return (+od === +td) || (+od === +tomorrow);
    }).slice(0, 8);

    const title = `${B(`${link.projectName} — Próximos (hoje/amanhã)`)}\n`;
    const lines = due.length
      ? due.map(t => `• ${t.tarefa} ${I(t.responsavel ? `(${t.responsavel})` : '')}`).join('\n')
      : 'Nenhuma tarefa para hoje/amanhã.';
    await safeReply(msg, title + lines);
  } catch (e) { console.error(e); await msg.reply(`${NO} Não consegui obter os próximos itens.`); }
}

async function handleLate(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const atrasadas = tasks.filter(t => /atrasad/i.test(t.status || '')).slice(0, 8);
    const title = `${B(`${link.projectName} — Atrasadas (top 8)`)}\n`;
    const lines = atrasadas.length
      ? atrasadas.map(t => `• ${t.tarefa} ${I(t.responsavel ? `(${t.responsavel})` : '')}`).join('\n')
      : 'Sem atrasadas. 👌';
    await safeReply(msg, title + lines);
  } catch (e) { console.error(e); await msg.reply(`${NO} Não consegui listar atrasadas.`); }
}

async function handleRemindNow(msg, link) {
  // versão simples: manda o resumo completo (você pode trocar por DM para cada responsável etc.)
  await handleSummaryComplete(msg, link);
}

async function handleNote(msg, _link, noteText) {
  if (!noteText) return msg.reply(`${WARN} Escreva a nota: /note <texto>`);
  try {
    // TODO: persistir em planilha/DB se desejar
    await msg.reply(`${OK} Nota registrada: ${noteText}`);
  } catch (e) { console.error(e); await msg.reply(`${NO} Não consegui registrar a nota agora.`); }
}

async function handleWho(msg, link) {
  const txt = [
    `${B(`${link.projectName} — Participantes (WhatsApp)`)}`,
    I('Dica: em breve — “@BOT pendências da <pessoa>”.'),
  ].join('\n');
  await safeReply(msg, txt);
}

// ------------------------------------------------------
// Wire & Router
// ------------------------------------------------------
function wireEvents(c) {
  c.on('qr', (qr) => { lastQr = qr; currentState = 'qr'; console.log('[WA] QR gerado'); });
  c.on('authenticated', () => console.log('[WA] Autenticado'));
  c.on('auth_failure', (m) => { console.error('[WA] auth_failure', m); safeReinit('auth_failure'); });
  c.on('ready', () => { currentState = 'ready'; console.log('[WA] Pronto ✅'); });
  c.on('disconnected', (r) => { currentState = 'disconnected'; console.error('[WA] Desconectado', r); safeReinit('disconnected'); });

  // 1) Respostas do MENU (ListMessage)
  c.on('message', async (msg) => {
    try {
      // o WhatsApp envia uma mensagem especial quando o usuário clica numa opção da lista
      if (msg.type === 'list_response') {
        const chatId = msg.from;
        const link = getProjectLink(chatId);
        const selected = msg.selectedRowId || msg.body || '';
        if (!isGroupMsg(msg)) return;

        if (!link) {
          return msg.reply(`${WARN} Vincule o projeto: /setup <sheetId|url> | <Nome do Projeto>`);
        }

        if (muteMap.get(chatId) && !/^mute_off$/i.test(selected)) return;

        switch ((selected || '').toLowerCase()) {
          case 'summary':     return handleSummaryComplete(msg, link);
          case 'summary_br':  return handleSummaryBrief(msg, link);
          case 'next':        return handleNext(msg, link);
          case 'late':        return handleLate(msg, link);
          case 'remind':      return handleRemindNow(msg, link);
          case 'note':        return msg.reply(`${WARN} Envie: /note <texto da nota>`);
          case 'who':         return handleWho(msg, link);
          case 'mute_on':     muteMap.set(chatId, true);  return msg.reply(I('ok, fico em silêncio até /mute off'));
          case 'mute_off':    muteMap.delete(chatId);     return msg.reply(I('voltei a falar 😉'));
          default:            return msg.reply(`${WARN} Opção não reconhecida. Tente /menu.`);
        }
      }
    } catch (err) {
      console.error('[WA] erro list_response:', err);
      try { await msg.reply('Deu um tilt no menu. Manda /menu de novo?'); } catch (_) {}
    }
  });

  // 2) Mensagens comuns (comandos, menções e IA 1:1)
  c.on('message', async (msg) => {
    try {
      const chat = await msg.getChat();
      const isGroup = chat.isGroup;
      const chatId = msg.from;
      const text = msg.body || '';
      const isCommand = text.trim().startsWith('/');

      // — Grupo ou 1:1?
      if (!isGroup) {
        // 1:1: IA padrão
        const reply = await generateReply(text, { from: msg.from, pushName: msg._data?.notifyName });
        return safeReply(msg, reply);
      }

      // —— Sempre permitir desmutar
      if (isCommand && /^\/(?:mute|silencio)\s*off/i.test(text)) {
        muteMap.delete(chatId);
        return msg.reply(I('voltei a falar 😉'));
      }

      // —— Se estiver mutado, sai (exceto mute off acima)
      if (muteMap.get(chatId)) return;

      // —— Ativar mute
      if (isCommand && /^\/(?:mute|silencio)\s*on/i.test(text)) {
        muteMap.set(chatId, true);
        return msg.reply(I('ok, fico em silêncio até /mute off'));
      }

      // —— SETUP
      if (isCommand && /^\/setup/i.test(text)) {
        const parts = text.split('|');
        const sheetRaw = (parts[0] || '').replace(/\/setup/i, '').trim();
        const projectName = (parts[1] || '').trim();
        const sheetId = extractSheetId(sheetRaw);
        if (!sheetId || !projectName) {
          return msg.reply(`${WARN} Use: /setup <sheetId|url> | <Nome do Projeto>`);
        }
        setProjectLink(chatId, sheetId, projectName);
        return safeReply(msg, `${OK} ${B('Projeto vinculado!')}\n• Planilha: ${sheetId}\n• Nome: ${projectName}`);
      }

      // —— Uploads de mídia → Drive
      if (msg.hasMedia) {
        const link = getProjectLink(chatId);
        if (!link) return msg.reply(`${WARN} Vincule o projeto: /setup <sheetId|url> | <Nome>`);
        try {
          const res = await saveIncomingMediaToDrive(c, msg, link);
          if (res?.url) return safeReply(msg, `${OK} Arquivo salvo em ${B(link.projectName)}.\n🔗 ${res.url}`);
          return msg.reply(`${NO} Não consegui salvar no Drive.`);
        } catch (e) { console.error(e); return msg.reply(`${NO} Não consegui salvar no Drive.`); }
      }

      // —— MENU (comando ou menção “menu”)
      if (isCommand && /^\/menu/i.test(text)) {
        const link = getProjectLink(chatId);
        if (!link) return msg.reply(`${WARN} Vincule o projeto: /setup <sheetId|url> | <Nome>`);
        return sendMenu(msg, link);
      }
      if (wasBotMentioned(msg) && /\bmenu\b/i.test(text)) {
        const link = getProjectLink(chatId);
        if (!link) return msg.reply(`${WARN} Vincule o projeto: /setup <sheetId|url> | <Nome>`);
        return sendMenu(msg, link);
      }

      // —— Outros comandos diretos (/summary, /next etc.) + NLU
      const link = getProjectLink(chatId);
      if (!link) {
        // só incomodamos se for um comando ou menção
        if (isCommand || wasBotMentioned(msg)) {
          return msg.reply(`${WARN} Vincule o projeto: /setup <sheetId|url> | <Nome>`);
        }
        return; // conversa paralela no grupo sem menção → ignorar
      }

      // Comandos pontuais (continuam funcionando)
      if (isCommand && /^\/summary\b/i.test(text))      return handleSummaryComplete(msg, link);
      if (isCommand && /^\/next\b/i.test(text))         return handleNext(msg, link);
      if (isCommand && /^\/late\b/i.test(text))         return handleLate(msg, link);
      if (isCommand && /^\/remind\s*now\b/i.test(text)) return handleRemindNow(msg, link);
      if (isCommand && /^\/who\b/i.test(text))          return handleWho(msg, link);
      if (isCommand && /^\/note\b/i.test(text)) {
        const nt = text.replace(/^\/note\s*/i, '').trim();
        return handleNote(msg, link, nt);
      }

      // Interpretação natural quando o bot é mencionado
      if (wasBotMentioned(msg)) {
        const nlu = parseNLU(text);
        switch (nlu.intent) {
          case INTENTS.HELP:          return sendMenu(msg, link);
          case INTENTS.SUMMARY:
          case INTENTS.SUMMARY_FULL:  return handleSummaryComplete(msg, link);
          case INTENTS.SUMMARY_BRIEF: return handleSummaryBrief(msg, link);
          case INTENTS.NEXT:          return handleNext(msg, link);
          case INTENTS.LATE:          return handleLate(msg, link);
          case INTENTS.REMIND_NOW:    return handleRemindNow(msg, link);
          case INTENTS.NOTE:          return handleNote(msg, link, nlu.note);
          case INTENTS.WHO:           return handleWho(msg, link);
          case INTENTS.MUTE_ON:       muteMap.set(chatId, true);  return msg.reply(I('ok, fico em silêncio até /mute off'));
          case INTENTS.MUTE_OFF:      muteMap.delete(chatId);     return msg.reply(I('voltei a falar 😉'));
          default:                    return sendMenu(msg, link);
        }
      }

      // demais mensagens no grupo (sem menção/comando) → ignorar para evitar “falação” do bot
    } catch (err) {
      console.error('[WA] erro msg:', err);
      try { await msg.reply('Dei uma engasgada técnica aqui. Pode reenviar?'); } catch (_) {}
    }
  });
}

// ------------------------------------------------------
// Init + endpoints utilitários
// ------------------------------------------------------
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

    app.get('/wa-qr', async (_req, res) => {
      try {
        if (!lastQr) return res.status(503).send('QR ainda não gerado. Aguarde e recarregue.');
        const png = await QRCode.toBuffer(lastQr, { type: 'png', margin: 1, scale: 6 });
        res.type('image/png').send(png);
      } catch (e) { console.error(e); res.status(500).send('Erro ao gerar QR'); }
    });
  }

  client.initialize();

  // watchdog
  setInterval(async () => {
    try {
      const s = await client.getState().catch(() => null);
      if (!s || ['CONFLICT', 'UNPAIRED', 'UNLAUNCHED'].includes(s)) safeReinit(`watchdog:${s || 'null'}`);
      else if (currentState !== 'ready' && s === 'CONNECTED') currentState = 'ready';
    } catch (e) { safeReinit('watchdog-error'); }
  }, WATCHDOG_INTERVAL_MS);
}

module.exports = { initWhatsApp, getLastQr };
