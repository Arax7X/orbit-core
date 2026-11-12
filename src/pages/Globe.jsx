import { useEffect, useRef, useState } from 'react'
import Globe from 'react-globe.gl'
import * as THREE from 'three'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import * as satellite from 'satellite.js'
import * as solar from 'solar-calculator'
import { fetchSatellites } from '../celestrak'
import { predictPasses } from '../passes'
import { geocode } from '../geocode'
import { buildShareText, buildShareUrl } from '../share'
import { buildIcsForPasses, downloadIcs } from '../calendar'
import { CAPITALS, CONTINENTS } from '../capitals'
import '../App.css'

const EARTH_RADIUS_KM = 6371
const ISS_NORAD = '25544'
const CHUNK = 2000 // satellites propagated per animation frame
const CLOUDS_IMG_URL = '//unpkg.com/three-globe/example/clouds/clouds.png'

// Real-time subsolar point (the [lng, lat] the sun sits directly overhead of),
// used to drive the day/night terminator shader below. Same formula as
// three-globe's own solar-terminator/day-night-cycle examples.
function sunPosAt(dt) {
  const day = new Date(+dt).setUTCHours(0, 0, 0, 0)
  const t = solar.century(dt)
  const longitude = ((day - dt) / 864e5) * 360 - 180
  return [longitude - solar.equationOfTime(t) / 4, solar.declination(t)]
}

// Blends day/night Earth textures based on real sun position — the same
// technique used by three-globe's official day-night-cycle example, adapted
// to react-globe.gl's `globeMaterial` prop.
const dayNightShader = {
  vertexShader: `
    varying vec3 vNormal;
    varying vec2 vUv;
    void main() {
      vNormal = normalize(normalMatrix * normal);
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    #define PI 3.141592653589793
    uniform sampler2D dayTexture;
    uniform sampler2D nightTexture;
    uniform vec2 sunPosition;
    uniform vec2 globeRotation;
    varying vec3 vNormal;
    varying vec2 vUv;

    float toRad(in float a) { return a * PI / 180.0; }

    vec3 Polar2Cartesian(in vec2 c) { // [lng, lat]
      float theta = toRad(90.0 - c.x);
      float phi = toRad(90.0 - c.y);
      return vec3(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
    }

    void main() {
      float invLon = toRad(globeRotation.x);
      float invLat = -toRad(globeRotation.y);
      mat3 rotX = mat3(1, 0, 0, 0, cos(invLat), -sin(invLat), 0, sin(invLat), cos(invLat));
      mat3 rotY = mat3(cos(invLon), 0, sin(invLon), 0, 1, 0, -sin(invLon), 0, cos(invLon));
      vec3 rotatedSunDirection = rotX * rotY * Polar2Cartesian(sunPosition);
      float intensity = dot(normalize(vNormal), normalize(rotatedSunDirection));
      vec4 dayColor = texture2D(dayTexture, vUv);
      vec4 nightColor = texture2D(nightTexture, vUv);
      // widen the blend band a touch so the terminator reads as a soft dusk/dawn
      // gradient rather than a hard knife-edge
      float blendFactor = smoothstep(-0.25, 0.2, intensity);
      gl_FragColor = mix(nightColor, dayColor, blendFactor);
    }
  `,
}

// Soft round sprite so points read as glowing dots instead of hard squares.
function makeDotTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.4, 'rgba(190,215,255,0.9)')
  g.addColorStop(1, 'rgba(190,215,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(canvas)
}

function geodeticNow(satrec, date = new Date()) {
  const pv = satellite.propagate(satrec, date)
  if (!pv.position) return null
  const gd = satellite.eciToGeodetic(pv.position, satellite.gstime(date))
  const v = pv.velocity
  return {
    lat: satellite.degreesLat(gd.latitude),
    lng: satellite.degreesLong(gd.longitude),
    alt: gd.height, // km
    speed: v ? Math.hypot(v.x, v.y, v.z) : null, // km/s (inertial)
  }
}

// Current range + elevation of a satellite as seen from the observer.
// elevation < 0 means it's below the horizon (not overhead right now).
function lookAngles(satrec, observer, date = new Date()) {
  const pv = satellite.propagate(satrec, date)
  if (!pv.position) return null
  const gmst = satellite.gstime(date)
  const ecf = satellite.eciToEcf(pv.position, gmst)
  const look = satellite.ecfToLookAngles(
    {
      longitude: (observer.lon * Math.PI) / 180,
      latitude: (observer.lat * Math.PI) / 180,
      height: 0,
    },
    ecf,
  )
  return { rangeKm: look.rangeSat, elevationDeg: (look.elevation * 180) / Math.PI }
}

