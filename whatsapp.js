// whatsapp.js
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const { generateReply } = require('./ai');
const { extractSheetId, readProjectConfig, readTasks, buildStatusSummary } = require('./sheets');
const { uploadBufferToProject } = require('./drive');

const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const LINKS_DB_PATH = process.env.LINKS_DB_PATH || '/var/data/links.json';
const REINIT_COOLDOWN_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 60_000;

const fs = require('fs');

let currentState = 'starting';
let lastQr = '';
let reinitNotBefore = 0;
let client;

const muteMap = new Map();           // chatId -> boolean
const linkMap = new Map();           // chatId -> {sheetId, projectName}

const B = s => `*${s}*`;
const I = s => `_${s}_`;
const OK = '✅', WARN = '⚠️', NO = '❌';

function chunkText(text, limit = 3500) {
  if (!text) return [''];
  const out = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}
async function safeReply(msg, text) { for (const p of chunkText(text)) await msg.reply(p); }

function getLastQr() { return lastQr; }
function getClient() { return client; }

// ===== links db (persistência simples)
function loadLinksDb() {
  try { return JSON.parse(fs.readFileSync(LINKS_DB_PATH, 'utf8')); }
  catch { return {}; }
}
function saveLinksDb(obj) {
  fs.mkdirSync(require('path').dirname(LINKS_DB_PATH), { recursive: true });
  fs.writeFileSync(LINKS_DB_PATH, JSON.stringify(obj, null, 2));
}
function setProjectLink(chatId, sheetId, projectName) {
  linkMap.set(chatId, { sheetId, projectName });
  const all = loadLinksDb(); all[chatId] = { sheetId, projectName }; saveLinksDb(all);
}
function getProjectLink(chatId) {
  if (linkMap.has(chatId)) return linkMap.get(chatId);
  const all = loadLinksDb();
  if (all[chatId]) { linkMap.set(chatId, all[chatId]); return all[chatId]; }
  return null;
}

function buildClient() {
  return new Client({
    authStrategy: new LocalAuth({ clientId: 'brynix-bot', dataPath: SESSION_PATH }),
    puppeteer: {
      headless: true, timeout: 60_000,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process']
    },
    restartOnAuthFail: true, takeoverOnConflict: true, takeoverTimeoutMs: 5_000,
  });
}

async function safeReinit() {
  const now = Date.now();
  if (now < reinitNotBefore) return;
  reinitNotBefore = now + REINIT_COOLDOWN_MS;
  try { if (client) await client.destroy().catch(()=>{}); } catch {}
  client = buildClient(); wireEvents(client); client.initialize();
}

// ===== API p/ scheduler usar
async function sendText(chatId, text) {
  const c = getClient(); if (!c) throw new Error('WA client inexistente');
  const chat = await c.getChatById(chatId);
  for (const part of chunkText(text)) await chat.sendMessage(part);
}
async function sendAudio(chatId, buffer, mime='audio/ogg') {
  const c = getClient(); if (!c) throw new Error('WA client inexistente');
  const media = new MessageMedia(mime, buffer.toString('base64'), 'audio.ogg');
  const chat = await c.getChatById(chatId);
  await chat.sendMessage(media, { sendAudioAsVoice: true }); // voice-note style
}

// ===== fluxo de respostas
function wasBotMentioned(msg) {
  const txt = (msg.body || '').toLowerCase();
  return (msg.mentionedIds && msg.mentionedIds.length > 0) ||
         txt.includes('@');
}

// ======== Natural language helpers
function isAskIntroduceBot(text) {
  const s = text.toLowerCase();
  return /(apresent(a|e)(-se)?|quem\s+é\s+v(c|ocê)|o que você faz)/i.test(s);
}
function isAskIntroduceProject(text) {
  const s = text.toLowerCase();
  return /(apresent(a|e)\s+o\s+projeto|sobre\s+o\s+projeto)/i.test(s);
}

async function handleIntroduceBot(msg, link) {
  const cfg = await readProjectConfig(link.sheetId);
  const t = `${B('Oi, eu sou o Assistente de Projeto BRYNIX!')}

Fui configurado para apoiar o grupo *${cfg.ProjectName}*:
• Lembrar prazos e pendências.
• Gerar resumos diários e semanais.
• Registrar e arquivar documentos no Drive do projeto.
• Responder perguntas simples sobre o andamento.

Pode me mencionar e falar natural:
Ex.: @BOT o que vence hoje? • @BOT resumo curto

${I('Diga “apresente o projeto” para um resumo do objetivo, benefícios e timeline.')}
`;
  await safeReply(msg, t);
}

async function handleIntroduceProject(msg, link) {
  const cfg = await readProjectConfig(link.sheetId);
  const t = `${B(`Projeto: ${cfg.ProjectName}`)}

${B('Objetivos')}
${cfg.ProjectObjectives || '—'}

${B('Benefícios Esperados')}
${cfg.ProjectBenefits || '—'}

${B('Prazo Estimado')}
${cfg.ProjectTimeline || '—'}
`;
  await safeReply(msg, t);
}

