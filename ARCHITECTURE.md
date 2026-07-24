# Architecture & Extension Guide

A practical guide to how this game is structured, how to add features, and how
you'd evolve it into an ECS if it grows. It reflects the code as it stands — if
you change the code, change this too.

---

## 1. Big picture

This is a tiny 3D top-down game (Zelda-ish room crawler) rendered with picoCAD2
models. It is deliberately **bare-bones and PICO-8-shaped**: the whole game is
three functions over one state object.

```
init(world)              run once at startup
update(world, dt, input) run every frame: advance the simulation
draw(world): Instance[]   run every frame: describe what to render
```

Two rules keep it clean:

1. **`lib/` is the engine, `game/` is the game.** `lib/` knows nothing about
   players, enemies, or rooms. `game/` never touches WebGL.
2. **One file per "thing."** Each entity kind (`player.ts`, `enemy.ts`) owns its
   data, its behavior, and how it draws itself. Cross-entity concerns that don't
   belong to a single kind (collision, combat) are their own files.

There is **no scene graph and no ECS** — `draw()` returns a flat array of things
to render ("minimal object list"). That's intentional; §9 covers when/how to go
ECS.

---

## 2. The two layers

```
src/
  main.ts        bootstrap + the frame loop + input + HUD
  game/          all game logic (no WebGL)
    world.ts     World state bag + createWorld; Input type
    game.ts      init / update / draw  (the PICO-8 contract)
    player.ts    the player: data + behavior + render
    enemy.ts     enemies: data + behavior + render + spawning
    map.ts       rooms as data + geometry + room collision/doors
    collide.ts   resolveCollisions (entity-vs-entity/prop pushing)
    combat.ts    resolveCombat (attack, damage, death)
  lib/           reusable engine (no game logic)
    math.ts      mat4 + quat helpers, clamp, compose (T·R·S)
    picocad2.ts  parse a .txt model + build its textures
    mesh.ts      model graph -> GPU vertex buffers (+ normals, uv bounds)
    model.ts     buildModel(text) -> { meshes, texture, bounds }
    renderer.ts  WebGL2: upload models, draw Instances
    camera.ts    perspective camera + view-space headlight
  assets/
    primitives/  mesh_*.txt (cube, sphere, cylinder, plane, capsule)
    model.txt    a full picoCAD2 model (test asset)
```

Dependency direction is strictly **game → lib** (never the reverse), and within
`game/`, modules only import "downward" toward `map.ts`/`world.ts` types — no
import cycles.

---

## 3. The frame lifecycle

`main.ts` owns the loop. Once, at startup:

1. Create the `Renderer`.
2. Glob every `assets/primitives/*.txt`, `buildModel` each, and `renderer.upload`
   it — storing a `handles` map of `name -> ModelHandle`.
3. `createWorld(handles)` then `init(world)`.

Every frame:

```ts
update(world, dt, keys);                    // advance simulation
renderer.render(viewProjection(cam, aspect), // draw
                cameraLightDir(cam),
                draw(world));
drawHud();                                   // DOM overlay
```

`update()` runs a **fixed, deliberate order** (order matters — collision must see
final positions, combat must see post-collision positions):

```ts
export function update(w, dt, input) {
  w.time += dt;
  updatePlayer(w.player, w, dt, input);   // 1. player input -> movement
  const door = doorCrossed(w);            // 2. room transition
  if (door) { enterRoom(w, door); spawnRoomEnemies(w); }
  for (const e of w.enemies) updateEnemy(e, w, dt); // 3. enemy behavior
  resolveCollisions(w);                   // 4. push everyone apart / off props
  resolveCombat(w);                       // 5. attack hits, contact damage, death
}
```

`draw()` just reads state and emits instances (floor + walls → enemies → slash →
player), skipping the player on blink frames:

```ts
export function draw(w): Instance[] {
  const out = [...mapInstances(w), ...w.enemies.map(e => enemyInstance(w, e))];
  const slash = slashInstance(w, w.player); if (slash) out.push(slash);
  if (!blinkedOut) out.push(playerInstance(w, w.player));
  return out;
}
```

---

## 4. Core concepts

**World** (`world.ts`) is the single mutable state object: `handles`, `camera`,
`player`, `enemies[]`, `roomId`, `time`. Everything reads and writes it.

**Entities are plain records.** `Player` and `Enemy` are just data (`{ x, z,
facing, hp, ... }`). No classes, no inheritance.

**Behavior is functions.** By convention each entity file exports:
- `createX(...) -> X` — make one
- `updateX(x, world, dt) -> void` — advance it one frame
- `xInstance(world, x) -> Instance` — how to draw it

**Systems** are cross-entity functions that don't belong to one kind:
`resolveCollisions(world)`, `resolveCombat(world)`. They loop over entities.

**Rooms are data** (`ROOMS` in `map.ts`): each room lists its `doors` (and where
they lead), a `prop`, and its `enemies` spawn list. The world is centered on the
origin, the camera is fixed, so changing rooms swaps contents in place.

