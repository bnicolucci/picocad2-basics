import { PicoCad2Loader, type PicoCadModel } from './loader';
import { Object3D } from './object3d';

// Dungeons: a grid of ROOMS, each a grid of TILES. A tile is empty (a pit),
// floor, or wall; each room edge can carry a DOOR — an opening punched in the
// middle of that edge connecting to the neighbouring room. Rooms also hold
// sparse overlays: which authored PART fills a floor/wall tile, which prop
// stands on it, and which entity spawns there.
//
// Coordinates: tiles are 1 world unit. Room (rc, rr) starts at world
// X = rc*tileCols, Z = rr*tileRows; tile (tx, tz) centres at (+tx+0.5,
// +tz+0.5). Row 0 is the room's "top" edge in the 2D editor.
//
// Parts come from src/assets/dungeon/*.txt: each FILE is a category
// ("walls", "grounds", "props") and each named mesh node in it is a part
// ("wall", "pillar", "grassy"). Author parts standing on the ground plane
// (y = 0), centred on x/z, about one tile wide — they are placed at a uniform
// tile scale, so what you model is what you get.

export const TILE_SIZE = 1;
/** Cosmetic seam between tiles: each part is shrunk this much so the void
    shows through the grid. Purely visual — tiles stay on the 1-unit grid. */
export const TILE_GAP = 0.08;

export const TILE_EMPTY = 0;
export const TILE_FLOOR = 1;
export const TILE_WALL = 2;
export type TileType = typeof TILE_EMPTY | typeof TILE_FLOOR | typeof TILE_WALL;

export const DOOR_EDGES = ['top', 'bottom', 'left', 'right'] as const;
export type DoorEdge = (typeof DOOR_EDGES)[number];
/** Width, in tiles, of a door opening centred on an edge. */
export const DOOR_WIDTH = 2;

export const GROUNDS = 'grounds';
export const WALLS = 'walls';
export const PROPS = 'props';

/** One entity placed on a tile: a name from the entity registry + its yaw. */
export type RoomEntity = { name: string; /** degrees, default 0 */ yaw?: number };

export type Room = {
    /** Row-major tileCols*tileRows array of TileType. Index = tz*tileCols + tx. */
    tiles: number[];
    doors: Record<DoorEdge, boolean>;
    /** Sparse tile index -> part name. Absent = auto (floors get a
        deterministic per-tile pick, walls the first part). */
    floorParts?: Record<number, string>;
    wallParts?: Record<number, string>;
    /** A decorative prop standing ON a floor tile — an overlay, not a type. */
    propParts?: Record<number, string>;
    /** Sparse tile index -> entity spawned there. */
    entities?: Record<number, RoomEntity>;
};

export type Dungeon = {
    roomCols: number;
    roomRows: number;
    tileCols: number;
    tileRows: number;
    /** Row-major roomCols*roomRows array. Index = rr*roomCols + rc. */
    rooms: Room[];
};

export const ROOM_TILE_COLS = 16;
export const ROOM_TILE_ROWS = 12;

export function roomIndex(dungeon: Pick<Dungeon, 'roomCols'>, rc: number, rr: number): number {
    return rr * dungeon.roomCols + rc;
}

export function tileIndex(dungeon: Pick<Dungeon, 'tileCols'>, tx: number, tz: number): number {
    return tz * dungeon.tileCols + tx;
}

export function roomAt(dungeon: Dungeon, rc: number, rr: number): Room | null {
    return dungeon.rooms[roomIndex(dungeon, rc, rr)] ?? null;
}

/** Does this room have a neighbour across the given edge? */
export function hasNeighbour(dungeon: Dungeon, rc: number, rr: number, edge: DoorEdge): boolean {
    if (edge === 'top') return rr > 0;
    if (edge === 'bottom') return rr < dungeon.roomRows - 1;
    if (edge === 'left') return rc > 0;
    return rc < dungeon.roomCols - 1;
}

