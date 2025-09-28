// whatsapp.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { generateReply } = require('./ai');
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

const muteMap = new Map();
const linkMap = new Map();

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

function isGroupMsg(msg, chat) {
  return msg.from.endsWith('@g.us') || chat.isGroup;
}
function getLastQr() { return lastQr; }

function setProjectLink(chatId, sheetId, projectName) {
  linkMap.set(chatId, { sheetId, projectName });
}
function getProjectLink(chatId) {
  return linkMap.get(chatId) || null;
}

// -------- Handlers Projeto ----------
async function handleSummaryComplete(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const card = buildStatusSummary(link.projectName, tasks);
    await safeReply(msg, card);
  } catch {
    await msg.reply(`${NO} Não consegui ler a planilha.`);
  }
}
async function handleSummaryBrief(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const total = tasks.length;
    const byStatus = tasks.reduce((a, t) => {
      const s = (t.status || 'Sem status').trim();
      a[s] = (a[s] || 0) + 1; return a;
    }, {});
    const top = Object.entries(byStatus).map(([s,n])=>`• ${s}: ${n}`).join('\n');
    const atrasadas = tasks.filter(t=>/atrasad/i.test(t.status||'')).length;
    const txt = `${B(link.projectName)} — Resumo rápido\nTotal: ${total}\n${top}\nAtrasadas: ${atrasadas}`;
    await safeReply(msg, txt);
  } catch {
    await msg.reply(`${NO} Erro ao gerar resumo curto.`);
  }
}
async function handleNext(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const today = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate()+1);
    const trunc = (d)=>new Date(d.getFullYear(),d.getMonth(),d.getDate());
    const due = tasks.filter(t=>{
      const m = (t.dataTermino||t.dataFim||'').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if(!m) return false;
      const dt = new Date(+m[3] + (m[3].length===2?2000:0), +m[2]-1, +m[1]);
      return +trunc(dt)===+trunc(today) || +trunc(dt)===+trunc(tomorrow);
    }).slice(0,8);
    const lines = due.map(t=>`• ${t.tarefa} ${I(t.responsavel||'')}`).join('\n') || 'Nenhuma.';
    await safeReply(msg, `${B(link.projectName)} — Próximos (hoje/amanhã)\n${lines}`);
  } catch {
    await msg.reply(`${NO} Não consegui listar próximos.`);
  }
}
async function handleLate(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const atrasadas = tasks.filter(t=>/atrasad/i.test(t.status||'')).slice(0,8);
    const lines = atrasadas.map(t=>`• ${t.tarefa} ${I(t.responsavel||'')}`).join('\n') || 'Nenhuma.';
    await safeReply(msg, `${B(link.projectName)} — Atrasadas\n${lines}`);
  } catch {
    await msg.reply(`${NO} Não consegui listar atrasadas.`);
  }
}
async function handleWho(msg, link) {
  await safeReply(msg, `${B(link.projectName)} — Participantes\n${I('Baseado nos membros do grupo')}`);
}

// -------- Menu Projeto ----------
function projectMenu(link) {
  return [
    `${B(link.projectName)} — Assistente de Projeto`,
    '',
    '1️⃣ Resumo completo',
    '2️⃣ Resumo curto',
    '3️⃣ Próximos (hoje/amanhã)',
    '4️⃣ Atrasadas (top 8)',
    '5️⃣ Quem participa',
    '6️⃣ Silenciar / Ativar bot'
  ].join('\n');
}

// -------- WireEvents ----------
function wireEvents(c) {
  c.on('qr', (qr)=>{ lastQr=qr; currentState='qr'; console.log('[WA] QR gerado'); });
  c.on('authenticated', ()=> console.log('[WA] Autenticado'));
  c.on('ready', ()=>{ currentState='ready'; console.log('[WA] Pronto ✅'); });
  c.on('message', async (msg)=>{
    try {
      const chat = await msg.getChat();
      const text = (msg.body||'').trim();
      const isCommand = text.startsWith('/');
      const chatId = msg.from;
      const group = isGroupMsg(msg,chat);

      // 🔹 DEBUG
      if (isCommand && /^\/debugctx/i.test(text)) {
        return msg.reply(`isGroup=${group} | chatId=${chatId} | inProject=${!!getProjectLink(chatId)}`);
      }

      // 🔹 DM (BRYNIX persona)
      if (!group) {
        if (/^\/(menu|ajuda|help)$/i.test(text)) {
          return safeReply(msg,
            `${B('BRYNIX — Assistente IA')}\n\n`+
            `Posso ajudar com:\n`+
            `• Entender nossas *ofertas*\n`+
            `• Explicar nossa *metodologia*\n`+
            `• Tirar dúvidas sobre *IA aplicada*\n\n`+
            I('Pergunte livremente, ex: "Quais ofertas vocês possuem?"') );
        }
        const reply = await generateReply(text, { from: msg.from, mode:'BRYNIX' });
        return safeReply(msg, reply);
      }

      // 🔹 Grupo (GP / Projeto)
      if (isCommand && /^\/setup/i.test(text)) {
        const parts=text.split('|');
        const sheetRaw=(parts[0]||'').replace(/\/setup/i,'').trim();
        const projectName=(parts[1]||'').trim();
        const sheetId=extractSheetId(sheetRaw);
        if(!sheetId||!projectName) return msg.reply(`${WARN} Use: /setup <sheetId|url> | <Nome>`);
        setProjectLink(chatId,sheetId,projectName);
        return safeReply(msg,`${OK} Projeto vinculado!\nPlanilha: ${sheetId}\nNome: ${projectName}`);
      }

      const link=getProjectLink(chatId);
      if(!link) return;

      if (/^\/(menu|ajuda|help)$/i.test(text) || /apresente/i.test(text)) {
        return safeReply(msg, projectMenu(link));
      }

      if (/^1$/.test(text)) return handleSummaryComplete(msg,link);
      if (/^2$/.test(text)) return handleSummaryBrief(msg,link);
      if (/^3$/.test(text)) return handleNext(msg,link);
      if (/^4$/.test(text)) return handleLate(msg,link);
      if (/^5$/.test(text)) return handleWho(msg,link);
      if (/^6$/.test(text)) {
        if(muteMap.get(chatId)){ muteMap.delete(chatId); return msg.reply(I('voltei a falar 😉')); }
        else { muteMap.set(chatId,true); return msg.reply(I('ok, silêncio até /menu')); }
      }

      // Upload
      if (msg.hasMedia) {
        try {
          const res=await saveIncomingMediaToDrive(c,msg,link);
          if(res?.url) return safeReply(msg,`${OK} Arquivo salvo em ${B(link.projectName)}\n🔗 ${res.url}`);
        } catch { return msg.reply(`${NO} Erro ao salvar.`); }
      }

      const nlu=parseNLU(text);
      switch(nlu.intent){
        case INTENTS.SUMMARY: return handleSummaryComplete(msg,link);
        case INTENTS.SUMMARY_BRIEF: return handleSummaryBrief(msg,link);
        case INTENTS.NEXT: return handleNext(msg,link);
        case INTENTS.LATE: return handleLate(msg,link);
        case INTENTS.WHO: return handleWho(msg,link);
      }
    } catch(e){ console.error(e); }
  });
}

function buildClient(){
  return new Client({
    authStrategy:new LocalAuth({clientId:'brynix-bot',dataPath:SESSION_PATH}),
    puppeteer:{ headless:true,args:['--no-sandbox','--disable-setuid-sandbox'] }
  });
}
function initWhatsApp(app){
  client=buildClient(); wireEvents(client); client.initialize();
}
module.exports={ initWhatsApp,getLastQr };
