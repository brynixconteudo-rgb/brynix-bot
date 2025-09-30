// whatsapp.js
// Motor da Alice: roteamento de mensagens, binds, menu, uploads, resumos, 1:1 analista.

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const {
  extractSheetId, readProjectMeta, readTasks, readResources,
  appendLog, buildStatusSummary, saveGroupId
} = require('./sheets');

const { saveIncomingMediaToDrive } = require('./drive');
const { generateReply } = require('./ai');
const { createScheduler } = require('./scheduler');

const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const WATCHDOG_INTERVAL_MS = 60_000;

let client;
let currentState = 'starting';
let lastQr = '';

/** binds em memória: chatId -> { sheetId, projectName } */
const linkMap = new Map();
/** mute por chatId */
const muteMap = new Map();
/** aliases do bot para menções */
const BOT_ALIASES = (process.env.BOT_ALIASES || 'Alice').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

/* util formatação */
const B = s => `*${s}*`;
const I = s => `_${s}_`;

/* ------------- Helpers UI ------------- */

function menuCard(projectName) {
  return [
    `✨ ${B(projectName || 'Projeto')} — Painel Rápido`,
    ``,
    `1️⃣ ${B('Resumo')}  →  /summary | /brief`,
    `2️⃣ ⏭ ${B('Próximos')}  →  /next`,
    `3️⃣ ⏰ ${B('Atrasadas')}  →  /late`,
    `4️⃣ 🔔 ${B('Lembrete agora')}  →  /remind now`,
    `5️⃣ 🧾 ${B('Nota rápida')}  →  /note <texto>`,
    `6️⃣ 👥 ${B('Pessoas')}  →  /who`,
    `7️⃣ 🤫 ${B('Silenciar')}  →  /mute on  ( /mute off para voltar )`,
    ``,
    I('Dica: responda com o número da opção.')
  ].join('\n');
}

function wasBotMentioned(msg) {
  const lower = (msg.body || '').toLowerCase();
  const matchedAlias = BOT_ALIASES.some(a => lower.includes('@'+a) || lower.includes(a));
  return (msg.mentionedIds && msg.mentionedIds.length) || matchedAlias;
}

function chunkText(text, limit = 3500) {
  const parts = [];
  for (let i=0;i<text.length;i+=limit) parts.push(text.slice(i, i+limit));
  return parts;
}
async function safeReply(msg, text) {
  for (const part of chunkText(text)) await msg.reply(part);
}

/* ------------- Scheduler integration ------------- */
const scheduler = createScheduler({
  getBindings: () => Array.from(linkMap.entries()).map(([groupId, v]) => ({ groupId, sheetId: v.sheetId, projectName: v.projectName })),
  sendToGroup: async (groupId, payload, meta={}) => {
    try {
      if (!client) return;
      if (meta.audio) {
        const media = new MessageMedia(payload.mime || 'audio/mpeg', payload.buffer.toString('base64'), 'resumo.mp3');
        await client.sendMessage(groupId, media, { sendAudioAsVoice: false });
      } else {
        await client.sendMessage(groupId, payload);
      }
    } catch (e) { console.log('[sendToGroup] erro', e?.message || e); }
  },
  tts: async (text) => {
    // usa TTS via openai (já configurado no projeto) — se quiser Google, trocar aqui
    const tts = require('./tts');
    const r = await tts.synthesize(text, { voice: process.env.TTS_VOICE || 'alloy' });
    return r ? { mime: r.mime, buffer: r.buffer } : null;
  }
});

/* ------------- Comandos ------------- */

async function handleSetup(msg, text) {
  const parts = text.split('|');
  const sheetRaw = (parts[0] || '').replace(/\/setup/i, '').trim();
  const projectName = (parts[1] || '').trim();

  const sheetId = extractSheetId(sheetRaw);
  if (!sheetId || !projectName) {
    return msg.reply('⚠️ Use: /setup <sheetId|url> | <Nome do Projeto>');
  }

  const chatId = msg.from;
  linkMap.set(chatId, { sheetId, projectName });

  // salva GroupId na planilha (se grupo)
  if (chatId.endsWith('@g.us')) {
    try { await saveGroupId(sheetId, chatId); } catch {}
  }

  await appendLog(sheetId, { tipo:'setup', autor:'bot', msg:`vinculado ao grupo ${chatId}`, arquivo:'', link:'', obs:projectName });
  return safeReply(msg, `✅ ${B('Projeto vinculado!')}\n\n• Planilha: ${sheetId}\n• Nome: ${projectName}\n${chatId.endsWith('@g.us')?`• GroupId: ${chatId}`:''}`);
}

