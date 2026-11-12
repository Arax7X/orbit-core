// Stand-in for `h3-js` (see the alias in vite.config.js).
//
// h3-js is the hexagon-grid maths library behind the globe's two hexagon
// layers (`hexBinPointsData` and `hexPolygonsData`). Orbit draws points and
// paths only, so its ~340 kB never ran — but three-globe imports it at the top
// of its file, so every landing-page visitor downloaded it anyway.
//
// Same approach as ./three-webgpu.js: fail loudly with instructions rather
// than quietly, in case someone adds a hexagon layer later.
function stubbed(name) {
  return () => {
    throw new Error(
      `h3-js ${name}() is stubbed out to keep the globe bundle small. To use the ` +
        "globe's hexagon layers, remove the h3-js alias in vite.config.js.",
    )
  }
}

export const latLngToCell = stubbed('latLngToCell')
export const cellToLatLng = stubbed('cellToLatLng')
export const cellToBoundary = stubbed('cellToBoundary')
export const polygonToCells = stubbed('polygonToCells')
