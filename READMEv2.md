# ZeroSkybox-JSX V2

A procedurally deterministic dynamic skybox for React + Three.js applications, built on the **ZeroBytes** and **Zero-Temporal** methodology. Version 2 extends the original with a physically correct pole-axis celestial rotation model, observer latitude, ZeroBytes-driven constellation catalogue, ecliptic-plane planets with Kepler orbital mechanics, Milky Way band, star twinkle, and atmospheric extinction — all with **zero stored state** and **O(1) access to any point in time**.

> V1 (`ZeroSkybox.jsx` / `demo.html`) remains unchanged and is fully supported. V2 is a superset — every V1 feature is present and the API is additive.

---

## What Changed in V2

### The core visual problem V1 had

V1 applied sidereal rotation as a flat azimuth offset — the equivalent of spinning a map around its centre point. This rotated everything around the **zenith** (straight up), meaning there was no fixed pole star and stars near the horizon swept in unrealistically large arcs rather than the tight circles seen in real time-lapse photography of the night sky.

### The fix: pole-axis rotation

V2 stores every star, constellation star, and planet as a `THREE.Vector3` unit vector in catalogue space. Each frame a single `THREE.Quaternion` is built around the true celestial pole axis — `(0, sin(latitude), cos(latitude))` — and applied to every direction vector before SVG projection. The pole star sits exactly at the tip of this axis and never moves. Stars near the pole trace tight circles; stars near the horizon trace wide shallow arcs. This matches real sky behaviour exactly.

### Complete list of V2 additions

| Feature | What it does |
|---|---|
| **Pole-axis rotation** | Stars rotate around `(0, sin(lat), cos(lat))`, not the zenith |
| **Observer latitude** | New `latitude` prop (degrees). Controls pole elevation and circumpolar visibility |
| **Named polestar** | Fixed ZeroBytes star at the pole axis tip, world-seed-derived name |
| **Star twinkle** | Per-star frequency + phase from `positionHash`; amplitude scales with horizon proximity; planets exempt |
| **Atmospheric extinction** | Stars and planets fade toward the horizon via `pow(elevation, 0.35)` |
| **Milky Way band** | Diffuse great-circle arc on SVG layer, rotates with stars, brightness variation per seed |
| **Ecliptic-plane planets** | Planets orbit in the ecliptic (~23.4° tilted), following the realistic sun/moon path band |
| **Constellation orientation** | Emerges naturally from 3-D vector rotation — constellations rise on their side and stand upright at meridian |
| **SVG element pooling** | Background star elements pre-allocated; no per-frame DOM node creation |
| **Face North camera mode** | Camera points directly at the polestar |

---

## Features

- **Fully deterministic** — same `worldSeed` + same `epoch` + same `latitude` produces identical sky on every machine, every session, forever
- **Physically correct rotation** — pole-axis quaternion rotation; stars circle the pole as in real time-lapse sky photography
- **Day/night cycle** — smooth gradient from midnight through dawn, solar noon and dusk
- **Seasonal colour** — warm summer sky palette vs cool blue winter tones, driven by year phase
- **Procedural clouds + storms** — ZeroTemporal hashes change per day-block and week-block
- **Moon phases** — full 29-day lunar cycle with SVG crescent clip
- **650 background stars** — tiny, uniformly distributed over the celestial sphere, ZeroBytes seeded
- **8 procedural constellations** — spanning-chain + cross-link edges, name labels, fade with dawn
- **Named polestar** — world-seed-derived name, never moves, subtle glow ring
- **5 planets on ecliptic** — Mercury, Venus, Mars, Jupiter, Saturn with Kepler orbits; Saturn has SVG ring
- **Milky Way** — diffuse band along galactic equator great circle
- **Star twinkle** — ZeroTemporal sine oscillation per star, more at horizon
- **Atmospheric extinction** — stars and planets dim naturally near the horizon
- **O(1) historical and future queries** — `getSkyState(anyEpoch, ...)` is pure computation, no replay
- **No GLSL** — sky dome is `CanvasTexture` (Canvas2D gradients); SVG overlay for all celestials
- **No external dependencies** — only `react` and `three` as peer deps

---

## Architecture

ZeroSkyboxV2 uses three ZeroBytes principles layered together. Understanding which layer drives which property is the key to adapting the system.

### Layer 1 — ZeroBytes (static, position-is-seed)

Computed once at catalogue build time. Changing `worldSeed` regenerates everything. The same seed always produces the same catalogue on every machine.

```
positionHash(x, y, z, salt) → uint32
hashToFloat(uint32) → [0, 1)
```

Every property in this layer has a **dedicated salt namespace** so systems never produce correlated outputs:

