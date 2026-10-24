// The 3D torso, loaded on demand by Torso.tsx. Hips up, arms hanging just past
// the torso, six zones on the surface. Solid orange is contact now (brighter
// with force), an orange outline is a fault recorded there, a short orange pulse
// is a thrust landing (stronger with peak). On the summary each zone is shaded
// by hit count with the count written on it.
//
// Rendering is manual (frameloop "never"): a 30 fps ticker draws only while
// frames flow or something is moving, and stops when the tab is hidden.
import { Line, OrbitControls, Text } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Suspense, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import monoFont from '@fontsource/courier-prime/files/courier-prime-latin-700-normal.woff?url';
import { THRESHOLDS } from '../../shared/mockStream.js';
import { getFrame, log } from '../debug';
import { PADS } from '../judge';
import type { PadId, TorsoProps } from './Torso';

const L = log['3d'];

const GLB_URL = `${import.meta.env.BASE_URL}torso.glb`;
const HEIGHT = 2.4;             // model is scaled to this many units tall
const FRAME_MS = 1000 / 30;     // render cap
const SNAP_MS = 3000;           // idle time after a drag before the camera returns
const PULSE_MS = 700;
const PULSE_FULL = 1.5;         // thrust peak (fraction of reference) that plays a full pulse
const EMISSIVE = 0.6;           // emissive intensity at force 1
const DIST = 6.2;
const PHI = Math.PI / 2 - 0.12; // resting camera, a little above chest height
const STATS_MS = 5000;

// ---------------------------------------------------------------------------
// Zones. Angles are degrees around the vertical axis, 0 = front (+z), 90 = the
// model's left. Heights are fractions of the torso, 0 = hips, 1 = shoulders.
// The data model has one side pad, so left and right both read it.
// ---------------------------------------------------------------------------
type ZoneName = 'target' | 'high' | 'low' | 'left' | 'right' | 'back';
interface ZoneSpec { name: ZoneName; pad: PadId; theta: number; width: number; y0: number; y1: number; count: boolean }

const ZONES: ZoneSpec[] = [
  { name: 'target', pad: 'target', theta: 0, width: 44, y0: 0.4, y1: 0.55, count: true },
  { name: 'high', pad: 'high', theta: 0, width: 44, y0: 0.58, y1: 0.7, count: true },
  { name: 'low', pad: 'low', theta: 0, width: 44, y0: 0.22, y1: 0.36, count: true },
  { name: 'left', pad: 'side', theta: 47, width: 24, y0: 0.4, y1: 0.55, count: true },
  { name: 'right', pad: 'side', theta: -47, width: 24, y0: 0.4, y1: 0.55, count: false },
  { name: 'back', pad: 'back', theta: 180, width: 60, y0: 0.6, y1: 0.84, count: true },
];

interface Zone {
  spec: ZoneSpec;
  /** A zone mesh from the glb, or a patch projected onto the torso. */
  mesh: THREE.Mesh;
  outline: THREE.Vector3[];
  center: THREE.Vector3;
  normal: THREE.Vector3;
  material: THREE.MeshLambertMaterial;
}

interface Model {
  source: 'glb' | 'procedural';
  root: THREE.Object3D;
  body: THREE.MeshLambertMaterial;
  zones: Zone[];
}

// ---------------------------------------------------------------------------
// Theme: three.js needs the CSS color tokens as values, re-read on theme change.
// ---------------------------------------------------------------------------
const TOKENS = ['paper', 'ink', 'ink-3', 'skel', 'signal'] as const;
type Palette = Record<(typeof TOKENS)[number], THREE.Color>;

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(TOKENS.map((k) => [k, new THREE.Color(cs.getPropertyValue(`--${k}`).trim() || '#888')])) as Palette;
}

function usePalette(): Palette {
  const [p, setP] = useState(readPalette);
  useEffect(() => {
    const mo = new MutationObserver(() => setP(readPalette()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return p;
}

// ---------------------------------------------------------------------------
// Model: torso.glb if it loads, else a torso built from primitives.
// ---------------------------------------------------------------------------
function procedural(): THREE.Group {
  const g = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 1.3, 2, 10));
  torso.name = 'torso';
  torso.scale.set(1.25, 1, 0.7);
  g.add(torso);
  // Arms start inside the shoulder and flare a little, ending just past the hips.
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.12, 2.0, 8));
    arm.name = side < 0 ? 'arm_right' : 'arm_left';
    arm.position.set(side * 0.74, -0.2, 0);
    arm.rotation.z = side * 0.07;
    g.add(arm);
  }
  return g;
}

