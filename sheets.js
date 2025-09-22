// sheets.js
// Acesso ao Google Sheets usando Service Account JSON da env GOOGLE_SA_JSON.
// Fornece helpers para resolver ID, ler metadados e listar tarefas.

const { google } = require('googleapis');

function parseServiceAccount() {
  const raw = process.env.GOOGLE_SA_JSON || '';
  if (!raw) throw new Error('GOOGLE_SA_JSON ausente.');
  try {
    return JSON.parse(raw);
  } catch (e) {
    // caso alguém cole o JSON “bonito” com quebras, ainda funciona
    return JSON.parse(raw.replace(/\n/g, '\\n'));
  }
}

function buildSheetsClient() {
  const sa = parseServiceAccount();
  const jwt = new google.auth.JWT(
    sa.client_email,
    null,
    sa.private_key,
    ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  );
  return google.sheets({ version: 'v4', auth: jwt });
}

function extractSheetId(urlOrId) {
  if (!urlOrId) return null;
  const m = String(urlOrId).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m && m[1]) return m[1];
  // se já vier o ID puro
  if (/^[a-zA-Z0-9-_]{20,}$/.test(urlOrId)) return urlOrId;
  return null;
}

async function readProjectMeta(sheetId) {
  const sheets = buildSheetsClient();
  // A1:B10 para Dados_Projeto
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

async function readTasks(sheetId) {
  const sheets = buildSheetsClient();
  // Cabeçalho esperado nas colunas: Tarefa | Prioridade | Responsável | Status | Data de início | Data de término | Marco | Produtos | Observações
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Tarefas!A1:K1000',
  });
  const rows = resp.data.values || [];
  if (rows.length < 2) return [];

  const header = rows[0].map(h => (h || '').toString().trim().toLowerCase());
  const idx = {
    tarefa: header.indexOf('tarefa'),
    prioridade: header.indexOf('prioridade'),
    responsavel: header.indexOf('responsável'),
    status: header.indexOf('status'),
    dtini: header.indexOf('data de início'),
    dtfim: header.indexOf('data de término'),
    marco: header.indexOf('marco'),
    obs: header.indexOf('observações'),
  };

  const tasks = rows.slice(1).map(r => ({
    tarefa: r[idx.tarefa] || '',
    prioridade: r[idx.prioridade] || '',
    responsavel: r[idx.responsavel] || '',
    status: r[idx.status] || '',
    dataInicio: r[idx.dtini] || '',
    dataTermino: r[idx.dtfim] || '',
    marco: r[idx.marco] || '',
    observacoes: r[idx.obs] || '',
  })).filter(t => t.tarefa);

  return tasks;
}

function buildStatusSummary(projectName, tasks) {
  const total = tasks.length;
  const byStatus = tasks.reduce((acc, t) => {
    const s = (t.status || 'Sem status').trim();
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});
  const topStatuses = Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `• ${s}: ${n}`)
    .join('\n');

  // abertas = não concluídas
  const abertas = tasks.filter(t => !/conclu(i|í)da/i.test(t.status || '')).slice(0, 10);
  const preview = abertas.map(t => `- ${t.tarefa} (${t.responsavel || 's/resp'})`).join('\n') || 'Nenhuma aberta.';

  return `*${projectName || 'Projeto'} — Status:*\n` +
         `Total de tarefas: ${total}\n` +
         `${topStatuses}\n\n` +
         `*Abertas (amostra):*\n${preview}`;
}

module.exports = {
  extractSheetId,
  readProjectMeta,
  readTasks,
  buildStatusSummary,
};
