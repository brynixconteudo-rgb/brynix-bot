// gp.js
// Camada de "Gerente de Projeto" – armazenamento leve em disco + webhooks p/ Zapier.
// Não quebra o que já existe; só é ativado em grupos via comandos com '/'.

const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const DATA_ROOT = '/var/data';
const STATE_FILE = path.join(DATA_ROOT, 'gp-state.json');        // config por grupo
const LOG_DIR    = path.join(DATA_ROOT, 'gp-logs');               // logs p/ summary
const DOCS_DIR   = path.join(DATA_ROOT, 'docs');                  // anexos por grupo

// Opcional: Zapier para planilha/drive
const GP_WEBHOOK_URL = process.env.GP_WEBHOOK_URL || '';

ensureDir(path.dirname(STATE_FILE));
ensureDir(LOG_DIR);
ensureDir(DOCS_DIR);

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJSON(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function state() {
  return readJSON(STATE_FILE, { groups: {} });
}
function saveState(s) {
  writeJSON(STATE_FILE, s);
}

function setGroupConfig(groupId, cfg) {
  const s = state();
  s.groups[groupId] = { ...(s.groups[groupId] || {}), ...cfg, updatedAt: new Date().toISOString() };
  saveState(s);
}
function getGroupConfig(groupId) {
  return state().groups[groupId] || null;
}

function appendLog(groupId, payload) {
  const file = path.join(LOG_DIR, `${groupId}.jsonl`);
  ensureDir(path.dirname(file));
  const entry = { ts: new Date().toISOString(), ...payload };
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

function readRecentLog(groupId, maxMinutes = 1440) {
  const file = path.join(LOG_DIR, `${groupId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const since = Date.now() - maxMinutes * 60 * 1000;
  const items = [];
  for (let i = Math.max(0, lines.length - 1500); i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      if (!obj.ts) continue;
      const t = Date.parse(obj.ts);
      if (isNaN(t) || t >= since) items.push(obj);
    } catch { /* ignore */ }
  }
  return items;
}

async function notifyZap(action, data) {
  if (!GP_WEBHOOK_URL) return; // opcional
  try {
    await fetch(GP_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body : JSON.stringify({ action, ...data }),
    });
  } catch (err) {
    console.error('[GP] Falha ao notificar Zapier:', err.message);
  }
}

function saveMediaToDisk(groupId, media, baseName) {
  // media: { data, mimetype, filename? } do whatsapp-web.js
  const ext = guessExt(media.mimetype) || (path.extname(media.filename || '') || '.bin');
  const dir = path.join(DOCS_DIR, groupId);
  ensureDir(dir);
  const file = path.join(dir, `${baseName}${ext}`);
  fs.writeFileSync(file, Buffer.from(media.data, 'base64'));
  return file;
}

function guessExt(mimetype) {
  if (!mimetype) return '';
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  };
  return map[mimetype] || '';
}

module.exports = {
  setGroupConfig,
  getGroupConfig,
  appendLog,
  readRecentLog,
  notifyZap,
  saveMediaToDisk,
};
