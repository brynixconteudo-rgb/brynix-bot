// whatsapp.js — versão completa com MENU numerado, gatilhos naturais e controle de mute
// -------------------------------------------------------------------------------

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

// Integrações internas do seu projeto
const { generateReply } = require('./ai');
const { extractSheetId, readTasks, buildStatusSummary } = require('./sheets');
const { saveIncomingMediaToDrive } = require('./drive');

// ---------------------- Config & Estado ---------------------------------------

const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const REINIT_COOLDOWN_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 60_000;

let client;
let currentState = 'starting';
let lastQr = '';
let reinitNotBefore = 0;

/** chatId -> boolean (mute) */
const muteMap = new Map();
/** chatId -> { sheetId, projectName } */
const linkMap = new Map();
/** chatId -> { ts: number, projectName: string } : “janela” para aceitar 1..6 */
const lastMenuSent = new Map();

// ---------------------- Helpers de formatação ---------------------------------

const B = s => `*${s}*`;
const I = s => `_${s}_`;
const OK = '✅';
const WARN = '⚠️';
const NO = '❌';

function chunkText(text, limit = 3500) {
  if (!text) return [''];
  const out = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}
async function safeReply(msg, text) {
  for (const part of chunkText(text)) await msg.reply(part);
}

function getLastQr() { return lastQr; }

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
        '--single-process'
      ]
    },
    restartOnAuthFail: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 5_000,
  });
}

async function safeReinit(reason = 'unknown') {
  const now = Date.now();
  if (now < reinitNotBefore) return;
  reinitNotBefore = now + REINIT_COOLDOWN_MS;

  try { if (client) try { await client.destroy(); } catch (_) {} } catch (_) {}
  client = buildClient();
  wireEvents(client);
  client.initialize();
}

// ---------------------- Vínculo de projeto ------------------------------------

function setProjectLink(chatId, sheetId, projectName) {
  linkMap.set(chatId, { sheetId, projectName });
}
function getProjectLink(chatId) {
  return linkMap.get(chatId) || null;
}

function isGroupMsg(msg) { return msg.from.endsWith('@g.us'); }

function wasBotMentioned(msg) {
  // heurística simples — suficiente para WhatsApp Web
  const txt = (msg.body || '').toLowerCase();
  const hasAt = txt.includes('@');
  const hasName = msg._data?.notifyName ? txt.includes((msg._data.notifyName || '').toLowerCase()) : false;
  return (msg.mentionedIds && msg.mentionedIds.length > 0) || hasAt || hasName;
}

// ---------------------- Cards / Menu ------------------------------------------

function introCard(projectName) {
  return [
    `Posso ajudar com o projeto. Aqui está o menu:`,
    '',
    `${B(`${projectName} — Assistente de Projeto`)}`,
  ].join('\n');
}

function menuCard(projectName) {
  return [
    `${B(`${projectName} — Assistente de Projeto`)}`,
    '',
    `${B('Opções')}`,
    '1️⃣  Resumo completo',
    '2️⃣  Resumo curto',
    '3️⃣  Próximos (hoje/amanhã)',
    '4️⃣  Atrasadas (top 8)',
    '5️⃣  Quem participa',
    '6️⃣  Silenciar / Ativar bot',
    '',
    I('Responda com o número da opção (1 a 6).')
  ].join('\n');
}

async function sendMenu(msg, link, withIntro = false) {
  if (withIntro) await safeReply(msg, introCard(link.projectName));
  await safeReply(msg, menuCard(link.projectName));

  lastMenuSent.set(msg.from, { ts: Date.now(), projectName: link.projectName });
}

function menuWindowIsOpen(chatId, maxMs = 5 * 60 * 1000) {
  const e = lastMenuSent.get(chatId);
  if (!e) return false;
  return (Date.now() - e.ts) <= maxMs;
}

// ---------------------- Handlers de ações de projeto --------------------------

async function handleSummaryComplete(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const card = buildStatusSummary(link.projectName, tasks);
    await safeReply(msg, card);
  } catch (e) {
    console.error(e);
    await msg.reply(`${NO} Não consegui ler a planilha para gerar o resumo.`);
  }
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
    const top = Object.entries(byStatus)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([s, n]) => `• ${s}: ${n}`)
      .join('\n') || '• Sem dados';

    const atrasadas = tasks.filter(t => /atrasad/i.test(t.status || '')).length;

    const txt = [
      `${B(`${link.projectName} — Resumo Rápido`)}`,
      `Total de tarefas: ${total}`,
      top,
      `Atrasadas: ${atrasadas}`,
    ].join('\n');
    await safeReply(msg, txt);
  } catch (e) {
    console.error(e);
    await msg.reply(`${NO} Não consegui gerar o resumo curto.`);
  }
}

