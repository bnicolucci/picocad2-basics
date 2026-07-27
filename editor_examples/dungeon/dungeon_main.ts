// Standalone runtime for the Zelda-style dungeon: renders the room grid from
// primitives, moves the player with the arrow keys, blocks it on walls, and
// slides the camera to the neighbouring room when the player steps into a
// doorway.
//
// The engine shell is this project's own: the core Renderer owns the canvas and
// the frame loop (setAnimationLoop), Input owns the keyboard, and the HUD is a
// plain DOM overlay. There is no separate 2D engine layer.

import cylinderRaw from '../assets/primitives/mesh_cylinder.txt?raw';
import cubeRaw from '../assets/primitives/mesh_cube.txt?raw';
import { type Camera, create_camera } from '../core/camera';
import { Input } from '../input';
import { type MaterialTextureData, Renderer } from '../renderer';
import type { RenderInstance } from '../scene';
import { allCatalogMaterials, allCatalogParts, loadDungeonCatalog, makeTileResolver } from './dungeon_assets';
import { currentDungeon } from './dungeon_current';
import {
    buildRoomDoorTriggers,
    buildRoomPlacements,
    isWallAtWorldGlobal,
    roomWorldCenter,
    TILE_GAP,
    TILE_SIZE,
} from './dungeon_geometry';
import { DUNGEON_COLORS, dungeonInstanceMatrix, dungeonPropMatrix, loadPrimitiveMesh, makeFlatMaterial } from './dungeon_primitives';
import { type PropBehavior, propAnimates, propBehavior } from './dungeon_props';
import { roomIndex } from './dungeon_types';

const dungeon = currentDungeon;

const errBox = document.getElementById('err') as HTMLElement;

function fail(err: unknown): void {
    errBox.style.display = 'block';
    errBox.textContent = `Dungeon failed to start:\n${err instanceof Error ? err.stack ?? err.message : String(err)}`;
    console.error(err);
}

// Fixed game resolution — the renderer letterboxes this aspect on the black
// surround (lockAspectRatio), matching the main game's screen config.
const GAME_WIDTH = 800;
const GAME_HEIGHT = 600;

// Camera looks down at the focused room from above and toward +Z, so -Z reads
// as "up/away" on screen and walls show their front faces. Tuned so a whole
// 16x12 room fits the 4:3 frame with a small margin, Zelda-style (see
// 01.JPG..04.JPG references). Room width is the binding constraint at this
// tilt — the depth foreshortens, so there is always more vertical slack.
const CAM_OFFSET: [number, number, number] = [0, 15, 7];
const CAM_FOV = Math.PI / 3.7;
const PLAYER_SCALE = 0.7;
const PLAYER_RADIUS = 0.34;
const MOVE_SPEED = 5.5;

// Room-to-room scroll: player and camera slide together over this many seconds,
// player input locked, both rooms on screen mid-slide. Matches the reference.
const TRANSITION_DURATION = 0.6;

// Fog of war: a visited room that isn't currently on screen renders at this
// brightness; unvisited rooms aren't rendered at all until you first enter them.
const DIM_BRIGHTNESS = 0.4;

