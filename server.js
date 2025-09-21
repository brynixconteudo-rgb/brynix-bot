const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const OpenAI = require('openai');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Twilio Credentials (vindos das variáveis de ambiente do Render)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

// OpenAI Config
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Rota de teste
app.get('/', (req, res) => {
  res.send('BRYNIX WhatsApp Bot up ✅');
});

// Endpoint para receber mensagens do WhatsApp
app.post('/whatsapp', async (req, res) => {
  const incomingMsg = req.body.Body;

  let reply;

  try {
    // Envia a mensagem para a OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: "Você é um assistente do projeto BRYNIX, responda de forma natural e útil." },
        { role: "user", content: incomingMsg }
      ],
    });

    reply = completion.choices[0].message.content;

  } catch (error) {
    console.error("Erro ao chamar OpenAI:", error);
    reply = "Desculpe, não consegui processar sua mensagem agora.";
  }

  // Envia resposta pelo Twilio
  client.messages
    .create({
      from: 'whatsapp:' + process.env.TWILIO_PHONE_NUMBER, // número do Twilio
      to: 'whatsapp:+5511956847159', // seu WhatsApp Business
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
