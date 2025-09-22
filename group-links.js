// group-links.js
const fs = require('fs/promises');
const path = require('path');

const DB_PATH = process.env.LINKS_DB_PATH || '/var/data/links-db.json';

// garante que a pasta existe
async function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
}

// carrega o JSON (ou retorna {} se não existir)
async function loadDb() {
  try {
    const raw = await fs.readFile(DB_PATH, 'utf8');
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

// salva o JSON
async function saveDb(db) {
  await ensureDirExists(DB_PATH);
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

// retorna o vínculo para um groupId (ou null)
async function getLink(groupId) {
  const db = await loadDb();
  return db[groupId] || null;
}

// cria/atualiza o vínculo do groupId
async function setLink(groupId, spreadsheetId, projectName = '') {
  const db = await loadDb();
  db[groupId] = { spreadsheetId, projectName, updatedAt: new Date().toISOString() };
  await saveDb(db);
  return db[groupId];
}

// remove o vínculo do groupId
async function removeLink(groupId) {
  const db = await loadDb();
  delete db[groupId];
  await saveDb(db);
  return true;
}

module.exports = { getLink, setLink, removeLink, DB_PATH };
