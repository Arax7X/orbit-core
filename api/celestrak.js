/**
 * Production CelesTrak proxy — the Globe's data source at the edge.
 *
 * CelesTrak sends no CORS header, so the browser can't fetch it directly. In dev
 * Vite proxies /celestrak/* (see vite.config.js), but that proxy doesn't exist in
 * the deployed app. This Edge Function fetches the TLE set server-side, adds CORS,
 * and — crucially — caches the ~3 MB payload at Vercel's edge (s-maxage) so every
 * visitor shares one upstream fetch. That both speeds up loads and keeps us under
 * CelesTrak's rate limit, which returns HTTP 403 when many clients fetch directly.
 *
 * Frontend: src/celestrak.js points here in prod (/api/celestrak?GROUP=active) and
 * at the Vite proxy in dev.
 *
 * Vercel Edge Function — lives outside src/ so the Vite build ignores it.
 */
export const config = { runtime: 'edge' }

// Allow-list the CelesTrak groups, so this can't be abused as an open proxy
// for arbitrary query strings.
const GROUPS = new Set([
  'active', 'stations', 'visual', 'starlink', 'gps-ops', 'glo-ops',
  'galileo', 'weather', 'noaa', 'goes', 'science', 'geo',
])

export default async function handler(req) {
  const { searchParams } = new URL(req.url)
  const group = searchParams.get('GROUP') || 'active'
  if (!GROUPS.has(group)) {
    return new Response('Unsupported GROUP', { status: 400 })
  }

  const upstream = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=TLE`
  let res
  try {
    res = await fetch(upstream, {
      headers: { 'User-Agent': 'orbit-globe/1.0 (+https://github.com/Arax7X)' },
    })
  } catch {
    return new Response('CelesTrak unreachable', {
      status: 502,
      headers: { 'Access-Control-Allow-Origin': '*' },
    })
  }
  if (!res.ok) {
    // Surface the upstream status (e.g. 403 when rate-limited) so the client
    // can show a friendly message and fall back to its own last-good cache.
    // Deliberately mapped to 503 rather than 429 here: RFC 5861's
    // stale-if-error (see the success-path Cache-Control below) is only
    // honored by CDNs for 500/502/503/504 responses, not 4xx — a 429 would
    // silently opt this failure mode out of the stale-serve fallback that's
    // the whole point of that header.
    return new Response(`CelesTrak HTTP ${res.status}`, {
      status: 503,
      headers: { 'Access-Control-Allow-Origin': '*' },
    })
  }

  // Stream the upstream body straight through (no buffering the whole 3 MB) and
  // let Vercel's CDN cache it: fresh for 30 min, then serve stale for up to a day
  // while revalidating. TLEs only update a few times a day, so this is plenty
  // current while hammering CelesTrak at most ~twice an hour per region.
  // stale-if-error keeps the last good copy flowing when CelesTrak rate-limits.
  return new Response(res.body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=1800, s-maxage=1800, stale-while-revalidate=86400, stale-if-error=86400',
    },
  })
}