| System | Hash inputs | Salt |
|---|---|---|
| Background star position (az, el) | `posHash(i, 10..14, 0, seed+1111)` | `+1111` |
| Background star brightness, colour, radius | same block | `+1111` |
| Constellation centroid position, spread | `posHash(ci, 0..4, 0, seed+5555)` | `+5555` |
| Constellation star offsets, brightness, size | `posHash(ci, si, 1..5, seed+5555)` | `+5555` |
| Constellation edge cross-links | `posHash(ci, 5..8, 0, seed+5555)` | `+5555` |
| Polestar name selection | `posHash(0, 0, 0, seed+6666)` | `+6666` |
| Planet period, phase, inclination, node, eccentricity | `posHash(i, 0..4, 0, seed+8888)` | `+8888` |
| Milky Way brightness + width variation | `posHash(i, 0..1, 0, seed+3333)` | `+3333` |
| Star twinkle frequency + phase offset | `posHash(i, 0..1, 9, seed+4444)` | `+4444` |

The polestar is a special case — its position is derived geometrically from `latitude`, not hashed, but its name comes from `posHash`. This is intentional: the pole axis is a physical fact, not a random property.

### Layer 2 — Zero-Temporal (stochastic, coordinate+epoch-is-seed)

Time-varying but fully O(1). Same region + same epoch always produces the same weather. Epoch is **always a world integer tick**, never wall-clock time.

```
temporalHash(x, y, z, epoch, salt) → uint32
```

| Property | Hash call | Epoch granularity |
|---|---|---|
| Cloud cover | `tempHash(rx, ry, 0, dayIndex, seed+100)` | per day |
| Storm probability | `tempHash(rx>>2, ry>>2, 0, weekIndex, seed+200)` | per week |
| Cloud UV drift | `tempHash(rx, ry, 1, 4hrBlock, seed+300)` | per 4 hours |
| Star twinkle modulation | `sin(epoch * freq + phase)` using freq/phase from ZeroBytes | continuous |

The regional chunking (`rx>>2` for storms) means large weather systems are spatially coherent across adjacent regions — a storm that starts in region (4,4) also affects (5,4) — exactly as the ZeroBytes Spatial-Temporal Hierarchy principle prescribes.

### Layer 3 — Cyclic (pure math, no hash)

Periodic properties are encoded as `sin/cos` of epoch — zero bytes, zero hash, O(1):

| Property | Formula |
|---|---|
| Sun elevation | `sin((dayPhase - 0.25) * 2π)` |
| Moon elevation | `sin((dayPhase + 0.25) * 2π)` |
| Seasonal warmth | `sin(yearPhase * 2π)` |
| Lunar phase | `(epoch % 29days) / 29days` |
| Sidereal rotation angle | `epoch / (tpd * 0.9973) * 2π` |
| Planet mean anomaly | `(epoch / period) * 2π + phase0` |

The sidereal factor `0.9973` is the ratio of a sidereal day to a solar day — the star sphere completes one extra rotation per year relative to the sun, which is what causes seasonal constellation drift.

### Pole-axis rotation in detail

```js
// Pole vector points at celestial north pole at observer's latitude
const poleAxis = new THREE.Vector3(0, Math.sin(latRad), Math.cos(latRad));

// Single quaternion built once per frame from current sidereal angle
const poleQ = new THREE.Quaternion().setFromAxisAngle(poleAxis, siderealAngle);

// Applied to every star, constellation star, planet, and Milky Way point
const rotatedDir = catalogueVector.clone().applyQuaternion(poleQ);
```

At `latitude = 90°` the pole is straight overhead and all stars circle the zenith. At `latitude = 0°` the pole is on the horizon and stars rise and set vertically. At `latitude = 51.5°` (default, Bristol) the pole sits 51.5° above the north horizon — Polaris never sets, Orion rises in the southeast.

### Rendering strategy

The rendering approach is unchanged from V1 — deliberately avoiding GLSL fragility:

- **Sky dome** — `THREE.SphereGeometry` hemisphere with `THREE.CanvasTexture` (Canvas2D gradients) redrawn each tick. Works on every WebGL implementation.
- **SVG overlay** — all celestials (stars, constellations, polestar, planets, Milky Way, sun, moon) are SVG elements. World directions are projected via `vector.project(camera)` → NDC → pixel coordinates.
- **Lighting** — `DirectionalLight` position and intensity driven by `getSkyState()` each frame.

---

## Quick Start

```bash
# No extra dependencies beyond react and three
npm install three
```

Copy `ZeroSkyboxV2.jsx` into your project:

