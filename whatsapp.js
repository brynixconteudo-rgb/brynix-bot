// whatsapp.js — Brynix BOT (menu numérico compatível com whatsapp-web.js)
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const { generateReply } = require('./ai');
const { extractSheetId, readTasks, buildStatusSummary } = require('./sheets');
const { saveIncomingMediaToDrive } = require('./drive');
const { INTENTS, parse: parseNLU } = require('./nlu');

// ===== Config básica
const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const REINIT_COOLDOWN_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 60_000;

// ===== Estado
let currentState = 'starting';
let lastQr = '';
let reinitNotBefore = 0;
let client;

const muteMap = new Map();        // chatId -> boolean (mutado?)
const linkMap = new Map();        // chatId -> { sheetId, projectName }
const expectMenu = new Map();     // chatId -> { until: ts } (aguardando escolha 1..6)

// ===== Helpers de formatação
const B = (s) => `*${s}*`;
const I = (s) => `_${s}_`;
const OK = '✅';
const WARN = '⚠️';
const NO = '❌';

function chunkText(text, limit = 3500) {
  if (!text) return [''];
  const chunks = [];
  for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit));
  return chunks;
}
async function safeReply(msg, text) {
  for (const part of chunkText(text)) await msg.reply(part);
}

function wasBotMentioned(msg) {
  const txt = (msg.body || '').toLowerCase();
  const hasAt = txt.includes('@');
  const hasPush = msg._data?.notifyName ? txt.includes(msg._data.notifyName.toLowerCase()) : false;
  return (msg.mentionedIds && msg.mentionedIds.length > 0) || hasAt || hasPush;
}

function setProjectLink(chatId, sheetId, projectName) { linkMap.set(chatId, { sheetId, projectName }); }
function getProjectLink(chatId) { return linkMap.get(chatId) || null; }

// ===== QR (status endpoint usa)
function getLastQr() { return lastQr; }