async function handleWho(msg, link) {
  const list = await readResources(link.sheetId);
  const lines = list.length ? list.map(p => `• ${p.nome} — ${p.funcao}${p.contato ? ` (${p.contato})` : ''}`).join('\n') : 'Sem registros na aba Rec_Projeto.';
  await appendLog(link.sheetId, { tipo:'who', autor:'bot', msg:`${list.length} membros`, arquivo:'', link:'', obs:'' });
  return safeReply(msg, `${B(`${link.projectName} — Participantes`)}\n${lines}`);
}

async function handleSummary(msg, link, { brief=false } = {}) {
  const tasks = await readTasks(link.sheetId);
  const text = buildStatusSummary(link.projectName, tasks);
  await appendLog(link.sheetId, { tipo:'summary', autor:'bot', msg:`OK (${tasks.length} tarefas)`, arquivo:link.sheetId, link:'', obs: brief?'brief':'' });
  return safeReply(msg, text);
}

async function handleNext(msg, link) {
  const tasks = await readTasks(link.sheetId);
  const today = new Date(); const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate()+1);
  const trunc = (dt)=> new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const due = tasks.filter(t => {
    if (!t.dtFimDate) return false;
    const od = trunc(t.dtFimDate), td = trunc(today);
    return (+od===+td) || (+od===+tomorrow);
  }).slice(0,10);

  const lines = due.length
    ? due.map(t => `• ${t.tarefa} — fim ${t.dataTermino}${t.responsavel?` (${t.responsavel})`:''}`).join('\n')
    : 'Nenhuma tarefa para hoje/amanhã.';

  await appendLog(link.sheetId, { tipo:'next', autor:'bot', msg:`${due.length} itens`, arquivo:'', link:'', obs:'' });
  return safeReply(msg, `${B(`${link.projectName} — Próximos (hoje/amanhã)`)}\n${lines}`);
}

async function handleLate(msg, link) {
  const tasks = await readTasks(link.sheetId);
  const atrasadas = tasks.filter(t => /atrasad/i.test(t.status||'')).slice(0,10);
  const lines = atrasadas.length
    ? atrasadas.map(t => `• ${t.tarefa} — fim ${t.dataTermino}${t.responsavel?` (${t.responsavel})`:''}`).join('\n')
    : 'Sem atrasadas. 👌';

  await appendLog(link.sheetId, { tipo:'late', autor:'bot', msg:`${atrasadas.length} itens`, arquivo:'', link:'', obs:'' });
  return safeReply(msg, `${B(`${link.projectName} — Atrasadas (top 10)`)}\n${lines}`);
}

async function handleNote(msg, link, noteText) {
  if (!noteText) return msg.reply(`⚠️ Use: /note <texto>`);
  await appendLog(link.sheetId, { tipo:'note', autor: msg._data?.notifyName || 'alguém', msg: noteText, arquivo:'', link:'', obs:'' });
  return msg.reply(`✅ Nota registrada.`);
}

async function handleRemindNow(msg, link) {
  return handleSummary(msg, link, { brief:false });
}

/* ------------- Upload ------------- */
async function handleUploadIfAny(c, msg, link) {
  if (!msg.hasMedia) return false;
  try {
    const res = await saveIncomingMediaToDrive(c, msg, link);
    if (res?.url) {
      await appendLog(link.sheetId, { tipo:'upload', autor: msg._data?.notifyName || 'alguém', msg: 'arquivo salvo', arquivo:'', link: res.url, obs:'' });
      await safeReply(msg, `✅ Arquivo salvo em ${B(link.projectName)}.\n🔗 ${res.url}`);
    } else {
      await appendLog(link.sheetId, { tipo:'upload', autor: 'bot', msg: 'falha upload', arquivo:'', link:'', obs:'' });
      await msg.reply('❌ Não consegui salvar no Drive.');
    }
  } catch (e) {
    console.log('[upload] erro', e?.message || e);
    await msg.reply('❌ Não consegui salvar no Drive.');
  }
  return true;
}

