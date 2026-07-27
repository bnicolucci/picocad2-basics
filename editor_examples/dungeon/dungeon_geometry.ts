// Pure tilemap -> 3D placement math, shared by the dungeon editor's 3D preview
// and the runtime game so both render byte-identical geometry. Emits abstract
// placements (which primitive + world transform); the caller maps a primitive
// name to an actual mesh/material. No renderer or LittleJS dependency here.

import {
    type DoorEdge,
    doorTileSpan,
    type Dungeon,
    hasNeighbour,
    roomIndex,
    TILE_FLOOR,
    TILE_WALL,
    tileIndex,
} from './dungeon_types';

export const TILE_SIZE = 1;
export const WALL_HEIGHT = 1.2;
export const FLOOR_THICKNESS = 0.1;
// Cosmetic gap between grid cells: each tile's slab is shrunk by this much
// (total, split evenly on all sides) while its center stays on the 1-unit grid,
// so the void shows through the seams. Purely visual — collision is tile-based
// and unaffected. Uniform for now; intended to become per-tile random once we
// settle on a nice range.
export const TILE_GAP = 0.08;

export type DungeonPrim = 'floor' | 'wall' | 'prop';
export type DungeonPlacement = {
    prim: DungeonPrim;
    pos: [number, number, number];
    scale: [number, number, number];
    /** The authored part name for this tile (Room.floorParts/wallParts/propParts),
     *  or undefined = auto. Consumers pick the mesh for the prim's category. */
    variant?: string;
};

/** World-space (X, Z) origin (min corner) of a room. */
export function roomWorldOrigin(dungeon: Dungeon, rc: number, rr: number): [number, number] {
    return [rc * dungeon.tileCols * TILE_SIZE, rr * dungeon.tileRows * TILE_SIZE];
}

/** World-space (X, Y, Z) center of a room's floor — the camera's look-at target. */
export function roomWorldCenter(dungeon: Dungeon, rc: number, rr: number): [number, number, number] {
    const [ox, oz] = roomWorldOrigin(dungeon, rc, rr);
    return [ox + (dungeon.tileCols * TILE_SIZE) / 2, 0, oz + (dungeon.tileRows * TILE_SIZE) / 2];
}

/** World-space center of a single tile's top surface (y = 0 on the floor plane). */
export function tileWorldCenter(dungeon: Dungeon, rc: number, rr: number, tx: number, tz: number): [number, number, number] {
    const [ox, oz] = roomWorldOrigin(dungeon, rc, rr);
    return [ox + (tx + 0.5) * TILE_SIZE, 0, oz + (tz + 0.5) * TILE_SIZE];
}

// Placements for one room. Floor tiles get a thin slab (top at y=0); wall tiles
// get a full-height box sitting on the floor. Empty tiles emit nothing (a pit).
export function buildRoomPlacements(dungeon: Dungeon, rc: number, rr: number): DungeonPlacement[] {
    const out: DungeonPlacement[] = [];
    const room = dungeon.rooms[roomIndex(dungeon, rc, rr)];
    if (!room) return out;
    for (let tz = 0; tz < dungeon.tileRows; tz++) {
        for (let tx = 0; tx < dungeon.tileCols; tx++) {
            const idx = tileIndex(dungeon, tx, tz);
            const t = room.tiles[idx];
            if (t !== TILE_FLOOR && t !== TILE_WALL) continue;
            const [cx, , cz] = tileWorldCenter(dungeon, rc, rr, tx, tz);
            const foot = TILE_SIZE - TILE_GAP; // shrunk footprint leaves the seam gap
            // Floor exists under walls too, so a wall tile still reads as ground.
            out.push({ prim: 'floor', pos: [cx, -FLOOR_THICKNESS / 2, cz], scale: [foot, FLOOR_THICKNESS, foot], variant: room.floorParts?.[idx] });
            if (t === TILE_WALL) {
                out.push({ prim: 'wall', pos: [cx, WALL_HEIGHT / 2, cz], scale: [foot, WALL_HEIGHT, foot], variant: room.wallParts?.[idx] });
            } else {
                // Props stand on floor tiles only (an overlay over the ground).
                const prop = room.propParts?.[idx];
                if (prop) out.push({ prim: 'prop', pos: [cx, 0, cz], scale: [foot, foot, foot], variant: prop });
            }
        }
    }
    return out;
}

/** Placements for every room in the dungeon (used when adjacent rooms must stay visible during a slide). */
export function buildDungeonPlacements(dungeon: Dungeon): DungeonPlacement[] {
    const out: DungeonPlacement[] = [];
    for (let rr = 0; rr < dungeon.roomRows; rr++) {
        for (let rc = 0; rc < dungeon.roomCols; rc++) {
            out.push(...buildRoomPlacements(dungeon, rc, rr));
        }
    }
    return out;
}