function parseDateBR(s) {
  const m = (s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const d = +m[1], mo = +m[2] - 1, y = +m[3] + (m[3].length === 2 ? 2000 : 0);
  return new Date(y, mo, d);
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
      const od = trunc(dt), td = trunc(today);
      return (+od === +td) || (+od === +tomorrow);
    }).slice(0, 8);

    const title = `${B(`${link.projectName} — Próximos (hoje/amanhã)`)}\n`;
    const lines = due.length
      ? due.map(t => `• ${t.tarefa}${t.responsavel ? ` ${I(`(${t.responsavel})`)}` : ''}`).join('\n')
      : 'Nenhuma tarefa para hoje/amanhã.';
    await safeReply(msg, title + lines);
  } catch (e) {
    console.error(e);
    await msg.reply(`${NO} Não consegui obter os próximos itens.`);
  }
}

async function handleLate(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const atrasadas = tasks.filter(t => /atrasad/i.test(t.status || '')).slice(0, 8);
    const title = `${B(`${link.projectName} — Atrasadas (top 8)`)}\n`;
    const lines = atrasadas.length
      ? atrasadas.map(t => `• ${t.tarefa}${t.responsavel ? ` ${I(`(${t.responsavel})`)}` : ''}`).join('\n')
      : 'Sem atrasadas. 👌';
    await safeReply(msg, title + lines);
  } catch (e) {
    console.error(e);
    await msg.reply(`${NO} Não consegui listar atrasadas.`);
  }
}

async function handleWho(msg, link) {
  const txt = [
    `${B(`${link.projectName} — Membros do grupo`)}`,
    I('Baseado nos participantes do WhatsApp.')
  ].join('\n');
  await safeReply(msg, txt);
}

// ---------------------- Router / Eventos --------------------------------------

