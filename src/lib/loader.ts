import { buildModelGraph, type GpuMesh, type ModelNode } from './mesh';
import { Object3D } from './object3d';
import { type BuiltTexture, buildTexture, type PicoCad2Data, parsePicoCad2 } from './picocad2';
import type { ModelData, UvTransform } from './renderer';

// How one instance of a model looks: a flat (still shaded) palette colour for
// every face, and/or a per-instance UV transform (tile / repeat).
export type ModelLook = {
    color?: number;
    uv?: UvTransform;
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

    constructor(data: PicoCad2Data) {
        this.data = data;
        const { root, meshes } = buildModelGraph(data);
        this.root = root;
        this.meshes = meshes;
        this.texture = buildTexture(data);
        this.shared = { meshes: this.meshes, texture: this.texture };
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
        const root = build(this.root);
        root.model = { model: this.shared, uv: look?.uv, color: look?.color, pendingUpdates: new Map() };
        return root;
    }
}

export class PicoCad2Loader {
    parse(text: string): PicoCadModel {
        return new PicoCadModel(parsePicoCad2(text));
    }
}
