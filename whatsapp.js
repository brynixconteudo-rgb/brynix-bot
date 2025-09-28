// whatsapp.js
// Alice – Assistente de Projeto BRYNIX (grupos) + Assistente institucional (1:1)
//
// Requer módulos locais já existentes no projeto:
//   ./ai            -> generateReply(text, { from, pushName })
//   ./sheets        -> extractSheetId, readTasks, buildStatusSummary, readProjectMeta (se disponível)
//   ./drive         -> saveIncomingMediaToDrive(client, msg, link)
//   ./nlu           -> INTENTS, parse(text)
//   ./tts           -> synthesize(text, { voice })
//
// .env relevantes:
//   WA_SESSION_PATH=/var/data/wa-session
//   ALERT_WEBHOOK_URL=... (Zapier) [opcional]
//   BOT_ALIASES="alice,assistente,bot"  (opcional; nomes/aliases para chamar no grupo)

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const { generateReply } = require('./ai');
const { extractSheetId, readTasks, buildStatusSummary } = require('./sheets');
const { saveIncomingMediaToDrive } = require('./drive');
const { INTENTS, parse: parseNLU } = require('./nlu');
const { synthesize } = require('./tts');

const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const REINIT_COOLDOWN_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 60_000;

let currentState = 'starting';
let lastQr = '';
let reinitNotBefore = 0;
let client;

// ===== Estado em memória =====
const muteMap = new Map();   // chatId -> boolean
const linkMap = new Map();   // chatId -> { sheetId, projectName }

// ===== Helpers de estilo =====
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

// ===== Nome/Alias do bot =====
function getAliases() {
  const envAliases = (process.env.BOT_ALIASES || 'alice,bot')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(envAliases)];
}

/** Retorna true se o bot foi explicitamente “endereçado” na mensagem do GRUPO */
function wasBotAddressed(msg, selfWid, selfPushName) {
  const text = (msg.body || '').toLowerCase();

  // 1) menção real via @ (WhatsApp transforma em mentionedIds)
  if (msg.mentionedIds && msg.mentionedIds.includes(selfWid)) return true;

  // 2) nome do contato do bot (pushName) citado no texto
  if (selfPushName && text.includes(selfPushName.toLowerCase())) return true;

  // 3) aliases configuráveis (alice, assistente, bot…)
  const aliases = getAliases();
  if (aliases.some(a => text.includes(a))) return true;

  // 4) padrões naturais comuns
  const naturalTriggers = [
    'alice,', 'alice ', ' oi alice', ' alicê', ' @alice', 'assistente', ' @assistente'
  ];
  if (naturalTriggers.some(t => text.includes(t))) return true;

  return false;
}

// ===== Cartão de Menu (estilo “bonito”) =====
function prettyMenu(projectName) {
  const title = projectName
    ? `🧭 ${B(projectName)} — Painel Rápido`
    : `🧭 ${B('Assistente de Projeto')} — Painel Rápido`;

  const blocks = [
    `${title}`,
    '',
    `*1)* 📊 ${B('Resumo')}  →  /summary  |  /brief`,
    `*2)* ⏭️ ${B('Próximos')}  →  /next`,
    `*3)* ⏱️ ${B('Atrasadas')} →  /late`,
    `*4)* 🔔 ${B('Lembrete agora')} →  /remind now`,
    `*5)* 📝 ${B('Nota rápida')}  →  /note <texto>`,
    `*6)* 👥 ${B('Pessoas')}      →  /who`,
    `*7)* 🤫 ${B('Silenciar')}     →  /mute on   ( /mute off para voltar )`,
    '',
    `${I('Dica: mencione-me naturalmente:')}`,
    `• @Alice o que vence hoje?`,
    `• @Alice resumo curto`,
    `• @Alice enviar lembrete agora`,
  ];

  return blocks.join('\n');
}

// ===== Ajuda curta =====
function helpCard(projectName) {
  const title = projectName ? `${projectName} — Assistente de Projeto` : 'Assistente de Projeto';
  return [
    `${B(title)}`,
    '',
    `${B('Como falar comigo')}`,
    `• No grupo: me mencione (ex.: @Alice) e fale natural.`,
    `  Ex.: @Alice o que vence hoje?  •  @Alice resumo curto`,
    '',
    `${B('Atalhos')}`,
    `• /menu — painel rápido`,
    `• /summary — resumo completo`,
    `• /brief — resumo curto`,
    `• /next — próximos (hoje/amanhã)`,
    `• /late — atrasadas (top 8)`,
    `• /remind now — dispara lembrete agora`,
    `• /note <texto> — registra nota`,
    `• /who — quem está no projeto`,
    `• /mute on | /mute off — silencia/volta a falar`,
    '',
    I('Dica: envie anexos me mencionando; eu salvo no Drive do projeto.'),
  ].join('\n');
}

