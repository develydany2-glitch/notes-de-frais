import { DB } from './db.js';
import * as Sync from './sync.js';
import { buildReminderICS, parseICS, tripDays, dayKey } from './ics.js';

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
  { id: 'autre', label: 'Autre', ico: '🧾' }
];
const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));
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

// ---------------------------------------------------------------- toast
let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label; b.onclick = () => { action.fn(); t.classList.remove('show'); };
    t.appendChild(b);
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2600);
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

function pickPhoto(source = 'camera') {
  return new Promise(resolve => {
    const input = source === 'camera' ? $('#cam') : $('#gal');
    input.value = '';
    input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
    input.click();
  });
}

async function photoUrl(e) {
  if (!e.has_photo) return null;
  let blob = await DB.getPhoto(e.id);
  if (!blob && e.photo_path) { try { blob = await Sync.fetchPhoto(e); } catch (_) { blob = null; } }
  return blob ? trackUrl(URL.createObjectURL(blob)) : null;
}

function openViewer(src, title) {
  const d = $('#sheet');
  d.innerHTML = `<div class="viewer"><div class="bar"><span>${esc(title || 'Justificatif')}</span><button data-close>Fermer</button></div><img src="${src}" alt="Photo du justificatif"></div>`;
  d.querySelector('[data-close]').onclick = () => d.close();
  d.showModal();
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
  const s = { total: 0, a_declarer: 0, declaree: 0, remboursee: 0, nophoto: 0 };
  items.forEach(e => { s.total += e.amount || 0; s[e.status] += e.amount || 0; if (!e.has_photo) s.nophoto++; });
  return s;
}

// ---------------------------------------------------------------- oublis (planning)
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
  const todo = (await DB.allExpenses()).filter(e => e.status === 'a_declarer').length;
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
  const ico = thumb ? `<img src="${thumb}" alt="">` : c.ico;
  return `<a class="row" href="#/note/${e.id}">
    <span class="cat-ico">${ico}</span>
    <span style="min-width:0"><div class="t">${esc(e.place || c.label)}</div><div class="s">${dateLabel(e.date)} · ${esc(c.label)}${e.has_photo ? '' : ' · <span style="color:var(--danger)">sans photo</span>'}</div></span>
    <span class="r"><div class="amount">${eur.format(e.amount || 0)}${e.dirty ? '<i class="unsynced" title="Pas encore synchronisée"></i>' : ''}</div><span class="pill ${e.status}">${STATUS[e.status]}</span></span>
  </a>`;
}

