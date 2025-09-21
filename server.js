// server.js
// BRYNIX WhatsApp Bot – servidor Express + whatsapp-web.js

const express = require('express');
const bodyParser = require('body-parser');
const { initWhatsApp } = require('./whatsapp');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// rota de saúde
app.get('/', (_req, res) => {
  res.send('BRYNIX WhatsApp Bot up ✅');
});

/**
 * Inicializa o cliente do WhatsApp e expõe rotas:
 *   - GET /wa-qr     -> exibe o QR code para autenticação
 *   - GET /wa-status -> mostra o status da sessão (conectado, carregando, etc.)
 *   - POST /wa-send  -> envia mensagem: { to: "+5511999999999", text: "Olá" }
 */
initWhatsApp(app);

// porta (Render injeta em process.env.PORT)
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
