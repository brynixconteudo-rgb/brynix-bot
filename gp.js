// gp.js
// Utilidades de "gestão de projeto": logging de mensagens de grupo,
// parsing de lembretes e utilitários simples.

const fs = require('fs');
const path = require('path');

const BASE_DIR = process.env.GP_STORE_PATH || '/var/data/gp-logs';
const NOTES_DIR = path.join(BASE_DIR, 'notes');
const DOCS_DIR  = path.join(BASE_DIR, 'docs');

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

// Cria estrutura mínima
ensureDir(BASE_DIR);
ensureDir(NOTES_DIR);
ensureDir(DOCS_DIR);

/**
 * Salva uma linha JSON (JSONL) por grupo.
 * Cada linha é um objeto { ts, groupId, author, body, meta }
 */
function appendLog(groupId, payload) {
  if (!groupId) return;
  ensureDir(BASE_DIR);
  const file = path.join(BASE_DIR, `${groupId}.jsonl`);

  const line = JSON.stringify({
    ts: Date.now(),
    groupId,
    ...payload,
  });

  try {
    fs.appendFileSync(file, line + '\n', { encoding: 'utf8' });
  } catch (err) {
    console.error('[GP] Falha ao gravar log:', err);
  }
}

/**
 * Guarda uma nota rápida (ex.: /note …)
 */
function saveNote(groupId, author, text) {
  ensureDir(NOTES_DIR);
  const file = path.join(NOTES_DIR, `${groupId}.txt`);
  const line = `[${new Date().toISOString()}] ${author || 'alguém'}: ${text}\n`;
  try {
    fs.appendFileSync(file, line, { encoding: 'utf8' });
  } catch (err) {
    console.error('[GP] Falha ao gravar nota:', err);
  }
}

/**
 * Parser simples de lembretes (ex.: "/remind 10:00 revisao backlog")
 * Retorna { timeText, text } ou null
 */
function parseReminder(body) {
  const m = body.trim().match(/^\/remind\s+([^\s]+)\s+(.+)$/i);
  if (!m) return null;
  return { timeText: m[1], text: m[2] };
}

/**
 * (stub) “Digitaliza” anexos. Aqui só guardamos metadados.
 */
function scanDocs(groupId, meta) {
  ensureDir(DOCS_DIR);
  const file = path.join(DOCS_DIR, `${groupId}.jsonl`);
  try {
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), ...meta }) + '\n', 'utf8');
  } catch (err) {
    console.error('[GP] Falha ao registrar doc:', err);
  }
}

module.exports = {
  appendLog,
  saveNote,
  parseReminder,
  scanDocs,
  // diretórios expostos só se precisar em outra parte:
  BASE_DIR,
  NOTES_DIR,
  DOCS_DIR,
};
