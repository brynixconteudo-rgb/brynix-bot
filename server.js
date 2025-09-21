const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Twilio Credentials (vindos das variáveis de ambiente do Render)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

// Rota de teste
app.get('/', (req, res) => {
  res.send('BRYNIX WhatsApp Bot up');
});

// Endpoint para receber mensagens do WhatsApp
app.post('/whatsapp', (req, res) => {
  const incomingMsg = req.body.Body;

  let reply;
  if (incomingMsg.toLowerCase().includes('oi')) {
    reply = 'Olá! 👋 Aqui é o Bot da BRYNIX, pronto para ajudar.';
  } else {
    reply = 'Recebi sua mensagem, já já respondo com novidades 🚀';
  }

  client.messages
    .create({
      from: 'whatsapp:' + process.env.TWILIO_PHONE_NUMBER, // número do Twilio
      to: 'whatsapp:+5511956847159', // 📌 seu WhatsApp Business
      body: reply,
    })
    .then(message => console.log(`Mensagem enviada: ${message.sid}`))
    .catch(err => console.error(err));

  res.send('<Response></Response>');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