/* ------------- Bind / Group utils ------------- */
async function ensureAutoBind(groupId, link) {
  try {
    const meta = await readProjectMeta(link.sheetId);
    if (!meta.GroupId) await saveGroupId(link.sheetId, groupId);
  } catch {}
}

/* ------------- Wire ------------- */

function buildClient() {
  return new Client({
    authStrategy: new LocalAuth({ clientId: 'brynix-bot', dataPath: SESSION_PATH }),
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process'] },
    restartOnAuthFail: true, takeoverOnConflict: true, takeoverTimeoutMs: 5_000,
  });
}

function getLastQr() { return lastQr; }

function wireEvents(c) {
  c.on('qr', (qr) => { lastQr = qr; currentState = 'qr'; console.log('[WA] QR gerado'); });
  c.on('authenticated', () => console.log('[WA] Autenticado'));
  c.on('ready', () => { currentState='ready'; console.log('[WA] Pronto ✅'); });

  c.on('message', async (msg) => {
    try {
      const chat = await msg.getChat();
      const isGroup = chat.isGroup;
      const text = (msg.body || '').trim();
      const isCommand = text.startsWith('/');
      const chatId = msg.from;

      // 1) 1:1 — analista
      if (!isGroup) {
        if (isCommand && /^\/ajuda|\/help|\/menu/i.test(text)) {
          return safeReply(msg, [
            B('Como posso ajudar?'),
            '• Fale comigo sobre a BRYNIX (o que fazemos, ofertas, metodologia, cases).',
            '• Para projetos, me adicione num grupo e use /setup para vincular à planilha.',
            'Comandos técnicos: /ping, /say <texto> (áudio).'
          ].join('\n'));
        }
        if (isCommand && /^\/ping/i.test(text)) return msg.reply('pong 🏓');
        if (isCommand && /^\/say/i.test(text)) {
          const t = text.replace(/^\/say/i,'').trim() || 'Oi! Estou por aqui.';
          const tts = require('./tts');
          const r = await tts.synthesize(t, { voice: process.env.TTS_VOICE || 'alloy' });
          if (!r) return msg.reply('⚠️ TTS indisponível.');
          const media = new MessageMedia(r.mime, r.buffer.toString('base64'), 'voz.mp3');
          return client.sendMessage(chatId, media, { sendAudioAsVoice:false });
        }
        const reply = await generateReply(text, { from: msg.from, pushName: msg._data?.notifyName });
        return safeReply(msg, reply);
      }

      // 2) grupo — GP/AP
      // silenciar
      if (muteMap.get(chatId)) {
        if (isCommand && /^\/mute\s*off/i.test(text)) { muteMap.delete(chatId); return msg.reply(I('voltei a falar 😉')); }
        return; // silenciado
      }

      // mudo <-> desmudo
      if (isCommand && /^\/mute\s*on/i.test(text)) { muteMap.set(chatId, true); return msg.reply(I('ok, fico em silêncio até /mute off')); }
      if (isCommand && /^\/mute\s*off/i.test(text)) { muteMap.delete(chatId); return msg.reply(I('voltei a falar 😉')); }

      // setup / bind utils
      if (isCommand && /^\/setup/i.test(text)) return handleSetup(msg, text);
      if (isCommand && /^\/__groupid/i.test(text)) return msg.reply(`GroupId: ${chatId}`);
      if (isCommand && /^\/__bind/i.test(text)) {
        const cur = linkMap.get(chatId);
        if (!cur) return msg.reply('⚠️ Sem vínculo em memória. Use /setup.');
        await ensureAutoBind(chatId, cur);
        return msg.reply('✅ GroupId gravado na planilha (se não existia).');
      }

      // precisa de vínculo
      let link = linkMap.get(chatId);
      if (!link) {
        // tenta autovincular se a planilha tem GroupId igual ao chat
        if (isCommand && /^\/link\s+/i.test(text)) {
          const sheetId = extractSheetId(text.replace(/^\/link/i,'').trim());
          if (sheetId) {
            const meta = await readProjectMeta(sheetId);
            if ((meta.GroupId||'') === chatId) {
              link = { sheetId, projectName: meta.ProjectName || 'Projeto' };
              linkMap.set(chatId, link);
              return msg.reply(`✅ Vínculo carregado: ${link.projectName}`);
            }
          }
        }
        // se não for /setup ou /link, orienta:
        if (!isCommand || !/^\/setup|^\/link/i.test(text)) {
          return msg.reply('⚠️ Grupo não vinculado. Use /setup <sheetId|url> | <Nome>  ou  /link <sheetId|url> (se a planilha já tem GroupId).');
        }
      }

      // salva GroupId se vazio
      if (link) ensureAutoBind(chatId, link);

      // upload se houver
      if (await handleUploadIfAny(c, msg, link)) return;

      // menu rápido / números
      const mentioned = wasBotMentioned(msg);
      const numberOnly = /^[1-7]$/.test(text);
      if (mentioned && !isCommand && !numberOnly) {
        return safeReply(msg, menuCard(link.projectName));
      }

      if (numberOnly) {
        const n = text.trim();
        if (n==='1') return handleSummary(msg, link);
        if (n==='2') return handleNext(msg, link);
        if (n==='3') return handleLate(msg, link);
        if (n==='4') return handleRemindNow(msg, link);
        if (n==='5') return msg.reply('Digite: /note <texto>');
        if (n==='6') return handleWho(msg, link);
        if (n==='7') { muteMap.set(chatId,true); return msg.reply(I('ok, fico em silêncio até /mute off')); }
      }

      if (isCommand) {
        if (/^\/menu/i.test(text)) return safeReply(msg, menuCard(link.projectName));
        if (/^\/help|^\/ajuda/i.test(text)) return safeReply(msg, menuCard(link.projectName));
        if (/^\/summary/i.test(text)) return handleSummary(msg, link);
        if (/^\/brief/i.test(text)) return handleSummary(msg, link, { brief:true });
        if (/^\/next/i.test(text)) return handleNext(msg, link);
        if (/^\/late/i.test(text)) return handleLate(msg, link);
        if (/^\/who/i.test(text)) return handleWho(msg, link);
        if (/^\/note/i.test(text)) return handleNote(msg, link, text.replace(/^\/note/i,'').trim());
        if (/^\/remind\s+now/i.test(text)) return handleRemindNow(msg, link);
      }

      // se falou comigo naturalmente, mostro o menu
      if (mentioned) return safeReply(msg, menuCard(link.projectName));

    } catch (e) {
      console.log('[WA] erro msg:', e?.message || e);
      try { await msg.reply('Dei uma engasgada técnica aqui. Pode reenviar?'); } catch {}
    }
  });
}

/* ------------- HTTP helpers ------------- */

function initWhatsApp(app) {
  client = buildClient();
  wireEvents(client);
  client.initialize();

  // watchdog simples
  setInterval(async () => {
    try {
      const s = await client.getState().catch(()=>null);
      if (!s) console.log('[WA] state nulo (ok se reiniciou)');
    } catch {}
  }, WATCHDOG_INTERVAL_MS);

  // rotas utilitárias (healthz / qr)
  if (app && app.get) {
    app.get('/wa-qr', async (_req,res)=>{
      if (!lastQr) return res.status(503).send('QR ainda não gerado.');
      const png = await QRCode.toBuffer(lastQr, { type:'png', margin:1, scale:6 });
      res.type('image/png').send(png);
    });
    app.get('/healthz', (_req,res)=> res.json({ status: currentState, binds: linkMap.size }));
  }

  // inicia scheduler (tick/60s)
  setInterval(() => scheduler().catch(()=>{}), 60_000);
}

module.exports = { initWhatsApp, getLastQr };
