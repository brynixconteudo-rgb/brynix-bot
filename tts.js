// tts.js (Google Cloud Text-to-Speech)
// ENV necessários:
//  - GOOGLE_TTS_SA_JSON   (conteúdo JSON da Service Account)  *ou*
//  - GOOGLE_APPLICATION_CREDENTIALS (caminho para o JSON no disco)
// Opcionais:
//  - TTS_VOICE           (default: pt-BR-Neural2-A)
//  - TTS_SPEAKING_RATE   (default: 1.0)

const textToSpeech = require('@google-cloud/text-to-speech');

function buildGCPTTSClient() {
  // 1) Preferimos GOOGLE_TTS_SA_JSON (conteúdo em texto)
  const saJson = process.env.GOOGLE_TTS_SA_JSON || '';
  let client;
  if (saJson) {
    try {
      const creds = JSON.parse(saJson);
      client = new textToSpeech.TextToSpeechClient({ credentials: creds });
      return client;
    } catch (e) {
      console.error('[TTS] Falha ao parsear GOOGLE_TTS_SA_JSON:', e?.message || e);
    }
  }

  // 2) Alternativa: GOOGLE_APPLICATION_CREDENTIALS (caminho no filesystem)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      client = new textToSpeech.TextToSpeechClient();
      return client;
    } catch (e) {
      console.error('[TTS] Erro ao criar cliente GCP TTS (por arquivo):', e?.message || e);
    }
  }

  console.warn('[TTS] Sem credenciais do Google TTS; sintetizador desativado.');
  return null;
}

const client = buildGCPTTSClient();

async function synthesize(text, opts = {}) {
  try {
    if (!client) return null;

    const voiceName = process.env.TTS_VOICE || opts.voice || 'pt-BR-Neural2-A';
    const speakingRate = parseFloat(process.env.TTS_SPEAKING_RATE || '1.0');

    const request = {
      input: { text: text || '' },
      // Voz pt-BR natural; se quiser outra, ajuste voiceName
      voice: {
        name: voiceName,           // ex: 'pt-BR-Neural2-A'
        languageCode: 'pt-BR',     // força idioma
        ssmlGender: 'FEMALE',      // ajuda a guiar o timbre feminino
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: isNaN(speakingRate) ? 1.0 : speakingRate, // 0.25–4.0
      },
    };

    const [response] = await client.synthesizeSpeech(request);
    if (!response || !response.audioContent) {
      console.warn('[TTS] Resposta sem audioContent.');
      return null;
    }

    return { mime: 'audio/mpeg', buffer: Buffer.from(response.audioContent, 'base64') };
  } catch (e) {
    console.error('[TTS] synthesize erro:', e?.message || e);
    return null;
  }
}

module.exports = { synthesize };
