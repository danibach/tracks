// Lecteurs de fichiers de trace : GPX, KML, IGC, FIT.
// Tout se passe dans le navigateur de l'utilisateur, avant l'envoi.
// Module utilisable dans le navigateur et dans Node (tests).

const EARTH_R = 6371000;
export const MAX_STORED_POINTS = 600;
export const MIN_POINTS = 10;
export const FORMATS = ['gpx', 'fit', 'kml', 'igc'];

// ---------- utilitaires ----------

export function haversine(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function validPoint(p) {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lon) <= 180 &&
    !(p.lat === 0 && p.lon === 0)
  );
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function timeMs(v) {
  if (!v) return null;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? t : null;
}

function firstChildText(node, tag) {
  const el = node.getElementsByTagName(tag)[0];
  return el ? el.textContent : null;
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error("Le fichier n'est pas un XML valide.");
  }
  return doc;
}

export function detectFormat(fileName) {
  const m = /\.([a-z0-9]+)$/i.exec(fileName || '');
  const ext = m ? m[1].toLowerCase() : '';
  return FORMATS.includes(ext) ? ext : null;
}

// ---------- GPX ----------

export function parseGPX(text) {
  const doc = parseXml(text);
  let nodes = Array.from(doc.getElementsByTagName('trkpt'));
  if (!nodes.length) nodes = Array.from(doc.getElementsByTagName('rtept'));
  const points = nodes.map((n) => ({
    lat: num(n.getAttribute('lat')),
    lon: num(n.getAttribute('lon')),
    alt: num(firstChildText(n, 'ele')),
    t: timeMs(firstChildText(n, 'time')),
  }));
  return { points, absoluteTime: true };
}

// ---------- KML ----------

export function parseKML(text) {
  const doc = parseXml(text);
  const points = [];

  // Format gx:Track (coordonnées + horodatage)
  const tracks = Array.from(doc.getElementsByTagName('gx:Track'));
  for (const tr of tracks) {
    const whens = Array.from(tr.getElementsByTagName('when')).map((w) => timeMs(w.textContent));
    const coords = Array.from(tr.getElementsByTagName('gx:coord'));
    coords.forEach((c, i) => {
      const [lon, lat, alt] = c.textContent.trim().split(/\s+/).map(num);
      points.push({ lat, lon, alt: alt ?? null, t: whens[i] ?? null });
    });
  }
  if (points.length) return { points, absoluteTime: true };

  // Format LineString classique : on garde la ligne la plus longue
  let best = [];
  for (const el of Array.from(doc.getElementsByTagName('coordinates'))) {
    const pts = el.textContent
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => {
        const [lon, lat, alt] = s.split(',').map(num);
        return { lat, lon, alt: alt ?? null, t: null };
      });
    if (pts.length > best.length) best = pts;
  }
  return { points: best, absoluteTime: false };
}

// ---------- IGC ----------

export function parseIGC(text) {
  const lines = text.split(/\r?\n/);
  let dateMs = null;
  for (const l of lines) {
    const m = /^HFDTE(?:DATE)?:?(\d{2})(\d{2})(\d{2})/.exec(l);
    if (m) {
      const yy = +m[3];
      dateMs = Date.UTC(yy < 70 ? 2000 + yy : 1900 + yy, +m[2] - 1, +m[1]);
      break;
    }
  }
  const points = [];
  let dayOffset = 0;
  let lastSec = -1;
  for (const l of lines) {
    if (l[0] !== 'B' || l.length < 35) continue;
    const sec = +l.substr(1, 2) * 3600 + +l.substr(3, 2) * 60 + +l.substr(5, 2);
    if (lastSec >= 0 && sec < lastSec - 3600) dayOffset += 1; // passage de minuit
    lastSec = sec;
    const lat =
      (+l.substr(7, 2) + +l.substr(9, 5) / 1000 / 60) * (l[14] === 'S' ? -1 : 1);
    const lon =
      (+l.substr(15, 3) + +l.substr(18, 5) / 1000 / 60) * (l[23] === 'W' ? -1 : 1);
    const pAlt = parseInt(l.substr(25, 5), 10);
    const gAlt = parseInt(l.substr(30, 5), 10);
    const alt = Number.isFinite(gAlt) && gAlt !== 0 ? gAlt : Number.isFinite(pAlt) ? pAlt : null;
    points.push({
      lat,
      lon,
      alt,
      t: (dateMs ?? 0) + (dayOffset * 86400 + sec) * 1000,
    });
  }
  return { points, absoluteTime: dateMs !== null };
}

// ---------- FIT (format binaire Garmin) ----------

const FIT_EPOCH_MS = Date.UTC(1989, 11, 31);

