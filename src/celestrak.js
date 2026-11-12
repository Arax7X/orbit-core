import * as satellite from 'satellite.js'

// CelesTrak sends no CORS header, so the browser needs a server-side proxy.
//   Dev:  Vite proxies /celestrak -> https://celestrak.org (see vite.config.js).
//   Prod: a Vercel Edge Function at /api/celestrak proxies + edge-caches it
//         (see api/celestrak.js) — the dev proxy doesn't exist in the deployed app.
// CelesTrak groups: active | starlink | stations | visual | gps-ops | ...
const ACTIVE_URL = import.meta.env.PROD
  ? '/api/celestrak?GROUP=active'
  : '/celestrak/NORAD/elements/gp.php?GROUP=active&FORMAT=TLE'

// Parse CelesTrak's 3-line TLE format into { name, noradId, satrec } records.
// Skips any record SGP4 can't initialise (satrec.error !== 0).
export function parseTleSet(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  const sats = []
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i].trim()
    const l1 = lines[i + 1]
    const l2 = lines[i + 2]
    // Resync guard in case a record is malformed and throws off the 3-line stride.
    if (l1[0] !== '1' || l2[0] !== '2') continue
    const satrec = satellite.twoline2satrec(l1, l2)
    if (satrec.error) continue
    sats.push({ name, noradId: l1.slice(2, 7).trim(), satrec })
  }
  return sats
}

// Persistent last-good fallback. CelesTrak serves the full active set as a ~3 MB
// file with no CORS header and a rate limit that returns HTTP 403 when hit — and
// it occasionally has short outages. The Cache API (larger quota than
// localStorage, available on localhost and prod HTTPS) lets us keep the last
// successful TLE payload and fall back to it so the globe still renders — just
// with slightly staler orbits — instead of showing an empty sphere.
const TLE_CACHE = 'orbit-tle-v1'

// Fetch fresh TLE text, caching every success. On any network/HTTP failure,
// serve the last cached copy if we have one; only throw when there's nothing to
// fall back to. Returns { text, stale } so callers can surface a "showing cached
// data" hint.
async function fetchTleText(url) {
  const cache = 'caches' in globalThis ? await caches.open(TLE_CACHE).catch(() => null) : null
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`CelesTrak HTTP ${res.status}`)
    if (cache) cache.put(url, res.clone()).catch(() => {})
    return { text: await res.text(), stale: false }
  } catch (err) {
    if (cache) {
      const hit = await cache.match(url).catch(() => null)
      if (hit) return { text: await hit.text(), stale: true }
    }
    throw err
  }
}

// Module-level cache: parsing ~16k TLEs and the network round-trip are both
// expensive, and the SPA may mount the globe more than once (router nav, HMR).
// We memoise the in-flight promise so concurrent callers share one fetch, and
// clear it on failure so a later attempt can retry.
// Resolves to { sats, stale } — `stale` true when served from the last-good cache.
let satellitesPromise = null

export function fetchSatellites(url = ACTIVE_URL) {
  if (satellitesPromise) return satellitesPromise
  satellitesPromise = fetchTleText(url).then(({ text, stale }) => ({
    sats: parseTleSet(text),
    stale,
  }))
  satellitesPromise.catch(() => {
    satellitesPromise = null
  })
  return satellitesPromise
}
