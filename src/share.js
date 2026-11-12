// Share helpers for the "Look up from <city>" virality hook.
//   buildShareText — the human sentence used by the Web Share sheet / clipboard.
//   buildShareUrl  — a deep link that re-opens the app on this observer + sat.

function fmtPassTime(d) {
  return d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

export function buildShareText({ sat, place, pass }) {
  if (!pass) return `Track ${sat} live over ${place} →`
  const when = fmtPassTime(new Date(pass.peak))
  const vis = pass.visible ? ' — visible to the naked eye!' : ''
  return `Look up from ${place}: ${sat} passes overhead ${when}, max ${Math.round(
    pass.peakElevation,
  )}° to the ${pass.peakDir}${vis}`
}

export function buildShareUrl({ observer, sat, pass }) {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const params = new URLSearchParams()
  if (sat) params.set('sat', sat)
  if (observer) {
    params.set('place', observer.label)
    params.set('lat', Number(observer.lat).toFixed(3))
    params.set('lon', Number(observer.lon).toFixed(3))
  }
  if (pass) {
    params.set('when', fmtPassTime(new Date(pass.peak)))
    params.set('el', String(Math.round(pass.peakElevation)))
    if (pass.peakDir) params.set('dir', pass.peakDir)
    params.set('vis', pass.visible ? '1' : '0')
  }
  const qs = params.toString()
  if (!qs) return origin || '/'
  return `${origin}/?${qs}`
}