/** The room across an edge, or null if off-grid. */
export function neighbourRoom(dungeon: Dungeon, rc: number, rr: number, edge: DoorEdge): { rc: number; rr: number } | null {
    if (!hasNeighbour(dungeon, rc, rr, edge)) return null;
    if (edge === 'top') return { rc, rr: rr - 1 };
    if (edge === 'bottom') return { rc, rr: rr + 1 };
    if (edge === 'left') return { rc: rc - 1, rr };
    return { rc: rc + 1, rr };
}

/** The tile columns (top/bottom) or rows (left/right) a door opening spans. */
export function doorTileSpan(count: number): [number, number] {
    const start = Math.floor((count - DOOR_WIDTH) / 2);
    return [start, start + DOOR_WIDTH - 1];
}

/** World (X, Z) of a room's min corner. */
export function roomOrigin(dungeon: Dungeon, rc: number, rr: number): [number, number] {
    return [rc * dungeon.tileCols * TILE_SIZE, rr * dungeon.tileRows * TILE_SIZE];
}

/** World centre of a room's floor — what a camera looks at. */
export function roomCenter(dungeon: Dungeon, rc: number, rr: number): [number, number, number] {
    const [ox, oz] = roomOrigin(dungeon, rc, rr);
    return [ox + (dungeon.tileCols * TILE_SIZE) / 2, 0, oz + (dungeon.tileRows * TILE_SIZE) / 2];
}

/** World centre of one tile, on the floor plane. */
export function tileCenter(dungeon: Dungeon, rc: number, rr: number, tx: number, tz: number): [number, number, number] {
    const [ox, oz] = roomOrigin(dungeon, rc, rr);
    return [ox + (tx + 0.5) * TILE_SIZE, 0, oz + (tz + 0.5) * TILE_SIZE];
}

// A plain room: solid wall border, floor interior, openings punched for
// whichever edges have doors.
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

// A fresh dungeon: every room a plain walled box with doors to every existing
// neighbour, so the whole grid is walkable out of the box.
export function makeDungeon(roomCols = 3, roomRows = 3, tileCols = ROOM_TILE_COLS, tileRows = ROOM_TILE_ROWS): Dungeon {
    const dungeon: Dungeon = { roomCols, roomRows, tileCols, tileRows, rooms: [] };
    for (let rr = 0; rr < roomRows; rr++) {
        for (let rc = 0; rc < roomCols; rc++) {
            dungeon.rooms.push(
                makeRoom(tileCols, tileRows, {
                    top: rr > 0,
                    bottom: rr < roomRows - 1,
                    left: rc > 0,
                    right: rc < roomCols - 1,
                }),
            );
        }
    }
    return dungeon;
}

