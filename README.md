# ZeroSkybox-JSX

A procedurally deterministic dynamic skybox for React + Three.js applications, built on the **ZeroBytes** and **Zero-Temporal** methodology. Drop it into any React Three.js scene and get a fully animated sky — day/night cycle, seasonal colour shifts, cloud cover, moon phases, storm events, and a projected SVG sun/moon/star overlay — with **zero stored state** and **O(1) access to any point in time**.

Live Demo: [https://scuffedepoch.com/zero-skybox/](https://scuffedepoch.com/zero-skybox/)

---

## ✨ Features

- **Fully deterministic** — same `worldSeed` + same `epoch` produces identical sky on every machine, every session, forever
- **Day/night cycle** — smooth gradient transitions through midnight, dawn, solar noon and dusk driven by cyclic `sin` of epoch
- **Seasonal colour** — zenith and horizon palette shifts between warm summer blues and cool winter tones
- **Procedural clouds** — cloud cover and storm probability derived from ZeroTemporal hashes, changing per day-block and week-block
- **Moon phases** — full 29-day lunar cycle with a real SVG crescent clip, no texture required
- **Star field** — 220+ deterministic stars from `positionHash`, projected to screen space as SVG circles with colour temperature variation
- **O(1) historical queries** — call `getSkyState(pastEpoch, seed, ...)` to reconstruct any past or future sky without replay or logs
- **No GLSL fragility** — sky dome uses a `CanvasTexture` (2D canvas gradient) rather than a custom fragment shader, so it works reliably across all Three.js versions and WebGL implementations
- **Lightweight** — no external dependencies beyond `react` and `three`

---

## 📐 Architecture

ZeroSkybox is built on two ZeroBytes principles:

### ZeroBytes — position is the seed
Static properties (star positions, regional moisture baseline) are computed once from `positionHash(x, y, z, worldSeed)`. No star map texture, no stored catalogue — the catalogue re-emerges from the seed on demand.

### Zero-Temporal — coordinate + epoch is the seed
Time-varying properties are computed from `temporalHash(x, y, z, epoch, worldSeed)`. The epoch is a **world-defined integer tick**, never wall-clock time, which means:

- The past is not a log — query epoch 0 after epoch 10,000 and you get the same result
- The future is not a simulation — jump to any epoch in O(1)
- Determinism is guaranteed across machines and execution orders

### Three rendering layers

| Layer | Mechanism | Drives |
|---|---|---|
| **Static** (ZeroBytes) | `positionHash(starIndex, seed)` | Star positions, regional moisture |
| **Cyclic** (Zero-Temporal) | `sin/cos` of `epoch % period` | Sun/moon arc, season, lunar phase |
| **Stochastic** (Zero-Temporal) | `temporalHash(region, dayIndex, seed)` | Cloud cover (per day-block), storm events (per week-block) |

### Rendering strategy

- **Sky dome** — a `THREE.SphereGeometry` hemisphere with a `THREE.CanvasTexture` redrawn each tick via `Canvas2D` linear and radial gradients. No custom GLSL.
- **Celestial overlay** — sun, moon and stars are SVG elements positioned by projecting world-direction vectors through the Three.js camera (`vector.project(camera)` → NDC → pixel coordinates). The sun disc colour shifts from orange at the horizon to white at zenith. The moon crescent is a real SVG ellipse clip animated by lunar phase.
- **Lighting** — `DirectionalLight` intensity and colour are driven by `getSkyState()` each frame, so scene geometry reacts correctly to time of day.

---

## 🚀 Quick Start

```bash
# No extra dependencies — requires react and three as peer deps
npm install three
```

Copy `ZeroSkybox.jsx` into your project, then:

```jsx
import { useRef, useState, useEffect } from 'react';
import * as THREE from 'three';
import ZeroSkybox, { ZeroSkyboxSVG, epochFromRealTime } from './ZeroSkybox';

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
      <ZeroSkybox
        scene={scene}
        worldSeed={1337}
        epoch={epoch}
        ticksPerDay={240}
        ticksPerYear={87600}
        regionX={0}
        regionY={0}
      />
      <ZeroSkyboxSVG
        camera={camera}
        worldSeed={1337}
        epoch={epoch}
        ticksPerDay={240}
        ticksPerYear={87600}
      />
    </>
  );
}
```

---

## 🧩 Components

### `ZeroSkybox`

Manages a canvas-textured hemisphere dome inside a Three.js scene. Renders nothing to the DOM.

| Prop | Type | Default | Description |
|---|---|---|---|
| `scene` | `THREE.Scene` | required | Scene to add the dome to |
| `worldSeed` | `number` | `1337` | Master integer seed for the world |
| `epoch` | `number` | `0` | Current world integer tick |
| `ticksPerDay` | `number` | `240` | How many ticks = 1 in-game day |
| `ticksPerYear` | `number` | `87600` | How many ticks = 1 in-game year |
| `regionX` | `number` | `0` | Region grid X for stochastic weather |
| `regionY` | `number` | `0` | Region grid Y for stochastic weather |
| `radius` | `number` | `10000` | Dome sphere radius |
| `onSkyState` | `function` | `null` | Callback `(skyState) => void` fired each update |

### `ZeroSkyboxSVG`

Absolutely-positioned SVG overlay rendering the sun, moon and stars projected to screen space. Place as a sibling of your Three.js canvas.

| Prop | Type | Default | Description |
|---|---|---|---|
| `camera` | `THREE.Camera` | required | Must have `updateMatrixWorld` called before render |
| `worldSeed` | `number` | `1337` | |
| `epoch` | `number` | `0` | |
| `ticksPerDay` | `number` | `240` | |
| `ticksPerYear` | `number` | `87600` | |
| `regionX` | `number` | `0` | |
| `regionY` | `number` | `0` | |
| `width` | `number` | `window.innerWidth` | Viewport width in px |
| `height` | `number` | `window.innerHeight` | Viewport height in px |

---

## 🛠 Exported Utilities

```js
import {
  getSkyState,          // Compute sky state at any epoch — O(1)
  buildStarCatalogue,   // Generate deterministic star catalogue from seed
  dirFromAzimuthElevation, // Azimuth + elevation → THREE.Vector3
  projectDirection,     // World direction → screen {x,y} or null
  epochFromRealTime,    // Derive world epoch from performance.now() delta
  positionHash,         // ZeroBytes core hash
  temporalHash,         // Zero-Temporal extension hash
  hashToFloat,          // uint32 → [0,1)
  coherentValue,        // Bilinear coherent noise
} from './ZeroSkybox';
```

### `getSkyState(epoch, worldSeed, regionX, regionY, ticksPerDay, ticksPerYear)`

Returns the full deterministic sky state at the given epoch. Use this to drive lighting, audio, gameplay weather checks, or any system that needs to know what the sky is doing at a given moment — including past or future epochs.

```js
const sky = getSkyState(epoch, seed, 0, 0, 240, 87600);
// sky.sunEl        — sun elevation [-1, 1]
// sky.cloudCover   — [0, 1]
// sky.storm        — boolean
// sky.moonPh       — lunar phase [0, 1]
// sky.season       — seasonal warmth [-1, 1]
// sky.dayPh        — time of day [0, 1]
```

### `epochFromRealTime(startEpoch, startTime, nowTime, ticksPerRealSecond)`

Derive a stable world epoch from a real-time clock. Capture `startEpoch` and `startTime = performance.now()` once; call each frame with the current `performance.now()`.

```js
// 60 world ticks per real second = 1 in-game day (240 ticks) every 4 real seconds
const epoch = epochFromRealTime(0, startTime, performance.now(), 60);
```

---

## ⚙️ Epoch Design

The epoch tick size is a world design decision made once and never changed.

| Tick size | Example mapping |
|---|---|
| 1 tick = ~6s real time @ 60×speed | `ticksPerDay = 240` (1 day = 24 min real) |
| 1 tick = 1s real time @ 1×speed | Slow, contemplative world time |
| 1 tick = 1 game hour | NPC schedules, tidal detail |

**Never** pass `Date.now()` or `performance.now()` directly as the epoch. Always go through `epochFromRealTime()` or an equivalent world clock that pins the start point.

---

## 🔧 Adapting to Your Project

**Lighting integration** — use `onSkyState` to drive your scene lights:

```jsx
<ZeroSkybox
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

**Weather-aware gameplay** — query the sky state anywhere without touching components:

```js
import { getSkyState } from './ZeroSkybox';

function shouldSpawnRain(worldTick, seed) {
  const sky = getSkyState(worldTick, seed, playerRegionX, playerRegionY, 240, 87600);
  return sky.storm && sky.cloudCover > 0.7;
}
```

**Different regions** — change `regionX` / `regionY` to get a different stochastic weather pattern for each area of your world, with the same deterministic guarantee:

```js
// Two regions can have different weather at the same epoch
const forestSky  = getSkyState(epoch, seed, 2,  5,  240, 87600);
const desertSky  = getSkyState(epoch, seed, 14, -3, 240, 87600);
```

**Historical queries** — the past is just a different coordinate:

```js
// What did the sky look like 30 in-game days ago?
const pastSky = getSkyState(epoch - 30 * 240, seed, rx, ry, 240, 87600);
```

---

## 📁 Files

| File | Purpose |
|---|---|
| `ZeroSkybox.jsx` | Main component — dome + SVG overlay + all utilities |
| `demo.html` | Self-contained standalone demo (Three.js via CDN, no build step) |

---

## 🌐 Browser Compatibility

Works in any browser with WebGL support. No GLSL custom shaders are used — the sky texture is rendered via `Canvas2D` API, which has universal support. The SVG overlay uses standard `vector.project()` from Three.js and SVG 1.1 elements.

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
  version = {1.0.0}
}
```

### Donate:

[![Ko-Fi](https://cdn.ko-fi.com/cdn/kofi3.png?v=3)](https://ko-fi.com/driftjohnson)
