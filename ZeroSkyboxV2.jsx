/**
 * ZeroSkyboxV2.jsx
 * Procedurally deterministic dynamic skybox — Version 2
 *
 * What's new over V1:
 *  - Pole-axis celestial rotation  : stars rotate around (0,sin(lat),cos(lat)), not zenith
 *  - Observer latitude prop        : controls pole elevation + circumpolar visibility
 *  - Polaris / named pole star     : fixed at celestial pole, never moves
 *  - Star twinkle (ZeroTemporal)   : per-star frequency from posHash; planets don't twinkle
 *  - Atmospheric extinction        : stars/planets fade toward horizon
 *  - Milky Way band                : diffuse arc on SVG layer, galactic centre seasonal drift
 *  - Ecliptic-plane planets        : orbit in tilted ecliptic (~23.5 deg), realistic path
 *  - Constellation orientation     : emerges naturally from 3-D vector rotation
 *  - SVG element pooling           : bg stars pooled; constellation SVG rebuilt each frame
 *    but using lightweight DOM ops (no class thrash)
 *
 * Rendering (no GLSL):
 *   Dome     : CanvasTexture hemisphere redrawn each tick
 *   Overlay  : SVG layer, all celestials projected via camera.project()
 *
 * Epoch contract: integer world tick. Never pass Date.now() directly.
 */

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Hash kernel  (Wang cascade, pure JS, no deps)
// ---------------------------------------------------------------------------

function wang(n) {
  n = ((n ^ 61) ^ (n >>> 16)) >>> 0;
  n = ((n + (n << 3)) >>> 0);
  n = ((n ^ (n >>> 4)) >>> 0);
  n = (Math.imul(n, 0x27d4eb2d) >>> 0);
  n = ((n ^ (n >>> 15)) >>> 0);
  return n >>> 0;
}
export function positionHash(x, y, z, salt = 0) {
  let h = wang((x & 0x7fffffff) >>> 0);
  h = wang((h ^ ((y & 0x7fffffff) >>> 0)) >>> 0);
  h = wang((h ^ ((z & 0x7fffffff) >>> 0)) >>> 0);
  h = wang((h ^ ((salt & 0x7fffffff) >>> 0)) >>> 0);
  return h >>> 0;
}
export function temporalHash(x, y, z, epoch, salt = 0) {
  let h = positionHash(x, y, z, salt);
  h = wang((h ^ ((Math.abs(Math.floor(epoch)) & 0x7fffffff) >>> 0)) >>> 0);
  return h >>> 0;
}
export function hashToFloat(h) { return (h >>> 0) / 0x100000000; }
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t)    { return a + (b - a) * t; }
function lerp3(a, b, t)   { return [lerp(a[0],b[0],t), lerp(a[1],b[1],t), lerp(a[2],b[2],t)]; }

// ---------------------------------------------------------------------------
// Sky State  (identical to V1 — O(1), deterministic)
// ---------------------------------------------------------------------------

export function getSkyState(epoch, worldSeed, regionX, regionY, ticksPerDay, ticksPerYear) {
  const ep     = Math.floor(epoch);
  const dayPh  = (ep % ticksPerDay)  / ticksPerDay;
  const yearPh = (ep % ticksPerYear) / ticksPerYear;
  const sunEl  = Math.sin((dayPh - 0.25) * Math.PI * 2);
  const sunAz  = dayPh * Math.PI * 2;
  const moonEl = Math.sin((dayPh + 0.25) * Math.PI * 2);
  const moonAz = (dayPh + 0.5) * Math.PI * 2;
  const season = Math.sin(yearPh * Math.PI * 2);
  const dayIdx = Math.floor(ep / ticksPerDay);
  const cloudSeed = temporalHash(regionX, regionY, 0, dayIdx, worldSeed + 100);
  const stormSeed = temporalHash((regionX >> 2)|0, (regionY >> 2)|0, 0,
                                  Math.floor(dayIdx / 7), worldSeed + 200);
  const cdetSeed  = temporalHash(regionX, regionY, 1,
                                  Math.floor(ep / (ticksPerDay / 6))|0, worldSeed + 300);
  const moisture  = (coherentValue(regionX * 0.1, regionY * 0.1, worldSeed + 500) + 1) * 0.5;
  const moonPh    = (ep % (ticksPerDay * 29)) / (ticksPerDay * 29);
  return {
    dayPh, yearPh, season, sunEl, sunAz, moonEl, moonAz,
    cloudCover: hashToFloat(cloudSeed),
    cloudOff:   hashToFloat(cdetSeed),
    storm:      hashToFloat(stormSeed) > 0.85 && moisture > 0.4,
    moonPh,
  };
}

