const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Rota de teste
app.get('/', (req, res) => {
  res.send('BRYNIX WhatsApp Bot up ✅');
});

// Endpoint mínimo para confirmar que /whatsapp está ativo
app.post('/whatsapp', (req, res) => {
  console.log('Webhook /whatsapp recebeu algo:', req.body);
  res.status(200).send('ok'); // resposta simples
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