```jsx
import { useState, useRef, useEffect } from 'react';
import * as THREE from 'three';
import ZeroSkyboxV2, { ZeroSkyboxV2SVG, epochFromRealTime } from './ZeroSkyboxV2';

export default function MyScene() {
  const [scene]  = useState(() => new THREE.Scene());
  const [camera] = useState(() => new THREE.PerspectiveCamera(70, innerWidth/innerHeight, 1, 30000));
  const [epoch, setEpoch] = useState(0);
  const startRef = useRef({ epoch: 60, time: performance.now() });

  useEffect(() => {
    const id = requestAnimationFrame(function tick(now) {
      setEpoch(epochFromRealTime(startRef.current.epoch, startRef.current.time, now, 60));
      requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <>
      {/* Three.js canvas ... */}
      <ZeroSkyboxV2
        scene={scene}
        worldSeed={1337}
        epoch={epoch}
        ticksPerDay={240}
        ticksPerYear={87600}
        regionX={0}
        regionY={0}
      />
      <ZeroSkyboxV2SVG
        camera={camera}
        worldSeed={1337}
        epoch={epoch}
        ticksPerDay={240}
        ticksPerYear={87600}
        latitude={51.5}
      />
    </>
  );
}
```

---

## Components

### `ZeroSkyboxV2`

Manages the canvas-textured hemisphere dome. API is identical to V1 `ZeroSkybox`.

| Prop | Type | Default | Description |
|---|---|---|---|
| `scene` | `THREE.Scene` | required | Scene to add the dome to |
| `worldSeed` | `number` | `1337` | Master integer seed |
| `epoch` | `number` | `0` | Current world integer tick |
| `ticksPerDay` | `number` | `240` | Ticks per in-game day |
| `ticksPerYear` | `number` | `87600` | Ticks per in-game year |
| `regionX` | `number` | `0` | Region grid X for stochastic weather |
| `regionY` | `number` | `0` | Region grid Y for stochastic weather |
| `radius` | `number` | `10000` | Dome sphere radius |
| `onSkyState` | `function` | `null` | Callback `(skyState) => void` fired each update |

### `ZeroSkyboxV2SVG`

SVG overlay with full V2 celestial features. New props over V1 are `latitude`, `showConstellationNames`, `showPlanetNames`, and `showMilkyWay`.

| Prop | Type | Default | Description |
|---|---|---|---|
| `camera` | `THREE.Camera` | required | Must have `updateMatrixWorld` called before render |
| `worldSeed` | `number` | `1337` | |
| `epoch` | `number` | `0` | |
| `ticksPerDay` | `number` | `240` | |
| `ticksPerYear` | `number` | `87600` | |
| `regionX` | `number` | `0` | |
| `regionY` | `number` | `0` | |
| `latitude` | `number` | `51.5` | Observer latitude in degrees. Controls pole elevation and circumpolar stars |
| `width` | `number` | `window.innerWidth` | Viewport width in px |
| `height` | `number` | `window.innerHeight` | Viewport height in px |
| `showConstellationNames` | `boolean` | `true` | Toggle constellation name labels |
| `showPlanetNames` | `boolean` | `true` | Toggle planet name labels |
| `showMilkyWay` | `boolean` | `true` | Toggle Milky Way band |

---

## Exported Utilities

```js
import {
  // Sky state
  getSkyState,            // Full deterministic sky at any epoch — O(1)

  // Celestial mechanics
  siderealAngle,          // Rotation angle at epoch
  poleRotation,           // THREE.Quaternion around pole axis
  rotateStar,             // Apply pole quaternion to a catalogue vector
  getPlanetVectors,       // Kepler planet positions at epoch as Vector3[]
  azElToVec3,             // Az + elevation-as-sin → THREE.Vector3

  // Catalogues (built once, reused every frame)
  buildBackgroundStars,   // 650 ZeroBytes background stars
  buildConstellations,    // 8 ZeroBytes constellations with edges
  buildPolestar,          // Pole-fixed named star
  buildPlanets,           // ZeroBytes planet orbital parameters
  buildMilkyWayPoints,    // 80-point galactic equator band

  // Projection
  projectDir,             // World direction → screen {x,y} or null

  // Hash kernel (exposed for host app use)
  positionHash,           // ZeroBytes core — position → uint32
  temporalHash,           // Zero-Temporal — position + epoch → uint32
  hashToFloat,            // uint32 → [0, 1)
  coherentValue,          // Bilinear coherent noise

  // Utilities
  epochFromRealTime,      // Derive stable epoch from performance.now() delta
} from './ZeroSkyboxV2';
```

---

## Adapting to Your Project

**Lighting integration** — `onSkyState` provides the full sky state each frame:

