// drive.js
// Upload de anexos do WhatsApp para o Google Drive usando OAuth (client ID/secret + refresh token).
// Suporta os dois conjuntos de nomes de variáveis (os seus e os antigos):
//
// Necessários (qualquer um dos pares):
//  - GOOGLE_OAUTH_CLIENT_ID           || DRIVE_CLIENT_ID
//  - GOOGLE_OAUTH_CLIENT_SECRET       || DRIVE_CLIENT_SECRET
//  - GOOGLE_OAUTH_REFRESH_TOKEN       || DRIVE_REFRESH_TOKEN
//  - GOOGLE_DRIVE_ROOT_FOLDER_ID      || DRIVE_ROOT_FOLDER_ID
// Opcionais:
//  - GOOGLE_OAUTH_REDIRECT_URI   (pode ficar em branco)
//
const { google } = require('googleapis');

const OAUTH_CLIENT_ID =
  process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.DRIVE_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET =
  process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.DRIVE_CLIENT_SECRET || '';
const OAUTH_REFRESH_TOKEN =
  process.env.GOOGLE_OAUTH_REFRESH_TOKEN || process.env.DRIVE_REFRESH_TOKEN || '';
const ROOT_FOLDER_ID =
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID || '';
const OAUTH_REDIRECT_URI =
  process.env.GOOGLE_OAUTH_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';

function haveOAuth() {
  return (
    OAUTH_CLIENT_ID &&
    OAUTH_CLIENT_SECRET &&
    OAUTH_REFRESH_TOKEN &&
    ROOT_FOLDER_ID
  );
}

function buildOAuth2Client() {
  const oAuth2Client = new google.auth.OAuth2(
    OAUTH_CLIENT_ID,
    OAUTH_CLIENT_SECRET,
    OAUTH_REDIRECT_URI
  );
  oAuth2Client.setCredentials({ refresh_token: OAUTH_REFRESH_TOKEN });
  return oAuth2Client;
}

function driveClient() {
  const auth = buildOAuth2Client();
  return google.drive({ version: 'v3', auth });
}

async function findFolder(drive, name, parentId) {
  const q = [
    `mimeType='application/vnd.google-apps.folder'`,
    `name='${name.replace(/'/g, "\\'")}'`,
    `trashed=false`
  ];
  if (parentId) q.push(`'${parentId}' in parents`);
  const res = await drive.files.list({
    q: q.join(' and '),
    fields: 'files(id,name,parents)',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true
  });
  return (res.data.files && res.data.files[0]) || null;
}

async function ensureFolder(drive, name, parentId) {
  const existing = await findFolder(drive, name, parentId);
  if (existing) return existing.id;

  const file = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined
    },
    fields: 'id',
    supportsAllDrives: true
  });
  return file.data.id;
}

function extFromMime(mime) {
  if (!mime) return 'bin';
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'video/mp4': 'mp4',
    'text/plain': 'txt'
  };
  return map[mime] || 'bin';
}

/**
 * Salva mídia recebida no grupo para a pasta do projeto no Drive.
 * Estrutura:
 *  ROOT_FOLDER /
 *    <ProjectName> /
 *      Documentos de Projeto /
 *        <arquivo>
 *
 * @param {Client} waClient
 * @param {Message} msg
 * @param {{sheetId: string, projectName: string}} link
 * @returns {Promise<{id: string, url?: string} | null>}
 */
async function saveIncomingMediaToDrive(waClient, msg, link) {
  try {
    if (!haveOAuth()) {
      console.warn(
        '[DRIVE] Variáveis ausentes: ' +
          [
            OAUTH_CLIENT_ID ? '' : 'GOOGLE_OAUTH_CLIENT_ID/DRIVE_CLIENT_ID',
            OAUTH_CLIENT_SECRET ? '' : 'GOOGLE_OAUTH_CLIENT_SECRET/DRIVE_CLIENT_SECRET',
            OAUTH_REFRESH_TOKEN ? '' : 'GOOGLE_OAUTH_REFRESH_TOKEN/DRIVE_REFRESH_TOKEN',
            ROOT_FOLDER_ID ? '' : 'GOOGLE_DRIVE_ROOT_FOLDER_ID/DRIVE_ROOT_FOLDER_ID'
          ]
            .filter(Boolean)
            .join(', ')
      );
      console.warn('[DRIVE] Sem configuração de OAuth; upload ignorado.');
      return null;
    }

    const media = await msg.downloadMedia();
    if (!media || !media.data) {
      console.warn('[DRIVE] Mensagem sem mídia baixável.');
      return null;
    }

    const drive = driveClient();

    // Pastas do projeto
    const projectFolderId = await ensureFolder(
      drive,
      (link.projectName || 'Projeto').trim(),
      ROOT_FOLDER_ID
    );
    const docsFolderId = await ensureFolder(
      drive,
      'Documentos de Projeto',
      projectFolderId
    );

    // Nome do arquivo
    const mime = media.mimetype || 'application/octet-stream';
    const ext = extFromMime(mime);
    const when = new Date();
    const baseName =
      (msg._data?.filename ||
        (link.projectName || 'arquivo')
          .normalize('NFD')
          .replace(/[^\w\s-]/g, '')
          .trim()
          .replace(/\s+/g, '_')) + `_${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}-${String(when.getHours()).padStart(2, '0')}${String(when.getMinutes()).padStart(2, '0')}`;
    const fileName = `${baseName}.${ext}`;

    // Upload
    const res = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [docsFolderId]
      },
      media: {
        mimeType: mime,
        body: Buffer.from(media.data, 'base64')
      },
      fields: 'id, webViewLink, webContentLink',
      supportsAllDrives: true
    });

    const fileId = res.data.id;
    const url = res.data.webViewLink || res.data.webContentLink || `https://drive.google.com/file/d/${fileId}/view`;

    return { id: fileId, url };
  } catch (e) {
    console.error('[DRIVE] erro upload:', e?.message || e);
    return null;
  }
}

module.exports = {
  saveIncomingMediaToDrive
};