function sanitizePartMap(src: unknown, tileCount: number): Record<number, string> | undefined {
    const out: Record<number, string> = {};
    for (const [k, v] of Object.entries((src ?? {}) as Record<string, unknown>)) {
        const idx = Number(k);
        if (Number.isInteger(idx) && idx >= 0 && idx < tileCount && typeof v === 'string' && v.length > 0) out[idx] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeEntityMap(src: unknown, tileCount: number): Record<number, RoomEntity> | undefined {
    const out: Record<number, RoomEntity> = {};
    for (const [k, v] of Object.entries((src ?? {}) as Record<string, unknown>)) {
        const idx = Number(k);
        const entity = v as Partial<RoomEntity> | undefined;
        if (!Number.isInteger(idx) || idx < 0 || idx >= tileCount) continue;
        if (typeof entity?.name !== 'string' || entity.name.length === 0) continue;
        out[idx] = { name: entity.name, ...(typeof entity.yaw === 'number' && entity.yaw !== 0 ? { yaw: entity.yaw } : {}) };
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

/** Normalize loaded data into a Dungeon, so a hand-edited or resized save
    can't crash the editor or the game. */
export function sanitizeDungeon(raw: unknown): Dungeon {
    const d = (raw ?? {}) as Partial<Dungeon>;
    const roomCols = Math.max(1, Math.floor(d.roomCols ?? 3));
    const roomRows = Math.max(1, Math.floor(d.roomRows ?? 3));
    const tileCols = Math.max(4, Math.floor(d.tileCols ?? ROOM_TILE_COLS));
    const tileRows = Math.max(4, Math.floor(d.tileRows ?? ROOM_TILE_ROWS));
    const tileCount = tileCols * tileRows;
    const srcRooms = Array.isArray(d.rooms) ? d.rooms : [];
    const rooms: Room[] = [];
    for (let i = 0; i < roomCols * roomRows; i++) {
        const src = (srcRooms[i] ?? {}) as Partial<Room>;
        const doors: Record<DoorEdge, boolean> = {
            top: !!src.doors?.top,
            bottom: !!src.doors?.bottom,
            left: !!src.doors?.left,
            right: !!src.doors?.right,
        };
        let tiles: number[] = Array.isArray(src.tiles) ? src.tiles.slice(0, tileCount).map((t) => (t === 0 || t === 1 || t === 2 ? t : TILE_FLOOR)) : [];
        // Missing/short tile data -> a plain room honouring its doors.
        if (tiles.length !== tileCount) tiles = makeRoom(tileCols, tileRows, doors).tiles;
        const floorParts = sanitizePartMap(src.floorParts, tileCount);
        const wallParts = sanitizePartMap(src.wallParts, tileCount);
        const propParts = sanitizePartMap(src.propParts, tileCount);
        const entities = sanitizeEntityMap(src.entities, tileCount);
        rooms.push({
            tiles,
            doors,
            ...(floorParts ? { floorParts } : {}),
            ...(wallParts ? { wallParts } : {}),
            ...(propParts ? { propParts } : {}),
            ...(entities ? { entities } : {}),
        });
    }
    return { roomCols, roomRows, tileCols, tileRows, rooms };
}

// --- part catalog -----------------------------------------------------------

/** Category name -> its parsed part library. */
export type DungeonCatalog = Map<string, PicoCadModel>;

const loader = new PicoCad2Loader();

/** Parse the dungeon part files. `texts` is category -> file text, exactly as
    the generated dungeon module imports them. */
export function loadDungeonCatalog(texts: Record<string, string>): DungeonCatalog {
    const catalog: DungeonCatalog = new Map();
    for (const [category, text] of Object.entries(texts)) catalog.set(category, loader.parse(text));
    return catalog;
}

export function categoryParts(catalog: DungeonCatalog, category: string): readonly string[] {
    return catalog.get(category)?.parts ?? [];
}

// Deterministic per-tile variant index in [0, n), keyed on world position so it
// is stable across frames, rooms and reloads. Classic hash-noise.
export function tileVariant(x: number, z: number, n: number): number {
    if (n <= 1) return 0;
    const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
    return Math.floor((s - Math.floor(s)) * n) % n;
}

/** Which parts a tile actually renders. The editor's 2D map resolves tiles
    through this too, so the map and the 3D view can never disagree. */
export type ResolvedTile = { floor: string | null; wall: string | null; prop: string | null };

function namedOr(parts: readonly string[], named: string | undefined, fallback: string | null): string | null {
    if (named !== undefined && parts.includes(named)) return named;
    return fallback;
}

export function resolveTile(dungeon: Dungeon, catalog: DungeonCatalog, rc: number, rr: number, tx: number, tz: number): ResolvedTile {
    const empty: ResolvedTile = { floor: null, wall: null, prop: null };
    const room = roomAt(dungeon, rc, rr);
    if (!room) return empty;
    const idx = tileIndex(dungeon, tx, tz);
    const tile = room.tiles[idx];
    if (tile !== TILE_FLOOR && tile !== TILE_WALL) return empty;

    const grounds = categoryParts(catalog, GROUNDS);
    const [wx, , wz] = tileCenter(dungeon, rc, rr, tx, tz);
    // Floor exists under walls too, so a wall tile still reads as ground.
    const floor = grounds.length === 0 ? null : namedOr(grounds, room.floorParts?.[idx], grounds[tileVariant(wx, wz, grounds.length)]);

    if (tile === TILE_WALL) {
        const walls = categoryParts(catalog, WALLS);
        return { floor, wall: walls.length === 0 ? null : namedOr(walls, room.wallParts?.[idx], walls[0]), prop: null };
    }
    const props = categoryParts(catalog, PROPS);
    return { floor, wall: null, prop: namedOr(props, room.propParts?.[idx], null) };
}

// --- building ---------------------------------------------------------------

const TILE_FOOT = TILE_SIZE - TILE_GAP;
const DEG = Math.PI / 180;

/** Resolves an entity name to a fresh object, or null if it is unknown.
    The generated dungeon module passes the entity registry's spawnEntity. */
export type SpawnEntity = (name: string) => Object3D | null;

function placePart(catalog: DungeonCatalog, category: string, part: string, x: number, z: number): Object3D | null {
    const model = catalog.get(category);
    if (!model) return null;
    const object = model.instantiate({ part });
    object.position.set(x, 0, z);
    object.scale.set(TILE_FOOT, TILE_FOOT, TILE_FOOT);
    return object;
}

/** One room as an Object3D group: its tiles, props and entities, placed in
    world space (so rooms sit side by side in one dungeon group). */
export function buildRoom(dungeon: Dungeon, rc: number, rr: number, catalog: DungeonCatalog, spawn?: SpawnEntity): Object3D {
    const group = new Object3D();
    group.name = `room_${rc}_${rr}`;
    const room = roomAt(dungeon, rc, rr);
    if (!room) return group;

    for (let tz = 0; tz < dungeon.tileRows; tz++) {
        for (let tx = 0; tx < dungeon.tileCols; tx++) {
            const [x, , z] = tileCenter(dungeon, rc, rr, tx, tz);
            const { floor, wall, prop } = resolveTile(dungeon, catalog, rc, rr, tx, tz);
            for (const [category, part] of [[GROUNDS, floor], [WALLS, wall], [PROPS, prop]] as const) {
                if (!part) continue;
                const object = placePart(catalog, category, part, x, z);
                if (object) group.add(object);
            }

            const entity = room.entities?.[tileIndex(dungeon, tx, tz)];
            if (!entity || !spawn) continue;
            const object = spawn(entity.name);
            if (!object) continue;
            // Named so a game can find its placements — getObjectByName
            // returns the first, which is what you want for the player.
            object.name = `entity:${entity.name}`;
            object.position.set(x, 0, z);
            object.rotation.y = (entity.yaw ?? 0) * DEG;
            group.add(object);
        }
    }
    return group;
}

/** Which room a world XZ falls in — unclamped, so it may be off the grid. */
export function roomAtWorld(dungeon: Dungeon, wx: number, wz: number): { rc: number; rr: number } {
    return {
        rc: Math.floor(wx / (dungeon.tileCols * TILE_SIZE)),
        rr: Math.floor(wz / (dungeon.tileRows * TILE_SIZE)),
    };
}

/** Can nothing walk here? Walls, pits and everything off the grid are solid. */
export function isSolidAt(dungeon: Dungeon, wx: number, wz: number): boolean {
    const { rc, rr } = roomAtWorld(dungeon, wx, wz);
    const room = roomAt(dungeon, rc, rr);
    if (!room) return true;
    const [ox, oz] = roomOrigin(dungeon, rc, rr);
    const tx = Math.floor((wx - ox) / TILE_SIZE);
    const tz = Math.floor((wz - oz) / TILE_SIZE);
    if (tx < 0 || tz < 0 || tx >= dungeon.tileCols || tz >= dungeon.tileRows) return true;
    return room.tiles[tileIndex(dungeon, tx, tz)] !== TILE_FLOOR;
}

/** The whole dungeon as one Object3D group of room groups. */
export function buildDungeon(dungeon: Dungeon, catalog: DungeonCatalog, spawn?: SpawnEntity): Object3D {
    const group = new Object3D();
    group.name = 'dungeon';
    for (let rr = 0; rr < dungeon.roomRows; rr++) {
        for (let rc = 0; rc < dungeon.roomCols; rc++) group.add(buildRoom(dungeon, rc, rr, catalog, spawn));
    }
    return group;
}
