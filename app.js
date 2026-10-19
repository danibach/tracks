import { CONFIG } from './config.js';
import { parseTraceFile, detectFormat } from './parsers.js';

// ---------- utilitaires ----------

const $ = (sel) => document.querySelector(sel);
const nf1 = new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 0 });
const SVG_NS = 'http://www.w3.org/2000/svg';
const TRACK_COLOR = '#d7261e';

// Tout contenu venant des utilisateurs passe par textContent : jamais de HTML injecté.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('data-') || k.startsWith('aria-')) node.setAttribute(k, v);
    else node[k] = v;
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function plural(n, one, many) {
  return n > 1 ? many : one;
}

function formatDistance(m) {
  if (!Number.isFinite(m)) return null;
  return m < 1000 ? { value: nf0.format(m), unit: 'm' } : { value: nf1.format(m / 1000), unit: 'km' };
}

function formatDuration(s) {
  if (!Number.isFinite(s) || s < 0) return null;
  let h = Math.floor(s / 3600);
  let m = Math.round((s % 3600) / 60);
  if (m === 60) { h += 1; m = 0; }
  return h > 0
    ? { value: `${h} h ${String(m).padStart(2, '0')}`, unit: '' }
    : { value: String(m), unit: 'min' };
}

function formatAltitude(m) {
  return Number.isFinite(m) ? { value: nf0.format(m), unit: 'm' } : null;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('fr-CH', { day: 'numeric', month: 'long', year: 'numeric' });
}

function stat(f, suffix = '') {
  if (!f) return null;
  const unit = [f.unit, suffix].filter(Boolean).join(' ');
  return el('span', {}, el('b', { text: f.value }), unit ? ` ${unit}` : '');
}

function baseName(fileName) {
  return fileName.replace(/\.[^.]+$/, '');
}

// ---------- profil d'altitude ----------

function fillProfile(svg, coords) {
  svg.replaceChildren();
  const pts = (coords || []).filter((c) => Array.isArray(c) && Number.isFinite(c[2]));
  if (pts.length < 2) return false;
  const alts = pts.map((c) => c[2]);
  const min = Math.min(...alts);
  const span = Math.max(Math.max(...alts) - min, 1);
  const W = 300;
  const H = 40;
  const xy = pts.map((c, i) => [(i / (pts.length - 1)) * W, H - 2 - ((c[2] - min) / span) * (H - 4)]);
  const d = 'M' + xy.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const area = document.createElementNS(SVG_NS, 'path');
  area.setAttribute('class', 'area');
  area.setAttribute('d', `${d}L${W} ${H}L0 ${H}Z`);
  const line = document.createElementNS(SVG_NS, 'path');
  line.setAttribute('class', 'line');
  line.setAttribute('d', d);
  svg.append(area, line);
  return true;
}

function createProfile(coords) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'profile');
  svg.setAttribute('aria-hidden', 'true');
  return fillProfile(svg, coords) ? svg : null;
}

// ---------- carte ----------

const map = L.map('map', { zoomSnap: 0.5, attributionControl: false }).setView([46.3, 7.3], 7);
L.control.attribution({ prefix: false }).addTo(map);
L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
  maxZoom: 17,
  subdomains: 'abc',
  attribution:
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM | © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
}).addTo(map);
const group = L.layerGroup().addTo(map);
map.on('click', () => select(null));

// ---------- état ----------

let traces = [];
let view = [];
let selectedId = null;
const layers = new Map();
let introPlayed = false;

