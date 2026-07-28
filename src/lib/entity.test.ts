import { describe, expect, test } from 'bun:test';
import { faceToward, instantiateEntity } from './entity';
import { Object3D } from './object3d';
import { tinyModelText } from './testModels';

const meshText = (): string => tinyModelText(['body']);

describe('instantiateEntity', () => {
    test('builds one child per part and carries the blueprint facing', () => {
        const group = instantiateEntity({ forward: 'x-', parts: [{ mesh: 'a' }, { mesh: 'a' }] }, meshText);
        expect(group.children).toHaveLength(2);
        expect(group.forward).toBe('x-');
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
