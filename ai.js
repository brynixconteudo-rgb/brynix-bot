// ai.js
// Integração OpenAI (CommonJS) – com geração de respostas e sumário de log.

const OpenAI = require('openai');
const API_KEY = process.env.OPENAI_API_KEY || '';

if (!API_KEY) {
  console.error('[AI] OPENAI_API_KEY ausente nas variáveis de ambiente.');
}

const client = new OpenAI({ apiKey: API_KEY });

// Modelo estável e econômico
const MODEL = (process.env.AI_MODEL || 'gpt-4o-mini').trim();

// Prompt base (Assistente BRYNIX)
const SYSTEM_PROMPT = `
Você é o **Assistente BRYNIX**.

Estilo: executivo, claro, cordial, com leve humor.
Foco: sempre responder a partir da perspectiva da BRYNIX (empresa, projetos, ofertas, automações, clientes).
Você **não é** uma enciclopédia geral**: se receber perguntas que não tenham relação com BRYNIX, redirecione de forma educada.

### Diretrizes
- Responda em PT-BR, com 2–4 parágrafos curtos ou bullets quando ajudar na clareza.
- Se a pergunta for fora de escopo (ex.: “Guerra do Golfo”), diga algo como:
  “Esse tema não faz parte do meu escopo. Meu papel é ajudar você com os projetos e soluções da BRYNIX.”
- Evite respostas genéricas demais. Traga utilidade prática ligada à BRYNIX.
- Conclua com um convite a um próximo passo (quando fizer sentido).
`;

function buildUserPrompt(userText, ctx = {}) {
  const name = ctx?.pushName ? `(${ctx.pushName})` : '';
  const origin = ctx?.from ? ` [origem: ${ctx.from}]` : '';
  return `Mensagem${name}${origin}: ${userText}`;
}

async function generateReply(userText, ctx = {}) {
  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(userText, ctx) },
    ];

    const resp = await client.responses.create({
      model: MODEL,
      input: messages.map(m => ({ role: m.role, content: m.content })),
      max_output_tokens: 400,
      temperature: 0.5,
    });

    const out = resp?.output_text?.trim();
    return out || 'Certo! Pode me contar um pouco mais do que você precisa?';
  } catch (err) {
    console.error('[AI] Erro generateReply:', err?.message || err);
    return 'Tive um problema técnico agora há pouco. Pode reenviar sua mensagem?';
  }
}

// Summariza um conjunto de eventos (log leve) em status executivo.
async function summarizeLog(events = [], projectName = 'Projeto', minutes = 1440) {
  try {
    const header = `Resumo das últimas ${minutes} min – ${projectName}`;
    const bullets = events.slice(-200).map(e => {
      const who = e.senderName || e.sender || 'alguém';
      const kind = e.type || 'msg';
      const txt = (e.text || e.caption || '').slice(0, 400).replace(/\s+/g, ' ').trim();
      return `- [${e.ts}] (${who}; ${kind}) ${txt}`;
    }).join('\n');

    const prompt = `
Você é GP da BRYNIX. Gere um status report objetivo. 
Entrada (log enxuto):
${bullets || '(sem eventos relevantes no período)'}
Saída:
- Principais avanços (bullets)
- Pendências e riscos (bullets)
- Próximos passos (bullets)
- % de avanço geral (estimativa)
- Tom curto, executivo, em PT-BR.
`;

    const resp = await client.responses.create({
      model: MODEL,
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      max_output_tokens: 500,
      temperature: 0.4,
    });

    const out = resp?.output_text?.trim();
    return out || `${header}\n(não há dados suficientes para um resumo significativo)`;
  } catch (err) {
    console.error('[AI] Erro summarizeLog:', err?.message || err);
    return 'Não consegui gerar o sumário agora. Tente novamente em instantes.';
  }
}

module.exports = { generateReply, summarizeLog };
