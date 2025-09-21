const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const OpenAI = require('openai'); // <— NOVO

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Twilio (vindos do Render)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const client     = twilio(accountSid, authToken);

// OpenAI (do Render)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Rota de teste
app.get('/', (req, res) => {
  res.send('BRYNIX WhatsApp Bot up ✅');
});

// Endpoint para receber mensagens do WhatsApp
app.post('/whatsapp', async (req, res) => {
  try {
    const from = req.body.From;       // ex: 'whatsapp:+55119...'
    const userText = req.body.Body || '';

    // Chama a OpenAI para gerar a resposta
    const ai = await openai.responses.create({
      model: "gpt-5-mini",
      input: `Você é a assistente da BRYNIX (clara, útil e concisa).
Responda em PT-BR, no máximo 2 a 3 frases.
Mensagem do usuário: "${userText}"`,
    });

    const replyText = ai.output_text?.trim() || "Estou aqui! Como posso ajudar?";

    // Envia a resposta de volta ao mesmo remetente
    await client.messages.create({
      from: 'whatsapp:' + process.env.TWILIO_PHONE_NUMBER, // número Twilio no Sandbox
      to: from,                                            // responde para quem enviou
      body: replyText,
    });

    // Responde ao Twilio que está tudo certo
    res.status(200).send('<Response></Response>');
  } catch (err) {
    console.error('Erro no webhook:', err);
    res.status(200).send('<Response></Response>'); // mantém 200 para Twilio não re-tentar em loop
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
