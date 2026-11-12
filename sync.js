// Synchronisation avec Supabase (base cloud gratuite).
// Principe « hors ligne d'abord » : chaque note est enregistrée localement avec dirty=true,
// puis envoyée dès qu'une connexion (wifi ou 4G) est disponible.
import { DB } from './db.js';

const BUCKET = 'receipts';
let running = false;

function emit(state, detail = '') {
  window.dispatchEvent(new CustomEvent('sync-status', { detail: { state, detail } }));
}

export async function getConfig() { return DB.getMeta('sync', null); }
export async function isConfigured() {
  const c = await getConfig();
  return !!(c && c.url && c.anonKey && c.session && c.session.refresh_token);
}

function cleanUrl(u) { return (u || '').trim().replace(/\/+$/, ''); }

export async function login(url, anonKey, email, password) {
  url = cleanUrl(url); anonKey = anonKey.trim();
  const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.trim(), password })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.msg || j.message || `Connexion refusée (${r.status})`);
  const cfg = { url, anonKey, email: email.trim(), session: sessionFrom(j) };
  await DB.setMeta('sync', cfg);
  await DB.setMeta('lastPull', null);
  await DB.setMeta('lastPullTrips', null);
  return cfg;
}

export async function logout() {
  await DB.setMeta('sync', null);
  await DB.setMeta('lastPull', null);
  await DB.setMeta('lastPullTrips', null);
  emit('off');
}

function sessionFrom(j) {
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (j.expires_in || 3600) * 1000,
    user_id: j.user && j.user.id
  };
}

async function token(cfg) {
  if (cfg.session.expires_at - Date.now() > 60000) return cfg.session.access_token;
  const r = await fetch(`${cfg.url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: cfg.session.refresh_token })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 400 || r.status === 401) { const e = new Error('Session expirée : reconnectez-vous dans Réglages.'); e.auth = true; throw e; }
    throw new Error(`Rafraîchissement impossible (${r.status})`);
  }
  cfg.session = sessionFrom(j);
  await DB.setMeta('sync', cfg);
  return cfg.session.access_token;
}

export async function accessToken() { return token(await getConfig()); }

async function api(cfg, path, opts = {}) {
  const t = await token(cfg);
  const headers = Object.assign({ apikey: cfg.anonKey, Authorization: `Bearer ${t}` }, opts.headers || {});
  const r = await fetch(`${cfg.url}${path}`, Object.assign({}, opts, { headers }));
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Erreur serveur ${r.status} ${txt.slice(0, 160)}`);
  }
  return r;
}

const ROW_FIELDS = ['id', 'date', 'category', 'amount', 'place', 'note', 'status', 'reimbursed_on',
  'has_photo', 'photo_path', 'created_at', 'updated_at', 'deleted'];
// Colonnes ajoutées après la première installation : si la base n'est pas encore mise à jour, on les retire de l'envoi
const OPTIONAL = { photos: 'needsPhotosColumn', month: 'needsMonthColumn' };

// Liste des photos d'une note (compatible avec l'ancienne version à photo unique)
export function photosOf(e) {
  if (Array.isArray(e.photos)) return e.photos;
  return e.has_photo ? [{ id: e.id, path: e.photo_path || null }] : [];
}

function toRow(e, userId, withPhotos) {
  const row = { user_id: userId };
  ROW_FIELDS.forEach(k => { row[k] = e[k] === undefined ? null : e[k]; });
  const photos = photosOf(e);
  row.deleted = !!e.deleted;
  row.has_photo = photos.length > 0;
  row.photo_path = (photos[0] && photos[0].path) || null;
  if (withPhotos) row.photos = photos.map(p => ({ id: p.id, path: p.path || null }));
  row.month = e.month || null;
  return row;
}