```jsx
<ZeroSkyboxV2
  scene={scene}
  epoch={epoch}
  worldSeed={seed}
  onSkyState={(sky) => {
    const d = Math.max(0, sky.sunEl);
    sunLight.intensity = d * 1.5 * (sky.storm ? 0.3 : 1.0);
    sunLight.color.setRGB(1.0, 0.7 + d * 0.3, 0.35 + d * 0.6);
    ambLight.intensity = 0.05 + d * 0.6;
  }}
/>
```

**Weather-aware gameplay** — query any epoch directly, zero replay:

```js
import { getSkyState } from './ZeroSkyboxV2';

function isStormy(worldTick, seed, rx, ry) {
  const sky = getSkyState(worldTick, seed, rx, ry, 240, 87600);
  return sky.storm && sky.cloudCover > 0.7;
}
```

**Latitude effects** — different latitudes give dramatically different sky behaviour:

```jsx
// Equatorial observer — pole on the horizon, all stars rise and set
<ZeroSkyboxV2SVG latitude={0} ... />

// Mid-latitude northern observer (default)
<ZeroSkyboxV2SVG latitude={51.5} ... />

// High arctic — pole nearly overhead, circumpolar stars dominate
<ZeroSkyboxV2SVG latitude={78} ... />

// Southern hemisphere — pole below horizon in north, southern sky dominates
<ZeroSkyboxV2SVG latitude={-33.9} ... />
```

**Historical queries** — the past is just a coordinate:

```js
// What did the sky look like 30 in-game days ago?
const pastSky = getSkyState(epoch - 30 * 240, seed, rx, ry, 240, 87600);

// What planets were visible at the start of the world?
const dawn    = getSkyState(0, seed, 0, 0, 240, 87600);
```

**Using planet positions for gameplay** — planets are real world-space vectors:

```js
import { buildPlanets, getPlanetVectors, poleRotation, siderealAngle } from './ZeroSkyboxV2';

const planets = buildPlanets(worldSeed, 87600);
const poleQ   = poleRotation(siderealAngle(epoch, 240), latitude * Math.PI / 180);
const vecs    = getPlanetVectors(planets, epoch, poleQ);

// vecs[2] is Mars — is it above the horizon?
const marsVisible = vecs[2].vec.y > 0;
```

---

## Epoch Design

The epoch tick size is a world design decision made once and never changed. V2 adds no new epoch concerns — the same rules apply:

| Tick size | Mapping |
|---|---|
| 1 tick = ~6s real time @ 60×speed | `ticksPerDay = 240` — 1 day every 24 real minutes |
| 1 tick = 1s real time @ 1×speed | Slow, contemplative world time |
| 1 tick = 1 game hour | Fine-grained NPC schedules and tidal detail |

**Never** pass `Date.now()` or `performance.now()` raw as the epoch. Always derive it from `epochFromRealTime()` which pins a `startEpoch` + `startTime` pair captured once.

---

## Files

| File | Purpose |
|---|---|
| `ZeroSkyboxV2.jsx` | V2 component — dome + full SVG overlay + all utilities |
| `demoV2.html` | Self-contained standalone demo (Three.js via CDN, no build step) |
| `ZeroSkybox.jsx` | V1 component — retained, unchanged, fully supported |
| `demo.html` | V1 standalone demo |

---

## Migrating from V1

The V2 API is fully additive. The minimum migration is a file rename and one new prop:

```diff
- import ZeroSkybox, { ZeroSkyboxSVG } from './ZeroSkybox';
+ import ZeroSkyboxV2, { ZeroSkyboxV2SVG } from './ZeroSkyboxV2';

- <ZeroSkybox   scene={scene}  ... />
+ <ZeroSkyboxV2 scene={scene}  ... />

- <ZeroSkyboxSVG   camera={camera} ... />
+ <ZeroSkyboxV2SVG camera={camera} latitude={51.5} ... />
```

All existing props carry over unchanged. The `latitude` prop defaults to `51.5` so northern mid-latitude behaviour is the baseline. Set it to match your world's geography.

---

## Browser Compatibility

Works in any browser with WebGL support. No GLSL custom shaders are used in either V1 or V2. The sky texture is Canvas2D, the celestial overlay is SVG 1.1, and the rotation system uses standard Three.js `Quaternion` — all universally supported.

---

## 📚 Citation

### Academic Citation

If you use this codebase in your research or project, please cite:

```bibtex
@software{ZeroSkybox_JSX,
  title = {ZeroSkybox JSX: Procedurally Deterministic Dynamic Skybox for React Three.js},
  author = {[Drift Johnson]},
  year = {2025},
  url = {https://github.com/MushroomFleet/ZeroSkybox-JSX},
  version = {2.0.0}
}
```

### Donate:

[![Ko-Fi](https://cdn.ko-fi.com/cdn/kofi3.png?v=3)](https://ko-fi.com/driftjohnson)
