// whatsapp.js
// Assistente de Projeto BRYNIX – WhatsApp (whatsapp-web.js)
// - Roteia 1:1 x Grupo (GP)
// - Comandos: /setup, /menu, /summary, /next, /late, /who, /note, /mute on|off
// - Upload de anexos -> Drive do projeto
// - Menção robusta no grupo (msg.mentionedIds + heurísticas @brynix bot)

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const { generateReply } = require('./ai'); // 1:1 (perfil BRYNIX)
const { extractSheetId, readTasks, buildStatusSummary } = require('./sheets');
const { saveIncomingMediaToDrive } = require('./drive');
const { INTENTS, parse: parseNLU } = require('./nlu');

const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const REINIT_COOLDOWN_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 60_000;

let currentState = 'starting';
let lastQr = '';
let reinitNotBefore = 0;
let client;

// Identidade do próprio bot (preenchida no 'ready')
let BOT_WID = null;     // ex: 5511987654321@c.us
let BOT_PUSHNAME = '';  // nome que aparece no WhatsApp

// Mapeamentos em memória
const muteMap = new Map();   // chatId -> boolean
const linkMap = new Map();   // chatId -> { sheetId, projectName }

// Utils simples
const B = (s) => `*${s}*`;
const I = (s) => `_${s}_`;
const OK = '✅';
const WARN = '⚠️';
const NO = '❌';

// Normalização leve para matching textual
const normalize = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

// Quebra mensagens longas
function chunkText(text, limit = 3500) {
  if (!text) return [''];
  const chunks = [];
  for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit));
  return chunks;
}
async function safeReply(msg, text) {
  for (const part of chunkText(text)) await msg.reply(part);
}

function helpCard(projectName) {
  const title = projectName ? `${projectName} — Assistente de Projeto` : 'Assistente de Projeto';
  return [
    `${B(title)}`,
    '',
    `${B('Como falar comigo')}`,
    `• No grupo: me mencione (ex.: @BOT) e fale natural.`,
    `  Ex.: @BOT o que vence hoje?  •  @BOT resumo curto`,
    '',
    `${B('Atalhos')}`,
    `• /menu — menu com opções`,
    `• /summary — resumo completo`,
    `• /next — próximos (hoje/amanhã)`,
    `• /late — atrasadas (top 8)`,
    `• /note <texto> — registra nota`,
    `• /who — quem participa`,
    `• /mute on | /mute off — silêncio do bot`,
    '',
    I('Dica: envie anexos me mencionando; salvo no Drive do projeto.'),
  ].join('\n');
}

function getLastQr() { return lastQr; }

async function sendAlert(payload) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) { console.log('ℹ️ ALERT_WEBHOOK_URL não configurada; alerta:', payload); return; }
  try {
    const body = typeof payload === 'string' ? { text: payload } : payload || { text: '⚠️ Alerta sem conteúdo' };
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) { console.error('❌ Webhook erro:', err); }
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

async function safeReinit(reason = 'unknown') {
  const now = Date.now();
  if (now < reinitNotBefore) return;
  reinitNotBefore = now + REINIT_COOLDOWN_MS;
  try { if (client) try { await client.destroy(); } catch(_){} } catch(e){}
  client = buildClient(); wireEvents(client); client.initialize();
}

function setProjectLink(chatId, sheetId, projectName) { linkMap.set(chatId, { sheetId, projectName }); }
function getProjectLink(chatId) { return linkMap.get(chatId) || null; }
const isGroupMsg = (msg) => msg.from.endsWith('@g.us');

