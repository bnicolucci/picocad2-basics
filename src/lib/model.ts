import { buildModelMeshes, type GpuMesh } from './mesh';
import { type BuiltTexture, buildTexture, parsePicoCad2 } from './picocad2';

// CPU-side model data ready to hand to Renderer.upload(). No GL involved, so it
// can be built before a context exists.
export type Model = {
    meshes: GpuMesh[];
    texture: BuiltTexture;
};

export function buildModel(text: string): Model {
    const data = parsePicoCad2(text);
    const meshes = buildModelMeshes(data);
    return { meshes, texture: buildTexture(data) };
}
