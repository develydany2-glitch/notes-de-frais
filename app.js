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
const SQL_UPDATE = `alter table public.expenses add column if not exists photos jsonb;
alter table public.expenses add column if not exists month text;
alter table public.expenses add column if not exists verified boolean;
create table if not exists public.trips (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null,
  deleted boolean not null default false
);
alter table public.trips enable row level security;
drop policy if exists "mes deplacements" on public.trips;
create policy "mes deplacements" on public.trips for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());`;
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

// Titre du déplacement qui couvre une date (pour pré-remplir « Chantier, client ou remarque »)
async function tripTitleFor(date) {
  const t = (await DB.allTrips()).find(x => date >= x.start && date <= x.end && x.title);
  return t ? t.title : null;
}
// Rattache automatiquement les notes d'une date aux étapes des déplacements de ce jour
async function autoLinkDate(date) {
  let n = 0;
  for (const t of (await DB.allTrips()).filter(x => date >= x.start && date <= x.end)) n += await autoLink(t.id);
  return n;
}

async function refreshBadges() {
  const all = await DB.allExpenses();
  const { waiting, overdue } = await tripReminders();
  const dups = duplicateIds(all).size;
  const inc = all.filter(isIncomplete).length;
  const td = $('#trip-dot'); if (td) td.hidden = !(waiting.length + overdue.length);
  const md = $('#month-dot'); if (md) md.hidden = !(inc + dups);
  try { if ('setAppBadge' in navigator) { const n = waiting.length + overdue.length + inc; n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } } catch (_) {}
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

const GEAR = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>';
const topRight = () => `<div class="top-right"><span data-sync-slot>${syncPillHtml()}</span><a class="gear" href="#/reglages" aria-label="Réglages">${GEAR}</a></div>`;

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
    if (row.dataset.swiped) return; // fin d'un glissement, pas un clic
    if (ev.target.closest('[data-cycle]') || ev.target.closest('[data-view]')) return;
    location.hash = `#/note/${row.dataset.id}`;
  });
  $$('[data-view]').forEach(b => b.onclick = ev => {
    ev.stopPropagation();
    const e = list.find(x => x.id === b.dataset.view);
    if (e) openNotePhotos(e);
  });
}

async function viewForm(id, prefill = {}) {
  let e = id ? await DB.getExpense(id) : null;
  const isNew = !e;
  if (!e) {
    e = { id: uid(), date: prefill.date || todayKey(), category: prefill.cat || '', amount: null, place: prefill.place || '', note: prefill.note || '', status: 'a_declarer', reimbursed_on: null, photos: [], has_photo: false, photo_path: null, created_at: new Date().toISOString(), deleted: false };
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
  if (prefill.cat) touched.add('category'); // étape d'un déplacement : le type est déjà connu
  if (prefill.trip) touched.add('date');    // … et le jour aussi
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
      <div class="topbar"><button class="back" data-back><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Retour</button>${topRight()}</div>
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
        <label class="field"><span>Nom du ticket</span><input id="f-place" class="${autoCls('place')}" value="${esc(e.place)}" placeholder="Ex. Brioche Dorée, Ticket métro" autocomplete="off"></label>
      </div>
      ${monthField()}
      <label class="field"><span>Chantier, client ou remarque${autoFilled.has('note') ? ' <em class="auto-tag">d\'après votre planning</em>' : ''}</span><input id="f-note" class="${autoCls('note')}" value="${esc(e.note)}" placeholder="${np ? 'Ex. facture demandée au fournisseur le…' : 'Ex. vérification lignes de vie — client X'}"></label>

      ${np ? '' : `<div class="field"><span>Suivi du remboursement</span><div class="segmented" id="f-status">${STATUS_ORDER.map(s => `<button type="button" data-st="${s}" aria-pressed="${e.status === s}">${STATUS[s]}</button>`).join('')}</div>
      ${e.status === 'remboursee' ? `<label class="field" style="margin-top:10px"><span>Remboursée le</span><input type="date" id="f-reimb" value="${e.reimbursed_on || todayKey()}"></label>` : ''}</div>`}

      <div class="form-actions">
        ${isNew ? '' : '<button class="btn btn-danger" data-del>Supprimer</button>'}
        <button class="btn btn-primary" data-save>Enregistrer</button>
      </div>`;
  };

  const monthField = () => {
    const nat = monthKey(e.date), cur = e.month || nat;
    const opts = [shiftMonth(nat, -1), nat, shiftMonth(nat, 1)];
    return `<div class="field"><span>Note de frais du mois de</span><div class="segmented" id="f-month">${opts.map(o => `<button type="button" data-mo="${o}" aria-pressed="${cur === o}">${monthLabel(o).split(' ')[0]}${o === nat ? ' <small>· ticket</small>' : ''}</button>`).join('')}</div>
      <small>${cur === nat ? 'Par défaut, le mois du ticket.' : `Ce ticket du ${dateLabel(e.date)} sera déclaré en ${monthLabel(cur)}.`}</small></div>`;
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
    $('[data-back]').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/mois');
    $$('#f-month button').forEach(b => b.onclick = () => { readForm(); e.month = b.dataset.mo === monthKey(e.date) ? null : b.dataset.mo; draw(); bind(); });
    $('#f-date').addEventListener('change', () => { readForm(); draw(); bind(); });
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
      const cur = photos[sel] || photos[0];
      if (!(await reviewSheet(e, cur ? urls[cur.id] : null))) return; // relecture : montant, nom, date
      e.verified = true;
      const dup = findDuplicate(e, await DB.allExpenses());
      if (dup && !confirm(`Une note de ${eur.format(dup.amount)} du ${dateLabel(dup.date)} existe déjà (« ${dup.place || (CAT[dup.category] || CAT.autre).label} »).\n\nC'est peut-être le même ticket. Enregistrer quand même ?`)) return;
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
      let linked = 0;
      if (prefill.trip && prefill.step) await linkExpense(prefill.trip, prefill.step, e.id);
      else if (isNew) linked = await autoLinkDate(e.date);
      toast(leftNP ? 'Facture ajoutée : la note passe « À déclarer »' : isNP(e) ? 'Paiement gardé à part (non pris en compte)' : isNew ? (e.has_photo ? 'Note enregistrée' : 'Note enregistrée sans photo') : 'Modifications enregistrées');
      if (linked) setTimeout(() => toast('Note rattachée à votre déplacement'), 2700);
      if (prefill.trip) location.hash = `#/deplacement/${prefill.trip}`;
      else if (history.length > 1 && !isNew) history.back();
      else location.hash = `#/mois?m=${mOf(e)}`;
    };
    const del = $('[data-del]');
    if (del) del.onclick = async () => {
      if (await deleteExpense(e)) location.hash = `#/mois?m=${mOf(e)}`;
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
    if (free2('note')) { const n = await tripTitleFor(e.date); if (n) { e.note = n; autoFilled.add('note'); } }
    draw(); bind();
    if (e.amount == null) $('#f-amount').focus();
  }
  const free2 = f => !touched.has(f) && (!e.note || autoFilled.has(f));

  if (isNew && !e.note) { const n = await tripTitleFor(e.date); if (n) { e.note = n; autoFilled.add('note'); } }
  draw(); bind();
  // Photo prise depuis le bouton « + » (l'appareil photo s'ouvre dans le même geste)
  if (isNew && pendingPhoto) { const p = pendingPhoto; pendingPhoto = null; p.then(f => addFiles(f ? [f] : [])); }
}

// ---------------------------------------------------------------- glisser une ligne : → état suivant, ← supprimer
const swipeHintSeen = () => { try { return localStorage.getItem('swipeHint') === '1'; } catch (_) { return false; } };
function swipeNext(e) {
  if (e.verified === false) return { label: 'Vérifier', cls: 'incomplete' };
  if (isIncomplete(e)) return { label: 'Compléter', cls: 'incomplete' };
  if (isNP(e)) return { label: 'Ajouter la facture', cls: 'np' };
  const n = STATUS_ORDER[(STATUS_ORDER.indexOf(e.status) + 1) % 3];
  return { label: STATUS[n], cls: n };
}
async function swipeAdvance(e) {
  if (e.verified === false) { location.hash = '#/relecture'; return; }
  if (isIncomplete(e) || isNP(e)) { location.hash = `#/note/${e.id}`; return; }
  const prev = e.status;
  const next = STATUS_ORDER[(STATUS_ORDER.indexOf(prev) + 1) % 3];
  await setStatus([e.id], next);
  toast(`${rowTitle(e)} : ${STATUS[next]}`, { label: 'Annuler', fn: async () => { await setStatus([e.id], prev); render(); } });
  render();
}
function bindSwipes(list) {
  const LIMIT = 90;
  $$('.swipe').forEach(w => {
    const row = w.querySelector('.row');
    const e = list.find(x => x.id === w.dataset.sw);
    let x0 = 0, y0 = 0, dx = 0, tracking = false, axis = null;
    const reset = () => { row.style.transition = 'transform .22s ease'; row.style.transform = ''; w.classList.remove('to-left', 'to-right', 'armed'); };
    let press = null;
    row.addEventListener('pointerdown', ev => {
      if (ev.button > 0) return;
      x0 = ev.clientX; y0 = ev.clientY; dx = 0; tracking = true; axis = null;
      row.style.transition = 'none';
      clearTimeout(press);
      press = setTimeout(() => { if (tracking && !axis) { tracking = false; row.dataset.swiped = '1'; setTimeout(() => { delete row.dataset.swiped; }, 600); openRowMenu(e); } }, 550);
    });
    row.addEventListener('contextmenu', ev => ev.preventDefault());
    row.addEventListener('pointermove', ev => {
      if (!tracking) return;
      const mx = ev.clientX - x0, my = ev.clientY - y0;
      if (!axis) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        clearTimeout(press);
        axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
        if (axis === 'y') { tracking = false; return; }
        try { row.setPointerCapture(ev.pointerId); } catch (_) {}
      }
      dx = mx;
      row.style.transform = `translateX(${dx}px)`;
      w.classList.toggle('to-right', dx > 0); w.classList.toggle('to-left', dx < 0);
      w.classList.toggle('armed', Math.abs(dx) > LIMIT);
    });
    const end = async () => {
      clearTimeout(press);
      if (!tracking) return;
      tracking = false;
      if (axis !== 'x') return;
      row.dataset.swiped = '1'; setTimeout(() => { delete row.dataset.swiped; }, 350);
      if (dx > LIMIT) { row.style.transition = 'transform .18s ease'; row.style.transform = 'translateX(100%)'; await new Promise(r => setTimeout(r, 160)); await swipeAdvance(e); return; }
      if (dx < -LIMIT) {
        row.style.transition = 'transform .18s ease'; row.style.transform = 'translateX(-100%)';
        if (await deleteExpense(e)) { render(); return; }  // message de validation, puis historique
      }
      reset();
    };
    row.addEventListener('pointerup', end);
    row.addEventListener('pointercancel', () => { tracking = false; reset(); });
  });
}