// ---------------------------------------------------------------------
// MENÇÃO ROBUSTA AO BOT
// ---------------------------------------------------------------------
function wasBotMentioned(msg) {
  try {
    // 1) Menção oficial do WhatsApp
    if (Array.isArray(msg.mentionedIds) && msg.mentionedIds.length) {
      if (BOT_WID && msg.mentionedIds.includes(BOT_WID)) return true;
      if (!BOT_WID) return true; // fallback: se não temos o WID ainda, considerar que houve menção
    }

    // 2) Heurística textual
    const t = normalize(msg.body || '');

    // padrões tolerantes (com ou sem @, com hífen, espaços etc.)
    const patterns = [
      /@?brynix\s*-\s*bot/,
      /@?brynix\s*bot/,
      /@?bryni[xcs]\s*-\s*bot/,
      /@?bot\b/,
      /\bhey\s+bot\b/,
      /\bol[aá]\s+bot\b/,
    ];
    if (patterns.some((rx) => rx.test(t))) return true;

    // 3) Se soubermos o pushname do bot, tentar casar
    if (BOT_PUSHNAME) {
      const bn = normalize(BOT_PUSHNAME);
      if (t.includes(`@${bn}`) || t.includes(bn)) return true;
    }
  } catch (e) {
    console.error('wasBotMentioned erro:', e);
  }
  return false;
}

// ---------------------------------------------------------------------
// Handlers GP
// ---------------------------------------------------------------------
async function handleSummaryComplete(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const card = buildStatusSummary(link.projectName, tasks);
    await safeReply(msg, card + `\n${I('Dica: @BOT resumo curto  •  /help')}`);
  } catch (e) { console.error(e); await msg.reply(`${NO} Não consegui ler a planilha.`); }
}

async function handleSummaryBrief(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const total = tasks.length;
    const byStatus = tasks.reduce((acc, t) => {
      const s = (t.status || 'Sem status').trim(); acc[s] = (acc[s] || 0) + 1; return acc;
    }, {});
    const top = Object.entries(byStatus).sort((a,b)=>b[1]-a[1]).slice(0,4)
      .map(([s,n])=>`• ${s}: ${n}`).join('\n') || '• Sem dados';

    const atrasadas = tasks.filter(t => /atrasad/i.test(t.status||'')).length;
    const txt = [
      `${B(`${link.projectName} — Resumo Rápido`)}`,
      `Total de tarefas: ${total}`,
      top,
      `Atrasadas: ${atrasadas}`,
      I('Dica: @BOT resumo completo  •  /summary')
    ].join('\n');
    await safeReply(msg, txt);
  } catch (e) { console.error(e); await msg.reply(`${NO} Não consegui gerar o resumo curto.`); }
}

function parseDateBR(s) {
  const m = (s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const d = +m[1], mo = +m[2]-1, y = +m[3] + (m[3].length===2?2000:0);
  return new Date(y, mo, d);
}

async function handleNext(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const today = new Date(); const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate()+1);
    const trunc = (dt)=> new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    const due = tasks.filter(t => {
      const dt = parseDateBR(t.dataTermino||t.dataFim||''); if(!dt) return false;
      const od = trunc(dt), td = trunc(today);
      return (+od===+td) || (+od===+tomorrow);
    }).slice(0,8);

    const title = `${B(`${link.projectName} — Próximos (hoje/amanhã)`)}\n`;
    const lines = due.length ? due.map(t => `• ${t.tarefa} ${I(t.responsavel?`(${t.responsavel})`:'')}`).join('\n') : 'Nenhuma tarefa para hoje/amanhã.';
    await safeReply(msg, title + lines);
  } catch (e) { console.error(e); await msg.reply(`${NO} Não consegui obter os próximos itens.`); }
}

async function handleLate(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const atrasadas = tasks.filter(t => /atrasad/i.test(t.status||'')).slice(0,8);
    const title = `${B(`${link.projectName} — Atrasadas (top 8)`)}\n`;
    const lines = atrasadas.length ? atrasadas.map(t => `• ${t.tarefa} ${I(t.responsavel?`(${t.responsavel})`:'')}`).join('\n') : 'Sem atrasadas. 👌';
    await safeReply(msg, title + lines);
  } catch (e) { console.error(e); await msg.reply(`${NO} Não consegui listar atrasadas.`); }
}

async function handleRemindNow(msg, link) { await handleSummaryComplete(msg, link); }

