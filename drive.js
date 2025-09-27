// drive.js (ADICIONE estes helpers ao seu arquivo existente)

const { google } = require('googleapis');

function getDrive() {
  const raw = process.env.GOOGLE_SA_JSON;
  if (!raw) throw new Error('GOOGLE_SA_JSON ausente.');
  const sa = JSON.parse(raw.replace(/\n/g, '\\n'));
  const jwt = new google.auth.JWT(
    sa.client_email, null, sa.private_key,
    ['https://www.googleapis.com/auth/drive']
  );
  return google.drive({ version: 'v3', auth: jwt });
}

async function ensureFolder(name, parentId) {
  const drive = getDrive();
  const q = `'${parentId}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const { data } = await drive.files.list({ q, fields: 'files(id,name)' });
  if (data.files?.length) return data.files[0].id;

  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id,name',
  });
  return res.data.id;
}

/**
 * Sobe um Buffer dentro da pasta do projeto, criando subpasta se necessário.
 * @param {object} link { sheetId, projectName, driveProjectFolderId? }
 * @param {string} subfolder ex: 'Resumos/Diario'
 * @param {string} filename ex: '2025-09-26-Diario.ogg'
 * @param {string} mime 'audio/ogg' | 'text/markdown'
 * @param {Buffer} buf
 * @returns url público (se compartilhado) ou webViewLink
 */
async function uploadBufferToProject(link, subfolder, filename, mime, buf) {
  // Você já deve ter uma forma de obter/guardar a pasta raiz do projeto.
  // Caso ainda não tenha, reaproveite o local onde salva anexos do grupo.
  // Aqui assumo que há env DRIVE_ROOT_FOLDER_ID (pasta “Documentos do Projeto”).
  const ROOT = process.env.DRIVE_ROOT_FOLDER_ID;
  if (!ROOT) throw new Error('DRIVE_ROOT_FOLDER_ID ausente.');

  const drive = getDrive();

  const projectFolder = await ensureFolder(link.projectName, ROOT);

  // subpastas encadeadas (ex.: "Resumos/Semanal")
  let parentId = projectFolder;
  if (subfolder) {
    const parts = subfolder.split('/').filter(Boolean);
    for (const p of parts) parentId = await ensureFolder(p, parentId);
  }

  const media = { mimeType: mime, body: Buffer.isBuffer(buf) ? buf : Buffer.from(buf) };
  const file = await drive.files.create({
    requestBody: { name: filename, parents: [parentId] },
    media,
    fields: 'id, name, webViewLink, webContentLink',
  });
  return file.data.webViewLink || file.data.webContentLink;
}

module.exports = {
  // ... exporte aqui também as funções antigas que você já tinha
  uploadBufferToProject,
};
