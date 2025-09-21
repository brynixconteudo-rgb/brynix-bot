const express = require('express');
const { MessagingResponse } = require('twilio').twiml;

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get('/', (req, res) => {
  res.send('BRYNIX WhatsApp Bot up ✅');
});

app.post('/webhook', (req, res) => {
  const twiml = new MessagingResponse();
  const msg = (req.body.Body || '').trim().toLowerCase();
  const from = req.body.ProfileName || req.body.From || 'Contato';

  let reply;

  if (!msg) {
    reply = `Olá, ${from}! Eu sou o bot da BRYNIX 🤖. Envie "ajuda" para ver opções.`;
  } else if (msg.includes('ajuda')) {
    reply = `Oi, ${from}! Posso ajudar com:\n- "status"\n- "agenda"\n- "contato"`;
  } else if (msg.includes('status')) {
    reply = `Status do Assessment:\nKick-off concluído ✅\nEntrevistas: agendamento pendente ⏳`;
  } else if (msg.includes('agenda')) {
    reply = `Agenda:\nEntrevista 1 (Estratégico): TBD\nEntrevista 2 (Gerencial): TBD\nEntrevista 3–5 (Operacional): TBD`;
  } else if (msg.includes('contato')) {
    reply = `Canais BRYNIX:\nEmail: contato@brynix.ai\nSite: https://brynix.ai`;
  } else {
    reply = `Entendi, ${from}. Se quiser ver opções, digite "ajuda".`;
  }

  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`BRYNIX bot listening on ${port}`));
