// Lecture automatique des tickets
// 1) IA (Claude) via la fonction Supabase « lire-ticket » quand il y a du réseau
// 2) Sinon, lecture sur l'appareil (Tesseract, hors ligne) + analyse du texte
import { DB } from './db.js';
import * as Sync from './sync.js';

export const CAT_IDS = ['hotel', 'restaurant', 'boulangerie', 'train', 'metro', 'taxi', 'carburant', 'peage', 'parking', 'avion', 'fournitures', 'autre', 'non_pris'];

// ------------------------------------------------------------------ réglage
export async function getMode() { return DB.getMeta('ocrMode', 'auto'); } // auto | local | off
export async function setMode(m) { return DB.setMeta('ocrMode', m); }

// ------------------------------------------------------------------ point d'entrée
// Renvoie { amount, date, merchant, city, category, source: 'ia'|'local' } ou lève une erreur lisible
export async function readReceipt(blob) {
  const mode = await getMode();
  if (mode === 'off') return null;
  if (mode === 'auto' && navigator.onLine && (await Sync.isConfigured())) {
    try {
      const r = await readWithAI(blob);
      if (r && (r.amount || r.category)) return { ...clean(r), source: 'ia' };
    } catch (err) {
      console.warn('Lecture IA indisponible, bascule sur le téléphone :', err.message);
      lastAIError = err.message;
    }
  }
  let text;
  try { text = await readLocal(blob); }
  catch (err) { lastLocalError = err.message; throw err; }
  return { ...parseReceipt(text), source: 'local' };
}
export let lastAIError = null;
export let lastLocalError = null;

function clean(r) {
  const out = {};
  const amt = typeof r.amount === 'string' ? parseFloat(r.amount.replace(',', '.')) : r.amount;
  if (amt && isFinite(amt) && amt > 0 && amt < 100000) out.amount = Math.round(amt * 100) / 100;
  if (r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && plausibleDate(r.date)) out.date = r.date;
  if (r.merchant) out.merchant = String(r.merchant).trim().slice(0, 60);
  if (r.city) out.city = String(r.city).trim().slice(0, 40);
  if (CAT_IDS.includes(r.category)) out.category = r.category;
  return out;
}

// ------------------------------------------------------------------ IA
async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function readWithAI(blob) {
  const cfg = await Sync.getConfig();
  const token = await Sync.accessToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(`${cfg.url}/functions/v1/lire-ticket`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: await blobToBase64(blob), media_type: blob.type || 'image/jpeg', today: new Date().toISOString().slice(0, 10) })
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 404) throw new Error('fonction « lire-ticket » non installée dans Supabase');
    if (!r.ok) throw new Error(j.error || j.message || `erreur ${r.status}`);
    return j;
  } finally { clearTimeout(timer); }
}

// ------------------------------------------------------------------ lecture sur l'appareil
let worker = null, workerPromise = null, idleTimer = null;
const here = p => new URL(p, location.href).href;

function loadScript(src) {
  return new Promise((res, rej) => {
    if (window.Tesseract) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('lecteur non disponible hors ligne'));
    document.head.appendChild(s);
  });
}

async function simdSupported() {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch (_) { return false; }
}

// Les fichiers du lecteur sont lus par la page (donc mis en cache par l'app),
// puis transmis au lecteur : il fonctionne ensuite sans réseau.
async function blobUrlOf(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error('lecteur non disponible hors ligne');
  return URL.createObjectURL(new Blob([await r.blob()], { type: 'application/javascript' }));
}

async function getWorker() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stopWorker, 60000);
  if (worker) return worker;
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    await loadScript('tesseract.min.js');
    const coreFile = (await simdSupported()) ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
    const create = (workerPath, corePath) => withTimeout(window.Tesseract.createWorker('fra', 1, {
      workerPath, corePath, langPath: here('./'), workerBlobURL: false, gzip: true
    }), 45000);
    let w;
    try {
      // 1er essai : fichiers lus par la page (mis en cache par l'app, marche hors ligne partout)
      w = await create(await blobUrlOf('worker.min.js'), (await blobUrlOf(coreFile)) + '#core.js');
    } catch (err) {
      // 2e essai (certains Safari) : chemins directs, mis en cache par le service worker
      console.warn('Lecteur : bascule sur les chemins directs', err);
      w = await create(here('worker.min.js'), here(coreFile));
    }
    await w.setParameters({ preserve_interword_spaces: '1' });
    worker = w;
    await DB.setMeta('ocrReady', true);
    return w;
  })();
  try { return await workerPromise; } catch (e) { workerPromise = null; throw e; }
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('le lecteur ne répond pas')), ms))]);
}

function stopWorker() {
  if (worker) { worker.terminate(); worker = null; workerPromise = null; }
}

// Télécharge le lecteur en avance (une fois, avec du réseau) pour qu'il marche ensuite hors ligne
export async function warmUp() {
  try {
    if ((await getMode()) === 'off' || !navigator.onLine || (await DB.getMeta('ocrReady', false))) return;
    await getWorker();
  } catch (_) {}
}

