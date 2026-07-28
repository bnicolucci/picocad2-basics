# Editor roadmap — entities, then dungeons

PICO-8 is the spirit: small, obvious, one-glance tools — but full 3D. The old
engine's editors (parked in `wip/editor_examples/`) are the reference for
layout and ideas; their code targets the old engine and is not ported, only
mined. Everything below follows the established dev-page recipe: dev-only
`editor_*.html` + `/editor.css`, `src/lib/editorPage.ts` helpers, the
`editor-save` middleware writing GENERATED registry files that round-trip.

## Phase 1 — Entity editor (DONE 2026-07-28)

An **entity** is a reusable game thing: one or more **parts** composed
together — custom models (`pig`) or the stock primitives (`mesh_sphere` ×3 =
snowman) — plus the gameplay facts the engine needs. Composition matters:
people without modelling skills build everything from primitives, and reused
primitives share their geometry/texture automatically (parse-once + upload
cache already guarantee this).

### Data (generated `src/assets/entities.ts`, types in `src/lib/entity.ts`)

```ts
type EntityPart = {
    mesh: string;                        // 'pig' | 'mesh_sphere' | ...
    pos?: [number, number, number];
    rot?: [number, number, number];      // degrees (hand-readable), → radians at spawn
    scale?: [number, number, number];
    color?: number;                      // flat palette colour override
    uv?: UvTransform;                    // tile / repeat, as in ModelLook
};

type EntityBlueprint = {
    /** The VISIBLE nose direction (as seen in picoCAD2/the editor — never raw
        file space, which the X-mirror hides). Six values so a rocket can face
        y+. */
    forward?: 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-'; // default 'z+'
    radius?: number;                     // circle collider; absent = not solid
    tags?: string[];                     // 'player', 'enemy', 'prop', ...
    parts: EntityPart[];
};
```

One registry file, `export default { pig: {...}, snowman: {...} }`, exactly
like the animations/controls patterns. The editor round-trips its state out of
this file; no sidecar saves.

### Runtime (`src/lib/entity.ts`)

- `spawnEntity(name)` → an `Object3D` group: each part instantiated with its
  look, local transform applied; `forward` carried on the object.
- `faceToward(obj, x, z)` → ground movement, yaw-only: bakes a fixed
  correction from the authored forward (for `y+` that includes a 90° pitch to
  lay the nose horizontal) plus the picoCAD X-mirror, then yaws along the
  movement vector. This is the fix for the pig walking sideways (authored X−).
- `pointAlong(obj, x, y, z)` → BACKLOG: full-3D alignment for flight (missile
  arcs, dives); aligning one axis leaves roll free, resolved via world-up —
  kept out of v1 so the ground case stays simple. No data change needed later.

### UI (three-pane, trimmed from `wip/editor_examples/editor_blueprint.html`)

- **Left** — mesh palette: Primitives and Models sections (dev-only globs,
  same pattern as the animation editor); click to add as a part. Entity
  picker + "new entity" at the top.
- **Center** — viewport: real renderer + orbit (generalized out of
  `animPreview`), ground grid, the `+X/−X/+Z/−Z` axis labels overlaid, and a
  forward-arrow gizmo showing the entity's facing.
- **Right** — inspector: Outliner (part list: select/duplicate/delete),
  Transform (pos/rot/scale fields), Look (colour / uv tile), Entity (name,
  forward via four cardinal buttons, collider radius, tags), Save.

v1 selects parts via the outliner (the engine has no raycaster; click-picking
is a stretch goal via ray-vs-collider). Blender-style G/R/S keys: stretch.

### Files

| file | role |
|---|---|
| `editor_entity.html` | dev-only page (links `/editor.css`) |
| `src/editor_entity.ts` | the editor |
| `src/lib/entity.ts` | types + `spawnEntity` + `faceToward` |
| `src/lib/editorViewport.ts` | orbit/overlay viewport shared with animPreview |
| `src/assets/entities.ts` | GENERATED registry |
| `vite.config.ts` | + `save-entities` endpoint (reuses `handle`) |

## Phase 2 — Dungeon editor (DONE 2026-07-28)

