// server.js — versão consolidada (uma única inicialização)

// 1) deps
const express = require('express');

// 2) módulos do bot
const { initWhatsApp, sendText, sendAudio, getClient } = require('./whatsapp');
const { startScheduler } = require('./scheduler');

// 3) app http
const app = express();
app.use(express.json());

// rota básica opcional (saúde do serviço)
app.get('/', (_req, res) => res.send('brynix-bot ok'));

// 4) inicializa WhatsApp e expõe endpoints (/wa-status, /wa-qr)
initWhatsApp(app);

// 5) inicia o scheduler (tick minutely)
startScheduler({ sendText, sendAudio, getClient });

// 6) start http
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