// ---------------------------------------------------------------- vue « Mois » : une note de frais par mois
const mOf = e => e.month || monthKey(e.date); // mois de déclaration (peut différer du mois du ticket)
const shiftMonth = (mk, n) => { const [y, m] = mk.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const monthName = mk => monthLabel(mk).replace(/^\w/, c => c.toUpperCase());

async function moveToMonth(e, target) {
  e.month = target === monthKey(e.date) ? null : target;
  await saveExpense(e);
}

function openRowMenu(e) {
  const d = $('#sheet');
  const cur = mOf(e), nat = monthKey(e.date);
  const items = [
    { ico: '←', label: `Déclarer en ${monthLabel(shiftMonth(cur, -1))}`, sub: 'Passer cette note sur la note de frais du mois précédent', fn: async () => { d.close(); await moveToMonth(e, shiftMonth(cur, -1)); toast(`Déclarée en ${monthLabel(shiftMonth(cur, -1))}`); render(); } },
    { ico: '→', label: `Déclarer en ${monthLabel(shiftMonth(cur, 1))}`, sub: 'Passer cette note sur la note de frais du mois suivant', fn: async () => { d.close(); await moveToMonth(e, shiftMonth(cur, 1)); toast(`Déclarée en ${monthLabel(shiftMonth(cur, 1))}`); render(); } }
  ];
  if (cur !== nat) items.push({ ico: '↺', label: `Revenir en ${monthLabel(nat)}`, sub: 'Le mois du ticket', fn: async () => { d.close(); await moveToMonth(e, nat); render(); } });
  items.push({ ico: '✎', label: 'Ouvrir la note', fn: () => { d.close(); location.hash = `#/note/${e.id}`; } });
  items.push({ ico: '🗑', label: 'Supprimer la note', sub: 'Elle ira dans l\'historique des suppressions', danger: true, fn: async () => { if (await deleteExpense(e)) render(); } });
  menuSheet(`${esc(rowTitle(e))} · ${esc(rowName(e))} · ${e.amount > 0 ? eur.format(e.amount) : '— €'}`, items);
}

// Libellés de ligne : « Métro · 03/11 » en titre, le nom du ticket en dessous
const shortDate = d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) : '';
const rowTitle = e => `${e.category ? (CAT[e.category] || CAT.autre).label : 'Ticket'} · ${shortDate(e.date)}`;
const rowName = e => e.place || 'Nom à compléter';

function openMonthsSheet(all, current) {
  const months = [...new Set([...all.map(mOf), monthKey(todayKey())])].sort().reverse();
  const d = $('#sheet');
  menuSheet('Choisir un mois', months.map(mk => {
    const x = sums(all.filter(e => mOf(e) === mk));
    const left = x.total - x.remboursee;
    return { ico: mk === current ? '✓' : '', label: monthName(mk), sub: x.total ? (left < 0.005 ? `Tout remboursé · ${eur.format(x.total)}` : `${eur.format(left)} en attente sur ${eur.format(x.total)}`) : 'Aucune note', fn: () => { d.close(); location.hash = `#/mois?m=${mk}`; } };
  }));
}

async function viewMonth(params) {
  const all = await DB.allExpenses();
  const m = params.get('m') || monthKey(todayKey());
  const filter = params.get('f') || 'tout';
  const dups = duplicateIds(all);
  const inMonth = all.filter(e => mOf(e) === m);
  const FILTERS = [['tout', 'Tout'], ...STATUS_ORDER.map(s => [s, STATUS[s]]), [NP, 'Non pris en compte']];
  const list = (filter === 'tout' ? inMonth : filter === 'incomplete' ? inMonth.filter(isIncomplete) : filter === NP ? inMonth.filter(isNP)
    : filter === 'doublons' ? inMonth.filter(e => dups.has(e.id)) : filter === 'verifier' ? inMonth.filter(e => e.verified === false)
    : inMonth.filter(e => !isNP(e) && e.status === filter))
    .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));
  const s = sums(inMonth);
  const pendingSum = all.filter(e => !isNP(e) && e.status !== 'remboursee').reduce((a, e) => a + (e.amount || 0), 0);
  const pl = (n, a, b) => n > 1 ? b : a;
  const thumbs = {};
  await Promise.all(list.filter(e => photosOf(e).length).map(async e => { thumbs[e.id] = await photoUrl(e); }));

  // « À traiter » : uniquement ce qui concerne les notes et leur remboursement (les rappels de déplacement restent dans Déplacements)
  const todo = [];
  const nVer = all.filter(e => e.verified === false).length;
  if (nVer) todo.push({ ico: '🔍', label: `${nVer} ${pl(nVer, 'note', 'notes')} à vérifier`, sub: 'Montant, nom et date lus automatiquement', href: '#/relecture' });
  const inc = all.filter(isIncomplete);
  if (inc.length) todo.push({ ico: '✎', label: `${inc.length} ${pl(inc.length, 'note', 'notes')} à compléter`, sub: 'Montant ou type manquant', href: `#/mois?m=${mOf(inc[0])}&f=incomplete` });
  if (dups.size) { const first = all.find(e => dups.has(e.id)); todo.push({ ico: '⧉', label: `${dups.size} doublons possibles`, sub: 'Même date et même montant', href: `#/mois?m=${mOf(first)}&f=doublons` }); }
  const old = all.filter(e => !isNP(e) && e.status === 'declaree' && daysBetween(new Date(e.date), new Date()) > 45);
  if (old.length) todo.push({ ico: '⏱', label: `${old.length} ${pl(old.length, 'note déclarée', 'notes déclarées')} il y a plus de 45 jours`, sub: 'Toujours pas remboursée' + pl(old.length, '', 's'), href: `#/mois?m=${mOf(old[0])}&f=declaree` });

  const pPaid = s.total ? s.remboursee / s.total * 100 : 0, pSent = s.total ? s.declaree / s.total * 100 : 0;
  const bulkable = inMonth.filter(e => !isNP(e) && !isIncomplete(e) && e.verified !== false);
  const special = { incomplete: 'Notes à compléter', doublons: 'Doublons possibles', verifier: 'Notes à vérifier' }[filter];
  const row = e => {
    const moved = e.month && e.month !== monthKey(e.date);
    const nxt = swipeNext(e);
    return `<div class="swipe" data-sw="${e.id}">
      <div class="sw-bg sw-next ${nxt.cls}" aria-hidden="true">${nxt.label} →</div>
      <div class="sw-bg sw-del" aria-hidden="true">Supprimer 🗑</div>
      <div class="row" data-id="${e.id}">
        ${thumbHtml(e, thumbs[e.id])}
        <span style="min-width:0"><div class="t">${esc(rowTitle(e))}</div>
          <div class="s">${esc(rowName(e))}${moved ? ` · <span class="moved">ticket ${monthKey(e.date) < m ? 'du mois précédent' : 'du mois suivant'}</span>` : ''}${photosOf(e).length ? '' : ' · <span style="color:var(--danger)">sans photo</span>'}</div></span>
        <span class="r"><div class="amount${isNP(e) ? ' np-amt' : ''}">${e.amount > 0 ? eur.format(e.amount) : '— €'}${e.dirty ? '<i class="unsynced" title="Pas encore synchronisée"></i>' : ''}</div>
          <span class="pills">${e.verified === false ? '<span class="pill verify">À vérifier</span>' : dups.has(e.id) ? '<span class="pill dup">Doublon ?</span>' : pillHtml(e, true)}</span></span>
      </div></div>`;
  };

  view.className = '';
  view.innerHTML = `
    <div class="topbar month-top">
      <button class="month-title" data-months aria-label="Choisir un mois"><h1>${monthName(m)}</h1><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
      ${topRight()}
    </div>
    <div class="month-grid">
      <div class="mg-a">
        <div class="ticket compact month-card">
          <div class="mc-head"><div><div class="label">Total du mois</div><div class="big num">${eurParts(s.total).split(',')[0]}<small>,${eurParts(s.total).split(',')[1]} €</small></div></div>
            <div class="mc-nav"><a class="btn" href="#/mois?m=${shiftMonth(m, -1)}" aria-label="Mois précédent">‹</a><a class="btn" href="#/mois?m=${shiftMonth(m, 1)}" aria-label="Mois suivant">›</a></div></div>
          <div class="progress" aria-hidden="true"><i class="p1" style="width:${pPaid}%"></i><i class="p2" style="width:${pSent}%"></i></div>
          <div class="split">
            <div>Remboursé<b class="num">${eur.format(s.remboursee)}</b></div>
            <div>Déclaré<b class="num">${eur.format(s.declaree)}</b></div>
            <div>À déclarer<b class="num">${eur.format(s.a_declarer)}</b></div>
          </div>
          <div class="mc-foot">
            <span>Reste à rembourser, tous mois : <b class="num">${eur.format(pendingSum)}</b></span>
            ${bulkable.some(e => e.status !== 'remboursee') ? '<button class="linkish" data-bulkmenu>Tout marquer…</button>' : ''}
          </div>
          ${s.npCount ? `<a class="np-line" href="#/mois?m=${m}&f=${NP}"><span>⏸️ Non pris en compte, sans facture</span><b class="num">${eur.format(s.np)}</b></a>` : ''}
        </div>
        ${todo.length ? `<div class="section-title"><h2>À traiter</h2></div><div class="list todo-list">${todo.map(t => `<a class="row" href="${t.href}"><span class="cat-ico">${t.ico}</span><span style="min-width:0"><div class="t">${t.label}</div><div class="s">${t.sub}</div></span><span class="r"></span></a>`).join('')}</div>` : ''}
      </div>
      <div class="mg-b">
        ${special ? `<div class="filter-head"><h2>${special}</h2><a class="linkish" href="#/mois?m=${m}">Tout afficher</a></div>`
          : `<div class="filter-chips" id="flt">${FILTERS.map(([k, l]) => `<button class="chip${k === NP ? ' chip-np' : ''}" data-f="${k}" aria-pressed="${filter === k}">${l}</button>`).join('')}</div>`}
        ${list.length && !swipeHintSeen() ? '<div class="swipe-hint" id="sw-hint"><span>Glissez <b>→</b> pour l\'état suivant, <b>←</b> pour supprimer. Appui long : changer de mois.</span><button class="linkish" id="sw-hint-ok">OK</button></div>' : ''}
        ${list.length ? `<div class="list">${list.map(row).join('')}</div>`
          : `<div class="list empty"><b>${filter === 'tout' ? `Aucune note en ${monthLabel(m)}` : 'Aucune note ici'}</b>${filter === 'tout' ? 'Touchez « Ajouter » pour photographier ou importer un ticket.' : ''}</div>`}
      </div>
    </div>`;

  const fl = $$('#flt button');
  fl.forEach(b => b.onclick = () => { location.hash = `#/mois?m=${m}${b.dataset.f === 'tout' ? '' : '&f=' + b.dataset.f}`; });
  const on = $('#flt [aria-pressed="true"]'); if (on) on.scrollIntoView({ inline: 'center', block: 'nearest' });
  $('[data-months]').onclick = () => openMonthsSheet(all, m);
  bindRows(all);
  bindSwipes(all);
  const hint = $('#sw-hint-ok'); if (hint) hint.onclick = () => { try { localStorage.setItem('swipeHint', '1'); } catch (_) {} $('#sw-hint').remove(); };
  $$('[data-cycle]').forEach(b => b.onclick = async ev => {
    ev.stopPropagation();
    const e = all.find(x => x.id === b.dataset.cycle);
    await swipeAdvance(e);
  });
  const bm = $('[data-bulkmenu]');
  if (bm) bm.onclick = () => {
    const d = $('#sheet');
    const go = async target => {
      const ids = bulkable.filter(e => STATUS_ORDER.indexOf(e.status) < STATUS_ORDER.indexOf(target)).map(e => e.id);
      if (!(await confirmSheet({ title: `Tout marquer « ${STATUS[target]} » ?`, text: `${ids.length} note${ids.length > 1 ? 's' : ''} de ${monthLabel(m)}. Les notes à vérifier, à compléter ou non prises en compte ne sont pas modifiées.`, ok: `Marquer ${STATUS[target].toLowerCase()}`, danger: false }))) return;
      await setStatus(ids, target); toast(`${monthName(m)} : ${STATUS[target].toLowerCase()}`); render();
    };
    const items = [];
    if (bulkable.some(e => e.status === 'a_declarer')) items.push({ ico: '📨', label: 'Tout marquer déclaré', fn: () => go('declaree') });
    items.push({ ico: '✓', label: 'Tout marquer remboursé', fn: () => go('remboursee') });
    menuSheet(monthName(m), items);
  };
}

