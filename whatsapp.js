// whatsapp.js
// Roteador WhatsApp: grupo (GP) vs 1:1 (BRYNIX), menu numérico, TTS oculto, ping e upload.

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const { synthesize } = require('./tts'); // /__say
const { extractSheetId, readTasks, buildStatusSummary, readProjectMeta } = require('./sheets');
const { saveIncomingMediaToDrive } = require('./drive');

const BOT_ALIASES = (process.env.BOT_ALIASES || 'bot,alice').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const REINIT_COOLDOWN_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 60_000;

let client;
let currentState = 'starting';
let lastQr = '';
let reinitNotBefore = 0;

// Estado por chat
const muteMap = new Map();          // chatId -> boolean
const linkMap = new Map();          // chatId -> { sheetId, projectName }
const menuWindow = new Map();       // chatId -> { expiresAt: timestamp }

// helpers de texto
const B = s => `*${s}*`;
const I = s => `_${s}_`;
const OK = '✅';
const NO = '❌';
const WARN = '⚠️';

// ------------- infra básica -------------
function buildClient() {
  return new Client({
    authStrategy: new LocalAuth({ clientId: 'brynix-bot', dataPath: SESSION_PATH }),
    puppeteer: {
      headless: true,
      timeout: 60_000,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process']
    },
    restartOnAuthFail: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 5_000,
  });
}

async function safeReinit(reason='unknown') {
  const now = Date.now();
  if (now < reinitNotBefore) return;
  reinitNotBefore = now + REINIT_COOLDOWN_MS;
  try { if (client) await client.destroy().catch(()=>{}); } catch(_){}
  client = buildClient();
  wireEvents(client);
  client.initialize();
}

function getLastQr(){ return lastQr; }

// ------------- util -------------
function isGroupMsg(msg){ return msg.from.endsWith('@g.us'); }
function mentionedBot(textRaw) {
  const t = (textRaw||'').toLowerCase();
  return BOT_ALIASES.some(a => t.includes(`@${a}`) || t.includes(a));
}
function chunk(text, max=3500) {
  if (!text) return [''];
  const parts = [];
  for (let i=0;i<text.length;i+=max) parts.push(text.slice(i, i+max));
  return parts;
}
async function safeReply(msg, text){
  for (const part of chunk(text)) await msg.reply(part);
}

// ------------- UI: menu -------------
function menuCard(projectName='Assistente de Projeto') {
  const title = `${projectName} — Painel Rápido`;
  return [
    `🪄 ${B(title)}`,
    '',
    `1⃣  ${B('Resumo')}  →  /summary | /brief`,
    `2⃣  ⏭️  ${B('Próximos')}  →  /next`,
    `3⃣  🕒  ${B('Atrasadas')}  →  /late`,
    `4⃣  🔔  ${B('Lembrete agora')}  →  /remind now`,
    `5⃣  📝  ${B('Nota rápida')}  →  /note <texto>`,
    `6⃣  👥  ${B('Pessoas')}  →  /who`,
    `7⃣  🤫  ${B('Silenciar')}  →  /mute on  ( /mute off para voltar )`,
    '',
    I('Dica: responda com o número da opção por até 2 minutos.')
  ].join('\n');
}
function openMenuWindow(chatId, ms=120_000){
  menuWindow.set(chatId, { expiresAt: Date.now() + ms });
}
function isMenuOpen(chatId){
  const w = menuWindow.get(chatId);
  if (!w) return false;
  if (Date.now() > w.expiresAt){ menuWindow.delete(chatId); return false; }
  return true;
}

// ------------- Ações GP -------------
async function actSummary(msg, link) {
  const tasks = await readTasks(link.sheetId);
  const card = buildStatusSummary(link.projectName, tasks);
  await safeReply(msg, card);
}
async function actSummaryBrief(msg, link) {
  const tasks = await readTasks(link.sheetId);
  const total = tasks.length;
  const byStatus = tasks.reduce((acc,t)=>{
    const s=(t.status||'Sem status').trim(); acc[s]=(acc[s]||0)+1; return acc;
  },{});
  const top = Object.entries(byStatus).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([s,n])=>`• ${s}: ${n}`).join('\n') || '• Sem dados';
  await safeReply(msg, `${B(`${link.projectName} — Resumo Rápido`)}\nTotal: ${total}\n${top}`);
}
function parseDateBR(s){
  const m = (s||'').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if(!m) return null; const d=+m[1], mo=+m[2]-1, y=+m[3]+(m[3].length===2?2000:0); return new Date(y,mo,d);
}
async function actNext(msg, link) {
  const tasks = await readTasks(link.sheetId);
  const today = new Date(); const tomorrow = new Date(today.getFullYear(),today.getMonth(),today.getDate()+1);
  const trunc = dt => new Date(dt.getFullYear(),dt.getMonth(),dt.getDate());
  const due = tasks.filter(t=>{
    const dt=parseDateBR(t.dataTermino||t.dataFim||''); if(!dt) return false;
    const od=trunc(dt), td=trunc(today);
    return (+od===+td)||(+od===+tomorrow);
  }).slice(0,8);
  const lines = due.length ? due.map(t=>`• ${t.tarefa} ${I(t.responsavel?`(${t.responsavel})`:'')}`).join('\n') : 'Nenhuma tarefa para hoje/amanhã.';
  await safeReply(msg, `${B(`${link.projectName} — Próximos (hoje/amanhã)`)}\n${lines}`);
}
async function actLate(msg, link) {
  const tasks = await readTasks(link.sheetId);
  const atrasadas = tasks.filter(t=>/atrasad/i.test(t.status||'')).slice(0,8);
  const lines = atrasadas.length ? atrasadas.map(t=>`• ${t.tarefa} ${I(t.responsavel?`(${t.responsavel})`:'')}`).join('\n') : 'Sem atrasadas. 👌';
  await safeReply(msg, `${B(`${link.projectName} — Atrasadas (top 8)`)}\n${lines}`);
}
async function actWho(msg, link) {
  // Lê metadados só p/ citar nome; se você já tem uma aba de recursos com nomes, adapte aqui
  const meta = await readProjectMeta(link.sheetId).catch(()=>({}));
  const title = `${link.projectName} — Participantes`;
  const hint = I('Dica: em breve — “@Alice pendências do <nome>”.');
  await safeReply(msg, `${B(title)}\n• Integrantes conforme planilha/WhatsApp do grupo.\n${hint}`);
}