// ---------------------------------------------------------------------------
// Celestial mechanics
// ---------------------------------------------------------------------------

/** Sidereal rotation angle — full sphere rotates once per sidereal day */
export function siderealAngle(epoch, ticksPerDay) {
  return (epoch / (ticksPerDay * 0.9973)) * Math.PI * 2;
}

/**
 * Pole-axis rotation quaternion.
 * The celestial pole sits at elevation = latitude (radians).
 * Stars rotate around this axis, not the zenith.
 */
export function poleRotation(siderealRad, latRad) {
  const poleAxis = new THREE.Vector3(0, Math.sin(latRad), Math.cos(latRad)).normalize();
  return new THREE.Quaternion().setFromAxisAngle(poleAxis, siderealRad);
}

/** Rotate a catalogue unit vector by the pole quaternion */
export function rotateStar(v3, q) {
  return v3.clone().applyQuaternion(q);
}

/** Project world direction -> screen {x,y} or null if behind camera */
export function projectDir(dir3, camera, W, H) {
  const ndc = dir3.clone().multiplyScalar(6000).add(camera.position);
  ndc.project(camera);
  if (ndc.z > 1.0) return null;
  return { x: (ndc.x * 0.5 + 0.5) * W, y: (-ndc.y * 0.5 + 0.5) * H };
}

/** Az/El to unit THREE.Vector3 (el is sin of elevation angle) */
export function azElToVec3(az, el) {
  const cosEl = Math.sqrt(Math.max(0, 1 - el * el));
  return new THREE.Vector3(cosEl * Math.sin(az), el, cosEl * Math.cos(az)).normalize();
}

// ---------------------------------------------------------------------------
// Atmospheric extinction  (stars fade near horizon)
// ---------------------------------------------------------------------------

function extinctionAlpha(elevation, baseBright) {
  // elevation is the Y component of the unit vector, i.e. sin(alt)
  const horizon = clamp(elevation, 0, 1);
  // pow(horizon, 0.35) gives a gentle rolloff — bright stars still visible low
  return baseBright * Math.pow(horizon + 0.04, 0.35);
}

// ---------------------------------------------------------------------------
// Star twinkle  (ZeroTemporal)
// ---------------------------------------------------------------------------

/**
 * Per-star twinkle modulation.
 * frequency and phase are static (ZeroBytes); amplitude scales with 1-elevation
 * so horizon stars twinkle more. Planets use this with amplitude = 0.
 */
function twinkle(starIdx, epoch, worldSeed, elevation, isPlanet = false) {
  if (isPlanet) return 1.0;
  const freqH  = positionHash(starIdx, 0, 9, worldSeed + 4444);
  const phaseH = positionHash(starIdx, 1, 9, worldSeed + 4444);
  const freq   = 0.08 + hashToFloat(freqH) * 0.18;   // cycles per tick
  const phase  = hashToFloat(phaseH) * Math.PI * 2;
  const amp    = 0.12 * clamp(1.0 - elevation * 4, 0, 1); // more at horizon
  return 1.0 + amp * Math.sin(epoch * freq + phase);
}

// ---------------------------------------------------------------------------
// Background star catalogue  (ZeroBytes — tiny dots, high density)
// ---------------------------------------------------------------------------

/**
 * Stars stored as THREE.Vector3 unit vectors in "catalogue space"
 * (no rotation applied yet — rotation happens per-frame).
 * Elevation is distributed over the full sphere; we only render above horizon.
 */
export function buildBackgroundStars(worldSeed, count = 650) {
  const stars = [];
  for (let i = 0; i < count; i++) {
    const s1 = positionHash(i, 10, 0, worldSeed + 1111);
    const s2 = positionHash(i, 11, 0, worldSeed + 1111);
    const s3 = positionHash(i, 12, 0, worldSeed + 1111);
    const s4 = positionHash(i, 13, 0, worldSeed + 1111);
    const s5 = positionHash(i, 14, 0, worldSeed + 1111);
    const az   = hashToFloat(s1) * Math.PI * 2;
    // Distribute over hemisphere  (acos sampling for uniform sphere coverage)
    const cosEl = hashToFloat(s2) * 2 - 1;  // -1..1
    const el    = Math.sqrt(1 - cosEl * cosEl) * (cosEl >= 0 ? 1 : -1);
    stars.push({
      vec:    azElToVec3(az, el),              // unit vector, catalogue space
      bright: 0.12 + hashToFloat(s3) * 0.50,
      blue:   hashToFloat(s4) > 0.62,
      r:      0.28 + hashToFloat(s5) * 0.32,  // tiny radius
    });
  }
  return stars;
}

// ---------------------------------------------------------------------------
// Polaris / pole star  (fixed, never moves)
// ---------------------------------------------------------------------------

