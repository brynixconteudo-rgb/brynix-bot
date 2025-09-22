// nlu.js
const INTENTS = {
  HELP: 'help',
  SUMMARY: 'summary',
  SUMMARY_BRIEF: 'summary_brief',
  SUMMARY_FULL: 'summary_full',
  NEXT: 'next',
  LATE: 'late',
  REMIND_NOW: 'remind_now',
  NOTE: 'note',
  WHO: 'who',
  MUTE_ON: 'mute_on',
  MUTE_OFF: 'mute_off'
};

function normalize(t) {
  return (t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAfter(patterns, text) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

function parse(text) {
  const raw = text || '';
  const t = normalize(raw);

  // comandos explícitos
  if (t.startsWith('/help')) return { intent: INTENTS.HELP };
  if (t.startsWith('/summary')) return { intent: INTENTS.SUMMARY };
  if (t.startsWith('/next')) return { intent: INTENTS.NEXT };
  if (t.startsWith('/late')) return { intent: INTENTS.LATE };
  if (t.startsWith('/remind now') || t.startsWith('/remind agora')) return { intent: INTENTS.REMIND_NOW };
  if (t.startsWith('/note')) {
    const note = raw.replace(/^\s*\/note\s*/i, '').trim();
    return { intent: INTENTS.NOTE, note };
  }
  if (t.startsWith('/who')) return { intent: INTENTS.WHO };
  if (t.startsWith('/mute on') || t.startsWith('/silencio on')) return { intent: INTENTS.MUTE_ON };
  if (t.startsWith('/mute off') || t.startsWith('/silencio off')) return { intent: INTENTS.MUTE_OFF };

  // linguagem natural
  if (/(o que voce|vc) pode fazer|ajuda|como usar|menu|help/.test(t)) {
    return { intent: INTENTS.HELP };
  }

  // resumo curto / completo / genérico
  if (/(resumo curto|resumo rapido|versao curta|bem rapido)/.test(t)) {
    return { intent: INTENTS.SUMMARY_BRIEF };
  }
  if (/(resumo completo|detalhado|versao completa)/.test(t)) {
    return { intent: INTENTS.SUMMARY_FULL };
  }
  if (/(resumo do projeto|resumo|status geral|como estamos)/.test(t)) {
    return { intent: INTENTS.SUMMARY };
  }

  // próximos
  if (/(vence hoje|para hoje|de hoje|pro hoje|do dia|proximo(s)? passos|o que vem agora|whats next|what.s next)/.test(t)) {
    return { intent: INTENTS.NEXT };
  }

  // atrasadas
  if (/(atrasad|pendenc|em atraso)/.test(t)) {
    return { intent: INTENTS.LATE };
  }

  // lembrete agora
  if (/(manda (um )?lembrete agora|dispara o lembrete|remind now|agora o status)/.test(t)) {
    return { intent: INTENTS.REMIND_NOW };
  }

  // nota
  if (/(anota( ai)?|registra (uma )?nota|nota:)/.test(t)) {
    const note = extractAfter(
      [/anota(?: ai)?\s+(.*)$/i, /registra (?:uma )?nota\s+(.*)$/i, /nota:\s*(.*)$/i],
      raw
    );
    return { intent: INTENTS.NOTE, note };
  }

  // quem
  if (/(quem esta no projeto|quem participa|lista de membros|who)/.test(t)) {
    return { intent: INTENTS.WHO };
  }

  // mute
  if (/silencio (total|on)|ficar quieto|mute on/.test(t)) return { intent: INTENTS.MUTE_ON };
  if (/pode falar|mute off|tira o silencio/.test(t)) return { intent: INTENTS.MUTE_OFF };

  return { intent: null };
}

module.exports = { INTENTS, parse };