async function handleNote(msg, _link, noteText) {
  if (!noteText) return msg.reply(`${WARN} Escreva a nota: /note <texto>`);
  try { await msg.reply(`${OK} Nota registrada: ${noteText}`); }
  catch (e) { console.error(e); await msg.reply(`${NO} Não consegui registrar a nota agora.`); }
}

async function handleWho(msg, link) {
  const txt = [
    `${B(`${link.projectName} — Membros do grupo`)}`,
    `• ${I('Baseado nos participantes do WhatsApp')}`,
    I('Dica: em breve — “@BOT pendências da <pessoa>”.')
  ].join('\n');
  await safeReply(msg, txt);
}

async function handleHelp(msg, link) { await safeReply(msg, helpCard(link?.projectName)); }

// ---------------------------------------------------------------------
// Wire & Router
// ---------------------------------------------------------------------
function wireEvents(c) {
  c.on('qr', (qr) => { lastQr = qr; currentState='qr'; console.log('[WA] QR gerado'); });
  c.on('authenticated', ()=> console.log('[WA] Autenticado'));
  c.on('auth_failure', (m)=>{ console.error('[WA] auth_failure', m); safeReinit('auth_failure'); });
  c.on('ready', async ()=>{
    currentState='ready';
    try {
      const info = c.info || {};
      BOT_WID = info?.wid?._serialized || null;
      BOT_PUSHNAME = info?.pushname || '';
      console.log('[WA] Pronto ✅', { wid: BOT_WID, pushname: BOT_PUSHNAME });
    } catch(e){
      console.log('[WA] Pronto ✅ (sem info de wid/pushname)');
    }
  });
  c.on('disconnected', (r)=>{ currentState='disconnected'; console.error('[WA] Desconectado', r); safeReinit('disconnected'); });

  c.on('message', async (msg) => {
    try {
      const chat = await msg.getChat();
      const isGroup = chat.isGroup;

      // ---------------- 1:1 (perfil BRYNIX) ----------------
      if (!isGroup) {
        const reply = await generateReply(msg.body || '', { from: msg.from, pushName: msg._data?.notifyName });
        return safeReply(msg, reply);
      }

      // ---------------- GRUPO (perfil GP) ----------------
      const chatId = msg.from;
      const text = msg.body || '';
      const isCommand = text.trim().startsWith('/');

      // menção robusta
      const mentioned = wasBotMentioned(msg);

      // logs úteis
      if (isCommand || mentioned) {
        console.log(`[GRUPO] trigger recebido | isCommand=${isCommand} | mentioned=${mentioned} | chatId=${chatId}`);
      }

      // 1) /mute off deve funcionar mesmo silenciado
      if (isCommand && /^\/(?:mute|silencio)\s+off/i.test(text)) {
        muteMap.delete(chatId);
        return msg.reply(I('voltei a falar 😉'));
      }

      // 2) Se estiver mutado, sai (a menos que seja /mute off acima)
      if (muteMap.get(chatId)) return;

      // 3) /mute on
      if (isCommand && /^\/(?:mute|silencio)\s+on/i.test(text)) {
        muteMap.set(chatId, true);
        return msg.reply(I('ok, fico em silêncio até /mute off'));
      }

      // 4) Se não for comando nem menção, ignorar
      if (!isCommand && !mentioned) return;

      // Upload (se houver mídia e projeto vinculado)
      if (msg.hasMedia) {
        const link = getProjectLink(chatId);
        if (!link) return msg.reply(`${WARN} Vincule o projeto primeiro: /setup <sheetId|url> | <Nome>`);
        try {
          const res = await saveIncomingMediaToDrive(c, msg, link);
          if (res?.url) return safeReply(msg, `${OK} Arquivo salvo em ${B(link.projectName)}.\n🔗 ${res.url}`);
          return msg.reply(`${NO} Não consegui salvar no Drive.`);
        } catch(e){ console.error(e); return msg.reply(`${NO} Não consegui salvar no Drive.`); }
      }

      // /setup
      if (isCommand && /^\/setup/i.test(text)) {
        const parts = text.split('|');
        const sheetRaw = (parts[0]||'').replace(/\/setup/i,'').trim();
        const projectName = (parts[1]||'').trim();
        const sheetId = extractSheetId(sheetRaw);
        if (!sheetId || !projectName) return msg.reply(`${WARN} Use: /setup <sheetId|url> | <Nome do Projeto>`);
        setProjectLink(chatId, sheetId, projectName);
        return safeReply(msg, `${OK} ${B('Projeto vinculado!')}\n• Planilha: ${sheetId}\n• Nome: ${projectName}`);
      }

      // /menu
      if (isCommand && /^\/menu/i.test(text)) {
        const link = getProjectLink(chatId);
        return handleHelp(msg, link);
      }

      // Requer projeto vinculado a partir daqui
      const link = getProjectLink(chatId);
      if (!link) {
        // se foi só uma menção, explique como vincular
        if (!isCommand) return msg.reply(`${WARN} Este grupo ainda não está vinculado a um projeto. Use: /setup <sheetId|url> | <Nome>`);
        return msg.reply(`${WARN} Vincule o projeto: /setup <sheetId|url> | <Nome>`);
      }

      // NLU (natural + comandos)
      const nlu = parseNLU(text);

      switch (nlu.intent) {
        case INTENTS.HELP: return handleHelp(msg, link);
        case INTENTS.SUMMARY:
        case INTENTS.SUMMARY_FULL: return handleSummaryComplete(msg, link);
        case INTENTS.SUMMARY_BRIEF: return handleSummaryBrief(msg, link);
        case INTENTS.NEXT: return handleNext(msg, link);
        case INTENTS.LATE: return handleLate(msg, link);
        case INTENTS.REMIND_NOW: return handleRemindNow(msg, link);
        case INTENTS.NOTE: return handleNote(msg, link, nlu.note);
        case INTENTS.WHO: return handleWho(msg, link);

        case INTENTS.MUTE_ON:  muteMap.set(chatId,true); return msg.reply(I('ok, fico em silêncio até /mute off'));
        case INTENTS.MUTE_OFF: muteMap.delete(chatId);   return msg.reply(I('voltei a falar 😉'));

        default:
          // Se mencionou, mas não casou nada → manda help contextual
          return handleHelp(msg, link);
      }

    } catch (err) {
      console.error('[WA] erro msg:', err);
      try { await msg.reply('Dei uma engasgada técnica aqui. Pode reenviar?'); } catch(_) {}
    }
  });
}

