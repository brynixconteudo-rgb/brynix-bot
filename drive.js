// drive.js
// Upload de anexos para Google Drive usando Service Account (GOOGLE_SA_JSON).
// Requer também configurar GOOGLE_DRIVE_ROOT_FOLDER_ID (pasta "Projetos" compartilhada com a SA).

const { google } = require('googleapis');

function parseServiceAccount() {
  const raw = process.env.GOOGLE_SA_JSON || '';
  if (!raw) throw new Error('GOOGLE_SA_JSON ausente.');
  try {
    return JSON.parse(raw);
  } catch (e) {
    return JSON.parse(raw.replace(/\n/g, '\\n'));
  }
}

function buildDriveClient() {
  const sa = parseServiceAccount();
  const jwt = new google.auth.JWT(
    sa.client_email,
    null,
    sa.private_key,
    ['https://www.googleapis.com/auth/drive']
  );
  return google.drive({ version: 'v3', auth: jwt });
}

/**
 * Cria/retorna o ID de uma subpasta (por nome) dentro de parentId.
 */
async function ensureFolder(drive, name, parentId) {
  // procura pasta existente
  const q = [
    `'${parentId}' in parents`,
    `name = '${name.replace(/'/g, "\\'")}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    'trashed = false'
  ].join(' and ');

  const { data } = await drive.files.list({ q, fields: 'files(id, name)', pageSize: 1 });
  if (data.files && data.files.length) return data.files[0].id;

  // cria se não existir
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id, name'
  });
  return res.data.id;
}

/**
 * Garante a estrutura: /<ROOT>/Projetos/<ProjectName>/Arquivos/<YYYY-MM>
 * Retorna o ID da pasta <YYYY-MM>.
 */
async function ensureProjectMonthFolder(projectName) {
  const rootId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!rootId) throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID ausente.');

  const drive = buildDriveClient();

  const projRootId   = await ensureFolder(drive, 'Projetos', rootId);
  const projectId    = await ensureFolder(drive, projectName || 'Projeto', projRootId);
  const arquivosId   = await ensureFolder(drive, 'Arquivos', projectId);

  const d = new Date();
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const monthFolder = `${yyyy}-${mm}`;

  const monthId = await ensureFolder(drive, monthFolder, arquivosId);
  return { drive, folderId: monthId };
}

/**
 * Faz upload de um buffer para a pasta do mês do projeto.
 * Retorna { fileId, webViewLink, webContentLink }.
 */
async function uploadBuffer({ projectName, filename, mimetype, buffer }) {
  if (!buffer || !buffer.length) throw new Error('Buffer vazio no upload.');
  const { drive, folderId } = await ensureProjectMonthFolder(projectName);

  const res = await drive.files.create({
    requestBody: {
      name: filename || 'arquivo',
      mimeType: mimetype || 'application/octet-stream',
      parents: [folderId],
    },
    media: {
      mimeType: mimetype || 'application/octet-stream',
      body: Buffer.isBuffer(buffer) ? require('stream').Readable.from(buffer) : buffer,
    },
    fields: 'id, name, webViewLink, webContentLink'
  });

  // Define permissão de leitura via link (opcional — comente se não quiser link público)
  try {
    await drive.permissions.create({
      fileId: res.data.id,
      requestBody: { role: 'reader', type: 'anyone' }
    });
  } catch (_) {
    // silencio — em domínios com restrições pode falhar, mas o owner ainda acessa
  }

  // re-obtem links após permissão
  const { data: file } = await drive.files.get({
    fileId: res.data.id,
    fields: 'id, webViewLink, webContentLink'
  });

  return {
    fileId: file.id,
    webViewLink: file.webViewLink,
    webContentLink: file.webContentLink
  };
}

module.exports = {
  uploadBuffer,
};
