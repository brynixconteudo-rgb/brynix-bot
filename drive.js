// drive.js
// Uploads no Google Drive usando OAuth (conta do usuário).
// Requer envs: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN
// Opcional: GOOGLE_OAUTH_REDIRECT_URI (default: http://localhost)

const { google } = require('googleapis');
const { Readable } = require('stream');

function getOAuthClient() {
  const {
    GOOGLE_OAUTH_CLIENT_ID: clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
    GOOGLE_OAUTH_REFRESH_TOKEN: refreshToken,
    GOOGLE_OAUTH_REDIRECT_URI: redirectUri = 'http://localhost',
  } = process.env;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Faltam envs do OAuth (CLIENT_ID/SECRET/REFRESH_TOKEN).');
  }

  const oAuth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oAuth2.setCredentials({ refresh_token: refreshToken });
  return oAuth2;
}

function driveClient() {
  return google.drive({ version: 'v3', auth: getOAuthClient() });
}

async function findFolderByName(name, parentId) {
  const drive = driveClient();
  const qParts = [
    `mimeType='application/vnd.google-apps.folder'`,
    `name='${name.replace(/'/g, "\\'")}'`,
    'trashed=false',
  ];
  if (parentId) qParts.push(`'${parentId}' in parents`);
  const q = qParts.join(' and ');

  const { data } = await drive.files.list({
    q,
    fields: 'files(id, name)',
    pageSize: 1,
    supportsAllDrives: false,
  });
  return (data.files && data.files[0]) || null;
}

async function createFolder(name, parentId) {
  const drive = driveClient();
  const fileMetadata = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: parentId ? [parentId] : undefined,
  };
  const { data } = await drive.files.create({
    requestBody: fileMetadata,
    fields: 'id, name',
    supportsAllDrives: false,
  });
  return data;
}

async function ensureFolderPath(pathArr) {
  // Garante que exista "pathArr[0]/pathArr[1]/..."
  let parentId = null;
  for (const segment of pathArr) {
    let folder = await findFolderByName(segment, parentId);
    if (!folder) folder = await createFolder(segment, parentId);
    parentId = folder.id;
  }
  return parentId; // id da última pasta
}

async function ensureProjectTree(projectName) {
  // Raiz -> "Documentos de Projeto" -> "{projectName}" -> subpastas
  const root = await ensureFolderPath(['Documentos de Projeto', projectName]);
  const subfolders = ['Insumos', 'Saídas', 'Anexos'];
  for (const s of subfolders) {
    await ensureFolderPath(['Documentos de Projeto', projectName, s]);
  }
  return { projectRootId: root };
}

// Helper: converte Buffer para stream aceitável pelo Drive API
function bufferToStream(buffer) {
  return Readable.from(buffer);
}

async function uploadBufferToProject(buffer, filename, mimeType, projectName, subfolder = 'Anexos') {
  if (!projectName) throw new Error('projectName ausente para upload.');

  const { projectRootId } = await ensureProjectTree(projectName);
  const targetFolderId = await ensureFolderPath(['Documentos de Projeto', projectName, subfolder]);

  const drive = driveClient();
  const media = {
    mimeType: mimeType || 'application/octet-stream',
    body: bufferToStream(buffer),
  };

  const fileMetadata = {
    name: filename || 'arquivo',
    parents: [targetFolderId],
  };

  const { data } = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id, name, webViewLink, webContentLink',
    supportsAllDrives: false,
  });

  // Por padrão, fica restrito ao seu Drive (sem compartilhar publicamente).
  return data; // { id, name, webViewLink, webContentLink }
}

module.exports = {
  ensureProjectTree,
  uploadBufferToProject,
};
