// whatsapp.js
// Bot Brynix – orquestração do WhatsApp (grupo = GP; 1:1 = assistente BRYNIX)

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const { generateReply } = require('./ai');
const {
  extractSheetId,
  readTasks,
  buildStatusSummary,
  readProjectMeta,
  // Se existir em sheets.js, ótimo; caso não, vamos em fallback.
  readResources,
} = require('./sheets');

const { saveIncomingMediaToDrive } = require('./drive');
const { synthesize } = require('./tts');

// ---------------------- Config e estado ----------------------

const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const REINIT_COOLDOWN_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 60_000;

let client;
let currentState = 'starting';
let lastQr = '';
let reinitNotBefore = 0;

// Mapa: chatId -> { sheetId, projectName }
const links = new Map();
// Mapa: chatId -> true/false (mutado)
const muted = new Map();

// util de negrito/itálico
const B = (s) => `*${s}*`;
const I = (s) => `_${s}_`;
const OK = '✅';
const NO = '❌';
const WARN = '⚠️';

// ---------------------- Helpers ----------------------

function isGroup(msg) {
  try { return msg.from.endsWith('@g.us'); } catch { return false; }
}

function wasMentioned(msg) {
  const body = (msg.body || '').toLowerCase();
  if (msg.mentionedIds && msg.mentionedIds.length > 0) return true;
  // fallback por @
  return body.includes('@');
}

function getProjectLink(chatId) {
  return links.get(chatId) || null;
}

function setProjectLink(chatId, sheetId, projectName) {
  links.set(chatId, { sheetId, projectName });
}

function chunk(text, limit = 3500) {
  if (!text) return [''];
  const out = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}

async function replyChunked(msg, text) {
  for (const part of chunk(text)) await msg.reply(part);
}

function getLastQrPng() {
  return lastQr || '';
}

function buildMenuCard(projectName) {
  const title = `${projectName ? `${projectName} — ` : ''}Assistente de Projeto`;
  return [
    B(title),
    '',
    B('Opções'),
    '1️⃣  Resumo completo',
    '2️⃣  Resumo curto',
    '3️⃣  Próximos (hoje/amanhã)',
    '4️⃣  Atrasadas (top 8)',
    '5️⃣  Quem participa',
    '6️⃣  Silenciar / Ativar bot',
    '',
    I('Responda com o número da opção ou diga em linguagem natural.'),
  ].join('\n');
}

function isNaturalAsk(text, patterns) {
  const t = (text || '').toLowerCase();
  return patterns.some((p) => p.test(t));
}

function toUniqueSortedNames(list) {
  const set = new Set();
  list.forEach((n) => {
    const s = String(n || '').trim();
    if (s) set.add(s);
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

// ---------------------- Ações de GP ----------------------

async function actSummaryFull(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const card = buildStatusSummary(link.projectName, tasks);
    await replyChunked(msg, card);
  } catch (e) {
    console.error('[GP] resumo completo erro:', e);
    await msg.reply(`${NO} Não consegui ler a planilha (${e?.message || e}).`);
  }
}

async function actSummaryBrief(msg, link) {
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
      B(`${link.projectName} — Resumo rápido`),
      `Total de tarefas: ${total}`,
      top,
      `Atrasadas: ${atrasadas}`,
      '',
      I('Dica: responda "menu" para ver opções.'),
    ].join('\n');
    await replyChunked(msg, txt);
  } catch (e) {
    console.error('[GP] resumo curto erro:', e);
    await msg.reply(`${NO} Não consegui gerar o resumo curto.`);
  }
}

