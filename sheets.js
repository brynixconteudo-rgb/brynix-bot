// sheets.js
// Integração com Google Sheets (Service Account) para ler/escrever
// - Lê metadados do projeto (aba: Dados_Projeto)
// - Lê tarefas (aba: Tarefas)
// - Escreve LOG (aba: Atualizacao_LOG)

const { google } = require('googleapis');

// ===== Helpers =====
function stripAccents(s = '') {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function parseServiceAccount() {
  const raw = process.env.GOOGLE_SA_JSON || '';
  if (!raw) throw new Error('GOOGLE_SA_JSON ausente.');
  try {
    return JSON.parse(raw);
  } catch {
    // caso cole o JSON com quebras
    return JSON.parse(raw.replace(/\n/g, '\\n'));
  }
}

function buildSheetsClient(write = false) {
  const sa = parseServiceAccount();
  const scopes = write
    ? [
        'https://www.googleapis.com/auth/spreadsheets', // leitura + escrita
      ]
    : [
        'https://www.googleapis.com/auth/spreadsheets.readonly', // só leitura
      ];

  const jwt = new google.auth.JWT(sa.client_email, null, sa.private_key, scopes);
  return google.sheets({ version: 'v4', auth: jwt });
}

function extractSheetId(urlOrId) {
  if (!urlOrId) return null;
  const m = String(urlOrId).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m && m[1]) return m[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(urlOrId)) return urlOrId;
  return null;
}

// ===== Leitura dos metadados =====
async function readProjectMeta(sheetId) {
  const sheets = buildSheetsClient(false);
  const meta = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Dados_Projeto!A1:B10',
  });

  const rows = meta.data.values || [];
  const obj = {};
  rows.forEach(([k, v]) => {
    if (k) obj[String(k).trim()] = (v || '').toString().trim();
  });
  return obj; // { ProjectName, GroupId, Timezone, DailyReminderTime, ... }
}

// ===== Leitura de tarefas =====
async function readTasks(sheetId) {
  const sheets = buildSheetsClient(false);
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Tarefas!A1:K2000',
  });

  const rows = resp.data.values || [];
  if (rows.length < 2) return [];

  const headerNorm = rows[0].map(h => stripAccents(h || ''));

  const find = (label) => headerNorm.indexOf(label);
  // Suportamos acentos/variações
  const idx = {
    tarefa:         find('tarefa'),
    prioridade:     find('prioridade'),
    responsavel:    find('responsavel'),
    status:         find('status'),
    dtini:          find('data de inicio'),
    dtfim:          find('data de termino'),
    marco:          find('marco'),
    produtos:       find('produtos'),
    observacoes:    find('observacoes'),
  };

  const tasks = rows.slice(1).map(r => ({
    tarefa:       (r[idx.tarefa] || '').toString().trim(),
    prioridade:   (r[idx.prioridade] || '').toString().trim(),
    responsavel:  (r[idx.responsavel] || '').toString().trim(),
    status:       (r[idx.status] || '').toString().trim(),
    dataInicio:   (r[idx.dtini] || '').toString().trim(),
    dataTermino:  (r[idx.dtfim] || '').toString().trim(),
    marco:        (r[idx.marco] || '').toString().trim(),
    produtos:     (r[idx.produtos] || '').toString().trim(),
    observacoes:  (r[idx.observacoes] || '').toString().trim(),
  })).filter(t => t.tarefa);

  return tasks;
}

// ===== Sumário de status =====
function buildStatusSummary(projectName, tasks) {
  const total = tasks.length;

  const byStatus = tasks.reduce((acc, t) => {
    const s = (t.status || 'Sem status').trim();
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});
  const linhasStatus = Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `• ${s}: ${n}`)
    .join('\n') || '—';

  // atrasadas: dataTermino < hoje e não concluída
  const hoje = new Date();
  const atrasadas = tasks.filter(t => {
    if (/conclu/i.test(t.status || '')) return false;
    const dt = t.dataTermino?.trim();
    if (!dt) return false;
    // aceita dd/mm/yyyy
    const m = dt.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) return false;
    const d = new Date(+m[3], +m[2]-1, +m[1], 23, 59, 59);
    return d < hoje;
  });

  const topAtrasadas = atrasadas.slice(0, 5)
    .map(t => `- ${t.tarefa} (${t.responsavel || 's/resp'}) [${t.dataTermino || '?'}]`)
    .join('\n') || 'Nenhuma atrasada.';

  const abertas = tasks.filter(t => !/conclu/i.test(t.status || '')).slice(0, 8);
  const previewAbertas = abertas
    .map(t => `- ${t.tarefa} (${t.responsavel || 's/resp'})`)
    .join('\n') || 'Nenhuma aberta.';

  return (
`*${projectName || 'Projeto'} — Status:*
Total de tarefas: *${total}*

*Por status:*
${linhasStatus}

*Em atraso (top 5):*
${topAtrasadas}

*Abertas (amostra):*
${previewAbertas}`
  );
}

// ===== Filtro por responsável =====
async function listTasksByAssignee(sheetId, nome) {
  const tasks = await readTasks(sheetId);
  const alvo = stripAccents(nome || '');
  const filtradas = tasks.filter(t =>
    stripAccents(t.responsavel || '').includes(alvo)
  );
  return filtradas;
}

// ===== LOG: Atualizacao_LOG =====
async function writeLog(sheetId, { timestamp, usuario, acao, resultado, link }) {
  const sheets = buildSheetsClient(true);
  const row = [
    timestamp || new Date().toISOString(),
    usuario || '',
    acao || '',
    resultado || '',
    link || '',
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Atualizacao_LOG!A:E',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

module.exports = {
  extractSheetId,
  readProjectMeta,
  readTasks,
  buildStatusSummary,
  listTasksByAssignee,
  writeLog,
};
