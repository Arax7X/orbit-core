# Orbit Core

**A live 3D globe of every active satellite, with pass predictions for any city.**

Orbit Core runs entirely in your browser. It downloads the current orbit data
for more than ten thousand satellites, works out where each one is right now,
and draws them all on a globe you can spin and zoom. Type in a city and it
tells you when a satellite will pass overhead and whether you can see it with
your own eyes.

This is the open-source core of [Orbit](https://satellite-globe.vercel.app),
which you can try live.

## What it does

- **Live positions.** Every active satellite, moving in real time.
- **Search.** Find any satellite by name and fly the camera to it.
- **Pass predictions.** Pick a city and get the next passes: start time, peak
  height in the sky, compass direction and duration.
- **Naked-eye check.** A pass is marked visible only when the satellite is in
  sunlight and your sky is dark.
- **Add to calendar.** Download the passes as a calendar file.
- **Share links.** Send someone a link that opens on the same satellite and city.
- **Works when the data source is down.** The last good orbit data is kept in
  the browser and reused.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer.

```
git clone https://github.com/Arax7X/orbit-core.git
cd orbit-core
npm install
npm run dev
```

Then open http://localhost:5173.

## How it works

| File | What it does |
| --- | --- |
| `src/celestrak.js` | Downloads and parses orbit data (TLEs) from CelesTrak, with an offline fallback |
| `src/passes.js` | Predicts passes over an observer and decides whether each is visible to the eye |
| `src/pages/Globe.jsx` | The globe, search and pass panel |
| `src/geocode.js` | Turns a city name into coordinates (Open-Meteo, no key needed) |
| `src/calendar.js` | Builds the calendar file |
| `api/celestrak.js` | A small caching proxy for CelesTrak, for when you deploy to Vercel |

The orbit maths is [satellite.js](https://github.com/shashwatak/satellite-js)
(SGP4). The globe is [react-globe.gl](https://github.com/vasturiano/react-globe.gl)
on three.js. `src/passes.js` has no browser dependencies, so you can lift it
into your own project.

## Deploy your own

Import the repository into [Vercel](https://vercel.com) and deploy. No settings
or keys are needed.

## Data and credits

Orbit data comes from [CelesTrak](https://celestrak.org). Please keep the
caching proxy in place if you deploy this, so their servers are not hit on
every page view.

## Contributing

Issues and pull requests are welcome. Run `npm run lint` and `npm run build`
before you open one.

## License

[MIT](LICENSE)

---

If Orbit Core is useful to you, a ⭐ helps other people find it.