function parseDateBR(s) {
  const m = (s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const d = +m[1], mo = +m[2] - 1, y = +m[3] + (m[3].length === 2 ? 2000 : 0);
  return new Date(y, mo, d);
}

function truncDate(dt) {
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

async function actNext(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const today = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const td = truncDate(today);
    const tm = truncDate(tomorrow);

    const due = tasks.filter(t => {
      const dt = parseDateBR(t.dataTermino || t.dataFim || '');
      if (!dt) return false;
      const d = truncDate(dt);
      return (+d === +td) || (+d === +tm);
    }).slice(0, 8);

    const lines = due.length
      ? due.map(t => `• ${t.tarefa} ${I(t.responsavel ? `(${t.responsavel})` : '')}`).join('\n')
      : 'Nenhuma tarefa para hoje/amanhã.';

    await replyChunked(msg, `${B(`${link.projectName} — Próximos (hoje/amanhã)`)}\n${lines}`);
  } catch (e) {
    console.error('[GP] next erro:', e);
    await msg.reply(`${NO} Não consegui listar próximos.`);
  }
}

async function actLate(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const atrasadas = tasks.filter(t => /atrasad/i.test(t.status || '')).slice(0, 8);
    const lines = atrasadas.length
      ? atrasadas.map(t => `• ${t.tarefa} ${I(t.responsavel ? `(${t.responsavel})` : '')}`).join('\n')
      : 'Sem atrasadas. 👌';

    await replyChunked(msg, `${B(`${link.projectName} — Atrasadas (top 8)`)}\n${lines}`);
  } catch (e) {
    console.error('[GP] atrasadas erro:', e);
    await msg.reply(`${NO} Não consegui listar atrasadas.`);
  }
}

async function actWho(msg, link) {
  try {
    let names = [];

    // Se existir readResources (aba Rec_Projeto), usa.
    if (typeof readResources === 'function') {
      try {
        const res = await readResources(link.sheetId);
        names = toUniqueSortedNames(res.map(r => r.nome || r.name));
      } catch (e) {
        console.warn('[GP] readResources falhou, fallback por responsáveis das tarefas:', e?.message || e);
      }
    }

    // Fallback por responsáveis das tarefas:
    if (!names.length) {
      const tasks = await readTasks(link.sheetId);
      names = toUniqueSortedNames(tasks.map(t => t.responsavel));
    }

    const lines = names.length ? names.map(n => `• ${n}`).join('\n') : 'Não encontrei nomes na planilha.';
    await replyChunked(msg, `${B(`${link.projectName} — Participantes`)}\n${lines}`);
  } catch (e) {
    console.error('[GP] who erro:', e);
    await msg.reply(`${NO} Não consegui obter participantes.`);
  }
}

async function actIntroduce(msg, link) {
  try {
    const meta = await readProjectMeta(link.sheetId);
    const obj = meta.ProjectObjectives || meta.ProjectObjective || '';
    const ben = meta.ProjectBenefits || '';
    const tim = meta.ProjectTimeline || '';

    const txt = [
      B(`${link.projectName} — Apresentação do Projeto`),
      obj ? `• ${B('Objetivos')}: ${obj}` : '',
      ben ? `• ${B('Benefícios esperados')}: ${ben}` : '',
      tim ? `• ${B('Prazo estimado')}: ${tim}` : '',
      '',
      I('Se precisar de algo, me mencione e diga em linguagem natural, ou responda "menu".'),
    ].filter(Boolean).join('\n');

    await replyChunked(msg, txt);
  } catch (e) {
    console.error('[GP] introdução erro:', e);
    await msg.reply(`${NO} Não consegui apresentar o projeto agora.`);
  }
}

async function actDailyText(msg, link) {
  // versão texto do lembrete diário (simulação de scheduler)
  await actSummaryBrief(msg, link);
}

async function actWeeklyText(msg, link) {
  // versão texto do wrap semanal (simulação de scheduler)
  await actSummaryFull(msg, link);
}

async function actSayTTS(msg, text) {
  try {
    if (!text) return msg.reply(`${WARN} Use: /__say <texto>`);
    const res = await synthesize(text, { voice: 'alloy' });
    if (!res || !res.buffer) return msg.reply(`${WARN} TTS indisponível agora.`);
    const m = new MessageMedia(res.mime, res.buffer.toString('base64'));
    await client.sendMessage(msg.from, m, { sendAudioAsVoice: true });
  } catch (e) {
    console.error('[TTS] erro', e);
    await msg.reply(`${WARN} TTS falhou.`);
  }
}

