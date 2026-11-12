// Stand-in for `three/tsl` (see the alias in vite.config.js, and
// ./three-webgpu.js for the why). three-globe only reads these names inside
// its WebGPU heatmap code, which Orbit doesn't use and which the three/webgpu
// stub stops with a clear error before any of them would be called. They exist
// only so the build doesn't warn about missing exports; if a globe library
// update starts reading a new name, the build will warn and it can be added.
const unused = undefined

export {
  unused as Fn,
  unused as If,
  unused as Loop,
  unused as asin,
  unused as cos,
  unused as exp,
  unused as float,
  unused as instanceIndex,
  unused as negate,
  unused as sin,
  unused as sqrt,
  unused as storage,
  unused as uniform,
}
