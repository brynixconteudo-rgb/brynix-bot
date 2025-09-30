// ai.js
// Respostas 1:1 (modo Analista) com tom natural e conhecimento estático da BRYNIX.
// Sem browsing. Usa OPENAI opcionalmente para reformular (se quiser mais "humanizado").

const OpenAI = require('openai');
const openaiKey = process.env.OPENAI_API_KEY || '';
const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;

const BRYNIX_KB = {
  site: 'https://brynix.ai',
  quemSomos: 'A BRYNIX ajuda PMEs a acelerar resultados com IA, focando em eficiência gerencial, automação de processos e crescimento de receita.',
  ofertas: [
    'Diagnóstico Inteligente (assessment rápido, mapa de oportunidades)',
    'Automação e copilots para processos comerciais e operacionais',
    'Análises e previsões com IA (vendas, churn, estoque)',
    'Treinamento e governança para adoção de IA'
  ],
  abordagem: 'Começamos por um diagnóstico (baixo atrito e alto impacto), priorizamos ganhos rápidos e evoluímos com um roadmap de automações e copilots.'
};

function answerFromKB(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('oferta') || t.includes('servi') || t.includes('fazem')) {
    return `A BRYNIX oferece: \n• ${BRYNIX_KB.ofertas.join('\n• ')}\n\nSite: ${BRYNIX_KB.site}`;
  }
  if (t.includes('site') || t.includes('website') || t.includes('url')) {
    return `Nosso site é ${BRYNIX_KB.site}`;
  }
  if (t.includes('quem é') || t.includes('quem sao') || t.includes('sobre') || t.includes('brynix')) {
    return `${BRYNIX_KB.quemSomos}\n\nAbordagem: ${BRYNIX_KB.abordagem}\nSite: ${BRYNIX_KB.site}`;
  }
  return null;
}

async function generateReply(text, ctx={}) {
  const kb = answerFromKB(text);
  let base = kb || `Entendi. Posso explicar nossa abordagem e como aplicamos IA de forma prática: ${BRYNIX_KB.abordagem}. Tem um desafio específico que você quer atacar primeiro?`;

  if (!openai) return base;
  try {
    const prompt = `Reescreva de forma amigável, clara e curta (português do Brasil), como se fosse uma especialista atenciosa: """${base}"""`;
    const r = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
    });
    return r.choices?.[0]?.message?.content?.trim() || base;
  } catch {
    return base;
  }
}

module.exports = { generateReply };