// ------------- Perfil 1:1 (BRYNIX) -------------
async function handleBrynixDM(msg, text) {
  const low = (text||'').toLowerCase().trim();

  if (low === '/ajuda' || low === '/help') {
    return safeReply(msg,
      B('Como posso ajudar?') + '\n' +
      '• Fale comigo sobre a BRYNIX (o que fazemos, ofertas, metodologia, cases)\n' +
      '• Para projetos, me adicione num grupo e use /setup para vincular à planilha.\n' +
      I('Comandos técnicos: /ping, /__say <texto> (áudio).')
    );
  }

  // Ping oculto
  if (low === '/ping') {
    return msg.reply('pong 🏓');
  }

  // TTS oculto
  if (low.startsWith('/__say')) {
    const say = text.replace(/^\/__say/i,'').trim();
    if (!say) return msg.reply('Diga algo após /__say');
    const audio = await synthesize(say, { voice: process.env.TTS_VOICE || 'alloy' });
    if (!audio) return msg.reply('Não consegui gerar o áudio agora.');
    const media = new MessageMedia(audio.mime, audio.buffer.toString('base64'));
    return client.sendMessage(msg.from, media, { sendAudioAsVoice: true });
  }

  // Resposta institucional simples (pode evoluir)
  const resposta =
`A *BRYNIX* ajuda PMEs a acelerar resultados com IA.
Atuamos em eficiência gerencial, automação de processos e *crescimento de receita*.

Se quiser, diga “/ajuda” para ver dicas rápidas ou me coloque num grupo de projeto que eu organizo tudo por lá.`;

  return safeReply(msg, resposta);
}

