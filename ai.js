// ai.js
const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------- helpers de formatação ----------
function asMenu(triggers = []) {
  const gatilhosVisiveis = triggers.filter(t => t.startsWith('/'));
  return [
    '📋 *Menu rápido*',
    '— Use @bot ou um dos comandos abaixo no grupo.',
    '',
    `• */status* — visão geral do projeto (mock)`,
    `• */tarefas* — tarefas do dia (mock)`,
    `• */hoje* — lembretes do dia (mock)`,
    `• */ajuda* — este menu`,
    '',
    gatilhosVisiveis.length
      ? `Gatilhos ativos: ${gatilhosVisiveis.join(', ')}`
      : ''
  ].join('\n');
}

function mockStatus() {
  return [
    '📊 *Status (mock)*',
    'Projeto: _Pendente de vinculação à planilha_',
    'Fase atual: Descoberta/Assessment',
    'Entregas foco: mapeamento de dados, entrevistas, quick wins',
    'Riscos: definição de fontes de dados e acesso a sistemas',
    'Próximos passos: validar planilha fonte, conectar Sheets ao bot',
  ].join('\n');
}

function mockTarefas() {
  return [
    '🗓️ *Tarefas de hoje (mock)*',
    '• Rafael — Consolidar checklist de documentos (P)',
    '• Sueli — Validar agenda de entrevistas (M)',
    '• Paulo — Criar planilha base do projeto no GDrive (A)',
    '_Obs.: assim que conectarmos à planilha, estes dados virão de fonte real._',
  ].join('\n');
}

function mockHoje() {
  return [
    '⏰ *Lembretes de hoje (mock)*',
    '• 10:00 — Checagem de pendências do checklist',
    '• 16:30 — Alinhamento rápido com time comercial',
    '_Quando a planilha estiver conectada, horários e itens virão dela._',
  ].join('\n');
}

// ---------- system prompt ----------
function buildSystem(isGroup, botName) {
  // Contexto institucional mínimo — enxuto, sem “palestra”
  const brynix = [
    'Você é o Assistente BRYNIX.',
    'Missão: acelerar resultados com IA prática para PMEs, com foco em eficiência gerencial, automação e geração de receita.',
    'Estilo: executivo, claro, cordial; objetivo por padrão; use bom humor leve quando adequado.',
  ].join(' ');

  const regrasGrupo = [
    'No *grupo*: seja breve e prático.',
    'Só responda se acionado por menção (@) ou comando (/), pois a orquestração já filtra.',
    'Mantenha o foco no projeto; se a pergunta fugir do escopo, responda rapidamente e convide a usar `/ajuda` para opções.',
  ].join(' ');

  const regrasPrivado = [
    'No *1:1*: pode expandir um pouco, ainda assim seja objetivo.',
  ].join(' ');

  const limites = [
    'Se não souber, diga o que precisa para responder.',
    'Evite inventar nomes de pessoas, projetos ou números.',
  ].join(' ');

  return [
    `Nome do bot: ${botName || 'Brynix Bot'}.`,
    brynix,
    isGroup ? regrasGrupo : regrasPrivado,
    limites,
  ].join('\n');
}

// ---------- tratadores de comandos (/...) ----------
async function handleSlashCommand(text, ctx) {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase();

  switch (cmd) {
    case '/ajuda':
      return asMenu(ctx.triggers || []);
    case '/status':
      return mockStatus();
    case '/tarefas':
      return mockTarefas();
    case '/hoje':
      return mockHoje();
    default:
      // volta um help rápido
      return `Comando não reconhecido. Use */ajuda* para ver opções.`;
  }
}

// ---------- geração principal ----------
async function generateReply(userText, ctx = {}) {
  try {
    const { isGroup, botName, triggers } = ctx;
    const text = (userText || '').trim();

    // comandos têm prioridade
    if (text.startsWith('/')) {
      return await handleSlashCommand(text, { isGroup, botName, triggers });
    }

    const system = buildSystem(!!isGroup, botName);

    const messages = [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          `Contexto: ${isGroup ? 'grupo de projeto' : 'conversa 1:1'}.`,
          'Se a pergunta for fora de escopo em grupo, responda curto e convide a usar /ajuda.',
          `Gatilhos disponíveis: ${(triggers || []).join(', ') || '(nenhum informado)'}.`,
          '',
          `Pergunta: "${text}"`,
        ].join('\n')
      }
    ];

    const resp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: isGroup ? 0.4 : 0.5,
      max_tokens: isGroup ? 220 : 320,
      messages,
    });

    let out = (resp.choices?.[0]?.message?.content || '').trim();

    // Em grupo, garanta concisão
    if (isGroup) {
      // Se a resposta ficou muito longa, dá uma versão resumida
      if (out.length > 600) {
        out = out.slice(0, 580) + '…';
      }
    }

    return out || 'Ok.';
  } catch (err) {
    console.error('[AI] Erro generateReply:', err);
    return 'Tive um problema técnico agora. Pode repetir em poucas palavras?';
  }
}

module.exports = { generateReply };
