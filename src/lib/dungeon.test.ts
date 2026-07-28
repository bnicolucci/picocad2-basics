import { describe, expect, test } from 'bun:test';
import {
    buildRoom,
    doorTileSpan,
    GROUNDS,
    isSolidAt,
    loadDungeonCatalog,
    makeDungeon,
    makeRoom,
    PROPS,
    resolveTile,
    roomCenter,
    roomIndex,
    sanitizeDungeon,
    TILE_EMPTY,
    TILE_FLOOR,
    TILE_WALL,
    tileCenter,
    tileIndex,
    WALLS,
} from './dungeon';
import { Object3D } from './object3d';
import { tinyModelText } from './testModels';

const catalog = loadDungeonCatalog({
    [GROUNDS]: tinyModelText(['grassy', 'dirty', 'sandy']),
    [WALLS]: tinyModelText(['wall', 'pillar']),
    [PROPS]: tinyModelText(['crate', 'gem']),
});

const noDoors = { top: false, bottom: false, left: false, right: false };

describe('makeRoom / makeDungeon', () => {
    test('a plain room is a solid wall border around floor', () => {
        const room = makeRoom(6, 5, noDoors);
        const d = { tileCols: 6 };
        expect(room.tiles[tileIndex(d, 0, 0)]).toBe(TILE_WALL);
        expect(room.tiles[tileIndex(d, 5, 4)]).toBe(TILE_WALL);
        expect(room.tiles[tileIndex(d, 3, 2)]).toBe(TILE_FLOOR);
    });

    test('a door punches an opening in the middle of its edge', () => {
        const room = makeRoom(6, 5, { ...noDoors, top: true });
        const [x0, x1] = doorTileSpan(6);
        for (let tx = x0; tx <= x1; tx++) expect(room.tiles[tileIndex({ tileCols: 6 }, tx, 0)]).toBe(TILE_FLOOR);
        expect(room.tiles[tileIndex({ tileCols: 6 }, x0 - 1, 0)]).toBe(TILE_WALL);
    });

    test('a fresh dungeon connects every room to its neighbours', () => {
        const dungeon = makeDungeon(2, 2, 8, 8);
        expect(dungeon.rooms).toHaveLength(4);
        expect(dungeon.rooms[roomIndex(dungeon, 0, 0)].doors).toEqual({ top: false, bottom: true, left: false, right: true });
        expect(dungeon.rooms[roomIndex(dungeon, 1, 1)].doors).toEqual({ top: true, bottom: false, left: true, right: false });
    });
});

describe('world coordinates', () => {
    const dungeon = makeDungeon(2, 2, 16, 12);

    test('rooms tile the world without gaps', () => {
        expect(roomCenter(dungeon, 0, 0)).toEqual([8, 0, 6]);
        expect(roomCenter(dungeon, 1, 0)).toEqual([24, 0, 6]);
        expect(roomCenter(dungeon, 0, 1)).toEqual([8, 0, 18]);
    });

    test('tiles are one unit and centred on the half', () => {
        expect(tileCenter(dungeon, 0, 0, 0, 0)).toEqual([0.5, 0, 0.5]);
        expect(tileCenter(dungeon, 1, 0, 0, 0)).toEqual([16.5, 0, 0.5]);
    });
});

describe('resolveTile', () => {
    const dungeon = makeDungeon(1, 1, 8, 8);
    const room = dungeon.rooms[0];

    test('a wall tile resolves floor + wall, never a prop', () => {
        const tile = resolveTile(dungeon, catalog, 0, 0, 0, 0);
        expect(tile.wall).toBe('wall'); // auto = the file's first part
        expect(tile.floor).not.toBeNull();
        expect(tile.prop).toBeNull();
    });

    test('an auto floor is deterministic but varies across tiles', () => {
        const at = (tx: number, tz: number): string | null => resolveTile(dungeon, catalog, 0, 0, tx, tz).floor;
        expect(at(3, 3)).toBe(at(3, 3)!);
        const picks = new Set([at(1, 1), at(2, 1), at(3, 1), at(1, 2), at(2, 2), at(3, 2), at(4, 3), at(5, 4)]);
        expect(picks.size).toBeGreaterThan(1);
    });

    test('a painted part wins over the auto pick', () => {
        room.floorParts = { [tileIndex(dungeon, 3, 3)]: 'sandy' };
        expect(resolveTile(dungeon, catalog, 0, 0, 3, 3).floor).toBe('sandy');
    });

    // Part libraries are edited outside this repo; a renamed part must not
    // crash or blank a tile.
    test('a part name that no longer exists falls back to the auto pick', () => {
        room.wallParts = { [tileIndex(dungeon, 0, 0)]: 'gone' };
        expect(resolveTile(dungeon, catalog, 0, 0, 0, 0).wall).toBe('wall');
    });

    test('a pit resolves to nothing at all', () => {
        room.tiles[tileIndex(dungeon, 4, 4)] = TILE_EMPTY;
        expect(resolveTile(dungeon, catalog, 0, 0, 4, 4)).toEqual({ floor: null, wall: null, prop: null });
    });

    test('a missing category resolves to null instead of throwing', () => {
        const bare = loadDungeonCatalog({ [GROUNDS]: tinyModelText(['grassy']) });
        expect(resolveTile(dungeon, bare, 0, 0, 0, 0).wall).toBeNull();
    });
});

