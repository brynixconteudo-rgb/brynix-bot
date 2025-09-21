// ai.js
// Camada de IA: tom executivo, direto, cordial, com humor leve.
// Mantém foco em BRYNIX; evita virar enciclopédia geral.
// Para perguntas fora do escopo, redireciona com elegância.

const OpenAI = require('openai');

const API_KEY = process.env.OPENAI_API_KEY || '';
if (!API_KEY) {
  console.error('[AI] OPENAI_API_KEY ausente nas variáveis de ambiente.');
}
const client = new OpenAI({ apiKey: API_KEY });

// Modelo: pode trocar via variável AI_MODEL no Render.
const MODEL = (process.env.AI_MODEL || 'gpt-4o-mini').trim();

// Prompt base (curto) — o restante vem do user/system dinamicamente.
const SYSTEM_PROMPT = `
Você é o **Assistente BRYNIX**.

Estilo: executivo, claro, cordial, com leve humor.
Regra de ouro: sempre que possível, traga utilidade prática (próximos passos, checklist,
sugestões objetivas). Evite respostas longas demais se não agregarem valor.

Escopo prioridade: BRYNIX (empresa, ofertas, automações, projetos, metodologia, exemplos),
organização de atividades de projeto e comunicação com cliente.
Se a pergunta estiver claramente fora desse escopo (ex.: cultura pop antiga, curiosidades aleatórias),
redirecione com elegância: explique que o foco é BRYNIX e projetos, e faça uma ponte útil.
`;

function buildUserPrompt(userText, ctx = {}) {
  const who = ctx.pushName || ctx.from || 'usuário';
  return `Mensagem de ${who}: "${userText}"`;
}

async function generateReply(userText, ctx = {}) {
  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(userText, ctx) },
    ];

    const resp = await client.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.5,
      max_tokens: 550,
    });

    const out =
      resp?.choices?.[0]?.message?.content?.trim() ||
      'Certo! Consegue me dar um pouco mais de contexto para eu te ajudar melhor?';
    return out;
  } catch (err) {
    console.error('[AI] Erro na OpenAI:', err?.message || err);
    return 'Tive um problema técnico com a IA agora há pouco. Pode reenviar sua mensagem?';
  }
}

module.exports = { generateReply };
