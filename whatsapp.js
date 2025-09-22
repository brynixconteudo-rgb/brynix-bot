// whatsapp.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const { generateReply } = require('./ai');
const { get: dbGet, set: dbSet, remove: dbRemove, DB_PATH } = require('./storage');
const {
  extractSheetId, readProjectMeta, readTasks, buildStatusSummary,
} = require('./sheets');

// =====================
// Configurações
// =====================
const SESSION_PATH = process.env.WA_SESSION_PATH || '/var/data/wa-session';
const REINIT_COOLDOWN_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 60_000;

let currentState = 'starting';
let lastQr = '';
let reinitNotBefore = 0;
let client;

// Mencionar por @ e comandos (sem @)
const BOT_NAMES = (process.env.BOT_NAMES || 'brynix,bot').split(',').map(s => s.trim().toLowerCase());
const CMD_PREFIX = '/';

// =====================
function getLastQr() { return lastQr; }

async function sendAlert(payload) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) { console.log('ℹ️ ALERT_WEBHOOK_URL não configurada; alerta:', payload); return; }
  try {
    const body = typeof payload === 'string' ? { text: payload } : (payload || { text: '⚠️ Alerta' });
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    console.log('🚨 Alerta enviado com sucesso.');
  } catch (err) {
    console.error('❌ Erro ao enviar alerta:', err);
  }
}

