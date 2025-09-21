// ai.js
// Inteligência do BOT: tom de voz, papéis (Analista/GP/Secretária) e
// atualização periódica do conhecimento via páginas do site da BRYNIX.

const OpenAI = require('openai');
const cheerio = require('cheerio');

// =====================
// Config & Cliente OpenAI
// =====================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// URLs do site para compor o "mini-KB" (ajuste para seu domínio real!)
const BRYNIX_PAGES = [
  'https://brynix.ai/',          // home
  'https://brynix.ai/ofertas',   // ofertas/serviços
  'https://brynix.ai/sobre-a-brynix',
  'https://brynix.ai/notícias',      // notícias/artigos
];

// TTL do KB em memória (a cada 6h refaz o crawl/sumário)
const KB_TTL_MS = 6 * 60 * 60 * 1000;

let KB_CACHE = {
  text: '',
  updatedAt: 0,
};

// Contexto fixo (posicionamento da BRYNIX) — edite livremente
const BRYNIX_CONTEXT = `
A BRYNIX é uma consultoria que une análise de projetos, otimização de processos e integração tecnológica.
Ofertas (exemplos): Assessment estratégico, Implementação de IA aplicada, Integrações, Segurança, Roadmaps executivos.
Metodologia (macro): Diagnóstico ➜ Assessment com roadmap visual ➜ Implementação em fases ➜ Acompanhamento.
Tom: executivo e direto, porém leve, humano e colaborativo. Respostas práticas e acionáveis.
`;

// ======= Utils: baixar e extrair texto das páginas =======
async function fetchTextFrom(url) {
  const res = await fetch(url, { timeout: 25_000 });
  const html = await res.text();
  const $ = cheerio.load(html);
  // remove navegação/rodapé comuns (ajuste seletores se quiser)
  $('nav, header, footer, script, style, noscript').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return text;
}

async function rebuildKB() {
  try {
    const parts = [];
    for (const url of BRYNIX_PAGES) {
      try {
        const t = await fetchTextFrom(url);
        // Evita explodir prompt (corta por página)
        parts.push(`\n[${url}]\n${t.slice(0, 2400)}`);
      } catch (e) {
        parts.push(`\n[${url}] (erro ao obter conteúdo)`);
      }
    }

    // Opcional: peça para a IA “limpar e resumir” as páginas em até N tokens
    const base = parts.join('\n');
    const summarize = await openai.responses.create({
      model: 'gpt-5-mini', // econômico para sumarização
      input:
        `Resuma de forma executiva (bullets) e factual o conteúdo abaixo para um briefing interno.\n` +
        `Mantenha no máximo 3500 caracteres.\n\n${base}`,
    });

    const clean = summarize.output_text?.trim() || base.slice(0, 3500);

    KB_CACHE = {
      text: clean,
      updatedAt: Date.now(),
    };

    console.log('[KB] Atualizado com sucesso:', new Date(KB_CACHE.updatedAt).toISOString());
  } catch (err) {
    console.error('[KB] Erro ao atualizar:', err);
  }
}

async function ensureKB() {
  const stale = Date.now() - (KB_CACHE.updatedAt || 0) > KB_TTL_MS;
  if (!KB_CACHE.text || stale) {
    await rebuildKB();
  }
}

// ======= Classificação simples de “papel” =======
// Heurística rápida; se quiser, evoluímos para uma pequena chamada de classificação.
function detectRole(userText = '') {
  const t = userText.toLowerCase();
  // gatilhos simples; a IA ainda pode adaptar pelo contexto
  if (/(cronograma|escopo|riscos|stakeholder|entregas|sprint|roadmap)/.test(t)) return 'Gerente de Projetos';
  if (/(diagnóstico|mapeamento|processo|requisitos|levantamento|análise)/.test(t)) return 'Analista de Projetos';
  if (/(agendar|marcar|documentos|proposta|contato|reunião|agenda)/.test(t)) return 'Secretária / Assistente';
  return 'Consultor BRYNIX';
}

// ======= Prompt (tom de voz + papéis) =======
function buildSystemPrompt(role) {
  return `
Você é ${role} da BRYNIX.
Fale como um(a) consultor(a) executivo(a): direto, claro, estruturado, sem formalidade excessiva.
Mantenha leveza e humor pontual, mas preserve foco e objetividade.
Seja proativo: sugira próximos passos, peça confirmações quando fizer sentido.
Quando a pergunta for vaga, esclareça com 1–2 perguntas curtas.
Nunca invente fatos; use o contexto BRYNIX e o conhecimento de páginas (KB) abaixo.
Termine respostas longas com um micro-resumo em 1 linha quando útil.
`;
}

// ======= Geração de resposta principal (usada pelo WhatsApp) =======
async function generateReply(userText, meta = {}) {
  await ensureKB();

  const role = detectRole(userText);
  const system = buildSystemPrompt(role);

  const contextPack = `
[Contexto fixo]
${BRYNIX_CONTEXT}

[Conteúdo resumido do site (KB)]
${KB_CACHE.text || '(KB ainda não carregado)'}
`;

  // Aqui usamos o modelo principal (ajuste se quiser outro):
  const response = await openai.responses.create({
    model: 'gpt-5',
    input: [
      { role: 'system', content: system },
      {
        role: 'system',
        content:
          `Use estritamente o contexto a seguir. Se algo não estiver no contexto, responda de forma neutra e transparente.\n` +
          `Metadados do usuário (pode ajudar no tom): ${JSON.stringify(meta)}\n\n` +
          `${contextPack}`,
      },
      {
        role: 'user',
        content:
          `Mensagem do usuário:\n"""${userText}"""\n` +
          `Responda como ${role} da BRYNIX.`,
      },
    ],
  });

  const text = response.output_text?.trim() || 'Certo! Pode me dizer um pouco mais?';
  return text;
}

// ======= Rota utilitária para forçar refresh do KB =======
async function refreshKB() {
  await rebuildKB();
  return {
    updatedAt: KB_CACHE.updatedAt,
    size: (KB_CACHE.text || '').length,
  };
}

module.exports = {
  generateReply,
  refreshKB,
};
