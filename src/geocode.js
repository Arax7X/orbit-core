// City/place name -> { name, label, lat, lon } via Open-Meteo's geocoding API.
// Free, no API key, CORS-enabled (works directly from the browser). null if no match.
export async function geocode(query) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Geocoding HTTP ${res.status}`)
  const data = await res.json()
  const r = data.results?.[0]
  if (!r) return null
  const label = [r.name, r.admin1, r.country_code].filter(Boolean).join(', ')
  return { name: r.name, label, lat: r.latitude, lon: r.longitude }
}
