// drive.js
// Upload de anexos do WhatsApp para o Google Drive usando OAuth (usuário).
// Suporta DOIS conjuntos de variáveis de ambiente (novas e antigas):
//
// Novas (recomendadas):
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REFRESH_TOKEN
//   GOOGLE_DRIVE_ROOT_FOLDER_ID
//   (opcional) GOOGLE_OAUTH_REDIRECT_URI
//
// Antigas (legacy):
//   DRIVE_CLIENT_ID
//   DRIVE_CLIENT_SECRET
//   DRIVE_REFRESH_TOKEN
//   DRIVE_ROOT_FOLDER_ID
//
// Exporta: saveIncomingMediaToDrive(client, msg, link)
//   link = { sheetId, projectName }

const { google } = require('googleapis');
const { Readable } = require('stream');

function pickEnv(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim()) return v;
  }
  return '';
}

function buildOAuthDrive() {
  const CLIENT_ID = pickEnv('GOOGLE_OAUTH_CLIENT_ID', 'DRIVE_CLIENT_ID');
  const CLIENT_SECRET = pickEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'DRIVE_CLIENT_SECRET');
  const REFRESH_TOKEN = pickEnv('GOOGLE_OAUTH_REFRESH_TOKEN', 'DRIVE_REFRESH_TOKEN');
  const REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';

  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    console.warn('[DRIVE] Variáveis ausentes para OAuth (CLIENT_ID/SECRET/REFRESH_TOKEN). Upload será ignorado.');
    return null;
  }

  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth: oAuth2Client });
}

async function ensureFolder(drive, parentId, name) {
  // Procura pasta pelo nome dentro do parent
  const q = [
    `'${parentId}' in parents`,
    `name = '${name.replace(/'/g, "\\'")}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    'trashed = false'
  ].join(' and ');

  const res = await drive.files.list({
    q,
    fields: 'files(id, name)',
    pageSize: 1
  });

  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  // cria
  const folder = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    },
    fields: 'id, name'
  });

  return folder.data.id;
}

function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

async function uploadBuffer(drive, parentId, name, mimeType, buffer) {
  const res = await drive.files.create({
    requestBody: {
      name,
      parents: [parentId]
    },
    media: {
      mimeType,
      body: bufferToStream(buffer)
    },
    fields: 'id, name, webViewLink, webContentLink'
  });
  return res.data;
}

async function saveIncomingMediaToDrive(client, msg, link) {
  try {
    const drive = buildOAuthDrive();
    if (!drive) {
      console.warn('[DRIVE] Sem configuração de OAuth; upload ignorado.');
      return null;
    }

    const ROOT_ID = pickEnv('GOOGLE_DRIVE_ROOT_FOLDER_ID', 'DRIVE_ROOT_FOLDER_ID');
    if (!ROOT_ID) {
      console.warn('[DRIVE] ROOT_FOLDER_ID ausente; defina GOOGLE_DRIVE_ROOT_FOLDER_ID (ou DRIVE_ROOT_FOLDER_ID).');
      return null;
    }

    // Baixa mídia do WhatsApp
    if (!msg.hasMedia) return null;
    const media = await msg.downloadMedia(); // { data (base64), mimetype, filename? }
    if (!media || !media.data) return null;

    const buf = Buffer.from(media.data, 'base64');
    const mime = media.mimetype || 'application/octet-stream';

    // Nome do arquivo
    const ts = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}_${pad(ts.getHours())}-${pad(ts.getMinutes())}-${pad(ts.getSeconds())}`;
    const baseName = media.filename || `anexo_${stamp}`;
    const safeName = baseName.replace(/[\\/:*?"<>|]/g, '_');

    // Estrutura de pastas: ROOT -> <Projeto> -> "Documentos de Projeto"
    const projectName = (link?.projectName || 'Projeto').trim();
    const projectFolderId = await ensureFolder(drive, ROOT_ID, projectName);
    const docsFolderId = await ensureFolder(drive, projectFolderId, 'Documentos de Projeto');

    const file = await uploadBuffer(drive, docsFolderId, safeName, mime, buf);

    // Link de visualização
    const url = file.webViewLink || file.webContentLink || `https://drive.google.com/file/d/${file.id}/view`;
    return { id: file.id, url };
  } catch (e) {
    console.error('[DRIVE] erro upload:', e?.message || e);
    return null;
  }
}

module.exports = { saveIncomingMediaToDrive };
