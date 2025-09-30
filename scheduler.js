// scheduler.js
// Dispara lembretes diários/semanal por planilha: lê Dados_Projeto (Timezone, DailyReminderTime, WeeklyWrap, QuietHours).
// Integra com whatsapp.js por um callback que enviará mensagens no grupo.

const { readProjectMeta, readTasks, buildStatusSummary, appendLog } = require('./sheets');

function parseQuietHours(s) {
  // "20:00–08:00" ou "20:00-08:00"
  const m = (s || '').replace('–','-').split('-').map(a => a.trim());
  if (m.length !== 2) return null;
  return { start: m[0], end: m[1] };
}

function inQuietHours(nowLocal, qh) {
  if (!qh) return false;
  const [sh, sm] = qh.start.split(':').map(Number);
  const [eh, em] = qh.end.split(':').map(Number);
  const start = new Date(nowLocal); start.setHours(sh, sm||0, 0, 0);
  const end   = new Date(nowLocal); end.setHours(eh, em||0, 0, 0);
  if (start < end) return nowLocal >= start && nowLocal <= end;
  // período cruzando meia-noite
  return (nowLocal >= start) || (nowLocal <= end);
}

function atTime(nowLocal, hhmm) {
  if (!hhmm) return false;
  const [h, m] = hhmm.split(':').map(Number);
  return nowLocal.getHours() === h && nowLocal.getMinutes() === (m||0);
}

function isWeeklyHit(nowLocal, spec) {
  // "FRI 17:30"
  const m = (spec || '').split(/\s+/);
  if (m.length < 1) return false;
  const wd = m[0].toUpperCase();
  const time = m[1] || '17:30';
  const days = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  return days[nowLocal.getDay()] === wd && atTime(nowLocal, time);
}

function toLocal(nowUTC, tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
    const p = fmt.formatToParts(nowUTC).reduce((o, p) => (o[p.type]=p.value, o), {});
    return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00`);
  } catch {
    return new Date(nowUTC);
  }
}

function createScheduler({ getBindings, sendToGroup, tts }) {
  let tick = 0;

  return async function schedulerTick() {
    tick++;
    const utcNow = new Date();

    const bindings = getBindings(); // [{ sheetId, groupId, projectName }]
    for (const b of bindings) {
      try {
        const meta = await readProjectMeta(b.sheetId);
        const tz = meta.Timezone || 'America/Sao_Paulo';
        const localNow = toLocal(utcNow, tz);
        const qh = parseQuietHours(meta.QuietHours || '');

        if (qh && inQuietHours(localNow, qh)) continue;

        // daily
        if (atTime(localNow, meta.DailyReminderTime || '09:00')) {
          const tasks = await readTasks(b.sheetId);
          const text = buildStatusSummary(meta.ProjectName || b.projectName, tasks);
          await sendToGroup(b.groupId, text, { sheetId: b.sheetId, type: 'daily' });
          await appendLog(b.sheetId, { tipo:'daily', autor:'bot', msg:'Resumo diário enviado', arquivo:'', link:'', obs:'' });
          if ((meta.TTS_Enabled || '').toUpperCase() === 'TRUE' && tts) {
            const audio = await tts(`Resumo diário do projeto ${meta.ProjectName || b.projectName}. ${tasks.length} tarefas ativas.`);
            if (audio) await sendToGroup(b.groupId, audio, { sheetId: b.sheetId, type: 'daily-tts', audio:true });
          }
        }

        // weekly
        if (isWeeklyHit(localNow, meta.WeeklyWrap || 'FRI 17:30')) {
          const tasks = await readTasks(b.sheetId);
          const text = `*${meta.ProjectName || b.projectName} — Fechamento semanal*\n\n` + buildStatusSummary(meta.ProjectName || b.projectName, tasks);
          await sendToGroup(b.groupId, text, { sheetId: b.sheetId, type: 'weekly' });
          await appendLog(b.sheetId, { tipo:'weekly', autor:'bot', msg:'Resumo semanal enviado', arquivo:'', link:'', obs:'' });
        }
      } catch (e) {
        console.log('[scheduler] erro', e?.message || e);
      }
    }
  };
}

module.exports = { createScheduler };
