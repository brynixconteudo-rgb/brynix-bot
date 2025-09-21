// ai.js
// Implementação robusta usando OpenAI v4 (Responses API) e CommonJS.

const OpenAI = require('openai');

const API_KEY = process.env.OPENAI_API_KEY || '';
if (!API_KEY) {
  console.error('[AI] OPENAI_API_KEY ausente nas variáveis de ambiente.');
}

const client = new OpenAI({ apiKey: API_KEY });

// Altere via variável de ambiente se quiser (ex.: gpt-4o-mini, gpt-5-mini)
const MODEL = (process.env.AI_MODEL || 'gpt-4o-mini').trim();

/**
 * Conhecimento base mínimo sobre a BRYNIX (EDITÁVEL).
 * Se quiser mover para um arquivo .md ou para env, fique à vontade.
 */
const BRYNIX_KB = `
BRYNIX: consultoria focada em análise de projetos e automações inteligentes (IA + integrações).
Áreas principais:
- Assessment de processos (diagnóstico inicial, mapeamento de riscos, backlog de melhorias).
- Automação operacional (n8n/Make/Zapier), bots conversacionais, extração e enriquecimento de dados.
- Integrações com GSuite/Drive/Sheets, WhatsApp, Jira, CRMs e serviços internos.
- Roadmaps executivos com entregas incrementais (semanas, não meses).
Estilo de comunicação BRYNIX: executivo, direto, cordial, com leve humor e foco em próximos passos.
`;

/**
 * Prompt de sistema: define identidade, tom e limites.
 * Mantém o foco em BRYNIX e redireciona assuntos “fora de escopo”.
 */
const SYSTEM_PROMPT = `
Você é o **Assistente BRYNIX**.

### Identidade e Estilo
- Estilo: executivo, claro, cordial, com leve humor.
- Objetivo: ajudar pessoas com projetos, ofertas e automações da BRYNIX.
- Você **não é uma enciclopédia geral**. Se a pergunta não tiver relação com BRYNIX, redirecione educadamente.

### Diretrizes
- Priorize sempre o contexto BRYNIX: visão, ofertas, metodologia, exemplos práticos e próximos passos.
- Responda em PT-BR. Prefira 2–4 parágrafos curtos ou bullets quando ajudar na clareza.
- Evite respostas genéricas; conecte com valor prático (o que fazer agora).
- Se o pedido for fora de escopo (ex.: Guerra do Golfo), diga algo como:
  "Esse tema foge do meu escopo. Meu foco é apoiar você com os projetos e soluções da BRYNIX.
   Posso conectar esse assunto à forma como tratamos análise de riscos, cenários ou gestão de stakeholders?"
- Finalize, quando fizer sentido, com um convite à ação (ex.: “Quer que eu monte um próximo passo?”).

### Conhecimento Interno (base)
${BRYNIX_KB}
`;

/**
 * Monta o prompt do usuário + contexto de remetente.
 * ctx: { from, pushName, projectName, role, extraContext }
 */
function buildUserPrompt(userText, ctx = {}) {
  const name = ctx.pushName ? `${ctx.pushName}` : (ctx.from ? `${ctx.from}` : 'usuário');

  // Se você já tiver guardado o nome do projeto / marcos,
  // pode incluir aqui para o modelo usar como contexto.
  const project = ctx.projectName ? `Projeto: ${ctx.projectName}\n` : '';

  const extra =
    ctx.extraContext && String(ctx.extraContext).trim().length > 0
      ? `Contexto extra: ${ctx.extraContext}\n`
      : '';

  return [
    `Remetente: ${name}`,
    project,
    extra,
    `Mensagem do usuário: """${userText}"""`,
  ].join('\n');
}

/**
 * Extrai o texto da resposta da Responses API (v4).
 */
function extractText(resp) {
  try {
    // Atalho do SDK v4:
    if (resp && typeof resp.output_text === 'string') {
      return resp.output_text.trim();
    }
    // fallback defensivo:
    if (resp?.output?.[0]?.content?.[0]?.text) {
      return String(resp.output[0].content[0].text).trim();
    }
  } catch (_) {}
  return 'Tive um problema para formular a resposta agora. Pode tentar novamente?';
}

/**
 * Gera a resposta final do assistente.
 * userText: string com a mensagem do usuário
 * ctx: { from, pushName, projectName, role, extraContext }
 */
async function generateReply(userText, ctx = {}) {
  if (!API_KEY) {
    return 'Configuração de IA ausente (OPENAI_API_KEY).';
  }

  const userPrompt = buildUserPrompt(userText, ctx);

  // Ajuste de temperatura e comprimento para ser assertivo sem ficar “seco”.
  const temperature = 0.5;
  const maxTokens = 450; // ~ 2–3 parágrafos/bullets bons

  const messages = [
    {
      role: 'system',
      content: [{ type: 'text', text: SYSTEM_PROMPT }],
    },
    {
      role: 'user',
      content: [{ type: 'text', text: userPrompt }],
    },
  ];

  // Responses API
  const resp = await client.responses.create({
    model: MODEL,
    input: messages,
    max_output_tokens: maxTokens,
    temperature,
  });

  return extractText(resp);
}

module.exports = { generateReply };