function validCoords(t) {
  const c = t.track_geojson && t.track_geojson.coordinates;
  return Array.isArray(c) && c.length >= 2 && c.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

async function loadTraces() {
  const cols =
    'id,created_at,title,pilot_name,file_format,activity_date,duration_s,distance_m,max_alt_m,min_alt_m,start_lat,start_lon,track_geojson';
  const url = `${CONFIG.SUPABASE_URL}/rest/v1/traces?select=${cols}&order=created_at.desc&limit=500`;
  const res = await fetch(url, {
    headers: { apikey: CONFIG.SUPABASE_PUBLISHABLE_KEY, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  return rows.filter(validCoords);
}

// ---------- filtres et affichage ----------

const searchInput = $('#search');
const sortSelect = $('#sort');
const chips = Array.from(document.querySelectorAll('.chip'));
const listEl = $('#list');
const countEl = $('#count');

function sortValue(t) {
  if (sortSelect.value === 'distance') return t.distance_m ?? -1;
  if (sortSelect.value === 'altitude') return t.max_alt_m ?? -1;
  return new Date(t.activity_date || t.created_at).getTime();
}

function applyView({ fit = false } = {}) {
  const q = searchInput.value.trim().toLowerCase();
  const formats = chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.format);
  view = traces
    .filter((t) => {
      const text = `${t.title || ''} ${t.pilot_name || ''}`.toLowerCase();
      return (!q || text.includes(q)) && (!formats.length || formats.includes(t.file_format));
    })
    .sort((a, b) => sortValue(b) - sortValue(a));
  if (selectedId && !view.some((t) => t.id === selectedId)) selectedId = null;
  renderMap(fit);
  renderList();
  renderCount();
}

function renderCount() {
  if (!traces.length) {
    countEl.textContent = "Aucune trace pour l'instant.";
  } else if (view.length === traces.length) {
    countEl.textContent = `${view.length} ${plural(view.length, 'trace', 'traces')} sur la carte`;
  } else {
    countEl.textContent = `${view.length} sur ${traces.length} ${plural(traces.length, 'trace', 'traces')}`;
  }
}

function renderList() {
  listEl.replaceChildren();
  if (!view.length) {
    listEl.append(
      el('li', {
        class: 'empty',
        text: traces.length
          ? 'Aucune trace ne correspond. Modifiez la recherche ou les formats.'
          : 'Aucune trace pour l\'instant. Ajoutez la première.',
      })
    );
    return;
  }
  for (const t of view) {
    const date = formatDate(t.activity_date || t.created_at);
    const meta = el('span', { class: 'item-meta' });
    if (t.pilot_name) meta.append(el('span', { text: t.pilot_name }));
    if (date) meta.append(el('span', { text: t.activity_date ? date : `Ajoutée le ${date}` }));

    const stats = el(
      'span',
      { class: 'stats' },
      stat(formatDistance(t.distance_m)),
      stat(formatDuration(t.duration_s)),
      stat(formatAltitude(t.max_alt_m), 'max')
    );

    const btn = el(
      'button',
      { type: 'button', class: 'item', 'data-id': t.id },
      el('span', { class: 'item-title', text: t.title || 'Trace sans titre' }),
      meta,
      stats,
      createProfile(t.track_geojson.coordinates)
    );
    if (t.id === selectedId) btn.setAttribute('aria-current', 'true');
    btn.addEventListener('click', () => select(t.id === selectedId ? null : t.id));
    listEl.append(el('li', {}, btn));
  }
}

function baseStyle() {
  return { color: TRACK_COLOR, weight: 3, opacity: selectedId ? 0.35 : 0.85 };
}

function renderMap(fit) {
  group.clearLayers();
  layers.clear();
  for (const t of view) {
    const latlngs = t.track_geojson.coordinates.map((c) => [c[1], c[0]]);
    const layer = L.polyline(latlngs, { ...baseStyle(), lineJoin: 'round', bubblingMouseEvents: false });
    layer.on('click', () => select(t.id, { scroll: true }));
    layer.addTo(group);
    layers.set(t.id, layer);
  }
  styleLayers();
  if (fit && view.length) {
    const bounds = group.getLayers().reduce((b, l) => b.extend(l.getBounds()), L.latLngBounds([]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13, animate: introPlayed });
  }
}

function styleLayers() {
  layers.forEach((layer, id) => {
    if (id === selectedId) {
      layer.setStyle({ color: TRACK_COLOR, weight: 5, opacity: 1 });
      layer.bringToFront();
    } else {
      layer.setStyle(baseStyle());
    }
  });
}

function select(id, { scroll = false } = {}) {
  selectedId = id;
  styleLayers();
  for (const btn of listEl.querySelectorAll('.item')) {
    const on = btn.dataset.id === id;
    if (on) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
    if (on && scroll) btn.scrollIntoView({ block: 'nearest' });
  }
  const layer = id && layers.get(id);
  if (layer) map.fitBounds(layer.getBounds(), { padding: [50, 50], maxZoom: 14 });
}

// Seul moment animé de la page : les traces se dessinent à l'ouverture.
function playIntro() {
  introPlayed = true;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let i = 0;
  layers.forEach((layer) => {
    const path = layer.getElement && layer.getElement();
    if (!path || !path.getTotalLength) return;
    path.style.setProperty('--len', path.getTotalLength());
    path.style.setProperty('--delay', `${Math.min(i, 40) * 0.04}s`);
    path.classList.add('trace-in');
    path.addEventListener(
      'animationend',
      () => {
        path.classList.remove('trace-in');
        path.style.removeProperty('--len');
        path.style.removeProperty('--delay');
      },
      { once: true }
    );
    i += 1;
  });
}

// ---------- chargement initial ----------

async function init() {
  document.title = CONFIG.SITE_NAME;
  $('#site-name').textContent = CONFIG.SITE_NAME;
  try {
    traces = await loadTraces();
    applyView({ fit: true });
    requestAnimationFrame(playIntro);
  } catch (err) {
    console.error(err);
    countEl.textContent = '';
    listEl.replaceChildren(
      el(
        'li',
        { class: 'empty' },
        el('p', { text: 'Impossible de charger les traces. Vérifiez votre connexion, puis réessayez.' }),
        el('button', { type: 'button', class: 'btn', text: 'Réessayer', onclick: () => init() })
      )
    );
  }
}

let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => applyView({ fit: true }), 250);
});
sortSelect.addEventListener('change', () => applyView());
for (const chip of chips) {
  chip.addEventListener('click', () => {
    chip.setAttribute('aria-pressed', String(chip.getAttribute('aria-pressed') !== 'true'));
    applyView({ fit: true });
  });
}