// ---------------------------------------------------------------- relecture des montants, noms et dates
// 1) Récapitulatif avant chaque enregistrement d'une note
async function reviewSheet(e, imgUrl) {
  const d = $('#sheet');
  if (d.open) { d.onclose = null; d.close(); await new Promise(r => setTimeout(r, 30)); }
  const c = CAT[e.category] || CAT.autre;
  return new Promise(resolve => {
    d.className = 'sheet menu';
    d.innerHTML = `<div class="menu-box confirm review" role="dialog" aria-labelledby="rv-t">
      <h2 id="rv-t">Vérifiez avant d'enregistrer</h2>
      <div class="rv-body">
        ${imgUrl ? `<img src="${imgUrl}" alt="Photo du ticket" class="rv-img">` : '<div class="rv-img rv-noimg">Pas de photo</div>'}
        <dl>
          <dt>Montant</dt><dd class="rv-amt">${eur.format(e.amount || 0)}</dd>
          <dt>Nom</dt><dd>${esc(e.place || '— (à compléter)')}</dd>
          <dt>Date</dt><dd>${longDay(e.date)}</dd>
          <dt>Type</dt><dd>${c.ico} ${esc(c.label)}</dd>
          ${e.month && e.month !== monthKey(e.date) ? `<dt>Déclarée en</dt><dd>${monthLabel(e.month)}</dd>` : ''}
        </dl>
      </div>
      <div class="confirm-actions"><button class="btn" data-no>Corriger</button><button class="btn btn-primary" data-yes>C'est juste, enregistrer</button></div></div>`;
    let done = false;
    const finish = v => { if (done) return; done = true; d.onclose = null; if (d.open) d.close(); resolve(v); };
    d.querySelector('[data-no]').onclick = () => finish(false);
    d.querySelector('[data-yes]').onclick = () => finish(true);
    d.onclick = ev => { if (ev.target === d) finish(false); };
    d.onclose = () => finish(false);
    d.showModal();
    d.querySelector('[data-yes]').focus();
  });
}

