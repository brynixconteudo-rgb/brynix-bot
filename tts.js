// tts.js
// Síntese de voz usando Google Cloud Text-to-Speech (pt-BR).
// Usa credenciais de Service Account do env GOOGLE_SA_JSON.
// VARS (Render):
//   - GOOGLE_SA_JSON            -> JSON da service account (string inteira)
//   - TTS_VOICE                 -> nome da voz (ex.: "pt-BR-Neural2-A")
//   - TTS_SPEAKING_RATE         -> opcional (ex.: "1.0")
//   - TTS_PITCH                 -> opcional (ex.: "0.0")

const tts = require('@google-cloud/text-to-speech');

function readSA() {
  const raw = process.env.GOOGLE_SA_JSON || '';
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Se colaram com quebras, tenta normalizar
    try {
      return JSON.parse(raw.replace(/\n/g, '\\n'));
    } catch {
      return null;
    }
  }
}

const sa = readSA();
let client = null;
if (sa) {
  client = new tts.TextToSpeechClient({
    credentials: {
      client_email: sa.client_email,
      private_key: sa.private_key,
    },
    projectId: sa.project_id,
  });
}

// text -> { mime, buffer } | null
async function synthesize(text, opts = {}) {
  try {
    if (!client) {
      console.warn('[TTS] Sem GOOGLE_SA_JSON; TTS desativado.');
      return null;
    }

    const voiceName = (opts.voice || process.env.TTS_VOICE || 'pt-BR-Neural2-A').trim();
    // Heurística simples para a languageCode (todas pt-BR-* usam "pt-BR")
    const languageCode = voiceName.startsWith('pt-') ? 'pt-BR' : 'pt-BR';

    const speakingRate = Number(process.env.TTS_SPEAKING_RATE || opts.speakingRate || '1.0');
    const pitch = Number(process.env.TTS_PITCH || opts.pitch || '0.0');

    const request = {
      input: { text: String(text || '') },
      voice: {
        languageCode,
        name: voiceName, // ex.: "pt-BR-Neural2-A"
        ssmlGender: 'FEMALE', // ajuda a escolher timbre quando a voz não for explicitada
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate,
        pitch,
      },
    };

    const [response] = await client.synthesizeSpeech(request);
    const audioContent = response.audioContent;
    if (!audioContent) return null;

    return {
      mime: 'audio/mpeg',
      buffer: Buffer.from(audioContent, 'base64'),
    };
  } catch (e) {
    console.error('[TTS] synthesize erro:', e?.message || e);
    return null;
  }
}

module.exports = { synthesize };