// ---------- fenêtres ----------

for (const btn of document.querySelectorAll('[data-close]')) {
  btn.addEventListener('click', () => btn.closest('dialog').close());
}

const privacyDialog = $('#privacy-dialog');
$('#open-privacy').addEventListener('click', () => {
  const box = $('#privacy-text');
  box.replaceChildren(
    el('p', {
      text: 'Chaque trace envoyée est publique : son tracé, son point de départ, ses statistiques, ainsi que le titre et le nom que vous saisissez.',
    }),
    el('p', {
      text: "Le fichier d'origine est conservé de façon privée et n'est pas diffusé. Le site ne demande ni compte ni adresse e-mail.",
    }),
    el('p', {
      text: CONFIG.CONTACT_EMAIL
        ? `Pour faire retirer une trace, écrivez à ${CONFIG.CONTACT_EMAIL}.`
        : "Pour faire retirer une trace, contactez l'administrateur du site.",
    })
  );
  privacyDialog.showModal();
});

// ---------- envoi d'une trace ----------

const uploadDialog = $('#upload-dialog');
const form = $('#upload-form');
const fileInput = $('#file');
const dropEl = $('#drop');
const dropMain = $('#drop-main');
const dropHint = $('#drop-hint');
const previewEl = $('#preview');
const titleInput = $('#title');
const pilotInput = $('#pilot');
const consentInput = $('#consent');
const submitBtn = $('#submit');
const statusEl = $('#form-status');
const MAX_BYTES = CONFIG.MAX_FILE_MB * 1024 * 1024;
const DEFAULT_HINT = `GPX, FIT, KML ou IGC, ${CONFIG.MAX_FILE_MB} Mo au maximum.`;

