// ai.js
// Implementação robusta para OpenAI usando CommonJS e modelo estável por padrão.

const OpenAI = require('openai');

// Lê a key do ambiente; se não existir, loga e falha claramente.
const API_KEY = process.env.OPENAI_API_KEY || '';
if (!API_KEY) {
  console.error('[AI] OPENAI_API_KEY ausente nas variáveis de ambiente.');
}

const client = new OpenAI({ apiKey: API_KEY });

// Defina o modelo por env ou use um default estável.
// Dica: se quiser mudar, crie AI_MODEL no Render (ex.: "gpt-4o-mini").
const MODEL = (process.env.AI_MODEL || 'gpt-4o-mini').trim();

// Prompt base curto; ampliamos depois conforme as features (/setup, summary etc.)
const SYSTEM_PROMPT = `
Você é o **Assistente BRYNIX**.

Estilo: executivo, claro, cordial, com leve humor.
Foco: sempre responder a partir da perspectiva da BRYNIX (empresa, projetos, ofertas, automações, clientes).
Você **não é uma enciclopédia geral**: se receber perguntas que não tenham relação com BRYNIX, redirecione de forma educada para o contexto correto.

### Diretrizes
- Sempre contextualize as respostas com BRYNIX: visão, ofertas, metodologia, exemplos práticos de projetos.
- Responda em PT-BR. Use 2–4 parágrafos curtos ou bullets quando ajudar na clareza.
- Se a pergunta for fora do escopo (ex.: Guerra do Golfo), diga algo como:
  "Esse tema não faz parte do meu escopo. Meu papel é ajudar você com os projetos e soluções da BRYNIX. Quer que eu conecte com como tratamos cenários de risco ou estratégia em projetos?"
- Evite respostas excessivamente genéricas ou evasivas. Traga sempre utilidade prática ligada à BRYNIX.
- Finalize quando possível com um convite à ação ou próximo passo.
`;

function buildUserPrompt(userText, ctx = {}) {
  const name = ctx?.pushName ? ` (${ctx.pushName})` : '';
  const from  = ctx?.from ? ` [origem: ${ctx.from}]` : '';
  return `Mensagem${name}${from}: ${userText}`;
}

/**
 * Gera resposta via OpenAI.
 * Lança erro para o caller lidar com fallback (o whatsapp.js já faz isso).
 */
async function generateReply(userText, ctx = {}) {
  if (!API_KEY) throw new Error('OPENAI_API_KEY não configurada');

  try {
    // Usamos Chat Completions da API estável
    const resp = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildUserPrompt(userText, ctx) },
      ],
      temperature: 0.3,
      max_tokens: 400,
    });

    const out = resp?.choices?.[0]?.message?.content?.trim();
    if (!out) throw new Error('Resposta vazia da IA');
    return out;
  } catch (err) {
    // Log detalhado ajuda MUITO a diagnosticar
    console.error('[AI] Erro na chamada OpenAI:', {
      message: err?.message,
      status: err?.status,
      data: err?.response?.data,
    });
    // Repassa para o whatsapp.js decidir o fallback
    throw err;
  }
}

module.exports = { generateReply };
