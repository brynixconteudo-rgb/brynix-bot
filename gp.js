// gp.js
// "Gerente de Projeto" leve: interpreta comandos/natural language,
// persiste eventos em JSON no disco e gera summaries sem "inventar".

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = process.env.GP_DATA_DIR || '/var/data/brynix';
const PROJECT_FILE = path.join(DATA_DIR, 'project.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json'); // [{ts,type,by,text,meta}]

const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true }).catch(() => {});
}

async function readJson(file, fallback) {
  try {
    const buf = await fsp.readFile(file, 'utf8');
    return JSON.parse(buf);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function sendWebhook(payload) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('[GP] Erro no webhook:', err?.message || err);
  }
}

/** Inicializa arquivos se necessário */
async function bootstrap() {
  await ensureDir(DATA_DIR);
  const proj = await readJson(PROJECT_FILE, null);
  if (!proj) {
    await writeJson(PROJECT_FILE, {
      name: null,
      owner: null,
      sheet: null,     // link de planilha (opcional)
      percent: null,   // % de avanço (opcional; pode vir de planilha depois)
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  const act = await readJson(ACTIVITY_FILE, null);
  if (!act) await writeJson(ACTIVITY_FILE, []);
}

function fmtDateISO(d = new Date()) {
  return new Date(d).toISOString();
}

async function addActivity(evt) {
  const list = await readJson(ACTIVITY_FILE, []);
  list.push({ ts: fmtDateISO(), ...evt });
  await writeJson(ACTIVITY_FILE, list);
}

function helpMenu() {
  return [
    '📋 *Comandos disponíveis*',
    '',
    '1️⃣ */setup* – Define nome do projeto e (opcional) link de planilha.',
    '   • Ex.: `/setup Projeto Fênix | owner=Paulo | sheet=https://...`',
    '2️⃣ */who* – Mostra metadados (nome, dono, planilha) e contagem de itens.',
    '3️⃣ */note* – Registra uma nota/atualização.',
    '   • Ex.: `/note Validação com time de negócio concluída.`',
    '4️⃣ */doc* – Registra um documento recebido/linkado.',
    '   • Ex.: `/doc Ata de Reunião 21/09 (link ...)`',
    '5️⃣ */summary* – Gera sumário das últimas interações (sem inventar).',
    '6️⃣ */remind* – Cria lembrete.',
    '   • Ex.: `/remind 10:00 Reunião com fornecedores`',
    '',
    '💡 *Fale naturalmente também!*',
    '   • "Segue a ata da reunião" → eu registro como documento.',
    '   • "Me lembra amanhã 09:00 revisar backlog" → viro lembrete.',
    '   • "Status do projeto" → gero um resumo.',
  ].join('\n');
}

/** Interpretação simples de intenções por texto (PT-BR) */
function detectIntent(textRaw) {
  const text = (textRaw || '').trim();
  const lower = text.toLowerCase();

  // comandos explícitos
  if (lower.startsWith('/help')) return { intent: 'help' };
  if (lower.startsWith('/who')) return { intent: 'who' };
  if (lower.startsWith('/setup')) return { intent: 'setup', payload: text.replace(/^\/setup\s*/i, '') };
  if (lower.startsWith('/note')) return { intent: 'note', payload: text.replace(/^\/note\s*/i, '') };
  if (lower.startsWith('/doc')) return { intent: 'doc', payload: text.replace(/^\/doc\s*/i, '') };
  if (lower.startsWith('/summary')) return { intent: 'summary' };
  if (lower.startsWith('/remind')) return { intent: 'remind', payload: text.replace(/^\/remind\s*/i, '') };

  // linguagem natural ↓
  if (/^help$|^menu$|^ajuda$/.test(lower)) return { intent: 'help' };

  if (/(status|resumo|atualiza(ç|c)ão|como estamos)/i.test(lower))
    return { intent: 'summary' };

  if (/(lembra|me lembra|me lembrar|lembrete)/i.test(lower))
    return { intent: 'remind', payload: text };

  if (/(segue|anexo|anexei|envio|enviando).*(ata|documento|contrato|apresenta|ppt|pdf|arquivo)/i.test(lower))
    return { intent: 'doc', payload: text };

  if (/nota:|registrar|apontamento|observa(ç|c)ão/i.test(lower))
    return { intent: 'note', payload: text.replace(/^nota:\s*/i, '') };

  if (/^quem somos|quem (é|e) o dono|quem (manda|lidera)|projeto se chama/i.test(lower))
    return { intent: 'who' };

  return { intent: null };
}

/** Parse simples do /setup “chave=valor” */
function parseSetupPayload(raw = '') {
  // Exemplos aceitos:
  // "Projeto Fênix | owner=Paulo | sheet=https://..."
  const parts = raw.split('|').map(s => s.trim()).filter(Boolean);
  const out = { name: null, owner: null, sheet: null };
  if (parts.length) {
    // o 1º bloco sem "chave=" vira nome, se couber
    if (!/^\w+=/.test(parts[0])) out.name = parts[0];
  }
  for (const p of parts) {
    const m = p.match(/^(\w+)=([\s\S]+)$/);
    if (m) {
      const k = m[1].toLowerCase();
      const v = m[2].trim();
      if (k === 'owner' || k === 'dono') out.owner = v;
      if (k === 'sheet' || k === 'planilha') out.sheet = v;
      if (k === 'name' || k === 'projeto') out.name = v;
    }
  }
  return out;
}

/** Puxa os dados atuais */
async function getState() {
  const proj = await readJson(PROJECT_FILE, {});
  const items = await readJson(ACTIVITY_FILE, []);
  return { proj, items };
}

/** Handlers */
async function handleHelp() {
  return helpMenu();
}

async function handleWho() {
  const { proj, items } = await getState();
  const docs = items.filter(i => i.type === 'doc').length;
  const notes = items.filter(i => i.type === 'note').length;
  const rems = items.filter(i => i.type === 'remind').length;

  return [
    'ℹ️ *Projeto*',
    `• Nome: ${proj.name || '—'}`,
    `• Dono: ${proj.owner || '—'}`,
    `• Planilha: ${proj.sheet || '—'}`,
    `• % Avanço: ${proj.percent != null ? proj.percent + '%' : '—'}`,
    '',
    '📦 *Registros*',
    `• Notas: ${notes} | Docs: ${docs} | Lembretes: ${rems}`,
  ].join('\n');
}

async function handleSetup(payload, ctx) {
  const parsed = parseSetupPayload(payload);
  const proj = await readJson(PROJECT_FILE, {});
  const updated = {
    ...proj,
    name: parsed.name ?? proj.name ?? null,
    owner: parsed.owner ?? proj.owner ?? (ctx?.pushName || null),
    sheet: parsed.sheet ?? proj.sheet ?? null,
    updatedAt: fmtDateISO(),
  };
  await writeJson(PROJECT_FILE, updated);
  await addActivity({ type: 'setup', by: ctx?.from || 'user', text: payload || '(setup)' });
  return '✅ *Setup salvo.* Use */who* para ver os metadados.';
}

async function handleNote(payload, ctx) {
  const text = (payload || '').trim();
  if (!text) return 'Para registrar uma nota, use `/note Texto da nota...`';
  await addActivity({ type: 'note', by: ctx?.from || 'user', text });
  return '📝 Nota registrada.';
}

async function handleDoc(payload, ctx) {
  const text = (payload || '').trim() || 'Documento';
  await addActivity({ type: 'doc', by: ctx?.from || 'user', text });
  return '📎 Documento registrado.';
}

function parseRemindPayload(raw = '') {
  // Aceita: "10:00 Revisar X" | "22/09/2025 10:00 Revisar..." | "amanhã 09:00 ..."
  // Como parsing de linguagem natural completa é grande,
  // vamos armazenar o texto original e avisar o webhook.
  const mTime = raw.match(/\b(\d{1,2}:\d{2})\b/);
  const time = mTime ? mTime[1] : null;
  const mDate = raw.match(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/);
  const date = mDate ? mDate[1] : null;
  const task = raw.replace(mDate?.[0] || '', '').replace(mTime?.[0] || '', '').trim();
  return { date, time, task: task || raw.trim() };
}

async function handleRemind(payload, ctx) {
  const data = parseRemindPayload(payload || '');
  await addActivity({ type: 'remind', by: ctx?.from || 'user', text: data.task, meta: { date: data.date, time: data.time } });

  // opcional: dispara webhook p/ Zapier (criar evento/lembrete)
  await sendWebhook({ kind: 'reminder', ...data, from: ctx?.from, who: ctx?.pushName });

  return `⏰ Lembrete anotado: ${[data.date, data.time].filter(Boolean).join(' ')} – ${data.task}`;
}

function takeLast(list, n) {
  return list.slice(-n);
}

async function handleSummary() {
  const { proj, items } = await getState();

  const notes = takeLast(items.filter(i => i.type === 'note'), 5);
  const docs = takeLast(items.filter(i => i.type === 'doc'), 5);
  const rems = takeLast(items.filter(i => i.type === 'remind'), 5);

  const lines = [];
  lines.push('📊 *Status do Projeto*');
  lines.push(`• Projeto: ${proj.name || '—'}`);
  lines.push(`• Dono: ${proj.owner || '—'}`);
  lines.push(`• % Avanço: ${proj.percent != null ? proj.percent + '%' : '—'}`);
  if (proj.sheet) lines.push(`• Planilha: ${proj.sheet}`);
  lines.push('');

  if (notes.length) {
    lines.push('📝 *Últimas notas*');
    for (const n of notes) lines.push(`• ${n.text}`);
    lines.push('');
  }
  if (docs.length) {
    lines.push('📎 *Docs recentes*');
    for (const d of docs) lines.push(`• ${d.text}`);
    lines.push('');
  }
  if (rems.length) {
    lines.push('⏰ *Lembretes*');
    for (const r of rems) {
      const when = [r?.meta?.date, r?.meta?.time].filter(Boolean).join(' ');
      lines.push(`• ${when ? `[${when}] ` : ''}${r.text}`);
    }
    lines.push('');
  }

  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= 4) lines.push('Não há registros suficientes ainda. Use */note*, */doc* e */remind* para alimentar o histórico.');

  return lines.join('\n');
}

/** Entrada única: decide se GP deve responder */
async function handleMessage(text, ctx) {
  await bootstrap(); // garante os arquivos

  const { intent, payload } = detectIntent(text);

  switch (intent) {
    case 'help':     return { handled: true, reply: handleHelp() };
    case 'who':      return { handled: true, reply: await handleWho() };
    case 'setup':    return { handled: true, reply: await handleSetup(payload, ctx) };
    case 'note':     return { handled: true, reply: await handleNote(payload, ctx) };
    case 'doc':      return { handled: true, reply: await handleDoc(payload, ctx) };
    case 'summary':  return { handled: true, reply: await handleSummary() };
    case 'remind':   return { handled: true, reply: await handleRemind(payload, ctx) };
    default:
      return { handled: false, reply: null };
  }
}

module.exports = {
  handleMessage,
  // utilidades expostas se precisar no futuro
  _internals: { bootstrap, readJson, writeJson, addActivity, parseRemindPayload, parseSetupPayload }
};
