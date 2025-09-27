// tts.js
// Text-to-Speech Google (usa GOOGLE_SA_JSON)
// Retorna Buffer OGG/Opus — perfeito p/ WhatsApp.

const { google } = require('googleapis');

function getTTSClient() {
  const raw = process.env.GOOGLE_SA_JSON;
  if (!raw) throw new Error('GOOGLE_SA_JSON ausente.');
  const sa = JSON.parse(raw.replace(/\n/g, '\\n'));
  const jwt = new google.auth.JWT(
    sa.client_email, null, sa.private_key,
    ['https://www.googleapis.com/auth/cloud-platform']
  );
  return google.texttospeech({ version: 'v1', auth: jwt });
}

/**
 * synthesize('Olá mundo', 'pt-BR-Neural2-A')
 * @returns {Promise<Buffer>} audio OGG_OPUS
 */
async function synthesize(text, voiceName = 'pt-BR-Neural2-A', speakingRate = 1.02) {
  const tts = getTTSClient();
  const request = {
    input: { text },
    voice: { languageCode: 'pt-BR', name: voiceName },
    audioConfig: { audioEncoding: 'OGG_OPUS', speakingRate },
  };
  const res = await tts.text.synthesize(request);
  const audio = res.data.audioContent;
  return Buffer.from(audio, 'base64');
}

module.exports = { synthesize };
