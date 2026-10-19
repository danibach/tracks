// Test de la fonction d'envoi avec un Supabase et un Cloudflare simulés.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { computeStats } from '../parsers.js';

// ----- environnement Deno simulé -----
const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_test' }),
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
};
let handler;
globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };

// ----- réseau simulé -----
const calls = [];
const state = { turnstileOk: true, ipCount: 0, dayCount: 0, hostname: 'danibach.github.io' };
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push({ url, init });
  if (url.includes('turnstile/v0/siteverify')) {
    return Response.json({ success: state.turnstileOk, hostname: state.hostname });
  }
  if (url.includes('/rest/v1/submission_log') && (init.method ?? 'GET') === 'GET') {
    const n = url.includes('ip_hash=') ? state.ipCount : state.dayCount;
    return new Response('[]', { status: 200, headers: { 'content-range': `*/${n}` } });
  }
  if (url.includes('/rest/v1/submission_log')) return new Response(null, { status: 201 });
  if (url.includes('/storage/v1/object/') && init.method === 'POST') return Response.json({ Key: 'ok' });
  if (url.includes('/storage/v1/object/') && init.method === 'DELETE') return Response.json({});
  if (url.includes('/rest/v1/traces')) return Response.json([{ id: 'abc-123' }], { status: 201 });
  throw new Error(`Appel inattendu : ${url}`);
};

// ----- chargement du code TypeScript -----
const src = await readFile(new URL('../supabase/functions/submit-trace/index.ts', import.meta.url), 'utf8');
const { code } = await transform(src, { loader: 'ts', format: 'esm' });
await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
assert.equal(typeof handler, 'function', 'la fonction doit s’enregistrer avec Deno.serve');

// ----- données de test -----
function stats() {
  const pts = [];
  for (let i = 0; i < 60; i++) pts.push({ lat: 46 + i * 0.001, lon: 6.5, alt: 1000 + i * 10, t: Date.UTC(2026, 5, 14, 9) + i * 10000 });
  return computeStats(pts, true);
}

function request({ name = 'vol.gpx', size = 2000, meta = {}, token = 'tok', origin = 'https://danibach.github.io', method = 'POST', mutateStats } = {}) {
  const s = stats();
  if (mutateStats) mutateStats(s);
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(size).fill(65)], name));
  fd.append(
    'meta',
    JSON.stringify({
      title: 'Mon vol',
      pilot_name: 'Dani',
      file_format: name.split('.').pop(),
      original_name: name,
      consent_public: true,
      stats: s,
      ...meta,
    })
  );
  if (token !== null) fd.append('turnstile_token', token);
  return new Request('https://example.supabase.co/functions/v1/submit-trace', {
    method,
    body: method === 'POST' ? fd : undefined,
    headers: { origin },
  });
}

async function run(label, req, expectedStatus, expectedError) {
  const res = await handler(req);
  const body = res.status === 204 ? null : await res.json();
  assert.equal(res.status, expectedStatus, `${label}: statut ${res.status} (${JSON.stringify(body)})`);
  if (expectedError) assert.match(body.error, expectedError, `${label}: message`);
  console.log(`ok  ${label}  -> ${res.status}`);
  return { res, body };
}

// ----- scénarios -----
{
  calls.length = 0;
  const { body } = await run('envoi valide', request({ meta: { title: '  Vol\u0000 du  matin \n ' } }), 200);
  assert.equal(body.id, 'abc-123');
  const insert = calls.find((c) => c.url.endsWith('/rest/v1/traces'));
  const row = JSON.parse(insert.init.body);
  assert.equal(row.title, 'Vol du matin', 'titre nettoyé');
  assert.equal(row.file_format, 'gpx');
  assert.match(row.file_path, /^\d{4}\/\d{2}\/[0-9a-f-]{36}\.gpx$/);
  assert.equal(row.consent_public, true);
  assert.equal(insert.init.headers.apikey, 'sb_secret_test');
  assert.equal(insert.init.headers.Authorization, undefined, 'clé sb_secret_ : seulement apikey');
  const upload = calls.find((c) => c.url.includes('/storage/v1/object/trace-files/') && c.init.method === 'POST');
  assert.ok(upload, 'fichier envoyé au stockage');
  console.log('ok  contenu inséré et stockage');
}
{
  state.turnstileOk = false;
  calls.length = 0;
  await run('anti-robot refusé', request(), 403, /anti-robot/);
  assert.ok(!calls.some((c) => c.url.includes('/storage/')), 'rien n’est stocké si l’anti-robot échoue');
  state.turnstileOk = true;
}
{
  state.hostname = 'autre-site.example';
  await run('mauvais nom de domaine', request(), 403, /autorisée/);
  state.hostname = 'danibach.github.io';
}
await run('consentement absent', request({ meta: { consent_public: false } }), 400, /consentement/);
await run('jeton absent', request({ token: null }), 400, /incomplet/);
await run('extension refusée', request({ name: 'virus.exe' }), 400, /Format/);
await run('format déclaré incohérent', request({ meta: { file_format: 'kml' } }), 400, /format/i);
await run('fichier trop gros', request({ size: 6 * 1024 * 1024 + 1 }), 413);
await run('distance incohérente', request({ mutateStats: (s) => { s.distance_m = 4_000_000; } }), 400, /distance/i);
await run('coordonnées hors limites', request({ mutateStats: (s) => { s.track_geojson.coordinates[5][1] = 123; } }), 400);
await run('date dans le futur', request({ mutateStats: (s) => { s.activity_date = '2099-01-01T00:00:00Z'; } }), 400, /Date/);
{
  state.ipCount = 5;
  await run('limite par connexion', request(), 429, /Trop d'envois/);
  state.ipCount = 0;
  state.dayCount = 300;
  await run('limite quotidienne', request(), 429, /limite/);
  state.dayCount = 0;
}
{
  const { res } = await run('requête OPTIONS', request({ method: 'OPTIONS' }), 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://danibach.github.io');
  const other = await handler(request({ method: 'OPTIONS', origin: 'https://pirate.example' }));
  assert.equal(other.headers.get('access-control-allow-origin'), 'https://danibach.github.io', 'origine inconnue : pas de réflexion');
  console.log('ok  CORS limité au site');
}
await run('méthode GET refusée', new Request('https://x/', { method: 'GET' }), 405);

console.log('\nTous les tests de la fonction sont passés.');
