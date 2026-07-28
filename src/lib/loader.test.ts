import { describe, expect, test } from 'bun:test';
import { PicoCad2Loader } from './loader';
import { flattenScene, Object3D } from './object3d';
import { tinyModelText } from './testModels';

const loader = new PicoCad2Loader();

describe('PicoCadModel.parts', () => {
    test('lists the named mesh nodes in file order', () => {
        expect(loader.parse(tinyModelText(['wall', 'pillar', 'castley'])).parts).toEqual(['wall', 'pillar', 'castley']);
    });

    test('skips nodes with no mesh (the graph root)', () => {
        expect(loader.parse(tinyModelText(['wall'])).parts).not.toContain('root');
    });
});

describe('instantiate({ part })', () => {
    const model = loader.parse(tinyModelText(['wall', 'pillar', 'castley']));

    // The whole point of part libraries: one file, one GPU upload, but a tile
    // draws only its own part. If this regresses, every tile draws the whole
    // file and the dungeon renders three overlapping meshes per tile.
    test('draws exactly one mesh, not the whole file', () => {
        const scene = new Object3D();
        scene.add(model.instantiate({ part: 'pillar' }));
        const instances = flattenScene(scene);
        expect(instances).toHaveLength(1);
        expect(instances[0].meshMatrices.filter(Boolean)).toHaveLength(1);
    });

    test('every part shares one model upload, so instancing can batch them', () => {
        const scene = new Object3D();
        for (const part of model.parts) scene.add(model.instantiate({ part }));
        const instances = flattenScene(scene);
        expect(instances).toHaveLength(3);
        expect(new Set(instances.map((i) => i.model)).size).toBe(1);
    });

    test('the whole model still instantiates without a part', () => {
        const scene = new Object3D();
        scene.add(model.instantiate());
        expect(flattenScene(scene)[0].meshMatrices.filter(Boolean)).toHaveLength(3);
    });

    // A wrapper root, so callers can place a part without clobbering the
    // transform it was authored with.
    test('the root transform is free — setting it does not erase the part transform', () => {
        const object = model.instantiate({ part: 'pillar' });
        object.position.set(5, 0, 7);
        object.scale.set(0.92, 0.92, 0.92);
        expect(object.children).toHaveLength(1);
        expect(object.children[0].name).toBe('pillar');
    });

    test('an unknown part name throws rather than drawing nothing', () => {
        expect(() => model.instantiate({ part: 'nope' })).toThrow(/no part named "nope"/);
    });
});

describe('flattenScene', () => {
    test('mirrors X at model roots (picoCAD2 space is flipped vs. our world)', () => {
        const scene = new Object3D();
        scene.add(loader.parse(tinyModelText(['wall'])).instantiate());
        const matrix = flattenScene(scene)[0].meshMatrices.find(Boolean)!;
        expect(matrix[0]).toBe(-1);
    });

    test('parents compose over children', () => {
        const parent = new Object3D();
        parent.position.set(10, 0, 0);
        const child = loader.parse(tinyModelText(['wall'])).instantiate();
        child.position.set(1, 2, 3);
        parent.add(child);
        const scene = new Object3D();
        scene.add(parent);
        const matrix = flattenScene(scene)[0].meshMatrices.find(Boolean)!;
        expect([matrix[12], matrix[13], matrix[14]]).toEqual([11, 2, 3]);
    });

    test('an invisible object contributes nothing', () => {
        const scene = new Object3D();
        const object = loader.parse(tinyModelText(['wall'])).instantiate();
        object.visible = false;
        scene.add(object);
        expect(flattenScene(scene)).toHaveLength(0);
    });
});