export type DoorTrigger = {
    edge: DoorEdge;
    from: { rc: number; rr: number };
    to: { rc: number; rr: number };
    /** World-space AABB (on the XZ plane) the player must enter to cross. */
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    /** Where the player re-appears in the destination room. */
    spawn: [number, number, number];
};

// Door triggers for one room: a thin band across each open, neighbour-backed
// door opening. Crossing it moves the player into the neighbour room and cues
// the camera slide. The destination spawn is just inside the neighbour's
// matching opening so the player doesn't immediately re-trigger.
export function buildRoomDoorTriggers(dungeon: Dungeon, rc: number, rr: number): DoorTrigger[] {
    const room = dungeon.rooms[roomIndex(dungeon, rc, rr)];
    if (!room) return [];
    const [ox, oz] = roomWorldOrigin(dungeon, rc, rr);
    const w = dungeon.tileCols * TILE_SIZE;
    const h = dungeon.tileRows * TILE_SIZE;
    const [cx0, cx1] = doorTileSpan(dungeon.tileCols);
    const [cz0, cz1] = doorTileSpan(dungeon.tileRows);
    const band = 0.6; // trigger band thickness at the opening
    const inset = 1.5; // how far into the destination room the player re-appears
    const triggers: DoorTrigger[] = [];

    const push = (edge: DoorEdge): void => {
        if (!room.doors[edge] || !hasNeighbour(dungeon, rc, rr, edge)) return;
        const to = edge === 'top' ? { rc, rr: rr - 1 } : edge === 'bottom' ? { rc, rr: rr + 1 } : edge === 'left' ? { rc: rc - 1, rr } : { rc: rc + 1, rr };
        const openX0 = ox + cx0 * TILE_SIZE;
        const openX1 = ox + (cx1 + 1) * TILE_SIZE;
        const openZ0 = oz + cz0 * TILE_SIZE;
        const openZ1 = oz + (cz1 + 1) * TILE_SIZE;
        let t: Omit<DoorTrigger, 'edge' | 'from' | 'to' | 'spawn'>;
        let spawn: [number, number, number];
        if (edge === 'top') {
            t = { minX: openX0, maxX: openX1, minZ: oz, maxZ: oz + band };
            spawn = [(openX0 + openX1) / 2, 0, oz - inset];
        } else if (edge === 'bottom') {
            t = { minX: openX0, maxX: openX1, minZ: oz + h - band, maxZ: oz + h };
            spawn = [(openX0 + openX1) / 2, 0, oz + h + inset];
        } else if (edge === 'left') {
            t = { minX: ox, maxX: ox + band, minZ: openZ0, maxZ: openZ1 };
            spawn = [ox - inset, 0, (openZ0 + openZ1) / 2];
        } else {
            t = { minX: ox + w - band, maxX: ox + w, minZ: openZ0, maxZ: openZ1 };
            spawn = [ox + w + inset, 0, (openZ0 + openZ1) / 2];
        }
        triggers.push({ edge, from: { rc, rr }, to, spawn, ...t });
    };
    for (const edge of ['top', 'bottom', 'left', 'right'] as const) push(edge);
    return triggers;
}

/** Which room a world XZ position falls in (unclamped — may be off-grid). */
export function roomAtWorld(dungeon: Dungeon, wx: number, wz: number): { rc: number; rr: number } {
    return {
        rc: Math.floor(wx / (dungeon.tileCols * TILE_SIZE)),
        rr: Math.floor(wz / (dungeon.tileRows * TILE_SIZE)),
    };
}

/** Solid-wall test anywhere in the dungeon (finds the room, then the tile). Off-grid = solid. */
export function isWallAtWorldGlobal(dungeon: Dungeon, wx: number, wz: number): boolean {
    const { rc, rr } = roomAtWorld(dungeon, wx, wz);
    if (rc < 0 || rr < 0 || rc >= dungeon.roomCols || rr >= dungeon.roomRows) return true;
    return isWallAtWorld(dungeon, rc, rr, wx, wz);
}

/** Is a wall tile solid at this world XZ position in the given room? (for player collision) */
export function isWallAtWorld(dungeon: Dungeon, rc: number, rr: number, wx: number, wz: number): boolean {
    const room = dungeon.rooms[roomIndex(dungeon, rc, rr)];
    if (!room) return false;
    const [ox, oz] = roomWorldOrigin(dungeon, rc, rr);
    const tx = Math.floor((wx - ox) / TILE_SIZE);
    const tz = Math.floor((wz - oz) / TILE_SIZE);
    if (tx < 0 || tz < 0 || tx >= dungeon.tileCols || tz >= dungeon.tileRows) return false;
    return room.tiles[tileIndex(dungeon, tx, tz)] === TILE_WALL;
}