export function buildPolestar(worldSeed, latRad) {
  const nameH = positionHash(0, 0, 0, worldSeed + 6666);
  const names = ['Polaris', 'Kelvorn', 'Stellith', 'Nadir-Prime', 'Axion', 'Velanthor'];
  const name  = names[nameH % names.length];
  return {
    vec:    new THREE.Vector3(0, Math.sin(latRad), Math.cos(latRad)).normalize(),
    bright: 0.85,
    r:      2.6,
    blue:   false,
    name,
    isPolestar: true,
  };
}

// ---------------------------------------------------------------------------
// Constellation catalogue  (ZeroBytes — 3-D vectors, correct orientation)
// ---------------------------------------------------------------------------

const CST_NAMES = ['Velthar','Sorun','Aethis','Droven','Quelith','Morvan','Isenax','Caelum'];

export function buildConstellations(worldSeed) {
  const cons = [];
  const TAU  = Math.PI * 2;
  for (let ci = 0; ci < 8; ci++) {
    const cseed   = positionHash(ci, 0, 0, worldSeed + 5555);
    const centAz  = (ci / 8 + hashToFloat(cseed) * 0.12) * TAU;
    // Keep constellations in upper hemisphere, varying elevation (0.2–0.75)
    const centEl  = 0.20 + hashToFloat(positionHash(ci, 1, 0, worldSeed + 5555)) * 0.55;
    const nStars  = 5 + (positionHash(ci, 2, 0, worldSeed + 5555) % 5);
    const spAz    = 0.18 + hashToFloat(positionHash(ci, 3, 0, worldSeed + 5555)) * 0.16;
    const spEl    = 0.10 + hashToFloat(positionHash(ci, 4, 0, worldSeed + 5555)) * 0.10;
    const stars   = [];
    for (let si = 0; si < nStars; si++) {
      const ss1 = positionHash(ci, si, 1, worldSeed + 5555);
      const ss2 = positionHash(ci, si, 2, worldSeed + 5555);
      const ss3 = positionHash(ci, si, 3, worldSeed + 5555);
      const ss4 = positionHash(ci, si, 4, worldSeed + 5555);
      const az  = centAz + (hashToFloat(ss1) * 2 - 1) * spAz;
      const el  = clamp(centEl + (hashToFloat(ss2) * 2 - 1) * spEl, 0.05, 0.92);
      stars.push({
        vec:    azElToVec3(az, el),
        bright: 0.55 + hashToFloat(ss3) * 0.45,
        r:      1.8  + hashToFloat(ss4) * 1.4,
        blue:   hashToFloat(positionHash(ci, si, 5, worldSeed + 5555)) > 0.55,
      });
    }
    // Spanning chain + up to 2 cross-links
    const edges = [];
    for (let si = 0; si < nStars - 1; si++) edges.push([si, si + 1]);
    const xl1 = positionHash(ci, 5, 0, worldSeed + 5555) % nStars;
    const xl2 = positionHash(ci, 6, 0, worldSeed + 5555) % nStars;
    if (xl1 !== xl2 && Math.abs(xl1 - xl2) > 1) edges.push([xl1, xl2]);
    const xl3 = positionHash(ci, 7, 0, worldSeed + 5555) % nStars;
    const xl4 = positionHash(ci, 8, 0, worldSeed + 5555) % nStars;
    if (xl3 !== xl4 && Math.abs(xl3 - xl4) > 1 &&
        !edges.some(e => (e[0]===xl3&&e[1]===xl4)||(e[0]===xl4&&e[1]===xl3)))
      edges.push([xl3, xl4]);
    // Centroid vector for label placement
    cons.push({ name: CST_NAMES[ci], centVec: azElToVec3(centAz, centEl), stars, edges });
  }
  return cons;
}

// ---------------------------------------------------------------------------
// Planet catalogue  (ZeroBytes static + ZeroTemporal Kepler orbit)
// Planets travel on the ECLIPTIC — tilted ~23.4° from equatorial plane
// ---------------------------------------------------------------------------

const PLANET_NAMES   = ['Mercury','Venus','Mars','Jupiter','Saturn'];
const PLANET_PERIODS = [0.24, 0.62, 1.88, 11.86, 29.46]; // years
const PLANET_COLS    = ['#c8b8a0','#f0e060','#e05028','#e8c880','#d4b870'];
const PLANET_SVGR    = [2.2, 3.5, 2.8, 4.2, 3.8];
const ECLIPTIC_TILT  = 23.4 * Math.PI / 180;

