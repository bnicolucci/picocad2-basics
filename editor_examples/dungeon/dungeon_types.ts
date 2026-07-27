// Dungeon data model for the Zelda-style room-grid game.
//
// A dungeon is a grid of ROOMS (roomCols x roomRows). Each room is a grid of
// TILES (tileCols x tileRows). Tiles carry a paintable type (empty pit / floor
// / wall). Each room edge (top/bottom/left/right) can have a DOOR — a passable
// opening punched in the middle of that edge's wall that connects to the
// neighbouring room. Walking a player into a door trigger slides the camera to
// the adjacent room (handled by the runtime, not this data).
//
// Coordinate convention (shared with the geometry builder + runtime): tiles map
// to world units 1:1. Room (rc, rr) starts at world X = rc*tileCols, Z =
// rr*tileRows. Tile (tx, tz) inside a room centers at (+tx+0.5, +tz+0.5). +tz
// (room row 0 -> increasing) is the room's "top" edge in the 2D editor.

export const ROOM_TILE_COLS = 16;
export const ROOM_TILE_ROWS = 12;

export const TILE_EMPTY = 0;
export const TILE_FLOOR = 1;
export const TILE_WALL = 2;
export type TileType = typeof TILE_EMPTY | typeof TILE_FLOOR | typeof TILE_WALL;

export const DOOR_EDGES = ['top', 'bottom', 'left', 'right'] as const;
export type DoorEdge = (typeof DOOR_EDGES)[number];

export type Room = {
    /** Row-major tileCols*tileRows array of TileType. Index = tz*tileCols + tx. */
    tiles: number[];
    /** Whether an opening exists in the middle of each edge (to an adjacent room). */
    doors: Record<DoorEdge, boolean>;
    /**
     * Sparse maps of tile index -> chosen part name. Absent entries mean "auto"
     * (floor: deterministic random pick; wall: the first wall part). `propParts`
     * places a decorative prop ON a floor tile (an overlay, not the tile type).
     * Sparse so unpainted tiles cost nothing in the save; keys are stringified
     * indices in JSON.
     */
    floorParts?: Record<number, string>;
    wallParts?: Record<number, string>;
    propParts?: Record<number, string>;
};

export type Dungeon = {
    roomCols: number;
    roomRows: number;
    tileCols: number;
    tileRows: number;
    /** Row-major roomCols*roomRows array. Index = rr*roomCols + rc. */
    rooms: Room[];
    /** Optional picoCadPalettes key recolouring every part; omit = authored colours. */
    paletteId?: string;
};

export function roomIndex(dungeon: Pick<Dungeon, 'roomCols'>, rc: number, rr: number): number {
    return rr * dungeon.roomCols + rc;
}

export function tileIndex(dungeon: Pick<Dungeon, 'tileCols'>, tx: number, tz: number): number {
    return tz * dungeon.tileCols + tx;
}

/** The width (in tiles) of a door opening, centered on an edge. */
export const DOOR_WIDTH = 2;

/** Does this room column/row have a neighbour across the given edge? */
export function hasNeighbour(dungeon: Dungeon, rc: number, rr: number, edge: DoorEdge): boolean {
    if (edge === 'top') return rr > 0;
    if (edge === 'bottom') return rr < dungeon.roomRows - 1;
    if (edge === 'left') return rc > 0;
    return rc < dungeon.roomCols - 1;
}

/** The adjacent room coords across an edge, or null if off-grid. */
export function neighbourRoom(dungeon: Dungeon, rc: number, rr: number, edge: DoorEdge): { rc: number; rr: number } | null {
    if (!hasNeighbour(dungeon, rc, rr, edge)) return null;
    if (edge === 'top') return { rc, rr: rr - 1 };
    if (edge === 'bottom') return { rc, rr: rr + 1 };
    if (edge === 'left') return { rc: rc - 1, rr };
    return { rc: rc + 1, rr };
}

/** The tile columns (for top/bottom) or rows (for left/right) spanned by a door opening. */
export function doorTileSpan(count: number): [number, number] {
    const start = Math.floor((count - DOOR_WIDTH) / 2);
    return [start, start + DOOR_WIDTH - 1];
}