describe('sanitizeDungeon', () => {
    test('round-trips a dungeon unchanged', () => {
        const dungeon = makeDungeon(2, 2, 8, 8);
        dungeon.rooms[0].floorParts = { 9: 'sandy' };
        dungeon.rooms[0].entities = { 10: { name: 'pig', yaw: 90 } };
        expect(sanitizeDungeon(JSON.parse(JSON.stringify(dungeon)))).toEqual(dungeon);
    });

    test('regenerates a room whose tile data is the wrong length', () => {
        const broken = { ...makeDungeon(1, 1, 8, 8), rooms: [{ tiles: [1, 2, 1], doors: noDoors }] };
        expect(sanitizeDungeon(broken).rooms[0].tiles).toHaveLength(64);
    });

    // Hand-edited or older saves reach this untyped, so the malformed entries
    // are the point: they must be dropped, not crash the editor.
    test('drops overlay keys that are out of range or malformed', () => {
        const base = makeDungeon(1, 1, 8, 8);
        const clean = sanitizeDungeon({
            ...base,
            rooms: [{
                tiles: base.rooms[0].tiles,
                doors: base.rooms[0].doors,
                floorParts: { 5: 'sandy', 9999: 'sandy', '-1': 'sandy', 6: '' },
                entities: { 7: { name: 'pig' }, 8: { name: '' }, 9: {} },
            }],
        });
        expect(clean.rooms[0].floorParts).toEqual({ 5: 'sandy' });
        expect(clean.rooms[0].entities).toEqual({ 7: { name: 'pig' } });
    });

    test('empty overlays stay out of the save entirely', () => {
        const clean = sanitizeDungeon({ ...makeDungeon(1, 1, 8, 8), rooms: [{ tiles: makeRoom(8, 8, noDoors).tiles, doors: noDoors, propParts: {} }] });
        expect('propParts' in clean.rooms[0]).toBe(false);
    });
});

describe('isSolidAt', () => {
    const dungeon = makeDungeon(1, 1, 8, 8);

    test('floor is walkable, wall and pit are not', () => {
        expect(isSolidAt(dungeon, 4.5, 4.5)).toBe(false);
        expect(isSolidAt(dungeon, 0.5, 0.5)).toBe(true);
        dungeon.rooms[0].tiles[tileIndex(dungeon, 3, 3)] = TILE_EMPTY;
        expect(isSolidAt(dungeon, 3.5, 3.5)).toBe(true);
    });

    test('off the grid is solid, so nothing can walk out of the dungeon', () => {
        expect(isSolidAt(dungeon, -1, 4)).toBe(true);
        expect(isSolidAt(dungeon, 4, 999)).toBe(true);
    });
});

describe('buildRoom', () => {
    const dungeon = makeDungeon(1, 1, 6, 6);

    test('places parts at tile centres in world space', () => {
        const group = buildRoom(dungeon, 0, 0, catalog);
        const first = group.children[0];
        expect([first.position.x, first.position.y, first.position.z]).toEqual([0.5, 0, 0.5]);
    });

    test('rooms sit side by side in world space', () => {
        const wide = makeDungeon(2, 1, 6, 6);
        expect(buildRoom(wide, 1, 0, catalog).children[0].position.x).toBe(6.5);
    });

    // The play page finds the player by this name; losing it silently breaks
    // "a painted player-tagged entity is the player".
    test('names each spawned entity entity:<name>', () => {
        dungeon.rooms[0].entities = { [tileIndex(dungeon, 2, 2)]: { name: 'pig', yaw: 90 } };
        const group = buildRoom(dungeon, 0, 0, catalog, (name) => {
            const object = new Object3D();
            object.name = name;
            return object;
        });
        const pig = group.getObjectByName('entity:pig');
        expect(pig).not.toBeNull();
        expect([pig!.position.x, pig!.position.z]).toEqual([2.5, 2.5]);
        expect(pig!.rotation.y).toBeCloseTo(Math.PI / 2);
    });

    test('an entity the registry no longer has spawns nothing instead of throwing', () => {
        dungeon.rooms[0].entities = { [tileIndex(dungeon, 2, 2)]: { name: 'deleted' } };
        expect(() => buildRoom(dungeon, 0, 0, catalog, () => null)).not.toThrow();
    });
});
