import { describe, expect, test } from 'bun:test';
import { createsCycle, faceToward, insertWithParents, instantiateEntity, removeWithParents } from './entity';
import { Object3D } from './object3d';
import { tinyModelText } from './testModels';

const meshText = (): string => tinyModelText(['body']);

// Parents are array indices, so every insert and remove has to move the
// references that shifted. A mistake here silently re-parents unrelated parts,
// which is invisible until something moves wrongly in game.
describe('editing a parented list', () => {
    const list = (...parents: (number | null)[]): { id: number; parent: number | null }[] =>
        parents.map((parent, id) => ({ id, parent }));
    const shape = (l: { id: number; parent: number | null }[]): string => l.map((p) => `${p.id}:${p.parent}`).join(' ');

    describe('insertWithParents', () => {
        test('references at or past the insert point move up', () => {
            const l = list(null, 0, 1); // 0 <- 1 <- 2
            insertWithParents(l, 1, { id: 9, parent: null });
            // Old parts 1 and 2 slid to slots 2 and 3, so part 2's parent
            // reference to slot 1 has to become slot 2 to still mean part 1.
            expect(shape(l)).toBe('0:null 9:null 1:0 2:2');
        });

        test('references before the insert point are untouched', () => {
            const l = list(null, 0);
            insertWithParents(l, 2, { id: 9, parent: null });
            expect(shape(l)).toBe('0:null 1:0 9:null');
        });

        // Duplicating a part inserts right after it, and the copy keeps the
        // original's parent — which may itself have just shifted.
        test('the inserted item has its own parent shifted too', () => {
            const l = list(null, null);
            insertWithParents(l, 0, { id: 9, parent: 1 });
            expect(shape(l)).toBe('9:2 0:null 1:null');
        });
    });

    describe('removeWithParents', () => {
        test('references past the removal move down', () => {
            const l = list(null, null, 1);
            removeWithParents(l, 0);
            expect(shape(l)).toBe('1:null 2:0');
        });

        test('children of the removed part are promoted to its parent', () => {
            const l = list(null, 0, 1); // 0 <- 1 <- 2
            removeWithParents(l, 1);
            expect(shape(l)).toBe('0:null 2:0'); // 2 now hangs off 0
        });

        test('children of a removed root become roots', () => {
            const l = list(null, 0);
            removeWithParents(l, 0);
            expect(shape(l)).toBe('1:null');
        });

        test('a promoted parent that also shifted is remapped once', () => {
            //  0 root, 1 root, 2 <- 1, 3 <- 2. Removing 2 promotes 3 onto 1.
            const l = list(null, null, 1, 2);
            removeWithParents(l, 2);
            expect(shape(l)).toBe('0:null 1:null 3:1');
        });
    });

    describe('createsCycle', () => {
        test('true when the target is already below the part', () => {
            const l = list(null, 0, 1);
            expect(createsCycle(l, 0, 2)).toBe(true); // 2 is a descendant of 0
        });

        test('false for an unrelated target', () => {
            const l = list(null, null);
            expect(createsCycle(l, 0, 1)).toBe(false);
        });

        test('does not hang on data that already loops', () => {
            const l = list(1, 0);
            expect(createsCycle(l, 0, 1)).toBe(true);
        });
    });
});