async function viewHome() {
  const all = await DB.allExpenses();
  const mk = monthKey(todayKey());
  const thisMonth = all.filter(e => monthKey(e.date) === mk);
  const pending = all.filter(e => e.status !== 'remboursee');
  const pendingSum = pending.reduce((a, e) => a + (e.amount || 0), 0);
  const s = sums(all);
  const recent = [...all].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 8);
  const [whole, cents] = eurParts(pendingSum).split(',');

  const alerts = [];
  const miss = await missingDays();
  if (miss.length) alerts.push(`<div class="alert"><svg viewBox="0 0 24 24"><path d="M12 3 2 20h20zM12 10v4M12 17v.5"/></svg><div><b>${miss.length} jour${miss.length > 1 ? 's' : ''} de déplacement sans note</b><p>Votre planning Outlook indique des déplacements pour lesquels aucun ticket n'est saisi.</p><a class="btn btn-small btn-accent" href="#/planning">Vérifier les jours</a></div></div>`);
  const oldDeclared = all.filter(e => e.status === 'declaree' && daysBetween(new Date(e.date), new Date()) > 45);
  if (oldDeclared.length) alerts.push(`<div class="alert"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><div><b>${oldDeclared.length} note${oldDeclared.length > 1 ? 's' : ''} déclarée${oldDeclared.length > 1 ? 's' : ''} depuis plus de 45 jours</b><p>Pas encore marquée${oldDeclared.length > 1 ? 's' : ''} comme remboursée${oldDeclared.length > 1 ? 's' : ''}. Vérifiez votre fiche de paie ou relancez la comptabilité.</p><a class="btn btn-small" href="#/tableau?f=declaree">Voir ces notes</a></div></div>`);

  const thumbs = await Promise.all(recent.map(e => e.has_photo ? DB.getPhoto(e.id).then(b => b ? trackUrl(URL.createObjectURL(b)) : null) : null));

  view.className = '';
  view.innerHTML = `
    <div class="topbar"><div><h1>Notes de frais</h1><div class="sub">${new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</div></div><div data-sync-slot>${syncPillHtml()}</div></div>
    <div class="home-grid">
      <div>
        <div class="ticket">
          <div class="label">Reste à vous rembourser</div>
          <div class="big num">${whole}<small>,${cents} €</small></div>
          <div class="meta">${pending.length} note${pending.length > 1 ? 's' : ''} en attente</div>
          <div class="split">
            <div>À déclarer<b class="num">${eur.format(s.a_declarer)}</b></div>
            <div>Déclarées<b class="num">${eur.format(s.declaree)}</b></div>
            <div>${new Date().toLocaleDateString('fr-FR', { month: 'long' })}<b class="num">${eur.format(sums(thisMonth).total)}</b></div>
          </div>
        </div>
        ${alerts.join('')}
      </div>
      <div>
        <div class="section-title"><h2>Dernières notes</h2>${all.length ? '<a href="#/tableau">Tout voir</a>' : ''}</div>
        ${recent.length ? `<div class="list">${recent.map((e, i) => rowHtml(e, thumbs[i])).join('')}</div>` :
          `<div class="list empty"><b>Aucune note pour l'instant</b>Prenez en photo votre premier ticket : hôtel, repas, train…<br><button class="btn btn-accent" data-action="add">Photographier un ticket</button></div>`}
      </div>
    </div>`;
}

async function viewForm(id, prefill = {}) {
  let e = id ? await DB.getExpense(id) : null;
  const isNew = !e;
  if (!e) {
    e = { id: uid(), date: prefill.date || todayKey(), category: '', amount: null, place: prefill.place || '', note: '', status: 'a_declarer', reimbursed_on: null, has_photo: false, photo_path: null, created_at: new Date().toISOString(), deleted: false };
  }
  let photoBlob = null, photoChanged = false;
  let currentSrc = await photoUrl(e);

  view.className = 'narrow';
  const draw = () => {
    view.innerHTML = `
      <div class="topbar"><button class="back" data-back><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Retour</button><div data-sync-slot>${syncPillHtml()}</div></div>
      <h1 style="margin-bottom:16px">${isNew ? 'Nouvelle note' : 'Modifier la note'}</h1>

      <div class="photo-zone" id="pz">
        ${currentSrc ? `<img src="${currentSrc}" alt="Photo du ticket" id="ph-img"><div class="ph-actions"><button class="btn btn-small" data-ph="camera">Reprendre</button><button class="btn btn-small" data-ph="remove">Retirer</button></div>`
        : `<div class="ph-empty"><svg viewBox="0 0 24 24"><path d="M9 4.5 7.6 6.5H5a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5a2 2 0 0 0-2-2h-2.6L15 4.5z"/><circle cx="12" cy="13" r="3.6"/></svg><div class="btn-row"><button class="btn btn-accent" data-ph="camera">Photographier le ticket</button><button class="btn" data-ph="gallery">Galerie / fichier</button></div></div>`}
      </div>

      <div class="card">
        <label class="amount-input"><input id="f-amount" inputmode="decimal" placeholder="0,00" value="${e.amount != null ? String(e.amount).replace('.', ',') : ''}" aria-label="Montant TTC"><span>€</span></label>
      </div>

      <div class="field"><span>Type de dépense</span><div class="chips" id="f-cat">${CATS.map(c => `<button type="button" class="chip" data-cat="${c.id}" aria-pressed="${e.category === c.id}">${c.ico} ${c.label}</button>`).join('')}</div></div>

      <div class="grid2">
        <label class="field"><span>Date</span><input type="date" id="f-date" value="${e.date}" max="${todayKey()}"></label>
        <label class="field"><span>Ville / lieu</span><input id="f-place" value="${esc(e.place)}" placeholder="Lyon, Ibis Part-Dieu…" autocomplete="off"></label>
      </div>
      <label class="field"><span>Chantier, client ou remarque</span><input id="f-note" value="${esc(e.note)}" placeholder="Ex. vérification lignes de vie — client X"></label>

      <div class="field"><span>Suivi du remboursement</span><div class="segmented" id="f-status">${STATUS_ORDER.map(s => `<button type="button" data-st="${s}" aria-pressed="${e.status === s}">${STATUS[s]}</button>`).join('')}</div>
      ${e.status === 'remboursee' ? `<label class="field" style="margin-top:10px"><span>Remboursée le</span><input type="date" id="f-reimb" value="${e.reimbursed_on || todayKey()}"></label>` : ''}</div>

      <div class="form-actions">
        ${isNew ? '' : '<button class="btn btn-danger" data-del>Supprimer</button>'}
        <button class="btn btn-primary" data-save>${isNew ? 'Enregistrer la note' : 'Enregistrer les modifications'}</button>
      </div>`;
  };

  const readForm = () => {
    const raw = $('#f-amount').value.replace(/\s/g, '').replace(',', '.');
    e.amount = raw === '' ? null : Math.round(parseFloat(raw) * 100) / 100;
    e.date = $('#f-date').value || todayKey();
    e.place = $('#f-place').value.trim();
    e.note = $('#f-note').value.trim();
    const r = $('#f-reimb'); if (r) e.reimbursed_on = r.value;
  };

  const bind = () => {
    const amt = $('#f-amount');
    const fit = () => { amt.style.width = Math.max(4, amt.value.length) + 0.2 + 'ch'; };
    amt.addEventListener('input', fit); fit();
    $('[data-back]').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/accueil');
    $$('[data-ph]').forEach(b => b.onclick = async () => {
      readForm();
      if (b.dataset.ph === 'remove') { photoBlob = null; currentSrc = null; e.has_photo = false; photoChanged = true; draw(); bind(); return; }
      applyPhoto(await pickPhoto(b.dataset.ph));
    });
    const img = $('#ph-img'); if (img) img.onclick = () => openViewer(currentSrc, 'Justificatif');
    $$('#f-cat .chip').forEach(c => c.onclick = () => { e.category = c.dataset.cat; $$('#f-cat .chip').forEach(x => x.setAttribute('aria-pressed', x === c)); });
    $$('#f-status button').forEach(b => b.onclick = () => {
      readForm(); e.status = b.dataset.st;
      if (e.status === 'remboursee' && !e.reimbursed_on) e.reimbursed_on = todayKey();
      if (e.status !== 'remboursee') e.reimbursed_on = null;
      draw(); bind();
    });
    $('[data-save]').onclick = async () => {
      readForm();
      if (e.amount == null || isNaN(e.amount) || e.amount <= 0) { toast('Indiquez le montant du ticket.'); $('#f-amount').focus(); return; }
      if (!e.category) { toast('Choisissez le type de dépense.'); return; }
      if (photoChanged) { if (photoBlob) await DB.putPhoto(e.id, photoBlob); else await DB.deletePhoto(e.id); e.photo_local = !!photoBlob; }
      await saveExpense(e, { photoChanged });
      toast(isNew ? (e.has_photo ? 'Note enregistrée' : 'Note enregistrée sans photo') : 'Modifications enregistrées');
      location.hash = '#/accueil';
    };
    const del = $('[data-del]');
    if (del) del.onclick = async () => {
      if (!confirm('Supprimer cette note de frais ?')) return;
      e.deleted = true;
      await saveExpense(e, { photoChanged: true });
      location.hash = '#/tableau';
      toast('Note supprimée', { label: 'Annuler', fn: async () => { e.deleted = false; await saveExpense(e, { photoChanged: true }); render(); } });
    };
  };
  async function applyPhoto(file) {
    if (!file) return;
    try { photoBlob = await compressImage(file); } catch (_) { toast('Cette image ne peut pas être lue. Essayez une photo JPEG ou PNG.'); return; }
    if ($('#f-amount')) readForm(); // garder ce qui a été tapé pendant le traitement de la photo
    currentSrc = trackUrl(URL.createObjectURL(photoBlob));
    e.has_photo = true; photoChanged = true;
    draw(); bind();
    if (e.amount == null) $('#f-amount').focus();
  }

  draw(); bind();
  // Photo prise depuis le bouton « + » (l'appareil photo s'ouvre dans le même geste)
  if (isNew && pendingPhoto) { const p = pendingPhoto; pendingPhoto = null; p.then(applyPhoto); }
}

async function viewTable(params) {
  const filter = params.get('f') || 'tout';
  const all = await DB.allExpenses();
  const list = filter === 'tout' ? all : all.filter(e => e.status === filter);
  const months = groupByMonth(list);
  const thumbs = {};
  if (window.matchMedia('(min-width: 900px)').matches) {
    await Promise.all(list.filter(e => e.has_photo).map(async e => { const u = await photoUrl(e); if (u) thumbs[e.id] = u; }));
  }

  view.className = '';
  view.innerHTML = `
    <div class="topbar"><div><h1>Tableau mensuel</h1><div class="sub">Suivez ce qui est déclaré puis remboursé.</div></div><div data-sync-slot>${syncPillHtml()}</div></div>
    <div class="toolbar">
      <div class="segmented" id="flt">${[['tout', 'Tout'], ...STATUS_ORDER.map(s => [s, STATUS[s]])].map(([k, l]) => `<button data-f="${k}" aria-pressed="${filter === k}">${l}</button>`).join('')}</div>
      <button class="btn btn-small" data-action="csv">Exporter pour Excel</button>
    </div>
    ${months.length ? months.map(m => {
      const s = sums(m.items);
      const pPaid = s.total ? (s.remboursee / s.total) * 100 : 0, pSent = s.total ? (s.declaree / s.total) * 100 : 0;
      return `<section class="month" data-month="${m.key}">
        <div class="month-head">
          <div><h2>${monthLabel(m.key)}</h2><div class="muted">${m.items.length} note${m.items.length > 1 ? 's' : ''}${s.nophoto ? ` · <span style="color:var(--danger)">${s.nophoto} sans photo</span>` : ''}</div></div>
          <div class="tot num">${eur.format(s.total)}</div>
          <div class="progress" aria-hidden="true"><i class="p1" style="width:${pPaid}%"></i><i class="p2" style="width:${pSent}%"></i></div>
          <div class="legend"><span>Remboursé <b class="num">${eur.format(s.remboursee)}</b></span><span>Déclaré <b class="num">${eur.format(s.declaree)}</b></span><span>À déclarer <b class="num">${eur.format(s.a_declarer)}</b></span></div>
          ${s.remboursee < s.total ? `<div class="month-actions">
            ${s.a_declarer > 0 ? `<button class="btn btn-small" data-bulk="declaree">Tout marquer déclaré</button>` : ''}
            <button class="btn btn-small" data-bulk="remboursee">Tout marquer remboursé</button>
          </div>` : ''}
        </div>
        <div class="mlist">${m.items.map(e => {
          const c = CAT[e.category] || CAT.autre;
          return `<div class="row" data-id="${e.id}">
            <span class="cat-ico">${c.ico}</span>
            <span style="min-width:0"><div class="t">${esc(e.place || c.label)}</div><div class="s">${dateLabel(e.date)} · ${esc(c.label)}${e.has_photo ? '' : ' · <span style="color:var(--danger)">sans photo</span>'}</div></span>
            <span class="r"><div class="amount">${eur.format(e.amount || 0)}${e.dirty ? '<i class="unsynced"></i>' : ''}</div><button class="pill ${e.status} status-btn" data-cycle="${e.id}">${STATUS[e.status]}</button></span>
          </div>`;
        }).join('')}</div>
        <table class="tbl">
          <thead><tr><th class="col-photo"></th><th>Date</th><th>Dépense</th><th class="col-place">Lieu / chantier</th><th class="r">Montant</th><th class="r">Statut</th></tr></thead>
          <tbody>${m.items.map(e => {
            const c = CAT[e.category] || CAT.autre;
            return `<tr data-id="${e.id}">
              <td class="col-photo">${thumbs[e.id] ? `<img class="thumb" src="${thumbs[e.id]}" alt="" data-view="${e.id}">` : e.has_photo ? '<span class="cat-ico" style="width:36px;height:36px;font-size:16px">📷</span>' : '<span class="noph">Pas de photo</span>'}</td>
              <td>${dateLabel(e.date)}</td>
              <td>${c.ico} ${esc(c.label)}${e.dirty ? '<i class="unsynced" title="Pas encore synchronisée"></i>' : ''}</td>
              <td class="col-place">${esc([e.place, e.note].filter(Boolean).join(' — '))}</td>
              <td class="r num"><b>${eur.format(e.amount || 0)}</b></td>
              <td class="r"><button class="pill ${e.status} status-btn" data-cycle="${e.id}" title="Changer le statut">${STATUS[e.status]}</button></td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </section>`;
    }).join('') : `<div class="list empty"><b>${filter === 'tout' ? 'Aucune note enregistrée' : 'Aucune note avec ce statut'}</b>${filter === 'tout' ? 'Vos notes apparaîtront ici, regroupées par mois.' : 'Choisissez « Tout » pour revoir l\'ensemble.'}</div>`}`;

  $$('#flt button').forEach(b => b.onclick = () => { location.hash = b.dataset.f === 'tout' ? '#/tableau' : `#/tableau?f=${b.dataset.f}`; });
  $$('tr[data-id], .mlist .row').forEach(tr => tr.onclick = ev => {
    if (ev.target.closest('[data-cycle]') || ev.target.closest('[data-view]')) return;
    location.hash = `#/note/${tr.dataset.id}`;
  });
  $$('[data-view]').forEach(img => img.onclick = () => openViewer(img.src));
  $$('[data-cycle]').forEach(b => b.onclick = async () => {
    const e = await DB.getExpense(b.dataset.cycle);
    const next = STATUS_ORDER[(STATUS_ORDER.indexOf(e.status) + 1) % 3];
    await setStatus([e.id], next);
    toast(`Statut : ${STATUS[next]}`);
    render();
  });
  $$('[data-bulk]').forEach(b => b.onclick = async () => {
    const mk = b.closest('[data-month]').dataset.month;
    const target = b.dataset.bulk;
    const ids = all.filter(e => monthKey(e.date) === mk && STATUS_ORDER.indexOf(e.status) < STATUS_ORDER.indexOf(target)).map(e => e.id);
    if (!confirm(`Marquer ${ids.length} note${ids.length > 1 ? 's' : ''} de ${monthLabel(mk)} comme « ${STATUS[target]} » ?`)) return;
    await setStatus(ids, target);
    toast(`${monthLabel(mk)} : ${STATUS[target].toLowerCase()}`);
    render();
  });
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

  view.className = 'narrow';
  view.innerHTML = `
    <div class="topbar"><div><h1>Réglages</h1></div><div data-sync-slot>${syncPillHtml()}</div></div>

    <div class="card">
      <h2>Synchronisation iPhone ↔ PC</h2>
      ${connected ? `
        <p>Connecté en tant que <b>${esc(cfg.email)}</b>. Les notes saisies hors ligne partent dès que le wifi ou la 4G revient.</p>
        <p class="muted" style="margin-top:8px">${pending ? `${pending} modification${pending > 1 ? 's' : ''} en attente d'envoi.` : 'Tout est envoyé.'}${lastSync ? ` Dernière synchro : ${new Date(lastSync).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}.` : ''}</p>
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
    <p class="muted" style="text-align:center;margin-top:18px">Version 1.0</p>`;

  const lg = $('#login');
  if (lg) lg.onclick = async () => {
    lg.disabled = true; lg.textContent = 'Connexion…';
    try {
      await Sync.login($('#s-url').value, $('#s-key').value, $('#s-email').value, $('#s-pass').value);
      // toutes les notes locales sont à envoyer
      for (const e of await DB.allExpenses({ includeDeleted: true })) { e.dirty = true; e.photo_dirty = !!e.has_photo; await DB.putExpense(e); }
      toast('Connecté. Synchronisation en cours…');
      await Sync.syncNow();
      render();
    } catch (err) {
      toast(err.message.includes('fetch') ? 'Serveur injoignable : vérifiez l\'adresse et la connexion.' : err.message);
      lg.disabled = false; lg.textContent = 'Se connecter';
    }
  };
  const lo = $('#logout');
  if (lo) lo.onclick = async () => { if (confirm('Se déconnecter ? Les notes restent sur cet appareil.')) { await Sync.logout(); render(); } };
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
  const lines = [['Mois', 'Date', 'Type', 'Lieu', 'Chantier / remarque', 'Montant TTC (€)', 'Statut', 'Remboursée le', 'Photo'].map(q).join(';')];
  all.forEach(e => {
    const [y, m, d] = e.date.split('-');
    lines.push([monthLabel(monthKey(e.date)), `${d}/${m}/${y}`, (CAT[e.category] || CAT.autre).label, e.place, e.note, num(e.amount), STATUS[e.status],
      e.reimbursed_on ? e.reimbursed_on.split('-').reverse().join('/') : '', e.has_photo ? 'oui' : 'non'].map((v, i) => i === 5 ? v : q(v)).join(';'));
  });
  downloadFile(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `notes-de-frais-${todayKey()}.csv`);
}

async function exportBackup() {
  const all = await DB.allExpenses({ includeDeleted: true });
  const toB64 = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
  const photos = {};
  for (const e of all) { const b = await DB.getPhoto(e.id); if (b) photos[e.id] = await toB64(b); }
  downloadFile(new Blob([JSON.stringify({ app: 'notes-de-frais', version: 1, exported_at: new Date().toISOString(), expenses: all, photos })], { type: 'application/json' }), `sauvegarde-notes-de-frais-${todayKey()}.json`);
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'notes-de-frais') throw new Error();
    let n = 0;
    for (const e of data.expenses) {
      const local = await DB.getExpense(e.id);
      if (local && local.updated_at >= e.updated_at) continue;
      if (data.photos[e.id]) { const r = await fetch(data.photos[e.id]); await DB.putPhoto(e.id, await r.blob()); }
      e.dirty = true; e.photo_dirty = !!data.photos[e.id];
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
});
window.addEventListener('hashchange', render);

// ---------------------------------------------------------------- démarrage
(async function start() {
  await DB.requestPersistence();
  await render();
  refreshBadges();
  Sync.startAutoSync();

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w && w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Nouvelle version disponible', { label: 'Mettre à jour', fn: () => { w.postMessage('skipWaiting'); } });
          }
        });
      });
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
    } catch (_) {}
  }
})();
