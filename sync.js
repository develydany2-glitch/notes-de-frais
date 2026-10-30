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
  return cfg;
}

export async function logout() {
  await DB.setMeta('sync', null);
  await DB.setMeta('lastPull', null);
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

function toRow(e, userId) {
  const row = { user_id: userId };
  ROW_FIELDS.forEach(k => { row[k] = e[k] === undefined ? null : e[k]; });
  row.deleted = !!e.deleted;
  row.has_photo = !!e.has_photo;
  return row;
}

async function push(cfg) {
  const all = await DB.allExpenses({ includeDeleted: true });
  const dirty = all.filter(e => e.dirty);
  let n = 0;
  for (const e of dirty) {
    const uid = cfg.session.user_id;
    if (e.photo_dirty) {
      const path = `${uid}/${e.id}.jpg`;
      if (e.has_photo && !e.deleted) {
        const blob = await DB.getPhoto(e.id);
        if (blob) {
          await api(cfg, `/storage/v1/object/${BUCKET}/${path}`, {
            method: 'POST', body: blob, headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }
          });
          e.photo_path = path;
        }
      } else if (e.photo_path) {
        await api(cfg, `/storage/v1/object/${BUCKET}/${e.photo_path}`, { method: 'DELETE' }).catch(() => {});
        e.photo_path = null;
      }
    }
    await api(cfg, `/rest/v1/expenses?on_conflict=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(toRow(e, uid))
    });
    // ne pas écraser une modification faite pendant l'envoi
    const fresh = await DB.getExpense(e.id);
    if (fresh && fresh.updated_at === e.updated_at) {
      fresh.dirty = false; fresh.photo_dirty = false; fresh.photo_path = e.photo_path;
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
    e.amount = Number(e.amount);
    e.dirty = false; e.photo_dirty = false;
    e.photo_local = local ? !!local.photo_local && local.photo_path === row.photo_path : false;
    await DB.putExpense(e);
    n++;
  }
  if (maxTs) await DB.setMeta('lastPull', maxTs);
  return n;
}

// Télécharge la photo d'une note depuis le cloud si elle n'est pas sur l'appareil
export async function fetchPhoto(e) {
  const cfg = await getConfig();
  if (!cfg || !e.photo_path || !navigator.onLine) return null;
  const r = await api(cfg, `/storage/v1/object/authenticated/${BUCKET}/${e.photo_path}`);
  const blob = await r.blob();
  await DB.putPhoto(e.id, blob);
  const fresh = await DB.getExpense(e.id);
  if (fresh) { fresh.photo_local = true; await DB.putExpense(fresh); }
  return blob;
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
    const got = await pull(cfg);
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