const ZONE_NAME = /^zone[_-]?(target|high|low|left|right|back)$/i;
const TORSO_NAME = /torso|body|chest|trunk/i;

/** Casts rays in from outside the torso and builds a patch that sits on its surface. */
function project(spec: ZoneSpec, targets: THREE.Object3D[], box: THREE.Box3) {
  const NU = 10, NV = 6, far = 10, lift = 0.012;
  const ray = new THREE.Raycaster();
  const pts: THREE.Vector3[] = [];
  let hits = 0;
  let lastR = Math.max(box.max.x, box.max.z);
  const at = (u: number, v: number) => {
    const th = THREE.MathUtils.degToRad(spec.theta + spec.width * (u - 0.5));
    const y = THREE.MathUtils.lerp(box.min.y, box.max.y, spec.y0 + (spec.y1 - spec.y0) * v);
    const out = new THREE.Vector3(Math.sin(th), 0, Math.cos(th));
    ray.set(out.clone().multiplyScalar(far).setY(y), out.clone().negate());
    const hit = ray.intersectObjects(targets, false)[0];
    if (hit) { hits++; lastR = Math.hypot(hit.point.x, hit.point.z); }
    return { p: out.clone().multiplyScalar(lastR + lift).setY(y), out };
  };
  for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) pts.push(at(i / NU, j / NV).p);
  if (hits < pts.length / 2) return null;
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const idx: number[] = [];
  for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
    const a = j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1;
    idx.push(a, b, d, a, d, c);
  }
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Boundary, pushed out a little more so the line sits above the fill.
  const ring: THREE.Vector3[] = [];
  const edge = (i: number, j: number) => {
    const p = pts[j * (NU + 1) + i];
    ring.push(p.clone().add(new THREE.Vector3(p.x, 0, p.z).normalize().multiplyScalar(0.006)));
  };
  for (let i = 0; i <= NU; i++) edge(i, 0);
  for (let j = 1; j <= NV; j++) edge(NU, j);
  for (let i = NU - 1; i >= 0; i--) edge(i, NV);
  for (let j = NV - 1; j >= 0; j--) edge(0, j);
  const mid = at(0.5, 0.5);
  return { geo, ring, center: mid.p.add(mid.out.clone().multiplyScalar(0.02)), normal: mid.out };
}

function prepare(source: Model['source'], scene: THREE.Object3D): Model {
  // Center and scale to HEIGHT; glTF is +y up and faces +z.
  const root = new THREE.Group();
  root.add(scene);
  const box0 = new THREE.Box3().setFromObject(scene);
  const size = box0.getSize(new THREE.Vector3());
  if (!(size.y > 0)) throw new Error('model has no visible size');
  const s = HEIGHT / size.y;
  root.scale.setScalar(s);
  root.position.copy(box0.getCenter(new THREE.Vector3()).multiplyScalar(-s));
  root.updateMatrixWorld(true);

  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  if (!meshes.length) throw new Error('model contains no meshes');
  const named = new Map<string, THREE.Mesh>();
  for (const m of meshes) { const k = ZONE_NAME.exec(m.name)?.[1]?.toLowerCase(); if (k) named.set(k, m); }
  const bodyMeshes = meshes.filter((m) => !ZONE_NAME.test(m.name));
  const torso = bodyMeshes.filter((m) => TORSO_NAME.test(m.name));
  const targets = torso.length ? torso : bodyMeshes;
  const box = new THREE.Box3();
  targets.forEach((m) => box.expandByObject(m));

  // Flat neutral material everywhere: no textures, maps or reflections from the file.
  const body = new THREE.MeshLambertMaterial({ flatShading: true });
  bodyMeshes.forEach((m) => { m.material = body; m.castShadow = m.receiveShadow = false; });

  const zones: Zone[] = [];
  const found: string[] = [];
  for (const spec of ZONES) {
    const patch = project(spec, targets, box);
    const own = named.get(spec.name);
    const material = new THREE.MeshLambertMaterial({ flatShading: true, side: THREE.DoubleSide });
    let mesh: THREE.Mesh | null = null;
    if (own) { own.removeFromParent(); own.material = material; mesh = own; }
    else if (patch) mesh = new THREE.Mesh(patch.geo, material);
    found.push(`${spec.name}:${mesh ? (own ? 'glb' : 'overlay') : 'MISSING'}`);
    L.info(`Zone ${spec.name} ${mesh ? 'registered' : 'NOT found'}`, { zone: spec.name, pad: spec.pad, found: !!mesh, mesh: own ? `glb ${own.name}` : patch ? 'overlay projected on torso' : 'none' });
    if (!mesh || !patch) { if (!mesh) material.dispose(); continue; }
    zones.push({ spec, mesh, outline: [...patch.ring, patch.ring[0]], center: patch.center, normal: patch.normal, material });
  }
  for (const pad of PADS) {
    if (!zones.some((z) => z.spec.pad === pad)) L.warn(`Pad ${pad} in the data model has no zone mesh; its contact will not show on the torso`, { pad });
  }
  return { source, root, body, zones };
}