// ------------- Wire de eventos -------------
function wireEvents(c){
  c.on('qr', async (qr) => { lastQr = qr; currentState='qr'; console.log('[WA] QR gerado'); });
  c.on('authenticated', () => console.log('[WA] Autenticado'));
  c.on('ready', () => { currentState='ready'; console.log('[WA] Pronto ✅'); });
  c.on('auth_failure', (m)=>{ console.error('[WA] auth_failure', m); safeReinit('auth_failure'); });
  c.on('disconnected', (r)=>{ currentState='disconnected'; console.error('[WA] Desconectado', r); safeReinit('disconnected'); });

  c.on('message', async (msg) => {
    try {
      const chat = await msg.getChat();
      const isGroup = chat.isGroup;
      const chatId = msg.from;
      const text = msg.body || '';
      const low = text.trim().toLowerCase();
      const isCommand = low.startsWith('/');

      // -------------- DESMUTAR SEMPRE FUNCIONA --------------
      if (isCommand && /^\/(mute\s+off|silencio\s+off)$/i.test(low)) {
        muteMap.delete(chatId);
        return msg.reply(I('voltei a falar 😉'));
      }

      // DM (1:1 BRYNIX)
      if (!isGroup) {
        return handleBrynixDM(msg, text);
      }

      // -------------- GRUPO (GP) --------------
      // Silenciar
      if (isCommand && /^\/(mute\s+on|silencio\s+on)$/i.test(low)) {
        muteMap.set(chatId, true);
        return msg.reply(I('ok, fico em silêncio até /mute off'));
      }
      if (muteMap.get(chatId)) return;

      // Vincular projeto
      if (isCommand && /^\/setup/i.test(low)) {
        const parts = text.split('|');
        const sheetRaw = (parts[0]||'').replace(/\/setup/i,'').trim();
        const projectName = (parts[1]||'').trim();
        const sheetId = extractSheetId(sheetRaw);
        if (!sheetId || !projectName) return msg.reply(`${WARN} Use: /setup <sheetId|url> | <Nome do Projeto>`);
        linkMap.set(chatId, { sheetId, projectName });
        return safeReply(msg, `${OK} ${B('Projeto vinculado!')}\n• Planilha: ${sheetId}\n• Nome: ${projectName}`);
      }

      const link = linkMap.get(chatId);
      if (!link) {
        if (isCommand && (low==='/ajuda'||low==='/help'||low==='/menu')) {
          return msg.reply(`${WARN} Vincule o projeto antes: /setup <sheetId|url> | <Nome>`);
        }
        return; // ignorar até setar /setup
      }

      // -------------- MENU e seleção numérica --------------
      if (isCommand && (low==='/ajuda'||low==='/help'||low==='/menu')) {
        await safeReply(msg, menuCard(link.projectName));
        openMenuWindow(chatId);
        return;
      }
      // Seleção numérica quando janela aberta
      if (isMenuOpen(chatId) && /^[1-7]$/.test(low)) {
        const n = low.trim();
        menuWindow.delete(chatId);
        if (n==='1') return actSummary(msg, link);
        if (n==='2') return actNext(msg, link);
        if (n==='3') return actLate(msg, link);
        if (n==='4') return safeReply(msg, '🔔 Lembrete imediato enviado (mock).'); // plugue seu scheduler se quiser
        if (n==='5') return safeReply(msg, 'Use: /note <texto> para registrar uma nota.');
        if (n==='6') return actWho(msg, link);
        if (n==='7') { muteMap.set(chatId,true); return msg.reply(I('ok, fico em silêncio até /mute off')); }
      }

      // -------------- OUTROS COMANDOS GP --------------
      if (isCommand) {
        if (low.startsWith('/summary') || low.startsWith('/brief')) return actSummary(msg, link);
        if (low.startsWith('/next')) return actNext(msg, link);
        if (low.startsWith('/late')) return actLate(msg, link);
        if (low.startsWith('/who')) return actWho(msg, link);

        if (low.startsWith('/note')) {
          const note = text.replace(/^\/note/i,'').trim();
          if (!note) return msg.reply('Use: /note <texto>');
          return msg.reply(`${OK} Nota registrada: ${note}`);
        }

        // ocultos também no grupo
        if (low==='/ping') return msg.reply('pong 🏓');
        if (low.startsWith('/__say')) {
          const say = text.replace(/^\/__say/i,'').trim();
          if (!say) return msg.reply('Diga algo após /__say');
          const audio = await synthesize(say, { voice: process.env.TTS_VOICE || 'alloy' });
          if (!audio) return msg.reply('Não consegui gerar o áudio agora.');
          const media = new MessageMedia(audio.mime, audio.buffer.toString('base64'));
          return client.sendMessage(msg.from, media, { sendAudioAsVoice: true });
        }
      }

      // -------------- Upload de anexos --------------
      if (msg.hasMedia) {
        try {
          const res = await saveIncomingMediaToDrive(client, msg, link);
        if (res?.url) return safeReply(msg, `${OK} Arquivo salvo em ${B(link.projectName)}.\n🔗 ${res.url}`);
          return msg.reply(`${NO} Não consegui salvar no Drive.`);
        } catch(e){ console.error('[DRIVE] erro upload:', e); return msg.reply(`${NO} Não consegui salvar no Drive.`); }
      }

      // -------------- Mencionei o bot? mostra menu --------------
      if (mentionedBot(text)) {
        await safeReply(msg, menuCard(link.projectName));
        openMenuWindow(chatId);
        return;
      }

    } catch(err) {
      console.error('[WA] erro msg:', err);
      try { await msg.reply('Dei uma engasgada técnica aqui. Pode reenviar?'); } catch(_){}
    }
  });
}

// ------------- init & health -------------
function initWhatsApp(app){
  client = buildClient();
  wireEvents(client);

  // rotas utilitárias
  if (app && app.get) {
    app.get('/wa-status', async (_req,res)=>{
      let state = currentState;
      try { const s = await client.getState().catch(()=>null); if (s) state = s; } catch(_){}
      res.json({ status: state, time: new Date().toISOString() });
    });
    app.get('/wa-qr', async (_req,res)=>{
      try {
        if (!lastQr) return res.status(503).send('QR ainda não gerado. Aguarde e recarregue.');
        const png = await QRCode.toBuffer(lastQr, { type:'png', margin:1, scale:6 });
        res.type('image/png').send(png);
      } catch(e){ console.error(e); res.status(500).send('Erro ao gerar QR'); }
    });
    // healthz real
    app.get('/healthz', (_req,res)=> res.status(200).send('ok'));
  }

  client.initialize();

  // watchdog
  setInterval(async ()=>{
    try{
      const s = await client.getState().catch(()=>null);
      if (!s || ['CONFLICT','UNPAIRED','UNLAUNCHED'].includes(s)) safeReinit(`watchdog:${s||'null'}`);
      else if (currentState!=='ready' && s==='CONNECTED') currentState = 'ready';
    }catch(_){ safeReinit('watchdog-error'); }
  }, WATCHDOG_INTERVAL_MS);
}

module.exports = { initWhatsApp, getLastQr };
