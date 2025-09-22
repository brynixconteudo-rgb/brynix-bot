// sheets-test.js - teste rápido de acesso à planilha via Service Account
const { google } = require('googleapis');

(async () => {
  try {
    const saJson = process.env.GOOGLE_SA_JSON;
    const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;

    if (!saJson) {
      throw new Error('Env GOOGLE_SA_JSON ausente.');
    }
    if (!spreadsheetId) {
      throw new Error('Env SHEETS_SPREADSHEET_ID ausente.');
    }

    const credentials = JSON.parse(saJson);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets.readonly',
        'https://www.googleapis.com/auth/drive.readonly',
      ],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    console.log('🔎 Testando acesso à planilha...', spreadsheetId);

    // 1) Lista as abas
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const tabs = (meta.data.sheets || []).map(s => s.properties?.title);
    console.log('📑 Abas encontradas:', tabs);

    // 2) Amostra dos dados da aba Dados_Projeto
    try {
      const resProj = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Dados_Projeto!A1:B10',
      });
      console.log('🧩 Dados_Projeto (A1:B10):', resProj.data.values || []);
    } catch (e) {
      console.log('ℹ️ Não consegui ler Dados_Projeto!A1:B10 (confira o nome da aba e intervalo).');
    }

    // 3) Amostra da aba Tarefas
    try {
      const resTasks = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Tarefas!A1:K6',
      });
      console.log('🧱 Tarefas (A1:K6):');
      console.table(resTasks.data.values || []);
    } catch (e) {
      console.log('ℹ️ Não consegui ler Tarefas!A1:K6 (confira o nome da aba e intervalo).');
    }

    console.log('✅ TESTE OK');
    process.exit(0);
  } catch (err) {
    console.error('❌ TESTE FALHOU:', err?.response?.data || err);
    process.exit(1);
  }
})();
