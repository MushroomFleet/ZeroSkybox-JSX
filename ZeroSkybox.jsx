/**
 * ZeroSkybox.jsx
 * Procedurally deterministic dynamic skybox for Vite/React/TypeScript + Three.js
 *
 * Architecture: ZeroBytes + Zero-Temporal
 *   Static  : star catalogue positions → posHash(i, seed)
 *   Cyclic  : sun/moon arc, seasons    → sin/cos of (epoch % period)
 *   Stochas : cloud cover, storm       → tempHash(rx, ry, dayIndex, seed)
 *
 * Rendering strategy (avoids GLSL fragility):
 *   - Sky dome : canvas 2D gradient texture on a hemisphere SphereGeometry
 *   - Sun/Moon : SVG elements projected to screen space by the host app
 *     (use the ZeroSkyboxSVG companion component, or call getSkyState + projectDir)
 *
 * Epoch contract: epoch is a world-defined integer tick. NEVER pass Date.now().
 *   Use epochFromRealTime() to derive a stable epoch from a real-time clock.
 *
 * Usage:
 *   // In your Three.js scene setup:
 *   <ZeroSkybox
 *     scene={threeScene}
 *     worldSeed={42}
 *     epoch={worldTick}
 *     ticksPerDay={240}
 *     ticksPerYear={87600}
 *     regionX={0}
 *     regionY={0}
 *   />
 *
 *   // For SVG celestial overlay (sun/moon/stars):
 *   <ZeroSkyboxSVG
 *     epoch={worldTick}
 *     worldSeed={42}
 *     ticksPerDay={240}
 *     ticksPerYear={87600}
 *     regionX={0}
 *     regionY={0}
 *     camera={threeCamera}
 *   />
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// § ZeroBytes / Zero-Temporal hash kernel
//   Wang hash cascade — pure JS, no deps, same output cross-platform.
// ─────────────────────────────────────────────────────────────────────────────

function wang(n) {
  n = ((n ^ 61) ^ (n >>> 16)) >>> 0;
  n = ((n + (n << 3)) >>> 0);
  n = ((n ^ (n >>> 4)) >>> 0);
  n = (Math.imul(n, 0x27d4eb2d) >>> 0);
  n = ((n ^ (n >>> 15)) >>> 0);
  return n >>> 0;
}

/** positionHash(x,y,z,salt) → uint32 — ZeroBytes core */
export function positionHash(x, y, z, salt = 0) {
  let h = wang((x & 0x7fffffff) >>> 0);
  h = wang((h ^ ((y & 0x7fffffff) >>> 0)) >>> 0);
  h = wang((h ^ ((z & 0x7fffffff) >>> 0)) >>> 0);
  h = wang((h ^ ((salt & 0x7fffffff) >>> 0)) >>> 0);
  return h >>> 0;
}

/** temporalHash(x,y,z,epoch,salt) → uint32 — Zero-Temporal extension */
export function temporalHash(x, y, z, epoch, salt = 0) {
  let h = positionHash(x, y, z, salt);
  h = wang((h ^ ((Math.abs(epoch) & 0x7fffffff) >>> 0)) >>> 0);
  return h >>> 0;
}

/** Map uint32 → [0,1) float */
export function hashToFloat(h) {
  return (h >>> 0) / 0x100000000;
}

/** Bilinear coherent noise at (fx,fy) → [-1,1] */
export function coherentValue(fx, fy, seed, octaves = 4) {
  let value = 0, amp = 1.0, freq = 1.0, maxAmp = 0.0;
  for (let i = 0; i < octaves; i++) {
    const x0 = Math.floor(fx * freq), y0 = Math.floor(fy * freq);
    let sx = (fx * freq) - x0; sx = sx * sx * (3 - 2 * sx);
    let sy = (fy * freq) - y0; sy = sy * sy * (3 - 2 * sy);
    const n00 = hashToFloat(positionHash(x0,   y0,   0, seed + i)) * 2 - 1;
    const n10 = hashToFloat(positionHash(x0+1, y0,   0, seed + i)) * 2 - 1;
    const n01 = hashToFloat(positionHash(x0,   y0+1, 0, seed + i)) * 2 - 1;
    const n11 = hashToFloat(positionHash(x0+1, y0+1, 0, seed + i)) * 2 - 1;
    value += amp * ((n00*(1-sx)+n10*sx)*(1-sy) + (n01*(1-sx)+n11*sx)*sy);
    maxAmp += amp; amp *= 0.5; freq *= 2.0;
  }
  return value / maxAmp;
}

