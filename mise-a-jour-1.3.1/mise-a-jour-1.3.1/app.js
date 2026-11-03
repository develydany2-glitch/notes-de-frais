import { DB } from './db.js';
import * as Sync from './sync.js';
import { buildReminderICS, parseICS, tripDays, dayKey } from './ics.js';
import * as OCR from './ocr.js';

// ---------------------------------------------------------------- constantes
const CATS = [
  { id: 'hotel', label: 'Hôtel', ico: '🏨' },
  { id: 'restaurant', label: 'Restaurant', ico: '🍽️' },
  { id: 'boulangerie', label: 'Boulangerie', ico: '🥐' },
  { id: 'train', label: 'Train', ico: '🚆' },
  { id: 'metro', label: 'Métro / bus', ico: '🚇' },
  { id: 'taxi', label: 'Taxi / VTC', ico: '🚕' },
  { id: 'carburant', label: 'Carburant', ico: '⛽' },
  { id: 'peage', label: 'Péage', ico: '🛣️' },
  { id: 'parking', label: 'Parking', ico: '🅿️' },
  { id: 'avion', label: 'Avion', ico: '✈️' },
  { id: 'fournitures', label: 'Fournitures', ico: '🧰' },
  { id: 'autre', label: 'Autre', ico: '🧾' },
  // Paiement réel mais sans facture : gardé à part, jamais compté dans les remboursements
  { id: 'non_pris', label: 'Non pris en compte', ico: '⏸️' }
];
const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));
const NP = 'non_pris';
const isNP = e => e.category === NP;
const isIncomplete = e => !(e.amount > 0) || !e.category;
const MAX_PHOTOS = 6;
const photosOf = Sync.photosOf;
const STATUS = {
  a_declarer: 'À déclarer',
  declaree: 'Déclarée',
  remboursee: 'Remboursée'
};
const STATUS_ORDER = ['a_declarer', 'declaree', 'remboursee'];
const DEFAULT_KEYWORDS = 'chantier, visite, rdv, client, déplacement, installation, vérification, contrôle, salon, formation';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');
const eur = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const eurParts = n => { const s = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n); return s; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayKey = () => dayKey(new Date());
const monthKey = d => d.slice(0, 7);
const monthLabel = mk => { const [y, m] = mk.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }); };
const dateLabel = d => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }); };
const daysBetween = (a, b) => Math.round((b - a) / 86400000);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

let pendingPhoto = null;
let objectUrls = [];
function trackUrl(u) { objectUrls.push(u); return u; }
function releaseUrls() { objectUrls.forEach(u => URL.revokeObjectURL(u)); objectUrls = []; }

// ---------------------------------------------------------------- mises à jour de l'app
let swReg = null;
function offerUpdate(w) {
  if (!w || !navigator.serviceWorker.controller) return;
  toast('Nouvelle version disponible', { label: 'Mettre à jour', fn: () => w.postMessage('skipWaiting') }, { sticky: true });
}
async function checkForUpdate() {
  if (!swReg) return 'none';
  try { await swReg.update(); } catch (_) { return 'offline'; }
  await new Promise(r => setTimeout(r, 2500));
  const w = swReg.waiting || swReg.installing;
  if (w) { if (w.state === 'installed') w.postMessage('skipWaiting'); else offerUpdate(w); return 'found'; }
  return 'none';
}

// ---------------------------------------------------------------- toast
let toastTimer;
function toast(msg, action, opts = {}) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label; b.onclick = () => { action.fn(); t.classList.remove('show'); };
    t.appendChild(b);
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  if (!opts.sticky) toastTimer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2600);
}

// ---------------------------------------------------------------- photo
async function compressImage(file, max = 1600, quality = 0.72) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', quality));
  } finally { URL.revokeObjectURL(url); }
}

// Ouvre l'appareil photo ou la galerie ; renvoie la liste des fichiers choisis
function pickPhotos(source = 'camera', multiple = false) {
  return new Promise(resolve => {
    const input = source === 'camera' ? $('#cam') : $('#gal');
    input.multiple = source !== 'camera' && multiple;
    input.value = '';
    input.onchange = () => resolve(input.files ? [...input.files] : []);
    input.oncancel = () => resolve([]);
    input.click();
  });
}
const pickPhoto = source => pickPhotos(source).then(f => f[0] || null);

async function photoBlobOf(p) {
  let blob = await DB.getPhoto(p.id);
  if (!blob && p.path) { try { blob = await Sync.fetchPhoto(p); } catch (_) { blob = null; } }
  return blob;
}
async function photoUrlOf(p) {
  const b = await photoBlobOf(p);
  return b ? trackUrl(URL.createObjectURL(b)) : null;
}
async function photoUrl(e) {
  const p = photosOf(e)[0];
  return p ? photoUrlOf(p) : null;
}

// Visionneuse plein écran : glisser pour passer d'une photo à l'autre, enregistrer ou partager
function openGallery(srcs, start = 0, title = 'Justificatif', fileBase = 'justificatif') {
  srcs = srcs.filter(Boolean);
  if (!srcs.length) { toast('Photo indisponible : reconnectez-vous au réseau pour la télécharger.'); return; }
  const d = $('#sheet');
  d.className = 'sheet';
  const many = srcs.length > 1;
  d.innerHTML = `<div class="viewer">
    <div class="bar"><span id="v-title">${esc(title)}${many ? ` · <span id="v-pos">${start + 1}</span>/${srcs.length}` : ''}</span>
      <span class="btn-row"><button data-share>Enregistrer</button><button data-close>Fermer</button></span></div>
    <div class="vtrack" id="vtrack">${srcs.map((s, i) => `<div class="vslide"><img src="${s}" alt="Photo ${i + 1} sur ${srcs.length}"></div>`).join('')}</div>
    ${many ? `<div class="vnav"><button data-prev aria-label="Photo précédente">‹</button><button data-next aria-label="Photo suivante">›</button></div>` : ''}
  </div>`;
  const track = d.querySelector('#vtrack');
  const pos = () => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  const go = i => track.scrollTo({ left: Math.max(0, Math.min(srcs.length - 1, i)) * track.clientWidth, behavior: 'smooth' });
  track.addEventListener('scroll', () => { const el = d.querySelector('#v-pos'); if (el) el.textContent = pos() + 1; });
  d.querySelector('[data-close]').onclick = () => d.close();
  const prev = d.querySelector('[data-prev]'), next = d.querySelector('[data-next]');
  if (prev) prev.onclick = () => go(pos() - 1);
  if (next) next.onclick = () => go(pos() + 1);
  d.onkeydown = ev => { if (ev.key === 'ArrowLeft') go(pos() - 1); if (ev.key === 'ArrowRight') go(pos() + 1); };
  d.querySelector('[data-share]').onclick = async () => {
    const i = pos();
    const blob = await (await fetch(srcs[i])).blob();
    const file = new File([blob], `${fileBase}${many ? '-' + (i + 1) : ''}.jpg`, { type: 'image/jpeg' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title }); return; }
    } catch (err) { if (err.name === 'AbortError') return; }
    downloadFile(file, file.name);
  };
  d.showModal();
  requestAnimationFrame(() => { track.scrollLeft = start * track.clientWidth; });
}

async function openNotePhotos(e, start = 0) {
  const urls = await Promise.all(photosOf(e).map(photoUrlOf));
  const c = CAT[e.category] || CAT.autre;
  openGallery(urls, start, e.place || c.label, `ticket-${e.date}-${(e.place || c.label).replace(/[^\w-]+/g, '-').slice(0, 30)}`);
}

// Pastille d'état d'une note
function pillHtml(e, cycle = false) {
  if (isIncomplete(e)) return `<span class="pill incomplete">À compléter</span>`;
  if (isNP(e)) return `<span class="pill np">Non pris en compte</span>`;
  return cycle ? `<button class="pill ${e.status} status-btn" data-cycle="${e.id}" title="Changer le statut">${STATUS[e.status]}</button>`
    : `<span class="pill ${e.status}">${STATUS[e.status]}</span>`;
}

// Vignette photo d'une ligne (touchez-la pour voir les photos en grand)
function thumbHtml(e, url, size = '') {
  const n = photosOf(e).length;
  const c = CAT[e.category] || CAT.autre;
  if (!n) return `<span class="cat-ico${size}">${c.ico}</span>`;
  return `<button type="button" class="cat-ico ph${size}" data-view="${e.id}" aria-label="Voir ${n > 1 ? 'les ' + n + ' photos' : 'la photo'}">${url ? `<img src="${url}" alt="">` : '📷'}${n > 1 ? `<i class="ph-count">${n}</i>` : ''}</button>`;
}

