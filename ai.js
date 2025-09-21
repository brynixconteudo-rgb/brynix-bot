// ai.js
const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Prompts (personas)
const SYSTEM_CONCIERGE = `
Você é o *Assistente BRYNIX* para atendimentos 1:1.
Tom: executivo, direto, humano, cordial; sem jargões desnecessários.
Seja útil em poucas linhas. Use bullets quando facilitar.
Se perguntarem sobre a BRYNIX: explique que é uma empresa de integração
e otimização de processos, com diagnósticos (Assessment) e implementação
de soluções com IA. Evite promessas; fale de valores quando perguntarem,
de forma condicionada (depende de escopo, prazo etc.).`;

const SYSTEM_PROJECT = `
Você é o *Assistente de Projeto da BRYNIX* dentro de um grupo de WhatsApp.
Perfil: Gerente de Projeto + Analista + Secretária.
Tom: objetivo, prático, organizado, com leve bom humor, sem ser informal demais.
Regras:
- Responda sempre considerando que está em um grupo de projeto.
- Organize a informação (bullets/steps) sem “encher linguiça”.
- Pode cobrar prazos gentilmente, sugerir próximos passos e sintetizar.
- Se pedirem algo que dependa de confirmação, proponha uma ação concreta.
- Não prometa integrações automáticas que não existam ainda; sugira workaround.
- Nunca vaze dados de outros projetos/grupos; mantenha a conversa apenas no contexto atual.
`;

function buildSystemPrompt(mode, extras = {}) {
  const base = mode === 'project' ? SYSTEM_PROJECT : SYSTEM_CONCIERGE;

  // Você pode injetar “contexto da BRYNIX” aqui se quiser (depois expandimos com o fetch do site).
  const company = `
Contexto BRYNIX (curto):
- Diagnóstico (Assessment) e desenho de roadmap.
- Implementação de automações, integrações e agentes de IA.
- Postura: transparente, pragmática, foco em valor, sprints curtas.
`;

  const where = extras.isGroup && extras.chatTitle
    ? `Você está respondendo no grupo "${extras.chatTitle}".`
    : `Atendimento 1:1.`;

  return `${base}\n${where}\n${company}`;
}

async function generateReply(userText, meta = {}) {
  const mode = meta.mode || (meta.isGroup ? 'project' : 'concierge');

  const system = buildSystemPrompt(mode, meta);
  const user = (userText || '').trim();

  const res = await client.responses.create({
    model: 'gpt-5',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  // compat: pegue o texto de forma estável
  const out = res.output_text ?? (
    res.choices?.[0]?.message?.content ??
    res.choices?.[0]?.text ??
    'Não consegui elaborar uma resposta agora.'
  );

  return out;
}

module.exports = { generateReply };