function buildClient() {
  return new Client({
    authStrategy: new LocalAuth({ clientId: 'brynix-bot', dataPath: SESSION_PATH }),
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

async function safeReinit(reason = 'unknown') {
  const now = Date.now();
  if (now < reinitNotBefore) { console.log(`[WA] Reinit ignorado (cooldown). Motivo: ${reason}`); return; }
  reinitNotBefore = now + REINIT_COOLDOWN_MS;
  try { if (client) { try { await client.destroy(); } catch (_) {} } } catch (e) { console.error('[WA] destroy err:', e); }
  client = buildClient(); wireEvents(client); client.initialize();
}

// ===== Helpers de grupo =====
function normalize(text) { return (text || '').toString().trim(); }
function isMentioningBot(body) {
  const lower = body.toLowerCase();
  return BOT_NAMES.some(n => lower.includes(`@${n}`));
}
function isCommand(body) { return (body || '').trim().startsWith(CMD_PREFIX); }
function stripCommand(text) { return text.trim().replace(/^\//, '').trim(); }

function onlyIfGroupCalled(msg) {
  // Responde em grupo apenas se foi mencionado OU se começou com "/"
  const fromGroup = msg.from.endsWith('@g.us');
  if (!fromGroup) return true; // 1:1 sempre
  const body = msg.body || '';
  if (isMentioningBot(body) || isCommand(body)) return true;
  console.log('[WA] Ignorado no grupo (sem menção/comando).');
  return false;
}

// ====== Comandos de planilha ======
function resolveSheetIdFromInput(input) {
  const id = extractSheetId(input);
  if (!id) throw new Error('Não consegui entender esse ID/URL de planilha.');
  return id;
}

async function cmdLinkSheet(msg, arg) {
  try {
    const id = resolveSheetIdFromInput(arg);
    // sanidade: tenta ler meta pra validar
    const meta = await readProjectMeta(id);
    dbSet(msg.from, id);
    await msg.reply(
      `✅ Planilha vinculada a este grupo.\n` +
      `*Projeto:* ${meta.ProjectName || '(sem nome)'}\n` +
      `*SheetId:* \`${id}\`\n` +
      `Arquivo: ${DB_PATH}`
    );
  } catch (e) {
    console.error('[CMD /link] erro:', e);
    await msg.reply(`❌ Não consegui vincular: ${e.message || e}`);
  }
}

async function cmdWhich(msg) {
  const id = dbGet(msg.from);
  if (!id) { await msg.reply('ℹ️ Este grupo ainda não tem planilha vinculada. Use /link <url|id>.'); return; }
  try {
    const meta = await readProjectMeta(id);
    await msg.reply(`🔗 *Planilha vinculada*\nProjeto: ${meta.ProjectName || '(sem nome)'}\nSheetId: \`${id}\``);
  } catch {
    await msg.reply(`🔗 SheetId registrado: \`${id}\`\n(Obs: não consegui ler os metadados agora)`);
  }
}

async function cmdUnlink(msg) {
  const id = dbGet(msg.from);
  if (!id) { await msg.reply('Já não havia planilha vinculada.'); return; }
  dbRemove(msg.from);
  await msg.reply('🗑️ Vínculo removido para este grupo.');
}

async function cmdStatus(msg) {
  const id = dbGet(msg.from);
  if (!id) { await msg.reply('ℹ️ Este grupo não tem planilha vinculada. Use /link <url|id>.'); return; }
  try {
    const meta = await readProjectMeta(id);
    const tasks = await readTasks(id);
    const text = buildStatusSummary(meta.ProjectName, tasks);
    await msg.reply(text);
  } catch (e) {
    console.error('[CMD /status] erro:', e);
    await msg.reply(`❌ Falha ao ler planilha: ${e.message || e}`);
  }
}

async function cmdTarefas(msg, filtroResponsavel) {
  const id = dbGet(msg.from);
  if (!id) { await msg.reply('ℹ️ Este grupo não tem planilha vinculada. Use /link <url|id>.'); return; }
  try {
    const tasks = await readTasks(id);
    let open = tasks.filter(t => !/conclu(i|í)da/i.test(t.status || ''));
    if (filtroResponsavel) {
      const f = filtroResponsavel.toLowerCase();
      open = open.filter(t => (t.responsavel || '').toLowerCase().includes(f));
    }
    const top = open.slice(0, 12).map(t =>
      `• ${t.tarefa} — ${t.status || 's/ status'} (${t.responsavel || 's/ resp'})`
    ).join('\n') || 'Nenhuma tarefa aberta.';
    await msg.reply(`*Tarefas abertas${filtroResponsavel ? ` para ${filtroResponsavel}` : ''}:*\n${top}`);
  } catch (e) {
    console.error('[CMD /tarefas] erro:', e);
    await msg.reply(`❌ Erro ao ler tarefas: ${e.message || e}`);
  }
}

// ====== Wiring ======
function wireEvents(c) {
  c.on('qr', (qr) => {
    lastQr = qr; currentState = 'qr';
    console.log('[WA] QR gerado. Abra /wa-qr para escanear.');
    sendAlert('🔄 BOT Brynix requer novo pareamento: abra /wa-qr e escaneie o código.');
  });

  c.on('authenticated', () => console.log('[WA] Autenticado'));
  c.on('auth_failure', (m) => { console.error('[WA] Falha auth:', m); sendAlert(`⚠️ Falha de auth: ${m || ''}`); safeReinit('auth_failure'); });
  c.on('ready', () => { currentState = 'ready'; console.log('[WA] Cliente pronto ✅'); sendAlert('✅ BOT Brynix online e pronto.'); });
  c.on('change_state', (state) => { currentState = state || currentState; console.log('[WA] Estado:', currentState); });
  c.on('disconnected', (reason) => { currentState = 'disconnected'; console.error('[WA] Desconectado:', reason); sendAlert(`❌ Desconectado: ${reason || ''}`); safeReinit(`disconnected:${reason||'x'}`); });

  // MENSAGENS
  c.on('message', async (msg) => {
    try {
      const body = normalize(msg.body);
      if (!onlyIfGroupCalled(msg)) return;

      // comandos (grupo ou 1:1)
      if (isCommand(body)) {
        const [cmd, ...rest] = stripCommand(body).split(/\s+/);
        const arg = rest.join(' ').trim();

        switch ((cmd || '').toLowerCase()) {
          case 'link':
          case 'vincular':
            if (!msg.from.endsWith('@g.us')) { await msg.reply('Comando /link é apenas em grupos.'); return; }
            await cmdLinkSheet(msg, arg);
            return;
          case 'which':
          case 'planilha':
            if (!msg.from.endsWith('@g.us')) { await msg.reply('Comando válido apenas em grupos.'); return; }
            await cmdWhich(msg);
            return;
          case 'unlink':
          case 'desvincular':
            if (!msg.from.endsWith('@g.us')) { await msg.reply('Comando válido apenas em grupos.'); return; }
            await cmdUnlink(msg);
            return;
          case 'status':
            await cmdStatus(msg);
            return;
          case 'tarefas':
          case 'tasks':
            await cmdTarefas(msg, arg || '');
            return;
          case 'help':
            await msg.reply(
              '*Comandos (modo GP):*\n' +
              '• /link <url|id> – vincula planilha ao grupo\n' +
              '• /which – mostra a planilha vinculada\n' +
              '• /unlink – remove vínculo\n' +
              '• /status – resumo do projeto\n' +
              '• /tarefas [responsável] – lista tarefas abertas\n'
            );
            return;
          default:
            await msg.reply('Não reconheci esse comando. Use /help.');
            return;
        }
      }

      // Conversa livre:
      const reply = await generateReply(body, { from: msg.from, pushName: msg._data?.notifyName });
      await msg.reply(reply);

    } catch (err) {
      console.error('[WA] Erro ao processar/enviar:', err);
      try { await msg.reply('Tive um problema técnico agora. Pode reenviar sua mensagem?'); } catch (_) {}
    }
  });
}

// =====================
function initWhatsApp(app) {
  client = buildClient(); wireEvents(client);

  if (app && app.get) {
    app.get('/wa-status', async (_req, res) => {
      let state = currentState;
      try {
        const s = await client.getState().catch(() => null);
        if (s) state = s;
      } catch {}
      res.json({ status: state, db: DB_PATH });
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
