// gp.js
// "Modo GP": lê a planilha, gera lembretes diários e publica no grupo do projeto.

const { google } = require('googleapis');

/* ========= Helpers: autenticação Google Sheets ========= */

function getSheetsClient() {
  const sa = process.env.GOOGLE_SA_JSON;
  if (!sa) {
    throw new Error('GOOGLE_SA_JSON ausente nas variáveis de ambiente.');
  }
  const creds = JSON.parse(sa);

  const jwt = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth: jwt });
}

async function readRange(sheets, spreadsheetId, rangeA1) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: rangeA1,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return resp.data.values || [];
}

/* ========= Helpers: datas e horário local por timezone ========= */

function nowPartsInTZ(timezone) {
  const dt = new Date();
  // cria string YYYY-MM-DD e HH:mm no timezone indicado sem libs extras
  const dateStr = dt.toLocaleDateString('en-CA', { timeZone: timezone }); // 2025-09-21
  const hm = dt
    .toLocaleTimeString('pt-BR', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    .replace(':', ':'); // HH:mm
  return { dateStr, hm };
}

/* ========= Parse de "Dados_Projeto" ========= */

function parseConfigFromDadosProjeto(rows) {
  // Espera algo como:
  // A1: "ProjectName" | B1: Nome
  // A2: "GroupId"     | B2: 1203...@g.us
  // A3: "Timezone"    | B3: America/Sao_Paulo
  // A4: "DailyReminderTime" | B4: 09:00
  const map = new Map();
  for (const r of rows) {
    if (!r || r.length < 2) continue;
    const key = String(r[0] || '').trim();
    const val = String(r[1] || '').trim();
    if (key) map.set(key, val);
  }
  return {
    projectName: map.get('ProjectName') || 'Projeto',
    groupId: map.get('GroupId') || '',
    timezone: map.get('Timezone') || 'America/Sao_Paulo',
    reminderTime: map.get('DailyReminderTime') || '09:00',
  };
}

/* ========= Parse de "Tarefas" ========= */

function normalizeStr(s) {
  return String(s || '').trim();
}

function parseDateBR(s) {
  // aceita dd/mm/yyyy ou vazio
  const str = normalizeStr(s);
  if (!str || !str.includes('/')) return null;
  const [dd, mm, yyyy] = str.split('/');
  if (!dd || !mm || !yyyy) return null;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  return isNaN(d.getTime()) ? null : d;
}

function formatDateBR(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function parseTarefas(rows) {
  // Cabeçalho esperado (exemplo):
  // [ "Tarefa", "Prioridade", "Responsável", "Status", "Data de início", "Data de término", "Marco", "Produtos", "Observações" ]
  if (!rows.length) return { header: [], items: [] };

  const header = rows[0].map(normalizeStr);
  const idx = {
    tarefa: header.indexOf('Tarefa'),
    prioridade: header.indexOf('Prioridade'),
    responsavel: header.indexOf('Responsável'),
    status: header.indexOf('Status'),
    inicio: header.indexOf('Data de início'),
    fim: header.indexOf('Data de término'),
    marco: header.indexOf('Marco'),
    produtos: header.indexOf('Produtos'),
    obs: header.indexOf('Observações'),
  };

  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const item = {
      rowNumber: i + 1, // útil pra futuros updates
      tarefa: normalizeStr(r[idx.tarefa]),
      prioridade: normalizeStr(r[idx.prioridade]),
      responsavel: normalizeStr(r[idx.responsavel]),
      status: normalizeStr(r[idx.status]),
      dataFim: parseDateBR(r[idx.fim]),
      marco: normalizeStr(r[idx.marco]),
      obs: normalizeStr(r[idx.obs]),
    };
    // ignora linhas vazias
    if (item.tarefa || item.responsavel || item.status) items.push(item);
  }
  return { header, items };
}

/* ========= Composição do lembrete ========= */

function buildReminderMessage(config, tasks, today) {
  const { projectName } = config;

  // define “abertas” (não concluída) e com data fim hoje ou atrasadas
  const pendentes = tasks.filter((t) => {
    const st = t.status.toLowerCase();
    const done = st.includes('conclu');
    if (done) return false;
    if (!t.dataFim) return false;
    const d = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate()
    );
    const df = new Date(t.dataFim.getFullYear(), t.dataFim.getMonth(), t.dataFim.getDate());
    return df <= d; // hoje ou atrasado
  });

  if (!pendentes.length) {
    return [
      `*${projectName}* — lembrete diário ✅`,
      '',
      `Hoje não há tarefas vencendo ou atrasadas. Bom trabalho!`,
    ].join('\n');
  }

  // agrupa por responsável
  const byOwner = new Map();
  for (const t of pendentes) {
    const owner = t.responsavel || '— sem responsável —';
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(t);
  }

  const lines = [];
  lines.push(`*${projectName}* — lembrete diário ⚠️`);
  lines.push('');
  lines.push(`Tarefas vencendo/atrasadas por responsável:`);
  lines.push('');

  for (const [owner, list] of byOwner.entries()) {
    lines.push(`• *${owner}*`);
    for (const t of list) {
      const when = t.dataFim ? formatDateBR(t.dataFim) : '—';
      const prio = t.prioridade || '—';
      lines.push(`  – ${t.tarefa} (fim: ${when}, prioridade: ${prio})`);
    }
    lines.push('');
  }

  lines.push(`Se finalizar algo, me avise com "*concluída <nome da tarefa>*" que atualizo a planilha.`);
  return lines.join('\n');
}