function useModel(onFail: () => void): Model | null {
  const [model, setModel] = useState<Model | null>(null);
  useEffect(() => {
    let alive = true;
    const t0 = performance.now();
    const done = (m: Model, error: string) => {
      let count = 0;
      m.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) count++; });
      L.info(`Torso model ready from ${m.source === 'glb' ? GLB_URL : 'primitives (procedural fallback)'}`, {
        path: m.source, load_ms: Math.round(performance.now() - t0), mesh_count: count + m.zones.length,
        zones: m.zones.length, error: error || 'none',
      });
      if (alive) setModel(m);
    };
    new GLTFLoader().loadAsync(GLB_URL)
      .then((gltf) => done(prepare('glb', gltf.scene), ''))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        L.warn(`${GLB_URL} did not load; building the torso from primitives`, { url: GLB_URL, error: msg });
        try { done(prepare('procedural', procedural()), msg); }
        catch (e) { L.error('The procedural torso could not be built', e); onFail(); }
      });
    return () => { alive = false; };
  }, [onFail]);
  return model;
}

// ---------------------------------------------------------------------------
// Render loop: draw at most 30 times a second, only when wanted. This ticker is
// the only thing that draws, so the cap holds even when React commits often.
// ---------------------------------------------------------------------------
function createLoop() {
  let draw: ((now: number) => void) | null = null;
  let raf = 0, last = 0, until = 0, live = false, running = false;
  const wants = (now: number) => !document.hidden && (live || now < until);
  const pause = (reason: string) => {
    cancelAnimationFrame(raf);
    if (running) L.info(`Render loop paused: ${reason}`, { reason });
    running = false;
  };
  const tick = (now: number) => {
    if (!wants(now)) return pause(document.hidden ? 'tab hidden' : 'nothing is animating');
    raf = requestAnimationFrame(tick);
    if (now - last >= FRAME_MS - 1) { last = now; draw?.(now); }
  };
  const start = () => {
    if (running || !draw || !wants(performance.now())) return;
    running = true;
    raf = requestAnimationFrame(tick);
  };
  const onVis = () => (document.hidden ? pause('tab hidden') : loop.kick(200));
  const loop = {
    attach(fn: (now: number) => void) { draw = fn; document.addEventListener('visibilitychange', onVis); start(); },
    detach() { document.removeEventListener('visibilitychange', onVis); draw = null; pause('view closed'); },
    /** Keep rendering for at least `ms` more. */
    kick(ms: number) { until = Math.max(until, performance.now() + ms); start(); },
    setLive(v: boolean) { live = v; start(); },
  };
  return loop;
}
type Loop = ReturnType<typeof createLoop>;

// ---------------------------------------------------------------------------
// Scene pieces
// ---------------------------------------------------------------------------
interface Pulse { t0: number; amp: number }