// ---------------------------------------------------------------- données
async function saveExpense(e, { photoChanged = false } = {}) {
  e.updated_at = new Date().toISOString();
  e.dirty = true;
  if (photoChanged) e.photo_dirty = true;
  await DB.putExpense(e);
  await DB.setMeta('lastEntryAt', e.updated_at);
  Sync.syncNow();
  refreshBadges();
}

async function setStatus(ids, status) {
  for (const id of ids) {
    const e = await DB.getExpense(id);
    if (!e || e.status === status) continue;
    e.status = status;
    e.reimbursed_on = status === 'remboursee' ? (e.reimbursed_on || todayKey()) : null;
    await saveExpense(e);
  }
}

function groupByMonth(list) {
  const m = {};
  list.forEach(e => { (m[monthKey(e.date)] = m[monthKey(e.date)] || []).push(e); });
  return Object.keys(m).sort().reverse().map(k => ({ key: k, items: m[k].sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at)) }));
}
function sums(items) {
  const s = { total: 0, a_declarer: 0, declaree: 0, remboursee: 0, nophoto: 0, np: 0, npCount: 0, incomplete: 0 };
  items.forEach(e => {
    if (isIncomplete(e)) s.incomplete++;
    if (isNP(e)) { s.np += e.amount || 0; s.npCount++; return; } // jamais compté dans les remboursements
    s.total += e.amount || 0; s[e.status] += e.amount || 0;
    if (!photosOf(e).length) s.nophoto++;
  });
  return s;
}

// ---------------------------------------------------------------- oublis (planning)
// Rendez-vous de déplacement d'un jour donné (pour pré-remplir « Chantier, client ou remarque »)
async function planningNote(date) {
  const planning = await DB.getMeta('planningEvents', null);
  if (!planning || !date) return null;
  const kw = (await DB.getMeta('keywords', DEFAULT_KEYWORDS)).split(',');
  const from = new Date(date + 'T00:00'), to = new Date(date + 'T23:59');
  const events = planning.map(ev => ({ ...ev, start: new Date(ev.start), end: ev.end ? new Date(ev.end) : null }));
  const list = tripDays(events, { from, to, keywords: kw })[date];
  return list ? [...new Set(list)].slice(0, 2).join(' · ').slice(0, 120) : null;
}

async function missingDays() {
  const planning = await DB.getMeta('planningEvents', null);
  if (!planning) return [];
  const kw = (await DB.getMeta('keywords', DEFAULT_KEYWORDS)).split(',');
  const dismissed = new Set(await DB.getMeta('dismissedDays', []));
  const to = new Date(); to.setHours(0, 0, 0, 0); to.setDate(to.getDate() - 1); to.setHours(23, 59);
  const from = new Date(); from.setDate(from.getDate() - 90); from.setHours(0, 0, 0, 0);
  const events = planning.map(ev => ({ ...ev, start: new Date(ev.start), end: ev.end ? new Date(ev.end) : null }));
  const trips = tripDays(events, { from, to, keywords: kw });
  const withExpense = new Set((await DB.allExpenses()).map(e => e.date));
  return Object.keys(trips).sort().reverse()
    .filter(d => !withExpense.has(d) && !dismissed.has(d))
    .map(d => ({ date: d, events: [...new Set(trips[d])] }));
}

async function refreshBadges() {
  const miss = await missingDays();
  const dot = $('#planning-dot');
  if (dot) dot.hidden = miss.length === 0;
  const all = await DB.allExpenses();
  const todo = all.filter(e => isIncomplete(e) || (!isNP(e) && e.status === 'a_declarer')).length;
  try { if ('setAppBadge' in navigator) { const n = miss.length + todo; n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } } catch (_) {}
}