export function buildPlanets(worldSeed, ticksPerYear) {
  return PLANET_NAMES.map((name, i) => {
    const ps1 = positionHash(i, 0, 0, worldSeed + 8888);
    const ps2 = positionHash(i, 1, 0, worldSeed + 8888);
    const ps3 = positionHash(i, 2, 0, worldSeed + 8888);
    const ps4 = positionHash(i, 3, 0, worldSeed + 8888);
    const ps5 = positionHash(i, 4, 0, worldSeed + 8888);
    return {
      name, colour: PLANET_COLS[i], svgR: PLANET_SVGR[i],
      period:      PLANET_PERIODS[i] * ticksPerYear * (0.92 + hashToFloat(ps1) * 0.16),
      phase0:      hashToFloat(ps2) * Math.PI * 2,
      // small inclination offset from ecliptic (real planets have ~0-7 deg)
      inclination: hashToFloat(ps3) * 0.12,
      node:        hashToFloat(ps4) * Math.PI * 2,
      eccentricity: 0.02 + hashToFloat(ps5) * 0.26,
      isSaturn:    name === 'Saturn',
    };
  });
}

/**
 * Compute planet unit vectors at a given epoch.
 * Returns THREE.Vector3 in world-space (equatorial coordinates).
 * Planets orbit in the ecliptic plane, then rotated to equatorial via ECLIPTIC_TILT.
 */
export function getPlanetVectors(planets, epoch) {
  // Ecliptic -> equatorial rotation (tilt around X axis)
  const eclipticQ = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0), ECLIPTIC_TILT
  );
  return planets.map(p => {
    const ep = Math.floor(epoch);
    const M  = (ep / p.period) * Math.PI * 2 + p.phase0;
    const E  = M + p.eccentricity * Math.sin(M);
    const nu = 2 * Math.atan2(
      Math.sqrt(1 + p.eccentricity) * Math.sin(E / 2),
      Math.sqrt(1 - p.eccentricity) * Math.cos(E / 2)
    );
    const lon = nu + p.node;
    // Position in ecliptic plane (XZ) with inclination offset
    const x = Math.cos(lon);
    const z = Math.sin(lon);
    const y = Math.sin(p.inclination) * Math.sin(nu);
    const vec = new THREE.Vector3(x, y, z).normalize().applyQuaternion(eclipticQ);
    return { name: p.name, colour: p.colour, svgR: p.svgR, isSaturn: p.isSaturn, vec };
  });
}

// ---------------------------------------------------------------------------
// Milky Way band
// ---------------------------------------------------------------------------

/**
 * Milky Way is a great circle arc on the SVG layer.
 * galactic_pole is ~(0, 0.46, 0.89) in equatorial coords (RA=192.8°, Dec=27.1°)
 * We model it as a series of projected dots along the galactic equator.
 * The band drifts with sidereal rotation just like stars.
 */
