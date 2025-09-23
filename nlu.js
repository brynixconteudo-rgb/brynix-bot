// nlu.js
// NLU leve, baseado em regex, com suporte a variações PT-BR.
// Exporta INTENTS e a função parse(text) -> { intent, note? }

const INTENTS = {
  MENU: 'MENU',
  HELP: 'HELP',
  SUMMARY: 'SUMMARY',
  SUMMARY_BRIEF: 'SUMMARY_BRIEF',
  SUMMARY_FULL: 'SUMMARY_FULL',
  NEXT: 'NEXT',
  LATE: 'LATE',
  REMIND_NOW: 'REMIND_NOW',
  NOTE: 'NOTE',
  WHO: 'WHO',
  MUTE_ON: 'MUTE_ON',
  MUTE_OFF: 'MUTE_OFF',
};

// util: normaliza e remove acentos para regex simples
function norm(s = '') {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function parse(text = '') {
  const raw = text || '';
  const t = norm(raw);

  // ===== MENU / AJUDA =====
  // cobre: /menu | menu | ajuda | help
  if (/^\/?menu\b/.test(t) || /\b(ajuda|help)\b/.test(t)) {
    return { intent: INTENTS.MENU };
  }
  // Alguns pedidos de "como funciona", "o que vc faz", etc. mandam pro help/menu
  if (/\b(como funciona|o que voce faz|o que vc faz|manual|tutorial)\b/.test(t)) {
    return { intent: INTENTS.MENU };
  }

  // ===== HELP =====
  if (/^\/?help\b/.test(t) || /^\/?ajuda\b/.test(t)) {
    return { intent: INTENTS.HELP };
  }

  // ===== SUMMARY =====
  // /summary (padrão = completo)
  if (/^\/?summary\b/.test(t)) {
    return { intent: INTENTS.SUMMARY };
  }
  // Resumo curto vs completo por linguagem natural
  if (/\b(resumo curto|resumo rapido|resumo rápido|resumo breve)\b/.test(t)) {
    return { intent: INTENTS.SUMMARY_BRIEF };
  }
  if (/\b(resumo completo|status completo|status geral|relatorio completo|relatório completo)\b/.test(t)) {
    return { intent: INTENTS.SUMMARY_FULL };
  }
  if (/\b(resumo|status|como estamos|panorama)\b/.test(t)) {
    // fallback: se pediu "resumo" sem qualificador, mandar completo
    return { intent: INTENTS.SUMMARY };
  }

  // ===== NEXT (hoje/amanhã) =====
  if (/^\/?next\b/.test(t)) {
    return { intent: INTENTS.NEXT };
  }
  if (/\b(o que vence hoje|entregas de hoje|prazo de hoje|para hoje|hoje|amanha|amanhã|proximas|próximas|proximos|próximos)\b/.test(t)) {
    return { intent: INTENTS.NEXT };
  }

  // ===== LATE (atrasadas) =====
  if (/^\/?late\b/.test(t) || /\b(atrasadas?|em atraso|pendencias atrasadas)\b/.test(t)) {
    return { intent: INTENTS.LATE };
  }

  // ===== REMIND NOW =====
  if (/^\/?remind\s+now\b/.test(t) || /\bdispara(r)? lembrete agora\b/.test(t)) {
    return { intent: INTENTS.REMIND_NOW };
  }

  // ===== NOTE =====
  // /note <texto>  |  "anotar ...", "registra nota ..."
  const noteSlash = raw.match(/^\/note\s+(.+)/i);
  if (noteSlash) {
    return { intent: INTENTS.NOTE, note: noteSlash[1].trim() };
  }
  const noteFree = raw.match(/\b(anota(r)?|registra(r)? nota|cria(r)? nota)\b[:\-\s]+(.+)/i);
  if (noteFree) {
    // pega o texto após a expressão
    const captured = noteFree[5] || noteFree[3] || '';
    if (captured.trim()) return { intent: INTENTS.NOTE, note: captured.trim() };
    return { intent: INTENTS.NOTE };
  }

  // ===== WHO =====
  if (/^\/?who\b/.test(t) || /\b(participantes|quem esta no projeto|quem está no projeto|quem esta|quem está)\b/.test(t)) {
    return { intent: INTENTS.WHO };
  }

  // ===== MUTE =====
  if (/^\/?mute\s*on\b/.test(t) || /\b(silencio\s*on|silenciar bot|ficar em silencio)\b/.test(t)) {
    return { intent: INTENTS.MUTE_ON };
  }
  if (/^\/?mute\s*off\b/.test(t) || /\b(silencio\s*off|tirar silencio|voltar a falar|desmutar)\b/.test(t)) {
    return { intent: INTENTS.MUTE_OFF };
  }

  // fallback: ajuda
  return { intent: INTENTS.HELP };
}

module.exports = { INTENTS, parse };