export function parseFIT(buf) {
  if (buf.byteLength < 14) throw new Error('Fichier FIT trop court.');
  const dv = new DataView(buf);
  const headerSize = dv.getUint8(0);
  const sig = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
  if (sig !== '.FIT') throw new Error("Ce fichier n'est pas un fichier FIT valide.");
  const dataSize = dv.getUint32(4, true);
  const end = Math.min(buf.byteLength, headerSize + dataSize);

  const defs = {};
  const points = [];
  let lastTs = 0;
  let pos = headerSize;
  const SEMI = 180 / 2 ** 31;

  while (pos < end) {
    const h = dv.getUint8(pos++);
    let local;
    let compressedOffset = null;

    if (h & 0x80) {
      local = (h >> 5) & 0x03;
      compressedOffset = h & 0x1f;
    } else if (h & 0x40) {
      const hasDev = !!(h & 0x20);
      local = h & 0x0f;
      pos += 1; // réservé
      const little = dv.getUint8(pos++) === 0;
      const global = dv.getUint16(pos, little);
      pos += 2;
      const nf = dv.getUint8(pos++);
      const fields = [];
      let size = 0;
      for (let i = 0; i < nf; i++) {
        const f = { num: dv.getUint8(pos), size: dv.getUint8(pos + 1) };
        fields.push(f);
        size += f.size;
        pos += 3;
      }
      if (hasDev) {
        const nd = dv.getUint8(pos++);
        for (let i = 0; i < nd; i++) {
          size += dv.getUint8(pos + 1);
          pos += 3;
        }
      }
      defs[local] = { little, global, fields, size };
      continue;
    } else {
      local = h & 0x0f;
    }

    const def = defs[local];
    if (!def) throw new Error('Fichier FIT corrompu (définition manquante).');
    if (pos + def.size > end) break;

    if (compressedOffset !== null) {
      const base = lastTs - (lastTs & 0x1f);
      lastTs = base + compressedOffset + (compressedOffset < (lastTs & 0x1f) ? 0x20 : 0);
    }

    let p = pos;
    let lat = null;
    let lon = null;
    let alt16 = null;
    let alt32 = null;
    let ts = null;
    for (const f of def.fields) {
      if (f.num === 253 && f.size === 4) {
        const v = dv.getUint32(p, def.little);
        if (v !== 0xffffffff) {
          ts = v;
          lastTs = v;
        }
      } else if (def.global === 20) {
        if (f.num === 0 && f.size === 4) {
          const v = dv.getInt32(p, def.little);
          if (v !== 0x7fffffff) lat = v * SEMI;
        } else if (f.num === 1 && f.size === 4) {
          const v = dv.getInt32(p, def.little);
          if (v !== 0x7fffffff) lon = v * SEMI;
        } else if (f.num === 2 && f.size === 2) {
          const v = dv.getUint16(p, def.little);
          if (v !== 0xffff) alt16 = v / 5 - 500;
        } else if (f.num === 78 && f.size === 4) {
          const v = dv.getUint32(p, def.little);
          if (v !== 0xffffffff) alt32 = v / 5 - 500;
        }
      }
      p += f.size;
    }

    if (def.global === 20 && lat !== null && lon !== null) {
      const t = compressedOffset !== null || ts !== null ? FIT_EPOCH_MS + lastTs * 1000 : null;
      points.push({ lat, lon, alt: alt32 ?? alt16 ?? null, t });
    }
    pos += def.size;
  }
  return { points, absoluteTime: true };
}

// ---------- statistiques et tracé simplifié ----------

export function computeStats(rawPoints, absoluteTime = true) {
  const points = rawPoints.filter(validPoint);
  if (points.length < MIN_POINTS) {
    throw new Error(
      `Trace inexploitable : ${points.length} point(s) GPS valide(s) (minimum ${MIN_POINTS}).`
    );
  }

  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    distance += haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }

  const alts = points.map((p) => p.alt).filter(Number.isFinite);
  const times = points.map((p) => p.t).filter(Number.isFinite);
  let duration = null;
  if (times.length >= 2) {
    duration = Math.round((times[times.length - 1] - times[0]) / 1000);
    if (duration < 0) duration = null;
  }

  let activityDate = null;
  if (absoluteTime && times.length) {
    const d = new Date(times[0]);
    if (d.getUTCFullYear() >= 1990 && d.getTime() < Date.now() + 86400000) {
      activityDate = d.toISOString();
    }
  }

  // Tracé simplifié (échantillonnage régulier) pour la carte
  const n = points.length;
  const target = Math.min(n, MAX_STORED_POINTS);
  const coordinates = [];
  for (let i = 0; i < target; i++) {
    const p = points[target === 1 ? 0 : Math.round((i * (n - 1)) / (target - 1))];
    const c = [Math.round(p.lon * 1e5) / 1e5, Math.round(p.lat * 1e5) / 1e5];
    if (Number.isFinite(p.alt)) c.push(Math.round(p.alt)); // 3e valeur GeoJSON : altitude (m)
    coordinates.push(c);
  }

  return {
    activity_date: activityDate,
    duration_s: duration,
    distance_m: Math.round(distance),
    max_alt_m: alts.length ? Math.round(Math.max(...alts)) : null,
    min_alt_m: alts.length ? Math.round(Math.min(...alts)) : null,
    start_lat: Math.round(points[0].lat * 1e6) / 1e6,
    start_lon: Math.round(points[0].lon * 1e6) / 1e6,
    point_count: n,
    track_geojson: { type: 'LineString', coordinates },
  };
}

// ---------- point d'entrée ----------

export async function parseTraceFile(file) {
  const format = detectFormat(file.name);
  if (!format) {
    throw new Error('Format non pris en charge. Formats acceptés : GPX, FIT, KML, IGC.');
  }
  let result;
  if (format === 'fit') {
    result = parseFIT(await file.arrayBuffer());
  } else {
    const text = await file.text();
    if (format === 'gpx') result = parseGPX(text);
    else if (format === 'kml') result = parseKML(text);
    else result = parseIGC(text);
  }
  const stats = computeStats(result.points, result.absoluteTime);
  return { format, stats };
}
