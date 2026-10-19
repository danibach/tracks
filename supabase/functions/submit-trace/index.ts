// Fonction Supabase « submit-trace » : reçoit une trace envoyée depuis le site.
//
// Ce qu'elle fait, dans l'ordre :
//   1. vérifie l'origine, la taille et le type du fichier ;
//   2. limite le nombre d'envois par connexion et par jour ;
//   3. vérifie l'anti-robot Cloudflare Turnstile ;
//   4. contrôle la cohérence des données extraites par le navigateur ;
//   5. range le fichier d'origine dans le stockage privé et ajoute la ligne dans la table « traces ».
//
// Réglages (Edge Functions > Secrets) :
//   TURNSTILE_SECRET_KEY  clé secrète Turnstile (obligatoire)
//   ALLOWED_ORIGINS       adresses autorisées à appeler la fonction, séparées par des virgules
//                         (défaut : https://danibach.github.io)
//   ALLOWED_HOSTNAMES     noms de domaine acceptés par Turnstile (défaut : danibach.github.io)
//   IP_SALT               texte secret quelconque servant à anonymiser les adresses IP (facultatif)

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const TURNSTILE_SECRET = Deno.env.get("TURNSTILE_SECRET_KEY") ?? "";
const IP_SALT = Deno.env.get("IP_SALT") ?? TURNSTILE_SECRET;
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://danibach.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);
const ALLOWED_HOSTNAMES = (Deno.env.get("ALLOWED_HOSTNAMES") ?? "danibach.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);

const BUCKET = "trace-files";
const MAX_FILE_BYTES = 6 * 1024 * 1024;
const MAX_BODY_BYTES = 7 * 1024 * 1024;
const FORMATS = ["gpx", "fit", "kml", "igc"];
const MAX_PER_IP_PER_HOUR = 5;
const MAX_PER_DAY_TOTAL = 300;

// ---------- utilitaires ----------

function corsHeaders(origin: string): Record<string, string> {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] ?? "";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function secretKey(): string {
  try {
    const dict = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    const k = dict.default ?? Object.values(dict)[0];
    if (typeof k === "string" && k) return k;
  } catch (_) { /* repli sur la clé historique */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

function authHeaders(): Record<string, string> {
  const key = secretKey();
  return key.startsWith("sb_secret_") ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` };
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    "unknown";
}

function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  // deno-lint-ignore no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------- accès à la base ----------

async function countRows(query: string): Promise<number> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/submission_log?select=id&${query}&limit=1`, {
    headers: { ...authHeaders(), Prefer: "count=exact" },
  });
  if (!res.ok) throw new Error(`Comptage impossible (${res.status}) : ${await res.text()}`);
  await res.arrayBuffer();
  const range = res.headers.get("content-range") ?? "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

async function verifyTurnstile(token: string, ip: string): Promise<void> {
  const body = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
  if (ip !== "unknown") body.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) {
    throw new HttpError(403, "La vérification anti-robot a échoué. Rechargez la page, puis réessayez.");
  }
  if (data.hostname && !ALLOWED_HOSTNAMES.includes(data.hostname)) {
    throw new HttpError(403, "Cette adresse n'est pas autorisée à envoyer des traces.");
  }
}

// ---------- validation ----------

function validateMeta(meta: any, ext: string) {
  if (!meta || typeof meta !== "object") throw new HttpError(400, "Données manquantes.");
  if (meta.consent_public !== true) throw new HttpError(400, "Le consentement à la publication est requis.");
  if (meta.file_format !== ext) throw new HttpError(400, "Le format déclaré ne correspond pas au fichier.");

  const s = meta.stats;
  if (!s || typeof s !== "object") throw new HttpError(400, "Statistiques de la trace manquantes.");

  const geo = s.track_geojson;
  const coords = geo && geo.type === "LineString" ? geo.coordinates : null;
  if (!Array.isArray(coords) || coords.length < 2 || coords.length > 600) {
    throw new HttpError(400, "Tracé invalide.");
  }
  for (const c of coords) {
    if (!Array.isArray(c) || c.length < 2 || c.length > 3 || !c.every(isNum)) {
      throw new HttpError(400, "Tracé invalide.");
    }
    if (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) throw new HttpError(400, "Coordonnées invalides.");
    if (c.length === 3 && (c[2] < -500 || c[2] > 9000)) throw new HttpError(400, "Altitude invalide.");
  }

  if (!isNum(s.point_count) || s.point_count < 10 || s.point_count > 10_000_000) {
    throw new HttpError(400, "Nombre de points invalide.");
  }
  if (!isNum(s.distance_m) || s.distance_m < 0 || s.distance_m > 5_000_000) {
    throw new HttpError(400, "Distance invalide.");
  }
  if (s.duration_s != null && (!isNum(s.duration_s) || s.duration_s < 0 || s.duration_s > 2_000_000)) {
    throw new HttpError(400, "Durée invalide.");
  }
  for (const k of ["max_alt_m", "min_alt_m"]) {
    if (s[k] != null && (!isNum(s[k]) || s[k] < -500 || s[k] > 9000)) throw new HttpError(400, "Altitude invalide.");
  }
  if (!isNum(s.start_lat) || !isNum(s.start_lon) || Math.abs(s.start_lat) > 90 || Math.abs(s.start_lon) > 180) {
    throw new HttpError(400, "Point de départ invalide.");
  }
  if (Math.abs(s.start_lon - coords[0][0]) > 0.001 || Math.abs(s.start_lat - coords[0][1]) > 0.001) {
    throw new HttpError(400, "Point de départ incohérent avec le tracé.");
  }
  if (s.activity_date != null) {
    const t = Date.parse(s.activity_date);
    if (!Number.isFinite(t) || t < Date.UTC(1990, 0, 1) || t > Date.now() + 86_400_000) {
      throw new HttpError(400, "Date invalide.");
    }
  }

  // La distance annoncée doit rester du même ordre de grandeur que la longueur du tracé simplifié.
  let simplified = 0;
  for (let i = 1; i < coords.length; i++) {
    simplified += haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  }
  if (simplified > s.distance_m * 1.1 + 100 || s.distance_m > simplified * 15 + 1000) {
    throw new HttpError(400, "La distance ne correspond pas au tracé.");
  }

  return {
    title: cleanText(meta.title, 80) || "Trace sans titre",
    pilot_name: cleanText(meta.pilot_name, 60) || null,
    original_name: cleanText(meta.original_name, 120) || null,
    stats: s,
  };
}

// ---------- traitement d'un envoi ----------

async function handle(req: Request, cors: Record<string, string>): Promise<Response> {
  if (!TURNSTILE_SECRET) throw new Error("TURNSTILE_SECRET_KEY n'est pas configuré.");
  if (!secretKey()) throw new Error("Aucune clé secrète disponible dans la fonction.");

  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) throw new HttpError(413, "Fichier trop volumineux (6 Mo au maximum).");

  let form: FormData;
  try {
    form = await req.formData();
  } catch (_) {
    throw new HttpError(400, "Envoi invalide.");
  }

  const file = form.get("file");
  const token = form.get("turnstile_token");
  const metaRaw = form.get("meta");
  if (!(file instanceof File) || typeof token !== "string" || typeof metaRaw !== "string" || !token) {
    throw new HttpError(400, "Envoi incomplet.");
  }
  if (file.size === 0 || file.size > MAX_FILE_BYTES) {
    throw new HttpError(413, "Fichier vide ou trop volumineux (6 Mo au maximum).");
  }
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!FORMATS.includes(ext)) throw new HttpError(400, "Format non pris en charge.");

  let metaIn: unknown;
  try {
    metaIn = JSON.parse(metaRaw);
  } catch (_) {
    throw new HttpError(400, "Données illisibles.");
  }
  const meta = validateMeta(metaIn, ext);

  // Limites d'usage, avant le contrôle anti-robot (qui coûte un appel externe)
  const ip = clientIp(req);
  const ipHash = await sha256Hex(`${IP_SALT}:${ip}`);
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  if (await countRows(`ip_hash=eq.${ipHash}&created_at=gte.${hourAgo}`) >= MAX_PER_IP_PER_HOUR) {
    throw new HttpError(429, "Trop d'envois depuis votre connexion. Réessayez dans une heure.");
  }
  if (await countRows(`created_at=gte.${dayAgo}`) >= MAX_PER_DAY_TOTAL) {
    throw new HttpError(429, "Le site a atteint sa limite d'envois pour aujourd'hui. Réessayez demain.");
  }

  await verifyTurnstile(token, ip);

  await fetch(`${SUPABASE_URL}/rest/v1/submission_log`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ ip_hash: ipHash }),
  });
  if (Math.random() < 0.1) {
    // Nettoyage occasionnel du journal (on ne garde que 2 jours)
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/submission_log?created_at=lt.${old}`, {
      method: "DELETE",
      headers: { ...authHeaders(), Prefer: "return=minimal" },
    });
  }

  // Fichier d'origine dans le stockage privé
  const now = new Date();
  const path = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;
  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/octet-stream", "x-upsert": "false" },
    body: await file.arrayBuffer(),
  });
  if (!up.ok) throw new Error(`Stockage impossible (${up.status}) : ${await up.text()}`);

  // Ligne dans la table
  const s = meta.stats;
  const ins = await fetch(`${SUPABASE_URL}/rest/v1/traces`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      title: meta.title,
      pilot_name: meta.pilot_name,
      file_format: ext,
      file_path: path,
      original_name: meta.original_name,
      file_size_bytes: file.size,
      activity_date: s.activity_date ?? null,
      duration_s: s.duration_s ?? null,
      distance_m: s.distance_m,
      max_alt_m: s.max_alt_m ?? null,
      min_alt_m: s.min_alt_m ?? null,
      start_lat: s.start_lat,
      start_lon: s.start_lon,
      track_geojson: s.track_geojson,
      consent_public: true,
    }),
  });
  if (!ins.ok) {
    const detail = await ins.text();
    await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, { method: "DELETE", headers: authHeaders() });
    throw new Error(`Insertion impossible (${ins.status}) : ${detail}`);
  }
  const rows = await ins.json();
  return json({ id: rows[0]?.id ?? null }, 200, cors);
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get("origin") ?? "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405, cors);
  try {
    return await handle(req, cors);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status, cors);
    console.error(err);
    return json({ error: "Erreur du service. Réessayez dans un instant." }, 500, cors);
  }
});