let parsed = null;
let busy = false;
let parseSeq = 0;
let tsWidget = null;
let tsToken = null;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`.trim();
}

function updateSubmit() {
  submitBtn.disabled = busy || !parsed || !consentInput.checked || !tsToken;
}

function resetForm() {
  form.reset();
  parsed = null;
  parseSeq += 1;
  previewEl.hidden = true;
  dropMain.textContent = 'Choisir un fichier ou le déposer ici';
  dropHint.textContent = DEFAULT_HINT;
  titleInput.placeholder = '';
  setStatus('');
  updateSubmit();
}

function setupTurnstile(tries = 0) {
  if (!window.turnstile) {
    if (tries > 40) {
      setStatus(
        "Le contrôle anti-robot n'a pas pu se charger. Vérifiez votre connexion ou désactivez le bloqueur de contenu, puis rouvrez cette fenêtre.",
        'error'
      );
      return;
    }
    setTimeout(() => setupTurnstile(tries + 1), 250);
    return;
  }
  tsToken = null;
  if (tsWidget !== null) {
    window.turnstile.reset(tsWidget);
    return;
  }
  tsWidget = window.turnstile.render('#turnstile', {
    sitekey: CONFIG.TURNSTILE_SITE_KEY,
    callback: (token) => { tsToken = token; updateSubmit(); },
    'expired-callback': () => { tsToken = null; updateSubmit(); },
    'error-callback': () => {
      tsToken = null;
      updateSubmit();
      setStatus('La vérification anti-robot a échoué. Rechargez la page, puis réessayez.', 'error');
    },
  });
}

$('#open-upload').addEventListener('click', () => {
  resetForm();
  uploadDialog.showModal();
  setupTurnstile();
});

async function handleFile(file) {
  const seq = ++parseSeq;
  parsed = null;
  previewEl.hidden = true;
  updateSubmit();
  if (!file) return;

  dropMain.textContent = file.name;
  if (!detectFormat(file.name)) {
    dropHint.textContent = DEFAULT_HINT;
    setStatus('Format non pris en charge. Choisissez un fichier GPX, FIT, KML ou IGC.', 'error');
    return;
  }
  if (file.size > MAX_BYTES) {
    dropHint.textContent = DEFAULT_HINT;
    setStatus(`Ce fichier dépasse ${CONFIG.MAX_FILE_MB} Mo. Choisissez un fichier plus léger.`, 'error');
    return;
  }

  setStatus('Lecture du fichier…');
  try {
    const result = await parseTraceFile(file);
    if (seq !== parseSeq) return;
    parsed = { file, format: result.format, stats: result.stats };
    const s = result.stats;
    const facts = $('#preview-facts');
    facts.replaceChildren();
    const rows = [
      ['Distance', formatDistance(s.distance_m)],
      ['Durée', formatDuration(s.duration_s)],
      ['Altitude max', formatAltitude(s.max_alt_m)],
      ['Date', s.activity_date ? { value: new Date(s.activity_date).toLocaleDateString('fr-CH'), unit: '' } : null],
    ];
    for (const [label, f] of rows) {
      if (!f) continue;
      facts.append(el('div', {}, el('dt', { text: label }), el('dd', { text: [f.value, f.unit].filter(Boolean).join(' ') })));
    }
    const profile = $('#preview-profile');
    const hasProfile = fillProfile(profile, s.track_geojson.coordinates);
    profile.style.display = hasProfile ? '' : 'none';
    previewEl.hidden = false;
    dropHint.textContent = `${nf0.format(s.point_count)} points GPS lus. Choisir un autre fichier pour le remplacer.`;
    titleInput.placeholder = baseName(file.name);
    setStatus('');
  } catch (err) {
    if (seq !== parseSeq) return;
    dropHint.textContent = DEFAULT_HINT;
    setStatus(err.message || 'Ce fichier ne peut pas être lu.', 'error');
  }
  updateSubmit();
}

fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
consentInput.addEventListener('change', updateSubmit);

for (const ev of ['dragenter', 'dragover']) {
  dropEl.addEventListener(ev, (e) => { e.preventDefault(); dropEl.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  dropEl.addEventListener(ev, () => dropEl.classList.remove('over'));
}
dropEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer && e.dataTransfer.files[0];
  if (file) {
    try { fileInput.files = e.dataTransfer.files; } catch (_) { /* navigateur sans prise en charge */ }
    handleFile(file);
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!parsed || !consentInput.checked || !tsToken || busy) return;
  busy = true;
  updateSubmit();
  setStatus('Envoi en cours…');

  const meta = {
    title: (titleInput.value.trim() || baseName(parsed.file.name)).slice(0, 80),
    pilot_name: pilotInput.value.trim().slice(0, 60) || null,
    file_format: parsed.format,
    original_name: parsed.file.name.slice(0, 120),
    consent_public: true,
    stats: parsed.stats,
  };
  const body = new FormData();
  body.append('file', parsed.file);
  body.append('meta', JSON.stringify(meta));
  body.append('turnstile_token', tsToken);

  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/submit-trace`, {
      method: 'POST',
      headers: { apikey: CONFIG.SUPABASE_PUBLISHABLE_KEY },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const unavailable = res.status === 401 || res.status === 404;
      throw new Error(
        data.error ||
          (unavailable ? "Le service d'envoi n'est pas disponible pour l'instant." : `L'envoi a échoué (erreur ${res.status}).`)
      );
    }
    setStatus('Trace envoyée. Elle apparaît sur la carte.', 'ok');
    uploadDialog.close();
    traces = await loadTraces();
    applyView({ fit: false });
    if (data.id && traces.some((t) => t.id === data.id)) select(data.id, { scroll: true });
  } catch (err) {
    setStatus(err.message || "L'envoi a échoué. Réessayez dans un instant.", 'error');
    tsToken = null;
    if (window.turnstile && tsWidget !== null) window.turnstile.reset(tsWidget);
  } finally {
    busy = false;
    updateSubmit();
  }
});

init();