// Builds a plain room: solid wall border, floor interior, plus openings punched
// for whichever edges have doors.
export function makeRoom(tileCols: number, tileRows: number, doors: Record<DoorEdge, boolean>): Room {
    const tiles: number[] = new Array(tileCols * tileRows).fill(TILE_FLOOR);
    const set = (tx: number, tz: number, t: TileType): void => {
        tiles[tz * tileCols + tx] = t;
    };
    for (let tx = 0; tx < tileCols; tx++) {
        set(tx, 0, TILE_WALL);
        set(tx, tileRows - 1, TILE_WALL);
    }
    for (let tz = 0; tz < tileRows; tz++) {
        set(0, tz, TILE_WALL);
        set(tileCols - 1, tz, TILE_WALL);
    }
    const [cx0, cx1] = doorTileSpan(tileCols);
    const [cz0, cz1] = doorTileSpan(tileRows);
    if (doors.top) for (let tx = cx0; tx <= cx1; tx++) set(tx, 0, TILE_FLOOR);
    if (doors.bottom) for (let tx = cx0; tx <= cx1; tx++) set(tx, tileRows - 1, TILE_FLOOR);
    if (doors.left) for (let tz = cz0; tz <= cz1; tz++) set(0, tz, TILE_FLOOR);
    if (doors.right) for (let tz = cz0; tz <= cz1; tz++) set(tileCols - 1, tz, TILE_FLOOR);
    return { tiles, doors };
}

// The starting test dungeon: a roomCols x roomRows grid (default 4x4 = 16 rooms),
// every room a plain walled box with doors to every existing neighbour, so the
// whole grid is walkable room-to-room out of the box.
export function makeDefaultDungeon(roomCols = 4, roomRows = 4, tileCols = ROOM_TILE_COLS, tileRows = ROOM_TILE_ROWS): Dungeon {
    const dungeon: Dungeon = { roomCols, roomRows, tileCols, tileRows, rooms: [] };
    for (let rr = 0; rr < roomRows; rr++) {
        for (let rc = 0; rc < roomCols; rc++) {
            const doors: Record<DoorEdge, boolean> = {
                top: rr > 0,
                bottom: rr < roomRows - 1,
                left: rc > 0,
                right: rc < roomCols - 1,
            };
            dungeon.rooms.push(makeRoom(tileCols, tileRows, doors));
        }
    }
    return dungeon;
}

// Keeps only valid `index -> non-empty-string` entries from a raw part map,
// returning undefined when empty (so it stays out of the save).
function sanitizePartMap(src: unknown, tileCount: number): Record<number, string> | undefined {
    const out: Record<number, string> = {};
    const raw = (src ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
        const idx = Number(k);
        if (Number.isInteger(idx) && idx >= 0 && idx < tileCount && typeof v === 'string' && v.length > 0) out[idx] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

// Normalizes/validates loaded JSON into a Dungeon (fills missing tiles/doors),
// so a hand-edited or older save can't crash the editor/runtime.
export function sanitizeDungeon(raw: unknown): Dungeon {
    const d = (raw ?? {}) as Partial<Dungeon>;
    const roomCols = Math.max(1, Math.floor(d.roomCols ?? 4));
    const roomRows = Math.max(1, Math.floor(d.roomRows ?? 4));
    const tileCols = Math.max(3, Math.floor(d.tileCols ?? ROOM_TILE_COLS));
    const tileRows = Math.max(3, Math.floor(d.tileRows ?? ROOM_TILE_ROWS));
    const rooms: Room[] = [];
    const srcRooms = Array.isArray(d.rooms) ? d.rooms : [];
    for (let i = 0; i < roomCols * roomRows; i++) {
        const src = (srcRooms[i] ?? {}) as Partial<Room>;
        const doors: Record<DoorEdge, boolean> = {
            top: !!src.doors?.top,
            bottom: !!src.doors?.bottom,
            left: !!src.doors?.left,
            right: !!src.doors?.right,
        };
        let tiles: number[] = Array.isArray(src.tiles) ? src.tiles.slice(0, tileCols * tileRows).map((t) => (t === 0 || t === 1 || t === 2 ? t : TILE_FLOOR)) : [];
        if (tiles.length !== tileCols * tileRows) {
            // Missing/short tile data -> regenerate a plain room honouring its doors.
            tiles = makeRoom(tileCols, tileRows, doors).tiles;
        }
        // Sparse part overrides: keep only valid in-range indices -> non-empty string.
        const tileCount = tileCols * tileRows;
        const floorParts = sanitizePartMap(src.floorParts, tileCount);
        const wallParts = sanitizePartMap(src.wallParts, tileCount);
        const propParts = sanitizePartMap(src.propParts, tileCount);
        rooms.push({
            tiles,
            doors,
            ...(floorParts ? { floorParts } : {}),
            ...(wallParts ? { wallParts } : {}),
            ...(propParts ? { propParts } : {}),
        });
    }
    const paletteId = typeof d.paletteId === 'string' && d.paletteId.length > 0 ? d.paletteId : undefined;
    return { roomCols, roomRows, tileCols, tileRows, rooms, ...(paletteId ? { paletteId } : {}) };
}