// ---------------------------------------------------------------------
// Init + endpoints utilitários
// ---------------------------------------------------------------------
function initWhatsApp(app) {
  client = buildClient();
  wireEvents(client);

  if (app && app.get) {
    app.get('/wa-status', async (_req,res)=> {
      let state = currentState;
      try { const s = await client.getState().catch(()=>null); if (s) state = s; } catch(_){}
      res.json({ status: state, wid: BOT_WID, pushname: BOT_PUSHNAME });
    });
    app.get('/wa-qr', async (_req,res)=>{
      try {
        const qr = getLastQr();
        if (!qr) return res.status(503).send('QR ainda não gerado. Aguarde e recarregue.');
        const png = await QRCode.toBuffer(qr, { type:'png', margin:1, scale:6 });
        res.type('image/png').send(png);
      } catch(e){ console.error(e); res.status(500).send('Erro ao gerar QR'); }
    });
  }

  client.initialize();
  setInterval(async ()=>{
    try {
      const s = await client.getState().catch(()=>null);
      if (!s || ['CONFLICT','UNPAIRED','UNLAUNCHED'].includes(s)) safeReinit(`watchdog:${s||'null'}`);
      else if (currentState!=='ready' && s==='CONNECTED') currentState = 'ready';
    } catch(e){ safeReinit('watchdog-error'); }
  }, WATCHDOG_INTERVAL_MS);
}

module.exports = { initWhatsApp, getLastQr };