async function upsertRow(cfg, row) {
  const send = r => api(cfg, `/rest/v1/expenses?on_conflict=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(r)
  });
  let r = { ...row };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await send(r);
      for (const [col, flag] of Object.entries(OPTIONAL)) if (col in r) await DB.setMeta(flag, false);
      return;
    } catch (err) {
      const col = Object.keys(OPTIONAL).find(c => c in r && new RegExp(`'${c}'|"${c}"|\\b${c}\\b`).test(err.message));
      if (!col) throw err;
      await DB.setMeta(OPTIONAL[col], true);
      delete r[col];
    }
  }
  await send(r);
}

async function push(cfg) {
  const all = await DB.allExpenses({ includeDeleted: true });
  const dirty = all.filter(e => e.dirty);
  let n = 0;
  for (const e of dirty) {
    const uid = cfg.session.user_id;
    const photos = photosOf(e).map(p => ({ ...p }));
    const deletedPaths = [];
    if (e.photo_dirty) {
      if (!e.deleted) {
        for (const p of photos) {
          if (p.path) continue;
          const blob = await DB.getPhoto(p.id);
          if (!blob) continue;
          const path = `${uid}/${p.id}.jpg`;
          await api(cfg, `/storage/v1/object/${BUCKET}/${path}`, {
            method: 'POST', body: blob, headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }
          });
          p.path = path;
        }
      }
      const toDelete = [...(e.removed_paths || []), ...(e.deleted ? photos.filter(p => p.path).map(p => p.path) : [])];
      for (const path of toDelete) {
        await api(cfg, `/storage/v1/object/${BUCKET}/${path}`, { method: 'DELETE' }).catch(() => {});
        deletedPaths.push(path);
      }
      if (e.deleted) photos.forEach(p => { p.path = null; }); // une note restaurée renverra ses photos
    }
    const sent = { ...e, photos };
    await upsertRow(cfg, toRow(sent, uid, true));
    // ne pas écraser une modification faite pendant l'envoi
    const fresh = await DB.getExpense(e.id);
    if (fresh) {
      const byId = Object.fromEntries(photos.map(p => [p.id, p.path]));
      fresh.photos = photosOf(fresh).map(p => ({ id: p.id, path: p.id in byId ? byId[p.id] : (p.path || null) }));
      fresh.photo_path = (fresh.photos[0] && fresh.photos[0].path) || null;
      fresh.removed_paths = (fresh.removed_paths || []).filter(x => !deletedPaths.includes(x));
      if (fresh.updated_at === e.updated_at) { fresh.dirty = false; fresh.photo_dirty = false; }
      await DB.putExpense(fresh);
    }
    n++;
    emit('syncing', `Envoi ${n}/${dirty.length}`);
  }
  return n;
}

async function pull(cfg) {
  const last = await DB.getMeta('lastPull', null);
  let q = `/rest/v1/expenses?select=*&order=updated_at.asc`;
  if (last) q += `&updated_at=gt.${encodeURIComponent(last)}`;
  const r = await api(cfg, q, { headers: { Accept: 'application/json' } });
  const rows = await r.json();
  let maxTs = last, n = 0;
  for (const row of rows) {
    if (!maxTs || row.updated_at > maxTs) maxTs = row.updated_at;
    const local = await DB.getExpense(row.id);
    if (local && local.updated_at >= row.updated_at) continue;
    const e = {};
    ROW_FIELDS.forEach(k => { e[k] = row[k]; });
    e.amount = e.amount == null ? null : Number(e.amount);
    e.photos = Array.isArray(row.photos) ? row.photos
      : row.has_photo ? [{ id: row.id, path: row.photo_path || null }] : [];
    e.month = row.month || null;
    e.dirty = false; e.photo_dirty = false;
    await DB.putExpense(e);
    n++;
  }
  if (maxTs) await DB.setMeta('lastPull', maxTs);
  return n;
}

// Télécharge une photo depuis le cloud si elle n'est pas sur l'appareil ({ id, path })
export async function fetchPhoto(p) {
  const cfg = await getConfig();
  if (!cfg || !p.path || !navigator.onLine || !(await isConfigured())) return null;
  const r = await api(cfg, `/storage/v1/object/authenticated/${BUCKET}/${p.path}`);
  const blob = await r.blob();
  await DB.putPhoto(p.id, blob);
  return blob;
}

// ---------- Déplacements (table « trips ») ----------
function tripsTableMissing(err) { return /PGRST205|PGRST204|42P01|trips/.test(err.message); }

async function pushTrips(cfg) {
  const dirty = (await DB.allTrips({ includeDeleted: true })).filter(t => t.dirty);
  let n = 0;
  for (const t of dirty) {
    const { dirty: _d, ...data } = t;
    await api(cfg, `/rest/v1/trips?on_conflict=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ id: t.id, user_id: cfg.session.user_id, data, updated_at: t.updated_at, deleted: !!t.deleted })
    });
    const fresh = await DB.getTrip(t.id);
    if (fresh && fresh.updated_at === t.updated_at) { fresh.dirty = false; await DB.putTrip(fresh); }
    n++;
  }
  return n;
}

async function pullTrips(cfg) {
  const last = await DB.getMeta('lastPullTrips', null);
  let q = `/rest/v1/trips?select=*&order=updated_at.asc`;
  if (last) q += `&updated_at=gt.${encodeURIComponent(last)}`;
  const rows = await (await api(cfg, q, { headers: { Accept: 'application/json' } })).json();
  let maxTs = last, n = 0;
  for (const row of rows) {
    if (!maxTs || row.updated_at > maxTs) maxTs = row.updated_at;
    const local = await DB.getTrip(row.id);
    if (local && local.updated_at >= row.updated_at) continue;
    await DB.putTrip({ ...(row.data || {}), id: row.id, updated_at: row.updated_at, deleted: !!row.deleted, dirty: false });
    n++;
  }
  if (maxTs) await DB.setMeta('lastPullTrips', maxTs);
  return n;
}

async function syncTrips(cfg) {
  try {
    await pushTrips(cfg);
    const got = await pullTrips(cfg);
    await DB.setMeta('needsTripsTable', false);
    return got;
  } catch (err) {
    if (tripsTableMissing(err)) { await DB.setMeta('needsTripsTable', true); return 0; } // base pas encore mise à jour
    throw err;
  }
}

export async function syncNow() {
  if (running) return;
  if (!(await isConfigured())) { emit('off'); return; }
  if (!navigator.onLine) { emit('offline'); return; }
  running = true;
  emit('syncing', 'Synchronisation…');
  try {
    const cfg = await getConfig();
    const sent = await push(cfg);
    const got = (await pull(cfg)) + (await syncTrips(cfg));
    await DB.setMeta('lastSync', new Date().toISOString());
    emit('ok', { sent, got });
    if (got > 0) window.dispatchEvent(new Event('data-changed'));
  } catch (err) {
    emit(err.auth ? 'auth' : 'error', err.message);
  } finally {
    running = false;
  }
}

export function startAutoSync() {
  window.addEventListener('online', () => syncNow());
  window.addEventListener('offline', () => emit('offline'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  setInterval(() => { if (navigator.onLine) syncNow(); }, 90 * 1000);
  syncNow();
}
