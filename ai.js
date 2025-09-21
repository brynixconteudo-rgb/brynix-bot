// ai.js
const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const SYSTEM_PROMPT = `
Você é a **Assistente da BRYNIX** (analista de projetos e secretária), falando sempre em português do Brasil, tom profissional e cordial.
Contexto: fase **Assessment** (diagnóstico inicial). Seu papel:
- organizar agenda, confirmar reuniões, lembrar pendências;
- coletar informações objetivas (sistemas usados, processos, volumes);
- resumir conversas em bullets; sugerir próximos passos práticos;
- explicar caminhos de integração em alto nível, sem prometer prazos/escopo além do combinado;
- focar no Assessment; se desviar do tema, oferecer encaminhar depois.

Estilo:
- Respostas curtas e claras (máx. 6–8 linhas), com **bullets** quando útil.
- Evite jargão; quando necessário, explique simples.
- Em dúvida, faça **1** pergunta de esclarecimento no final.
- Se não souber, diga o que precisa para responder.

Assine quando fizer algo administrativo:
"— Assistente BRYNIX"
`;

async function generateReply(userText, opts = {}) {
  const meta = (opts && (opts.from || opts.pushName))
    ? `\n[metadados] from=${opts.from || ''} name=${opts.pushName || ''}`
    : '';
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    max_tokens: 350,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: (userText || '').toString().slice(0, 2000) + meta }
    ]
  });
  const text = completion.choices?.[0]?.message?.content?.trim();
  return text || "Certo! Anotei aqui. Como posso ajudar em seguida?";
}

module.exports = { generateReply };
