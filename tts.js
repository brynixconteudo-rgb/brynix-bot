// tts.js (OpenAI)
// Gera áudio (MP3) a partir de texto usando a API de TTS da OpenAI.
// Requisitos:
//   - ENV OPENAI_API_KEY
//   - (opcional) ENV TTS_MODEL      -> default: gpt-4o-mini-tts
//   - (opcional) ENV TTS_VOICE      -> default: alloy
//   - (opcional) ENV TTS_FORMAT     -> default: mp3
//
// Uso: const { synthesize } = require('./tts'); const audio = await synthesize('texto', { voice: 'alloy' });
// Retorno: { mime: 'audio/mpeg', buffer: <Buffer> }  ou  null se falhar.

const OpenAI = require('openai');

const apiKey    = process.env.OPENAI_API_KEY || '';
const TTS_MODEL = process.env.TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_VOICE = process.env.TTS_VOICE || 'alloy';
const TTS_FORMAT= (process.env.TTS_FORMAT || 'mp3').toLowerCase();

let openai = null;
if (apiKey) openai = new OpenAI({ apiKey });

/** Converte texto em áudio (Buffer). */
async function synthesize(text, opts = {}) {
  try {
    if (!openai) {
      console.warn('[TTS] OPENAI_API_KEY ausente; TTS desativado.');
      return null;
    }
    const voice  = (opts.voice || TTS_VOICE || 'alloy').trim();
    const format = ['mp3','wav','flac','ogg'].includes(TTS_FORMAT) ? TTS_FORMAT : 'mp3';

    const resp = await openai.audio.speech.create({
      model: TTS_MODEL,
      voice,
      input: String(text || ''),
      format, // mp3|wav|flac|ogg
    });

    // SDK retorna um web stream / arrayBuffer
    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const mime =
      format === 'wav'  ? 'audio/wav'  :
      format === 'flac' ? 'audio/flac' :
      format === 'ogg'  ? 'audio/ogg'  : 'audio/mpeg';

    return { mime, buffer };
  } catch (e) {
    console.error('[TTS] synthesize erro:', e?.message || e);
    return null;
  }
}

module.exports = { synthesize };
