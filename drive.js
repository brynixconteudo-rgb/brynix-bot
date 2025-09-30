// drive.js
// Upload de anexos do WhatsApp para o Google Drive usando OAuth do usuário.
// Suporta nomes de env 'GOOGLE_OAUTH_*' (seus) e legados 'DRIVE_*'.
// Necessárias: CLIENT_ID + CLIENT_SECRET + REFRESH_TOKEN + ROOT_FOLDER_ID

const { google } = require('googleapis');

function pickEnv(...names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  return '';
}

const CLIENT_ID     = pickEnv('GOOGLE_OAUTH_CLIENT_ID','DRIVE_CLIENT_ID');
const CLIENT_SECRET = pickEnv('GOOGLE_OAUTH_CLIENT_SECRET','DRIVE_CLIENT_SECRET');
const REFRESH_TOKEN = pickEnv('GOOGLE_OAUTH_REFRESH_TOKEN','DRIVE_REFRESH_TOKEN');
const ROOT_FOLDER   = pickEnv('GOOGLE_DRIVE_ROOT_FOLDER_ID','DRIVE_ROOT_FOLDER_ID');

function oAuth2() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) return null;
  const o = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, pickEnv('GOOGLE_OAUTH_REDIRECT_URI','DRIVE_REDIRECT_URI') || 'urn:ietf:wg:oauth:2.0:oob');
  o.setCredentials({ refresh_token: REFRESH_TOKEN });
  return o;
}

async function ensureProjectFolder(drive, projectName) {
  const q = `name='${projectName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and '${ROOT_FOLDER}' in parents and trashed=false`;
  const list = await drive.files.list({ q, fields: 'files(id,name)' });
  if (list.data.files?.length) return list.data.files[0].id;
  const res = await drive.files.create({
    requestBody: { name: projectName, mimeType: 'application/vnd.google-apps.folder', parents: [ROOT_FOLDER] },
    fields: 'id'
  });
  return res.data.id;
}

async function saveIncomingMediaToDrive(client, msg, link) {
  const auth = oAuth2();
  if (!auth || !ROOT_FOLDER) {
    console.log('[DRIVE] Sem configuração de OAuth; upload ignorado.');
    return null;
  }

  try {
    const drive = google.drive({ version: 'v3', auth });
    const media = await msg.downloadMedia();
    if (!media) throw new Error('Sem media');

    const base64 = media.data;
    const buffer = Buffer.from(base64, 'base64');
    const mime = media.mimetype || 'application/octet-stream';

    const projectFolderId = await ensureProjectFolder(drive, link.projectName || 'Projeto');
    const filename = `${Date.now()}_${msg.id.id}.${(mime.split('/')[1] || 'bin')}`;

    const res = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [projectFolderId],
        mimeType: mime,
      },
      media: {
        mimeType: mime,
        body: require('stream').Readable.from(buffer),
      },
      fields: 'id,webViewLink,webContentLink',
    });

    const url = res.data.webViewLink || res.data.webContentLink || '';
    return { fileId: res.data.id, url };
  } catch (e) {
    console.log('[DRIVE] erro upload:', e?.message || e);
    return null;
  }
}

module.exports = { saveIncomingMediaToDrive };