// 2) Écran de relecture : les notes « À vérifier » une par une (photo + montant, nom, date, type)
async function viewReview(params) {
  const queue = (await DB.allExpenses()).filter(e => e.verified === false).sort((a, b) => a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at));
  const total = +(params.get('n') || queue.length);
  view.className = 'narrow';
  if (!queue.length) {
    view.innerHTML = `<div class="topbar"><button class="back" data-back><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Mois</button></div>
      <h1>Relecture</h1>
      <div class="list empty" style="margin-top:16px"><b>Tout est vérifié ✓</b>Les montants, noms et dates de toutes vos notes ont été relus.</div>`;
    $('[data-back]').onclick = () => { location.hash = '#/mois'; };
    return;
  }
  const e = queue[0];
  const urls = await Promise.all(photosOf(e).map(photoUrlOf));
  const pos = Math.max(1, total - queue.length + 1);
  view.innerHTML = `
    <div class="topbar"><button class="back" data-back><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Mois</button><span class="muted rv-pos">${pos} sur ${total}</span></div>
    <h1>Relecture</h1>
    <p class="muted" style="margin:4px 0 14px">Comparez avec la photo, corrigez si besoin, puis validez.</p>
    <div class="photo-zone">${urls[0] ? `<img src="${urls[0]}" alt="Photo du ticket" id="rv-photo">` : '<div class="ph-missing">Photo indisponible hors ligne</div>'}</div>
    <div class="card"><label class="amount-input"><input id="r-amount" inputmode="decimal" value="${e.amount != null ? e.amount.toFixed(2).replace('.', ',') : ''}" placeholder="0,00" aria-label="Montant TTC"><span>€</span></label></div>
    <label class="field"><span>Nom du ticket</span><input id="r-place" value="${esc(e.place)}" placeholder="Ex. Brioche Dorée, Ticket métro"></label>
    <label class="field"><span>Date</span><input type="date" id="r-date" value="${e.date}" max="${todayKey()}"></label>
    <div class="field"><span>Type de dépense</span><div class="chips" id="r-cat">${CATS.map(c => `<button type="button" class="chip${c.id === NP ? ' chip-np' : ''}" data-cat="${c.id}" aria-pressed="${e.category === c.id}">${c.ico} ${c.label}</button>`).join('')}</div></div>
    <div class="form-actions">
      <button class="btn" data-skip>Plus tard</button>
      <button class="btn btn-primary" data-ok>Valider</button>
    </div>`;
  let cat = e.category;
  $('[data-back]').onclick = () => { location.hash = '#/mois'; };
  const ph = $('#rv-photo'); if (ph) ph.onclick = () => openGallery(urls, 0, rowTitle(e));
  $$('#r-cat .chip').forEach(b => b.onclick = () => { cat = b.dataset.cat; $$('#r-cat .chip').forEach(x => x.setAttribute('aria-pressed', x === b)); });
  $('[data-skip]').onclick = async () => {
    // remise en fin de file : on la marque vérifiable plus tard sans la valider
    e.created_at = new Date().toISOString(); await DB.putExpense(e);
    location.hash = `#/relecture?n=${total}&t=${Date.now()}`;
  };
  $('[data-ok]').onclick = async () => {
    const raw = $('#r-amount').value.replace(/\s/g, '').replace(',', '.');
    const amount = raw === '' ? null : Math.round(parseFloat(raw) * 100) / 100;
    if (!(amount > 0)) { toast('Indiquez le montant du ticket.'); $('#r-amount').focus(); return; }
    if (!cat) { toast('Choisissez le type de dépense.'); return; }
    Object.assign(e, { amount, place: $('#r-place').value.trim(), date: $('#r-date').value || e.date, category: cat, verified: true });
    await saveExpense(e);
    toast('Note vérifiée ✓');
    location.hash = `#/relecture?n=${total}&t=${Date.now()}`;
  };
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
  let created = 0, toFix = 0, skipped = 0, linked = 0;
  const show = (row, e) => {
    const c = CAT[e.category] || CAT.autre;
    row.dataset.note = e.id;
    row.querySelector('.t').textContent = rowTitle(e);
    row.querySelector('.s').textContent = rowName(e);
    row.querySelector('.r').innerHTML = `<div class="amount">${e.amount ? eur.format(e.amount) : '— €'}</div>${pillHtml(e)}`;
  };
  const save = async (e, pid, blob) => {
    await DB.putPhoto(pid, blob);
    await saveExpense(e, { photoChanged: true });
    linked += await autoLinkDate(e.date);
    created++; if (isIncomplete(e)) toFix++;
  };
  for (let i = 0; i < files.length; i++) {
    const row = $('#imp-' + i);
    row.querySelector('.s').textContent = 'Lecture…';
    let blob;
    try { blob = await compressImage(files[i]); } catch (_) { row.querySelector('.s').textContent = 'Image illisible, ignorée'; row.querySelector('.cat-ico').textContent = '⚠️'; continue; }
    row.querySelector('.cat-ico').innerHTML = `<img src="${trackUrl(URL.createObjectURL(blob))}" alt="">`;
    const pid = uid();
    const e = { id: uid(), date: todayKey(), category: '', amount: null, place: '', note: '', status: 'a_declarer', reimbursed_on: null, photos: [{ id: pid, path: null }], has_photo: true, photo_path: null, created_at: new Date().toISOString(), deleted: false, verified: false };
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
    if (!e.note) e.note = (await tripTitleFor(e.date)) || '';
    // doublon probable : même date et même montant qu'une note existante → pas importée d'office
    const dup = findDuplicate(e, await DB.allExpenses());
    if (dup) {
      skipped++;
      row.querySelector('.t').textContent = e.place || 'Ticket';
      row.querySelector('.s').innerHTML = `Doublon probable de « ${esc(dup.place || (CAT[dup.category] || CAT.autre).label)} » du ${dateLabel(dup.date)}`;
      row.querySelector('.r').innerHTML = `<div class="amount">${eur.format(e.amount)}</div><button class="pill dup status-btn" data-force>Importer quand même</button>`;
      row.querySelector('[data-force]').onclick = async ev => { ev.stopPropagation(); skipped--; await save(e, pid, blob); show(row, e); };
      continue;
    }
    await save(e, pid, blob);
    show(row, e);
  }
  $('#imp-sub').textContent = `${created} note${created > 1 ? 's' : ''} créée${created > 1 ? 's' : ''}${toFix ? `, dont ${toFix} à compléter` : ''}${skipped ? ` · ${skipped} doublon${skipped > 1 ? 's' : ''} non importé${skipped > 1 ? 's' : ''}` : ''}${linked ? ` · ${linked} rattachée${linked > 1 ? 's' : ''} à vos déplacements` : ''}. Touchez une ligne pour la vérifier.`;
  const done = $('#imp-done');
  done.disabled = false; done.textContent = created ? 'Vérifier les montants' : 'Voir le mois';
  done.onclick = () => { d.close(); location.hash = created ? `#/relecture?t=${Date.now()}` : '#/mois'; render(); };
  $$('#imp-list [data-note]').forEach(r => r.onclick = ev => { if (ev.target.closest('[data-force]')) return; d.close(); location.hash = `#/note/${r.dataset.note}`; });
  refreshBadges();
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
  const needsCol = connected && ((await DB.getMeta('needsPhotosColumn', false)) || (await DB.getMeta('needsMonthColumn', false)) || (await DB.getMeta('needsVerifiedColumn', false)) || (await DB.getMeta('needsTripsTable', false)));
  const prefs = await DB.getMeta('reminder', { weekday: 5, time: '16:30', interval: 2 });
  const nDel = (await deletedItems()).length;
  const days = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const ocrReady = await DB.getMeta('ocrReady', false);

  view.className = 'narrow';
  view.innerHTML = `
    <div class="topbar"><div><h1>Réglages</h1></div>${topRight()}</div>

    <div class="card">
      <h2>Synchronisation iPhone ↔ PC</h2>
      ${connected ? `
        <p>Connecté en tant que <b>${esc(cfg.email)}</b>. Les notes saisies hors ligne partent dès que le wifi ou la 4G revient.</p>
        <p class="muted" style="margin-top:8px">${pending ? `${pending} modification${pending > 1 ? 's' : ''} en attente d'envoi.` : 'Tout est envoyé.'}${lastSync ? ` Dernière synchro : ${new Date(lastSync).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}.` : ''}</p>
        ${needsCol ? `<div class="np-note" style="margin-top:12px"><b>Une mise à jour de Supabase est nécessaire</b> pour synchroniser les déplacements, le mois de déclaration et les photos multiples. Dans Supabase › SQL Editor › New query, collez ce texte puis cliquez sur Run :
          <code class="sql" id="sql-line">${SQL_UPDATE.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code>
          <button class="btn btn-small" id="sql-copy">Copier le texte</button></div>` : ''}
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
      <h2>Rappel dans Outlook</h2>
      <p>Un rendez-vous récurrent dans votre agenda Outlook vous rappelle de saisir vos tickets et de vérifier vos remboursements. Il sonne sur l'iPhone et le PC.</p>
      <div class="grid2" style="margin-top:12px">
        <label class="field"><span>Jour</span><select id="r-day">${[1, 2, 3, 4, 5].map(d => `<option value="${d}" ${+prefs.weekday === d ? 'selected' : ''}>${days[d]}</option>`).join('')}</select></label>
        <label class="field"><span>Heure</span><input type="time" id="r-time" value="${prefs.time}"></label>
      </div>
      <label class="field"><span>Fréquence</span><select id="r-int">${[1, 2, 3, 4].map(n => `<option value="${n}" ${+prefs.interval === n ? 'selected' : ''}>${n === 1 ? 'Chaque semaine' : `Toutes les ${n} semaines`}</option>`).join('')}</select></label>
      <button class="btn btn-block" id="r-dl">Ajouter le rappel à Outlook</button>
      <p class="muted" style="margin-top:8px">Sur le PC, ouvrez le fichier téléchargé puis « Enregistrer et fermer » dans Outlook. Une seule fois suffit.</p>
    </div>

    <a class="card link-card" href="#/historique" style="margin-top:0"><b>Historique des suppressions${nDel ? ` · ${nDel}` : ''}</b><span class="muted">Restaurer une note ou un déplacement supprimé</span></a>

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
    <p class="muted" style="text-align:center;margin-top:18px">Version 1.8 · <button class="linkish" id="upd" style="font-size:14px">Rechercher une mise à jour</button></p>`;

  const lg = $('#login');
  if (lg) lg.onclick = async () => {
    lg.disabled = true; lg.textContent = 'Connexion…';
    try {
      await Sync.login($('#s-url').value, $('#s-key').value, $('#s-email').value, $('#s-pass').value);
      // toutes les notes locales sont à envoyer
      for (const e of await DB.allExpenses({ includeDeleted: true })) { e.photos = photosOf(e).map(p => ({ id: p.id, path: null })); e.dirty = true; e.photo_dirty = e.photos.length > 0; await DB.putExpense(e); }
      for (const t of await DB.allTrips({ includeDeleted: true })) { t.dirty = true; await DB.putTrip(t); }
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
  const savePrefs = () => DB.setMeta('reminder', { weekday: +$('#r-day').value, time: $('#r-time').value || '16:30', interval: +$('#r-int').value });
  ['#r-day', '#r-time', '#r-int'].forEach(x => $(x).onchange = savePrefs);
  $('#r-dl').onclick = async () => {
    await savePrefs();
    const ics = buildReminderICS({ weekday: +$('#r-day').value, time: $('#r-time').value || '16:30', intervalWeeks: +$('#r-int').value, appUrl: location.href.split('#')[0] });
    downloadFile(new Blob([ics], { type: 'text/calendar;charset=utf-8' }), 'rappel-notes-de-frais.ics');
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

// ---------------------------------------------------------------- déplacements (planning par journée)
// Un déplacement = des jours, chacun avec ses étapes (métro, repas, hôtel…), plus des frais généraux (parking…).
// Chaque étape reçoit sa note de frais, ou est marquée « facture attendue » / « pas de frais ».
const STEP_PRESETS = [
  { label: 'Train', cat: 'train' }, { label: 'Métro / bus', cat: 'metro' }, { label: 'Taxi / VTC', cat: 'taxi' }, { label: 'Avion', cat: 'avion' },
  { label: 'Petit-déjeuner', cat: 'boulangerie' }, { label: 'Repas midi', cat: 'restaurant' }, { label: 'Repas soir', cat: 'restaurant' },
  { label: 'Repas client', cat: 'restaurant', note: 'Repas client — invités : ' }, { label: 'Hôtel', cat: 'hotel' },
  { label: 'Parking', cat: 'parking' }, { label: 'Péage', cat: 'peage' }, { label: 'Carburant', cat: 'carburant' },
  { label: 'Fournitures', cat: 'fournitures' }, { label: 'Autre', cat: 'autre' }
];
const preset = label => STEP_PRESETS.find(p => p.label === label) || { label, cat: 'autre' };
const newStep = (label, cat, extra = {}) => ({ id: uid(), label, cat: cat || preset(label).cat, status: 'todo', expense_ids: [], ...extra });

function tripDates(t) {
  const out = [];
  const d = new Date(t.start + 'T12:00'), end = new Date(t.end + 'T12:00');
  for (let i = 0; d <= end && i < 31; i++, d.setDate(d.getDate() + 1)) out.push(dayKey(d));
  return out;
}
const longDay = d => { const s = new Date(d + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }); return s.charAt(0).toUpperCase() + s.slice(1); };

// Étapes habituelles selon la position du jour et le moyen de transport
function templateDay(i, n, mode) {
  const out = mode === 'voiture' ? 'Péage' : mode === 'avion' ? 'Avion' : 'Train';
  const go = [newStep(out, null, { label: `${out} aller` })];
  const back = [newStep(out, null, { label: `${out} retour` })];
  if (mode === 'voiture') { go.push(newStep('Carburant')); }
  const local = mode === 'voiture' ? [] : [newStep('Métro / bus')];
  if (n === 1) return [...go, ...local, newStep('Repas midi'), ...back];
  if (i === 0) return [...go, ...local, newStep('Repas midi'), newStep('Repas soir'), newStep('Hôtel')];
  if (i === n - 1) return [newStep('Petit-déjeuner'), newStep('Repas midi'), ...back, ...local];
  return [newStep('Petit-déjeuner'), ...local, newStep('Repas midi'), newStep('Repas soir'), newStep('Hôtel')];
}

async function saveTrip(t) {
  t.updated_at = new Date().toISOString();
  t.dirty = true;
  await DB.putTrip(t);
  Sync.syncNow();
  refreshBadges();
}

function eachStep(t, fn) {
  Object.entries(t.days || {}).forEach(([d, steps]) => steps.forEach(s => fn(s, d)));
  (t.general || []).forEach(s => fn(s, null));
}

function stepState(s, expMap) {
  const linked = (s.expense_ids || []).map(id => expMap[id]).filter(e => e && !e.deleted);
  if (linked.length) return { s: 'done', linked };
  if (s.status === 'waiting') return { s: 'waiting', linked };
  if (s.status === 'none') return { s: 'none', linked };
  return { s: 'todo', linked };
}

function tripStats(t, expMap) {
  const st = { total: 0, done: 0, waiting: 0, todo: 0, none: 0, steps: 0, amount: 0, overdue: 0 };
  const today = todayKey();
  eachStep(t, (s, d) => {
    const r = stepState(s, expMap);
    st.steps++; st[r.s]++;
    if (r.s === 'todo' && (d ? d < today : t.end < today)) st.overdue++;
    r.linked.forEach(e => { if (!isNP(e)) st.amount += e.amount || 0; });
  });
  return st;
}

// Factures attendues et étapes passées sans justificatif, tous déplacements confondus
async function tripReminders() {
  const trips = await DB.allTrips();
  const exps = await DB.allExpenses();
  const expMap = Object.fromEntries(exps.map(e => [e.id, e]));
  const today = todayKey();
  const waiting = [], overdue = [];
  for (const t of trips) eachStep(t, (s, d) => {
    const r = stepState(s, expMap);
    const item = { trip: t, step: s, day: d };
    if (r.s === 'waiting') waiting.push(item);
    else if (r.s === 'todo' && (d ? d < today : t.end < today)) overdue.push(item);
  });
  return { waiting, overdue };
}

async function linkExpense(tripId, stepId, expenseId) {
  const t = await DB.getTrip(tripId);
  if (!t) return;
  let found = false;
  eachStep(t, s => {
    if (s.id === stepId) { s.expense_ids = [...new Set([...(s.expense_ids || []), expenseId])]; s.status = 'done'; found = true; }
    else if ((s.expense_ids || []).includes(expenseId)) s.expense_ids = s.expense_ids.filter(x => x !== expenseId); // une note = une seule étape
  });
  if (found) await saveTrip(t);
}

async function linkedExpenseIds() {
  const ids = new Set();
  for (const t of await DB.allTrips()) eachStep(t, s => (s.expense_ids || []).forEach(id => ids.add(id)));
  return ids;
}

// ---------- Liste des déplacements ----------
async function viewTrips() {
  const trips = (await DB.allTrips()).sort((a, b) => b.start.localeCompare(a.start));
  const exps = await DB.allExpenses();
  const expMap = Object.fromEntries(exps.map(e => [e.id, e]));
  const { waiting, overdue } = await tripReminders();
  const today = todayKey();
  const label = t => t.title || `Déplacement du ${dateLabel(t.start)}`;
  const since = d => { const n = daysBetween(new Date(d + 'T12:00'), new Date()); return n <= 0 ? "aujourd'hui" : n === 1 ? 'depuis hier' : `depuis ${n} j`; };
  const todo = [...waiting.map(w => ({ ...w, kind: 'waiting' })), ...overdue.map(w => ({ ...w, kind: 'todo' }))];

  view.className = 'narrow';
  view.innerHTML = `
    <div class="topbar"><div><h1>Déplacements</h1></div>${topRight()}</div>
    <button class="new-trip" data-trip-new><span class="cat-ico">＋</span><span><b>Nouveau déplacement</b><small>Les étapes habituelles sont ajoutées pour vous</small></span></button>

    ${todo.length ? `<div class="section-title"><h2>À faire</h2><span class="muted">${todo.length}</span></div>
    <div class="list">${todo.slice(0, 10).map(w => `<div class="row" data-goto="${w.trip.id}">
      <span class="cat-ico">${w.kind === 'waiting' ? '⏳' : (CAT[w.step.cat] || CAT.autre).ico}</span>
      <span style="min-width:0"><div class="t">${esc(w.step.label)}${w.day ? ' · ' + shortDate(w.day) : ''}</div><div class="s">${esc(label(w.trip))}${w.kind === 'waiting' ? ' · facture attendue ' + since(w.step.waiting_since || w.day || w.trip.end) : ''}</div></span>
      <span class="r">${w.kind === 'waiting' ? '<span class="pill waiting">Attendue</span>' : '<span class="pill incomplete">À justifier</span>'}</span></div>`).join('')}</div>` : ''}

    <div class="section-title"><h2>Mes déplacements</h2></div>
    ${trips.length ? `<div class="list">${trips.map(t => {
      const st = tripStats(t, expMap);
      const ok = st.done + st.none;
      const state = t.end < today ? (st.todo || st.waiting ? 'À finir' : 'Complet') : t.start > today ? 'À venir' : 'En cours';
      return `<div class="row trip-row" data-goto="${t.id}">
        <span class="cat-ico">${state === 'Complet' ? '✅' : '🧳'}</span>
        <span style="min-width:0"><div class="t">${esc(label(t))}</div><div class="s">${shortDate(t.start)}${t.end !== t.start ? ' → ' + shortDate(t.end) : ''} · ${ok}/${st.steps} étapes · ${eur.format(st.amount)}</div></span>
        <span class="r"><span class="pill ${state === 'Complet' ? 'remboursee' : state === 'À finir' ? 'incomplete' : 'declaree'}">${state}</span></span>
      </div>`;
    }).join('')}</div>` : `<div class="list empty"><b>Aucun déplacement</b>Créez votre prochain déplacement : il ne restera qu'à attacher un ticket à chaque étape.</div>`}`;

  $('[data-trip-new]').onclick = () => { location.hash = '#/deplacement/new'; };
  $$('[data-goto]').forEach(r => r.onclick = () => { location.hash = `#/deplacement/${r.dataset.goto}`; });
}

