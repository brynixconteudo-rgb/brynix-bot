// ai.js
// Implementação robusta para OpenAI usando CommonJS e com "guarda de escopo".
// A IA só responde dentro do tema BRYNIX; para o resto, redireciona.

const OpenAI = require('openai');
const gp = require('./gp');

// === Config OpenAI ===
const API_KEY = process.env.OPENAI_API_KEY || '';
if (!API_KEY) {
  console.error('[AI] OPENAI_API_KEY ausente nas variáveis de ambiente.');
}
const client = new OpenAI({ apiKey: API_KEY });

// Modelo (pode trocar via env AI_MODEL)
const MODEL = (process.env.AI_MODEL || 'gpt-4o-mini').trim();

// === Prompt base ===
const SYSTEM_PROMPT = `
Você é o **Assistente BRYNIX**, com tom executivo, direto e cordial, leve humor quando apropriado.

**Escopo**: BRYNIX (empresa, ofertas, automações, cases, metodologia, projetos), contexto de atendimento, agenda e follow-up.  
NÃO é seu papel responder assuntos fora deste escopo. Quando algo estiver fora, diga educadamente:
"Esse tema foge do meu escopo. Posso te ajudar com projetos e soluções da BRYNIX."

**Diretrizes**:
- Responda em PT-BR.
- Priorize respostas objetivas (2–4 parágrafos curtos) ou bullets quando ajudar.
- Quando possível, conclua com um convite prático (próximo passo/ação).
- Evite generalidades. Use informações concretas quando disponíveis.
`.trim();

function buildUserPrompt(userText, ctx = {}) {
  const name = ctx?.pushName ? ` (${ctx.pushName})` : '';
  const origin = ctx?.from ? ` [origem: ${ctx.from}]` : '';
  return `Mensagem${name}${origin}: ${userText}`;
}

// Extrai texto do Responses API (compatível)
function extractText(resp) {
  // v4 client.responses.create
  if (resp?.output_text) return resp.output_text;

  // fallback (às vezes vem em 'content[0].text')
  try {
    const parts = resp?.output?.[0]?.content || resp?.content || [];
    const textPart = parts.find(p => p.type === 'output_text' || p.type === 'text');
    if (textPart?.text?.value) return textPart.text.value;
    if (typeof textPart?.text === 'string') return textPart.text;
  } catch {}
  return '';
}

async function generateReply(userText, ctx) {
  // 1) Tenta tratar como GP (comandos, linguagem natural)
  try {
    const gpRes = await gp.handleMessage(userText, ctx);
    if (gpRes?.handled) {
      const msg = await Promise.resolve(gpRes.reply);
      return msg;
    }
  } catch (err) {
    console.error('[AI] GP handler falhou:', err?.message || err);
    // segue para IA mesmo assim
  }

  // 2) Fora do GP → IA responde, MAS dentro do escopo BRYNIX
  const userPrompt = buildUserPrompt(userText, ctx);

  try {
    const response = await client.responses.create({
      model: MODEL,
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ]
    });

    let out = extractText(response) || '';
    if (!out) out = 'Posso te ajudar com projetos e soluções da BRYNIX. Como prefere começar?';

    // Hard guard: se o usuário perguntar claramente algo fora (e.g. "Guerra do Golfo"),
    // faz o desvio elegante:
    const lower = (userText || '').toLowerCase();
    const outOfScope =
      /(guerra|hist[oó]ria geral|geopol[ií]tica|celebridades|filmes|receitas|c[âa]mbio|clima|cotação|piada)/.test(lower);
    if (outOfScope) {
      out = 'Esse tema foge do meu escopo. Posso te ajudar com projetos e soluções da BRYNIX, como automações, diagnóstico (assessment) e delivery.';
    }

    return out;
  } catch (err) {
    console.error('[AI] Falha na chamada OpenAI:', err?.message || err);
    return 'Tive um problema técnico agora há pouco. Pode reenviar sua mensagem?';
  }
}

module.exports = { generateReply };
