// whatsapp.js
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { generateReply } = require('./ai');

const {
  extractSheetId,
  readProjectMeta,
  readTasks,
  buildStatusSummary,
  listTasksByAssignee,
  writeLog,
} = require('./sheets');

const { saveToProjectDrive } = require('./drive'); // seu drive.js atual

const fs = require('fs');
const path = require('path');

// =====================
// Config
// =====================
const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const REINIT_COOLDOWN_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 60_000;
const LINKS_DB_PATH = process.env.LINKS_DB_PATH || path.join(__dirname, 'links-db.json');

let currentState = 'starting';
let lastQr = '';
let reinitNotBefore = 0;
let client;

function getLastQr() { return lastQr; }

// ====== tiny KV com mapeamento groupId -> { sheetId, projectName, driveFolderId? }
function loadLinksDB() {
  try {
    return JSON.parse(fs.readFileSync(LINKS_DB_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveLinksDB(db) {
  try {
    fs.writeFileSync(LINKS_DB_PATH, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('[LINKS_DB] erro ao salvar:', e);
  }
}

async function sendAlert(payload) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    const body = typeof payload === 'string' ? { text: payload } : payload || { text: '⚠️' };
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) {
    console.error('❌ Erro webhook:', err);
  }
}

// =====================
// Client
// =====================
function buildClient() {
  return new Client({
    authStrategy: new LocalAuth({
      clientId: 'brynix-bot',
      dataPath: SESSION_PATH,
    }),
    puppeteer: {
      headless: true,
      timeout: 60_000,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process'],
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

  try { if (client) { try { await client.destroy(); } catch {} } } catch {}
  client = buildClient();
  wireEvents(client);
  client.initialize();
}

function userLabelFromMsg(msg) {
  return msg._data?.notifyName || msg._data?.sender?.pushname || msg.from || 'desconhecido';
}

function isGroup(id) {
  return id.endsWith('@g.us');
}

function mentionedMe(msg) {
  // wwebjs: msg.mentionedIds contém os @ citados
  const me = client.info?.wid?._serialized;
  return (msg.mentionedIds || []).includes(me);
}

function helpText() {
  return (
`*Comandos*
• /setup <sheetId|url> | <Nome do Projeto>
• /summary → sumário real do projeto
• /who <nome> → tarefas de um responsável
• /mine → minhas tarefas
• (Envie anexos mencionando o bot ou com /upload para salvar no Drive)`
  );
}

async function handleSetup(msg, db, args) {
  const [left, right] = (args || '').split('|').map(s => (s || '').trim());
  if (!left || !right) {
    return msg.reply('Uso: /setup <sheetId|url> | <Nome do Projeto>');
  }
  const sheetId = extractSheetId(left);
  if (!sheetId) return msg.reply('SheetId/URL inválido.');

  // sanity: tenta ler metadados só pra validar
  try {
    await readProjectMeta(sheetId);
  } catch (e) {
    console.error('[SETUP] não consegui ler a planilha:', e);
    return msg.reply('❌ Não consegui acessar a planilha. Confirme compartilhamento com a Service Account.');
  }

  db[msg.from] = { sheetId, projectName: right };
  saveLinksDB(db);

  await msg.reply(
`✅ Projeto vinculado!

• Planilha: ${sheetId}
• Nome: *${right}*`
  );

  // LOG no Sheets (opcional)
  try {
    await writeLog(sheetId, {
      timestamp: new Date().toISOString(),
      usuario: userLabelFromMsg(msg),
      acao: 'setup',
      resultado: `Projeto vinculado: ${right}`,
      link: `https://docs.google.com/spreadsheets/d/${sheetId}`,
    });
  } catch (e) { console.warn('[LOG setup] falhou:', e?.message); }
}

async function handleSummary(msg, db) {
  const map = db[msg.from];
  if (!map?.sheetId) return msg.reply('Antes faça /setup.');
  try {
    const tasks = await readTasks(map.sheetId);
    const text = buildStatusSummary(map.projectName, tasks);
    await msg.reply(text);
    await writeLog(map.sheetId, {
      timestamp: new Date().toISOString(),
      usuario: userLabelFromMsg(msg),
      acao: 'summary',
      resultado: `OK (${tasks.length} tarefas)`,
      link: `https://docs.google.com/spreadsheets/d/${map.sheetId}`,
    });
  } catch (e) {
    console.error('[SUMMARY] erro:', e);
    await msg.reply('❌ Não consegui gerar o resumo agora.');
  }
}

async function handleWho(msg, db, rawArgs, mine = false) {
  const map = db[msg.from];
  if (!map?.sheetId) return msg.reply('Antes faça /setup.');

  let nome = rawArgs?.trim();
  if (mine || !nome) nome = userLabelFromMsg(msg);

  try {
    const lista = await listTasksByAssignee(map.sheetId, nome);
    if (!lista.length) return msg.reply(`Sem tarefas para *${nome}*.`);
    const linhas = lista.slice(0, 15).map(t => {
      const prazo = t.dataTermino ? ` | prazo: ${t.dataTermino}` : '';
      const st = t.status ? ` | ${t.status}` : '';
      return `- ${t.tarefa}${st}${prazo}`;
    }).join('\n');

    await msg.reply(`*Tarefas de ${nome}:*\n${linhas}${lista.length>15?`\n(+ ${lista.length-15} mais...)`:''}`);

    await writeLog(map.sheetId, {
      timestamp: new Date().toISOString(),
      usuario: userLabelFromMsg(msg),
      acao: mine ? 'mine' : 'who',
      resultado: `${nome} => ${lista.length} tarefa(s)`,
      link: `https://docs.google.com/spreadsheets/d/${map.sheetId}`,
    });
  } catch (e) {
    console.error('[WHO] erro:', e);
    await msg.reply('❌ Não consegui filtrar agora.');
  }
}

async function handleUpload(msg, db) {
  const map = db[msg.from];
  if (!map?.sheetId || !map?.projectName) {
    return msg.reply('Antes faça /setup para vincular o projeto.');
  }
  try {
    const media = await msg.downloadMedia();
    if (!media) return msg.reply('Não recebi o anexo. Pode reenviar?');

    // salva no Drive
    const res = await saveToProjectDrive({
      projectName: map.projectName,
      chatId: msg.from,
      media,
      originalCaption: msg.body || '',
    });

    if (!res?.webViewLink) throw new Error('Sem link do Drive');

    await msg.reply(`✅ Arquivo salvo em *${map.projectName}*.\n🔗 ${res.webViewLink}`);

    // LOG no Sheets
    await writeLog(map.sheetId, {
      timestamp: new Date().toISOString(),
      usuario: userLabelFromMsg(msg),
      acao: 'upload',
      resultado: res.name || 'arquivo',
      link: res.webViewLink,
    });
  } catch (e) {
    console.error('[UPLOAD] erro:', e);
    await msg.reply('❌ Não consegui salvar no Drive.');
  }
}

// =====================
// Eventos
// =====================
function wireEvents(c) {
  c.on('qr', (qr) => {
    lastQr = qr;
    currentState = 'qr';
    console.log('[WA] QR gerado. Abra /wa-qr para escanear.');
    sendAlert('🔄 BOT Brynix requer novo pareamento: abra /wa-qr e escaneie o código.');
  });

  c.on('authenticated', () => console.log('[WA] Autenticado'));

  c.on('auth_failure', (m) => {
    console.error('[WA] Falha de autenticação:', m);
    sendAlert(`⚠️ Falha de autenticação do BOT Brynix: ${m || 'motivo não informado'}`);
    safeReinit('auth_failure');
  });

  c.on('ready', () => {
    currentState = 'ready';
    console.log('[WA] Cliente pronto ✅');
    sendAlert('✅ BOT Brynix online e pronto.');
  });

  c.on('change_state', (state) => {
    currentState = state || currentState;
    console.log('[WA] Estado alterado:', currentState);
  });

  c.on('disconnected', (reason) => {
    currentState = 'disconnected';
    console.error('[WA] Desconectado:', reason);
    sendAlert(`❌ BOT Brynix desconectado. Motivo: ${reason || 'não informado'}`);
    safeReinit(`disconnected:${reason || 'unknown'}`);
  });

  c.on('message', async (msg) => {
    const db = loadLinksDB();

    try {
      // GROUP gate: só responde se for @mencionado ou comando
      const emGrupo = isGroup(msg.from);
      const texto = (msg.body || '').trim();

      const isCommand = /^\/(setup|summary|help|who|mine|upload)\b/i.test(texto);

      if (emGrupo && !isCommand && !mentionedMe(msg)) {
        // Ignora mensagens de bate-papo do grupo
        return;
      }

      // Comandos
      if (/^\/help\b/i.test(texto)) {
        return msg.reply(helpText());
      }

      if (/^\/setup\b/i.test(texto)) {
        const args = texto.replace(/^\/setup\s*/i, '');
        return await handleSetup(msg, db, args);
      }

      if (/^\/summary\b/i.test(texto)) {
        return await handleSummary(msg, db);
      }

      if (/^\/mine\b/i.test(texto)) {
        return await handleWho(msg, db, '', true);
      }

      if (/^\/who\b/i.test(texto)) {
        const nome = texto.replace(/^\/who\s*/i, '');
        return await handleWho(msg, db, nome, false);
      }

      if (/^\/upload\b/i.test(texto) || (msg.hasMedia && (!emGrupo || mentionedMe(msg)))) {
        return await handleUpload(msg, db);
      }

      // Fora comandos — IA (1:1) ou menção em grupo
      const reply = await generateReply(msg.body, {
        from: msg.from,
        pushName: msg._data?.notifyName,
      });
      await msg.reply(reply);

    } catch (err) {
      console.error('[WA] Erro ao processar/enviar resposta:', err);
      try { await msg.reply('Tive um problema técnico agora há pouco. Pode reenviar sua mensagem?'); } catch {}
      sendAlert(`❗ Erro ao responder mensagem: ${err?.message || err}`);
    }
  });
}

// =====================
// Init
// =====================
function initWhatsApp(app) {
  client = buildClient();
  wireEvents(client);

  if (app && app.get) {
    app.get('/wa-status', async (_req, res) => {
      let state = currentState;
      try {
        const s = await client.getState().catch(() => null);
        if (s) state = s;
      } catch {}
      res.json({ status: state });
    });
  }

  client.initialize();

  setInterval(async () => {
    try {
      const s = await client.getState().catch(() => null);
      if (!s || s === 'CONFLICT' || s === 'UNPAIRED' || s === 'UNLAUNCHED') {
        console.log(`[WA] Watchdog: estado crítico (${s || 'null'}) → reinit`);
        sendAlert(`⏰ Watchdog: estado do BOT é "${s || 'null'}". Tentando reinicializar.`);
        safeReinit(`watchdog:${s || 'null'}`);
      } else if (currentState !== 'ready' && s === 'CONNECTED') {
        currentState = 'ready';
      } else {
        console.log(`[WA] Estado ok (${s || currentState})`);
      }
    } catch (err) {
      console.error('[WA] Watchdog erro:', err);
      safeReinit('watchdog-error');
    }
  }, WATCHDOG_INTERVAL_MS);
}

module.exports = { initWhatsApp, getLastQr };
