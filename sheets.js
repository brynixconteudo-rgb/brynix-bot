// sheets.js
// Acesso ao Google Sheets usando Service Account JSON (env GOOGLE_SA_JSON).
// Helpers: resolver ID, ler metadados, listar tarefas, ler config de projeto.

const { google } = require('googleapis');

function parseServiceAccount() {
  const raw = process.env.GOOGLE_SA_JSON || '';
  if (!raw) throw new Error('GOOGLE_SA_JSON ausente.');
  try { return JSON.parse(raw); }
  catch {
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
  if (/^[a-zA-Z0-9-_]{20,}$/.test(urlOrId)) return urlOrId;
  return null;
}

async function readProjectMeta(sheetId) {
  const sheets = buildSheetsClient();
  const meta = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Dados_Projeto!A1:B200',
  });
  const rows = meta.data.values || [];
  const obj = {};
  rows.forEach(([k, v]) => {
    if (!k) return;
    obj[String(k).trim()] = (v || '').toString().trim();
  });
  return obj;
}

async function readProjectConfig(sheetId) {
  const m = await readProjectMeta(sheetId);
  const cfg = {
    ProjectName: m.ProjectName || 'Projeto',
    Timezone: m.Timezone || 'America/Sao_Paulo',
    DailyReminderTime: (m.DailyReminderTime || '09:00').replace(/\s/g, ''),
    WeeklyWrap: (m.WeeklyWrap || 'FRI 17:30').replace(/\s/g, ' '),
    QuietHours: (m.QuietHours || '20:00-08:00').replace(/\s/g, ''),
    ProjectObjectives: m.ProjectObjectives || '',
    ProjectBenefits: m.ProjectBenefits || '',
    ProjectTimeline: m.ProjectTimeline || '',
    TTS_Enabled: /^true$/i.test(m.TTS_Enabled || ''),
    TTS_Voice: m.TTS_Voice || 'pt-BR-Neural2-A',
    MentionsEnabled: /^true$/i.test(m.MentionsEnabled || ''),
  };
  return cfg;
}

async function readTasks(sheetId) {
  const sheets = buildSheetsClient();
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
  const B = s => `*${s}*`;
  const I = s => `_${s}_`;

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

  const abertas = tasks
    .filter(t => !/conclu(i|í)da/i.test(t.status || ''))
    .slice(0, 10);
  const preview = abertas
    .map(t => `- ${t.tarefa} (${t.responsavel || 's/resp'})`)
    .join('\n') || 'Nenhuma aberta.';

  return `${B(`${projectName || 'Projeto'} — Status`)}

Total de tarefas: ${total}
${topStatuses}

${B('Abertas (amostra):')}
${preview}`;
}

module.exports = {
  extractSheetId,
  readProjectMeta,
  readProjectConfig,
  readTasks,
  buildStatusSummary,
};
