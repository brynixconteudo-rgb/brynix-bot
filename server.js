// server.js
// Bootstrap do HTTP + WhatsApp + heartbeat do scheduler (logs).

const express = require('express');
const wa = require('./whatsapp'); // importa o módulo inteiro

const PORT = process.env.PORT || 10000;
const TICK_SECONDS = parseInt(process.env.SCHED_TICK || '60', 10);

const app = express();

// health / info
app.get('/', (_req, res) => res.send('OK'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// --- valida exportação do whatsapp.js ---
if (!wa || typeof wa.initWhatsApp !== 'function') {
  const keys = wa ? Object.keys(wa) : [];
  console.error('[BOOT] Export inválido de "./whatsapp". Esperava função initWhatsApp.');
  console.error('[BOOT] Chaves exportadas pelo módulo:', keys);
  console.error('[BOOT] Verifique se no final do arquivo whatsapp.js existe:');
  console.error("        module.exports = { initWhatsApp, getLastQr };");
  process.exit(1);
}

// inicializa o WhatsApp e registra /wa-status e /wa-qr
wa.initWhatsApp(app);

// sobe http
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

// heartbeat simples (apenas logging)
console.log(`[scheduler] iniciado (tick=${TICK_SECONDS}s)`);
setInterval(() => {
  // gancho para rotinas futuras (intencionalmente vazio por ora)
}, TICK_SECONDS * 1000);