// ─────────────────────────────────────────────────────────────────────────────
// § Sky State — pure, O(1), deterministic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the complete sky state at a given world epoch.
 * No stored state. Same inputs → same result on every machine.
 *
 * @returns SkyState {
 *   dayPh, yearPh, season,
 *   sunEl, sunAz, moonEl, moonAz,
 *   cloudCover, cloudOff, storm, moonPh
 * }
 */
export function getSkyState(epoch, worldSeed, regionX, regionY, ticksPerDay, ticksPerYear) {
  const ep = Math.floor(epoch);
  const dayPh  = (ep % ticksPerDay)  / ticksPerDay;
  const yearPh = (ep % ticksPerYear) / ticksPerYear;

  // sunEl: -1=midnight, +1=solar noon (peak at dayPh=0.5)
  const sunEl  = Math.sin((dayPh - 0.25) * Math.PI * 2);
  const sunAz  = dayPh * Math.PI * 2;
  const moonEl = Math.sin((dayPh + 0.25) * Math.PI * 2);
  const moonAz = (dayPh + 0.5) * Math.PI * 2;
  const season = Math.sin(yearPh * Math.PI * 2);    // +1=summer, -1=winter

  const dayIdx   = Math.floor(ep / ticksPerDay);
  const cloudSeed = temporalHash(regionX, regionY, 0, dayIdx, worldSeed + 100);
  const stormSeed = temporalHash((regionX >> 2) | 0, (regionY >> 2) | 0, 0,
                                  Math.floor(dayIdx / 7), worldSeed + 200);
  const cdetSeed  = temporalHash(regionX, regionY, 1,
                                  Math.floor(ep / (ticksPerDay / 6)) | 0, worldSeed + 300);
  const moisture  = (coherentValue(regionX * 0.1, regionY * 0.1, worldSeed + 500) + 1) * 0.5;
  const moonPh    = (ep % (ticksPerDay * 29)) / (ticksPerDay * 29);

  return {
    dayPh, yearPh, season,
    sunEl, sunAz, moonEl, moonAz,
    cloudCover: hashToFloat(cloudSeed),
    cloudOff:   hashToFloat(cdetSeed),
    storm:      hashToFloat(stormSeed) > 0.85 && moisture > 0.4,
    moonPh,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// § Canvas sky texture helpers
// ─────────────────────────────────────────────────────────────────────────────

const SKY_W = 512, SKY_H = 512;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function lerp3(a, b, t) { return [lerp(a[0],b[0],t), lerp(a[1],b[1],t), lerp(a[2],b[2],t)]; }

function drawSkyToCanvas(ctx, skyState) {
  const { sunEl, season, cloudCover, cloudOff, storm } = skyState;
  const t     = clamp((sunEl + 1) / 2, 0, 1);
  const twil  = Math.max(0, 1 - Math.abs(sunEl) * 5);

  // Colour palette stops: [zenith, upper, horizon, sub-horizon] → [r,g,b]
  const night = [[3,4,18],   [5,7,28],      [10,14,36],    [2,3,10]];
  const day   = [[28,95,215],[70,155,240],   [155,205,255], [38,55,75]];
  const twi   = [[35,18,75], [130,55,28],    [250,115,35],  [55,28,8]];

  const lerpPal = (pa, pb, t) => pa.map((_, i) => lerp3(pa[i], pb[i], t));

  let pal = lerpPal(night, day, t);
  pal = pal.map((c, i) => lerp3(c, twi[i], twil * 0.95));

  if (storm) {
    pal = pal.map(c => {
      const avg = (c[0]+c[1]+c[2]) / 3;
      return [avg*.5+c[0]*.2, avg*.5+c[1]*.2, avg*.5+c[2]*.2];
    });
  }

  const gc = cloudCover * 0.3;
  pal = pal.map(c => {
    const avg = (c[0]+c[1]+c[2]) / 3;
    return [c[0]*(1-gc)+avg*gc, c[1]*(1-gc)+avg*gc, c[2]*(1-gc)+avg*gc];
  });

  const ws = season * 10;
  pal = pal.map(c => [c[0]+ws, c[1]+ws*0.25, c[2]-ws*0.4]);

  const css = pal.map(c =>
    'rgb(' + c.map(v => clamp(Math.round(v), 0, 255)).join(',') + ')'
  );

  const grad = ctx.createLinearGradient(0, 0, 0, SKY_H);
  grad.addColorStop(0,    css[0]);
  grad.addColorStop(0.32, css[1]);
  grad.addColorStop(0.70, css[2]);
  grad.addColorStop(1,    css[3]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SKY_W, SKY_H);

  // Clouds
  if (cloudCover > 0.05) {
    const dayT = t, cr = storm ? 110 : Math.round(195 + dayT*60);
    const cg = storm ? 115 : Math.round(200 + dayT*55);
    const cb = storm ? 135 : Math.round(215 + dayT*40);
    const baseA = cloudCover * (storm ? 0.88 : 0.60);
    const dx = cloudOff * SKY_W;

    const defs = [
      { ox:.12, oy:.20, rx:210, ry:42 },
      { ox:.48, oy:.15, rx:240, ry:48 },
      { ox:.76, oy:.26, rx:170, ry:34 },
      { ox:.32, oy:.30, rx:140, ry:30 },
      { ox:.63, oy:.38, rx:190, ry:38 },
    ];

    ctx.save();
    for (const d of defs) {
      const cx = ((d.ox * SKY_W + dx) % SKY_W + SKY_W) % SKY_W;
      const cy = d.oy * SKY_H;
      const g  = ctx.createRadialGradient(cx, cy, 0, cx, cy, d.rx);
      g.addColorStop(0,  `rgba(${cr},${cg},${cb},${baseA})`);
      g.addColorStop(.5, `rgba(${cr},${cg},${cb},${(baseA*.55).toFixed(3)})`);
      g.addColorStop(1,  `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = g;
      ctx.save();
      ctx.scale(1, d.ry / d.rx);
      ctx.beginPath();
      ctx.arc(cx, cy * (d.rx / d.ry), d.rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § Star catalogue — ZeroBytes, static per worldSeed
// ─────────────────────────────────────────────────────────────────────────────

export function buildStarCatalogue(worldSeed, count = 220) {
  const stars = [];
  for (let i = 0; i < count; i++) {
    const s1 = positionHash(i, 0, 0, worldSeed + 7777);
    const s2 = positionHash(i, 1, 0, worldSeed + 7777);
    const s3 = positionHash(i, 2, 0, worldSeed + 7777);
    const s4 = positionHash(i, 3, 0, worldSeed + 7777);
    stars.push({
      azimuth:   hashToFloat(s1) * Math.PI * 2,
      elevation: hashToFloat(s2),  // [0,1] → mapped to 0..85° in overlay
      bright:    0.4 + hashToFloat(s3) * 0.6,
      blue:      hashToFloat(s4) > 0.5,
    });
  }
  return stars;
}

// ─────────────────────────────────────────────────────────────────────────────
// § Direction vector helper
// ─────────────────────────────────────────────────────────────────────────────

export function dirFromAzimuthElevation(azimuth, elevation) {
  const cosEl = Math.sqrt(Math.max(0, 1 - elevation * elevation));
  return new THREE.Vector3(
    cosEl * Math.sin(azimuth),
    elevation,
    cosEl * Math.cos(azimuth)
  ).normalize();
}

/**
 * Project a world-direction vector to SVG/DOM screen coordinates.
 * Returns { x, y } or null if behind the camera.
 */
export function projectDirection(dir3, camera, screenWidth, screenHeight) {
  const ndc = dir3.clone().multiplyScalar(6000).add(camera.position);
  ndc.project(camera);
  if (ndc.z > 1.0) return null;
  return {
    x: (ndc.x *  0.5 + 0.5) * screenWidth,
    y: (ndc.y * -0.5 + 0.5) * screenHeight,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// § ZeroSkybox  — Three.js dome component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ZeroSkybox
 * Adds a canvas-textured hemisphere dome to the provided Three.js scene.
 * The dome texture is redrawn each frame from the deterministic sky state.
 *
 * Props:
 *   scene       {THREE.Scene}    Required
 *   worldSeed   {number}         Default: 1337
 *   epoch       {number}         World integer tick. Default: 0
 *   ticksPerDay {number}         Default: 240
 *   ticksPerYear{number}         Default: 87600
 *   regionX     {number}         Default: 0
 *   regionY     {number}         Default: 0
 *   radius      {number}         Dome radius. Default: 10000
 *   onSkyState  {function}       Optional callback(skyState) called each render
 */
export function ZeroSkybox({
  scene,
  worldSeed    = 1337,
  epoch        = 0,
  ticksPerDay  = 240,
  ticksPerYear = 87600,
  regionX      = 0,
  regionY      = 0,
  radius       = 10000,
  onSkyState   = null,
}) {
  const domeRef   = useRef(null);
  const matRef    = useRef(null);
  const texRef    = useRef(null);
  const ctxRef    = useRef(null);
  const canvasRef = useRef(null);

  // Build dome once on mount
  useEffect(() => {
    if (!scene) return;

    const offscreen = document.createElement('canvas');
    offscreen.width  = SKY_W;
    offscreen.height = SKY_H;
    canvasRef.current = offscreen;
    ctxRef.current    = offscreen.getContext('2d');

    const tex = new THREE.CanvasTexture(offscreen);
    tex.flipY = true;
    texRef.current = tex;

    const geo = new THREE.SphereGeometry(radius, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2 + 0.3);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    matRef.current = mat;

    const dome = new THREE.Mesh(geo, mat);
    dome.renderOrder = -1;
    scene.add(dome);
    domeRef.current = dome;

    return () => {
      scene.remove(dome);
      geo.dispose();
      mat.dispose();
      tex.dispose();
      domeRef.current  = null;
      matRef.current   = null;
      texRef.current   = null;
      ctxRef.current   = null;
      canvasRef.current = null;
    };
  }, [scene, radius]);

  // Redraw texture whenever epoch or config changes
  useEffect(() => {
    if (!ctxRef.current || !texRef.current) return;
    const ss = getSkyState(epoch, worldSeed, regionX, regionY, ticksPerDay, ticksPerYear);
    drawSkyToCanvas(ctxRef.current, ss);
    texRef.current.needsUpdate = true;
    if (onSkyState) onSkyState(ss);
  }, [epoch, worldSeed, regionX, regionY, ticksPerDay, ticksPerYear, onSkyState]);

  return null; // No DOM output — manages Three.js objects only
}

// ─────────────────────────────────────────────────────────────────────────────
// § ZeroSkyboxSVG  — DOM overlay for sun, moon, stars
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ZeroSkyboxSVG
 * Renders an absolutely-positioned SVG overlay with projected sun, moon, stars.
 * Place this as a sibling of your Three.js canvas in the DOM.
 *
 * Props:
 *   camera      {THREE.Camera}   Required — must have updateMatrixWorld called before render
 *   worldSeed   {number}
 *   epoch       {number}
 *   ticksPerDay {number}
 *   ticksPerYear{number}
 *   regionX     {number}
 *   regionY     {number}
 *   width       {number}         Viewport width in px (default: window.innerWidth)
 *   height      {number}         Viewport height in px
 */
export function ZeroSkyboxSVG({
  camera,
  worldSeed    = 1337,
  epoch        = 0,
  ticksPerDay  = 240,
  ticksPerYear = 87600,
  regionX      = 0,
  regionY      = 0,
  width        = typeof window !== 'undefined' ? window.innerWidth  : 1920,
  height       = typeof window !== 'undefined' ? window.innerHeight : 1080,
}) {
  const [state, setState] = useState(null);
  const catalogueRef = useRef(null);

  // Rebuild star catalogue when seed changes
  useEffect(() => {
    catalogueRef.current = buildStarCatalogue(worldSeed);
  }, [worldSeed]);

  // Recompute projected positions when epoch/camera changes
  useEffect(() => {
    if (!camera || !catalogueRef.current) return;
    const ss = getSkyState(epoch, worldSeed, regionX, regionY, ticksPerDay, ticksPerYear);
    const nightBlend = clamp((-ss.sunEl + 0.05) / 0.22, 0, 1);

    // Sun
    const sunDir = dirFromAzimuthElevation(ss.sunAz, ss.sunEl);
    const sunPos = projectDirection(sunDir, camera, width, height);
    const sunAlpha = sunPos && ss.sunEl > -0.18
      ? clamp((ss.sunEl + 0.14) / 0.22, 0, 1) : 0;
    const sunT  = clamp(ss.sunEl / 0.55, 0, 1);
    const sunDiscR = 255, sunDiscG = Math.round(185 + sunT*70), sunDiscB = Math.round(70 + sunT*185);

    // Moon
    const moonDir = dirFromAzimuthElevation(ss.moonAz, ss.moonEl);
    const moonPos = projectDirection(moonDir, camera, width, height);
    const moonAlpha = moonPos && ss.moonEl > -0.12
      ? clamp((ss.moonEl + 0.10) / 0.18, 0, 1) * nightBlend : 0;
    const pAngle = ss.moonPh * Math.PI * 2;
    const moonShadowCx = (Math.cos(pAngle) * 22).toFixed(1);
    const moonShadowRx = Math.max(0, Math.abs(Math.sin(pAngle)) * 22).toFixed(1);

    // Stars
    const stars = catalogueRef.current.map(st => {
      const elevAngle = st.elevation * 0.85;
      const actualEl  = Math.sin(elevAngle);
      const dir  = dirFromAzimuthElevation(st.azimuth, actualEl);
      const pos  = projectDirection(dir, camera, width, height);
      const alpha = pos ? st.bright * nightBlend * (actualEl > 0 ? 1 : Math.max(0, 1+actualEl*20)) : 0;
      return { pos, alpha, bright: st.bright, blue: st.blue };
    });

    setState({ ss, sunPos, sunAlpha, sunDiscR, sunDiscG, sunDiscB,
               moonPos, moonAlpha, moonShadowCx, moonShadowRx, stars, nightBlend });
  }, [epoch, camera, worldSeed, regionX, regionY, ticksPerDay, ticksPerYear, width, height]);

  if (!state) return null;
  const { sunPos, sunAlpha, sunDiscR, sunDiscG, sunDiscB,
          moonPos, moonAlpha, moonShadowCx, moonShadowRx, stars } = state;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      style={{ position:'absolute', inset:0, width:'100%', height:'100%', pointerEvents:'none', overflow:'hidden' }}
    >
      <defs>
        <radialGradient id="zs-sun-g" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stopColor="#fff8e0" stopOpacity="1"/>
          <stop offset="40%"  stopColor="#ffe080" stopOpacity="1"/>
          <stop offset="70%"  stopColor="#ff9a20" stopOpacity=".6"/>
          <stop offset="100%" stopColor="#ff6000" stopOpacity="0"/>
        </radialGradient>
        <radialGradient id="zs-moon-g" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stopColor="#e8eeff" stopOpacity="1"/>
          <stop offset="60%"  stopColor="#c0ccee" stopOpacity="1"/>
          <stop offset="85%"  stopColor="#8899cc" stopOpacity=".4"/>
          <stop offset="100%" stopColor="#8899cc" stopOpacity="0"/>
        </radialGradient>
        <clipPath id="zs-moon-clip">
          <circle r="22" cx="0" cy="0"/>
        </clipPath>
        <filter id="zs-star-glow" x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.4" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>

      {/* Stars */}
      {stars.map((s, i) => s.alpha > 0.02 && s.pos ? (
        <circle key={i}
          cx={s.pos.x.toFixed(1)} cy={s.pos.y.toFixed(1)}
          r={(1.0 + s.bright * 1.4).toFixed(1)}
          fill={s.blue ? 'rgb(160,185,255)' : 'rgb(255,255,215)'}
          opacity={s.alpha.toFixed(3)}
          filter="url(#zs-star-glow)"
        />
      ) : null)}

      {/* Moon */}
      {moonPos && (
        <g opacity={moonAlpha.toFixed(3)} transform={`translate(${moonPos.x.toFixed(1)},${moonPos.y.toFixed(1)})`}>
          <circle r="48" cx="0" cy="0" fill="url(#zs-moon-g)" opacity=".35"/>
          <g clipPath="url(#zs-moon-clip)">
            <circle r="22" cx="0" cy="0" fill="#d0daff"/>
            <ellipse rx={moonShadowRx} ry="22" cx={moonShadowCx} cy="0" fill="#080c1a"/>
          </g>
        </g>
      )}

      {/* Sun */}
      {sunPos && (
        <g opacity={sunAlpha.toFixed(3)} transform={`translate(${sunPos.x.toFixed(1)},${sunPos.y.toFixed(1)})`}>
          <circle r="80" cx="0" cy="0" fill="url(#zs-sun-g)" opacity=".5"/>
          <circle r="44" cx="0" cy="0" fill="url(#zs-sun-g)" opacity=".7"/>
          <circle r="22" cx="0" cy="0" fill={`rgb(${sunDiscR},${sunDiscG},${sunDiscB})`}/>
          <circle r="10" cx="0" cy="0" fill="#ffffff"/>
        </g>
      )}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * epochFromRealTime(startEpoch, startTime, nowTime, ticksPerRealSecond)
 * Derive a stable world epoch from real elapsed time.
 * Capture startEpoch + startTime = performance.now() once; call each frame.
 */
export function epochFromRealTime(startEpoch, startTime, nowTime, ticksPerRealSecond = 1) {
  const elapsed = (nowTime - startTime) / 1000;
  return Math.floor(startEpoch + elapsed * ticksPerRealSecond);
}

export default ZeroSkybox;