// ---------------------- IA 1:1 (perfil BRYNIX) ----------------------

async function actOneToOne(msg) {
  try {
    const text = msg.body || '';

    // Perguntas “fora de projeto” devem responder como BRYNIX (site/ofertas/posicionamento etc.)
    // Delega para ai.js
    const answer = await generateReply(text, {
      from: msg.from,
      pushName: msg._data?.notifyName,
      mode: 'brynix',      // dica para ai.js
    });

    await replyChunked(msg, answer || 'Posso ajudar com informações sobre a BRYNIX. 😉');
  } catch (e) {
    console.error('[1:1] erro IA:', e);
    await msg.reply('Dei uma engasgada técnica aqui. Pode tentar de novo?');
  }
}

// ---------------------- Fluxo principal ----------------------

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
      ],
    },
    restartOnAuthFail: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 5_000,
  });
}

async function safeReinit(why = 'unknown') {
  const now = Date.now();
  if (now < reinitNotBefore) return;
  reinitNotBefore = now + REINIT_COOLDOWN_MS;

  try { if (client) await client.destroy().catch(() => {}); } catch {}
  client = buildClient();
  wire(client);
  client.initialize();
  console.log('[WA] reinit:', why);
}

function wire(c) {
  c.on('qr', (qr) => { lastQr = qr; currentState = 'qr'; console.log('[WA] QR gerado'); });
  c.on('authenticated', () => console.log('[WA] Autenticado'));
  c.on('auth_failure', (m) => { console.error('[WA] auth_failure', m); safeReinit('auth_failure'); });
  c.on('ready', () => { currentState = 'ready'; console.log('[WA] Pronto ✅'); });
  c.on('disconnected', (r) => { currentState = 'disconnected'; console.error('[WA] Desconectado', r); safeReinit('disconnected'); });

  c.on('message', async (msg) => {
    try {
      const chat = await msg.getChat();
      const inGroup = chat.isGroup;
      const text = (msg.body || '').trim();

      // ---------------- MUTE: comandos sempre funcionam ----------------
      if (/^\/mute\s+off\b/i.test(text) || /^\/silencio\s+off\b/i.test(text)) {
        muted.delete(msg.from);
        return msg.reply(I('voltei a falar 😉'));
      }
      if (/^\/mute\s+on\b/i.test(text) || /^\/silencio\s+on\b/i.test(text)) {
        muted.set(msg.from, true);
        return msg.reply(I('ok, fico em silêncio até /mute off'));
      }

      // ---------------- GRUPO (perfil GP) ----------------
      if (inGroup) {
        // bloqueio se mutado (exceto /setup, /menu, /mute off e testes internos)
        const isAllowedWhenMuted = /^\/(setup|menu|__)/i.test(text) || /^\/mute\s+off\b/i.test(text) || /^\/silencio\s+off\b/i.test(text);
        if (muted.get(msg.from) && !isAllowedWhenMuted) return;

        const link = getProjectLink(msg.from);

        // /setup <sheet|url> | <Nome>
        if (/^\/setup\b/i.test(text)) {
          const parts = text.split('|');
          const sheetRaw = (parts[0] || '').replace(/\/setup/i, '').trim();
          const name = (parts[1] || '').trim();
          const id = extractSheetId(sheetRaw);
          if (!id || !name) {
            return msg.reply(`${WARN} Use: /setup <sheetId|url> | <Nome do Projeto>`);
          }
          setProjectLink(msg.from, id, name);
          return replyChunked(msg,
            `${OK} ${B('Projeto vinculado!')}\n• Planilha: ${id}\n• Nome: ${name}`);
        }

        // sem projeto ainda?
        if (!link) {
          // só responde ao setup ou ajuda/menu
          if (/^\/menu\b/i.test(text) || isNaturalAsk(text, [/menu/, /opções?/i])) {
            return replyChunked(msg, buildMenuCard('Projeto'));
          }
          return msg.reply(`${WARN} Vincule o projeto: /setup <sheetId|url> | <Nome>`);
        }

        // upload de mídia (Drive)
        if (msg.hasMedia) {
          try {
            const res = await saveIncomingMediaToDrive(c, msg, link);
            if (res?.url) {
              return replyChunked(msg, `${OK} Arquivo salvo em ${B(link.projectName)}.\n🔗 ${res.url}`);
            }
            return msg.reply(`${NO} Não consegui salvar no Drive.`);
          } catch (e) {
            console.error('[DRIVE] erro upload:', e);
            return msg.reply(`${NO} Falha ao salvar no Drive.`);
          }
        }

        // MENU
        if (/^\/menu\b/i.test(text) || isNaturalAsk(text, [/^menu$/i, /opções?/i])) {
          return replyChunked(msg, buildMenuCard(link.projectName));
        }

        // Gatilhos por número do menu
        if (/^[1-6]$/.test(text)) {
          switch (text) {
            case '1': return actSummaryFull(msg, link);
            case '2': return actSummaryBrief(msg, link);
            case '3': return actNext(msg, link);
            case '4': return actLate(msg, link);
            case '5': return actWho(msg, link);
            case '6': {
              if (muted.get(msg.from)) {
                muted.delete(msg.from);
                return msg.reply(I('voltei a falar 😉'));
              }
              muted.set(msg.from, true);
              return msg.reply(I('ok, fico em silêncio até /mute off'));
            }
          }
        }

        // Linguagem natural no grupo
        if (wasMentioned(msg) || /^\/(status|summary|resumo)\b/i.test(text)) {
          if (isNaturalAsk(text, [/resumo curto/i, /breve/i])) return actSummaryBrief(msg, link);
          if (isNaturalAsk(text, [/resumo/i, /completo/i])) return actSummaryFull(msg, link);
          if (isNaturalAsk(text, [/próxim/i, /hoje/i, /amanhã/i])) return actNext(msg, link);
          if (isNaturalAsk(text, [/atrasad/i])) return actLate(msg, link);
          if (isNaturalAsk(text, [/quem participa/i, /quem está/i])) return actWho(msg, link);
          if (isNaturalAsk(text, [/apresente-se/i, /apresentar o projeto/i, /apresenta o projeto/i])) return actIntroduce(msg, link);
          // default no grupo
          return replyChunked(msg, buildMenuCard(link.projectName));
        }

        // comandos de teste internos (apenas no grupo)
        if (/^\/__ping\b/i.test(text)) return msg.reply('pong');
        if (/^\/__say\b/i.test(text)) {
          const t = text.replace(/^\/__say/i, '').trim();
          return actSayTTS(msg, t);
        }
        if (/^\/__remind_daily\b/i.test(text)) return actDailyText(msg, link);
        if (/^\/__remind_weekly\b/i.test(text)) return actWeeklyText(msg, link);

        // sem menção e sem comando → silencia
        return;
      }

      // ---------------- 1:1 (perfil BRYNIX) ----------------
      return actOneToOne(msg);

    } catch (err) {
      console.error('[WA] erro msg:', err);
      try { await msg.reply('Dei uma engasgada técnica aqui. Pode reenviar?'); } catch {}
    }
  });
}

// ---------------------- Inicialização + endpoints ----------------------

function initWhatsApp(app) {
  client = buildClient();
  wire(client);

  if (app && app.get) {
    // status
    app.get('/wa-status', async (_req, res) => {
      let state = currentState;
      try {
        const s = await client.getState().catch(() => null);
        if (s) state = s;
      } catch {}
      res.json({ status: state });
    });

    // QR (PNG)
    app.get('/wa-qr', async (_req, res) => {
      try {
        const qr = getLastQrPng();
        if (!qr) return res.status(503).send('QR ainda não gerado. Aguarde e recarregue.');
        const png = await QRCode.toBuffer(qr, { type: 'png', margin: 1, scale: 6 });
        res.type('image/png').send(png);
      } catch (e) {
        console.error('[WA] /wa-qr erro', e);
        res.status(500).send('Erro ao gerar QR');
      }
    });
  }

  client.initialize();

  // watchdog
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

module.exports = { initWhatsApp, getLastQr: getLastQrPng };