// How far out the camera has to sit for the whole Earth (plus its glow) to fit
// across the screen. The camera's field of view is vertical, so on a wide
// screen the default 2.3 always fits; on a tall phone screen it does not, and
// the globe used to open cropped at both sides.
const DEFAULT_ALTITUDE = 2.3
function framingAltitude(camera, w, h) {
  const halfWidthAngle = Math.atan(Math.tan((camera.fov * Math.PI) / 360) * (w / h))
  return Math.max(DEFAULT_ALTITUDE, 1.08 / Math.sin(halfWidthAngle) - 1)
}

function fmtWhen(d) {
  return d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}
function relTime(d, now) {
  const ms = d.getTime() - now
  if (ms <= 0) return 'now'
  const m = Math.round(ms / 60000)
  if (m < 60) return `in ${m}m`
  return `in ${Math.floor(m / 60)}h ${m % 60}m`
}
function fmtDur(sec) {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m ? `${m}m ${s}s` : `${s}s`
}

export default function GlobePage() {
  const globeEl = useRef()
  const satsRef = useRef([])
  const pointsRef = useRef(null)
  const posRef = useRef(null)
  const cursorRef = useRef(0)
  const deepLinkSatRef = useRef(null) // sat name from a shared "?sat=" link, applied after load
  const readoutRef = useRef(null) // mirrors `readout`, read inside rAF loops that can't close over state
  const earthLoadedRef = useRef(false) // the library has told us the Earth picture is in
  const globeStartedRef = useRef(false) // startGlobe() has done its one-time setup

  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [status, setStatus] = useState({ loading: true, count: 0, error: null, stale: false })
  const [dayNightMaterial, setDayNightMaterial] = useState(null)
  const [globeReady, setGlobeReady] = useState(false)
  const [satsLoaded, setSatsLoaded] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(null)
  const [readout, setReadout] = useState(null) // { name, lat, lng, alt }
  const [search, setSearch] = useState('')

  // step 4: location + passes
  const [observer, setObserver] = useState(null) // { lat, lon, label }
  const [locInput, setLocInput] = useState('')
  const [locMsg, setLocMsg] = useState(null)
  const [passes, setPasses] = useState([])
  const [passesMsg, setPassesMsg] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [shareMsg, setShareMsg] = useState(null)
  const [orbitPath, setOrbitPath] = useState([])

  // Small screens only (see the "phone layout" block in App.css): the two
  // panels share one bottom sheet, `tab` picks which one it shows and
  // `sheetOpen` whether it is pulled up. Desktop ignores both.
  const [tab, setTab] = useState('sat')
  const [sheetOpen, setSheetOpen] = useState(false)

  // viewport sizing
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Build the real day/night terminator material once. Loads both textures in
  // parallel, then swaps in over whatever globeImageUrl is showing as a fallback.
  useEffect(() => {
    let cancelled = false
    const loader = new THREE.TextureLoader()
    Promise.all([
      loader.loadAsync('//unpkg.com/three-globe/example/img/earth-day.jpg'),
      loader.loadAsync('//unpkg.com/three-globe/example/img/earth-night.jpg'),
    ]).then(([dayTexture, nightTexture]) => {
      if (cancelled) return
      dayTexture.colorSpace = THREE.SRGBColorSpace
      nightTexture.colorSpace = THREE.SRGBColorSpace
      const material = new THREE.ShaderMaterial({
        uniforms: {
          dayTexture: { value: dayTexture },
          nightTexture: { value: nightTexture },
          sunPosition: { value: new THREE.Vector2(...sunPosAt(Date.now())) },
          globeRotation: { value: new THREE.Vector2() },
        },
        vertexShader: dayNightShader.vertexShader,
        fragmentShader: dayNightShader.fragmentShader,
      })
      setDayNightMaterial(material)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Keep the terminator's sun position true to the real world clock — the
  // subsolar point barely moves minute to minute, so a slow refresh is plenty.
  useEffect(() => {
    if (!dayNightMaterial) return
    const update = () => dayNightMaterial.uniforms.sunPosition.value.set(...sunPosAt(Date.now()))
    update()
    const id = setInterval(update, 30000)
    return () => clearInterval(id)
  }, [dayNightMaterial])

  // The globe mesh itself never rotates — "auto-rotate" spins the camera
  // around it — so the shader needs the camera's current lng/lat every frame
  // to counter-rotate the sun direction and keep the terminator locked to
  // the real world instead of sliding as the view orbits.
  useEffect(() => {
    if (!dayNightMaterial || !globeReady) return
    const globe = globeEl.current
    let raf
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const { lng, lat } = globe.toGeoCoords(globe.camera().position)
      dayNightMaterial.uniforms.globeRotation.value.set(lng, lat)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [dayNightMaterial, globeReady])

  // Thin, slowly-drifting cloud layer just above the surface — independent
  // rotation speed from the globe/camera gives real parallax as you orbit.
  useEffect(() => {
    if (!globeReady) return
    const globe = globeEl.current
    const radius = globe.getGlobeRadius() * 1.008
    const clouds = new THREE.Mesh(new THREE.SphereGeometry(radius, 75, 75))
    // A mesh without a material of its own is drawn solid white. Keep this
    // one hidden until its picture arrives, or the Earth is covered by a white
    // ball while the picture downloads, and for good if the download fails.
    clouds.visible = false
    let disposed = false
    new THREE.TextureLoader().load(CLOUDS_IMG_URL, (texture) => {
      if (disposed) {
        texture.dispose()
        return
      }
      clouds.material = new THREE.MeshPhongMaterial({
        map: texture,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      })
      clouds.visible = true
    })
    globe.scene().add(clouds)

    let raf
    const tick = () => {
      raf = requestAnimationFrame(tick)
      clouds.rotation.y += (-0.006 * Math.PI) / 180
    }
    raf = requestAnimationFrame(tick)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      globe.scene().remove(clouds)
      clouds.geometry.dispose()
      clouds.material?.map?.dispose()
      clouds.material?.dispose()
    }
  }, [globeReady])

  // Bloom post-processing — the payoff for all the additive-blended layers
  // (starfield, satellite point cloud, radar rings, atmosphere edge): only
  // genuinely bright pixels catch bloom, so city lights and glow accents pop
  // without blowing out the day-lit textures.
  useEffect(() => {
    if (!globeReady) return
    const globe = globeEl.current
    const composer = globe.postProcessingComposer()
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.9, // strength
      0.6, // radius
      0.72, // threshold — only bright accents bloom, not the whole lit globe
    )
    const output = new OutputPass()
    composer.addPass(bloom)
    composer.addPass(output)

    const onResize = () => bloom.resolution.set(window.innerWidth, window.innerHeight)
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      composer.removePass(bloom)
      composer.removePass(output)
      bloom.dispose()
    }
  }, [globeReady])

  // deep link: a shared "?sat=&place=&lat=&lon=" link opens focused on that view
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const place = p.get('place')
    const lat = Number(p.get('lat'))
    const lon = Number(p.get('lon'))
    if (place && Number.isFinite(lat) && Number.isFinite(lon)) {
      setObserver({ label: place, lat, lon })
    }
    const sat = p.get('sat')
    if (sat) deepLinkSatRef.current = sat
  }, [])

  // load the full active-satellite catalogue from CelesTrak
  useEffect(() => {
    let cancelled = false
    fetchSatellites()
      .then(({ sats, stale }) => {
        if (cancelled) return
        satsRef.current = sats
        setStatus({ loading: false, count: sats.length, error: null, stale })
        setSatsLoaded(true)
      })
      .catch((err) => {
        if (cancelled) return
        setStatus({ loading: false, count: 0, error: err.message, stale: false })
        showLoadError()
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // build the point cloud + start the propagation loop once globe + data are ready
  useEffect(() => {
    if (!globeReady || !satsLoaded) return
    const globe = globeEl.current
    const sats = satsRef.current
    const n = sats.length

    const positions = new Float32Array(n * 3)
    posRef.current = positions

    // initial full pass so nothing sits at the origin on the first frame
    const now0 = new Date()
    const gmst = satellite.gstime(now0)
    for (let i = 0; i < n; i++) {
      const pv = satellite.propagate(sats[i].satrec, now0)
      if (!pv.position) continue
      const gd = satellite.eciToGeodetic(pv.position, gmst)
      const c = globe.getCoords(
        satellite.degreesLat(gd.latitude),
        satellite.degreesLong(gd.longitude),
        gd.height / EARTH_RADIUS_KM,
      )
      positions[i * 3] = c.x
      positions[i * 3 + 1] = c.y
      positions[i * 3 + 2] = c.z
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const material = new THREE.PointsMaterial({
      size: 3.0, // tune this for dot size
      map: makeDotTexture(),
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
      color: 0xcfe6ff,
      blending: THREE.AdditiveBlending, // overlapping dots bloom brighter — "neon dust" look
    })
    const points = new THREE.Points(geometry, material)
    points.frustumCulled = false // positions mutate every frame; don't cull by stale bounds
    pointsRef.current = points
    globe.scene().add(points)

    // a shared link selects (and flies to) its satellite; otherwise default to
    // the ISS in the panel while the globe keeps spinning (no fly-to)
    const want = deepLinkSatRef.current
    let startIdx = -1
    if (want) startIdx = sats.findIndex((s) => s.name.toLowerCase().includes(want.toLowerCase()))
    if (startIdx < 0) startIdx = sats.findIndex((s) => s.noradId === ISS_NORAD)
    if (startIdx >= 0) selectSat(startIdx, { fly: !!want })

    // chunked propagation — bounded work per frame, full set refreshed ~7x/sec
    let raf
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const date = new Date()
      const g = satellite.gstime(date)
      const pos = posRef.current
      const start = cursorRef.current
      const end = Math.min(start + CHUNK, n)
      for (let i = start; i < end; i++) {
        const pv = satellite.propagate(sats[i].satrec, date)
        if (!pv.position) continue
        const gd = satellite.eciToGeodetic(pv.position, g)
        const c = globe.getCoords(
          satellite.degreesLat(gd.latitude),
          satellite.degreesLong(gd.longitude),
          gd.height / EARTH_RADIUS_KM,
        )
        pos[i * 3] = c.x
        pos[i * 3 + 1] = c.y
        pos[i * 3 + 2] = c.z
      }
      cursorRef.current = end >= n ? 0 : end
      geometry.attributes.position.needsUpdate = true
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      globe.scene().remove(points)
      geometry.dispose()
      material.map?.dispose()
      material.dispose()
      pointsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globeReady, satsLoaded])

  // click-to-select via raycasting; ignores drags so rotating doesn't select
  useEffect(() => {
    if (!globeReady) return
    const globe = globeEl.current
    const dom = globe.renderer().domElement
    const raycaster = new THREE.Raycaster()
    raycaster.params.Points.threshold = 1.6
    let downX = 0
    let downY = 0

    const onDown = (e) => {
      downX = e.clientX
      downY = e.clientY
      globe.controls().autoRotate = false // stop spinning once the user engages
    }
    const onUp = (e) => {
      const touch = e.pointerType === 'touch'
      // a finger wobbles more than a mouse between press and release
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > (touch ? 10 : 5)) return // was a drag
      if (!pointsRef.current) return
      const rect = dom.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(ndc, globe.camera())
      if (!touch) {
        raycaster.params.Points.threshold = 1.6
        const hits = raycaster.intersectObject(pointsRef.current, false)
        if (hits.length) selectSat(hits[0].index)
        return
      }
      // A fingertip covers far more than a mouse pointer, so accept anything
      // within about 22 px of the tap and take the dot closest to its centre.
      // Dots hidden behind the Earth are skipped, or the wider net would
      // pick satellites on the far side.
      const camera = globe.camera()
      const pxToUnits =
        (2 * camera.position.length() * Math.tan((camera.fov * Math.PI) / 360)) / rect.height
      raycaster.params.Points.threshold = Math.max(1.6, 22 * pxToUnits)
      const earth = new THREE.Sphere(new THREE.Vector3(), globe.getGlobeRadius())
      const surface = raycaster.ray.intersectSphere(earth, new THREE.Vector3())
      const surfaceDist = surface ? surface.distanceTo(raycaster.ray.origin) : Infinity
      let best = null
      for (const hit of raycaster.intersectObject(pointsRef.current, false)) {
        if (hit.distance > surfaceDist) continue
        if (!best || hit.distanceToRay < best.distanceToRay) best = hit
      }
      if (best) {
        selectSat(best.index)
        // show what was just tapped: on a phone the readout lives in the sheet
        setTab('sat')
        setSheetOpen(true)
      }
    }

    dom.addEventListener('pointerdown', onDown)
    dom.addEventListener('pointerup', onUp)
    return () => {
      dom.removeEventListener('pointerdown', onDown)
      dom.removeEventListener('pointerup', onUp)
    }
  }, [globeReady])

  // keep the selected satellite's readout + highlight marker live
  useEffect(() => {
    if (selectedIdx == null) return
    const update = () => {
      const sat = satsRef.current[selectedIdx]
      if (!sat) return
      const geo = geodeticNow(sat.satrec)
      if (!geo) return
      const rel = observer ? lookAngles(sat.satrec, observer) : null
      const next = { name: sat.name, ...geo, rel }
      readoutRef.current = next
      setReadout(next)
    }
    update()
    const id = setInterval(update, 250)
    return () => clearInterval(id)
  }, [selectedIdx, observer])

  // Deep-space starfield: a shell of thousands of soft, twinkling points sitting
  // well inside the existing background skysphere (three-render-objects sets
  // skyRadius/camera.far around 50000/125000) so it reads as real parallax depth
  // behind the globe rather than a flat backdrop.
  useEffect(() => {
    if (!globeReady) return
    const globe = globeEl.current
    const COUNT = 6000
    const RADIUS = 7000
    const positions = new Float32Array(COUNT * 3)
    const phases = new Float32Array(COUNT)
    const sizes = new Float32Array(COUNT)
    for (let i = 0; i < COUNT; i++) {
      // uniform random point on a sphere shell (with a little radial jitter for depth)
      const u = Math.random()
      const v = Math.random()
      const theta = 2 * Math.PI * u
      const phi = Math.acos(2 * v - 1)
      const r = RADIUS * (0.85 + Math.random() * 0.15)
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
      positions[i * 3 + 2] = r * Math.cos(phi)
      phases[i] = Math.random() * Math.PI * 2
      sizes[i] = 1 + Math.random() * 2.2
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1))
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))

    const material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float aPhase;
        attribute float aSize;
        uniform float uTime;
        varying float vTwinkle;
        void main() {
          vTwinkle = 0.5 + 0.5 * sin(uTime * 1.6 + aPhase);
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (0.5 + 0.5 * vTwinkle) * (350.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying float vTwinkle;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          float alpha = smoothstep(0.5, 0.0, d) * (0.35 + 0.65 * vTwinkle);
          gl_FragColor = vec4(0.85, 0.92, 1.0, alpha);
        }
      `,
    })

    const stars = new THREE.Points(geometry, material)
    stars.frustumCulled = false
    globe.scene().add(stars)

    let raf
    const clock = new THREE.Clock()
    const tick = () => {
      raf = requestAnimationFrame(tick)
      material.uniforms.uTime.value = clock.getElapsedTime()
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      globe.scene().remove(stars)
      geometry.dispose()
      material.dispose()
    }
  }, [globeReady])

  // Pulsing "radar ping" rings anchored to the tracked satellite's ground point —
  // two phase-offset rings expanding + fading in a continuous loop, oriented
  // tangent to the globe surface so they read as a radar sweep, not a HUD sticker.
  useEffect(() => {
    if (!globeReady || selectedIdx == null) return
    const globe = globeEl.current
    const group = new THREE.Group()
    const ringGeo = new THREE.RingGeometry(1, 1.08, 64)
    const period = 2200 // ms per ping cycle
    const maxScale = 6
    const rings = [0, 1].map(() => {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x00e5ff,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      const mesh = new THREE.Mesh(ringGeo, mat)
      group.add(mesh)
      return mesh
    })
    globe.scene().add(group)

    let raf
    const start = performance.now()
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const geo = readoutRef.current
      if (!geo) return
      const c = globe.getCoords(geo.lat, geo.lng, (geo.alt || 0) / EARTH_RADIUS_KM + 0.002)
      group.position.set(c.x, c.y, c.z)
      group.lookAt(0, 0, 0) // orients the ring's face outward, tangent to the surface

      const t = performance.now() - start
      rings.forEach((mesh, i) => {
        const phase = ((t + (i * period) / 2) % period) / period
        const scale = 0.6 + phase * maxScale
        mesh.scale.set(scale, scale, scale)
        mesh.material.opacity = 0.55 * (1 - phase)
      })
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      globe.scene().remove(group)
      ringGeo.dispose()
      rings.forEach((m) => m.material.dispose())
    }
  }, [globeReady, selectedIdx])

  // Draw the selected satellite's ground track — a glowing, animated arc
  // showing where it's been and where it's headed, ±45 minutes either side
  // of now. Recomputed every 30s; the orbit barely shifts faster than that.
  useEffect(() => {
    if (selectedIdx == null) {
      setOrbitPath([])
      return
    }
    const sat = satsRef.current[selectedIdx]
    if (!sat) return
    function computeTrack() {
      const pts = []
      const t0 = Date.now()
      const stepMs = 60000
      const halfSpanMin = 45
      for (let m = -halfSpanMin; m <= halfSpanMin; m++) {
        const d = new Date(t0 + m * stepMs)
        const pv = satellite.propagate(sat.satrec, d)
        if (!pv.position) continue
        const gd = satellite.eciToGeodetic(pv.position, satellite.gstime(d))
        pts.push({
          lat: satellite.degreesLat(gd.latitude),
          lng: satellite.degreesLong(gd.longitude),
          alt: gd.height / EARTH_RADIUS_KM,
        })
      }
      setOrbitPath(pts)
    }
    computeTrack()
    const id = setInterval(computeTrack, 30000)
    return () => clearInterval(id)
  }, [selectedIdx])

  // recompute passes whenever the location or the selected satellite changes
  useEffect(() => {
    if (!observer) {
      setPasses([])
      setPassesMsg(null)
      return
    }
    if (selectedIdx == null) {
      setPasses([])
      setPassesMsg('Select a satellite to see its passes.')
      return
    }
    const sat = satsRef.current[selectedIdx]
    if (!sat) return
    try {
      const result = predictPasses(sat.satrec, observer, { hours: 48 })
      setPasses(result)
      setPassesMsg(result.length ? null : 'No passes above 10° in the next 48 h.')
    } catch {
      setPasses([])
      setPassesMsg('Could not compute passes for this object.')
    }
  }, [observer, selectedIdx])

  // keep relative times ("in 3h 12m") fresh
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(id)
  }, [])

  // Manual retry after a load failure (e.g. CelesTrak rate-limiting). fetchSatellites
  // clears its memoised promise on failure, so this triggers a genuine fresh fetch.
  function retryLoad() {
    setStatus({ loading: true, count: 0, error: null, stale: false })
    fetchSatellites()
      .then(({ sats, stale }) => {
        satsRef.current = sats
        setStatus({ loading: false, count: sats.length, error: null, stale })
        setSatsLoaded(true)
      })
      .catch((err) => {
        setStatus({ loading: false, count: 0, error: err.message, stale: false })
        showLoadError()
      })
  }

  // On a phone the error and its Retry button sit inside the sheet, so pull
  // the sheet up rather than leave an empty globe with no explanation.
  function showLoadError() {
    setTab('sat')
    setSheetOpen(true)
  }

  // Tapping a tab opens the sheet on that panel; tapping the tab that is
  // already showing puts the sheet away again.
  function onTabClick(next) {
    if (sheetOpen && tab === next) {
      setSheetOpen(false)
      return
    }
    setTab(next)
    setSheetOpen(true)
  }

  function selectSat(idx, { fly = true } = {}) {
    setSelectedIdx(idx)
    if (!fly || !globeEl.current) return
    const sat = satsRef.current[idx]
    const geo = sat && geodeticNow(sat.satrec)
    if (geo) {
      globeEl.current.controls().autoRotate = false
      globeEl.current.pointOfView({ lat: geo.lat, lng: geo.lng, altitude: 1.8 }, 1000)
    }
  }

  function onSearchSubmit(e) {
    e.preventDefault()
    const q = search.trim().toLowerCase()
    if (!q) return
    const idx = satsRef.current.findIndex((s) => s.name.toLowerCase().includes(q))
    if (idx >= 0) selectSat(idx)
  }

  async function onLocationSubmit(e) {
    e.preventDefault()
    const q = locInput.trim()
    if (!q) return
    setLocMsg('Searching…')
    try {
      const place = await geocode(q)
      if (!place) {
        setLocMsg(`Couldn't find "${q}".`)
        return
      }
      setObserver(place)
      setLocInput('')
      setLocMsg(null)
    } catch {
      setLocMsg('Location lookup failed.')
    }
  }

  // Instant, exact observer from the curated capitals list (no geocoding round-trip).
  function onCapitalPick(e) {
    const v = e.target.value
    if (!v) return
    const [lat, lon, label] = v.split('|')
    setObserver({ lat: Number(lat), lon: Number(lon), label })
    setLocInput('')
    setLocMsg(null)
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setLocMsg('Geolocation not available in this browser.')
      return
    }
    setLocMsg('Locating…')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setObserver({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          label: 'My location',
        })
        setLocMsg(null)
      },
      () => setLocMsg('Location permission denied.'),
      { timeout: 10000 },
    )
  }

  // Virality hook: share the next visible pass as "Look up from <city>…".
  async function sharePass() {
    if (!observer || !readout) return
    const nextVisible = passes.find((p) => p.visible) || passes[0]
    if (!nextVisible) return
    const text = buildShareText({
      sat: readout.name,
      place: observer.label,
      pass: nextVisible,
    })
    const url = buildShareUrl({ observer, sat: readout.name, pass: nextVisible })
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Satellite Tracker', text, url })
        setShareMsg(null)
      } else {
        await navigator.clipboard.writeText(`${text} ${url}`)
        setShareMsg('Copied to clipboard!')
        setTimeout(() => setShareMsg(null), 2500)
      }
    } catch {
      /* user cancelled the share sheet — no-op */
    }
  }

  // Free hook: drop every predicted pass for the selected satellite into the
  // visitor's own calendar app, 15-minute reminder included.
  function addToCalendar() {
    if (!observer || !readout || !passes.length) return
    const ics = buildIcsForPasses({ passes, satName: readout.name, place: observer.label })
    const safeName = readout.name.replace(/[^\w-]+/g, '-')
    downloadIcs(`${safeName}-passes.ics`, ics)
  }

  // One-time globe setup: slow auto-rotate, zoom limit, opening camera
  // position, and the `globeReady` switch every layer above waits for.
  //
  // It needs two things that arrive in either order. react-globe.gl starts
  // downloading the Earth picture while React is still rendering this page,
  // and calls onGlobeReady when the picture is in. React, meanwhile, can hold
  // a freshly loaded page back for a moment before putting it on screen (it
  // does this after showing a "Loading…" state). If the picture wins that
  // race, which it does whenever it is already in the browser's cache,
  // onGlobeReady runs before `globeEl` points at anything. That used to throw,
  // and because the library only ever calls onGlobeReady once, the globe then
  // sat still with no satellites on it for the whole visit. So: remember that
  // the picture is in, and run the setup from whichever of the two happens
  // last.
  function startGlobe() {
    const globe = globeEl.current
    if (!globe || !earthLoadedRef.current || globeStartedRef.current) return
    globeStartedRef.current = true
    const controls = globe.controls()
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.35
    controls.minDistance = 105 // let visitors push in almost to the surface
    // closer, more immersive default framing, pulled back on tall screens
    // just far enough that the Earth is not cropped at the sides
    globe.pointOfView({
      altitude: framingAltitude(globe.camera(), window.innerWidth, window.innerHeight),
    })
    setGlobeReady(true)
  }

  const onGlobeReady = () => {
    earthLoadedRef.current = true
    startGlobe()
  }

  // the other half of the race described above: the page is now on screen
  useEffect(() => {
    startGlobe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const nextPass = passes.find((p) => p.peak.getTime() > now) || null
  const satTabNote = status.error
    ? 'Could not load'
    : readout
      ? readout.name
      : status.loading
        ? 'Loading…'
        : `${status.count.toLocaleString()} tracked`
  const passTabNote = !observer
    ? 'Set your city'
    : nextPass
      ? `Next ${relTime(nextPass.peak, now)}`
      : passes.length
        ? 'Overhead now'
        : 'None in 48 h'

  return (
    <div className="app">
      <Globe
        ref={globeEl}
        width={size.w}
        height={size.h}
        onGlobeReady={onGlobeReady}
        globeImageUrl="//unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
        globeMaterial={dayNightMaterial || undefined}
        backgroundImageUrl="//unpkg.com/three-globe/example/img/night-sky.png"
        showAtmosphere={true}
        atmosphereColor="#3fa9f5"
        atmosphereAltitude={0.28}
        pointsData={readout ? [readout] : []}
        pointsMerge={false}
        pointLat="lat"
        pointLng="lng"
        pointAltitude={(d) => d.alt / EARTH_RADIUS_KM}
        pointRadius={0.5}
        pointColor={() => '#00e5ff'}
        pointLabel={(d) => d.name}
        pathsData={orbitPath.length ? [orbitPath] : []}
        pathPoints={(p) => p}
        pathPointLat="lat"
        pathPointLng="lng"
        pathPointAlt="alt"
        pathColor={() => '#00e5ff'}
        pathStroke={0.6}
        pathDashLength={0.35}
        pathDashGap={0.18}
        pathDashAnimateTime={4500}
        pathTransitionDuration={0}
      />

      <div className={sheetOpen ? 'panels is-open' : 'panels'} data-tab={tab}>
        {/* Phone-only tab bar; hidden on desktop, where both panels always show. */}
        <div className="sheet-bar">
          <div className="sheet-tabs" role="tablist" aria-label="Globe panels">
            <button
              type="button"
              role="tab"
              id="tab-sat"
              aria-controls="panel-sat"
              aria-selected={sheetOpen && tab === 'sat'}
              className="sheet-tab"
              onClick={() => onTabClick('sat')}
            >
              <span className="sheet-tab-title">Satellite</span>
              <span className="sheet-tab-note">{satTabNote}</span>
            </button>
            <button
              type="button"
              role="tab"
              id="tab-passes"
              aria-controls="panel-passes"
              aria-selected={sheetOpen && tab === 'passes'}
              className="sheet-tab"
              onClick={() => onTabClick('passes')}
            >
              <span className="sheet-tab-title">Passes</span>
              <span className="sheet-tab-note">{passTabNote}</span>
            </button>
          </div>
          <button
            type="button"
            className="sheet-toggle"
            aria-expanded={sheetOpen}
            aria-label={sheetOpen ? 'Hide panel' : 'Show panel'}
            onClick={() => setSheetOpen((open) => !open)}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path
                d="M6 15l6-6 6 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <div className="sheet-body">
          <div className="hud" id="panel-sat">
            <h1>Satellite Tracker</h1>

            <form onSubmit={onSearchSubmit} className="search">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search: STARLINK, ISS, HUBBLE…"
                aria-label="Search satellites by name"
              />
            </form>

            {status.loading && <p className="muted">Loading catalogue…</p>}
            {status.error && (
              <div className="load-err">
                <p className="err">
                  {status.error.includes('403')
                    ? 'CelesTrak is rate-limiting new data right now — this usually clears within a few minutes.'
                    : `Couldn't load satellites: ${status.error}`}
                </p>
                <button type="button" className="retry-btn" onClick={retryLoad}>
                  Retry
                </button>
              </div>
            )}
            {!status.loading && !status.error && (
              <p className="muted">
                {status.count.toLocaleString()} satellites tracked
                {status.stale && ' · showing saved data'}
              </p>
            )}

            {readout && (
              <div className="sel">
                <div className="sel-name">{readout.name}</div>
                <dl>
                  <div>
                    <dt>Lat</dt>
                    <dd>{readout.lat.toFixed(2)}°</dd>
                  </div>
                  <div>
                    <dt>Lon</dt>
                    <dd>{readout.lng.toFixed(2)}°</dd>
                  </div>
                  <div>
                    <dt>Alt</dt>
                    <dd>{readout.alt.toFixed(0)} km</dd>
                  </div>
                  {readout.speed != null && (
                    <div>
                      <dt>Speed</dt>
                      <dd>{readout.speed.toFixed(2)} km/s</dd>
                    </div>
                  )}
                  {readout.rel && readout.rel.elevationDeg >= 0 && (
                    <>
                      <div>
                        <dt>Range</dt>
                        <dd>{Math.round(readout.rel.rangeKm).toLocaleString()} km</dd>
                      </div>
                      <div>
                        <dt>Elevation</dt>
                        <dd>{readout.rel.elevationDeg.toFixed(0)}° up</dd>
                      </div>
                    </>
                  )}
                  {readout.rel && readout.rel.elevationDeg < 0 && (
                    <div>
                      <dt>Overhead</dt>
                      <dd>below horizon</dd>
                    </div>
                  )}
                </dl>
              </div>
            )}
          </div>

          <div className="passes" id="panel-passes">
            <h2>Overhead passes</h2>

            <form onSubmit={onLocationSubmit} className="loc">
              <input
                value={locInput}
                onChange={(e) => setLocInput(e.target.value)}
                placeholder="Your city…"
                aria-label="Your city"
              />
              <button
                type="button"
                onClick={useMyLocation}
                title="Use my location"
                aria-label="Use my location"
              >
                📍
              </button>
            </form>

            <select
              className="capital-select"
              value=""
              onChange={onCapitalPick}
              aria-label="Jump to a capital city"
            >
              <option value="" disabled>
                Or jump to a capital…
              </option>
              {CONTINENTS.map((cont) => (
                <optgroup key={cont} label={cont}>
                  {CAPITALS[cont].map((c) => (
                    <option
                      key={`${c.city}|${c.country}`}
                      value={`${c.lat}|${c.lon}|${c.city}, ${c.country}`}
                    >
                      {c.city} · {c.country}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            {locMsg && <p className="muted">{locMsg}</p>}
            {observer && (
              <p className="loc-label">
                {readout ? <strong>{readout.name}</strong> : 'Satellite'} over{' '}
                <strong>{observer.label}</strong> · next 48 h
              </p>
            )}

            {observer && passesMsg && <p className="muted">{passesMsg}</p>}
            {!observer && (
              <p className="muted">
                Enter a city to see when {readout?.name || 'the selected satellite'} flies overhead —
                and which passes are bright enough to spot with the naked eye.
              </p>
            )}

            {observer && passes.length > 0 && (
              <>
                <ul className="pass-list">
                  {passes.map((p, i) => (
                    <li key={i} className={p.visible ? 'vis' : ''}>
                      <div className="row1">
                        <span className="when">{fmtWhen(p.peak)}</span>
                        <span className="rel">{relTime(p.peak, now)}</span>
                      </div>
                      <div className="row2">
                        <span>
                          max {p.peakElevation.toFixed(0)}° to the {p.peakDir}
                        </span>
                        <span>{fmtDur(p.durationSec)}</span>
                      </div>
                      {p.visible && <span className="badge">★ visible to the eye</span>}
                    </li>
                  ))}
                </ul>
                <div className="pass-actions">
                  <button type="button" className="share-btn" onClick={sharePass}>
                    {shareMsg || 'Share this pass ↗'}
                  </button>
                  <button type="button" className="ics-btn" onClick={addToCalendar}>
                    Add to calendar 📅
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
