// scheduler.js
// Tick minutely: lê LINKS_DB_PATH => { chatId: {sheetId, projectName} }
// para cada projeto: lê config (sheets), decide disparos diário/semanal,
// gera resumo texto e (opcional) áudio TTS e envia via WhatsApp.

const fs = require('fs');
const path = require('path');
const { readProjectConfig, readTasks, buildStatusSummary } = require('./sheets');
const { synthesize } = require('./tts');
const { uploadBufferToProject } = require('./drive');

// whatsapp bridge (exposto por whatsapp.js)
let _wa = null;
function bindWhatsApp(waApi) { _wa = waApi; }

function readLinksDb() {
  const fp = process.env.LINKS_DB_PATH || '/var/data/links.json';
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return {}; }
}

function nowPartsTZ(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = t => parts.find(p => p.type === t)?.value || '';
  return {
    wd: get('weekday').toUpperCase().slice(0,3), // MON TUE ...
    hh: get('hour').padStart(2,'0'),
    mm: get('minute').padStart(2,'0'),
  };
}

function inQuietHours(quietHours, hhmm) {
  // quietHours ex: "20:00-08:00"
  const m = quietHours.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!m) return false;
  const start = +m[1] * 60 + +m[2];
  const end   = +m[3] * 60 + +m[4];
  const now   = +(hhmm.slice(0,2)) * 60 + +(hhmm.slice(3,5));
  if (start <= end) return now >= start && now < end;     // dentro do mesmo dia
  return now >= start || now < end;                       // madrugada
}

// memoria anti-duplicação por minuto
const lastShot = new Map(); // key: chatId|type => 'YYYYMMDDHHmm'

function stampKey(chatId, type, tz, hh, mm) {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' })
               .format(new Date()).replace(/-/g,'');
  return `${chatId}|${type}|${d}${hh}${mm}`;
}

async function fireDaily(chatId, link, cfg) {
  const tasks = await readTasks(link.sheetId);
  const txt = buildStatusSummary(cfg.ProjectName, tasks);

  // envia texto
  await _wa.sendText(chatId, txt);

  // salva .md + opcional TTS
  const md = `# Resumo Diário — ${cfg.ProjectName}\n\n${txt}\n`;
  await uploadBufferToProject(link, 'Resumos/Diario',
    `${cfg.ProjectName}-Diario-${Date.now()}.md`, 'text/markdown', Buffer.from(md));

  if (cfg.TTS_Enabled) {
    const audio = await synthesize(txt, cfg.TTS_Voice);
    await _wa.sendAudio(chatId, audio, 'audio/ogg');
    await uploadBufferToProject(link, 'Resumos/Diario',
      `${cfg.ProjectName}-Diario-${Date.now()}.ogg`, 'audio/ogg', audio);
  }
}

function buildWeeklyText(cfg, tasks) {
  const B = s => `*${s}*`;
  const I = s => `_${s}_`;
  const total = tasks.length;
  const concl = tasks.filter(t => /conclu/i.test(t.status||'')).length;
  const pend = total - concl;
  const atras = tasks.filter(t => /atrasad/i.test(t.status||'')).length;

  return `${B(`Encerramento da Sprint — ${cfg.ProjectName}`)}

${B('Objetivos')}:
${cfg.ProjectObjectives || '—'}

${B('Benefícios esperados')}:
${cfg.ProjectBenefits || '—'}

${B('Andamento')}:
• Total: ${total}
• Concluídas: ${concl}
• Pendentes: ${pend}
• Atrasadas: ${atras}

${I('Timeline estimada')}: ${cfg.ProjectTimeline || '—'}

_${I('Próxima sprint será preparada automaticamente. Conte comigo!')}_`;
}

async function fireWeekly(chatId, link, cfg) {
  const tasks = await readTasks(link.sheetId);
  const txt = buildWeeklyText(cfg, tasks);

  await _wa.sendText(chatId, txt);

  const md = `# Encerramento Semanal — ${cfg.ProjectName}\n\n${txt}\n`;
  await uploadBufferToProject(link, 'Resumos/Semanal',
    `${cfg.ProjectName}-Semanal-${Date.now()}.md`, 'text/markdown', Buffer.from(md));

  if (cfg.TTS_Enabled) {
    const audio = await synthesize(txt, cfg.TTS_Voice);
    await _wa.sendAudio(chatId, audio, 'audio/ogg');
    await uploadBufferToProject(link, 'Resumos/Semanal',
      `${cfg.ProjectName}-Semanal-${Date.now()}.ogg`, 'audio/ogg', audio);
  }
}

function parseWeeklyWrap(s) {
  // ex: "FRI 17:30"
  const m = (s || '').trim().match(/^([A-Z]{3})\s+(\d{2}):(\d{2})$/i);
  if (!m) return null;
  return { wd: m[1].toUpperCase(), hh: m[2], mm: m[3] };
}

function tickOnce() {
  const links = readLinksDb();
  const entries = Object.entries(links); // [chatId, {sheetId, projectName}]
  if (!entries.length || !_wa) return;

  for (const [chatId, link] of entries) {
    (async () => {
      try {
        const cfg = await readProjectConfig(link.sheetId);
        const { wd, hh, mm } = nowPartsTZ(cfg.Timezone);
        const hhmm = `${hh}:${mm}`;

        // quiet hours?
        if (cfg.QuietHours && inQuietHours(cfg.QuietHours, hhmm)) return;

        // diário
        const [dailyH, dailyM] = (cfg.DailyReminderTime || '09:00').split(':');
        if (hh === dailyH && mm === dailyM) {
          const key = stampKey(chatId, 'DAILY', cfg.Timezone, hh, mm);
          if (!lastShot.has(key)) {
            lastShot.set(key, true);
            await fireDaily(chatId, link, cfg);
          }
        }

        // semanal
        const ww = parseWeeklyWrap(cfg.WeeklyWrap);
        if (ww && wd === ww.wd && hh === ww.hh && mm === ww.mm) {
          const key = stampKey(chatId, 'WEEKLY', cfg.Timezone, hh, mm);
          if (!lastShot.has(key)) {
            lastShot.set(key, true);
            await fireWeekly(chatId, link, cfg);
          }
        }
      } catch (e) {
        console.error('[scheduler] erro:', e.message || e);
      }
    })();
  }
}

function startScheduler(waApi) {
  bindWhatsApp(waApi);
  // roda a cada 60s
  setInterval(tickOnce, 60 * 1000);
  console.log('[scheduler] iniciado (tick=60s)');
}

module.exports = { startScheduler };
