const express = require('express');
const twilio = require('twilio'); // usaremos o TwiML do Twilio

const app = express();

// Twilio manda application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

// Rota de teste
app.get('/', (req, res) => {
  res.send('BRYNIX WhatsApp Bot up ✅');
});

// Webhook do WhatsApp (Twilio Sandbox chama aqui via POST)
app.post('/whatsapp', (req, res) => {
  try {
    const { MessagingResponse } = twilio.twiml;
    const twiml = new MessagingResponse();

    const body = (req.body.Body || '').toLowerCase();

    const reply = body.includes('oi')
      ? 'Olá! 👋 Aqui é o Bot da BRYNIX, pronto para ajudar.'
      : 'Recebi sua mensagem, já já respondo com novidades 🚀';

    twiml.message(reply);

    // responde em XML (Twilio TwiML)
    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('Erro no webhook:', err);
    res.status(500).send('Erro');
  }
});

// Porta do Render
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