// ---------------------------------------------------------------- sync UI
let syncState = { state: 'off', detail: '' };
function syncPillHtml() {
  const s = syncState;
  const txt = {
    off: 'Local',
    offline: 'Hors ligne',
    syncing: typeof s.detail === 'string' && s.detail ? s.detail : 'Synchronisation…',
    ok: 'Synchronisé',
    error: 'Erreur synchro',
    auth: 'À reconnecter'
  }[s.state] || '';
  return `<button class="sync-pill ${s.state}" data-action="sync" title="${esc(typeof s.detail === 'string' ? s.detail : '')}"><i></i>${esc(txt)}</button>`;
}
window.addEventListener('sync-status', ev => {
  syncState = ev.detail;
  $$('[data-sync-slot]').forEach(el => el.innerHTML = syncPillHtml());
  $('#side-sync').innerHTML = syncPillHtml();
});
window.addEventListener('data-changed', () => { if (!/^#\/note/.test(location.hash)) render(); refreshBadges(); });

// ---------------------------------------------------------------- vues
function rowHtml(e, thumb) {
  const c = CAT[e.category] || CAT.autre;
  const n = photosOf(e).length;
  return `<div class="row" data-id="${e.id}">
    ${thumbHtml(e, thumb)}
    <span style="min-width:0"><div class="t">${esc(e.place || (e.category ? c.label : 'Ticket importé'))}</div><div class="s">${dateLabel(e.date)}${e.category && !isNP(e) ? ' · ' + esc(c.label) : ''}${n ? '' : ' · <span style="color:var(--danger)">sans photo</span>'}</div></span>
    <span class="r"><div class="amount">${e.amount > 0 ? eur.format(e.amount) : '— €'}${e.dirty ? '<i class="unsynced" title="Pas encore synchronisée"></i>' : ''}</div>${pillHtml(e)}</span>
  </div>`;
}

// Lignes cliquables : la vignette ouvre les photos, le reste ouvre la note
function bindRows(list) {
  $$('[data-id]').forEach(row => row.onclick = ev => {
    if (ev.target.closest('[data-cycle]') || ev.target.closest('[data-view]')) return;
    location.hash = `#/note/${row.dataset.id}`;
  });
  $$('[data-view]').forEach(b => b.onclick = ev => {
    ev.stopPropagation();
    const e = list.find(x => x.id === b.dataset.view);
    if (e) openNotePhotos(e);
  });
}

async function viewHome() {
  const all = await DB.allExpenses();
  const mk = monthKey(todayKey());
  const thisMonth = all.filter(e => monthKey(e.date) === mk);
  const pending = all.filter(e => !isNP(e) && e.status !== 'remboursee');
  const pendingSum = pending.reduce((a, e) => a + (e.amount || 0), 0);
  const s = sums(all);
  const recent = [...all].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 8);
  const [whole, cents] = eurParts(pendingSum).split(',');
  const pl = (n, a, b) => n > 1 ? b : a;

  const alerts = [];
  if (s.incomplete) alerts.push(`<div class="alert"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/></svg><div><b>${s.incomplete} ${pl(s.incomplete, 'note', 'notes')} à compléter</b><p>Il manque le montant ou le type de dépense : ces notes ne comptent pas encore dans vos remboursements.</p><a class="btn btn-small btn-accent" href="#/tableau?f=incomplete">Compléter</a></div></div>`);
  const miss = await missingDays();
  if (miss.length) alerts.push(`<div class="alert"><svg viewBox="0 0 24 24"><path d="M12 3 2 20h20zM12 10v4M12 17v.5"/></svg><div><b>${miss.length} ${pl(miss.length, 'jour', 'jours')} de déplacement sans note</b><p>Votre planning Outlook indique des déplacements pour lesquels aucun ticket n'est saisi.</p><a class="btn btn-small btn-accent" href="#/planning">Vérifier les jours</a></div></div>`);
  if (s.npCount) alerts.push(`<div class="alert alert-np"><svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg><div><b>${s.npCount} ${pl(s.npCount, 'paiement', 'paiements')} sans facture · ${eur.format(s.np)}</b><p>Payé, mais pas remboursable tant que vous n'avez pas la facture. Dès que vous la recevez, ajoutez sa photo à la note et choisissez le vrai type de dépense.</p><a class="btn btn-small" href="#/tableau?f=non_pris">Voir ces paiements</a></div></div>`);
  const oldDeclared = all.filter(e => !isNP(e) && e.status === 'declaree' && daysBetween(new Date(e.date), new Date()) > 45);
  if (oldDeclared.length) alerts.push(`<div class="alert"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><div><b>${oldDeclared.length} ${pl(oldDeclared.length, 'note déclarée', 'notes déclarées')} depuis plus de 45 jours</b><p>Pas encore ${pl(oldDeclared.length, 'marquée comme remboursée', 'marquées comme remboursées')}. Vérifiez votre fiche de paie ou relancez la comptabilité.</p><a class="btn btn-small" href="#/tableau?f=declaree">Voir ces notes</a></div></div>`);

  const thumbs = await Promise.all(recent.map(e => photosOf(e).length ? photoUrl(e) : null));

  view.className = '';
  view.innerHTML = `
    <div class="topbar"><div><h1>Notes de frais</h1><div class="sub">${new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</div></div><div data-sync-slot>${syncPillHtml()}</div></div>
    <div class="home-grid">
      <div>
        <div class="ticket">
          <div class="label">Reste à vous rembourser</div>
          <div class="big num">${whole}<small>,${cents} €</small></div>
          <div class="meta">${pending.length} ${pl(pending.length, 'note', 'notes')} en attente</div>
          <div class="split">
            <div>À déclarer<b class="num">${eur.format(s.a_declarer)}</b></div>
            <div>Déclarées<b class="num">${eur.format(s.declaree)}</b></div>
            <div>${new Date().toLocaleDateString('fr-FR', { month: 'long' })}<b class="num">${eur.format(sums(thisMonth).total)}</b></div>
          </div>
          ${s.npCount ? `<a class="np-line" href="#/tableau?f=non_pris"><span>⏸️ Non pris en compte, sans facture</span><b class="num">${eur.format(s.np)}</b></a>` : ''}
        </div>
        ${alerts.join('')}
      </div>
      <div>
        <div class="section-title"><h2>Dernières notes</h2><span class="btn-row"><button class="linkish" data-action="import">Importer des photos</button>${all.length ? '<a href="#/tableau">Tout voir</a>' : ''}</span></div>
        ${recent.length ? `<div class="list">${recent.map((e, i) => rowHtml(e, thumbs[i])).join('')}</div>` :
          `<div class="list empty"><b>Aucune note pour l'instant</b>Prenez en photo votre premier ticket, ou importez ceux déjà dans votre téléphone.<br><span class="btn-row" style="justify-content:center"><button class="btn btn-accent" data-action="add">Photographier un ticket</button><button class="btn" data-action="import">Importer des photos</button></span></div>`}
      </div>
    </div>`;
  bindRows(all);
}

async function viewForm(id, prefill = {}) {
  let e = id ? await DB.getExpense(id) : null;
  const isNew = !e;
  if (!e) {
    e = { id: uid(), date: prefill.date || todayKey(), category: '', amount: null, place: prefill.place || '', note: '', status: 'a_declarer', reimbursed_on: null, photos: [], has_photo: false, photo_path: null, created_at: new Date().toISOString(), deleted: false };
  }
  const wasNP = isNP(e);
  const photos = photosOf(e).map(p => ({ id: p.id, path: p.path || null }));
  const urls = {};
  await Promise.all(photos.map(async p => { urls[p.id] = await photoUrlOf(p); }));
  const added = new Map();   // nouvelles photos pas encore enregistrées : id -> image
  const removed = [];        // photos retirées
  let sel = 0, photoChanged = false, scanToken = 0;
  const ocrMode = await OCR.getMode();
  let scan = null;                 // état de la lecture automatique du ticket
  const autoFilled = new Set();    // champs remplis automatiquement (surlignés)
  const touched = new Set();       // champs modifiés à la main (jamais écrasés)
  const SRC_LABEL = { ia: "Lu par l'IA", local: 'Lu sur le téléphone' };
  const scanBadge = () => {
    if (!scan) return '';
    if (scan.state === 'reading') return `<div class="scan-badge reading" role="status"><i class="spin"></i>Lecture du ticket…</div>`;
    if (scan.state === 'done') return `<div class="scan-badge ok" role="status"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>${SRC_LABEL[scan.source]} · vérifiez</div>`;
    return `<div class="scan-badge warn" role="status">${esc(scan.msg)}</div>`;
  };
  const autoCls = f => autoFilled.has(f) ? ' auto' : '';
  const CAM = '<svg viewBox="0 0 24 24"><path d="M9 4.5 7.6 6.5H5a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5a2 2 0 0 0-2-2h-2.6L15 4.5z"/><circle cx="12" cy="13" r="3.6"/></svg>';
  const GAL = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>';

  const photoZone = () => {
    if (!photos.length) return `<div class="photo-zone" id="pz"><div class="ph-empty">${CAM}
      <div class="btn-row" style="justify-content:center"><button class="btn btn-accent" data-ph="camera">Photographier le ticket</button><button class="btn" data-ph="gallery">Importer du téléphone</button></div>
      <small class="muted">Ticket, facture, reçu de carte… jusqu'à ${MAX_PHOTOS} photos par note.</small></div></div>`;
    const cur = photos[sel];
    return `<div class="photo-zone" id="pz">
        ${urls[cur.id] ? `<img src="${urls[cur.id]}" alt="Photo ${sel + 1} du justificatif" id="ph-img">` : `<div class="ph-missing">Photo enregistrée dans le cloud. Elle s'affichera dès que le réseau revient.</div>`}
        ${scanBadge()}
        <div class="ph-actions">${urls[cur.id] && ocrMode !== 'off' && scan?.state !== 'reading' ? '<button class="btn btn-small" data-ph-rescan title="Relire ce ticket et remplacer ce qui a été rempli automatiquement">Relire</button>' : ''}${urls[cur.id] ? '<button class="btn btn-small" data-ph-zoom>Agrandir</button>' : ''}<button class="btn btn-small" data-ph-remove>Retirer</button></div>
      </div>
      <div class="ph-strip" aria-label="Photos de la note">
        ${photos.map((p, i) => `<button type="button" class="ph-thumb${i === sel ? ' on' : ''}" data-sel="${i}" aria-label="Photo ${i + 1}" aria-pressed="${i === sel}">${urls[p.id] ? `<img src="${urls[p.id]}" alt="">` : '📷'}</button>`).join('')}
        ${photos.length < MAX_PHOTOS ? `<button type="button" class="ph-add" data-ph="camera">${CAM}<span>Photo</span></button><button type="button" class="ph-add" data-ph="gallery">${GAL}<span>Importer</span></button>` : ''}
      </div>`;
  };

  view.className = 'narrow';
  const draw = () => {
    const np = isNP(e);
    view.innerHTML = `
      <div class="topbar"><button class="back" data-back><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Retour</button><div data-sync-slot>${syncPillHtml()}</div></div>
      <h1 style="margin-bottom:16px">${isNew ? 'Nouvelle note' : 'Modifier la note'}</h1>

      ${photoZone()}

      <div class="card">
        <label class="amount-input"><input id="f-amount" class="${autoCls('amount')}" inputmode="decimal" placeholder="0,00" value="${e.amount != null ? e.amount.toFixed(2).replace('.', ',') : ''}" aria-label="Montant TTC payé"><span>€</span></label>
      </div>

      <div class="field"><span>Type de dépense${autoFilled.has('category') ? ' <em class="auto-tag">proposé automatiquement</em>' : ''}</span>
        <div class="chips" id="f-cat">${CATS.filter(c => c.id !== NP).map(c => `<button type="button" class="chip" data-cat="${c.id}" aria-pressed="${e.category === c.id}">${c.ico} ${c.label}</button>`).join('')}</div>
        <div class="chips np-chips"><button type="button" class="chip chip-np" data-cat="${NP}" aria-pressed="${np}">${CAT[NP].ico} ${CAT[NP].label} <small>pas de facture</small></button></div>
      </div>
      ${np ? `<div class="np-note"><b>Gardé à part, pas compté dans vos remboursements.</b> Le montant payé est conservé pour ne pas l'oublier. Quand vous aurez la facture : ajoutez sa photo ci-dessus, puis choisissez le vrai type de dépense. La note passera alors « À déclarer ».</div>` : ''}

      <div class="grid2">
        <label class="field"><span>Date</span><input type="date" id="f-date" class="${autoCls('date')}" value="${e.date}" max="${todayKey()}"></label>
        <label class="field"><span>Ville / lieu</span><input id="f-place" class="${autoCls('place')}" value="${esc(e.place)}" placeholder="Lyon, Ibis Part-Dieu…" autocomplete="off"></label>
      </div>
      <label class="field"><span>Chantier, client ou remarque${autoFilled.has('note') ? ' <em class="auto-tag">d\'après votre planning</em>' : ''}</span><input id="f-note" class="${autoCls('note')}" value="${esc(e.note)}" placeholder="${np ? 'Ex. facture demandée au fournisseur le…' : 'Ex. vérification lignes de vie — client X'}"></label>

      ${np ? '' : `<div class="field"><span>Suivi du remboursement</span><div class="segmented" id="f-status">${STATUS_ORDER.map(s => `<button type="button" data-st="${s}" aria-pressed="${e.status === s}">${STATUS[s]}</button>`).join('')}</div>
      ${e.status === 'remboursee' ? `<label class="field" style="margin-top:10px"><span>Remboursée le</span><input type="date" id="f-reimb" value="${e.reimbursed_on || todayKey()}"></label>` : ''}</div>`}

      <div class="form-actions">
        ${isNew ? '' : '<button class="btn btn-danger" data-del>Supprimer</button>'}
        <button class="btn btn-primary" data-save>${isNew ? 'Enregistrer la note' : 'Enregistrer les modifications'}</button>
      </div>`;
  };

  const readForm = () => {
    if (!$('#f-amount')) return;
    const raw = $('#f-amount').value.replace(/\s/g, '').replace(',', '.');
    e.amount = raw === '' ? null : Math.round(parseFloat(raw) * 100) / 100;
    e.date = $('#f-date').value || todayKey();
    e.place = $('#f-place').value.trim();
    e.note = $('#f-note').value.trim();
    const r = $('#f-reimb'); if (r) e.reimbursed_on = r.value;
  };
  const redraw = () => { readForm(); draw(); bind(); };

  const bind = () => {
    const amt = $('#f-amount');
    const fit = () => { amt.style.width = Math.max(4, amt.value.length) + 0.2 + 'ch'; };
    amt.addEventListener('input', fit); fit();
    [['#f-amount', 'amount'], ['#f-date', 'date'], ['#f-place', 'place'], ['#f-note', 'note']].forEach(([sel, f]) => {
      $(sel).addEventListener('input', () => { touched.add(f); autoFilled.delete(f); $(sel).classList.remove('auto'); });
    });
    $('[data-back]').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/accueil');
    $$('[data-ph]').forEach(b => b.onclick = async () => {
      readForm();
      addFiles(await pickPhotos(b.dataset.ph, true));
    });
    $$('[data-sel]').forEach(b => b.onclick = () => { sel = +b.dataset.sel; redraw(); });
    const zoom = () => { const list = photos.map(p => urls[p.id]); openGallery(list, list.slice(0, sel).filter(Boolean).length, e.place || 'Justificatif'); };
    const img = $('#ph-img'); if (img) img.onclick = zoom;
    const z = $('[data-ph-zoom]'); if (z) z.onclick = zoom;
    const rs = $('[data-ph-rescan]');
    if (rs) rs.onclick = async () => {
      readForm();
      const cur = photos[sel];
      const blob = added.get(cur.id) || await photoBlobOf(cur);
      if (!blob) return;
      scan = { state: 'reading' };
      draw(); bind();
      runScan(blob, true);
    };
    const rm = $('[data-ph-remove]');
    if (rm) rm.onclick = () => {
      readForm(); scanToken++;
      const [p] = photos.splice(sel, 1);
      if (added.has(p.id)) added.delete(p.id); else removed.push(p);
      sel = Math.max(0, Math.min(sel, photos.length - 1));
      photoChanged = true; scan = null;
      draw(); bind();
    };
    $$('[data-cat]').forEach(c => c.onclick = () => {
      readForm();
      const prevNP = isNP(e);
      e.category = c.dataset.cat; touched.add('category'); autoFilled.delete('category');
      if (prevNP !== isNP(e)) { draw(); bind(); return; }
      const t = $('.auto-tag'); if (t) t.remove();
      $$('[data-cat]').forEach(x => x.setAttribute('aria-pressed', x === c));
    });
    $$('#f-status button').forEach(b => b.onclick = () => {
      readForm(); e.status = b.dataset.st;
      if (e.status === 'remboursee' && !e.reimbursed_on) e.reimbursed_on = todayKey();
      if (e.status !== 'remboursee') e.reimbursed_on = null;
      draw(); bind();
    });
    $('[data-save]').onclick = async () => {
      readForm();
      if (e.amount == null || isNaN(e.amount) || e.amount <= 0) { toast('Indiquez le montant payé.'); $('#f-amount').focus(); return; }
      if (!e.category) { toast('Choisissez le type de dépense.'); return; }
      if (photoChanged) {
        for (const [pid, blob] of added) await DB.putPhoto(pid, blob);
        for (const p of removed) await DB.deletePhoto(p.id);
      }
      // reprendre les adresses cloud des photos envoyées pendant que l'écran était ouvert
      const fresh = await DB.getExpense(e.id);
      const known = fresh ? Object.fromEntries(photosOf(fresh).map(p => [p.id, p.path])) : {};
      e.photos = photos.map(p => ({ id: p.id, path: known[p.id] || p.path || null }));
      e.removed_paths = [...((fresh && fresh.removed_paths) || []), ...removed.map(p => known[p.id] || p.path).filter(Boolean)];
      e.has_photo = e.photos.length > 0;
      e.photo_path = (e.photos[0] && e.photos[0].path) || null;
      const leftNP = wasNP && !isNP(e);
      if (leftNP) { e.status = 'a_declarer'; e.reimbursed_on = null; }
      await saveExpense(e, { photoChanged });
      toast(leftNP ? 'Facture ajoutée : la note passe « À déclarer »' : isNP(e) ? 'Paiement gardé à part (non pris en compte)' : isNew ? (e.has_photo ? 'Note enregistrée' : 'Note enregistrée sans photo') : 'Modifications enregistrées');
      if (history.length > 1 && !isNew) history.back(); else location.hash = '#/accueil';
    };
    const del = $('[data-del]');
    if (del) del.onclick = async () => {
      if (!confirm('Supprimer cette note de frais et ses photos ?')) return;
      e.deleted = true;
      await saveExpense(e, { photoChanged: true });
      location.hash = '#/tableau';
      toast('Note supprimée', { label: 'Annuler', fn: async () => { const x = await DB.getExpense(e.id); x.deleted = false; await saveExpense(x, { photoChanged: true }); render(); } });
    };
  };

  async function addFiles(files) {
    files = (files || []).slice(0, MAX_PHOTOS - photos.length);
    if (!files.length) return;
    readForm();
    let first = null;
    for (const f of files) {
      let blob;
      try { blob = await compressImage(f); } catch (_) { toast('Une image ne peut pas être lue (essayez JPEG ou PNG).'); continue; }
      const pid = uid();
      photos.push({ id: pid, path: null });
      added.set(pid, blob);
      urls[pid] = trackUrl(URL.createObjectURL(blob));
      if (!first) first = { pid, blob };
    }
    if (!first) return;
    photoChanged = true;
    sel = photos.findIndex(p => p.id === first.pid);
    const needs = e.amount == null || !e.category || !e.place;
    const mode = await OCR.getMode();
    scan = mode !== 'off' && needs ? { state: 'reading' } : null;
    draw(); bind();
    if (scan) runScan(first.blob);
    else if (e.amount == null) $('#f-amount').focus();
  }

  // Lecture automatique : remplit tout ce qui peut l'être. Vous pouvez ensuite tout modifier ;
  // un champ que vous avez modifié à la main n'est jamais écrasé.
  // overwrite = « Relire » : remplace aussi ce qui avait déjà été rempli automatiquement.
  async function runScan(blob, overwrite = false) {
    const token = ++scanToken;
    const initialDate = e.date;
    let r = null, err = null;
    try { r = await OCR.readReceipt(blob); } catch (x) { err = x; }
    if (token !== scanToken || !document.getElementById('pz')) return; // photo retirée ou écran quitté
    readForm();
    if (err || !r) {
      const why = !navigator.onLine && !(await DB.getMeta('ocrReady', false)) ? 'lecture hors ligne pas encore téléchargée' : (OCR.lastLocalError || (err && err.message) || 'erreur inconnue');
      scan = { state: 'error', msg: `Lecture impossible (${why}) : saisissez le montant` };
    } else {
      const free = (f, empty) => !touched.has(f) && (overwrite ? true : empty);
      const before = autoFilled.size;
      if (r.amount && free('amount', e.amount == null)) { e.amount = r.amount; autoFilled.add('amount'); }
      if (r.category && free('category', !e.category)) { e.category = r.category; autoFilled.add('category'); }
      if (r.date && r.date !== e.date && free('date', isNew && e.date === initialDate)) { e.date = r.date; autoFilled.add('date'); }
      const place = [r.merchant, r.city && !(r.merchant || '').toLowerCase().includes(r.city.toLowerCase()) ? r.city : null].filter(Boolean).join(' — ');
      if (place && free('place', !e.place)) { e.place = place; autoFilled.add('place'); }
      scan = autoFilled.size > before || r.amount ? { state: 'done', source: r.source } : { state: 'error', msg: 'Ticket illisible : saisissez le montant' };
    }
    // Chantier / client : repris du planning Outlook importé, pour la date du ticket
    if (free2('note')) { const n = await planningNote(e.date); if (n) { e.note = n; autoFilled.add('note'); } }
    draw(); bind();
    if (e.amount == null) $('#f-amount').focus();
  }
  const free2 = f => !touched.has(f) && (!e.note || autoFilled.has(f));

  if (isNew && !e.note) { const n = await planningNote(e.date); if (n) { e.note = n; autoFilled.add('note'); } }
  draw(); bind();
  // Photo prise depuis le bouton « + » (l'appareil photo s'ouvre dans le même geste)
  if (isNew && pendingPhoto) { const p = pendingPhoto; pendingPhoto = null; p.then(f => addFiles(f ? [f] : [])); }
}

async function viewTable(params) {
  const filter = params.get('f') || 'tout';
  const all = await DB.allExpenses();
  const nInc = all.filter(isIncomplete).length;
  const FILTERS = [['tout', 'Tout'], ...(nInc ? [['incomplete', `À compléter · ${nInc}`]] : []), ...STATUS_ORDER.map(s => [s, STATUS[s]]), [NP, 'Non pris en compte']];
  const list = filter === 'tout' ? all
    : filter === 'incomplete' ? all.filter(isIncomplete)
    : filter === NP ? all.filter(isNP)
    : all.filter(e => !isNP(e) && e.status === filter);
  const months = groupByMonth(list);
  const thumbs = {};
  await Promise.all(list.filter(e => photosOf(e).length).map(async e => { const u = await photoUrl(e); if (u) thumbs[e.id] = u; }));

  view.className = '';
  view.innerHTML = `
    <div class="topbar"><div><h1>Tableau mensuel</h1><div class="sub">Touchez une photo pour la voir en grand.</div></div><div data-sync-slot>${syncPillHtml()}</div></div>
    <div class="toolbar">
      <div class="filter-chips" id="flt">${FILTERS.map(([k, l]) => `<button class="chip${k === NP ? ' chip-np' : ''}" data-f="${k}" aria-pressed="${filter === k}">${l}</button>`).join('')}</div>
      <div class="btn-row"><button class="btn btn-small" data-action="import">Importer des photos</button><button class="btn btn-small" data-action="csv">Exporter pour Excel</button></div>
    </div>
    ${filter === NP && list.length ? `<div class="np-note" style="margin-bottom:14px"><b>Paiements sans facture.</b> Ces montants sont gardés en mémoire mais ne comptent pas dans vos remboursements. Dès réception de la facture, ouvrez la note, ajoutez la photo de la facture et choisissez le vrai type de dépense.</div>` : ''}
    ${months.length ? months.map(m => {
      const s = sums(m.items);
      const pPaid = s.total ? (s.remboursee / s.total) * 100 : 0, pSent = s.total ? (s.declaree / s.total) * 100 : 0;
      const onlyNP = s.npCount === m.items.length;
      const bulkable = m.items.filter(e => !isNP(e) && !isIncomplete(e));
      return `<section class="month" data-month="${m.key}">
        <div class="month-head">
          <div><h2>${monthLabel(m.key)}</h2><div class="muted">${m.items.length} note${m.items.length > 1 ? 's' : ''}${s.nophoto ? ` · <span style="color:var(--danger)">${s.nophoto} sans photo</span>` : ''}${s.incomplete ? ` · <span style="color:var(--st-todo)">${s.incomplete} à compléter</span>` : ''}</div></div>
          <div class="tot num">${onlyNP ? `<span class="np-tot">${eur.format(s.np)}</span>` : eur.format(s.total)}</div>
          ${onlyNP ? '' : `<div class="progress" aria-hidden="true"><i class="p1" style="width:${pPaid}%"></i><i class="p2" style="width:${pSent}%"></i></div>
          <div class="legend"><span>Remboursé <b class="num">${eur.format(s.remboursee)}</b></span><span>Déclaré <b class="num">${eur.format(s.declaree)}</b></span><span>À déclarer <b class="num">${eur.format(s.a_declarer)}</b></span>${s.npCount ? `<span class="np-leg">Non pris en compte <b class="num">${eur.format(s.np)}</b></span>` : ''}</div>`}
          ${bulkable.some(e => e.status !== 'remboursee') ? `<div class="month-actions">
            ${bulkable.some(e => e.status === 'a_declarer') ? `<button class="btn btn-small" data-bulk="declaree">Tout marquer déclaré</button>` : ''}
            <button class="btn btn-small" data-bulk="remboursee">Tout marquer remboursé</button>
          </div>` : ''}
        </div>
        <div class="mlist">${m.items.map(e => {
          const c = CAT[e.category] || CAT.autre;
          return `<div class="row" data-id="${e.id}">
            ${thumbHtml(e, thumbs[e.id])}
            <span style="min-width:0"><div class="t">${esc(e.place || (e.category ? c.label : 'Ticket importé'))}</div><div class="s">${dateLabel(e.date)}${e.category && !isNP(e) ? ' · ' + esc(c.label) : ''}${photosOf(e).length ? '' : ' · <span style="color:var(--danger)">sans photo</span>'}</div></span>
            <span class="r"><div class="amount${isNP(e) ? ' np-amt' : ''}">${e.amount > 0 ? eur.format(e.amount) : '— €'}${e.dirty ? '<i class="unsynced"></i>' : ''}</div>${pillHtml(e, true)}</span>
          </div>`;
        }).join('')}</div>
        <table class="tbl">
          <thead><tr><th class="col-photo">Photos</th><th>Date</th><th>Dépense</th><th class="col-place">Lieu / chantier</th><th class="r">Montant</th><th class="r">Statut</th></tr></thead>
          <tbody>${m.items.map(e => {
            const c = CAT[e.category] || CAT.autre;
            return `<tr data-id="${e.id}">
              <td class="col-photo">${photosOf(e).length ? thumbHtml(e, thumbs[e.id], ' sm') : '<span class="noph">Pas de photo</span>'}</td>
              <td>${dateLabel(e.date)}</td>
              <td>${e.category ? `${c.ico} ${esc(c.label)}` : '<span class="muted">Type à choisir</span>'}${e.dirty ? '<i class="unsynced" title="Pas encore synchronisée"></i>' : ''}</td>
              <td class="col-place">${esc([e.place, e.note].filter(Boolean).join(' — '))}</td>
              <td class="r num${isNP(e) ? ' np-amt' : ''}"><b>${e.amount > 0 ? eur.format(e.amount) : '—'}</b></td>
              <td class="r">${pillHtml(e, true)}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </section>`;
    }).join('') : `<div class="list empty"><b>${filter === 'tout' ? 'Aucune note enregistrée' : 'Aucune note dans cette catégorie'}</b>${filter === 'tout' ? 'Vos notes apparaîtront ici, regroupées par mois.' : 'Choisissez « Tout » pour revoir l\'ensemble.'}</div>`}`;

  $$('#flt button').forEach(b => b.onclick = () => { location.hash = b.dataset.f === 'tout' ? '#/tableau' : `#/tableau?f=${b.dataset.f}`; });
  const on = $('#flt [aria-pressed="true"]'); if (on) on.scrollIntoView({ inline: 'center', block: 'nearest' });
  bindRows(all);
  $$('[data-cycle]').forEach(b => b.onclick = async ev => {
    ev.stopPropagation();
    const e = await DB.getExpense(b.dataset.cycle);
    const next = STATUS_ORDER[(STATUS_ORDER.indexOf(e.status) + 1) % 3];
    await setStatus([e.id], next);
    toast(`Statut : ${STATUS[next]}`);
    render();
  });
  $$('[data-bulk]').forEach(b => b.onclick = async () => {
    const mk = b.closest('[data-month]').dataset.month;
    const target = b.dataset.bulk;
    const ids = all.filter(e => monthKey(e.date) === mk && !isNP(e) && !isIncomplete(e) && STATUS_ORDER.indexOf(e.status) < STATUS_ORDER.indexOf(target)).map(e => e.id);
    if (!confirm(`Marquer ${ids.length} note${ids.length > 1 ? 's' : ''} de ${monthLabel(mk)} comme « ${STATUS[target]} » ?\nLes paiements non pris en compte et les notes à compléter ne sont pas modifiés.`)) return;
    await setStatus(ids, target);
    toast(`${monthLabel(mk)} : ${STATUS[target].toLowerCase()}`);
    render();
  });
}

// ---------------------------------------------------------------- import de photos du téléphone
// Une note par photo, lue automatiquement ; celles où il manque le montant ou le type sont « À compléter »
async function importPhotos(files) {
  files = (files || []).slice(0, 30);
  if (!files.length) return;
  const d = $('#sheet');
  d.className = 'sheet panel';
  d.innerHTML = `<div class="imp">
    <h2>Import de ${files.length} photo${files.length > 1 ? 's' : ''}</h2>
    <p class="muted" id="imp-sub">Lecture des tickets en cours, gardez l'app ouverte…</p>
    <div class="list" id="imp-list">${files.map((f, i) => `<div class="row" id="imp-${i}"><span class="cat-ico">⏳</span><span style="min-width:0"><div class="t">Photo ${i + 1}</div><div class="s">En attente</div></span><span class="r"></span></div>`).join('')}</div>
    <div class="btn-row" style="margin-top:16px"><button class="btn btn-primary btn-block" id="imp-done" disabled>Patientez…</button></div>
  </div>`;
  d.showModal();
  let created = 0, toFix = 0;
  const ids = [];
  for (let i = 0; i < files.length; i++) {
    const row = $('#imp-' + i);
    row.querySelector('.s').textContent = 'Lecture…';
    let blob;
    try { blob = await compressImage(files[i]); } catch (_) { row.querySelector('.s').textContent = 'Image illisible, ignorée'; row.querySelector('.cat-ico').textContent = '⚠️'; continue; }
    row.querySelector('.cat-ico').innerHTML = `<img src="${trackUrl(URL.createObjectURL(blob))}" alt="">`;
    const pid = uid();
    const e = { id: uid(), date: todayKey(), category: '', amount: null, place: '', note: '', status: 'a_declarer', reimbursed_on: null, photos: [{ id: pid, path: null }], has_photo: true, photo_path: null, created_at: new Date().toISOString(), deleted: false };
    const taken = files[i].lastModified ? dayKey(new Date(files[i].lastModified)) : null;
    if (taken && taken <= todayKey() && daysBetween(new Date(taken), new Date()) < 400) e.date = taken;
    try {
      const r = await OCR.readReceipt(blob);
      if (r) {
        if (r.amount) e.amount = r.amount;
        if (r.category) e.category = r.category;
        if (r.date) e.date = r.date;
        e.place = [r.merchant, r.city && !(r.merchant || '').toLowerCase().includes(r.city.toLowerCase()) ? r.city : null].filter(Boolean).join(' — ');
      }
    } catch (_) {}
    await DB.putPhoto(pid, blob);
    await saveExpense(e, { photoChanged: true });
    created++; ids.push(e.id);
    if (isIncomplete(e)) toFix++;
    const c = CAT[e.category] || CAT.autre;
    row.dataset.note = e.id;
    row.querySelector('.t').textContent = e.place || (e.category ? c.label : 'Ticket importé');
    row.querySelector('.s').textContent = `${dateLabel(e.date)}${e.category && !isNP(e) ? ' · ' + c.label : ''}`;
    row.querySelector('.r').innerHTML = `<div class="amount">${e.amount ? eur.format(e.amount) : '— €'}</div>${pillHtml(e)}`;
  }
  $('#imp-sub').textContent = `${created} note${created > 1 ? 's' : ''} créée${created > 1 ? 's' : ''}${toFix ? `, dont ${toFix} à compléter` : ''}. Touchez une ligne pour la vérifier.`;
  const done = $('#imp-done');
  done.disabled = false; done.textContent = toFix ? 'Compléter les notes' : 'Voir le tableau';
  done.onclick = () => { d.close(); location.hash = toFix ? '#/tableau?f=incomplete' : '#/tableau'; render(); };
  $$('#imp-list [data-note]').forEach(r => r.onclick = () => { d.close(); location.hash = `#/note/${r.dataset.note}`; });
  refreshBadges();
}

async function viewPlanning() {
  const prefs = await DB.getMeta('reminder', { weekday: 5, time: '16:30', interval: 2 });
  const kw = await DB.getMeta('keywords', DEFAULT_KEYWORDS);
  const planning = await DB.getMeta('planningEvents', null);
  const importedAt = await DB.getMeta('planningImportedAt', null);
  const miss = await missingDays();
  const days = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

  view.className = 'narrow';
  view.innerHTML = `
    <div class="topbar"><div><h1>Oublis &amp; rappels</h1><div class="sub">Ne laissez plus un ticket au fond de la poche.</div></div></div>

    <div class="card">
      <h2>Rappel dans Outlook</h2>
      <p>Un rendez-vous récurrent s'ajoute à votre agenda Outlook. Il sonne sur l'iPhone et sur le PC, comme vos autres rendez-vous.</p>
      <div class="spacer"></div>
      <div class="grid2">
        <label class="field"><span>Jour</span><select id="r-day">${[1, 2, 3, 4, 5].map(d => `<option value="${d}" ${+prefs.weekday === d ? 'selected' : ''}>${days[d]}</option>`).join('')}</select></label>
        <label class="field"><span>Heure</span><input type="time" id="r-time" value="${prefs.time}"></label>
      </div>
      <label class="field"><span>Fréquence</span><select id="r-int">${[1, 2, 3, 4].map(n => `<option value="${n}" ${+prefs.interval === n ? 'selected' : ''}>${n === 1 ? 'Chaque semaine' : `Toutes les ${n} semaines`}</option>`).join('')}</select></label>
      <button class="btn btn-primary btn-block" id="r-dl">Ajouter le rappel à Outlook</button>
      <ol class="steps" style="margin-top:14px">
        <li><b>Sur le PC (conseillé) :</b> ouvrez le fichier téléchargé, Outlook affiche le rendez-vous : cliquez « Enregistrer et fermer ».</li>
        <li>Outlook le synchronise ensuite sur l'iPhone : la notification sonne sur les deux appareils.</li>
        <li>Une seule fois suffit : le rappel revient automatiquement.</li>
      </ol>
    </div>

    <div class="card">
      <h2>Repérer les déplacements oubliés</h2>
      <p>Importez votre agenda Outlook : l'application compare vos rendez-vous sur site avec vos notes saisies, sur les 90 derniers jours.</p>
      <div class="spacer"></div>
      <label class="field"><span>Mots qui signalent un déplacement</span><input id="kw" value="${esc(kw)}"><small>Les rendez-vous avec une adresse physique sont aussi comptés. Teams, Zoom et le bureau sont ignorés.</small></label>
      <input type="file" id="ics-in" accept=".ics,text/calendar" hidden>
      <div class="btn-row"><button class="btn btn-primary" id="ics-btn">${planning ? 'Mettre à jour le planning' : 'Importer le planning (.ics)'}</button>
      ${planning ? `<button class="btn" id="ics-clear">Effacer</button>` : ''}</div>
      ${importedAt ? `<p class="muted" style="margin-top:8px">Planning importé le ${new Date(importedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })} · ${planning.length} rendez-vous</p>` : `
      <ol class="steps" style="margin-top:14px">
        <li><b>Outlook sur PC :</b> Fichier › Enregistrer le calendrier, puis « Plus d'options » › 3 derniers mois, détails complets.</li>
        <li>Ouvrez cette application sur le PC et importez le fichier .ics enregistré.</li>
        <li>Refaites-le à chaque rappel pour garder la liste à jour.</li>
      </ol>`}
    </div>

    ${planning ? `<div class="section-title"><h2>${miss.length ? `${miss.length} jour${miss.length > 1 ? 's' : ''} sans note` : 'Aucun oubli détecté'}</h2></div>
    ${miss.length ? `<div class="list">${miss.map(m => `<div class="miss"><div><div class="d">${new Date(m.date + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</div><div class="e">${esc(m.events.slice(0, 2).join(' · '))}</div></div>
      <div class="acts"><button class="btn btn-small btn-accent" data-add-day="${m.date}" data-place="${esc((m.events[0] || '').split(' — ')[1] || '')}">Ajouter</button><button class="btn btn-small" data-dismiss="${m.date}">Pas de frais</button></div></div>`).join('')}</div>`
      : `<div class="list empty"><b>Tout est à jour</b>Chaque jour de déplacement a au moins une note.</div>`}` : ''}`;

  const savePrefs = () => DB.setMeta('reminder', { weekday: +$('#r-day').value, time: $('#r-time').value || '16:30', interval: +$('#r-int').value });
  ['#r-day', '#r-time', '#r-int'].forEach(s => $(s).onchange = savePrefs);
  $('#r-dl').onclick = async () => {
    await savePrefs();
    const appUrl = location.href.split('#')[0];
    const ics = buildReminderICS({ weekday: +$('#r-day').value, time: $('#r-time').value || '16:30', intervalWeeks: +$('#r-int').value, appUrl });
    downloadFile(new Blob([ics], { type: 'text/calendar;charset=utf-8' }), 'rappel-notes-de-frais.ics');
  };
  $('#kw').onchange = async () => { await DB.setMeta('keywords', $('#kw').value); render(); refreshBadges(); };
  $('#ics-btn').onclick = () => $('#ics-in').click();
  $('#ics-in').onchange = async ev => {
    const f = ev.target.files[0]; if (!f) return;
    const evs = parseICS(await f.text());
    if (!evs.length) { toast('Aucun rendez-vous trouvé dans ce fichier.'); return; }
    await DB.setMeta('planningEvents', evs.map(e => ({ ...e, start: e.start.toISOString(), end: e.end ? e.end.toISOString() : null })));
    await DB.setMeta('planningImportedAt', new Date().toISOString());
    toast(`${evs.length} rendez-vous importés`);
    render(); refreshBadges();
  };
  const clr = $('#ics-clear');
  if (clr) clr.onclick = async () => { await DB.setMeta('planningEvents', null); await DB.setMeta('planningImportedAt', null); render(); refreshBadges(); };
  $$('[data-add-day]').forEach(b => b.onclick = () => { location.hash = `#/note/new?date=${b.dataset.addDay}&place=${encodeURIComponent(b.dataset.place)}`; });
  $$('[data-dismiss]').forEach(b => b.onclick = async () => {
    const list = await DB.getMeta('dismissedDays', []);
    list.push(b.dataset.dismiss); await DB.setMeta('dismissedDays', list);
    render(); refreshBadges();
  });
}

async function viewSettings() {
  const cfg = await Sync.getConfig();
  const connected = await Sync.isConfigured();
  const lastSync = await DB.getMeta('lastSync', null);
  const all = await DB.allExpenses({ includeDeleted: true });
  const pending = all.filter(e => e.dirty).length;
  let est = null;
  try { est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (_) {}
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ocrMode = await OCR.getMode();
  const needsCol = connected && (await DB.getMeta('needsPhotosColumn', false));
  const ocrReady = await DB.getMeta('ocrReady', false);

  view.className = 'narrow';
  view.innerHTML = `
    <div class="topbar"><div><h1>Réglages</h1></div><div data-sync-slot>${syncPillHtml()}</div></div>

    <div class="card">
      <h2>Synchronisation iPhone ↔ PC</h2>
      ${connected ? `
        <p>Connecté en tant que <b>${esc(cfg.email)}</b>. Les notes saisies hors ligne partent dès que le wifi ou la 4G revient.</p>
        <p class="muted" style="margin-top:8px">${pending ? `${pending} modification${pending > 1 ? 's' : ''} en attente d'envoi.` : 'Tout est envoyé.'}${lastSync ? ` Dernière synchro : ${new Date(lastSync).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}.` : ''}</p>
        ${needsCol ? `<div class="np-note" style="margin-top:12px"><b>Une mise à jour de Supabase est nécessaire</b> pour synchroniser plusieurs photos par note. Pour l'instant, seule la première photo est partagée entre l'iPhone et le PC. Dans Supabase › SQL Editor, collez cette ligne puis cliquez sur Run :
          <code class="sql" id="sql-line">alter table public.expenses add column if not exists photos jsonb;</code>
          <button class="btn btn-small" id="sql-copy">Copier la ligne</button></div>` : ''}
        <div class="btn-row" style="margin-top:12px"><button class="btn btn-primary" data-action="sync">Synchroniser maintenant</button><button class="btn" id="logout">Se déconnecter</button></div>`
      : `
        <p>Reliez l'application à votre espace cloud gratuit pour retrouver les mêmes notes sur l'iPhone et le PC. Le guide d'installation explique comment le créer en 10 minutes.</p>
        <div class="spacer"></div>
        <label class="field"><span>Adresse du projet (Project URL)</span><input id="s-url" inputmode="url" autocomplete="off" placeholder="https://xxxx.supabase.co" value="${esc(cfg?.url || '')}"></label>
        <label class="field"><span>Clé publique (anon / publishable key)</span><input id="s-key" autocomplete="off" value="${esc(cfg?.anonKey || '')}"></label>
        <label class="field"><span>E-mail</span><input id="s-email" type="email" autocomplete="username" value="${esc(cfg?.email || '')}"></label>
        <label class="field"><span>Mot de passe</span><input id="s-pass" type="password" autocomplete="current-password"></label>
        <button class="btn btn-primary btn-block" id="login">Se connecter</button>
        <p class="muted" style="margin-top:10px">Sans connexion, tout reste enregistré sur cet appareil.</p>`}
    </div>

    <div class="card">
      <h2>Lecture automatique des tickets</h2>
      <p>Après la photo, le montant, la date, le lieu et le type de dépense sont remplis pour vous. Vous n'avez plus qu'à vérifier.</p>
      <div class="segmented" id="ocr-mode" style="margin-top:12px">${[['auto', 'Auto (IA)'], ['local', 'Téléphone'], ['off', 'Désactivée']].map(([k, l]) => `<button data-m="${k}" aria-pressed="${ocrMode === k}">${l}</button>`).join('')}</div>
      <p class="muted" style="margin-top:10px">${ocrMode === 'off' ? 'Vous saisissez tout à la main.' :
        ocrMode === 'auto' && !connected ? "L'IA s'active une fois la synchronisation connectée. En attendant, la lecture se fait sur le téléphone." :
        ocrMode === 'auto' ? "Avec du réseau, l'IA lit le ticket. Sans réseau, le téléphone prend le relais." : 'La lecture se fait sur le téléphone, sans réseau. Moins précise sur les tickets abîmés.'}</p>
      ${ocrMode !== 'off' ? `<p class="muted" style="margin-top:6px">${ocrReady ? 'Lecture hors ligne prête sur cet appareil.' : 'Lecture hors ligne : pas encore téléchargée sur cet appareil (environ 5 Mo).'}</p>` : ''}
      <div class="btn-row" style="margin-top:12px">
        ${ocrMode !== 'off' && !ocrReady ? '<button class="btn" id="ocr-warm">Préparer la lecture hors ligne</button>' : ''}
        ${ocrMode === 'auto' && connected ? '<button class="btn" id="ocr-test">Tester la lecture IA</button>' : ''}
      </div>
      <p class="muted" id="ocr-result" style="margin-top:8px"></p>
    </div>

    <div class="card">
      <h2>Exports et sauvegarde</h2>
      <p>Le fichier Excel liste toutes les notes, triées par date. La sauvegarde complète inclut les photos.</p>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn" data-action="csv">Exporter pour Excel</button>
        <button class="btn" id="bk-out">Sauvegarde complète</button>
        <button class="btn" id="bk-in-btn">Restaurer</button>
        <input type="file" id="bk-in" accept="application/json,.json" hidden>
      </div>
      ${est ? `<p class="muted" style="margin-top:10px">Espace utilisé sur cet appareil : ${(est.usage / 1048576).toFixed(1)} Mo.</p>` : ''}
    </div>

    <div class="card">
      <h2>Installer sur l'iPhone</h2>
      ${standalone ? '<p>L\'application est installée sur cet appareil.</p>' : `
      <ol class="steps">
        <li>Ouvrez cette page dans <b>Safari</b>.</li>
        <li>Touchez le bouton <b>Partager</b> (carré avec une flèche vers le haut).</li>
        <li>Choisissez <b>Sur l'écran d'accueil</b>, puis <b>Ajouter</b>.</li>
        <li>Ouvrez l'application depuis son icône : elle fonctionne alors sans réseau.</li>
      </ol>`}
      <h3 style="margin-top:8px">Sur le PC</h3>
      <p class="muted" style="margin-top:4px">Ouvrez la même adresse dans Edge ou Chrome, puis menu ⋯ › Applications › Installer cette application.</p>
    </div>
    <p class="muted" style="text-align:center;margin-top:18px">Version 1.3.1 · <button class="linkish" id="upd" style="font-size:14px">Rechercher une mise à jour</button></p>`;

  const lg = $('#login');
  if (lg) lg.onclick = async () => {
    lg.disabled = true; lg.textContent = 'Connexion…';
    try {
      await Sync.login($('#s-url').value, $('#s-key').value, $('#s-email').value, $('#s-pass').value);
      // toutes les notes locales sont à envoyer
      for (const e of await DB.allExpenses({ includeDeleted: true })) { e.photos = photosOf(e).map(p => ({ id: p.id, path: null })); e.dirty = true; e.photo_dirty = e.photos.length > 0; await DB.putExpense(e); }
      toast('Connecté. Synchronisation en cours…');
      await Sync.syncNow();
      render();
    } catch (err) {
      toast(err.message.includes('fetch') ? 'Serveur injoignable : vérifiez l\'adresse et la connexion.' : err.message);
      lg.disabled = false; lg.textContent = 'Se connecter';
    }
  };
  $('#upd').onclick = async () => {
    if (!navigator.onLine) { toast('Connectez-vous au réseau pour rechercher une mise à jour.'); return; }
    toast('Recherche…');
    const r = await checkForUpdate();
    if (r === 'none') toast('Vous avez déjà la dernière version.');
    else if (r === 'offline') toast('Recherche impossible : réseau indisponible.');
  };
  const sc = $('#sql-copy');
  if (sc) sc.onclick = async () => { try { await navigator.clipboard.writeText($('#sql-line').textContent); toast('Ligne copiée'); } catch (_) { toast('Sélectionnez la ligne et copiez-la'); } };
  const lo = $('#logout');
  if (lo) lo.onclick = async () => { if (confirm('Se déconnecter ? Les notes restent sur cet appareil.')) { await Sync.logout(); render(); } };
  $$('#ocr-mode button').forEach(b => b.onclick = async () => { await OCR.setMode(b.dataset.m); render(); if (b.dataset.m !== 'off') OCR.warmUp(); });
  const warm = $('#ocr-warm');
  if (warm) warm.onclick = async () => {
    if (!navigator.onLine) { toast('Connectez-vous au wifi ou à la 4G pour télécharger la lecture.'); return; }
    warm.disabled = true; warm.textContent = 'Téléchargement…';
    await OCR.warmUp();
    toast((await DB.getMeta('ocrReady', false)) ? 'Lecture hors ligne prête' : 'Téléchargement impossible, réessayez');
    render();
  };
  const test = $('#ocr-test');
  if (test) test.onclick = async () => {
    const out = $('#ocr-result');
    test.disabled = true; out.textContent = 'Envoi d\'un ticket d\'essai à l\'IA…';
    try {
      const c = document.createElement('canvas'); c.width = 420; c.height = 300;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 420, 300); g.fillStyle = '#111'; g.font = '20px monospace';
      ['BOULANGERIE DES ARTS', '12 rue Garibaldi', '69007 LYON', todayKey().split('-').reverse().join('/'), '', 'SANDWICH        5,40', 'BOISSON         2,10', 'TOTAL TTC       7,50 EUR'].forEach((l, i) => g.fillText(l, 20, 36 + i * 32));
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
      const r = await OCR.readWithAI(blob);
      out.innerHTML = `<span style="color:var(--st-paid)">L'IA fonctionne.</span> Lu : ${esc(r.merchant || '?')}, ${r.amount != null ? eur.format(r.amount) : '?'}, catégorie « ${esc((CAT[r.category] || CAT.autre).label)} ».`;
    } catch (err) {
      out.innerHTML = `<span style="color:var(--danger)">L'IA ne répond pas : ${esc(err.message)}.</span> Vérifiez la fonction « lire-ticket » et la clé dans Supabase.`;
    }
    test.disabled = false;
  };
  $('#bk-out').onclick = exportBackup;
  $('#bk-in-btn').onclick = () => $('#bk-in').click();
  $('#bk-in').onchange = async ev => { const f = ev.target.files[0]; if (f) await importBackup(f); };
}

// ---------------------------------------------------------------- export / sauvegarde
function downloadFile(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function exportCSV() {
  const all = (await DB.allExpenses()).sort((a, b) => a.date.localeCompare(b.date));
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const num = n => (n || 0).toFixed(2).replace('.', ',');
  const lines = [['Mois', 'Date', 'Type', 'Lieu', 'Chantier / remarque', 'Montant TTC (€)', 'Statut', 'Compté dans le remboursement', 'Remboursée le', 'Photos'].map(q).join(';')];
  all.forEach(e => {
    const [y, m, d] = e.date.split('-');
    lines.push([monthLabel(monthKey(e.date)), `${d}/${m}/${y}`, e.category ? (CAT[e.category] || CAT.autre).label : '', e.place, e.note, num(e.amount),
      isIncomplete(e) ? 'À compléter' : isNP(e) ? 'Non pris en compte (sans facture)' : STATUS[e.status], isNP(e) ? 'non' : 'oui',
      e.reimbursed_on ? e.reimbursed_on.split('-').reverse().join('/') : '', photosOf(e).length].map((v, i) => i === 5 ? v : q(v)).join(';'));
  });
  downloadFile(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `notes-de-frais-${todayKey()}.csv`);
}

async function exportBackup() {
  const all = await DB.allExpenses({ includeDeleted: true });
  const toB64 = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
  const photos = {};
  for (const e of all) for (const p of photosOf(e)) { const b = await DB.getPhoto(p.id); if (b) photos[p.id] = await toB64(b); }
  downloadFile(new Blob([JSON.stringify({ app: 'notes-de-frais', version: 2, exported_at: new Date().toISOString(), expenses: all, photos })], { type: 'application/json' }), `sauvegarde-notes-de-frais-${todayKey()}.json`);
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'notes-de-frais') throw new Error();
    let n = 0;
    for (const e of data.expenses) {
      const local = await DB.getExpense(e.id);
      if (local && local.updated_at >= e.updated_at) continue;
      const ph = photosOf(e);
      let any = false;
      for (const p of ph) if (data.photos[p.id]) { const r = await fetch(data.photos[p.id]); await DB.putPhoto(p.id, await r.blob()); any = true; }
      e.photos = ph.map(p => ({ id: p.id, path: data.photos[p.id] ? null : p.path || null }));
      e.dirty = true; e.photo_dirty = any;
      await DB.putExpense(e); n++;
    }
    toast(`${n} note${n > 1 ? 's' : ''} restaurée${n > 1 ? 's' : ''}`);
    Sync.syncNow(); render();
  } catch (_) { toast('Ce fichier n\'est pas une sauvegarde valide.'); }
}

// ---------------------------------------------------------------- routeur
async function render() {
  releaseUrls();
  const [path, qs] = (location.hash || '#/accueil').slice(1).split('?');
  const params = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  const tab = parts[0] === 'note' ? '' : (parts[0] || 'accueil');
  $$('[data-tab]').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  if (parts[0] === 'note') {
    await viewForm(parts[1] === 'new' ? null : parts[1], { date: params.get('date'), place: params.get('place'), camera: params.get('camera') === '1' });
  } else if (tab === 'tableau') await viewTable(params);
  else if (tab === 'planning') await viewPlanning();
  else if (tab === 'reglages') await viewSettings();
  else await viewHome();
  view.scrollTop = 0; window.scrollTo(0, 0);
}

document.addEventListener('click', ev => {
  const a = ev.target.closest('[data-action]');
  if (!a) return;
  const act = a.dataset.action;
  if (act === 'add') {
    // Sur téléphone, l'appareil photo s'ouvre directement (doit se faire dans le geste de l'utilisateur)
    if (window.matchMedia('(pointer: coarse)').matches) pendingPhoto = pickPhoto('camera');
    if (location.hash === '#/note/new') render(); else location.hash = '#/note/new';
  }
  else if (act === 'sync') { Sync.syncNow(); if (syncState.state === 'off') location.hash = '#/reglages'; }
  else if (act === 'csv') exportCSV();
  else if (act === 'import') pickPhotos('gallery', true).then(importPhotos);
});
window.addEventListener('hashchange', render);

// ---------------------------------------------------------------- démarrage
(async function start() {
  await DB.requestPersistence();
  await render();
  refreshBadges();
  Sync.startAutoSync();
  // Télécharge la lecture hors ligne en arrière-plan, une fois, quand il y a du réseau
  setTimeout(() => (window.requestIdleCallback || (f => f()))(() => OCR.warmUp()), 6000);

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      swReg = reg;
      if (reg.waiting) offerUpdate(reg.waiting);   // version déjà téléchargée en arrière-plan
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w && w.addEventListener('statechange', () => { if (w.state === 'installed') offerUpdate(w); });
      });
      // vérifier les nouveautés à chaque retour dans l'app
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
      reg.update().catch(() => {});
      let reloaded = false;
      const hadController = !!navigator.serviceWorker.controller; // pas de rechargement à la toute première installation
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
    } catch (_) {}
  }
})();