// ===== Client factory
function buildClient() {
  return new Client({
    authStrategy: new LocalAuth({ clientId: 'brynix-bot', dataPath: SESSION_PATH }),
    puppeteer: {
      headless: true,
      timeout: 60_000,
      args: [
        '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
        '--disable-gpu','--no-zygote','--single-process'
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
  try { if (client) try { await client.destroy(); } catch(_){} } catch(e){}
  client = buildClient(); wireEvents(client); client.initialize();
}

// ====== MENU (texto com números)
function renderMenuTitle(projectName) {
  return `${B(projectName ? `${projectName} — Assistente de Projeto` : 'Assistente de Projeto')}`;
}
function renderMenuText(link) {
  return [
    renderMenuTitle(link?.projectName),
    '',
    B('Opções'),
    '1️⃣  Resumo completo',
    '2️⃣  Resumo curto',
    '3️⃣  Próximos (hoje/amanhã)',
    '4️⃣  Atrasadas (top 8)',
    '5️⃣  Quem participa',
    '6️⃣  Silenciar / Ativar bot',
    '',
    I('Responda com o número da opção. Ex.: 3')
  ].join('\n');
}
function openMenu(chatId) {
  // dá 3 minutos para responder 1..6
  expectMenu.set(chatId, { until: Date.now() + 3 * 60 * 1000 });
}
function isExpectingChoice(chatId) {
  const rec = expectMenu.get(chatId);
  if (!rec) return false;
  if (Date.now() > rec.until) { expectMenu.delete(chatId); return false; }
  return true;
}
function clearMenuWait(chatId) { expectMenu.delete(chatId); }

// ====== Handlers de projeto
async function handleSummaryComplete(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const card = buildStatusSummary(link.projectName, tasks);
    await safeReply(msg, `${card}\n${I('Dica: digite /menu ou responda um número.')}`);
  } catch (e) {
    console.error(e);
    await msg.reply(`${NO} Não consegui ler a planilha.`);
  }
}
async function handleSummaryBrief(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const total = tasks.length;
    const byStatus = tasks.reduce((acc, t) => {
      const s = (t.status || 'Sem status').trim();
      acc[s] = (acc[s] || 0) + 1; return acc;
    }, {});
    const top = Object.entries(byStatus).sort((a,b)=>b[1]-a[1]).slice(0,4)
      .map(([s,n])=>`• ${s}: ${n}`).join('\n') || '• Sem dados';

    const atrasadas = tasks.filter(t => /atrasad/i.test(t.status||'')).length;
    const txt = [
      B(`${link.projectName} — Resumo rápido`),
      `Total de tarefas: ${total}`,
      top,
      `Atrasadas: ${atrasadas}`,
    ].join('\n');
    await safeReply(msg, txt);
  } catch (e) {
    console.error(e); await msg.reply(`${NO} Não consegui gerar o resumo curto.`);
  }
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
async function handleRemindNow(msg, link) {
  // placeholder: por enquanto usa o resumo completo
  await handleSummaryComplete(msg, link);
}
async function handleWho(msg, link) {
  const txt = [
    `${B(`${link.projectName} — Participantes`)}`,
    I('Baseado nos membros do grupo no WhatsApp.'),
    I('Em breve: “@BOT pendências de <pessoa>”.'),
  ].join('\n');
  await safeReply(msg, txt);
}
async function handleNote(msg, link, noteText) {
  if (!noteText) return msg.reply(`${WARN} Use: /note <texto>`);
  try { await msg.reply(`${OK} Nota registrada: ${noteText}`); }
  catch (e) { console.error(e); await msg.reply(`${NO} Não consegui registrar a nota agora.`); }
}

// ====== Roteamento do MENU numérico
async function handleMenuChoice(msg, choice, link, chatId) {
  switch (choice) {
    case '1': clearMenuWait(chatId); return handleSummaryComplete(msg, link);
    case '2': clearMenuWait(chatId); return handleSummaryBrief(msg, link);
    case '3': clearMenuWait(chatId); return handleNext(msg, link);
    case '4': clearMenuWait(chatId); return handleLate(msg, link);
    case '5': clearMenuWait(chatId); return handleWho(msg, link);
    case '6':
      // toggle mute
      const m = muteMap.get(chatId);
      muteMap.set(chatId, !m);
      clearMenuWait(chatId);
      return msg.reply(m ? I('voltei a falar 😉') : I('ok, fico em silêncio até /mute off'));
    default:
      return msg.reply(`${WARN} Opção inválida. Responda com 1 a 6, ou digite /menu.`);
  }
}

// ====== Eventos
function wireEvents(c) {
  c.on('qr', (qr) => { lastQr = qr; currentState='qr'; console.log('[WA] QR gerado'); });
  c.on('authenticated', ()=> console.log('[WA] Autenticado'));
  c.on('auth_failure', (m)=>{ console.error('[WA] auth_failure', m); safeReinit('auth_failure'); });
  c.on('ready', ()=>{ currentState='ready'; console.log('[WA] Pronto ✅'); });
  c.on('disconnected', (r)=>{ currentState='disconnected'; console.error('[WA] Desconectado', r); safeReinit('disconnected'); });

  c.on('message', async (msg) => {
    try {
      const chat = await msg.getChat();
      const isGroup = chat.isGroup;
      if (!isGroup) {
        // 1:1 mantém a IA padrão
        const reply = await generateReply(msg.body || '', { from: msg.from, pushName: msg._data?.notifyName });
        return safeReply(msg, reply);
      }

      const chatId = msg.from;
      const text = (msg.body || '').trim();
      const isCommand = text.startsWith('/');

      // ===== Desmutar mesmo mutado
      if (isCommand && /^\/mute\s+off/i.test(text)) { muteMap.delete(chatId); return msg.reply(I('voltei a falar 😉')); }
      if (isCommand && /^\/silencio\s+off/i.test(text)) { muteMap.delete(chatId); return msg.reply(I('voltei a falar 😉')); }

      // Mutado? (exceto os 2 acima)
      if (muteMap.get(chatId)) return;

      // ===== Mutar (comando)
      if (isCommand && /^\/mute\s+on/i.test(text)) { muteMap.set(chatId,true); return msg.reply(I('ok, fico em silêncio até /mute off')); }
      if (isCommand && /^\/silencio\s+on/i.test(text)) { muteMap.set(chatId,true); return msg.reply(I('ok, fico em silêncio até /mute off')); }

      // ===== Upload de mídia (Drive)
      if (msg.hasMedia) {
        const link = getProjectLink(chatId);
        if (!link) return msg.reply(`${WARN} Vincule o projeto: /setup <sheetId|url> | <Nome>`);
        try {
          const res = await saveIncomingMediaToDrive(c, msg, link);
          if (res?.url) return safeReply(msg, `${OK} Arquivo salvo em ${B(link.projectName)}.\n🔗 ${res.url}`);
          return msg.reply(`${NO} Não consegui salvar no Drive.`);
        } catch(e){ console.error(e); return msg.reply(`${NO} Não consegui salvar no Drive.`); }
      }

      // ===== Acesso ao projeto exigido para ações
      const link = getProjectLink(chatId);
      // Setup do projeto
      if (isCommand && /^\/setup/i.test(text)) {
        const parts = text.split('|');
        const sheetRaw = (parts[0]||'').replace(/\/setup/i,'').trim();
        const projectName = (parts[1]||'').trim();
        const sheetId = extractSheetId(sheetRaw);
        if (!sheetId || !projectName) return msg.reply(`${WARN} Use: /setup <sheetId|url> | <Nome do Projeto>`);
        setProjectLink(chatId, sheetId, projectName);
        return safeReply(msg, `${OK} ${B('Projeto vinculado!')}\n• Planilha: ${sheetId}\n• Nome: ${projectName}`);
      }

      // Sem projeto definido, só aceita setup
      if (!link) return msg.reply(`${WARN} Vincule o projeto: /setup <sheetId|url> | <Nome>`);

      // ===== MENU comando/menção
      if (isCommand && /^\/menu$/i.test(text) || /^menu$/i.test(text) || (wasBotMentioned(msg) && /menu/i.test(text))) {
        openMenu(chatId);
        return safeReply(msg, renderMenuText(link));
      }

      // ===== Se o menu foi aberto recentemente e a pessoa mandou 1..6, roteia
      if (isExpectingChoice(chatId) && /^[1-6]$/.test(text)) {
        return handleMenuChoice(msg, text, link, chatId);
      }

      // ===== Demais atalhos por NLU / comandos
      const mentioned = wasBotMentioned(msg);
      if (!isCommand && !mentioned) return; // ignora conversa normal entre pessoas

      // Comandos diretos
      if (isCommand && /^\/summary$/i.test(text)) return handleSummaryComplete(msg, link);
      if (isCommand && /^\/next$/i.test(text)) return handleNext(msg, link);
      if (isCommand && /^\/late$/i.test(text)) return handleLate(msg, link);
      if (isCommand && /^\/remind\s+now$/i.test(text)) return handleRemindNow(msg, link);
      if (isCommand && /^\/who$/i.test(text)) return handleWho(msg, link);
      if (isCommand && /^\/note\s+/i.test(text)) {
        const note = text.replace(/^\/note\s+/i,'').trim();
        return handleNote(msg, link, note);
      }

      // NLU leve para frases naturais (mencionando o bot)
      const nlu = parseNLU(text);
      switch (nlu.intent) {
        case INTENTS.SUMMARY: 
        case INTENTS.SUMMARY_FULL: return handleSummaryComplete(msg, link);
        case INTENTS.SUMMARY_BRIEF: return handleSummaryBrief(msg, link);
        case INTENTS.NEXT: return handleNext(msg, link);
        case INTENTS.LATE: return handleLate(msg, link);
        case INTENTS.REMIND_NOW: return handleRemindNow(msg, link);
        case INTENTS.NOTE: return handleNote(msg, link, nlu.note);
        case INTENTS.WHO: return handleWho(msg, link);
        default:
          // Se pediu “menu” de forma natural e caiu aqui, mostra menu
          if (/menu/i.test(text)) { openMenu(chatId); return safeReply(msg, renderMenuText(link)); }
          // fallback ajuda
          openMenu(chatId);
          return safeReply(msg, `${B('Posso ajudar com o projeto.')} ${I('Aqui está o menu:')}\n\n${renderMenuText(link)}`);
      }
    } catch (err) {
      console.error('[WA] erro msg:', err);
      try { await msg.reply('Dei uma engasgada técnica aqui. Pode reenviar?'); } catch(_) {}
    }
  });
}

// ====== Inicialização + endpoints de status
function initWhatsApp(app) {
  client = buildClient();
  wireEvents(client);

  if (app && app.get) {
    app.get('/wa-status', async (_req,res)=> {
      let state = currentState;
      try { const s = await client.getState().catch(()=>null); if (s) state = s; } catch(_){}
      res.json({ status: state });
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
