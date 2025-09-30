// sheets.js
// Acesso ao Google Sheets usando Service Account JSON da env GOOGLE_SA_JSON.
// Helpers: meta do projeto, tarefas, recursos, logging e utilidades.

const { google } = require('googleapis');

function parseServiceAccount() {
  const raw = process.env.GOOGLE_SA_JSON || '';
  if (!raw) throw new Error('GOOGLE_SA_JSON ausente.');
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(raw.replace(/\n/g, '\\n'));
  }
}

function buildSheetsClient() {
  const sa = parseServiceAccount();
  const jwt = new google.auth.JWT(
    sa.client_email,
    null,
    sa.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
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

/* ===================== Metadados ===================== */

async function readProjectMeta(sheetId) {
  const sheets = buildSheetsClient();
  const meta = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Dados_Projeto!A1:B50',
  });
  const rows = meta.data.values || [];
  const obj = {};
  rows.forEach(([k, v]) => {
    if (!k) return;
    obj[String(k).trim()] = (v || '').toString().trim();
  });
  return obj; // { ProjectName, GroupId, Timezone, DailyReminderTime, WeeklyWrap, QuietHours, ... }
}

async function writeMeta(sheetId, key, value) {
  const sheets = buildSheetsClient();
  // procura linha do key e escreve na coluna B
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Dados_Projeto!A1:B50',
  });
  const rows = resp.data.values || [];
  let rowIndex = rows.findIndex(r => (r[0] || '').trim() === key);
  if (rowIndex < 0) rowIndex = rows.length;
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Dados_Projeto!B${rowIndex + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] },
  });
}

async function saveGroupId(sheetId, groupId) {
  return writeMeta(sheetId, 'GroupId', groupId);
}

/* ===================== Recursos ===================== */

async function readResources(sheetId) {
  const sheets = buildSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Rec_Projeto!A1:E1000', // Nome | Função | Contato | Status | ...
  });
  const rows = resp.data.values || [];
  if (rows.length < 2) return [];
  const header = rows[0].map(h => (h || '').toString().trim().toLowerCase());
  const idx = {
    nome: header.indexOf('nome'),
    funcao: header.indexOf('função') >= 0 ? header.indexOf('função') : header.indexOf('funcao'),
    contato: header.indexOf('contato'),
    status: header.indexOf('status'),
  };
  return rows.slice(1).map(r => ({
    nome: r[idx.nome] || '',
    funcao: r[idx.funcao] || '',
    contato: r[idx.contato] || '',
    status: r[idx.status] || '',
  })).filter(x => x.nome);
}

/* ===================== Tarefas ===================== */

function parseBRDate(s) {
  const m = (s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const d = +m[1], mo = +m[2]-1, y = +m[3] + (m[3].length===2?2000:0);
  return new Date(y, mo, d);
}

async function readTasks(sheetId) {
  const sheets = buildSheetsClient();
  // Esperado: Tarefa | Prioridade | Responsável | Status | Data de início | Data de término | Marco | Observações
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Tarefas!A1:K2000',
  });
  const rows = resp.data.values || [];
  if (rows.length < 2) return [];

  const header = rows[0].map(h => (h || '').toString().trim().toLowerCase());
  const idx = {
    tarefa: header.indexOf('tarefa'),
    prioridade: header.indexOf('prioridade'),
    responsavel: header.indexOf('responsável') >= 0 ? header.indexOf('responsável') : header.indexOf('responsavel'),
    status: header.indexOf('status'),
    dtini: header.indexOf('data de início'),
    dtfim: header.indexOf('data de término'),
    marco: header.indexOf('marco'),
    obs: header.indexOf('observações') >=0 ? header.indexOf('observações') : header.indexOf('observacoes'),
  };

  return rows.slice(1).map(r => {
    const dataInicio = r[idx.dtini] || '';
    const dataTermino = r[idx.dtfim] || '';
    return {
      tarefa: r[idx.tarefa] || '',
      prioridade: r[idx.prioridade] || '',
      responsavel: r[idx.responsavel] || '',
      status: r[idx.status] || '',
      dataInicio,
      dataTermino,
      dtIniDate: parseBRDate(dataInicio),
      dtFimDate: parseBRDate(dataTermino),
      marco: r[idx.marco] || '',
      observacoes: r[idx.obs] || '',
    };
  }).filter(t => t.tarefa);
}

/* ===================== LOG ===================== */

async function appendLog(sheetId, payload) {
  // Aba: Atualizacao_LOG => Timestamp | Tipo | Autor | Mensagem | Arquivo | Link_GDrive | Observações
  const sheets = buildSheetsClient();
  const ts = new Date().toISOString();
  const row = [
    ts,
    payload.tipo || '',
    payload.autor || '',
    payload.msg || '',
    payload.arquivo || '',
    payload.link || '',
    payload.obs || '',
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Atualizacao_LOG!A1:G1',
    valueInputOption: 'RAW',
    requestBody: { values: [row] },
  });
}

/* ===================== Sumários ===================== */

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

  // Abertas = não concluídas
  const abertas = tasks
    .filter(t => !/conclu(i|í)da/i.test(t.status || ''))
    .slice(0, 10);

  const preview = abertas.map(t => {
    const datas = [];
    if (t.dataInicio) datas.push(`ini ${t.dataInicio}`);
    if (t.dataTermino) datas.push(`fim ${t.dataTermino}`);
    const dat = datas.length ? ` — ${datas.join(' | ')}` : '';
    return `- ${t.tarefa} (${t.responsavel || 's/resp'})${dat}`;
  }).join('\n') || 'Nenhuma aberta.';

  return `*${projectName || 'Projeto'} — Status:*\n` +
         `Total de tarefas: ${total}\n` +
         `${topStatuses}\n\n` +
         `*Abertas (amostra):*\n${preview}`;
}

module.exports = {
  extractSheetId,
  readProjectMeta,
  writeMeta,
  saveGroupId,
  readTasks,
  readResources,
  appendLog,
  buildStatusSummary,
};
