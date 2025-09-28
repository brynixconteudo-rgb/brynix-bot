// server.js
// Bootstrap do serviço HTTP + WhatsApp + heartbeat do scheduler.

const express = require('express');
const { initWhatsApp } = require('./whatsapp'); // << desestruturado!

const PORT = process.env.PORT || 10000;
const TICK_SECONDS = parseInt(process.env.SCHED_TICK || '60', 10); // intervalo do heartbeat (s)

const app = express();

// Endpoints simples (úteis para Render/healthcheck)
app.get('/', (_req, res) => res.send('OK'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Inicializa WhatsApp e expõe /wa-status e /wa-qr via initWhatsApp(app)
initWhatsApp(app);

// Sobe o HTTP
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

// Heartbeat do “scheduler” (apenas batimento/gancho para evolução futura)
// A lógica de texto/TTS já está disponível pelos comandos ocultos:
//   /__test daily   | /__test weekly   | /__test tts <texto>
console.log(`[scheduler] iniciado (tick=${TICK_SECONDS}s)`);
setInterval(() => {
  // Aqui você pode invocar uma rotina real quando quiser, por ex.:
  // runScheduledJobs().catch(console.error);
}, TICK_SECONDS * 1000);