**Rendering handles.** A model is uploaded to the GPU once and referred to by a
`ModelHandle` (a number). To draw it you push an `Instance`:

```ts
type Instance = { model: ModelHandle; matrix: Mat4; uv?: UvTransform };
```

`matrix` places it; optional `uv` re-tiles/re-colors its texture (see below). The
renderer draws the flat `Instance[]` — no retained scene.

**Per-instance UV** (`UvTransform`) lets one uploaded model look different per
instance: `repeatU/V` tiles the texture (the floor uses this); `tile: {u,v}`
re-points to a different 16px atlas tile (entities use this for color). Textured
faces are affected; flat-color (`notex`) faces are not.

---

## 5. How to add features

### Add a new entity kind (e.g. a pickup)

1. **`game/pickup.ts`** — mirror `enemy.ts`:
   ```ts
   export type Pickup = { x: number; z: number; model: string; radius: number };
   export function createPickup(x, z): Pickup { return { x, z, model: 'mesh_sphere', radius: 0.4 }; }
   export function pickupInstance(w, p): Instance {
     return { model: w.handles[p.model], matrix: compose({x:p.x,y:0.4,z:p.z},{x:0,y:0,z:0},{x:0.6,y:0.6,z:0.6}) };
   }
   ```
2. **`world.ts`** — add `pickups: Pickup[]` to `World` and `[]` in `createWorld`.
3. **`game.ts`** — spawn in `init`/`enterRoom`; draw in `draw` (`...w.pickups.map(...)`).
4. **Interaction** — either in `combat.ts` or a new `pickups.ts` system:
   `if (dist(player, pickup) < r) { grant effect; remove pickup; }`.

That's the whole pattern: **new file + add to World + wire into update/draw**.

### Add a new enemy behavior

Add a kind to `EnemyKind` and a branch in `updateEnemy`:
```ts
export type EnemyKind = 'chaser' | 'wander' | 'shooter';
// in updateEnemy:
else if (e.kind === 'shooter') { /* keep distance, spawn a projectile entity */ }
```
Pick its model/speed/hp in `createEnemy`.

### Add a new room

Add an entry to `ROOMS` in `map.ts` — pure data:
```ts
D: { doors: { west: 'C' }, prop: { model: 'mesh_cube', x: 0, z: -3 },
     enemies: [{ kind: 'chaser', x: -3, z: 0 }, { kind: 'wander', x: 3, z: 0 }] },
```
Wire it by giving an existing room a door to `'D'`. Geometry (walls, doorway gap,
floor) is generated from the door list automatically.

### Add a new action/ability (X or C button)

PICO-8 buttons: **Z/X** are actions, **C** is spare. Attack is on Z/X today.
1. Add state to `Player` (e.g. `dashTimer`, `dashCooldown`).
2. In `updatePlayer`, read the key (`input.has('x')`) and set the timers.
3. Apply the effect (in `updatePlayer` for self-effects like a dash, or in a
   system like `combat.ts` for effects on others).
Movement keys are fixed (WASD/arrows); actions read raw keys directly.

### Add a new model / primitive

Drop a `mesh_whatever.txt` into `assets/primitives/`. `main.ts` globs and uploads
it automatically; reference it by `w.handles.mesh_whatever`. No config changes.
(For a full model, `buildModel(rawText)` + `renderer.upload(...)` anywhere.)

### Change an entity's appearance

Set its optional `uv`:
```ts
enemy.uv = { tile: { u: 2, v: 1 } };  // recolor via atlas tile (see the atlas map below)
floor.uv = { repeatU: 7, repeatV: 5 }; // tile a texture across a surface
```
Only textured faces recolor; flat (`notex`) faces keep their face color — use a
palette swap when you need everything recolored.

Handy shared-atlas solid-color tiles (1-based col,row): red `(2,1)`, green
`(3,1)`, lime `(4,1)`, blue `(5,1)`/`(1,3)`, orange `(7,1)`, purple `(8,1)`.

---

## 6. Testing without a browser

Because `update()` is pure logic over a plain `World` (no WebGL, no DOM), you can
simulate the game headlessly with `bun`:

```ts
import { createWorld } from './src/game/world.ts';
import { init, update } from './src/game/game.ts';

const w = createWorld({} as any);   // handles unused by update()
init(w);
const step = (keys: string[], s: number) => {
  const k = new Set(keys);
  for (let i = 0; i < s * 60; i++) update(w, 1/60, k);
};
step(['w'], 1);           // hold W for 1 s
console.log(w.roomId, w.player.hp, w.enemies.length);
```

This is the fastest way to verify movement, door transitions, and combat rules.

---

## 7. Conventions & gotchas

- **No parameter properties / no enums with values that emit** — `tsconfig` uses
  `erasableSyntaxOnly`. Write explicit fields in constructors.
- **`bun`/`bunx` only**, never npm/npx. Type-check with `bunx tsc --noEmit`.
- **picoCAD models are X-mirrored** vs. WebGL; `mesh.ts` applies one mirror
  matrix and negates normals. You never deal with this in game code.