/* ========= Log na aba Atualizacao_LOG ========= */

async function appendLog(sheets, spreadsheetId, who, action, result) {
  const timestamp = new Date().toISOString();
  const row = [[timestamp, who, action, result]];
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Atualizacao_LOG!A:D',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: row },
  });
}

/* ========= GP Runner ========= */

class GP {
  constructor(waClient) {
    this.wa = waClient;
    this.sheets = getSheetsClient();
    this.spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
    if (!this.spreadsheetId) {
      throw new Error('SHEETS_SPREADSHEET_ID ausente nas variáveis de ambiente.');
    }
    this.config = null;
    this._lastReminderDate = null; // "YYYY-MM-DD"
    this._timer = null;
  }

  async loadConfig() {
    // lê A1:B10 de Dados_Projeto
    const dados = await readRange(
      this.sheets,
      this.spreadsheetId,
      'Dados_Projeto!A1:B10'
    );
    this.config = parseConfigFromDadosProjeto(dados);
    if (!this.config.groupId) {
      console.warn('[GP] Atenção: GroupId não definido em Dados_Projeto (B2).');
    }
    return this.config;
  }

  async readTasks() {
    const rows = await readRange(
      this.sheets,
      this.spreadsheetId,
      'Tarefas!A1:Z1000'
    );
    const { items } = parseTarefas(rows);
    return items;
  }

  _timeMatches(nowHM, reminderHM) {
    // aceita uma janela de 2 minutos (ex.: 09:00, 09:01) pra garantir disparo
    return nowHM === reminderHM || nowHM === addMinute(reminderHM, 1);
    function addMinute(hm, add) {
      const [h, m] = hm.split(':').map((n) => parseInt(n, 10));
      const d = new Date(2000, 0, 1, h, m + add, 0);
      return `${String(d.getHours()).padStart(2, '0')}:${String(
        d.getMinutes()
      ).padStart(2, '0')}`;
    }
  }

  async tick() {
    try {
      if (!this.config) await this.loadConfig();

      const { timezone, reminderTime, projectName, groupId } = this.config;
      const { dateStr, hm } = nowPartsInTZ(timezone);

      // dispara uma vez por dia, na janela do horário
      if (this._lastReminderDate === dateStr) return;
      if (!this._timeMatches(hm, reminderTime)) return;

      const tasks = await this.readTasks();
      const msg = buildReminderMessage(this.config, tasks, new Date());

      if (groupId) {
        await this.wa.sendMessage(groupId, msg);
        await appendLog(
          this.sheets,
          this.spreadsheetId,
          'BOT',
          'DailyReminder',
          `Enviado para ${groupId}`
        );
        console.log('[GP] Lembrete enviado para o grupo.');
      } else {
        console.warn('[GP] Não foi possível enviar (GroupId vazio).');
        await appendLog(
          this.sheets,
          this.spreadsheetId,
          'BOT',
          'DailyReminder',
          'Falhou: GroupId vazio'
        );
      }

      this._lastReminderDate = dateStr;
    } catch (err) {
      console.error('[GP] Erro no tick:', err?.message || err);
      try {
        await appendLog(
          this.sheets,
          this.spreadsheetId,
          'BOT',
          'DailyReminder',
          `Erro: ${err?.message || err}`
        );
      } catch (_) {}
    }
  }

  start() {
    if (this._timer) clearInterval(this._timer);
    // roda a cada 60s
    this._timer = setInterval(() => this.tick(), 60 * 1000);
    console.log('[GP] Agendador iniciado (checagem a cada 60s).');
  }
}

/* ========= API pública ========= */

let gpInstance = null;

async function initGP(waClient) {
  if (gpInstance) return gpInstance;
  gpInstance = new GP(waClient);
  await gpInstance.loadConfig().catch((e) =>
    console.warn('[GP] Aviso ao carregar config:', e?.message || e)
  );
  gpInstance.start();
  return gpInstance;
}

module.exports = { initGP };
