// Outils calendrier (.ics) — compatibles Outlook
// 1) Créer un rappel récurrent toutes les N semaines à importer dans Outlook
// 2) Lire un export de calendrier Outlook pour repérer les jours de déplacement

const pad = n => String(n).padStart(2, '0');
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function fmtLocal(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}
function fmtUTC(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'); }

export function buildReminderICS({ weekday = 5, time = '16:30', intervalWeeks = 2, appUrl = '' }) {
  const [h, m] = time.split(':').map(Number);
  const start = new Date();
  start.setHours(h, m, 0, 0);
  let delta = (weekday - start.getDay() + 7) % 7;
  if (delta === 0 && start < new Date()) delta = 7;
  start.setDate(start.getDate() + delta);
  const end = new Date(start.getTime() + 15 * 60000);
  const tz = 'Europe/Paris';
  const desc = `Prendre 5 minutes :\n1. Photographier les tickets restants (hôtel, resto, train, métro…)\n2. Vérifier dans le tableau que les notes du mois précédent sont remboursées\n${appUrl ? '\nOuvrir l\'application : ' + appUrl : ''}`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Notes de frais//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VTIMEZONE', `TZID:${tz}`,
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:notes-de-frais-rappel-${Date.now()}@local`,
    `DTSTAMP:${fmtUTC(new Date())}`,
    `DTSTART;TZID=${tz}:${fmtLocal(start)}`,
    `DTEND;TZID=${tz}:${fmtLocal(end)}`,
    `RRULE:FREQ=WEEKLY;INTERVAL=${intervalWeeks};BYDAY=${DAY_CODES[weekday]}`,
    'SUMMARY:🧾 Notes de frais : saisir et vérifier les remboursements',
    `DESCRIPTION:${esc(desc)}`,
    appUrl ? `URL:${appUrl}` : null,
    'TRANSP:TRANSPARENT',
    'CATEGORIES:Notes de frais',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Notes de frais', 'TRIGGER:-PT0M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean);
  return lines.join('\r\n');
}

// ---------- Lecture d'un export Outlook ----------
function unfold(text) { return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); }

function parseDate(prop, value) {
  // value : 20261028 | 20261028T090000 | 20261028T080000Z
  const y = +value.slice(0, 4), mo = +value.slice(4, 6) - 1, d = +value.slice(6, 8);
  if (value.length === 8 || /VALUE=DATE(?!-)/.test(prop)) return { date: new Date(y, mo, d), allDay: true };
  const h = +value.slice(9, 11), mi = +value.slice(11, 13);
  if (value.endsWith('Z')) return { date: new Date(Date.UTC(y, mo, d, h, mi)), allDay: false };
  return { date: new Date(y, mo, d, h, mi), allDay: false };
}

function unescape(s) { return (s || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim(); }

export function parseICS(text) {
  const lines = unfold(text).split('\n');
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur && cur.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const prop = line.slice(0, i), val = line.slice(i + 1);
    const name = prop.split(';')[0].toUpperCase();
    if (name === 'DTSTART') { const p = parseDate(prop, val); cur.start = p.date; cur.allDay = p.allDay; }
    else if (name === 'DTEND') cur.end = parseDate(prop, val).date;
    else if (name === 'SUMMARY') cur.summary = unescape(val);
    else if (name === 'LOCATION') cur.location = unescape(val);
    else if (name === 'RRULE') cur.rrule = val;
    else if (name === 'EXDATE') val.split(',').forEach(v => cur.exdates.push(dayKey(parseDate(prop, v).date)));
    else if (name === 'STATUS') cur.status = val;
    else if (name === 'X-MICROSOFT-CDO-BUSYSTATUS') cur.busy = val;
  }
  return events;
}

export function dayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function expand(ev, from, to) {
  const out = [];
  const spanDays = ev.end && ev.allDay ? Math.max(1, Math.round((ev.end - ev.start) / 86400000)) : 1;
  const pushOcc = d => {
    for (let k = 0; k < spanDays; k++) {
      const x = new Date(d); x.setDate(x.getDate() + k);
      if (x >= from && x <= to && !ev.exdates.includes(dayKey(d))) out.push(x);
    }
  };
  if (!ev.rrule) { pushOcc(ev.start); return out; }
  const r = Object.fromEntries(ev.rrule.split(';').map(p => p.split('=')));
  const interval = +(r.INTERVAL || 1);
  const until = r.UNTIL ? parseDate('', r.UNTIL).date : to;
  const count = r.COUNT ? +r.COUNT : Infinity;
  const end = until < to ? until : to;
  let n = 0;
  if (r.FREQ === 'DAILY') {
    for (let d = new Date(ev.start); d <= end && n < count; d.setDate(d.getDate() + interval), n++) pushOcc(new Date(d));
  } else if (r.FREQ === 'WEEKLY') {
    const days = r.BYDAY ? r.BYDAY.split(',').map(c => DAY_CODES.indexOf(c.slice(-2))) : [ev.start.getDay()];
    const weekStart = new Date(ev.start); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    for (let w = new Date(weekStart); w <= end && n < count; w.setDate(w.getDate() + 7 * interval)) {
      for (const wd of days.sort()) {
        const d = new Date(w); d.setDate(d.getDate() + wd);
        d.setHours(ev.start.getHours(), ev.start.getMinutes());
        if (d < ev.start || d > end || n >= count) continue;
        pushOcc(d); n++;
      }
    }
  } else {
    pushOcc(ev.start); // autres fréquences : seule la 1re occurrence
  }
  return out;
}

const VIRTUAL = /(teams|zoom|google meet|meet\.google|webex|skype|https?:\/\/|en ligne|visio|t[ée]l[ée]phone|bureau)/i;

// Renvoie { 'YYYY-MM-DD': ['Visite chantier — Lyon', ...] } pour les jours probables de déplacement
export function tripDays(events, { from, to, keywords = [] }) {
  const kw = keywords.map(k => k.trim().toLowerCase()).filter(Boolean);
  const map = {};
  for (const ev of events) {
    if (ev.status === 'CANCELLED') continue;
    const summary = ev.summary || '';
    const loc = ev.location || '';
    const physicalLoc = loc && !VIRTUAL.test(loc);
    const kwHit = kw.some(k => summary.toLowerCase().includes(k) || loc.toLowerCase().includes(k));
    if (!physicalLoc && !kwHit) continue;
    for (const d of expand(ev, from, to)) {
      const k = dayKey(d);
      (map[k] = map[k] || []).push(loc ? `${summary} — ${loc}` : summary);
    }
  }
  return map;
}
