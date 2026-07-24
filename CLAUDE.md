# picoCAD2 minimal — load a model, control it with code

A bare-bones WebGL2 viewer for picoCAD2 `.txt` models. It parses one model
file, builds GPU meshes, and renders it with a perspective camera. There is no
engine, ECS, editor, scene system, or physics — just enough to load a model
and manipulate it from plain TypeScript.

## Package manager
Use **bun** / **bunx**. Never npm/npx.
- Install: `bun install`
- Dev server: `bun run dev`
- Type-check: `bunx tsc --noEmit`

## Code style
- No comments unless the WHY is non-obvious
- Prefer targeted edits over rewrites
- No premature abstractions

## Layout

```
src/
  main.ts        app entry: uploads primitives, tracks keys, runs init/update/draw
  game/          game logic (PICO-8 style)
    world.ts     World state bag + createWorld
    game.ts      init(world) / update(world, dt, input) / draw(world)
    player.ts    Player: type, createPlayer, updatePlayer, playerInstance
    enemy.ts     Enemy: type, createEnemy, updateEnemy, enemyInstance
    map.ts       rooms data, geometry, clampToRoom, doorCrossed, enterRoom
    collide.ts   resolveCollisions: circle-circle push on the XZ plane
    combat.ts    resolveCombat: attack hits, contact damage, death/respawn
  lib/           reusable engine core (no game logic)
  assets/        picoCAD2 model + primitive .txt files
```

Engine core lives in `src/lib/`; game code lives in `src/game/`. Each entity
kind owns one file holding its data **and** behavior **and** how it renders
(`createX` / `updateX` / `xInstance`) — the PICO-8 "one file per thing" shape.

| File | Role |
|---|---|
| `src/main.ts` | Entry point. Uploads every primitive once, tracks held keys, runs the loop (`update` → `draw` → `renderer.render`). |
| `src/game/world.ts` | `World` (the state bag: handles, camera, player, enemies, roomId, time) + `createWorld`. `Input` is a `Set` of held keys. |
| `src/game/game.ts` | The PICO-8 contract: `init` (spawn room A), `update` (move player, run door transitions + enemies), `draw` (emit the `Instance[]`). |
| `src/game/player.ts` | The player: record, WASD/arrow movement, render instance. |
| `src/game/enemy.ts` | Enemies: `chaser` (steers at the player) / `wander` records + behavior + render instance. |
| `src/game/map.ts` | Rooms as data (`ROOMS`): doors, prop, enemy spawns. Owns geometry (`mapInstances`, `wallSegments`), `clampToRoom`, `doorCrossed`, `enterRoom`, `roomColliders`. |
| `src/game/collide.ts` | `resolveCollisions(w)`: circle-circle on XZ, run after movement. Props are static (push the mover out); player/enemies split the push; everyone re-clamped to the room. Entities carry a `radius`. |
| `src/game/combat.ts` | `resolveCombat(w)`: player attack (forward arc) damages/kills enemies; enemy contact damages the player with i-frames + knockback; death respawns at room A. |
| `src/lib/picocad2.ts` | The picoCAD2 file format: types, `parsePicoCad2`, and `buildTexture` (indexed palette → GPU index + palette textures). |
| `src/lib/mesh.ts` | `buildModelMeshes` walks the model graph into flat interleaved GPU vertex buffers (position, uv, normal, colorIndex, faceFlags) with baked node matrices. This is the "WebGL-friendly" conversion. |
| `src/lib/model.ts` | `buildModel(text)` → CPU-side `{ meshes, texture, bounds }` ready for `Renderer.upload()`. |
| `src/lib/renderer.ts` | Minimal WebGL2 renderer. `upload(meshes, texture)` returns a `ModelHandle`; `render(viewProj, lightDir, instances)` draws an `Instance[]` (`{ model, matrix, uv? }`). One palette-shaded program, no AA, half-res retro upscale. Per-instance `uv: UvTransform` tiles/re-tiles the texture (see below). |
| `src/lib/camera.ts` | Perspective camera, view-space headlight, orbit controls (unused by the game, which drives the camera directly). |
| `src/lib/math.ts` | Column-major mat4 + quaternion helpers, `clamp`, `compose` (T·R·S). |
| `src/assets/**/*.txt` | picoCAD2 models (`model.txt`) and primitives (`primitives/mesh_*.txt`). |