function roomKey(rc: number, rr: number): string {
    return `${rc},${rr}`;
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

// Ease-in-out so the scroll accelerates off the old room and settles into the new.
function smoothstep(t: number): number {
    return t * t * (3 - 2 * t);
}

// A tile remembers its bright + dim material ids so the fog pass can swap
// between them (the id pair depends on whether it uses a textured part or the
// flat cube fallback).
type RoomTile = { roomKey: string; matBright: string; matDim: string; inst: RenderInstance };

// A placed prop, tracked separately so it can animate each frame and be
// collected. `x`/`z` are its tile centre; `scale` the uniform tile scale.
type PropTile = {
    roomKey: string;
    inst: RenderInstance;
    x: number;
    z: number;
    scale: number;
    behavior: PropBehavior;
    collected: boolean;
};

/** How close the player must get (in tiles) to collect a prop. */
const PROP_PICKUP_RADIUS = 0.55;

type Transition = {
    fromCenter: [number, number, number];
    toCenter: [number, number, number];
    fromPlayer: [number, number];
    toPlayer: [number, number];
    fromKey: string;
    toKey: string;
    t: number;
};

type Hud = { room: HTMLElement; collected: HTMLElement };

// All runtime state, assembled once by setup() (which is async because the
// renderer creation is). update() reads it; it no-ops until it exists,
// mirroring src/main.ts's load-then-start ordering.
type Game = {
    renderer: Renderer;
    camera: Camera;
    hud: Hud;
    instances: RenderInstance[];
    roomTiles: RoomTile[];
    propTiles: PropTile[];
    collectedCount: number;
    playerInstance: RenderInstance;
    focus: { rc: number; rr: number };
    visited: Set<string>;
    transition: Transition | null;
    player: { x: number; z: number };
    camTarget: [number, number, number];
};
let game: Game | null = null;

const input = new Input();

// Headless-verification input override (window.__dungeon.press/release). Real
// gameplay input is the Input class; this Set is OR'd in so a CDP driver can
// script movement without dispatching synthetic key events.
const testKeys = new Set<string>();
function keyDown(code: string): boolean {
    return input.isDown(code) || testKeys.has(code);
}

function playerHitsWall(x: number, z: number): boolean {
    const r = PLAYER_RADIUS;
    for (const dx of [-r, r]) for (const dz of [-r, r]) {
        if (isWallAtWorldGlobal(dungeon, x + dx, z + dz)) return true;
    }
    return false;
}

// Screen-space HUD. The renderer owns the canvas, so the readouts are plain DOM
// pinned over it rather than drawn into the frame.
function createHud(root: HTMLElement): Hud {
    const panel = document.createElement('div');
    panel.style.cssText =
        'position:fixed;left:14px;top:12px;z-index:2;pointer-events:none;font:14px/1.5 monospace;' +
        'color:#fff;text-shadow:0 2px 0 #000,2px 0 0 #000;white-space:pre';
    const hint = document.createElement('div');
    hint.textContent = 'Arrow keys to move · walk into a doorway to slide to the next room';
    const room = document.createElement('div');
    room.style.color = '#ffd23c';
    const collected = document.createElement('div');
    collected.style.color = '#8bf299';
    panel.append(hint, room, collected);
    root.appendChild(panel);
    return { room, collected };
}

async function setup(root: HTMLElement): Promise<void> {
    const cube = loadPrimitiveMesh('mesh_cube', cubeRaw);
    const player = loadPrimitiveMesh('mesh_cylinder', cylinderRaw);

    // Part library from src/assets/dungeon/*.txt. Each category renders with its
    // own authored texture material (all "grounds" share grounds.txt's texture,
    // differing by UVs, etc.). Tile resolution (which part mesh + material +
    // transform per placement) is shared with the editor preview via
    // makeTileResolver so the preview matches the game exactly.
    const catalog = loadDungeonCatalog(DIM_BRIGHTNESS, dungeon.paletteId);
    const resolveTile = makeTileResolver(catalog, cube.meshId);

    const meshes = new Map([
        [cube.meshId, cube.builtMesh],
        [player.meshId, player.builtMesh],
    ]);
    for (const part of allCatalogParts(catalog)) meshes.set(part.meshId, part.builtMesh);

    const dim = (c: readonly [number, number, number]): [number, number, number] => [
        c[0] * DIM_BRIGHTNESS,
        c[1] * DIM_BRIGHTNESS,
        c[2] * DIM_BRIGHTNESS,
    ];
    const materials: MaterialTextureData[] = [
        // Flat fallbacks (only used when a category has no authored parts).
        { materialId: 'mat:floor', texture: makeFlatMaterial(DUNGEON_COLORS.floor) },
        { materialId: 'mat:wall', texture: makeFlatMaterial(DUNGEON_COLORS.wall) },
        { materialId: 'mat:floor_dim', texture: makeFlatMaterial(dim(DUNGEON_COLORS.floor)) },
        { materialId: 'mat:wall_dim', texture: makeFlatMaterial(dim(DUNGEON_COLORS.wall)) },
        { materialId: 'mat:player', texture: makeFlatMaterial(DUNGEON_COLORS.player) },
        // Real per-category textures (bright + fog-dim).
        ...allCatalogMaterials(catalog),
    ];

    // Static dungeon geometry, built once but grouped so every tile remembers
    // which room it belongs to. The per-frame fog-of-war pass toggles each
    // tile's visibility + bright/dim material from its room's visited/on-screen
    // state, so rooms hide and dim independently ("separate levels").
    const roomTiles: RoomTile[] = [];
    const propTiles: PropTile[] = [];
    const staticInstances: RenderInstance[] = [];
    const propScale = TILE_SIZE - TILE_GAP; // same uniform scale the resolver uses
    let tileId = 0;
    for (let rr = 0; rr < dungeon.roomRows; rr++) {
        for (let rc = 0; rc < dungeon.roomCols; rc++) {
            const key = roomKey(rc, rr);
            for (const p of buildRoomPlacements(dungeon, rc, rr)) {
                const spec = resolveTile(p);
                const inst: RenderInstance = {
                    nodeId: `tile:${tileId++}`,
                    nodeName: p.prim,
                    meshAssetId: spec.meshId,
                    materialId: spec.matBright,
                    visible: false, // fog-of-war pass sets this every frame
                    worldMatrix: spec.worldMatrix,
                };
                staticInstances.push(inst);
                roomTiles.push({ roomKey: key, matBright: spec.matBright, matDim: spec.matDim, inst });
                if (p.prim === 'prop') {
                    propTiles.push({
                        roomKey: key,
                        inst,
                        x: p.pos[0],
                        z: p.pos[2],
                        scale: propScale,
                        behavior: propBehavior(p.variant),
                        collected: false,
                    });
                }
            }
        }
    }

    const focus = { rc: 0, rr: 0 };
    const startCenter = roomWorldCenter(dungeon, focus.rc, focus.rr);
    const playerPos = { x: startCenter[0], z: startCenter[2] };
    const playerInstance: RenderInstance = {
        nodeId: 'player',
        nodeName: 'player',
        meshAssetId: player.meshId,
        materialId: 'mat:player',
        visible: true,
        worldMatrix: playerMatrix(playerPos.x, playerPos.z),
    };
    const instances = [...staticInstances, playerInstance];

    const camTarget: [number, number, number] = [...startCenter];
    const camera = create_camera({
        position: [startCenter[0] + CAM_OFFSET[0], CAM_OFFSET[1], startCenter[2] + CAM_OFFSET[2]],
        target: startCenter,
        near: 0.1,
        far: 200,
        fovYRadians: CAM_FOV,
    });

    const canvas = document.createElement('canvas');
    canvas.style.touchAction = 'none';
    root.appendChild(canvas);

    const renderer = await Renderer.create(canvas, materials, meshes, instances, camera, {
        width: GAME_WIDTH,
        height: GAME_HEIGHT,
        retroRenderScale: 1,
        maxPixelRatio: 2,
        lockAspectRatio: true,
        targetAspectRatio: GAME_WIDTH / GAME_HEIGHT,
        viewBackgroundColor: '#0c0e12',
    });
    renderer.setWireframeEnabled(false); // core Renderer defaults wireframe ON
    window.addEventListener('resize', () => renderer.resize());

    game = {
        renderer,
        camera,
        hud: createHud(root),
        instances,
        roomTiles,
        propTiles,
        collectedCount: 0,
        playerInstance,
        focus,
        visited: new Set<string>([roomKey(focus.rc, focus.rr)]),
        transition: null,
        player: playerPos,
        camTarget,
    };

    // setAnimationLoop calls this each frame and draws afterwards, so the
    // camera/instance updates below land in the same frame.
    renderer.setAnimationLoop((frame) => {
        gameUpdate(frame.deltaTime, frame.elapsedTime);
        renderer.updateCamera(camera);
        renderer.updateRenderInstances(instances);
    });
}

// The primitives are unit-sized and centered on the origin, so the player is
// lifted by half its scale to stand on the floor plane (y = 0).
function playerMatrix(x: number, z: number): Float32Array {
    return dungeonInstanceMatrix([x, PLAYER_SCALE / 2, z], [PLAYER_SCALE, PLAYER_SCALE, PLAYER_SCALE]);
}

function gameUpdate(dt: number, now: number): void {
    const g = game;
    if (!g) return;

    if (g.transition) {
        // Room scroll in progress: slide camera + player together, no input.
        const tr = g.transition;
        tr.t = Math.min(1, tr.t + dt / TRANSITION_DURATION);
        const e = smoothstep(tr.t);
        g.camTarget[0] = lerp(tr.fromCenter[0], tr.toCenter[0], e);
        g.camTarget[1] = lerp(tr.fromCenter[1], tr.toCenter[1], e);
        g.camTarget[2] = lerp(tr.fromCenter[2], tr.toCenter[2], e);
        g.player.x = lerp(tr.fromPlayer[0], tr.toPlayer[0], e);
        g.player.z = lerp(tr.fromPlayer[1], tr.toPlayer[1], e);
        if (tr.t >= 1) g.transition = null;
    } else {
        // Camera locked on the focused room.
        const focusCenter = roomWorldCenter(dungeon, g.focus.rc, g.focus.rr);
        g.camTarget[0] = focusCenter[0];
        g.camTarget[1] = focusCenter[1];
        g.camTarget[2] = focusCenter[2];

        let dx = 0;
        let dz = 0;
        if (keyDown('ArrowLeft')) dx -= 1;
        if (keyDown('ArrowRight')) dx += 1;
        if (keyDown('ArrowUp')) dz -= 1;
        if (keyDown('ArrowDown')) dz += 1;
        if (dx !== 0 || dz !== 0) {
            const len = Math.hypot(dx, dz);
            const step = (MOVE_SPEED * dt) / len;
            const nx = g.player.x + dx * step;
            const nz = g.player.z + dz * step;
            if (!playerHitsWall(nx, g.player.z)) g.player.x = nx;
            if (!playerHitsWall(g.player.x, nz)) g.player.z = nz;
        }

        // Collection triggers: walking over a collectible prop in the current
        // room picks it up (hidden for good + counted).
        const focusKey = roomKey(g.focus.rc, g.focus.rr);
        for (const prop of g.propTiles) {
            if (prop.collected || !prop.behavior.collect || prop.roomKey !== focusKey) continue;
            if (Math.hypot(g.player.x - prop.x, g.player.z - prop.z) <= PROP_PICKUP_RADIUS) {
                prop.collected = true;
                prop.inst.visible = false;
                g.collectedCount++;
            }
        }

        // Doorway crossing -> start a scroll that carries camera + player into
        // the neighbour room in lockstep (the door-band position is the
        // player's slide start, the neighbour's inset opening is the end).
        for (const trig of buildRoomDoorTriggers(dungeon, g.focus.rc, g.focus.rr)) {
            if (g.player.x >= trig.minX && g.player.x <= trig.maxX && g.player.z >= trig.minZ && g.player.z <= trig.maxZ) {
                const from = g.focus;
                g.focus = { ...trig.to };
                const toKey = roomKey(g.focus.rc, g.focus.rr);
                g.visited.add(toKey); // reveal the destination for the whole slide
                g.transition = {
                    fromCenter: roomWorldCenter(dungeon, from.rc, from.rr),
                    toCenter: roomWorldCenter(dungeon, g.focus.rc, g.focus.rr),
                    fromPlayer: [g.player.x, g.player.z],
                    toPlayer: [trig.spawn[0], trig.spawn[2]],
                    fromKey: roomKey(from.rc, from.rr),
                    toKey,
                    t: 0,
                };
                break;
            }
        }
    }

    // Fog of war: the on-screen rooms (both ends of a slide, else just the
    // focus) render bright; other visited rooms render dim; unvisited rooms
    // stay hidden. Applied to the shared instance array the renderer reads.
    const litA = g.transition ? g.transition.fromKey : roomKey(g.focus.rc, g.focus.rr);
    const litB = g.transition ? g.transition.toKey : litA;
    for (const tile of g.roomTiles) {
        if (!g.visited.has(tile.roomKey)) {
            tile.inst.visible = false;
            continue;
        }
        tile.inst.visible = true;
        const lit = tile.roomKey === litA || tile.roomKey === litB;
        tile.inst.materialId = lit ? tile.matBright : tile.matDim;
    }

    // Props: keep collected ones hidden (the fog pass above re-shows every tile
    // in a visited room), and animate the rest — spin around Y and/or bob, both
    // driven off the clock so they stay in sync regardless of frame rate.
    for (const prop of g.propTiles) {
        if (prop.collected) {
            prop.inst.visible = false;
            continue;
        }
        const b = prop.behavior;
        if (!propAnimates(b)) continue;
        const rotY = b.spin ? now * b.spin * Math.PI * 2 : 0;
        // Ride 0..bobHeight so a prop never sinks through the floor.
        const y = b.bobHeight ? b.bobHeight * (0.5 + 0.5 * Math.sin(now * (b.bobSpeed ?? 1) * Math.PI * 2)) : 0;
        prop.inst.worldMatrix = dungeonPropMatrix([prop.x, y, prop.z], [prop.scale, prop.scale, prop.scale], rotY);
    }

    g.playerInstance.worldMatrix = playerMatrix(g.player.x, g.player.z);
    g.camera.target = [g.camTarget[0], g.camTarget[1], g.camTarget[2]];
    g.camera.position = [g.camTarget[0] + CAM_OFFSET[0], CAM_OFFSET[1] + g.camTarget[1], g.camTarget[2] + CAM_OFFSET[2]];

    g.hud.room.textContent = `Room ${g.focus.rc},${g.focus.rr}`;
    g.hud.collected.textContent = `Collected ${g.collectedCount}`;
}

// Expose for headless verification (drive_dungeon.mjs). press/release drive the
// testKeys override; state() reads gameplay state.
(window as unknown as { __dungeon: unknown }).__dungeon = {
    state: () =>
        game
            ? {
                  focus: game.focus,
                  player: { ...game.player },
                  camTarget: [...game.camTarget],
                  visited: [...game.visited],
                  collectedCount: game.collectedCount,
                  // y / m0 come straight off the live world matrix so tests can
                  // observe the bob (translation Y) and spin (basis X) animating.
                  props: game.propTiles.map((p) => ({
                      room: p.roomKey,
                      x: p.x,
                      z: p.z,
                      collectible: !!p.behavior.collect,
                      collected: p.collected,
                      y: p.inst.worldMatrix[13],
                      m0: p.inst.worldMatrix[0],
                  })),
              }
            : null,
    press: (code: string) => testKeys.add(code),
    release: (code: string) => testKeys.delete(code),
    roomIndex: (rc: number, rr: number) => roomIndex(dungeon, rc, rr),
    // Categories -> part names discovered in src/assets/dungeon/*.txt.
    catalog: () =>
        Object.fromEntries([...loadDungeonCatalog().entries()].map(([category, cat]) => [category, cat.parts.map((p) => p.name)])),
};

const app = document.getElementById('app');
if (!app) {
    fail(new Error('Missing #app root element.'));
} else {
    app.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#000;overflow:hidden';
    void setup(app).catch(fail);
}