// ---------- Création / modification ----------
async function viewTripForm(id) {
  const t = id ? await DB.getTrip(id) : null;
  const start = t ? t.start : todayKey();
  view.className = 'narrow';
  view.innerHTML = `
    <div class="topbar"><button class="back" data-back><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Retour</button></div>
    <h1 style="margin-bottom:16px">${t ? 'Modifier le déplacement' : 'Nouveau déplacement'}</h1>
    <label class="field"><span>Nom du déplacement</span><input id="t-title" value="${esc(t ? t.title : '')}" placeholder="Ex. IDF — vérification lignes de vie client X"></label>
    <div class="grid2">
      <label class="field"><span>Premier jour</span><input type="date" id="t-start" value="${start}"></label>
      <label class="field"><span>Dernier jour</span><input type="date" id="t-end" value="${t ? t.end : start}"></label>
    </div>
    ${t ? '' : `<div class="field"><span>Transport principal</span><div class="segmented" id="t-mode">${[['train', 'Train'], ['voiture', 'Voiture'], ['avion', 'Avion']].map(([k, l], i) => `<button type="button" data-m="${k}" aria-pressed="${i === 0}">${l}</button>`).join('')}</div></div>
    <label class="check"><input type="checkbox" id="t-tpl" checked> Ajouter les étapes habituelles (transport, repas, hôtel, parking). Vous pourrez en retirer ou en ajouter.</label>`}
    <div class="form-actions">
      ${t ? '<button class="btn btn-danger" data-del>Supprimer</button>' : ''}
      <button class="btn btn-primary" data-save>${t ? 'Enregistrer' : 'Créer le déplacement'}</button>
    </div>`;
  let mode = 'train';
  $$('#t-mode button').forEach(b => b.onclick = () => { mode = b.dataset.m; $$('#t-mode button').forEach(x => x.setAttribute('aria-pressed', x === b)); });
  $('#t-start').onchange = () => { if ($('#t-end').value < $('#t-start').value) $('#t-end').value = $('#t-start').value; };
  $('[data-back]').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/deplacements');
  $('[data-save]').onclick = async () => {
    const s = $('#t-start').value, e = $('#t-end').value;
    if (!s || !e || e < s) { toast('Vérifiez les dates du déplacement.'); return; }
    if (daysBetween(new Date(s), new Date(e)) > 30) { toast('Un déplacement dure au maximum 31 jours.'); return; }
    const title = $('#t-title').value.trim();
    if (t) {
      t.title = title; t.start = s; t.end = e;
      const dates = tripDates(t);
      dates.forEach(d => { t.days[d] = t.days[d] || []; });
      // les étapes des jours retirés qui ont une note passent dans les frais du déplacement
      Object.keys(t.days).filter(d => !dates.includes(d)).forEach(d => { t.general.push(...t.days[d].filter(x => (x.expense_ids || []).length)); delete t.days[d]; });
      await saveTrip(t);
      location.hash = `#/deplacement/${t.id}`;
      return;
    }
    const trip = { id: uid(), title, start: s, end: e, days: {}, general: [], created_at: new Date().toISOString(), deleted: false };
    const dates = tripDates(trip);
    const tpl = $('#t-tpl').checked;
    dates.forEach((d, i) => { trip.days[d] = tpl ? templateDay(i, dates.length, mode) : []; });
    if (tpl) trip.general = [newStep('Parking', 'parking', { label: mode === 'train' ? 'Parking gare' : mode === 'avion' ? 'Parking aéroport' : 'Parking' })];
    await saveTrip(trip);
    // rattacher tout de suite les notes déjà saisies sur ces dates
    const n = await autoLink(trip.id);
    toast(n ? `Déplacement créé · ${n} note${n > 1 ? 's' : ''} déjà rattachée${n > 1 ? 's' : ''}` : 'Déplacement créé');
    location.hash = `#/deplacement/${trip.id}`;
  };
  const del = $('[data-del]');
  if (del) del.onclick = async () => {
    if (!(await confirmSheet({ title: 'Supprimer ce déplacement ?', text: `« ${esc(t.title || 'Déplacement')} » et ses étapes iront dans l'historique des suppressions. Les notes de frais elles-mêmes sont conservées dans vos mois.` }))) return;
    t.deleted = true; t.deleted_at = new Date().toISOString(); await saveTrip(t);
    location.hash = '#/deplacements';
    toast('Déplacement supprimé', { label: 'Annuler', fn: async () => { const x = await DB.getTrip(t.id); x.deleted = false; x.deleted_at = null; await saveTrip(x); location.hash = `#/deplacement/${t.id}`; } });
  };
}

