// Dungeon preview — walks a generated dungeon in the real game harness, so the
// editor's "Preview in game" button shows the thing the game would build:
// same run loop, same retro renderer, same entities, same collision grid.
//
// Dev-only page (not a build input). Which dungeon it loads comes from
// ?dungeon=<name>; the editor passes the one you were editing.
//
// This is the Zelda room-crawler in miniature: walk into a door opening and the
// camera slides to the next room. Everything else (hearts, pickups, enemies) is
// game code that belongs in main.ts, not here.

import { entities, spawnEntity } from './assets/entities';
import { move } from './controls';
import { type Dungeon, isSolidAt, roomAtWorld, roomCenter, roomIndex, TILE_FLOOR, tileIndex } from './lib/dungeon';
import type { EntityBlueprint } from './lib/entity';
import { faceToward } from './lib/entity';
import type { Object3D } from './lib/object3d';
import { cube } from './primitives';
import { camera, run, scene } from './run';

type DungeonModule = { dungeon: Dungeon; buildDungeon: () => Object3D };
const MODULES = import.meta.glob('./assets/dungeons/*.ts', { eager: true }) as Record<string, DungeonModule>;

const wanted = new URLSearchParams(window.location.search).get('dungeon');
const entry =
    Object.entries(MODULES).find(([path]) => path.endsWith(`/${wanted}.ts`)) ?? Object.entries(MODULES)[0];
if (!entry) throw new Error('No dungeons in src/assets/dungeons — paint one in /editor_dungeon.html first.');
const [modulePath, module] = entry;
const dungeon = module.dungeon;
document.title = `Dungeon Preview — ${modulePath.split('/').pop()!.replace(/\.ts$/, '')}`;

// The player is the entity blueprint tagged 'player'. If one is painted on the
// map, that placement IS the player (no second copy); otherwise it spawns in
// the middle of the first walkable tile of room 0,0.
// The registry's literal types differ per entity; widen once to read it as data.
const blueprints = entities as Record<string, EntityBlueprint>;
const playerName = Object.keys(blueprints).find((name) => blueprints[name].tags?.includes('player'));
const DEFAULT_RADIUS = 0.35;
const radius = (playerName ? blueprints[playerName].radius : undefined) ?? DEFAULT_RADIUS;

const SPEED = 5;
const CAM_LERP = 6; // per second; how fast the camera slides between rooms

// A room-crawler's fixed three-quarter view: pulled back far enough that the
// whole room fits, tilted so you read the floor plan but still see wall faces.
const CAM_PITCH = (55 * Math.PI) / 180;
const camDistance = Math.max(dungeon.tileCols * 0.82, dungeon.tileRows * 1.05);
const CAM_HEIGHT = camDistance * Math.sin(CAM_PITCH);
const CAM_BACK = camDistance * Math.cos(CAM_PITCH);
// A tilted view foreshortens the far half, so aiming at the exact room centre
// leaves it sitting low; aim slightly nearer to centre it on screen.
const CAM_AIM = dungeon.tileRows * 0.07;

let player: Object3D;
let room = { rc: 0, rr: 0 };
let camAt: [number, number] = [0, 0];
// Room groups in `dungeon.rooms` order, so only the room you are in draws.
let roomGroups: Object3D[] = [];
let leaving = -1;
let slide = 1;

/** A walkable tile to drop the player on: the room's centre, else its first floor. */
function startTile(rc: number, rr: number): [number, number] {
    const [cx, , cz] = roomCenter(dungeon, rc, rr);
    if (!isSolidAt(dungeon, cx, cz)) return [cx, cz];
    const tiles = dungeon.rooms[roomIndex(dungeon, rc, rr)]?.tiles ?? [];
    for (let tz = 0; tz < dungeon.tileRows; tz++) {
        for (let tx = 0; tx < dungeon.tileCols; tx++) {
            if (tiles[tileIndex(dungeon, tx, tz)] !== TILE_FLOOR) continue;
            const [ox, , oz] = roomCenter(dungeon, rc, rr);
            return [ox - dungeon.tileCols / 2 + tx + 0.5, oz - dungeon.tileRows / 2 + tz + 0.5];
        }
    }
    return [cx, cz];
}

// Only the room you are in is drawn — plus the one you just left, while the
// camera is still sliding, so the transition reads as movement between rooms.
function showRooms(): void {
    const here = roomIndex(dungeon, room.rc, room.rr);
    roomGroups.forEach((group, i) => {
        group.visible = i === here || (i === leaving && slide < 1);
    });
}

function init(): void {
    const world = module.buildDungeon();
    scene.add(world);
    roomGroups = world.children;

    const placed = playerName ? world.getObjectByName(`entity:${playerName}`) : null;
    if (placed) {
        // A player-tagged entity painted on the map IS the player — no second
        // copy. Re-parented to the scene so hiding its room can't hide it
        // (room groups sit at the origin, so its world position is unchanged).
        player = placed;
        scene.add(placed);
    } else {
        player = playerName ? spawnEntity(playerName as keyof typeof entities) : cube({ color: 8 });
        if (!playerName) player.scale.set(0.5, 0.5, 0.5);
        const [x, z] = startTile(0, 0);
        player.position.set(x, playerName ? 0 : 0.25, z);
        scene.add(player);
    }

    room = roomAtWorld(dungeon, player.position.x, player.position.z);
    const [cx, , cz] = roomCenter(dungeon, room.rc, room.rr);
    camAt = [cx, cz];
    camera.position.set(cx, CAM_HEIGHT, cz + CAM_BACK);
    camera.lookAt(cx, 0, cz + CAM_AIM);
    showRooms();
}

/** Would a circle of `radius` at (x, z) overlap a wall or a pit? */
function blocked(x: number, z: number): boolean {
    return (
        isSolidAt(dungeon, x - radius, z - radius) ||
        isSolidAt(dungeon, x + radius, z - radius) ||
        isSolidAt(dungeon, x - radius, z + radius) ||
        isSolidAt(dungeon, x + radius, z + radius)
    );
}

function update(dt: number): void {
    const m = move();
    // Axis at a time, so running into a wall slides along it instead of sticking.
    const nx = player.position.x + m.x * SPEED * dt;
    const nz = player.position.z + m.z * SPEED * dt;
    if (m.x !== 0 && !blocked(nx, player.position.z)) player.position.x = nx;
    if (m.z !== 0 && !blocked(player.position.x, nz)) player.position.z = nz;
    faceToward(player, m.x, m.z);

    // Crossing a door opening puts the player in the neighbour room; the camera
    // eases after them — the room transition.
    const now = roomAtWorld(dungeon, player.position.x, player.position.z);
    if (now.rc !== room.rc || now.rr !== room.rr) {
        leaving = roomIndex(dungeon, room.rc, room.rr);
        slide = 0;
        room = now;
    }
    slide = Math.min(1, slide + dt * CAM_LERP * 0.5);
    showRooms();

    const [tx, , tz] = roomCenter(dungeon, room.rc, room.rr);
    const k = Math.min(1, CAM_LERP * dt);
    camAt = [camAt[0] + (tx - camAt[0]) * k, camAt[1] + (tz - camAt[1]) * k];
    camera.position.set(camAt[0], CAM_HEIGHT, camAt[1] + CAM_BACK);
    camera.lookAt(camAt[0], 0, camAt[1] + CAM_AIM);
}

run({ init, update });
