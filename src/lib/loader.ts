import { buildModelGraph, type GpuMesh, type ModelNode } from './mesh';
import { Object3D } from './object3d';
import { type BuiltTexture, buildTexture, type PicoCad2Data, parsePicoCad2 } from './picocad2';
import type { ModelData, UvTransform } from './renderer';

// How one instance of a model looks: a flat (still shaded) palette colour for
// every face, and/or a per-instance UV transform (tile / repeat).
export type ModelLook = {
    color?: number;
    uv?: UvTransform;
    /** Instantiate only this named node's subtree. Part libraries put several
        independent things in one file (dungeon walls.txt = wall / pillar /
        castley), all sharing one texture and one GPU upload. */
    part?: string;
};

// A parsed model: shared geometry + texture, instantiated any number of times.
// Geometry uploads to the GPU once (on first draw); each instantiate() returns
// a fresh Object3D tree whose inner nodes mirror the picoCAD graph — grab one
// by name to move it, or hand the root to the animator to play a clip.
export class PicoCadModel {
    readonly data: PicoCad2Data;
    readonly meshes: GpuMesh[];
    readonly texture: BuiltTexture;
    private readonly root: ModelNode;
    // One shared identity for the renderer's upload cache.
    private readonly shared: ModelData;

    /** Names of the model's drawable nodes — the parts `instantiate({ part })`
        can pick out. In file order. */
    readonly parts: string[];

    constructor(data: PicoCad2Data) {
        this.data = data;
        const { root, meshes } = buildModelGraph(data);
        this.root = root;
        this.meshes = meshes;
        this.texture = buildTexture(data);
        this.shared = { meshes: this.meshes, texture: this.texture };
        this.parts = [];
        const collect = (node: ModelNode): void => {
            if (node.meshIndex !== null && node.name !== '') this.parts.push(node.name);
            for (const child of node.children) collect(child);
        };
        collect(root);
    }

    instantiate(look?: ModelLook): Object3D {
        const build = (node: ModelNode): Object3D => {
            const object = new Object3D();
            object.name = node.name;
            object.visible = node.visible;
            object.position.set(node.pos.x, node.pos.y, node.pos.z);
            object.rotation.set(node.rot.x, node.rot.y, node.rot.z);
            object.scale.set(node.scale.x, node.scale.y, node.scale.z);
            object.meshIndex = node.meshIndex;
            object.add(...node.children.map(build));
            return object;
        };

        let root: Object3D;
        if (look?.part === undefined) {
            root = build(this.root);
        } else {
            const node = findNode(this.root, look.part);
            if (!node) throw new Error(`Model has no part named "${look.part}"`);
            // The part hangs under a fresh root rather than being one, so its
            // authored transform survives whatever the caller sets on the root.
            root = new Object3D();
            root.name = look.part;
            root.add(build(node));
        }
        root.model = { model: this.shared, uv: look?.uv, color: look?.color, pendingUpdates: new Map() };
        return root;
    }
}

function findNode(node: ModelNode, name: string): ModelNode | null {
    if (node.name === name) return node;
    for (const child of node.children) {
        const found = findNode(child, name);
        if (found) return found;
    }
    return null;
}

export class PicoCad2Loader {
    parse(text: string): PicoCadModel {
        return new PicoCadModel(parsePicoCad2(text));
    }
}
