// Stand-in for `three/webgpu` (see the alias in vite.config.js).
//
// The globe libraries (three-render-objects, three-globe) import three's
// WebGPU renderer at the top of their files, but only *use* it in two cases
// Orbit never triggers: passing `rendererConfig={{ useWebGPU: true }}` to
// <Globe>, or using the heatmap layer (`heatmapsData`). Bundling the real
// thing cost every landing-page visitor roughly 800 kB of JavaScript that
// could never run.
//
// These throw rather than fail quietly, so if someone does turn one of those
// features on, the console says exactly what to do instead of rendering a
// blank globe.
const hint =
  'is stubbed out to keep the globe bundle small. To use WebGPU rendering or ' +
  'the heatmap layer, remove the three/webgpu and three/tsl aliases in vite.config.js.'

export class WebGPURenderer {
  constructor() {
    throw new Error(`three/webgpu WebGPURenderer ${hint}`)
  }
}

export class StorageInstancedBufferAttribute {
  constructor() {
    throw new Error(`three/webgpu StorageInstancedBufferAttribute ${hint}`)
  }
}
