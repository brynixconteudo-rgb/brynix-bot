// sheets.js
// Acesso ao Google Sheets usando Service Account JSON (env GOOGLE_SA_JSON).
// Helpers para: resolver ID, ler metadados do projeto, ler tarefas e montar um resumo executivo.

const { google } = require('googleapis');

/* --------------------------- Auth / Cliente --------------------------- */

function parseServiceAccount() {
  const raw = process.env.GOOGLE_SA_JSON || '';
  if (!raw) throw new Error('GOOGLE_SA_JSON ausente.');
  try {
    // formato JSON “compacto”
    return JSON.parse(raw);
  } catch {
    // se colaram com quebras, normaliza \n
    return JSON.parse(raw.replace(/\n/g, '\\n'));
  }
}

function buildSheetsClient(scope = 'https://www.googleapis.com/auth/spreadsheets.readonly') {
  const sa = parseServiceAccount();
  const jwt = new google.auth.JWT(sa.client_email, null, sa.private_key, [scope]);
  return google.sheets({ version: 'v4', auth: jwt });
}

/* --------------------------- Utilidades --------------------------- */

function extractSheetId(urlOrId) {
  if (!urlOrId) return null;
  const m = String(urlOrId).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m && m[1]) return m[1];
  // se já vier o ID puro:
  if (/^[a-zA-Z0-9-_]{20,}$/.test(urlOrId)) return urlOrId;
  return null;
}

function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function parseDateMaybe(s) {
  if (!s) return '';
  // aceita dd/mm/yyyy
  const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) {
    const [_, d, mo, y] = m;
    const dt = new Date(+y, +mo - 1, +d);
    return isNaN(dt.getTime()) ? s : dt.toISOString().slice(0, 10);
  }
  return s; // devolve cru se não reconhecer
}

/* --------------------------- Leituras --------------------------- */

async function readProjectMeta(sheetId) {
  const sheets = buildSheetsClient();
  // A1:B10 para aba Dados_Projeto (chave | valor)
  const meta = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Dados_Projeto!A1:B10',
  });
  const rows = meta.data.values || [];
  const obj = {};
  rows.forEach(([k, v]) => {
    if (k) obj[String(k).trim()] = (v || '').toString().trim();
  });
  // Ex.: { ProjectName, GroupId, Timezone, DailyReminderTime, ... }
  return obj;
}

async function readTasks(sheetId) {
  const sheets = buildSheetsClient();
  // Cabeçalho esperado (pode ter acento/variações):
  // Tarefa | Prioridade | Responsável | Status | Data de início | Data de término | Marco | Produtos | Observações
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Tarefas!A1:K1000',
  });

  const rows = resp.data.values || [];
  if (rows.length < 2) return [];

  const header = rows[0].map((h) => norm(h));
  // tolera acentos/variações
  const idx = {
    tarefa: header.indexOf('tarefa'),
    prioridade: header.indexOf('prioridade'),
    responsavel:
      header.indexOf('responsavel') !== -1
        ? header.indexOf('responsavel')
        : header.indexOf('responsável'),
    status: header.indexOf('status'),
    dtini:
      header.indexOf('data de inicio') !== -1
        ? header.indexOf('data de inicio')
        : header.indexOf('data de início'),
    dtfim:
      header.indexOf('data de termino') !== -1
        ? header.indexOf('data de termino')
        : header.indexOf('data de término'),
    marco: header.indexOf('marco'),
    produtos: header.indexOf('produtos'),
    obs:
      header.indexOf('observacoes') !== -1
        ? header.indexOf('observacoes')
        : header.indexOf('observações'),
  };

  const tasks = rows
    .slice(1)
    .map((r) => ({
      tarefa: (idx.tarefa >= 0 && r[idx.tarefa]) || '',
      prioridade: (idx.prioridade >= 0 && r[idx.prioridade]) || '',
      responsavel: (idx.responsavel >= 0 && r[idx.responsavel]) || '',
      status: (idx.status >= 0 && r[idx.status]) || '',
      dataInicio: parseDateMaybe(idx.dtini >= 0 && r[idx.dtini] ? r[idx.dtini] : ''),
      dataTermino: parseDateMaybe(idx.dtfim >= 0 && r[idx.dtfim] ? r[idx.dtfim] : ''),
      marco: (idx.marco >= 0 && r[idx.marco]) || '',
      produtos: (idx.produtos >= 0 && r[idx.produtos]) || '',
      observacoes: (idx.obs >= 0 && r[idx.obs]) || '',
    }))
    .filter((t) => t.tarefa);

  return tasks;
}

/* --------------------------- Resumo executivo --------------------------- */

function buildStatusSummary(projectName, tasks) {
  const title = projectName || 'Projeto';
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
  const abertas = tasks.filter((t) => !/conclu(i|í)da/i.test(t.status || ''));

  const preview = abertas
    .slice(0, 10)
    .map((t) => `- ${t.tarefa} (${t.responsavel || 's/resp'})`)
    .join('\n') || 'Nenhuma aberta.';

  return (
    `*${title} — Status*\n` +
    `Total de tarefas: ${total}\n` +
    `${topStatuses || '• (sem distribuição)'}\n\n` +
    `*Abertas (amostra):*\n${preview}`
  );
}

/* --------------------------- Export --------------------------- */

module.exports = {
  extractSheetId,
  readProjectMeta,
  readTasks,
  buildStatusSummary,
};
