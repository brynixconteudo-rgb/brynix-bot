// storage.js
// Persistência simples: mapeia chatId → sheetId em JSON no disco do Render.

const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.LINKS_DB_PATH || '/var/data/group-links.json';

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  try {
    if (!fs.existsSync(DB_PATH)) return {};
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) {
    console.error('[DB] Erro ao ler arquivo:', e);
    return {};
  }
}

function save(obj) {
  try {
    ensureDir(DB_PATH);
    fs.writeFileSync(DB_PATH, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('[DB] Erro ao gravar arquivo:', e);
  }
}

function get(chatId) {
  const db = load();
  return db[chatId] || null;
}

function set(chatId, sheetId) {
  const db = load();
  db[chatId] = sheetId;
  save(db);
}

function remove(chatId) {
  const db = load();
  delete db[chatId];
  save(db);
}

module.exports = { get, set, remove, DB_PATH };