// Améliore la photo pour la lecture : niveaux de gris, contraste, taille adaptée
async function prepare(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = g; if (g < min) min = g; if (g > max) max = g;
  }
  const range = Math.max(40, max - min);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - min) / range) * 255));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export async function readLocal(blob) {
  const w = await getWorker();
  const canvas = await prepare(blob);
  const { data } = await w.recognize(canvas);
  return data.text || '';
}

// ------------------------------------------------------------------ analyse du texte
const strip = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const CAT_WORDS = {
  hotel: ['hotel', 'ibis', 'novotel', 'mercure', 'campanile', 'kyriad', 'b&b', 'premiere classe', 'formule 1', 'best western', 'logis', 'nuitee', 'nuit', 'chambre', 'taxe de sejour', 'accor', 'appart city', 'adagio', 'holiday inn', 'hebergement'],
  restaurant: ['restaurant', 'brasserie', 'bistrot', 'bistro', 'pizzeria', 'pizza', 'menu', 'plat du jour', 'couvert', 'mcdonald', 'burger', 'kfc', 'quick', 'flunch', 'buffalo', 'courtepaille', 'del arte', 'sushi', 'kebab', 'creperie', 'traiteur', 'dessert', 'entree', 'table', 'serveur', 'formule midi'],
  boulangerie: ['boulangerie', 'patisserie', 'marie blachere', 'baguette', 'croissant', 'viennoiserie', 'sandwich', 'feuillete', 'pain au chocolat', 'chocolatine', 'boulanger', 'fournil', 'quiche'],
  train: ['sncf', 'tgv', 'ouigo', 'inoui', 'intercites', 'trenitalia', 'eurostar', 'lyria', 'voiture', 'place assise', 'gare de', 'billet de train', 'e-billet', 'connect'],
  metro: ['ratp', 'tcl', 'metro', 'navigo', 'ticket t+', 'tramway', 'keolis', 'transdev', 'rtm', 'tisseo', 'ilevia', 'tag grenoble', 'stas', 'titre de transport', 'ticket unite', 'carnet'],
  taxi: ['taxi', 'uber', 'bolt', 'heetch', 'g7', 'vtc', 'freenow', 'free now', 'course'],
  carburant: ['totalenergies', 'total access', 'esso', 'shell', 'avia', 'carburant', 'gazole', 'gasoil', 'diesel', 'sp95', 'sp98', 'sp 95', 'sp 98', 'e10', 'e85', 'adblue', 'litres', 'pompe', 'station service', 'prix/l', 'eur/l'],
  peage: ['peage', 'aprr', 'area', 'vinci autoroutes', 'sanef', 'asf', 'escota', 'autoroute', 'classe 1', 'gare de peage', 'sapn', 'atmb'],
  parking: ['parking', 'indigo', 'effia', 'saemes', 'onepark', 'stationnement', 'horodateur', 'q-park', 'zenpark', 'parc auto', 'duree de stationnement'],
  avion: ['air france', 'easyjet', 'ryanair', 'transavia', 'volotea', 'aeroport', 'boarding', 'carte d\'embarquement', 'vol '],
  fournitures: ['leroy merlin', 'castorama', 'brico', 'point p', 'wurth', 'manutan', 'bureau vallee', 'quincaillerie', 'visserie', 'cheville', 'foret', 'outillage', 'rubson', 'cedeo', 'rexel', 'big mat', 'gedimat', 'weldom', 'mr bricolage', 'tollens']
};

export function guessCategory(text) {
  const t = ' ' + strip(text).replace(/[^a-z0-9&+/'\- ]+/g, ' ') + ' ';
  let best = null, score = 0;
  for (const [cat, words] of Object.entries(CAT_WORDS)) {
    let s = 0;
    for (const w of words) {
      const re = new RegExp('(^|[^a-z])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z])', 'g');
      const n = (t.match(re) || []).length;
      if (n) s += n * (w.length >= 6 ? 2 : 1);
    }
    if (s > score) { score = s; best = cat; }
  }
  return best;
}

function plausibleDate(iso) {
  const d = new Date(iso + 'T12:00');
  const now = new Date();
  return d <= new Date(now.getTime() + 86400000) && d >= new Date(now.getTime() - 400 * 86400000);
}

const MONTHS = { janv: 1, jan: 1, fevr: 2, fev: 2, mars: 3, mar: 3, avr: 4, mai: 5, juin: 6, juil: 7, aout: 8, sept: 9, sep: 9, oct: 10, nov: 11, dec: 12 };

export function findDate(text) {
  const t = strip(text);
  const pad = n => String(n).padStart(2, '0');
  const cands = [];
  for (const m of t.matchAll(/(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4}|\d{2})(?!\d)/g)) {
    let [_, d, mo, y] = m; y = y.length === 2 ? '20' + y : y;
    cands.push(`${y}-${pad(mo)}-${pad(d)}`);
  }
  for (const m of t.matchAll(/(\d{1,2})\s+(janv|jan|fevr|fev|mars|mar|avr|mai|juin|juil|aout|sept|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})/g)) {
    cands.push(`${m[3]}-${pad(MONTHS[m[2]])}-${pad(m[1])}`);
  }
  for (const m of t.matchAll(/(20\d{2})[\-\/.](\d{1,2})[\-\/.](\d{1,2})/g)) cands.push(`${m[1]}-${pad(m[2])}-${pad(m[3])}`);
  return cands.find(c => { const [y, mo, d] = c.split('-').map(Number); return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && plausibleDate(c); }) || null;
}