- **Movement is in world XZ**, `y` is up. `facing` is `atan2(dx, dz)`; the
  forward vector is `(sin facing, cos facing)`.
- **Colliders are circles** (a `radius`), approximate — no rotation, and a box
  prop is treated as its inscribed circle.
- Keep `draw()` free of state changes; it only reads.

---

## 8. The ECS version (how you'd evolve this)

You do **not** need ECS yet — the record-based structure above is the right size
for a handful of entity kinds. Reach for ECS when you have **many kinds that
share the same plumbing** (lots of things that all move, collide, take damage,
get drawn), and the per-kind `updateX` loops start duplicating each other.

The good news: the current seams line up exactly with ECS, so it's an
incremental refactor, not a rewrite.

### The mapping

| Today (records) | ECS |
|---|---|
| `Player` / `Enemy` record | an **entity** = an integer id |
| record fields (`x,z`, `hp`, `uv`) | **components** = data arrays keyed by entity id |
| `createPlayer()` / `createEnemy()` | **spawn blueprints** that attach components |
| `updatePlayer` / `updateEnemy` | **systems** that iterate entities by signature |
| `resolveCollisions` / `resolveCombat` | already systems — barely change |
| `World.player` / `World.enemies[]` | component arrays + a signature bitset |
| `draw()` | a `sys_render` system that emits `Instance[]` |

### Shape of it

```
src/ecs/
  world.ts        component arrays + signatures; createEntity/addComponent/query
  components.ts   data shapes + Has flags
src/entities/     spawn blueprints (compose components)
  player.ts       spawnPlayer(w, x, z)
  enemy.ts        spawnEnemy(w, kind, x, z)
src/systems/      one concern each, run in fixed order
  sys_input.ts    keys -> Move intent on entities with Player
  sys_enemy.ts    AI -> Move intent on entities with Enemy
  sys_move.ts     integrate Move -> Transform, clamp, doors  (ALL movers)
  sys_collide.ts  circle-circle on entities with Collide
  sys_combat.ts   attack + contact damage on entities with Health
  sys_render.ts   Transform + Model (+ Uv) -> Instance[]
game.ts           init(): spawn scene; update(): run systems in order; draw(): sys_render
```

### Components & entities

Components are data-only; a bitmask signature says which an entity has:

```ts
// components.ts
export const enum Has {
  Transform = 1 << 0, Move = 1 << 1, Model = 1 << 2,
  Collide = 1 << 3, Health = 1 << 4, Player = 1 << 5, Enemy = 1 << 6,
}

// world.ts (sketch)
type World = {
  count: number;
  signature: number[];
  transform: { x: number; z: number; facing: number }[];
  move: { speed: number }[];
  model: { name: string; uv?: UvTransform }[];
  collide: { radius: number }[];
  health: { hp: number; maxHp: number; invuln: number }[];
  // ...plus handles, camera, roomId, time as today
};
```

A "player" stops being a type and becomes a blueprint — a bundle of components:

```ts
// entities/player.ts
export function spawnPlayer(w: World, x: number, z: number) {
  const e = createEntity(w);
  w.transform[e] = { x, z, facing: 0 };
  w.move[e] = { speed: 7 };
  w.model[e] = { name: 'mesh_capsule', uv: { tile: { u: 1, v: 3 } } };
  w.collide[e] = { radius: 0.5 };
  w.health[e] = { hp: 3, maxHp: 3, invuln: 0 };
  w.signature[e] = Has.Transform | Has.Move | Has.Model | Has.Collide | Has.Health | Has.Player;
  return e;
}
```

### Systems iterate by signature

The win: **one** movement system moves the player, every enemy, and anything
else with `Move` — no more per-kind duplication.

```ts
// systems/sys_move.ts
const MASK = Has.Transform | Has.Move;
export function sysMove(w: World, dt: number) {
  for (let e = 0; e < w.count; e++) {
    if ((w.signature[e] & MASK) !== MASK) continue;
    const t = w.transform[e];
    // integrate whatever queued movement is on this entity, clamp to room, ...
  }
}
```

`game.update` becomes an explicit ordered runner (same order as today):

```ts
export function update(w, dt, input) {
  sysInput(w, input);
  sysEnemy(w, dt);
  sysMove(w, dt);
  sysCollide(w);
  sysCombat(w);
}
export const draw = sysRender; // Transform + Model -> Instance[]
```

### Migration path (incremental)

1. Introduce `world.ts` component arrays alongside the current records; keep both
   working.
2. Move one concern at a time: e.g. turn `resolveCollisions` into `sysCollide`
   reading `collide[]`/`transform[]`.
3. Convert `createX` → `spawnX`, then delete the old `Player`/`Enemy` types.
4. Replace the per-kind `updateX` with shared systems (`sysMove`, `sysEnemy`).

Nothing in the current design fights this — it was written so `createX` maps to a
spawn blueprint and `updateX` maps to a system. Do it only when the duplication
actually hurts.
