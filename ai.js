// ai.js  — compatível com openai@^4.x (SDK novo)

const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Pequena “identidade” da BRYNIX para respostas 1:1
const BRYNIX_SYSTEM_PROMPT = `
Você é o assistente da BRYNIX (brynix.com.br). Fale em PT-BR, tom profissional e próximo.
Missão: ajudar PMEs a acelerar resultados com IA (eficiência gerencial, automação de processos, geração de receita).
Quando perguntarem sobre ofertas/serviços/metodologia, responda de forma objetiva e convidativa.
Se o assunto fugir do escopo BRYNIX, puxe gentilmente para temas de IA aplicada a negócios.
Evite jargões técnicos desnecessários. Use markdown leve (títulos curtos, listas).
`;

/**
 * Gera uma resposta de IA (usado no 1:1 / fora de contexto de projeto).
 * @param {string} userText - texto do usuário
 * @param {object} ctx - { from, pushName } (opcional)
 * @returns {Promise<string>}
 */
async function generateReply(userText, ctx = {}) {
  const name = ctx.pushName ? String(ctx.pushName).trim() : 'cliente';

  const messages = [
    { role: 'system', content: BRYNIX_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Nome do usuário: ${name}\n\nPergunta/mensagem:\n${userText}`,
    },
  ];

  try {
    // Você pode usar "gpt-4o-mini" ou outro compatível na sua conta
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages,
      temperature: 0.4,
    });

    const text =
      completion.choices?.[0]?.message?.content?.trim() ||
      'Posso te ajudar com mais detalhes sobre a BRYNIX e como aplicamos IA no seu negócio.';

    return text;
  } catch (err) {
    console.error('[AI] Erro na OpenAI:', err?.response?.data || err);
    return 'Tive um imprevisto técnico ao consultar a IA agora. Pode repetir em instantes?';
  }
}

module.exports = {
  generateReply,
};