## Game (`src/game/`)

A top-down-ish (angled) Zelda-style room crawler, built entirely from
primitives, structured PICO-8 style: `init` / `update` / `draw` over a single
`World` object (no globals — the `World` is passed in).

- **Entities are plain records** (`Player`, `Enemy`). Each kind's file owns its
  data, its `updateX(entity, world, dt)` behavior, and its `xInstance(world,
  entity)` render mapping. Adding a kind = new file + wire it into
  `update`/`draw`. (This is deliberately the light version; the ECS upgrade path
  — `createX`→spawn blueprint, `updateX`→system — is noted in git history.)
- **Rooms** (`ROOMS` in `map.ts`) are data: which walls have `doors` (and where
  they lead), one distinguishing `prop`, and an `enemies` spawn list. Rooms sit
  at the origin; the camera is fixed and framed on the room, so entering a room
  swaps its contents in place. `enterRoom` repositions the player at the opposite
  doorway; `game.ts` respawns that room's enemies.
- **Walls** are unit `mesh_cube`s scaled into segments (`wallSegments`), leaving
  a centered gap on any wall with a door. **Floor** is a scaled `mesh_plane`.
  **Player** is `mesh_capsule` (offset `y -1.2` so its feet sit on the floor);
  enemies are unit-centered primitives (`y 0.5`).
- **`clampToRoom`** keeps any `{x,z}` inside the walls but permits walking into
  an aligned doorway; player and enemies share it. There is no scene graph —
  `draw` returns a flat `Instance[]` ("minimal object list").
- **Collision** (`collide.ts`) runs each frame after movement: circle-circle on
  the XZ plane. Props push the player/enemies out; player and enemies push each
  other apart. Colliders are approximate (a `radius` per entity), no rotation.
- **Per-instance UV** (`Instance.uv: UvTransform`): `repeatU/V` tiles a model's
  texture across its surface (the floor uses `repeatU: 7, repeatV: 5`); `tile`
  re-points to a different 16px atlas tile. The renderer normalizes within each
  model's own UV bounds (computed at upload) before repeating, so it works on
  primitives whose UVs already sit in a specific atlas tile.
- **Combat** (`combat.ts`): player has `hp`/`maxHp`; **Z/X** (PICO-8 action
  buttons) starts a swing
  that stays active ~0.16s (`attackTimer`) and damages each enemy in a wide
  forward arc once per swing (`swingId` / `enemy.hitSwing`), killing them (chaser
  hp 2, wander hp 1). A green slash (`slashInstance`, a scaled cube) shows in
  front during the swing. Enemy contact costs a heart with i-frames (`INVULN`) +
  knockback; the player blinks while invulnerable. Zero HP respawns at room A. A
  DOM `#hud` shows hearts + enemy count; `#hint` shows the controls.
- **Open seams** (not built yet): per-instance **palette** swap (needs a small
  palette catalog reintroduced — heavier than UV); a nicer attack visual (the
  slash is a placeholder cube); and rooms as authored modules.

## Model space

picoCAD2 models are X-mirrored vs. a right-handed WebGL world. `mesh.ts` applies
that as one innermost mirror matrix per model; face normals are negated to match
the winding flip, and the shader flips normals on back faces for lighting.

## Loop & input

`src/main.ts` uploads every primitive once (`import.meta.glob` over
`assets/primitives`), builds the `World`, calls `init` once, then each frame runs
`update(world, dt, keys)` and feeds `draw(world)` to the renderer. Held keys are
a `Set<string>` (lowercased). The `world` is exposed on `window` for console
poking. WASD/arrows move the player; walk through a doorway to change rooms.

## The format-conversion question

You do **not** need a separate on-disk format (glTF, custom binary with normals,
etc.). The picoCAD2 `.txt` is already parseable JSON; `buildModelMeshes` converts
it at load into exactly the GPU-friendly layout WebGL wants — triangulated,
interleaved, with computed normals. That conversion is cheap and happens once at
load, so a precomputed file would only save a few ms while adding a build step to
keep in sync. Keep the `.txt` + the load-time build.