function wireEvents(c) {
  c.on('qr', (qr) => { lastQr = qr; currentState = 'qr'; console.log('[WA] QR gerado'); });
  c.on('authenticated', () => console.log('[WA] Autenticado'));
  c.on('auth_failure', (m) => { console.error('[WA] auth_failure', m); safeReinit('auth_failure'); });
  c.on('ready', () => { currentState = 'ready'; console.log('[WA] Pronto ✅'); });
  c.on('disconnected', (r) => { currentState = 'disconnected'; console.error('[WA] Desconectado', r); safeReinit('disconnected'); });

  c.on('message', async (msg) => {
    try {
      const chat = await msg.getChat();
      const isGroup = chat.isGroup;
      if (!isGroup) {
        // 1:1 segue seu fluxo “IA geral”
        const reply = await generateReply(msg.body || '', { from: msg.from, pushName: msg._data?.notifyName });
        return safeReply(msg, reply);
      }

      const chatId = msg.from;
      const text = (msg.body || '').trim();
      const textLower = text.toLowerCase();
      const isCommand = text.startsWith('/');
      const mentioned = wasBotMentioned(msg);

      // ----------------— Desmutar deve funcionar mesmo mutado ----------------
      if (isCommand && /^\/(mute|silencio)\s*off/i.test(text)) {
        muteMap.delete(chatId);
        return msg.reply(I('voltei a falar 😉'));
      }

      // ----------------— Upload de mídia (se houver) -------------------------
      if (msg.hasMedia) {
        const link = getProjectLink(chatId);
        if (!link) return msg.reply(`${WARN} Vincule o projeto: /setup <sheetId|url> | <Nome>`);
        try {
          const res = await saveIncomingMediaToDrive(c, msg, link);
          if (res?.url) return safeReply(msg, `${OK} Arquivo salvo em ${B(link.projectName)}.\n🔗 ${res.url}`);
          return msg.reply(`${NO} Não consegui salvar no Drive.`);
        } catch (e) {
          console.error(e);
          return msg.reply(`${NO} Não consegui salvar no Drive.`);
        }
      }

      // ----------------— Se estiver mutado, sai (exceto unmute acima) --------
      if (muteMap.get(chatId)) return;

      // ----------------— /setup: vincular planilha ---------------------------
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

      // ----------------— /mute on/off e sinônimos ----------------------------
      if (isCommand && /^\/(mute|silencio)\s*on/i.test(text)) {
        muteMap.set(chatId, true);
        return msg.reply(I('ok, fico em silêncio até /mute off'));
      }
      if (isCommand && /^\/(mute|silencio)\s*off/i.test(text)) {
        muteMap.delete(chatId);
        return msg.reply(I('voltei a falar 😉'));
      }

      // ----------------— Ações por comando direto ----------------------------
      if (isCommand && /^\/menu|^\/help/i.test(text)) {
        const link = getProjectLink(chatId) || { projectName: 'Assistente' };
        return sendMenu(msg, link, false);
      }
      if (isCommand && /^\/summary\b/i.test(text)) {
        const link = getProjectLink(chatId);
        if (!link) return msg.reply(`${WARN} Vincule o projeto: /setup <sheetId|url> | <Nome>`);
        return handleSummaryComplete(msg, link);
      }
      if (isCommand && /^\/next\b/i.test(text)) {
        const link = getProjectLink(chatId);
        if (!link) return msg.reply(`${WARN} Vincule o projeto: /setup <sheetId|url> | <Nome>`);
        return handleNext(msg, link);
      }
      if (isCommand && /^\/late\b/i.test(text)) {
        const link = getProjectLink(chatId);
        if (!link) return msg.reply(`${WARN} Vincule o projeto: /setup <sheetId|url> | <Nome>`);
        return handleLate(msg, link);
      }
      if (isCommand && /^\/who\b/i.test(text)) {
        const link = getProjectLink(chatId);
        if (!link) return msg.reply(`${WARN} Vincule o projeto: /setup <sheetId|url> | <Nome>`);
        return handleWho(msg, link);
      }

      // ----------------— Triggers naturais (menção + palavra-chave) ----------
      const askedForMenu =
        mentioned &&
        (textLower.includes('menu') ||
         textLower.includes('opções') ||
         textLower.includes('opcoes') ||
         textLower.includes('ajuda'));

      const askedToIntroduce =
        mentioned &&
        (textLower.includes('apresente-se') ||
         textLower.includes('apresentar') ||
         textLower.includes('apresentação') ||
         textLower.includes('apresente'));

      // Se falar “menu/ajuda” com menção
      if (askedForMenu) {
        const link = getProjectLink(chatId) || { projectName: 'Assistente' };
        return sendMenu(msg, link, false);
      }

      // “apresente-se” com menção → intro + menu
      if (askedToIntroduce) {
        const link = getProjectLink(chatId) || { projectName: 'Assistente' };
        return sendMenu(msg, link, true);
      }

      // ----------------— Seleção numérica (1..6) após envio do menu ----------
      if (/^[1-6]$/.test(text)) {
        if (!menuWindowIsOpen(chatId)) {
          // ignora — menu não foi enviado recentemente
        } else {
          const link = getProjectLink(chatId);
          if (!link) return msg.reply(`${WARN} Vincule o projeto: /setup <sheetId|url> | <Nome>`);

          switch (text) {
            case '1': return handleSummaryComplete(msg, link);
            case '2': return handleSummaryBrief(msg, link);
            case '3': return handleNext(msg, link);
            case '4': return handleLate(msg, link);
            case '5': return handleWho(msg, link);
            case '6':
              if (muteMap.get(chatId)) {
                muteMap.delete(chatId);
                return msg.reply(I('voltei a falar 😉'));
              } else {
                muteMap.set(chatId, true);
                return msg.reply(I('ok, fico em silêncio até /mute off'));
              }
          }
        }
      }

      // ----------------— “menu” em linguagem natural sem menção --------------
      if (/^menu$|ajuda|opções|opcoes/i.test(text)) {
        const link = getProjectLink(chatId) || { projectName: 'Assistente' };
        return sendMenu(msg, link, false);
      }

      // ----------------— Se houver projeto vinculado, respostas úteis --------
      const link = getProjectLink(chatId);
      if (link && (mentioned || /resumo curto|resumo completo|próximos|proximos|atrasadas|quem participa/i.test(textLower))) {
        // chute leve para manter conversação natural
        if (/resumo curto/i.test(textLower)) return handleSummaryBrief(msg, link);
        if (/resumo completo|resumo geral|summary/i.test(textLower)) return handleSummaryComplete(msg, link);
        if (/próximos|proximos|hoje|amanhã|amanha/i.test(textLower)) return handleNext(msg, link);
        if (/atrasadas|atrasados/i.test(textLower)) return handleLate(msg, link);
        if (/quem participa|participantes|quem está/i.test(textLower)) return handleWho(msg, link);
      }

      // ----------------— Fallback: ajuda se menção; senão, ignora ------------
      if (mentioned) {
        const lk = getProjectLink(chatId) || { projectName: 'Assistente' };
        return sendMenu(msg, lk, false);
      }

      // Não fazer nada se ninguém chamou o bot explicitamente.
      return;

    } catch (err) {
      console.error('[WA] erro msg:', err);
      try { await msg.reply('Dei uma engasgada técnica aqui. Pode reenviar?'); } catch (_) {}
    }
  });
}

// ---------------------- Inicialização/HTTP helpers -----------------------------

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
        const qr = getLastQr();
        if (!qr) return res.status(503).send('QR ainda não gerado. Aguarde e recarregue.');
        const png = await QRCode.toBuffer(qr, { type: 'png', margin: 1, scale: 6 });
        res.type('image/png').send(png);
      } catch (e) {
        console.error(e);
        res.status(500).send('Erro ao gerar QR');
      }
    });
  }

  client.initialize();

  // watchdog simples para reconectar
  setInterval(async () => {
    try {
      const s = await client.getState().catch(() => null);
      if (!s || ['CONFLICT', 'UNPAIRED', 'UNLAUNCHED'].includes(s)) {
        safeReinit(`watchdog:${s || 'null'}`);
      } else if (currentState !== 'ready' && s === 'CONNECTED') {
        currentState = 'ready';
      }
    } catch (e) {
      safeReinit('watchdog-error');
    }
  }, WATCHDOG_INTERVAL_MS);
}

module.exports = { initWhatsApp, getLastQr };