function Zones({ model, palette, zonesRef, pulses, counts, faults, loop }: {
  model: Model;
  palette: Palette;
  zonesRef: MutableRefObject<TorsoProps['zones']>;
  pulses: Map<PadId, Pulse>;
  counts?: TorsoProps['counts'];
  faults?: Set<string>;
  loop: Loop;
}) {
  const max = counts ? Math.max(1, ...Object.values(counts).map((v) => v ?? 0)) : 0;
  const shade = (pad: PadId) => (counts ? (counts[pad] ?? 0) / max : 0);
  const tmp = useMemo(() => new THREE.Color(), []);

  useFrame(() => {
    const now = performance.now();
    for (const z of model.zones) {
      const pad = z.spec.pad;
      const force = zonesRef.current?.[pad] ?? 0;
      const lit = force >= THRESHOLDS.zoneOff;
      const p = pulses.get(pad);
      const env = p ? p.amp * Math.max(0, 1 - (now - p.t0) / PULSE_MS) ** 2 : 0;
      if (p && env === 0) pulses.delete(pad);
      const base = tmp.copy(palette.paper).lerp(palette['ink-3'], shade(pad) * 0.9);
      const m = z.material;
      m.color.copy(lit ? palette.signal : base.lerp(palette.signal, env));
      m.emissive.copy(palette.signal);
      m.emissiveIntensity = EMISSIVE * ((lit ? Math.min(force, 1) : 0) + env);
      if (env > 0) loop.kick(60);
    }
  });

  return (
    <>
      {model.zones.map((z) => {
        const fault = faults?.has(z.spec.pad);
        const t = shade(z.spec.pad);
        return (
          <group key={z.spec.name}>
            <primitive object={z.mesh} />
            <Line points={z.outline} color={fault ? palette.signal : palette['ink-3']} lineWidth={fault ? 3 : 1} />
            {counts && z.spec.count && (
              <Suspense fallback={null}>
                <Text
                  font={monoFont}
                  position={z.center}
                  quaternion={new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), z.normal)}
                  fontSize={z.spec.width < 30 ? 0.16 : 0.24}
                  anchorX="center"
                  anchorY="middle"
                  color={t > 0.5 ? palette.paper : palette.ink}
                  onSync={() => loop.kick(60)}
                >
                  {String(counts[z.spec.pad] ?? 0)}
                </Text>
              </Suspense>
            )}
          </group>
        );
      })}
    </>
  );
}

/** Eases the camera to the side that matters, unless someone dragged it in the last 3 s. */
function Rig({ facing, drag, loop }: { facing: MutableRefObject<'front' | 'back'>; drag: MutableRefObject<{ on: boolean; last: number }>; loop: Loop }) {
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update(): void } | null;
  const sph = useMemo(() => new THREE.Spherical(), []);
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera }, dt) => {
    if (drag.current.on || performance.now() - drag.current.last < SNAP_MS) return;
    const target = controls?.target ?? v.set(0, 0, 0);
    sph.setFromVector3(v.copy(camera.position).sub(target));
    const goal = facing.current === 'back' ? Math.PI : 0;
    const dTh = Math.atan2(Math.sin(goal - sph.theta), Math.cos(goal - sph.theta));
    const dPh = PHI - sph.phi;
    if (Math.abs(dTh) < 1e-3 && Math.abs(dPh) < 1e-3 && Math.abs(sph.radius - DIST) < 1e-3) return;
    const k = 1 - Math.exp(-Math.min(dt, 0.1) * 7);
    sph.theta += dTh * k;
    sph.phi += dPh * k;
    sph.radius = DIST;
    camera.position.setFromSpherical(sph).add(target);
    camera.lookAt(target);
    controls?.update();
    loop.kick(80);
  });
  return null;
}

/** Light rides with the camera so the facing side always reads the same. */
function CameraLight() {
  const light = useRef<THREE.DirectionalLight>(null);
  useFrame(({ camera }) => { light.current?.position.copy(camera.position); });
  return <directionalLight ref={light} intensity={0.4 * Math.PI} />;
}

/** Logs fps, draw calls and triangles once per 5 s while rendering. */
function Stats() {
  const gl = useThree((s) => s.gl);
  const w = useRef({ since: 0, last: 0, frames: 0 });
  useFrame(() => {
    const now = performance.now();
    const s = w.current;
    if (!s.since || now - s.last > 500) { s.since = now; s.frames = 0; }
    s.last = now;
    s.frames++;
    if (now - s.since >= STATS_MS) {
      L.info('Rendering', { fps: Math.round((s.frames * 10000) / (now - s.since)) / 10, draw_calls: gl.info.render.calls, triangles: gl.info.render.triangles });
      s.since = now;
      s.frames = 0;
    }
  });
  return null;
}

/** A resize needs a redraw; nothing else would trigger one while idle. */
function KickOnResize({ loop }: { loop: Loop }) {
  const size = useThree((s) => s.size);
  useEffect(() => { loop.kick(100); }, [size, loop]);
  return null;
}