describe('instantiateEntity', () => {
    test('builds one child per part and carries the blueprint facing', () => {
        const group = instantiateEntity({ forward: 'x-', parts: [{ mesh: 'a' }, { mesh: 'a' }] }, meshText);
        expect(group.children).toHaveLength(2);
        expect(group.forward).toBe('x-');
    });

    // A part instantiates a whole model, whose own node graph hangs beneath it —
    // so "the parts under X" means X's children that are model roots.
    const partsUnder = (object: Object3D): Object3D[] => object.children.filter((child) => child.model !== undefined);

    // Parts nest so a complex thing can be moved as assemblies: rotate the
    // turret and its barrel comes along.
    test('a part with a parent becomes its child, not the root\'s', () => {
        const group = instantiateEntity({ parts: [{ mesh: 'a' }, { mesh: 'a', parent: 0 }] }, meshText);
        expect(partsUnder(group)).toHaveLength(1);
        expect(partsUnder(partsUnder(group)[0])).toHaveLength(1);
    });

    test('a parent later in the array still links', () => {
        const group = instantiateEntity({ parts: [{ mesh: 'a', parent: 1 }, { mesh: 'a' }] }, meshText);
        expect(partsUnder(group)).toHaveLength(1);
        expect(partsUnder(partsUnder(group)[0])).toHaveLength(1);
    });

    test('nests to any depth', () => {
        const group = instantiateEntity({ parts: [{ mesh: 'a' }, { mesh: 'a', parent: 0 }, { mesh: 'a', parent: 1 }] }, meshText);
        const depth2 = partsUnder(partsUnder(partsUnder(group)[0])[0]);
        expect(depth2).toHaveLength(1);
    });

    // The registry is generated, so a stale or broken index should cost the
    // nesting, not the entity.
    test.each([
        ['out of range', 9],
        ['negative', -1],
        ['itself', 0],
        ['not an integer', 0.5],
    ])('a parent that is %s falls back to the root', (_label, parent) => {
        const group = instantiateEntity({ parts: [{ mesh: 'a', parent: parent as number }] }, meshText);
        expect(partsUnder(group)).toHaveLength(1);
        expect(partsUnder(partsUnder(group)[0])).toHaveLength(0);
    });

    test('a parent loop is broken rather than hanging', () => {
        const group = instantiateEntity({ parts: [{ mesh: 'a', parent: 1 }, { mesh: 'a', parent: 0 }] }, meshText);
        // The cycle is cut by dropping both links, so nothing is lost or looped.
        expect(partsUnder(group)).toHaveLength(2);
    });

    test('defaults to facing z+', () => {
        expect(instantiateEntity({ parts: [{ mesh: 'a' }] }, meshText).forward).toBe('z+');
    });

    // Blueprints store degrees so the generated registry stays hand-readable.
    test('converts part rotation from degrees to radians', () => {
        const group = instantiateEntity({ parts: [{ mesh: 'a', pos: [1, 2, 3], rot: [0, 90, 0], scale: [2, 2, 2] }] }, meshText);
        const part = group.children[0];
        expect([part.position.x, part.position.y, part.position.z]).toEqual([1, 2, 3]);
        expect(part.rotation.y).toBeCloseTo(Math.PI / 2);
        expect(part.scale.x).toBe(2);
    });

    test('parts of the same mesh share one parsed model, so they batch', () => {
        const group = instantiateEntity({ parts: [{ mesh: 'a' }, { mesh: 'a' }] }, meshText);
        expect(group.children[0].model!.model).toBe(group.children[1].model!.model);
    });

    test('a missing mesh throws with the part name, rather than rendering nothing', () => {
        expect(() => instantiateEntity({ parts: [{ mesh: 'gone' }] }, () => undefined)).toThrow(/gone/);
    });
});

describe('faceToward', () => {
    // `forward` is the VISIBLE nose direction, so a pig authored facing x-
    // must still walk nose-first. This is the bug the whole field exists for.
    const yawFor = (forward: 'z+' | 'z-' | 'x+' | 'x-', x: number, z: number): number => {
        const object = new Object3D();
        object.forward = forward;
        faceToward(object, x, z);
        return object.rotation.y;
    };

    test('a z+ nose points straight along the movement vector', () => {
        expect(yawFor('z+', 0, 1)).toBeCloseTo(0);
        expect(yawFor('z+', 1, 0)).toBeCloseTo(Math.PI / 2);
    });

    test('an x- nose is corrected by a quarter turn', () => {
        expect(yawFor('x-', 0, 1)).toBeCloseTo(Math.PI / 2);
        expect(yawFor('x-', 1, 0)).toBeCloseTo(Math.PI);
    });

    test('a vertical nose is laid horizontal by a roll', () => {
        const object = new Object3D();
        object.forward = 'y+';
        faceToward(object, 0, 1);
        expect(object.rotation.z).toBeCloseTo(-Math.PI / 2);
    });

    test('standing still leaves the facing alone', () => {
        const object = new Object3D();
        object.rotation.set(0, 1.23, 0);
        faceToward(object, 0, 0);
        expect(object.rotation.y).toBe(1.23);
    });
});
