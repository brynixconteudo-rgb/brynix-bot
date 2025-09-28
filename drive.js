// drive.js
// Upload de anexos para Google Drive usando OAuth de usuário (não Service Account).
// ENV obrigatórias:
//   DRIVE_CLIENT_ID
//   DRIVE_CLIENT_SECRET
//   DRIVE_REFRESH_TOKEN
//   DRIVE_ROOT_FOLDER_ID   (pasta raiz onde ficarão os projetos)
//
// Saída principal exportada: saveIncomingMediaToDrive(client, msg, link)
//   - link = { sheetId, projectName }

const { google } = require('googleapis');
const path = require('path');
const crypto = require('crypto');

const REQUIRED_ENVS = [
  'DRIVE_CLIENT_ID',
  'DRIVE_CLIENT_SECRET',
  'DRIVE_REFRESH_TOKEN',
  'DRIVE_ROOT_FOLDER_ID',
];

function missingEnv() {
  const missing = REQUIRED_ENVS.filter((k) => !process.env[k]);
  return missing.length ? missing : null;
}

function buildOAuth() {
  const missing = missingEnv();
  if (missing) {
    console.warn('[DRIVE] Variáveis ausentes:', missing.join(', '));
    return null;
  }
  const oAuth2Client = new google.auth.OAuth2(
    process.env.DRIVE_CLIENT_ID,
    process.env.DRIVE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  oAuth2Client.setCredentials({ refresh_token: process.env.DRIVE_REFRESH_TOKEN });
  return oAuth2Client;
}

function driveClient() {
  const auth = buildOAuth();
  if (!auth) return null;
  return google.drive({ version: 'v3', auth });
}

async function ensureFolder(drive, name, parentId) {
  // procura pasta com esse nome sob o parent
  const q = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    `'${parentId}' in parents`,
    'trashed = false',
  ].join(' and ');

  const list = await drive.files.list({ q, fields: 'files(id, name)' });
  if (list.data.files && list.data.files.length) return list.data.files[0].id;

  // cria
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id, name',
  });
  return res.data.id;
}

async function createOrGetProjectFolders(drive, projectName) {
  const rootId = process.env.DRIVE_ROOT_FOLDER_ID;
  const projectId = await ensureFolder(drive, projectName, rootId);
  const docsId = await ensureFolder(drive, 'Documentos de Projeto', projectId);
  return { projectId, docsId };
}

function guessExt(mime) {
  if (!mime) return '';
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'application/pdf': '.pdf',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/webm': '.webm',
    'video/mp4': '.mp4',
    'application/zip': '.zip',
  };
  return map[mime] || '';
}

async function uploadBuffer(drive, buffer, { filename, mimeType, parentId }) {
  const res = await drive.files.create({
    requestBody: {
      name: filename,
      mimeType,
      parents: [parentId],
    },
    media: {
      mimeType,
      body: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
    },
    fields: 'id, name, webViewLink',
  });

  const fileId = res.data.id;

  // garante que o link de visualização funcione para membros da organização ou link-sharing conforme necessidade
  // Aqui abrimos como "anyoneWithLink = reader". Ajuste se necessário.
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
    });
  } catch (e) {
    console.warn('[DRIVE] Falha ao abrir permissão pública (ok em ambientes restritos):', e?.message || e);
  }

  const view = `https://drive.google.com/file/d/${fileId}/view?usp=drivesdk`;
  return { id: fileId, url: view, name: res.data.name };
}

/**
 * Salva a mídia recebida no WhatsApp no Drive, sob:
 *   DRIVE_ROOT_FOLDER_ID / <Nome do Projeto> / Documentos de Projeto
 */
async function saveIncomingMediaToDrive(_client, msg, link) {
  try {
    const drive = driveClient();
    if (!drive) {
      console.warn('[DRIVE] Sem configuração de OAuth; upload ignorado.');
      return { url: null };
    }
    if (!link?.projectName) {
      console.warn('[DRIVE] link.projectName ausente.');
      return { url: null };
    }

    const media = await msg.downloadMedia(); // { mimetype, data(base64) }
    if (!media || !media.data) {
      console.warn('[DRIVE] Sem media.data base64.');
      return { url: null };
    }

    const bytes = Buffer.from(media.data, 'base64');
    const ext = guessExt(media.mimetype) || '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = crypto.randomBytes(3).toString('hex');
    const filename = `wa_${stamp}_${rand}${ext}`;

    const { docsId } = await createOrGetProjectFolders(drive, link.projectName);
    const up = await uploadBuffer(drive, bytes, {
      filename,
      mimeType: media.mimetype || 'application/octet-stream',
      parentId: docsId,
    });

    return { url: up.url, id: up.id, name: up.name };
  } catch (e) {
    console.error('[DRIVE] saveIncomingMediaToDrive erro:', e?.message || e);
    return { url: null };
  }
}

module.exports = {
  saveIncomingMediaToDrive,
};
