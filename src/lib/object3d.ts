import { compose, identity, type Mat4, multiply } from './math';
import type { Instance, ModelData, UvTransform } from './renderer';

// A tiny three.js-shaped scene graph over the minimal renderer: objects carry
// position / rotation (radians, XYZ) / scale, parents compose over children,
// and `flattenScene` turns the tree into the renderer's flat Instance list
// each frame. Model roots (from PicoCad2Loader.instantiate / the primitives)
// carry the shared geometry reference; their inner nodes stay live so
// animation can move them.

export class Vector3 {
    x: number;
    y: number;
    z: number;

    constructor(x = 0, y = 0, z = 0) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    set(x: number, y: number, z: number): this {
        this.x = x;
        this.y = y;
        this.z = z;
        return this;
    }
}

// One instantiated model: which shared geometry to draw plus this instance's
// look. `pendingUpdates` holds vertex rewrites from UV-scroll animation until
// the next flatten. (Vertex buffers are shared per model, so tex animation on
// two instances of the same model shows on both — fine for previews/one-offs.)
export type InstantiatedModel = {
    model: ModelData;
    uv?: UvTransform;
    color?: number;
    pendingUpdates: Map<number, Float32Array>;
};

/** An object's visible nose direction, as seen on screen ('z+' unless set). */
export type Forward = 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';

export class Object3D {
    name = '';
    visible = true;
    /** Rest facing, folded in by faceToward (set by spawnEntity or by hand). */
    forward: Forward = 'z+';
    readonly position = new Vector3(0, 0, 0);
    readonly rotation = new Vector3(0, 0, 0); // radians, XYZ order
    readonly scale = new Vector3(1, 1, 1);
    children: Object3D[] = [];
    parent: Object3D | null = null;

    /** Set on a model root by the loader/primitives; internal to the engine. */
    model?: InstantiatedModel;
    /** Which of the model's meshes this node draws; internal to the engine. */
    meshIndex: number | null = null;

    add(...objects: Object3D[]): this {
        for (const object of objects) {
            object.parent?.remove(object);
            object.parent = this;
            this.children.push(object);
        }
        return this;
    }

    remove(object: Object3D): this {
        const index = this.children.indexOf(object);
        if (index !== -1) {
            this.children.splice(index, 1);
            object.parent = null;
        }
        return this;
    }

    getObjectByName(name: string): Object3D | null {
        if (this.name === name) return this;
        for (const child of this.children) {
            const found = child.getObjectByName(name);
            if (found) return found;
        }
        return null;
    }

}

export class Scene extends Object3D {
    /** Hex colour ('#1d2b53') cleared behind everything. */
    background = '#0f1416';
}

// picoCAD2 model space is X-mirrored vs. our right-handed world; the mirror
// sits between a model root's own transform and its contents.
const MIRROR: Mat4 = (() => {
    const m = identity();
    m[0] = -1;
    return m;
})();

function localMatrix(object: Object3D): Mat4 {
    return compose(object.position, object.rotation, object.scale);
}

// Walk the tree, composing world matrices, and emit one Instance per model
// root with per-mesh matrices (null = hidden).
export function flattenScene(root: Object3D): Instance[] {
    const instances: Instance[] = [];

    const walk = (object: Object3D, parentWorld: Mat4, current: Instance | null): void => {
        if (!object.visible) return;

        let world = multiply(parentWorld, localMatrix(object));
        let instance = current;

        if (object.model) {
            const info = object.model;
            instance = {
                model: info.model,
                uv: info.uv,
                color: info.color,
                meshMatrices: new Array<Mat4 | null>(info.model.meshes.length).fill(null),
            };
            if (info.pendingUpdates.size > 0) {
                instance.updates = [...info.pendingUpdates].map(([meshIndex, vertices]) => ({ meshIndex, vertices }));
                info.pendingUpdates.clear();
            }
            instances.push(instance);
            world = multiply(world, MIRROR);
        }

        if (instance && object.meshIndex !== null) {
            instance.meshMatrices[object.meshIndex] = world;
        }

        for (const child of object.children) walk(child, world, instance);
    };

    walk(root, identity(), null);
    return instances;
}