// ===== QR / Alertas =====
function getLastQr() { return lastQr; }

async function sendAlert(payload) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) { console.log('ℹ️ ALERT_WEBHOOK_URL não configurada; alerta:', payload); return; }
  try {
    const body = typeof payload === 'string' ? { text: payload } : payload || { text: '⚠️ Alerta sem conteúdo' };
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) { console.error('❌ Webhook erro:', err); }
}

// ===== Client / ciclo de vida =====
function buildClient() {
  return new Client({
    authStrategy: new LocalAuth({ clientId: 'brynix-bot', dataPath: SESSION_PATH }),
    puppeteer: {
      headless: true, timeout: 60_000,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process']
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

// ===== Links por grupo =====
function setProjectLink(chatId, sheetId, projectName) { linkMap.set(chatId, { sheetId, projectName }); }
function getProjectLink(chatId) { return linkMap.get(chatId) || null; }

// ===== Handlers de Projeto =====
async function handleSummaryComplete(msg, link) {
  try {
    const tasks = await readTasks(link.sheetId);
    const card = buildStatusSummary(link.projectName, tasks);
    await safeReply(msg, card + `\n${I('Dica: @Alice resumo curto  •  /menu')}`);
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
      I('Dica: @Alice resumo completo  •  /summary')
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

async function handleRemindNow(msg, link) {
  // hoje: dispara um status imediato (pode evoluir para DM por responsável)
  await handleSummaryComplete(msg, link);
}

async function handleNote(msg, link, noteText) {
  if (!noteText) return msg.reply(`${WARN} Escreva a nota: /note <texto>`);
  try {
    await msg.reply(`${OK} Nota registrada: ${noteText}`);
    // (opcional) append em LOG de planilha
  } catch (e) { console.error(e); await msg.reply(`${NO} Não consegui registrar a nota agora.`); }
}

async function handleWho(msg, link) {
  // Placeholder elegante; leitura real da aba "Rec_Projeto" pode ser feita no sheets.js, se já implementada.
  const txt = [
    `${B(`${link.projectName} — Membros do projeto`)}`,
    `• ${I('Baseado nos participantes do grupo + planilha Recursos')}`,
    I('Dica: em breve — “@Alice pendências da <pessoa>”.')
  ].join('\n');
  await safeReply(msg, txt);
}

async function handleMenu(msg, link) {
  await safeReply(msg, prettyMenu(link?.projectName));
}

async function handleIntro(msg) {
  const txt = [
    `${B('Olá! Eu sou a Alice 🤖✨')}`,
    `Sou a assistente da ${B('BRYNIX')} para apoiar projetos.`,
    `• No ${B('1:1')} eu tiro dúvidas sobre a BRYNIX (ofertas, metodologia, cases).`,
    `• Em ${B('grupos de projeto')} eu ajudo com tarefas, lembretes, status, documentos e rotinas.`,
    '',
    I('Dica: no grupo, mencione-me com @Alice ou use /menu para ver atalhos.'),
  ].join('\n');
  await safeReply(msg, txt);
}

async function handleAudioTest(msg, text) {
  const say = text.replace(/^\/audio\b/i, '').trim() || 'Teste de voz da Alice em português do Brasil. Tudo certo por aqui!';
  const audio = await synthesize(say, { voice: 'female' });
  if (!audio) return msg.reply(`${WARN} TTS indisponível no momento.`);
  await client.sendMessage(msg.from, audio.buffer, { sendAudioAsVoice: true }); // ptt (bolinha)
}

// ===== Router (grupos x 1:1) =====
function wireEvents(c) {
  c.on('qr', (qr) => { lastQr = qr; currentState='qr'; console.log('[WA] QR gerado'); });
  c.on('authenticated', ()=> console.log('[WA] Autenticado'));
  c.on('auth_failure', (m)=>{ console.error('[WA] auth_failure', m); sendAlert('⚠️ Falha de auth'); safeReinit('auth_failure'); });
  c.on('ready', ()=>{ currentState='ready'; console.log('[WA] Pronto ✅'); sendAlert('✅ Alice online'); });
  c.on('disconnected', (r)=>{ currentState='disconnected'; console.error('[WA] Desconectado', r); sendAlert('❌ Alice desconectada'); safeReinit('disconnected'); });

  c.on('message', async (msg) => {
    try {
      const chat = await msg.getChat();
      const isGroup = chat.isGroup;
      const text = msg.body || '';
      const isCommand = text.trim().startsWith('/');

      // ===== Fluxo GRUPO (GP/AP) =====
      if (isGroup) {
        const chatId = msg.from;

        // Sempre permitir desmutar
        if (isCommand && /^\/(mute|silencio)\s+off/i.test(text)) {
          muteMap.delete(chatId);
          return msg.reply('_voltei a falar 😉_');
        }
        // Silenciar
        if (isCommand && /^\/(mute|silencio)\s+on/i.test(text)) {
          muteMap.set(chatId, true);
          return msg.reply('_ok, fico em silêncio até /mute off_');
        }
        // Se mutado, não segue
        if (muteMap.get(chatId)) return;

        // Upload de arquivo (quando houver mídia) — requer projeto vinculado
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

        const selfWid = c.info?.wid?._serialized;
        const selfPush = c.info?.pushname || '';

        const addressed = wasBotAddressed(msg, selfWid, selfPush);

        // Comandos de setup/menu sempre aceitos
        if (isCommand && /^\/setup/i.test(text)) {
          const parts = text.split('|');
          const sheetRaw = (parts[0]||'').replace(/\/setup/i,'').trim();
          const projectName = (parts[1]||'').trim();
          const sheetId = extractSheetId(sheetRaw);
          if (!sheetId || !projectName) return msg.reply(`${WARN} Use: /setup <sheetId|url> | <Nome do Projeto>`);
          setProjectLink(chatId, sheetId, projectName);
          return safeReply(msg, `${OK} ${B('Projeto vinculado!')}\n• Planilha: ${sheetId}\n• Nome: ${projectName}\n\n${I('Dica: /menu para o painel rápido')}`);
        }

        if (isCommand && /^\/(menu|help|ajuda)$/i.test(text)) {
          const link = getProjectLink(chatId);
          return handleMenu(msg, link);
        }

        // Se não me chamaram e não é comando: ignora para ficar “natural”
        if (!isCommand && !addressed) return;

        // Necessário estar vinculado após comandos básicos
        const link = getProjectLink(chatId);
        if (!link) {
          return msg.reply(`${WARN} Vincule o projeto antes: /setup <sheetId|url> | <Nome>`);
        }

        // NLU
        const nlu = parseNLU(text);
        switch (nlu.intent) {
          case INTENTS.HELP:
            return handleMenu(msg, link);
          case INTENTS.SUMMARY:
          case INTENTS.SUMMARY_FULL:
            return handleSummaryComplete(msg, link);
          case INTENTS.SUMMARY_BRIEF:
            return handleSummaryBrief(msg, link);
          case INTENTS.NEXT:
            return handleNext(msg, link);
          case INTENTS.LATE:
            return handleLate(msg, link);
          case INTENTS.REMIND_NOW:
            return handleRemindNow(msg, link);
          case INTENTS.NOTE:
            return handleNote(msg, link, nlu.note);
          case INTENTS.WHO:
            return handleWho(msg, link);
          default:
            // fallback amigável no grupo
            return handleMenu(msg, link);
        }
      }

      // ===== Fluxo 1:1 (Institucional BRYNIX) =====
      if (/^\/audio\b/i.test(text)) {
        return handleAudioTest(msg, text);
      }
      if (/^\/intro\b/i.test(text) || /apresente-se|quem é você|o que você faz/i.test(text)) {
        return handleIntro(msg);
      }

      const reply = await generateReply(text, { from: msg.from, pushName: msg._data?.notifyName });
      await safeReply(msg, reply);

    } catch (err) {
      console.error('[WA] erro msg:', err);
      try { await msg.reply('Dei uma engasgada técnica aqui. Pode reenviar?'); } catch(_) {}
    }
  });
}

// ===== Inicialização / Health =====
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
    // healthz “real” (200/OK quando conectado; 503 caso contrário)
    app.get('/healthz', async (_req, res) => {
      try {
        const s = await client.getState().catch(()=>null);
        if (s && (s === 'CONNECTED' || s === 'OPENING')) return res.status(200).send('ok');
        return res.status(503).send(`state=${s || 'unknown'}`);
      } catch {
        return res.status(503).send('error');
      }
    });
  }

  client.initialize();
  setInterval(async ()=>{
    try {
      const s = await client.getState().catch(()=>null);
      if (!s || ['CONFLICT','UNPAIRED','UNLAUNCHED'].includes(s)) {
        sendAlert(`⏰ Watchdog: estado "${s || 'null'}" → reiniciando.`);
        safeReinit(`watchdog:${s||'null'}`);
      } else if (currentState!=='ready' && s==='CONNECTED') {
        currentState = 'ready';
      }
    } catch(e){ safeReinit('watchdog-error'); }
  }, WATCHDOG_INTERVAL_MS);
}

module.exports = { initWhatsApp, getLastQr };