Ported against the new engine. Dungeon = grid of rooms; room = tile grid
(empty/floor/wall) + door edges + sparse part-override maps. Asset convention
carried over: each `src/assets/dungeon/*.txt` is a category, each named node a
part, authored on the ground plane at ~1 tile and placed at a uniform tile
scale.

**The addition**: a per-room `entities` layer (sparse tile index → entity name
+ yaw) so Phase-1 entities are placed directly on the map. This replaces the
old standalone scene editor for the Zelda use case.

UI: sidebar (dungeon picker, grid size, paint palette + part row, room nav,
door toggles), 2D paint canvas, live 3D room preview. Saves generated
`src/assets/dungeons/<name>.ts`, which exports the data plus `buildDungeon()`
/ `buildRoom(rc, rr)` wired to its own asset imports.

The 2D map and the 3D preview both resolve tiles through the runtime's
`resolveTile`, and map colours are sampled from each part's real texture, so
the map cannot disagree with what the game builds.

### Files

| file | role |
|---|---|
| `editor_dungeon.html` | dev-only page (links `/editor.css`) |
| `src/editor_dungeon.ts` | the editor |
| `dungeon_play.html` + `src/dungeon_play.ts` | dev-only "Preview in game" page |
| `src/lib/dungeon.ts` | types + helpers + `resolveTile` / `buildRoom` / `buildDungeon` / `isSolidAt` |
| `src/assets/dungeon/*.txt` | part libraries by category (junction into the picoCAD2 app folder) |
| `src/assets/dungeons/*.ts` | GENERATED dungeons |
| `vite.config.ts` | + `save-dungeon` endpoint (mkdirs its directory) |

Engine changes it needed: `instantiate({ part })` (draw one named node of a
multi-part file — one upload shared by every tile) and `PicoCadModel.parts`;
`EditorViewport.frame` takes an optional yaw/pitch pose; `saveGenerated`
resolves true/false so Preview can wait for the write.

Carried over from the wip editor: the floating part menu with 3/4-view icons
(`src/lib/editorIcons.ts`), now driven by the real renderer.

Not carried over: the palette recolour select (see Backlog — the new engine has
no palette override yet).

## Phase 3 — runtime glue (to play what you edit)

The dev-only preview page (`src/dungeon_play.ts`) already does the walkable
core, so what it does is the reference for what moves into game code:

- ~~Entity spawning from dungeon data; player = the one tagged `player`~~ DONE
  (a painted `player` placement is adopted as the player).
- ~~Tile collision~~ DONE via `isSolidAt` — circle-vs-tile, axis-at-a-time so
  you slide along walls. Circle-**circle** collision between entities is still
  to come (git history, `c867ac8` era).
- ~~Camera slide between rooms~~ DONE as a lerp on room change, with only the
  current room (and the one being left) drawn. Proper door *triggers* — a
  band at the opening with a spawn point just inside the neighbour — are still
  open; the preview just uses "which room is the player standing in".
- HUD (hearts/minimap) is game code, later.

When a real dungeon game exists it becomes `main.ts` + `index.html`; the
preview page stays as the editor's check-it-works button.

## Backlog / futures

- **Palettes** (`src/assets/palettes/` — restored 2026-07-28): palette
  recolouring of parts/entities, as the wip dungeon editor did. Needs a
  `PicoCadPaletteOverride` argument on `buildTexture` first. Wire into the
  entity editor's Look section and a dungeon-editor palette select when it
  lands (a `paletteId` field on `Dungeon` is the natural home). Note the part
  icons are baked once at startup, so a palette switch would need them re-baked.
- **Texture dedup across models**: primitives usually carry the same
  texture. Dedupe at renderer upload (hash `BuiltTexture` → share the GPU
  texture) and/or at build in the compact plugin (identical texture blocks
  encoded once). Now that instancing batches per mesh, this is what would let
  DIFFERENT models batch together as well.
- **Instancing follow-ups** (the core landed 2026-07-28): `flattenScene` still
  allocates a `Mat4` per node and an `Instance` per model root every frame —
  the next win if CPU time shows up. Frustum/room culling is the other one; the
  dungeon preview already culls by room, crudely.
- **Freeform scene editor**: only if a non-dungeon game needs it.
- **In-viewport transform gizmos / click-picking**: needs a small raycaster
  (ray vs part collider), then G/R/S keys like the old editors.
