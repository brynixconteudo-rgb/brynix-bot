// tts.js
// TTS opcional. Se não houver configuração adequada, retorna null.
// Implementação usando OpenAI (modelo TTS).
// VARS: OPENAI_API_KEY (obrigatória p/ TTS), TTS_MODEL (opcional; default gpt-4o-mini-tts)

const OpenAI = require('openai');

const apiKey = process.env.OPENAI_API_KEY || '';
const TTS_MODEL = process.env.TTS_MODEL || 'gpt-4o-mini-tts';

let openai = null;
if (apiKey) {
  openai = new OpenAI({ apiKey });
}

async function synthesize(text, opts = {}) {
  try {
    if (!openai) return null;
    const voice = opts.voice || 'alloy';

    // API de TTS do OpenAI – resposta como Buffer (mp3)
    const resp = await openai.audio.speech.create({
      model: TTS_MODEL,
      voice,
      input: text,
      format: 'mp3',
    });

    const arrayBuffer = await resp.arrayBuffer();
    return { mime: 'audio/mpeg', buffer: Buffer.from(arrayBuffer) };
  } catch (e) {
    console.error('[TTS] synthesize erro:', e?.message || e);
    return null;
  }
}

module.exports = { synthesize };
