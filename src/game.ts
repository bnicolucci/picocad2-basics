import { type Camera, createCamera } from './lib/camera';
import { compose } from './lib/math';
import type { Instance, ModelHandle } from './lib/renderer';

// --- Room / world constants (world units) ---------------------------------
const ROOM_W = 14; // x extent
const ROOM_D = 10; // z extent
const HX = ROOM_W / 2;
const HZ = ROOM_D / 2;
const WALL_H = 1.5;
const WALL_T = 0.6;
const DOOR_W = 3;

const PLAYER_SPEED = 7;
const PLAYER_R = 0.5;
const LIMIT_X = HX - WALL_T / 2 - PLAYER_R;
const LIMIT_Z = HZ - WALL_T / 2 - PLAYER_R;

type Dir = 'north' | 'south' | 'east' | 'west';

type RoomDef = {
    // Which wall has a doorway, and which room it leads to.
    doors: Partial<Record<Dir, string>>;
    // A single distinguishing prop so rooms read as different places.
    prop?: { model: string; x: number; z: number };
};

const ROOMS: Record<string, RoomDef> = {
    A: { doors: { north: 'B' }, prop: { model: 'mesh_sphere', x: -4, z: -2 } },
    B: { doors: { south: 'A', east: 'C' }, prop: { model: 'mesh_cylinder', x: 4, z: 2 } },
    C: { doors: { west: 'B' }, prop: { model: 'mesh_cube', x: 0, z: 0 } },
};

type Handles = Record<string, ModelHandle>;

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

export class Game {
    camera: Camera;
    roomId = 'A';
    private handles: Handles;
    private player = { x: 0, z: 0, facing: 0 };

    constructor(handles: Handles) {
        this.handles = handles;
        // Fixed angled top-down camera, framed on the room (centered at origin).
        this.camera = createCamera({ target: [0, 0.5, 0], yaw: 0, pitch: 0.85, distance: 19 });
    }

    private room(): RoomDef {
        return ROOMS[this.roomId];
    }

    update(dt: number, keys: Set<string>): void {
        let dx = 0;
        let dz = 0;
        if (keys.has('w') || keys.has('arrowup')) dz -= 1;
        if (keys.has('s') || keys.has('arrowdown')) dz += 1;
        if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
        if (keys.has('d') || keys.has('arrowright')) dx += 1;

        if (dx !== 0 || dz !== 0) {
            const len = Math.hypot(dx, dz);
            dx /= len;
            dz /= len;
            this.player.x += dx * PLAYER_SPEED * dt;
            this.player.z += dz * PLAYER_SPEED * dt;
            this.player.facing = Math.atan2(dx, dz);
        }

        const doors = this.room().doors;
        const inDoorX = Math.abs(this.player.x) < DOOR_W / 2;
        const inDoorZ = Math.abs(this.player.z) < DOOR_W / 2;

        // Let the player walk into an aligned doorway past the wall line;
        // otherwise clamp to the room interior.
        const zMin = inDoorX && doors.north ? -HZ - 1 : -LIMIT_Z;
        const zMax = inDoorX && doors.south ? HZ + 1 : LIMIT_Z;
        const xMin = inDoorZ && doors.west ? -HX - 1 : -LIMIT_X;
        const xMax = inDoorZ && doors.east ? HX + 1 : LIMIT_X;
        this.player.z = clamp(this.player.z, zMin, zMax);
        this.player.x = clamp(this.player.x, xMin, xMax);

        // Crossing a threshold enters the connected room from the opposite door.
        if (inDoorX && doors.north && this.player.z <= -HZ) this.enter(doors.north, 'south');
        else if (inDoorX && doors.south && this.player.z >= HZ) this.enter(doors.south, 'north');
        else if (inDoorZ && doors.east && this.player.x >= HX) this.enter(doors.east, 'west');
        else if (inDoorZ && doors.west && this.player.x <= -HX) this.enter(doors.west, 'east');
    }

    // Enter `roomId`, arriving at its `side` doorway.
    private enter(roomId: string, side: Dir): void {
        this.roomId = roomId;
        const inset = 1.2;
        if (side === 'south') (this.player.x = 0), (this.player.z = HZ - inset);
        else if (side === 'north') (this.player.x = 0), (this.player.z = -HZ + inset);
        else if (side === 'west') (this.player.x = -HX + inset), (this.player.z = 0);
        else (this.player.x = HX - inset), (this.player.z = 0);
    }

    instances(): Instance[] {
        const out: Instance[] = [];
        const room = this.room();

        // Floor
        out.push({ model: this.handles.mesh_plane, matrix: compose({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: ROOM_W, y: 1, z: ROOM_D }) });

        // Walls (cubes), leaving a gap where a door exists.
        for (const seg of wallSegments(room.doors)) {
            out.push({
                model: this.handles.mesh_cube,
                matrix: compose({ x: seg.x, y: WALL_H / 2, z: seg.z }, { x: 0, y: 0, z: 0 }, { x: seg.sx, y: WALL_H, z: seg.sz }),
            });
        }

        // Prop
        if (room.prop) {
            out.push({
                model: this.handles[room.prop.model],
                matrix: compose({ x: room.prop.x, y: 0.5, z: room.prop.z }, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }),
            });
        }

        // Player (capsule sits at local y 1.2..2.8, so offset it onto the floor).
        out.push({
            model: this.handles.mesh_capsule,
            matrix: compose({ x: this.player.x, y: -1.2, z: this.player.z }, { x: 0, y: this.player.facing, z: 0 }, { x: 1, y: 1, z: 1 }),
        });

        return out;
    }
}

type Seg = { x: number; z: number; sx: number; sz: number };

// One or two wall segments per edge; a door leaves a centered gap.
function wallSegments(doors: Partial<Record<Dir, string>>): Seg[] {
    const segs: Seg[] = [];
    const addEdge = (along: 'x' | 'z', fixed: number, hasDoor: boolean) => {
        const full = along === 'x' ? ROOM_W + WALL_T : ROOM_D + WALL_T;
        const make = (center: number, len: number): Seg =>
            along === 'x'
                ? { x: center, z: fixed, sx: len, sz: WALL_T }
                : { x: fixed, z: center, sx: WALL_T, sz: len };
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
