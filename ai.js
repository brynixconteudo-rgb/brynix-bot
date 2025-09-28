// ai.js
const { Configuration, OpenAIApi } = require('openai');
const config = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
const openai = new OpenAIApi(config);

async function generateReply(text, ctx={}) {
  const mode = ctx.mode || 'BRYNIX';

  if (mode==='BRYNIX') {
    const prompt = `
Você é o assistente oficial da BRYNIX, falando em 1:1 no WhatsApp.
Seu tom deve ser consultivo, amigável, objetivo, com títulos em **negrito**, listas com bullets e 1 emoji por bloco (sem exagero).
Responda apenas dentro do escopo BRYNIX: ofertas, metodologia, IA aplicada a negócios, diagnóstico inteligente.
Se for algo fora, responda: "_Esse assunto foge um pouco do escopo. Posso te explicar sobre nossas soluções em IA e como aplicamos na prática!_"

Contexto BRYNIX:
- **Quem somos**: empresa focada em acelerar resultados de pequenas e médias empresas com inteligência artificial.
- **Ofertas**:
  1. **Diagnóstico Inteligente** — mapeia ambiente, processos e oportunidades de IA.
  2. **Automação & Copilotos** — cria copilotos de negócio e fluxos inteligentes para eficiência.
  3. **Growth com IA** — estratégias de geração de receita e expansão.
- **Metodologia**: começamos com diagnóstico, seguimos para roadmap, entregamos quick wins e estruturamos transformação.
- **Estilo**: direto, consultivo, estruturado, sem parecer robótico.

Pergunta do usuário: "${text}"
`;

    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      messages: [{ role:'system', content: prompt }]
    });
    return resp.data.choices[0].message.content.trim();
  }

  // fallback
  return "Não entendi bem. Pode reformular?";
}

module.exports={ generateReply };
