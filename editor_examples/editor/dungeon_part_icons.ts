// Renders a small 3/4-view icon of every dungeon part, so the editor's part
// menus show the actual model instead of a colour chip.
//
// It draws through the real game Renderer on a detached canvas — same meshes,
// same textures, same shading as the game — rather than a bespoke rasterizer,
// so an icon can't drift from what the part looks like in play. Each part is
// framed from its own bounds, so a floor slab and a tall pillar both fill the
// icon.

import { create_camera } from '../core/camera';
import type { DungeonCatalog } from '../dungeon/dungeon_assets';
import { dungeonInstanceMatrix } from '../dungeon/dungeon_primitives';
import type { BuiltMesh } from '../mesh';
import { VERTEX_STRIDE } from '../core/pico_anim_eval';
import { type MaterialTextureData, Renderer } from '../renderer';
import type { RenderInstance } from '../scene';

/** On-screen size of an icon in the part menus. */
export const ICON_DISPLAY_SIZE = 52;
/** Render resolution — 2x the display size so the icons stay crisp. */
const ICON_SIZE = ICON_DISPLAY_SIZE * 2;
const ICON_BACKGROUND = '#1b2540';
const ICON_FOV = Math.PI / 5;
/** Camera direction, from the part toward the eye — front / right / above. */
const ICON_DIR: [number, number, number] = [0.78, 0.72, 1];
/** Extra room around the part's bounding sphere so nothing touches the edge. */
const ICON_MARGIN = 1.18;

/** category:name -> PNG data URL. */
export type DungeonPartIcons = Map<string, string>;

function meshBounds(mesh: BuiltMesh): { center: [number, number, number]; radius: number } {
    const v = mesh.vertices;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < v.length; i += VERTEX_STRIDE) {
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], v[i + k]!);
            max[k] = Math.max(max[k], v[i + k]!);
        }
    }
    const center: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const radius = Math.max(1e-3, Math.hypot(max[0] - center[0], max[1] - center[1], max[2] - center[2]));
    return { center, radius };
}

export async function renderDungeonPartIcons(catalog: DungeonCatalog): Promise<DungeonPartIcons> {
    const icons: DungeonPartIcons = new Map();
    const parts = [...catalog.entries()].flatMap(([category, entry]) => entry.parts.map((part) => ({ category, part, entry })));
    if (parts.length === 0) return icons;

    const canvas = document.createElement('canvas');
    // Claim the context first so it is created with preserveDrawingBuffer: the
    // attributes of the FIRST getContext win, and Renderer.create's later call
    // returns this same context. Without it toDataURL can come back blank,
    // because the drawing buffer may be cleared once the frame is composited.
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });

    const meshes = new Map<string, BuiltMesh>();
    const materials: MaterialTextureData[] = [];
    for (const [, entry] of catalog) {
        materials.push(entry.material);
        for (const part of entry.parts) meshes.set(part.meshId, part.builtMesh);
    }

    // One instance per part, all hidden; the capture loop shows one at a time.
    // Identity placement (the mirror the renderer expects rides on the X scale),
    // so the camera does the framing.
    const instances: RenderInstance[] = parts.map(({ category, part, entry }) => ({
        nodeId: `icon:${category}:${part.name}`,
        nodeName: part.name,
        meshAssetId: part.meshId,
        materialId: entry.material.materialId,
        visible: false,
        worldMatrix: dungeonInstanceMatrix([0, 0, 0], [1, 1, 1]),
    }));

    const camera = create_camera({ near: 0.01, far: 100, fovYRadians: ICON_FOV });
    const renderer = await Renderer.create(canvas, materials, meshes, instances, camera, {
        retroRenderScale: 1,
        maxPixelRatio: 1,
        lockAspectRatio: false,
        viewBackgroundColor: ICON_BACKGROUND,
    });
    renderer.setWireframeEnabled(false);

    // Renderer.create sizes the canvas to the window; icons want a fixed square.
    // render() re-reads canvas.width/height every frame, so this is enough.
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;

    const dirLength = Math.hypot(ICON_DIR[0], ICON_DIR[1], ICON_DIR[2]);
    for (let i = 0; i < parts.length; i++) {
        const { category, part } = parts[i]!;
        for (const instance of instances) instance.visible = false;
        instances[i]!.visible = true;

        const { center, radius } = meshBounds(part.builtMesh);
        // The instance matrix mirrors X, so the part's world centre is mirrored too.
        const target: [number, number, number] = [-center[0], center[1], center[2]];
        const distance = (radius * ICON_MARGIN) / Math.tan(ICON_FOV / 2);
        camera.target = target;
        camera.position = [
            target[0] + (ICON_DIR[0] / dirLength) * distance,
            target[1] + (ICON_DIR[1] / dirLength) * distance,
            target[2] + (ICON_DIR[2] / dirLength) * distance,
        ];

        renderer.updateCamera(camera);
        renderer.updateRenderInstances(instances);
        renderer.renderFrame();
        icons.set(`${category}:${part.name}`, canvas.toDataURL('image/png'));
    }

    // Icons are baked once into data URLs, so drop the context rather than hold
    // one per palette change — browsers only allow a handful at a time.
    renderer.stopAnimationLoop();
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return icons;
}