// Rattache les notes non rattachées aux étapes « à justifier » du même jour et du même type
async function autoLink(tripId) {
  const t = await DB.getTrip(tripId);
  const used = await linkedExpenseIds();
  const free = (await DB.allExpenses()).filter(e => !used.has(e.id) && e.date >= t.start && e.date <= t.end);
  let n = 0;
  const expMap = Object.fromEntries((await DB.allExpenses()).map(e => [e.id, e]));
  for (const e of free.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const pool = [...(t.days[e.date] || []), ...(t.general || [])];
    const match = pool.find(s => stepState(s, expMap).s !== 'done' && s.status !== 'none' && s.cat === e.category)
      || (isNP(e) ? null : pool.find(s => stepState(s, expMap).s !== 'done' && s.status !== 'none' && CAT[s.cat] && s.cat !== 'autre' && (e.category === 'restaurant' || e.category === 'boulangerie') && (s.cat === 'restaurant' || s.cat === 'boulangerie')));
    if (match) { match.expense_ids = [...(match.expense_ids || []), e.id]; match.status = 'done'; expMap[e.id] = e; n++; }
  }
  if (n) await saveTrip(t);
  return n;
}

// ---------- Détail d'un déplacement ----------
async function viewTrip(id) {
  const t = await DB.getTrip(id);
  if (!t || t.deleted) { location.hash = '#/deplacements'; return; }
  const exps = await DB.allExpenses();
  const expMap = Object.fromEntries(exps.map(e => [e.id, e]));
  const used = await linkedExpenseIds();
  const st = tripStats(t, expMap);
  const loose = exps.filter(e => !used.has(e.id) && e.date >= t.start && e.date <= t.end).sort((a, b) => a.date.localeCompare(b.date));
  const thumbs = {};
  const allLinked = []; eachStep(t, s => stepState(s, expMap).linked.forEach(e => allLinked.push(e)));
  await Promise.all([...allLinked, ...loose].filter(e => photosOf(e).length).map(async e => { thumbs[e.id] = await photoUrl(e); }));

  const stepRow = (s, d) => {
    const r = stepState(s, expMap);
    const c = CAT[s.cat] || CAT.autre;
    const e = r.linked[0];
    const sub = r.s === 'done' ? `${esc(rowName(e))}${r.linked.length > 1 ? ` + ${r.linked.length - 1} autre${r.linked.length > 2 ? 's' : ''}` : ''}`
      : r.s === 'waiting' ? 'Facture pas encore reçue' : r.s === 'none' ? 'Pas de frais' : 'Ajouter le ticket';
    const right = r.s === 'done' ? `<span class="step-ok"><span class="amount${isNP(e) ? ' np-amt' : ''}">${eur.format(r.linked.reduce((a, x) => a + (x.amount || 0), 0))}</span><i class="check" aria-label="Justifiée">✓</i></span>`
      : r.s === 'waiting' ? '<span class="pill waiting">Attendue</span>' : r.s === 'none' ? '<span class="pill none">Pas de frais</span>' : '<span class="pill incomplete">À justifier</span>';
    return `<div class="row step ${r.s}" data-step="${s.id}" data-day="${d || ''}">
      <span class="cat-ico">${r.s === 'waiting' ? '⏳' : c.ico}</span>
      <span style="min-width:0"><div class="t">${esc(s.label)}</div><div class="s">${sub}</div></span>
      <span class="r">${right}</span></div>`;
  };
  const addRow = d => `<button class="row add-step" data-add="${d || ''}"><span class="cat-ico">＋</span><span class="t">Ajouter une étape</span></button>`;

  view.className = 'narrow';
  view.innerHTML = `
    <div class="topbar"><button class="back" data-back><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Déplacements</button><button class="btn btn-small" data-edit>Modifier</button></div>
    <h1>${esc(t.title || 'Déplacement')}</h1>
    <div class="sub muted" style="margin:4px 0 14px">${longDay(t.start)}${t.end !== t.start ? ' → ' + longDay(t.end) : ''}</div>
    <div class="ticket trip-ticket">
      <div class="label">Total justifié</div>
      <div class="big num">${eurParts(st.amount).split(',')[0]}<small>,${eurParts(st.amount).split(',')[1]} €</small></div>
      <div class="progress" aria-hidden="true" style="margin-top:10px"><i class="p1" style="width:${st.steps ? st.done / st.steps * 100 : 0}%"></i><i class="p3" style="width:${st.steps ? st.none / st.steps * 100 : 0}%"></i><i class="p4" style="width:${st.steps ? st.waiting / st.steps * 100 : 0}%"></i></div>
      <div class="split">
        <div>Justifiées<b class="num">${st.done}/${st.steps}</b></div>
        <div>Attendues<b class="num">${st.waiting}</b></div>
        <div>À justifier<b class="num">${st.todo}</b></div>
      </div>
    </div>
    ${tripDates(t).map(d => `<section class="day"><div class="day-head"><h2>${longDay(d)}</h2></div>
      <div class="list">${(t.days[d] || []).map(s => stepRow(s, d)).join('')}${addRow(d)}</div></section>`).join('')}
    <section class="day"><div class="day-head"><h2>Frais du déplacement</h2><span class="muted">parking, péage, carburant…</span></div>
      <div class="list">${(t.general || []).map(s => stepRow(s, null)).join('')}${addRow(null)}</div></section>
    ${loose.length ? `<section class="day"><div class="day-head"><h2>Notes à rattacher</h2><button class="linkish" data-autolink>Tout rattacher</button></div>
      <div class="list">${loose.map(e => `<div class="row" data-loose="${e.id}">${thumbHtml(e, thumbs[e.id])}<span style="min-width:0"><div class="t">${esc(rowTitle(e))}</div><div class="s">${esc(rowName(e))}</div></span><span class="r"><div class="amount">${e.amount > 0 ? eur.format(e.amount) : '— €'}</div><span class="pill declaree">Rattacher</span></span></div>`).join('')}</div></section>` : ''}`;

  $('[data-back]').onclick = () => { location.hash = '#/deplacements'; };
  $('[data-edit]').onclick = () => { location.hash = `#/deplacement/${t.id}/modifier`; };
  const al = $('[data-autolink]');
  if (al) al.onclick = async () => { const n = await autoLink(t.id); toast(n ? `${n} note${n > 1 ? 's' : ''} rattachée${n > 1 ? 's' : ''}` : 'Aucune étape correspondante : rattachez-les à la main ci-dessous'); render(); };
  bindRows(exps);
  $$('[data-step]').forEach(r => r.onclick = ev => { if (ev.target.closest('[data-view]')) return; openStepMenu(t, r.dataset.step, r.dataset.day || null, expMap); });
  $$('[data-add]').forEach(b => b.onclick = () => openAddStep(t, b.dataset.add || null));
  $$('[data-loose]').forEach(r => r.onclick = ev => { if (ev.target.closest('[data-view]')) return; openAttach(t, expMap[r.dataset.loose], expMap); });
}

function findStep(t, stepId) {
  let found = null, day = null, list = null;
  Object.entries(t.days).forEach(([d, steps]) => steps.forEach(s => { if (s.id === stepId) { found = s; day = d; list = steps; } }));
  (t.general || []).forEach(s => { if (s.id === stepId) { found = s; day = null; list = t.general; } });
  return { step: found, day, list };
}

function menuSheet(title, items) {
  const d = $('#sheet');
  d.className = 'sheet menu';
  d.innerHTML = `<div class="menu-box"><h2>${title}</h2>${items.map((it, i) => it.html ? it.html : `<button class="menu-item${it.danger ? ' danger' : ''}" data-i="${i}"><span class="mi-ico">${it.ico || ''}</span><span><b>${it.label}</b>${it.sub ? `<small>${it.sub}</small>` : ''}</span></button>`).join('')}<button class="btn btn-block" data-close>Fermer</button></div>`;
  d.onclick = ev => { if (ev.target === d) d.close(); };
  d.querySelector('[data-close]').onclick = () => d.close();
  items.forEach((it, i) => { const b = d.querySelector(`[data-i="${i}"]`); if (b) b.onclick = () => it.fn(); });
  d.showModal();
  return d;
}

