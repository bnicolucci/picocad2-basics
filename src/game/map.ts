import { clamp, groundTransform } from '../lib/math';
import type { Instance } from '../lib/renderer';
import type { EnemyKind } from './enemy';
import type { World } from './world';

// --- Room / world constants (world units) ---------------------------------
const ROOM_W = 14; // x extent
const ROOM_D = 10; // z extent
const HX = ROOM_W / 2;
const HZ = ROOM_D / 2;
const WALL_H = 1.5;
const WALL_T = 0.6;
const DOOR_W = 3;
const ENTITY_R = 0.5;
const LIMIT_X = HX - WALL_T / 2 - ENTITY_R;
const LIMIT_Z = HZ - WALL_T / 2 - ENTITY_R;

export type Dir = 'north' | 'south' | 'east' | 'west';
type Ground = { x: number; z: number };

// The room the player starts in and respawns to on death.
export const SPAWN_ROOM = 'A';

type EnemySpawn = { kind: EnemyKind; x: number; z: number };
// radius defaults to 0.5 (the unit primitives' footprint) when omitted.
type Prop = { model: string; x: number; z: number; radius?: number };
type RoomDef = {
    doors: Partial<Record<Dir, string>>;
    props: Prop[];
    enemies: EnemySpawn[];
};

const ROOMS: Record<string, RoomDef> = {
    A: { doors: { north: 'B' }, props: [{ model: 'mesh_sphere', x: -4, z: -2 }], enemies: [{ kind: 'wander', x: 3, z: 2 }] },
    B: { doors: { south: 'A', east: 'C' }, props: [{ model: 'mesh_cylinder', x: 4, z: 2 }], enemies: [{ kind: 'chaser', x: 0, z: -2 }] },
    C: { doors: { west: 'B' }, props: [{ model: 'mesh_cube', x: 0, z: 0 }], enemies: [{ kind: 'chaser', x: -3, z: 2 }, { kind: 'wander', x: 3, z: -2 }] },
};

function room(w: World): RoomDef {
    return ROOMS[w.roomId];
}

export function roomEnemySpawns(w: World): EnemySpawn[] {
    return room(w).enemies;
}

// Static circle colliders in the current room (props).
export function roomColliders(w: World): { x: number; z: number; radius: number }[] {
    return room(w).props.map((p) => ({ x: p.x, z: p.z, radius: p.radius ?? 0.5 }));
}

// Keeps a ground position inside the room walls, but allows walking into an
// aligned doorway (past the wall line) so a transition can trigger.
export function clampToRoom(w: World, pos: Ground): void {
    const doors = room(w).doors;
    const inDoorX = Math.abs(pos.x) < DOOR_W / 2;
    const inDoorZ = Math.abs(pos.z) < DOOR_W / 2;
    const zMin = inDoorX && doors.north ? -HZ - 1 : -LIMIT_Z;
    const zMax = inDoorX && doors.south ? HZ + 1 : LIMIT_Z;
    const xMin = inDoorZ && doors.west ? -HX - 1 : -LIMIT_X;
    const xMax = inDoorZ && doors.east ? HX + 1 : LIMIT_X;
    pos.z = clamp(pos.z, zMin, zMax);
    pos.x = clamp(pos.x, xMin, xMax);
}

// Which door (if any) the player has stepped through this frame.
export function doorCrossed(w: World): Dir | null {
    const p = w.player;
    const doors = room(w).doors;
    const inDoorX = Math.abs(p.x) < DOOR_W / 2;
    const inDoorZ = Math.abs(p.z) < DOOR_W / 2;
    if (inDoorX && doors.north && p.z <= -HZ) return 'north';
    if (inDoorX && doors.south && p.z >= HZ) return 'south';
    if (inDoorZ && doors.east && p.x >= HX) return 'east';
    if (inDoorZ && doors.west && p.x <= -HX) return 'west';
    return null;
}

// Move into the room connected by `exitDir`, placing the player at the opposite
// doorway. Enemy respawn is the caller's job (game.ts owns entity creation).
export function enterRoom(w: World, exitDir: Dir): void {
    w.roomId = room(w).doors[exitDir]!;
    // You arrive at the door on the opposite side from the one you exited.
    const inset = 1.2;
    if (exitDir === 'north') (w.player.x = 0), (w.player.z = HZ - inset);
    else if (exitDir === 'south') (w.player.x = 0), (w.player.z = -HZ + inset);
    else if (exitDir === 'west') (w.player.x = HX - inset), (w.player.z = 0);
    else (w.player.x = -HX + inset), (w.player.z = 0);
}

// Room geometry (floor/walls/props) only changes when roomId changes, so
// it's cached instead of rebuilt every draw() call.
let cachedRoomId: string | null = null;
let cachedInstances: Instance[] = [];

export function mapInstances(w: World): Instance[] {
    if (w.roomId !== cachedRoomId) {
        cachedRoomId = w.roomId;
        cachedInstances = buildRoomInstances(w);
    }
    return cachedInstances;
}

function buildRoomInstances(w: World): Instance[] {
    const out: Instance[] = [];
    const def = room(w);

    out.push({
        model: w.handles.mesh_plane,
        matrix: groundTransform(0, 0, 0, 0, { x: ROOM_W, y: 1, z: ROOM_D }),
        uv: { repeatU: 7, repeatV: 5 }, // tile the floor texture instead of stretching it
    });

    for (const seg of wallSegments(def.doors)) {
        out.push({
            model: w.handles.mesh_cube,
            matrix: groundTransform(seg.x, WALL_H / 2, seg.z, 0, { x: seg.sx, y: WALL_H, z: seg.sz }),
        });
    }

    for (const prop of def.props) {
        out.push({
            model: w.handles[prop.model],
            matrix: groundTransform(prop.x, 0.5, prop.z, 0),
        });
    }

    return out;
}

type Seg = { x: number; z: number; sx: number; sz: number };

// One or two wall segments per edge; a door leaves a centered gap.
function wallSegments(doors: Partial<Record<Dir, string>>): Seg[] {
    const segs: Seg[] = [];
    const addEdge = (along: 'x' | 'z', fixed: number, hasDoor: boolean) => {
        const full = along === 'x' ? ROOM_W + WALL_T : ROOM_D + WALL_T;
        const make = (center: number, len: number): Seg =>
            along === 'x' ? { x: center, z: fixed, sx: len, sz: WALL_T } : { x: fixed, z: center, sx: WALL_T, sz: len };
        if (!hasDoor) {
            segs.push(make(0, full));
        } else {
            const len = (full - DOOR_W) / 2;
            const off = DOOR_W / 2 + len / 2;
            segs.push(make(-off, len), make(off, len));
        }
    };
    addEdge('x', -HZ, !!doors.north);
    addEdge('x', HZ, !!doors.south);
    addEdge('z', -HX, !!doors.west);
    addEdge('z', HX, !!doors.east);
    return segs;
}
