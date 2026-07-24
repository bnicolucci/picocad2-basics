import { buildModelMeshes, type GpuMesh, modelBounds } from './mesh';
import { type BuiltTexture, buildTexture, parsePicoCad2 } from './picocad2';

// CPU-side model data ready to hand to Renderer.upload(). No GL involved, so it
// can be built before a context exists.
export type Model = {
    meshes: GpuMesh[];
    texture: BuiltTexture;
    bounds: { center: [number, number, number]; radius: number };
};

export function buildModel(text: string): Model {
    const data = parsePicoCad2(text);
    const meshes = buildModelMeshes(data);
    return { meshes, texture: buildTexture(data), bounds: modelBounds(meshes) };
}