function openStepMenu(t, stepId, day, expMap) {
  const { step, list } = findStep(t, stepId);
  if (!step) return;
  const r = stepState(step, expMap);
  const d = $('#sheet');
  const date = day || (todayKey() >= t.start && todayKey() <= t.end ? todayKey() : t.start);
  const newNote = src => {
    const picked = src ? pickPhotos(src, false) : null; // doit partir du geste
    d.close();
    const go = () => { location.hash = `#/note/new?date=${date}&cat=${step.cat}&trip=${t.id}&step=${step.id}${preset(step.label).note ? '&note=' + encodeURIComponent(preset(step.label).note) : ''}`; };
    if (!picked) { pendingPhoto = null; go(); return; }
    pendingPhoto = picked.then(f => f[0] || null);
    go();
  };
  const candidates = Object.values(expMap).filter(e => !e.deleted && (day ? e.date === day : e.date >= t.start && e.date <= t.end) && !(step.expense_ids || []).includes(e.id));
  const items = [];
  if (r.s === 'done') r.linked.forEach(e => items.push({ ico: (CAT[e.category] || CAT.autre).ico, label: `${esc(e.place || (CAT[e.category] || CAT.autre).label)} · ${eur.format(e.amount || 0)}`, sub: 'Ouvrir la note', fn: () => { d.close(); location.hash = `#/note/${e.id}`; } }));
  items.push({ ico: '📷', label: r.s === 'done' ? 'Ajouter un autre ticket' : 'Prendre une photo du ticket', sub: 'La note se remplit seule et est rattachée à cette étape', fn: () => newNote('camera') });
  items.push({ ico: '🖼️', label: 'Importer depuis le téléphone', sub: 'Photo ou capture d\'écran', fn: () => newNote('gallery') });
  if (candidates.length) items.push({ ico: '🔗', label: 'Associer une note déjà saisie', sub: `${candidates.length} note${candidates.length > 1 ? 's' : ''} ${day ? 'ce jour-là' : 'pendant ce déplacement'}`, fn: () => {
    menuSheet('Associer une note', candidates.map(e => ({ ico: (CAT[e.category] || CAT.autre).ico, label: `${esc(e.place || (CAT[e.category] || CAT.autre).label)} · ${e.amount > 0 ? eur.format(e.amount) : '— €'}`, sub: dateLabel(e.date), fn: async () => { d.close(); await linkExpense(t.id, step.id, e.id); toast('Note rattachée'); render(); } })));
  } });
  if (r.s !== 'done') {
    items.push({ ico: '⏳', label: r.s === 'waiting' ? 'Facture reçue ? Retirer le pense-bête' : 'Facture pas encore reçue', sub: r.s === 'waiting' ? '' : 'Pense-bête jusqu\'à ce que vous ajoutiez la facture (hôtel, réservation…)', fn: async () => { step.status = r.s === 'waiting' ? 'todo' : 'waiting'; step.waiting_since = step.status === 'waiting' ? todayKey() : null; d.close(); await saveTrip(t); render(); } });
    items.push({ ico: '✕', label: r.s === 'none' ? 'Finalement, il y a des frais' : 'Pas de frais pour cette étape', sub: r.s === 'none' ? '' : 'Ex. repas offert, trajet en voiture de collègue', fn: async () => { step.status = r.s === 'none' ? 'todo' : 'none'; d.close(); await saveTrip(t); render(); } });
  } else {
    items.push({ ico: '↩︎', label: 'Détacher la note de cette étape', sub: 'La note reste dans votre tableau', fn: async () => { step.expense_ids = []; step.status = 'todo'; d.close(); await saveTrip(t); render(); } });
  }
  if (r.s === 'done') r.linked.forEach(e => items.push({ ico: '🗑', label: `Supprimer la note ${eur.format(e.amount || 0)}`, sub: 'Elle ira dans l\'historique des suppressions', danger: true, fn: async () => { if (await deleteExpense(e)) render(); } }));
  items.push({ ico: '🗑', label: 'Supprimer l\'étape', sub: r.s === 'done' ? 'Les notes rattachées restent dans vos mois' : '', danger: true, fn: async () => {
    if (!(await confirmSheet({ title: 'Supprimer cette étape ?', text: `« ${esc(step.label)} »${day ? ' du ' + dateLabel(day) : ''} sera retirée du déplacement.${r.s === 'done' ? ' Les notes rattachées restent dans vos mois.' : ''}` }))) return;
    const idx = list.indexOf(step); list.splice(idx, 1); await saveTrip(t); render();
    toast('Étape supprimée', { label: 'Annuler', fn: async () => { const x = await DB.getTrip(t.id); const where = day ? x.days[day] : x.general; where.splice(idx, 0, step); await saveTrip(x); render(); } });
  } });
  menuSheet(`${esc(step.label)}${day ? ' · ' + dateLabel(day) : ''}`, items);
}

function openAddStep(t, day) {
  const d = menuSheet(day ? `Ajouter une étape · ${dateLabel(day)}` : 'Ajouter un frais du déplacement', [{ html: `<div class="chips step-chips">${STEP_PRESETS.map(p => `<button class="chip" data-p="${esc(p.label)}">${(CAT[p.cat] || CAT.autre).ico} ${p.label}</button>`).join('')}</div>
    <label class="field" style="margin:6px 0 0"><span>Ou une étape personnalisée</span><div class="btn-row" style="flex-wrap:nowrap"><input id="custom-step" placeholder="Ex. Vestiaire salon" style="flex:1"><button class="btn btn-primary" id="custom-add">Ajouter</button></div></label>` }]);
  const add = async (label, cat) => {
    const s = newStep(label, cat);
    if (day) (t.days[day] = t.days[day] || []).push(s); else (t.general = t.general || []).push(s);
    d.close(); await saveTrip(t); render();
  };
  d.querySelectorAll('[data-p]').forEach(b => b.onclick = () => add(b.dataset.p, preset(b.dataset.p).cat));
  d.querySelector('#custom-add').onclick = () => { const v = d.querySelector('#custom-step').value.trim(); if (v) add(v, 'autre'); };
}

function openAttach(t, e, expMap) {
  const pool = [...(t.days[e.date] || []).map(s => ({ s, d: e.date })), ...(t.general || []).map(s => ({ s, d: null }))]
    .filter(x => stepState(x.s, expMap).s !== 'none');
  const d = $('#sheet');
  menuSheet(`Rattacher « ${esc(e.place || (CAT[e.category] || CAT.autre).label)} »`, [
    ...pool.map(x => ({ ico: (CAT[x.s.cat] || CAT.autre).ico, label: esc(x.s.label), sub: `${x.d ? dateLabel(x.d) : 'Frais du déplacement'} · ${({ done: 'déjà justifiée', waiting: 'facture attendue', todo: 'à justifier' })[stepState(x.s, expMap).s]}`, fn: async () => { d.close(); await linkExpense(t.id, x.s.id, e.id); toast('Note rattachée'); render(); } })),
    { ico: '＋', label: 'Nouvelle étape pour cette note', sub: e.date ? dateLabel(e.date) : '', fn: async () => {
      const s = newStep((CAT[e.category] || CAT.autre).label, e.category || 'autre'); s.expense_ids = [e.id]; s.status = 'done';
      (t.days[e.date] = t.days[e.date] || []).push(s); d.close(); await saveTrip(t); render();
    } },
    { ico: '👁', label: 'Ouvrir la note', fn: () => { d.close(); location.hash = `#/note/${e.id}`; } }
  ]);
}

// ---------------------------------------------------------------- suppression avec validation + historique
// Message de validation (remplace la fenêtre « confirm » du navigateur)
async function confirmSheet({ title, text, ok = 'Supprimer', danger = true }) {
  const d = $('#sheet');
  if (d.open) { d.onclose = null; d.close(); await new Promise(r => setTimeout(r, 30)); } // laisser passer la fermeture du menu précédent
  return new Promise(resolve => {
    d.className = 'sheet menu';
    d.innerHTML = `<div class="menu-box confirm" role="alertdialog" aria-labelledby="cf-t" aria-describedby="cf-x">
      <h2 id="cf-t">${title}</h2><p id="cf-x">${text}</p>
      <div class="confirm-actions"><button class="btn" data-no>Annuler</button><button class="btn ${danger ? 'btn-del' : 'btn-primary'}" data-yes>${ok}</button></div></div>`;
    let done = false;
    const finish = v => { if (done) return; done = true; d.onclose = null; if (d.open) d.close(); resolve(v); };
    d.querySelector('[data-no]').onclick = () => finish(false);
    d.querySelector('[data-yes]').onclick = () => finish(true);
    d.onclick = ev => { if (ev.target === d) finish(false); };
    d.onclose = () => finish(false); // touche Échap
    d.showModal();
    d.querySelector('[data-no]').focus();
  });
}

const noteTitle = e => `${rowTitle(e)} · ${rowName(e)} · ${e.amount > 0 ? eur.format(e.amount) : '— €'}`;

async function deleteExpense(e, { ask = true } = {}) {
  if (ask && !(await confirmSheet({ title: 'Supprimer cette note ?', text: `<b>${esc(noteTitle(e))}</b><br>Elle ira dans l'historique des suppressions : vous pourrez la restaurer avec ses photos.` }))) return false;
  const x = (await DB.getExpense(e.id)) || e;
  x.deleted = true; x.deleted_at = new Date().toISOString();
  await saveExpense(x);
  toast('Note supprimée', { label: 'Annuler', fn: async () => { await restoreExpense(x.id); render(); } });
  return true;
}

async function restoreExpense(id) {
  const e = await DB.getExpense(id);
  if (!e || e.status === 'purge') return;
  e.deleted = false; e.deleted_at = null;
  await saveExpense(e, { photoChanged: photosOf(e).some(p => !p.path) });
}

async function purgeExpense(id) {
  const e = await DB.getExpense(id);
  if (!e) return;
  for (const p of photosOf(e)) await DB.deletePhoto(p.id);
  e.deleted = true; e.status = 'purge'; // « purge » = supprimée définitivement, photos effacées du cloud
  await saveExpense(e, { photoChanged: true });
}

async function deletedItems() {
  const notes = (await DB.allExpenses({ includeDeleted: true })).filter(e => e.deleted && e.status !== 'purge').map(e => ({ kind: 'note', at: e.deleted_at || e.updated_at, e }));
  const trips = (await DB.allTrips({ includeDeleted: true })).filter(t => t.deleted && !t.purged).map(t => ({ kind: 'trip', at: t.deleted_at || t.updated_at, t }));
  return [...notes, ...trips].sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}

