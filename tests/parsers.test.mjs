// Tests des lecteurs de traces. Lancer : npm install && npm test
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import {
  parseGPX,
  parseKML,
  parseIGC,
  parseFIT,
  computeStats,
  detectFormat,
} from '../parsers.js';

globalThis.DOMParser = DOMParser;

// Trace synthétique : 60 points, ~ 111 m entre chaque point vers le nord, altitude 1000 -> 1590 m
const N = 60;
const lat0 = 46.0;
const lon0 = 6.5;
const step = 0.001; // ~111 m
const t0 = Date.UTC(2026, 5, 14, 9, 0, 0);
const expectedDistance = (N - 1) * 111.2;

function gpxText() {
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = new Date(t0 + i * 10000).toISOString();
    pts.push(
      `<trkpt lat="${lat0 + i * step}" lon="${lon0}"><ele>${1000 + i * 10}</ele><time>${t}</time></trkpt>`
    );
  }
  return `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
}

function kmlLineText() {
  const c = [];
  for (let i = 0; i < N; i++) c.push(`${lon0},${lat0 + i * step},${1000 + i * 10}`);
  return `<?xml version="1.0"?><kml><Document><Placemark><Point><coordinates>${lon0},${lat0},0</coordinates></Point></Placemark><Placemark><LineString><coordinates>${c.join(' ')}</coordinates></LineString></Placemark></Document></kml>`;
}

function kmlTrackText() {
  const w = [];
  const c = [];
  for (let i = 0; i < N; i++) {
    w.push(`<when>${new Date(t0 + i * 10000).toISOString()}</when>`);
    c.push(`<gx:coord>${lon0} ${lat0 + i * step} ${1000 + i * 10}</gx:coord>`);
  }
  return `<?xml version="1.0"?><kml xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><Placemark><gx:Track>${w.join('')}${c.join('')}</gx:Track></Placemark></Document></kml>`;
}

function igcText(startSecond = 9 * 3600) {
  const lines = ['AXXX000 test', 'HFDTEDATE:140626,01', 'HFPLTPILOTINCHARGE:Test'];
  for (let i = 0; i < N; i++) {
    const sec = startSecond + i * 10;
    const hh = String(Math.floor(sec / 3600) % 24).padStart(2, '0');
    const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    const lat = lat0 + i * step;
    const latDeg = Math.floor(lat);
    const latMin = Math.round((lat - latDeg) * 60 * 1000);
    const lonDeg = Math.floor(lon0);
    const lonMin = Math.round((lon0 - lonDeg) * 60 * 1000);
    const latS = String(latDeg).padStart(2, '0') + String(latMin).padStart(5, '0') + 'N';
    const lonS = String(lonDeg).padStart(3, '0') + String(lonMin).padStart(5, '0') + 'E';
    const alt = String(1000 + i * 10).padStart(5, '0');
    lines.push(`B${hh}${mm}${ss}${latS}${lonS}A${alt}${alt}`);
  }
  return lines.join('\r\n');
}

function fitBuffer({ compressed = false } = {}) {
  const FIT_EPOCH = Date.UTC(1989, 11, 31);
  const bytes = [];
  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const semi = (deg) => Math.round(deg / (180 / 2 ** 31)) | 0;
  const body = [];
  // Définition du message 20 (record) : timestamp, lat, lon, altitude
  body.push(0x40, 0, 0, ...u16(20), 4);
  body.push(253, 4, 0x86, 0, 4, 0x85, 1, 4, 0x85, 2, 2, 0x84);
  // Un message sans rapport (global 0, 1 champ) pour vérifier le saut
  body.push(0x41, 0, 0, ...u16(0), 1, 0, 1, 0x00);
  body.push(0x01, 7);
  const ts0 = Math.round((t0 - FIT_EPOCH) / 1000);
  for (let i = 0; i < N; i++) {
    const ts = ts0 + i * 10;
    const alt = Math.round((1000 + i * 10 + 500) * 5);
    if (compressed && i % 2 === 1) {
      // timestamp compressé : décalage sur 5 bits, local type 0
      // ts0 + 10*i : on code l'écart avec le dernier timestamp complet (toujours < 32 s ici)
      const off = ts & 0x1f;
      body.push(0x80 | off);
    } else {
      body.push(0x00, ...u32(ts));
    }
    // les champs lat/lon/alt suivent dans les deux cas
    // (pour un message compressé, le champ 253 est absent de la définition réelle :
    // on utilise donc une seconde définition locale 1 sans timestamp)
    if (compressed && i % 2 === 1) {
      // retire l'en-tête compressé ajouté et le remplace par la version locale 1
      body.pop();
      body.push(0x80 | (1 << 5) | (ts & 0x1f));
    }
    body.push(...u32(semi(lat0 + i * step)), ...u32(semi(lon0)), ...u16(alt));
    if (compressed && i === 0) {
      // définition locale 1 (record sans timestamp) juste après le premier enregistrement
      body.push(0x41, 0, 0, ...u16(20), 3, 0, 4, 0x85, 1, 4, 0x85, 2, 2, 0x84);
    }
  }
  const header = [14, 0x20, ...u16(2000), ...u32(body.length), 0x2e, 0x46, 0x49, 0x54, 0, 0];
  bytes.push(...header, ...body, 0, 0);
  return new Uint8Array(bytes).buffer;
}

function check(label, stats, { time = true, alt = true } = {}) {
  assert.equal(stats.point_count, N, `${label}: nombre de points`);
  assert.ok(
    Math.abs(stats.distance_m - expectedDistance) < 15,
    `${label}: distance ${stats.distance_m} ≠ ~${Math.round(expectedDistance)}`
  );
  if (alt) {
    assert.equal(stats.max_alt_m, 1000 + (N - 1) * 10, `${label}: altitude max`);
    assert.equal(stats.min_alt_m, 1000, `${label}: altitude min`);
  }
  if (time) {
    assert.equal(stats.duration_s, (N - 1) * 10, `${label}: durée`);
    assert.equal(stats.activity_date, new Date(t0).toISOString(), `${label}: date`);
  }
  assert.ok(Math.abs(stats.start_lat - lat0) < 1e-5, `${label}: latitude de départ`);
  assert.equal(stats.track_geojson.coordinates.length, N, `${label}: tracé`);
  if (alt) {
    const last = stats.track_geojson.coordinates[N - 1];
    assert.equal(last[2], 1000 + (N - 1) * 10, `${label}: altitude dans le tracé`);
  }
  console.log(`ok  ${label}  (distance ${stats.distance_m} m, durée ${stats.duration_s ?? '-'} s)`);
}

// GPX
{
  const r = parseGPX(gpxText());
  check('GPX', computeStats(r.points, r.absoluteTime));
}
// KML LineString (pas d'horodatage)
{
  const r = parseKML(kmlLineText());
  const s = computeStats(r.points, r.absoluteTime);
  assert.equal(s.activity_date, null);
  check('KML LineString', s, { time: false });
}
// KML gx:Track (avec horodatage)
{
  const r = parseKML(kmlTrackText());
  check('KML gx:Track', computeStats(r.points, r.absoluteTime));
}
// IGC
{
  const r = parseIGC(igcText());
  check('IGC', computeStats(r.points, r.absoluteTime));
}
// IGC avec passage de minuit
{
  const r = parseIGC(igcText(24 * 3600 - 200));
  const s = computeStats(r.points, r.absoluteTime);
  assert.equal(s.duration_s, (N - 1) * 10, 'IGC minuit: durée');
  console.log('ok  IGC passage de minuit');
}
// FIT
{
  const r = parseFIT(fitBuffer());
  check('FIT', computeStats(r.points, r.absoluteTime));
}
// FIT avec timestamps compressés
{
  const r = parseFIT(fitBuffer({ compressed: true }));
  check('FIT (timestamps compressés)', computeStats(r.points, r.absoluteTime));
}
// Fichiers invalides
{
  assert.throws(() => parseFIT(new ArrayBuffer(20)), /FIT/);
  assert.throws(() => computeStats([{ lat: 46, lon: 6, alt: 0, t: 0 }]), /inexploitable/);
  // Selon le moteur XML, un fichier invalide échoue au décodage (navigateur) ou ne donne aucun point
  assert.throws(() => {
    const r = parseGPX('pas du xml <<<');
    computeStats(r.points, r.absoluteTime);
  }, /XML|inexploitable/);
  assert.equal(detectFormat('vol.IGC'), 'igc');
  assert.equal(detectFormat('vol.exe'), null);
  console.log('ok  fichiers invalides et formats');
}
// Simplification du tracé
{
  const pts = [];
  for (let i = 0; i < 5000; i++) pts.push({ lat: 46 + i * 1e-5, lon: 6.5, alt: 1000, t: t0 + i * 1000 });
  const s = computeStats(pts, true);
  assert.equal(s.track_geojson.coordinates.length, 600);
  assert.equal(s.point_count, 5000);
  console.log('ok  simplification 5000 -> 600 points');
}
console.log('\nTous les tests sont passés.');
