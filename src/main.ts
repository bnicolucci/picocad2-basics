import modelText from './model.txt?raw';
import { cameraLightDir, createCamera, installOrbitControls, viewProjection } from './camera';
import { compose, type Vec3 } from './math';
import { buildModelMeshes, modelBounds } from './mesh';
import { buildTexture, parsePicoCad2 } from './picocad2';
import { Renderer } from './renderer';

// --- Load the model -------------------------------------------------------
const data = parsePicoCad2(modelText);
const meshes = buildModelMeshes(data);
const texture = buildTexture(data);

// --- Set up canvas + renderer + camera ------------------------------------
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const renderer = new Renderer(canvas);
renderer.loadModel(meshes, texture);

// Frame the camera to whatever model was loaded, so swapping model.txt just works.
const bounds = modelBounds(meshes);
const camera = createCamera({ target: bounds.center });
camera.distance = (bounds.radius / Math.sin(camera.fovYRadians / 2)) * 1.1;
installOrbitControls(canvas, camera);

// --- The model: mutate these from your own code ---------------------------
// position/scale in world units, rotation in radians (XYZ Euler).
const model = {
    position: { x: 0, y: 0, z: 0 } as Vec3,
    rotation: { x: 0, y: 0, z: 0 } as Vec3,
    scale: { x: 1, y: 1, z: 1 } as Vec3,
};

// Example: slowly spin the model. Delete or replace with your own logic.
function update(dt: number): void {
    model.rotation.y += dt * 0.6;
}

// --- Render loop ----------------------------------------------------------
let last = performance.now();
function frame(now: number): void {
    const dt = (now - last) / 1000;
    last = now;

    update(dt);

    const modelMatrix = compose(model.position, model.rotation, model.scale);
    renderer.render(viewProjection(camera, renderer.aspect), cameraLightDir(camera), modelMatrix);
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Expose for tinkering in the devtools console.
Object.assign(window as unknown as Record<string, unknown>, { model, camera });