async function viewHistory() {
  const items = await deletedItems();
  const thumbs = {};
  await Promise.all(items.filter(i => i.kind === 'note' && photosOf(i.e).length).map(async i => { thumbs[i.e.id] = await photoUrl(i.e); }));
  const when = at => at ? new Date(at).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  view.className = 'narrow';
  view.innerHTML = `
    <div class="topbar"><button class="back" data-back><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Retour</button>${topRight()}</div>
    <h1>Historique des suppressions</h1>
    <p class="muted" style="margin:6px 0 16px">Les notes et déplacements supprimés restent ici, avec leurs photos, jusqu'à ce que vous les supprimiez définitivement.</p>
    ${items.length ? `<div class="list">${items.map(i => i.kind === 'note' ? `<div class="row hist" data-note="${i.e.id}">
        ${thumbHtml(i.e, thumbs[i.e.id])}
        <span style="min-width:0"><div class="t">${esc(rowTitle(i.e))}</div><div class="s">${esc(rowName(i.e))} · supprimée ${when(i.at)}</div></span>
        <span class="r"><div class="amount">${i.e.amount > 0 ? eur.format(i.e.amount) : '— €'}</div></span>
        <div class="hist-actions"><button class="btn btn-small" data-restore="${i.e.id}">Restaurer</button><button class="btn btn-small btn-danger" data-purge="${i.e.id}">Supprimer définitivement</button></div>
      </div>` : `<div class="row hist">
        <span class="cat-ico">🧳</span>
        <span style="min-width:0"><div class="t">${esc(i.t.title || 'Déplacement')}</div><div class="s">Déplacement du ${dateLabel(i.t.start)} · supprimé ${when(i.at)}</div></span>
        <span class="r"></span>
        <div class="hist-actions"><button class="btn btn-small" data-trestore="${i.t.id}">Restaurer</button><button class="btn btn-small btn-danger" data-tpurge="${i.t.id}">Supprimer définitivement</button></div>
      </div>`).join('')}</div>
      <button class="btn btn-danger btn-block" data-empty style="margin-top:16px">Vider l'historique</button>`
    : `<div class="list empty"><b>Aucune suppression</b>Quand vous supprimez une note ou un déplacement, il apparaît ici et peut être restauré.</div>`}`;

  $('[data-back]').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/mois');
  const exps = items.filter(i => i.kind === 'note').map(i => i.e);
  $$('[data-view]').forEach(b => b.onclick = ev => { ev.stopPropagation(); const e = exps.find(x => x.id === b.dataset.view); if (e) openNotePhotos(e); });
  $$('[data-restore]').forEach(b => b.onclick = async () => { await restoreExpense(b.dataset.restore); const e = await DB.getExpense(b.dataset.restore); toast(`Note restaurée en ${monthLabel(mOf(e))}`); render(); });
  $$('[data-purge]').forEach(b => b.onclick = async () => {
    const e = exps.find(x => x.id === b.dataset.purge);
    if (!(await confirmSheet({ title: 'Supprimer définitivement ?', text: `<b>${esc(noteTitle(e))}</b><br>La note et ses photos seront effacées sur tous vos appareils. Cette action est irréversible.`, ok: 'Supprimer définitivement' }))) return;
    await purgeExpense(e.id); toast('Note supprimée définitivement'); render();
  });
  $$('[data-trestore]').forEach(b => b.onclick = async () => { const t = await DB.getTrip(b.dataset.trestore); t.deleted = false; t.deleted_at = null; await saveTrip(t); toast('Déplacement restauré'); render(); });
  $$('[data-tpurge]').forEach(b => b.onclick = async () => {
    const t = await DB.getTrip(b.dataset.tpurge);
    if (!(await confirmSheet({ title: 'Supprimer définitivement ?', text: `Le déplacement « ${esc(t.title || 'Déplacement')} » sera effacé sur tous vos appareils. Les notes de frais restent dans vos mois. Cette action est irréversible.`, ok: 'Supprimer définitivement' }))) return;
    t.purged = true; t.days = {}; t.general = []; await saveTrip(t); toast('Déplacement supprimé définitivement'); render();
  });
  const empty = $('[data-empty]');
  if (empty) empty.onclick = async () => {
    if (!(await confirmSheet({ title: 'Vider l\'historique ?', text: `${items.length} élément${items.length > 1 ? 's' : ''} ser${items.length > 1 ? 'ont' : 'a'} effacé${items.length > 1 ? 's' : ''} définitivement, photos comprises, sur tous vos appareils. Cette action est irréversible.`, ok: 'Tout supprimer définitivement' }))) return;
    for (const i of items) {
      if (i.kind === 'note') await purgeExpense(i.e.id);
      else { const t = await DB.getTrip(i.t.id); t.purged = true; t.days = {}; t.general = []; await saveTrip(t); }
    }
    toast('Historique vidé'); render();
  };
}

// ---------------------------------------------------------------- doublons
const dupKey = e => `${e.date}|${(e.amount || 0).toFixed(2)}`;
function findDuplicate(e, all) {
  if (!(e.amount > 0)) return null;
  return all.find(x => x.id !== e.id && !x.deleted && x.date === e.date && Math.abs((x.amount || 0) - e.amount) < 0.005) || null;
}
function duplicateIds(all) {
  const groups = {};
  all.filter(e => e.amount > 0).forEach(e => { (groups[dupKey(e)] = groups[dupKey(e)] || []).push(e.id); });
  return new Set(Object.values(groups).filter(g => g.length > 1).flat());
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
  const lines = [['Mois de déclaration', 'Date', 'Type', 'Lieu', 'Chantier / remarque', 'Montant TTC (€)', 'Statut', 'Compté dans le remboursement', 'Remboursée le', 'Photos'].map(q).join(';')];
  all.forEach(e => {
    const [y, m, d] = e.date.split('-');
    lines.push([monthLabel(mOf(e)), `${d}/${m}/${y}`, e.category ? (CAT[e.category] || CAT.autre).label : '', e.place, e.note, num(e.amount),
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
  const [path, qs] = (location.hash || '#/deplacements').slice(1).split('?');
  const params = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  let route = parts[0] || 'deplacements';
  if (route === 'accueil' || route === 'tableau') route = 'mois';           // anciens liens
  if (route === 'planning') route = 'reglages';
  const tab = { deplacement: 'deplacements', note: '', historique: 'reglages', relecture: 'mois' }[route] ?? route;
  $$('[data-tab]').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  if (route === 'note') {
    await viewForm(parts[1] === 'new' ? null : parts[1], { date: params.get('date'), place: params.get('place'), cat: params.get('cat'), note: params.get('note'), trip: params.get('trip'), step: params.get('step') });
  } else if (route === 'deplacement') {
    if (parts[1] === 'new') await viewTripForm(null);
    else if (parts[2] === 'modifier') await viewTripForm(parts[1]);
    else await viewTrip(parts[1]);
  } else if (route === 'mois') await viewMonth(params);
  else if (route === 'reglages') await viewSettings();
  else if (route === 'historique') await viewHistory();
  else if (route === 'relecture') await viewReview(params);
  else await viewTrips();
  view.scrollTop = 0; window.scrollTo(0, 0);
  // barre de titre compacte façon iPhone, visible quand le grand titre sort de l'écran
  const h1 = $('#view h1');
  $('#nav-title').textContent = h1 ? h1.textContent : '';
  document.body.classList.remove('scrolled');
}
window.addEventListener('scroll', () => { document.body.classList.toggle('scrolled', window.scrollY > 56); }, { passive: true });

// Menu du bouton « + » : photo, import depuis le téléphone, ou saisie sans photo
function openAddMenu() {
  const d = $('#sheet');
  d.className = 'sheet menu';
  const ico = p => `<svg viewBox="0 0 24 24">${p}</svg>`;
  d.innerHTML = `<div class="menu-box">
    <h2>Nouvelle note de frais</h2>
    <button class="menu-item" data-m="camera">${ico('<path d="M9 4.5 7.6 6.5H5a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5a2 2 0 0 0-2-2h-2.6L15 4.5z"/><circle cx="12" cy="13" r="3.6"/>')}<span><b>Prendre une photo</b><small>Le ticket est lu et la note se remplit seule</small></span></button>
    <button class="menu-item" data-m="gallery">${ico('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>')}<span><b>Importer depuis le téléphone</b><small>Photos ou captures d'écran, une ou plusieurs à la fois</small></span></button>
    <button class="menu-item" data-m="manual">${ico('<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>')}<span><b>Saisir sans photo</b><small>Vous ajouterez le justificatif plus tard</small></span></button>
    <button class="btn btn-block" data-m="cancel">Annuler</button>
  </div>`;
  const goNew = () => { if (location.hash === '#/note/new') render(); else location.hash = '#/note/new'; };
  d.onclick = ev => { if (ev.target === d) d.close(); };
  d.querySelector('[data-m=camera]').onclick = () => { pendingPhoto = pickPhoto('camera'); d.close(); goNew(); };
  d.querySelector('[data-m=gallery]').onclick = () => {
    const picked = pickPhotos('gallery', true); // doit partir du geste de l'utilisateur
    d.close();
    picked.then(files => {
      if (!files.length) return;
      if (files.length === 1) { pendingPhoto = Promise.resolve(files[0]); goNew(); } // une photo : la note s'ouvre pour vérification
      else importPhotos(files);                                                 // plusieurs : une note par photo
    });
  };
  d.querySelector('[data-m=manual]').onclick = () => { pendingPhoto = null; d.close(); goNew(); };
  d.querySelector('[data-m=cancel]').onclick = () => d.close();
  d.showModal();
}

document.addEventListener('click', ev => {
  const a = ev.target.closest('[data-action]');
  if (!a) return;
  const act = a.dataset.action;
  if (act === 'add') openAddMenu();
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