export function buildMilkyWayPoints(worldSeed, count = 80) {
  const points = [];
  for (let i = 0; i < count; i++) {
    const lon = (i / count) * Math.PI * 2;
    // Galactic equator in equatorial coords (approximate)
    const galPoleRa  = 3.366; // radians
    const galPoleDec = 0.473; // radians (~27.1 deg)
    // Rotate lon around galactic pole to get equatorial vector
    const galPole = new THREE.Vector3(
      Math.cos(galPoleDec) * Math.cos(galPoleRa),
      Math.sin(galPoleDec),
      Math.cos(galPoleDec) * Math.sin(galPoleRa)
    ).normalize();
    // Any perpendicular to galPole
    const perp = new THREE.Vector3(1, 0, 0);
    perp.sub(galPole.clone().multiplyScalar(perp.dot(galPole))).normalize();
    const q   = new THREE.Quaternion().setFromAxisAngle(galPole, lon);
    const vec = perp.clone().applyQuaternion(q);
    // Width variation via coherent noise
    const bH  = positionHash(i, 0, 0, worldSeed + 3333);
    const brightness = 0.03 + hashToFloat(bH) * 0.04;
    const widthH = positionHash(i, 1, 0, worldSeed + 3333);
    const width  = 18 + hashToFloat(widthH) * 30;
    points.push({ vec, brightness, width });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Canvas sky texture  (same gradient logic as V1)
// ---------------------------------------------------------------------------

const SKY_W = 512, SKY_H = 512;

function drawSkyToCanvas(ctx, ss) {
  const { sunEl, season, cloudCover, cloudOff, storm } = ss;
  const t    = clamp((sunEl + 1) / 2, 0, 1);
  const twil = Math.max(0, 1 - Math.abs(sunEl) * 5);
  const night = [[3,4,18],    [5,7,28],    [10,14,36],    [2,3,10]];
  const day   = [[28,95,215], [70,155,240],[155,205,255], [38,55,75]];
  const twi   = [[35,18,75],  [130,55,28], [250,115,35],  [55,28,8]];
  const lP    = (pa, pb, t) => pa.map((_, i) => lerp3(pa[i], pb[i], t));
  let pal = lP(night, day, t);
  pal = pal.map((c, i) => lerp3(c, twi[i], twil * 0.95));
  if (storm) pal = pal.map(c => { const a=(c[0]+c[1]+c[2])/3; return [a*.5+c[0]*.2,a*.5+c[1]*.2,a*.5+c[2]*.2]; });
  const gc = cloudCover * 0.3;
  pal = pal.map(c => { const a=(c[0]+c[1]+c[2])/3; return [c[0]*(1-gc)+a*gc,c[1]*(1-gc)+a*gc,c[2]*(1-gc)+a*gc]; });
  const ws = season * 10;
  pal = pal.map(c => [c[0]+ws, c[1]+ws*0.25, c[2]-ws*0.4]);
  const css = pal.map(c => 'rgb('+c.map(v=>clamp(Math.round(v),0,255)).join(',')+')');
  const grad = ctx.createLinearGradient(0,0,0,SKY_H);
  grad.addColorStop(0, css[0]); grad.addColorStop(0.32, css[1]);
  grad.addColorStop(0.70, css[2]); grad.addColorStop(1, css[3]);
  ctx.fillStyle = grad; ctx.fillRect(0,0,SKY_W,SKY_H);
  if (cloudCover > 0.05) {
    const dT = t;
    const cr = storm ? 110 : Math.round(195+dT*60);
    const cg = storm ? 115 : Math.round(200+dT*55);
    const cb = storm ? 135 : Math.round(215+dT*40);
    const bA = cloudCover*(storm?0.88:0.60);
    const dx = cloudOff*SKY_W;
    [[.12,.20,210,42],[.48,.15,240,48],[.76,.26,170,34],[.32,.30,140,30],[.63,.38,190,38]].forEach(([ox,oy,rx,ry])=>{
      const cx=((ox*SKY_W+dx)%SKY_W+SKY_W)%SKY_W,cy=oy*SKY_H;
      const g=ctx.createRadialGradient(cx,cy,0,cx,cy,rx);
      g.addColorStop(0,`rgba(${cr},${cg},${cb},${bA})`);
      g.addColorStop(.5,`rgba(${cr},${cg},${cb},${(bA*.55).toFixed(3)})`);
      g.addColorStop(1,`rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle=g;ctx.save();ctx.scale(1,ry/rx);ctx.beginPath();
      ctx.arc(cx,cy*(rx/ry),rx,0,Math.PI*2);ctx.fill();ctx.restore();
    });
  }
}

// ---------------------------------------------------------------------------
// ZeroSkyboxV2 — Three.js dome component
// ---------------------------------------------------------------------------

export function ZeroSkyboxV2({
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
  const domeRef = useRef(null);
  const matRef  = useRef(null);
  const texRef  = useRef(null);
  const ctxRef  = useRef(null);

  useEffect(() => {
    if (!scene) return;
    const canvas = document.createElement('canvas');
    canvas.width = SKY_W; canvas.height = SKY_H;
    ctxRef.current = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas); tex.flipY = true;
    texRef.current = tex;
    const geo = new THREE.SphereGeometry(radius,48,24,0,Math.PI*2,0,Math.PI/2+0.3);
    const mat = new THREE.MeshBasicMaterial({ map:tex, side:THREE.BackSide, depthWrite:false, fog:false });
    matRef.current = mat;
    const dome = new THREE.Mesh(geo, mat); dome.renderOrder = -1; scene.add(dome);
    domeRef.current = dome;
    return () => {
      scene.remove(dome); geo.dispose(); mat.dispose(); tex.dispose();
      domeRef.current = matRef.current = texRef.current = ctxRef.current = null;
    };
  }, [scene, radius]);

  useEffect(() => {
    if (!ctxRef.current || !texRef.current) return;
    const ss = getSkyState(epoch, worldSeed, regionX, regionY, ticksPerDay, ticksPerYear);
    drawSkyToCanvas(ctxRef.current, ss);
    texRef.current.needsUpdate = true;
    if (onSkyState) onSkyState(ss);
  }, [epoch, worldSeed, regionX, regionY, ticksPerDay, ticksPerYear, onSkyState]);

  return null;
}

// ---------------------------------------------------------------------------
// ZeroSkyboxV2SVG — full celestial overlay (pole-axis rotation, all features)
// ---------------------------------------------------------------------------

export function ZeroSkyboxV2SVG({
  camera,
  worldSeed    = 1337,
  epoch        = 0,
  ticksPerDay  = 240,
  ticksPerYear = 87600,
  regionX      = 0,
  regionY      = 0,
  latitude     = 51.5,   // observer latitude in degrees (default: Bristol)
  width        = typeof window !== 'undefined' ? window.innerWidth  : 1920,
  height       = typeof window !== 'undefined' ? window.innerHeight : 1080,
  showConstellationNames = true,
  showPlanetNames        = true,
  showMilkyWay           = true,
}) {
  const [frame, setFrame] = useState(null);
  const bgStarsRef    = useRef(null);
  const constellRef   = useRef(null);
  const planetsRef    = useRef(null);
  const milkyWayRef   = useRef(null);
  const polestarRef   = useRef(null);
  const latRadRef     = useRef(latitude * Math.PI / 180);

  // Rebuild static catalogues when seed or latitude changes
  useEffect(() => {
    const latRad       = latitude * Math.PI / 180;
    latRadRef.current  = latRad;
    bgStarsRef.current = buildBackgroundStars(worldSeed, 650);
    constellRef.current = buildConstellations(worldSeed);
    planetsRef.current  = buildPlanets(worldSeed, ticksPerYear);
    milkyWayRef.current = buildMilkyWayPoints(worldSeed, 80);
    polestarRef.current = buildPolestar(worldSeed, latRad);
  }, [worldSeed, latitude, ticksPerYear]);

  // Compute all projected positions each tick
  useEffect(() => {
    if (!camera || !bgStarsRef.current) return;

    const ss         = getSkyState(epoch, worldSeed, regionX, regionY, ticksPerDay, ticksPerYear);
    const nightBlend = clamp((-ss.sunEl + 0.05) / 0.22, 0, 1);
    const latRad     = latRadRef.current;
    const sRad       = siderealAngle(epoch, ticksPerDay);
    const poleQ      = poleRotation(sRad, latRad);

    // ── Background stars ──
    const bgStars = bgStarsRef.current.map((st, i) => {
      const rv  = rotateStar(st.vec, poleQ);
      const pos = projectDir(rv, camera, width, height);
      const el  = rv.y;
      if (!pos || el < -0.04) return null;
      const twk = twinkle(i, epoch, worldSeed, el);
      const alpha = extinctionAlpha(el, st.bright) * nightBlend * twk;
      if (alpha < 0.02) return null;
      return { pos, alpha: clamp(alpha, 0, 1), r: st.r, blue: st.blue };
    }).filter(Boolean);

    // ── Pole star ──
    const ps      = polestarRef.current;
    // Polestar never rotates — it IS the rotation axis
    const psPos   = projectDir(ps.vec, camera, width, height);
    const psEl    = ps.vec.y;
    const psAlpha = psPos && psEl > 0.02
      ? clamp(extinctionAlpha(psEl, ps.bright) * nightBlend * 1.2, 0, 1)
      : 0;

    // ── Constellations ──
    const constellations = constellRef.current.map(con => {
      const projStars = con.stars.map((st, si) => {
        const rv    = rotateStar(st.vec, poleQ);
        const pos   = projectDir(rv, camera, width, height);
        const el    = rv.y;
        if (!pos || el < -0.04) return { pos:null, alpha:0, r:st.r, blue:st.blue, visible:false };
        const twk   = twinkle(si * 100 + 7777, epoch, worldSeed, el);
        const alpha = clamp(extinctionAlpha(el, st.bright) * nightBlend * twk, 0, 1);
        return { pos, alpha, r: st.r, blue: st.blue, visible: el > 0 };
      });
      const centRv  = rotateStar(con.centVec, poleQ);
      const centPos = projectDir(centRv, camera, width, height);
      const edges   = con.edges.map(([ai, bi]) => {
        const a = projStars[ai], b = projStars[bi];
        if (!a.visible || !b.visible || !a.pos || !b.pos) return null;
        return { x1:a.pos.x, y1:a.pos.y, x2:b.pos.x, y2:b.pos.y,
                 alpha: Math.min(a.alpha, b.alpha) * 0.38 };
      }).filter(Boolean);
      return { name: con.name, projStars, edges, centPos, centEl: centRv.y };
    });

    // ── Planets ──
    const planetVecs = getPlanetVectors(planetsRef.current, epoch);
    // Planets also undergo sidereal rotation (they share the celestial sphere)
    const planets = planetVecs.map((pv, i) => {
      const rv  = rotateStar(pv.vec, poleQ);
      const pos = projectDir(rv, camera, width, height);
      const el  = rv.y;
      if (!pos || el < -0.08) return null;
      const alpha = clamp(extinctionAlpha(el, 0.9) * nightBlend * clamp((el+0.06)/0.14,0,1), 0, 1);
      if (alpha < 0.03) return null;
      return { ...pv, pos, alpha, el };
    }).filter(Boolean);

    // ── Milky Way ──
    const milkyWay = showMilkyWay ? milkyWayRef.current.map(mw => {
      const rv  = rotateStar(mw.vec, poleQ);
      const pos = projectDir(rv, camera, width, height);
      if (!pos || rv.y < -0.15) return null;
      return { pos, brightness: mw.brightness * nightBlend, width: mw.width };
    }).filter(Boolean) : [];

    // ── Sun ──
    const sunDir  = azElToVec3(ss.sunAz, ss.sunEl);
    const sunPos  = projectDir(sunDir, camera, width, height);
    const sunAlpha = sunPos && ss.sunEl > -0.18 ? clamp((ss.sunEl+0.14)/0.22, 0, 1) : 0;
    const sunT    = clamp(ss.sunEl / 0.55, 0, 1);

    // ── Moon ──
    const moonDir   = azElToVec3(ss.moonAz, ss.moonEl);
    const moonPos   = projectDir(moonDir, camera, width, height);
    const moonAlpha = moonPos && ss.moonEl > -0.12
      ? clamp((ss.moonEl+0.10)/0.18, 0, 1) * nightBlend : 0;
    const pAngle      = ss.moonPh * Math.PI * 2;
    const moonShadowCx = (Math.cos(pAngle) * 22).toFixed(1);
    const moonShadowRx = Math.max(0, Math.abs(Math.sin(pAngle)) * 22).toFixed(1);

    setFrame({
      bgStars, psPos, psAlpha, psName: ps.name,
      constellations, planets,
      milkyWay,
      sunPos, sunAlpha, sunT,
      moonPos, moonAlpha, moonShadowCx, moonShadowRx,
      nightBlend,
    });
  }, [epoch, camera, worldSeed, regionX, regionY, ticksPerDay, ticksPerYear,
      latitude, width, height, showMilkyWay]);

  if (!frame) return null;

  const {
    bgStars, psPos, psAlpha, psName,
    constellations, planets, milkyWay,
    sunPos, sunAlpha, sunT,
    moonPos, moonAlpha, moonShadowCx, moonShadowRx,
  } = frame;

  const sunDiscG = Math.round(185 + sunT * 70);
  const sunDiscB = Math.round(70  + sunT * 185);

  return (
    <svg xmlns="http://www.w3.org/2000/svg"
      style={{ position:'absolute', inset:0, width:'100%', height:'100%',
               pointerEvents:'none', overflow:'hidden' }}>
      <defs>
        <radialGradient id="v2-sun-g" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stopColor="#fff8e0" stopOpacity="1"/>
          <stop offset="40%"  stopColor="#ffe080" stopOpacity="1"/>
          <stop offset="70%"  stopColor="#ff9a20" stopOpacity=".6"/>
          <stop offset="100%" stopColor="#ff6000" stopOpacity="0"/>
        </radialGradient>
        <radialGradient id="v2-moon-g" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stopColor="#e8eeff" stopOpacity="1"/>
          <stop offset="60%"  stopColor="#c0ccee" stopOpacity="1"/>
          <stop offset="85%"  stopColor="#8899cc" stopOpacity=".4"/>
          <stop offset="100%" stopColor="#8899cc" stopOpacity="0"/>
        </radialGradient>
        <clipPath id="v2-moon-clip"><circle r="22" cx="0" cy="0"/></clipPath>
        <filter id="v2-cst-glow" x="-300%" y="-300%" width="700%" height="700%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.8" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="v2-pole-glow" x="-300%" y="-300%" width="700%" height="700%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="v2-planet-glow" x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.8" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>

      {/* Milky Way */}
      {milkyWay.map((mw, i) => (
        <ellipse key={`mw${i}`}
          cx={mw.pos.x.toFixed(1)} cy={mw.pos.y.toFixed(1)}
          rx={(mw.width * 0.6).toFixed(1)} ry={(mw.width * 0.25).toFixed(1)}
          fill={`rgba(200,210,255,${(mw.brightness).toFixed(4)})`}
        />
      ))}

      {/* Background stars */}
      {bgStars.map((s, i) => (
        <circle key={`bg${i}`}
          cx={s.pos.x.toFixed(1)} cy={s.pos.y.toFixed(1)}
          r={s.r.toFixed(2)}
          fill={s.blue ? 'rgb(175,200,255)' : 'rgb(255,255,225)'}
          opacity={s.alpha.toFixed(3)}
        />
      ))}

      {/* Constellation edges */}
      {constellations.map((con, ci) =>
        con.edges.map((e, ei) => (
          <line key={`ce${ci}-${ei}`}
            x1={e.x1.toFixed(1)} y1={e.y1.toFixed(1)}
            x2={e.x2.toFixed(1)} y2={e.y2.toFixed(1)}
            stroke="rgba(140,185,255,1)" strokeWidth="0.55"
            opacity={e.alpha.toFixed(3)}
          />
        ))
      )}

      {/* Constellation stars */}
      {constellations.map((con, ci) =>
        con.projStars.map((st, si) => st.alpha > 0.02 && st.pos ? (
          <circle key={`cs${ci}-${si}`}
            cx={st.pos.x.toFixed(1)} cy={st.pos.y.toFixed(1)}
            r={st.r.toFixed(1)}
            fill={st.blue ? 'rgb(155,180,255)' : 'rgb(255,255,195)'}
            opacity={st.alpha.toFixed(3)}
            filter="url(#v2-cst-glow)"
          />
        ) : null)
      )}

      {/* Constellation labels */}
      {showConstellationNames && constellations.map((con, ci) =>
        con.centPos && con.centEl > 0.05 && frame.nightBlend > 0.1 ? (
          <text key={`cn${ci}`}
            x={con.centPos.x.toFixed(1)} y={(con.centPos.y + 24).toFixed(1)}
            fill="rgba(140,190,255,1)"
            fontSize="8.5" fontFamily="'Courier New',monospace"
            letterSpacing="1.8" textAnchor="middle"
            opacity={(frame.nightBlend * 0.50).toFixed(3)}>
            {con.name.toUpperCase()}
          </text>
        ) : null
      )}

      {/* Pole star (special — never moves, slightly brighter ring) */}
      {psPos && psAlpha > 0.02 && (
        <g opacity={psAlpha.toFixed(3)} transform={`translate(${psPos.x.toFixed(1)},${psPos.y.toFixed(1)})`}>
          <circle r="6" cx="0" cy="0" fill="rgba(180,210,255,0.12)" filter="url(#v2-pole-glow)"/>
          <circle r="2.6" cx="0" cy="0" fill="rgb(220,235,255)"/>
          {showConstellationNames && (
            <text x="0" y="-8" fill="rgba(160,200,255,0.7)"
              fontSize="7.5" fontFamily="'Courier New',monospace"
              letterSpacing="1.2" textAnchor="middle">
              {psName.toUpperCase()}
            </text>
          )}
        </g>
      )}

      {/* Planets */}
      {planets.map((p, i) => (
        <g key={`pl${i}`}
          transform={`translate(${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)})`}
          opacity={p.alpha.toFixed(3)}>
          <circle r={(p.svgR*2.8).toFixed(1)} cx="0" cy="0"
            fill={p.colour} opacity=".18" filter="url(#v2-planet-glow)"/>
          <circle r={p.svgR.toFixed(1)} cx="0" cy="0" fill={p.colour}/>
          {p.isSaturn && (
            <ellipse rx={(p.svgR*2.4).toFixed(1)} ry={(p.svgR*0.65).toFixed(1)}
              cx="0" cy="0" fill="none" stroke={p.colour} strokeWidth="1.2" opacity=".88"/>
          )}
          {showPlanetNames && (
            <text x="0" y={(p.svgR+11).toFixed(1)} fill={p.colour}
              fontSize="7.5" fontFamily="'Courier New',monospace"
              letterSpacing="1" textAnchor="middle" opacity=".72">
              {p.name.toUpperCase()}
            </text>
          )}
        </g>
      ))}

      {/* Moon */}
      {moonPos && (
        <g opacity={moonAlpha.toFixed(3)}
          transform={`translate(${moonPos.x.toFixed(1)},${moonPos.y.toFixed(1)})`}>
          <circle r="52" cx="0" cy="0" fill="url(#v2-moon-g)" opacity=".32"/>
          <g clipPath="url(#v2-moon-clip)">
            <circle r="22" cx="0" cy="0" fill="#d0daff"/>
            <ellipse rx={moonShadowRx} ry="22" cx={moonShadowCx} cy="0" fill="#080c1a"/>
          </g>
        </g>
      )}

      {/* Sun */}
      {sunPos && (
        <g opacity={sunAlpha.toFixed(3)}
          transform={`translate(${sunPos.x.toFixed(1)},${sunPos.y.toFixed(1)})`}>
          <circle r="80" cx="0" cy="0" fill="url(#v2-sun-g)" opacity=".5"/>
          <circle r="44" cx="0" cy="0" fill="url(#v2-sun-g)" opacity=".7"/>
          <circle r="22" cx="0" cy="0" fill={`rgb(255,${sunDiscG},${sunDiscB})`}/>
          <circle r="10" cx="0" cy="0" fill="#ffffff"/>
        </g>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export function epochFromRealTime(startEpoch, startTime, nowTime, ticksPerRealSecond = 1) {
  return Math.floor(startEpoch + ((nowTime - startTime) / 1000) * ticksPerRealSecond);
}

export default ZeroSkyboxV2;
