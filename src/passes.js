import * as satellite from 'satellite.js'

const DEG = 180 / Math.PI
const RAD = Math.PI / 180
const EARTH_RADIUS_KM = 6371
const AU_KM = 149597870.7

// Low-precision geocentric solar position (good to ~0.01°), in ECI equatorial coords.
// Source: Astronomical Almanac, "low precision formulas for the Sun".
export function sunEci(date) {
  const jd = date.getTime() / 86400000 + 2440587.5
  const n = jd - 2451545.0 // days since J2000.0
  const L = (280.46 + 0.9856474 * n) * RAD // mean longitude
  const g = (357.528 + 0.9856003 * n) * RAD // mean anomaly
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD // ecliptic longitude
  const eps = (23.439 - 0.0000004 * n) * RAD // obliquity of the ecliptic
  const unit = {
    x: Math.cos(lambda),
    y: Math.cos(eps) * Math.sin(lambda),
    z: Math.sin(eps) * Math.sin(lambda),
  }
  return { unit, position: { x: unit.x * AU_KM, y: unit.y * AU_KM, z: unit.z * AU_KM } }
}

// Is the satellite in sunlight (not in Earth's umbra)? Cylindrical-shadow approximation.
export function isSunlit(satEci, sun) {
  const proj = satEci.x * sun.unit.x + satEci.y * sun.unit.y + satEci.z * sun.unit.z
  if (proj > 0) return true // sunward side of Earth — always lit
  const r2 = satEci.x * satEci.x + satEci.y * satEci.y + satEci.z * satEci.z
  const perp = Math.sqrt(Math.max(0, r2 - proj * proj)) // distance from the Earth–Sun axis
  return perp > EARTH_RADIUS_KM
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
export function azToCompass(azDeg) {
  const a = ((azDeg % 360) + 360) % 360
  return COMPASS[Math.round(a / 22.5) % 16]
}

// Predict upcoming passes of one satellite over an observer.
// observer: { lat, lon, altKm? } in degrees / km.
// Returns [{ start, peak, end, peakElevation, peakAzimuth, peakDir, durationSec, visible }].
export function predictPasses(satrec, observer, opts = {}) {
  const { hours = 48, stepSec = 30, minElevation = 10, maxPasses = 8 } = opts
  const observerGd = {
    latitude: observer.lat * RAD,
    longitude: observer.lon * RAD,
    height: observer.altKm || 0,
  }
  const t0 = Date.now()
  const passes = []
  let cur = null

  const finish = (p) => {
    p.durationSec = Math.round((p.end - p.start) / 1000)
    if (p.durationSec < stepSec) return // drop grazing single-sample passes
    p.peakDir = azToCompass(p.peakAzimuth)
    passes.push(p)
  }

  for (let s = 0; s <= hours * 3600; s += stepSec) {
    const date = new Date(t0 + s * 1000)
    const pv = satellite.propagate(satrec, date)
    if (!pv.position) continue
    const gmst = satellite.gstime(date)
    const look = satellite.ecfToLookAngles(observerGd, satellite.eciToEcf(pv.position, gmst))
    const elDeg = look.elevation * DEG

    if (elDeg >= minElevation) {
      // visible to the naked eye = satellite sunlit AND observer past civil twilight (-6°)
      const sun = sunEci(date)
      const sunEl = satellite.ecfToLookAngles(observerGd, satellite.eciToEcf(sun.position, gmst)).elevation * DEG
      const visibleNow = isSunlit(pv.position, sun) && sunEl < -6

      if (!cur) {
        cur = { start: date, peak: date, end: date, peakElevation: elDeg, peakAzimuth: look.azimuth * DEG, visible: visibleNow }
      } else {
        cur.end = date
        if (elDeg > cur.peakElevation) {
          cur.peakElevation = elDeg
          cur.peakAzimuth = look.azimuth * DEG
          cur.peak = date
        }
        if (visibleNow) cur.visible = true
      }
    } else if (cur) {
      finish(cur)
      cur = null
      if (passes.length >= maxPasses) break
    }
  }
  if (cur && passes.length < maxPasses) finish(cur)
  return passes
}
