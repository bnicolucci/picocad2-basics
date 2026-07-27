import { type Camera, create_camera, OrbitCamera, OrbitCameraController, set_camera_from_orbit } from '../core/camera';
import { createModelClipControllerDeps, PicoCadAnimationController } from '../core/picocad_animation_controller';
import { buildBuiltMeshesFromMeshAssets, collectMeshAssetsFromImportedRoots } from '../mesh';
import { buildTextureRGBA, computeGraphBounds, parsePicoCad2 } from '../picocad2';
import { Renderer } from '../renderer';
import {
    addImportedModelToScene,
    collectRenderInstances,
    createScene,
    makeMaterialId,
    type RenderInstance,
    type Scene,
    updateRenderInstancesFromScene,
} from '../scene';

// Lightweight single-model preview for the Animation editor: parse a base model,
// assemble one Scene + Renderer with the game's own building blocks (so the
// mirror, materials, and meshes match in-game exactly), and drive an on-demand
// PicoCadAnimationController. No game loop / ECS — just enough to see a clip play.

const FOV_Y = Math.PI / 3;

export type AnimPreview = {
    controller: PicoCadAnimationController;
    /** Latest render-loop clock (seconds) — pass to controller.play as the start. */
    clock(): number;
    /** Size the embedded canvas to the given CSS box (the game renderer's own
     *  resize() targets the whole window, which is wrong for a panel). */
    resize(cssWidth: number, cssHeight: number): void;
    frameToModel(): void;
    dispose(): void;
};

export async function buildAnimPreview(opts: {
    canvas: HTMLCanvasElement;
    modelText: string;
    modelId: string;
    orbit: OrbitCamera;
    orbitController: OrbitCameraController;
}): Promise<AnimPreview> {
    const { canvas, modelText, modelId, orbit, orbitController } = opts;

    const data = parsePicoCad2(modelText);
    if (!data.graph) throw new Error(`${modelId} has no graph root`);

    const materialId = makeMaterialId(modelId);
    const material = { materialId, texture: buildTextureRGBA(data) };

    const scene: Scene = createScene(`anim-preview:${modelId}`);
    const modelRoot = addImportedModelToScene(scene, { modelId, node: data.graph });

    const meshAssets = collectMeshAssetsFromImportedRoots([{ modelId, node: data.graph }]);
    const builtMeshes = buildBuiltMeshesFromMeshAssets(meshAssets);

    const renderInstances: RenderInstance[] = collectRenderInstances(scene);
    const renderInstanceByNodeId = new Map(renderInstances.map((i) => [i.nodeId, i]));

    const camera: Camera = create_camera({ fovYRadians: FOV_Y, near: 0.1, far: 500 });
    set_camera_from_orbit(camera, orbit);

    const renderer = await Renderer.create(canvas, [material], builtMeshes, renderInstances, camera, {
        retroRenderScale: 1,
        maxPixelRatio: 2,
        lockAspectRatio: false,
        viewBackgroundColor: '#1a1f24',
    });

    const controller = new PicoCadAnimationController(
        createModelClipControllerDeps({
            root: modelRoot,
            builtMeshes,
            updateMeshVertices: (id, verts) => renderer.updateMeshVertices(id, verts),
        }),
    );

    let lastClock = 0;
    renderer.setAnimationLoop((frame) => {
        lastClock = frame.elapsedTime;
        orbitController.update(frame.deltaTime);
        set_camera_from_orbit(camera, orbit);
        controller.advance(frame.elapsedTime);
        updateRenderInstancesFromScene(scene, renderInstanceByNodeId);
        renderer.updateRenderInstances(renderInstances, false);
        renderer.updateCamera(camera);
    });

    // Frame the orbit to the model's bounds. The mirror negates the visible X of
    // the raw graph center; Y/Z are unchanged.
    function frameToModel(): void {
        const b = data.graph ? computeGraphBounds(data.graph) : null;
        if (!b) return;
        const radius = 0.5 * Math.hypot(b.sizeX, b.sizeY, b.sizeZ);
        const distance = Math.max(0.5, (radius / Math.sin(FOV_Y / 2)) * 1.15);
        const minDistance = Math.max(0.05, radius * 0.15);
        const maxDistance = Math.max(distance * 4, radius * 20);
        orbit.minDistance = minDistance;
        orbit.maxDistance = maxDistance;
        orbitController.snapToOrbitPose({ targetX: -b.centerX, targetY: b.centerY, targetZ: b.centerZ, yaw: orbit.yaw, pitch: orbit.pitch, distance });
        orbitController.setDistanceLimits({ minDistance, maxDistance, distance });
    }

    function resize(cssWidth: number, cssHeight: number): void {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.max(1, Math.round(cssWidth * dpr));
        canvas.height = Math.max(1, Math.round(cssHeight * dpr));
        canvas.style.width = '100%';
        canvas.style.height = '100%';
    }

    return {
        controller,
        clock: () => lastClock,
        resize,
        frameToModel,
        dispose: () => renderer.stopAnimationLoop(),
    };
}