// ======== comandos já existentes de vocês (resumo/next/late) — você mantém os seus
async function handleSummaryComplete(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const card = buildStatusSummary(link.projectName || (await readProjectConfig(link.sheetId)).ProjectName, tasks);
    await safeReply(msg, card + `\n${I('Dica: @BOT resumo curto  •  /help')}`);
  } catch (e) { console.error(e); await msg.reply(`${NO} Não consegui ler a planilha.`); }
}

function wireEvents(c) {
  c.on('qr', qr => { lastQr = qr; currentState = 'qr'; console.log('[WA] QR gerado'); });
  c.on('authenticated', () => console.log('[WA] Autenticado'));
  c.on('auth_failure', m => { console.error('[WA] auth_failure', m); safeReinit(); });
  c.on('ready', () => { currentState = 'ready'; console.log('[WA] Pronto ✅'); });
  c.on('disconnected', r => { currentState = 'disconnected'; console.error('[WA] Desconectado', r); safeReinit(); });

  c.on('message', async (msg) => {
    try {
      const chat = await msg.getChat();
      if (!chat.isGroup) return;

      const chatId = msg.from;
      const text = msg.body || '';
      const isCommand = text.trim().startsWith('/');

      // desmutar mesmo em silêncio
      if (isCommand && /^\/(mute|silencio)\s+off/i.test(text)) {
        muteMap.delete(chatId); return msg.reply(I('voltei a falar 😉'));
      }
      if (muteMap.get(chatId)) return; // silêncio

      // mutar
      if (isCommand && /^\/(mute|silencio)\s+on/i.test(text)) {
        muteMap.set(chatId, true);
        return msg.reply(I('ok, fico em silêncio até /mute off'));
      }

      const mentioned = wasBotMentioned(msg);
      if (!isCommand && !mentioned) return;

      // /setup (vincular)
      if (isCommand && /^\/setup/i.test(text)) {
        const parts = text.split('|');
        const sheetRaw = (parts[0] || '').replace(/\/setup/i, '').trim();
        const projectName = (parts[1] || '').trim();
        const sheetId = extractSheetId(sheetRaw);
        if (!sheetId || !projectName) return msg.reply(`${WARN} Use: /setup <sheetId|url> | <Nome do Projeto>`);
        setProjectLink(chatId, sheetId, projectName);
        return safeReply(msg, `${OK} ${B('Projeto vinculado!')}
• Planilha: ${sheetId}
• Nome: ${projectName}`);
      }

      // comandos naturais
      const link = getProjectLink(chatId);
      if (!link) return msg.reply(`${WARN} Vincule o projeto: /setup <sheetId|url> | <Nome>`);

      if (isAskIntroduceBot(text)) return handleIntroduceBot(msg, link);
      if (isAskIntroduceProject(text)) return handleIntroduceProject(msg, link);

      // exemplos: /summary etc. (mantenha sua tabela de intents se quiser)
      if (isCommand && /^\/summary/i.test(text)) return handleSummaryComplete(msg, link);

      // fallback IA 1:1 (não aplicável em grupo, mas caso queira)
      // return safeReply(msg, await generateReply(text, { from: msg.from, pushName: msg._data?.notifyName }));

      // ajuda
      return safeReply(msg,
        `${B('Como falar comigo')}
• Me mencione e fale natural. Ex.: @BOT o que vence hoje?
• /summary — resumo completo
• /mute on | /mute off — silêncio do bot`);
    } catch (err) {
      console.error('[WA] erro msg:', err);
      try { await msg.reply('Dei uma engasgada técnica aqui. Pode reenviar?'); } catch {}
    }
  });
}

function initWhatsApp(app) {
  client = buildClient();
  wireEvents(client);

  if (app && app.get) {
    app.get('/wa-status', async (_req, res) => {
      let state = currentState;
      try { const s = await client.getState().catch(()=>null); if (s) state = s; } catch {}
      res.json({ status: state });
    });
    app.get('/wa-qr', async (_req, res) => {
      try {
        const qr = getLastQr();
        if (!qr) return res.status(503).send('QR ainda não gerado. Aguarde e recarregue.');
        const png = await QRCode.toBuffer(qr, { type: 'png', margin: 1, scale: 6 });
        res.type('image/png').send(png);
      } catch { res.status(500).send('Erro ao gerar QR'); }
    });
  }

  client.initialize();
  setInterval(async () => {
    try {
      const s = await client.getState().catch(()=>null);
      if (!s || ['CONFLICT','UNPAIRED','UNLAUNCHED'].includes(s)) safeReinit();
      else if (currentState !== 'ready' && s === 'CONNECTED') currentState = 'ready';
    } catch { safeReinit(); }
  }, WATCHDOG_INTERVAL_MS);
}

module.exports = {
  initWhatsApp,
  getLastQr,
  // API p/ scheduler:
  sendText,
  sendAudio,
  getClient,
};