function onCreated(gl: THREE.WebGLRenderer, loop: Loop, advance: (now: number) => void) {
  const ctx = gl.getContext();
  const ext = ctx.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER));
  const software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  L.info(`WebGL context created on ${renderer}`, { renderer, software, webgl2: gl.capabilities.isWebGL2 });
  if (software) L.warn('WebGL is running on a software renderer; the 3D view may be slow', { renderer });
  const el = gl.domElement;
  el.addEventListener('webglcontextlost', () => L.warn('WebGL context lost; the torso stops drawing until the browser restores it', { renderer }));
  el.addEventListener('webglcontextrestored', () => { L.info('WebGL context restored', { renderer }); loop.kick(300); });
  loop.attach(advance);
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------
export default function Torso3D({ zones, faults, counts, phase, events, live = false, facing: rest = 'front', onFail }: TorsoProps & { onFail: () => void }) {
  const palette = usePalette();
  const model = useModel(onFail);
  const loop = useMemo(createLoop, []);
  useEffect(() => () => loop.detach(), [loop]);

  const [side, setSide] = useState<'front' | 'back'>(rest);
  const want = phase ? (phase === 'backblows' ? 'back' : 'front') : side;
  const facing = useRef(want);
  useEffect(() => {
    if (facing.current !== want) L.info(`Camera turning to the ${want}`, { facing: want, phase: phase ?? 'none' });
    facing.current = want;
    loop.kick(1500);
  }, [want, phase, loop]);

  const zonesRef = useRef(zones);
  zonesRef.current = zones;
  useEffect(() => { loop.setLive(live); }, [live, loop]);
  useEffect(() => { model?.body.color.copy(palette.skel); loop.kick(120); }, [zones, faults, counts, palette, model, loop]);

  // Zone activations: one line each time a pad crosses the contact floor.
  const litPads = useRef(new Set<PadId>());
  useEffect(() => {
    for (const pad of PADS) {
      const v = zones?.[pad] ?? 0;
      const on = v >= THRESHOLDS.zoneOff;
      if (on && !litPads.current.has(pad)) {
        L.info(`Zone ${pad} contact`, { zone: pad, meshes: ZONES.filter((z) => z.pad === pad).map((z) => z.name), force: v, frame: getFrame() });
      }
      if (on) litPads.current.add(pad); else litPads.current.delete(pad);
    }
  }, [zones]);

  // Thrust pulses: one per thrust as it closes, on the zone it landed on.
  const pulses = useMemo(() => new Map<PadId, Pulse>(), []);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const closed = (events ?? []).filter((e) => e.type === 'thrust' && !e.open);
    if (!seen.current || closed.length < seen.current.size) { seen.current = new Set(closed.map((e) => e.id)); return; }
    for (const e of closed) {
      if (seen.current.has(e.id) || e.type !== 'thrust') continue;
      seen.current.add(e.id);
      if (!e.zone || e.zone === 'off') continue;
      const amp = Math.min(1, Math.max(0, e.peak / PULSE_FULL));
      pulses.set(e.zone, { t0: performance.now(), amp });
      L.info(`Pulse on ${e.zone} for ${e.id}`, { zone: e.zone, peak: e.peak, amp, frame: getFrame() });
      loop.kick(PULSE_MS + 100);
    }
  }, [events, pulses, loop]);

  const drag = useRef({ on: false, last: 0 });

  return (
    <div className="torso3d-wrap">
      <div className="torso3d" role="img" aria-label="3D torso showing pad contact and recorded faults">
        <Canvas
          frameloop="never"
          flat
          dpr={[1, 2]}
          camera={{ fov: 28, near: 0.1, far: 50, position: new THREE.Vector3().setFromSphericalCoords(DIST, PHI, want === 'back' ? Math.PI : 0) }}
          gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
          onCreated={({ gl, advance }) => onCreated(gl, loop, (now) => advance(now))}
        >
          <ambientLight intensity={0.65 * Math.PI} />
          <CameraLight />
          {model && (
            <>
              <primitive object={model.root} />
              <Zones model={model} palette={palette} zonesRef={zonesRef} pulses={pulses} counts={counts} faults={faults} loop={loop} />
            </>
          )}
          <OrbitControls
            makeDefault
            enableZoom={false}
            enablePan={false}
            enableDamping={false}
            minPolarAngle={0.7}
            maxPolarAngle={2.2}
            onStart={() => { drag.current.on = true; loop.kick(SNAP_MS + 1500); }}
            onEnd={() => { drag.current = { on: false, last: performance.now() }; loop.kick(SNAP_MS + 1500); }}
            onChange={() => { if (drag.current.on) loop.kick(SNAP_MS + 1500); }}
          />
          <Rig facing={facing} drag={drag} loop={loop} />
          <Stats />
          <KickOnResize loop={loop} />
        </Canvas>
      </div>
      {counts && (
        <div className="seg" role="group" aria-label="Side shown">
          {(['front', 'back'] as const).map((s) => (
            <button key={s} type="button" className={side === s ? 'is-on' : ''} aria-pressed={side === s} onClick={() => setSide(s)}>{s}</button>
          ))}
        </div>
      )}
    </div>
  );
}