const AMOUNT_RE = /(\d{1,3}(?:[ . ]\d{3})*|\d+)\s?[,.]\s?(\d{2})(?!\d)/g;
function amountsIn(line) {
  const out = [];
  for (const m of line.matchAll(AMOUNT_RE)) {
    const v = parseFloat(m[1].replace(/[ . ]/g, '') + '.' + m[2]);
    if (v > 0 && v < 20000) out.push(v);
  }
  return out;
}

export function findAmount(text) {
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const KEY = /(total|ttc|net\s*a\s*payer|a\s*payer|montant|carte\s*bancaire|\bcb\b|paiement|regle|somme|\bdu\b|visa|mastercard|sans contact)/;
  const BAD = /(tva|\bht\b|hors\s*taxe|rendu|monnaie|sous[\s-]*total|remise|economi|fidelite|points|tel|siret|prix\/l|eur\/l|\/l\b|litre)/;
  const keyVals = [];
  lines.forEach((l, i) => {
    const s = strip(l);
    if (!KEY.test(s) || BAD.test(s)) return;
    let vals = amountsIn(l);
    if (!vals.length && lines[i + 1] && !BAD.test(strip(lines[i + 1]))) vals = amountsIn(lines[i + 1]); // montant sur la ligne suivante
    keyVals.push(...vals);
  });
  if (keyVals.length) {
    const count = {};
    keyVals.forEach(v => { count[v] = (count[v] || 0) + 1; });
    return keyVals.sort((a, b) => (count[b] - count[a]) || (b - a))[0];
  }
  const all = lines.filter(l => !BAD.test(strip(l))).flatMap(amountsIn);
  return all.length ? Math.max(...all) : null;
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s\-'])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase());
}

export function findMerchantCity(text) {
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean).slice(0, 16);
  let merchant = null, city = null;
  const noise = l => {
    const s = strip(l);
    const letters = (l.match(/[A-Za-zÀ-ÿ]/g) || []).length;
    if (letters < 3 || letters < l.length * 0.5) return true;
    if (/(ticket|bienvenue|merci|siret|tel\b|facture|recu|caisse|date|www|@|transaction|paye|releve|operation|historique|solde|compte|carte|client|sans contact|contactless|mastercard|visa|debit|credit|montant|conserver|cb\\b)/.test(s)) return true;
    if (/[.!?]$/.test(l) || l.split(/\s+/).length > 8 || /^[<>←]/.test(l)) return true;
    return false;
  };
  const keywords = Object.values(CAT_WORDS).flat().filter(w => w.length >= 4);
  const clean1 = l => titleCase(l.replace(/[^A-Za-zÀ-ÿ0-9&'\- ]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 48);
  const withBrand = lines.find(l => !noise(l) && keywords.some(w => strip(l).includes(w)));
  const first = lines.slice(0, 6).find(l => !noise(l));
  if (withBrand || first) merchant = clean1(withBrand || first);
  for (const l of lines) {
    const m = l.match(/\b(\d{5})\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{2,30})/);
    if (m) { city = titleCase(m[2].trim().split(/\s{2,}/)[0]).replace(/\s+Cedex.*$/i, ''); break; }
  }
  return { merchant, city };
}

// Simple preuve de paiement (reçu de carte « ticket client », capture d'appli bancaire ou de réservation) :
// ce n'est pas une facture, donc « Non pris en compte » tant que la vraie facture n'est pas fournie
const PROOF_WORDS = ['ticket client', 'a conserver', 'carte bancaire', 'montant reel', 'debit', 'transaction', 'transactions', 'payee', 'paiement accepte', 'paiement effectue', 'no auto', 'n° auto', 'contactless', 'sans contact', 'mastercard', 'visa', 'cb ', 'releve', 'operation', 'booking.com', 'paypal', 'lydia', '••••', '****', 'xxxx'];
export function isPaymentProof(text) {
  const t = strip(text);
  const hits = PROOF_WORDS.filter(w => t.includes(w)).length;
  const itemLines = text.split(/\n+/).filter(l => amountsIn(l).length && !/total|montant|tva|ttc/i.test(l)).length;
  const looksLikeInvoice = /(facture|tva|ht\b|n° de facture|qte|quantite|prix unitaire)/.test(t);
  return hits >= 3 && !looksLikeInvoice && itemLines <= 2;
}

export function parseReceipt(text) {
  const { merchant, city } = findMerchantCity(text);
  const out = clean({ amount: findAmount(text), date: findDate(text), merchant, city, category: isPaymentProof(text) ? 'non_pris' : guessCategory(text) });
  out.rawText = text;
  return out;
}
