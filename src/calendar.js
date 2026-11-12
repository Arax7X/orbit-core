// Turns predicted passes into a downloadable .ics feed so someone can drop
// "ISS over London" straight into their phone's calendar instead of having to
// remember to check back. This is the kind of feature every competitor
// (Star Walk, ISS Detector, Heavens-Above) locks behind a paid tier — here
// it's the free hook; live alerts (see notify.js) are the paid one.

function pad(n) {
  return String(n).padStart(2, '0')
}

// UTC "basic" ICS timestamp: 20260704T214300Z
function toIcsDate(d) {
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  )
}

function escapeIcsText(s) {
  return String(s).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n')
}

// passes: [{ start, peak, end, peakElevation, peakDir, durationSec, visible }]
export function buildIcsForPasses({ passes, satName, place }) {
  const stamp = toIcsDate(new Date())
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//orbit//pass-predictions//EN',
    'CALSCALE:GREGORIAN',
  ]

  passes.forEach((p, i) => {
    const summary = p.visible
      ? `★ ${satName} visible over ${place}`
      : `${satName} pass over ${place}`
    const desc = `Max ${Math.round(p.peakElevation)}° to the ${p.peakDir || ''} · ${
      p.visible ? 'visible to the naked eye' : 'above horizon (may not be visible)'
    }`
    lines.push(
      'BEGIN:VEVENT',
      `UID:orbit-${satName.replace(/\W+/g, '')}-${p.start.getTime()}-${i}@orbit`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${toIcsDate(new Date(p.start))}`,
      `DTEND:${toIcsDate(new Date(p.end))}`,
      `SUMMARY:${escapeIcsText(summary)}`,
      `DESCRIPTION:${escapeIcsText(desc)}`,
      // 15-minute heads-up so there's time to actually go outside and look up.
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Reminder',
      'TRIGGER:-PT15M',
      'END:VALARM',
      'END:VEVENT',
    )
  })

  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}

export function downloadIcs(filename, icsText) {
  const blob = new Blob([icsText], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
