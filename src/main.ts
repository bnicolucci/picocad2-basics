import { draw, init, update } from './game/game';
import { createWorld } from './game/world';
import { cameraLightDir, viewProjection } from './lib/camera';
import { buildModel } from './lib/model';
import { type ModelHandle, Renderer } from './lib/renderer';

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const renderer = new Renderer(canvas);

// Load every primitive and upload it once; key handles by file name (mesh_cube, ...).
const primitiveTexts = import.meta.glob('./assets/primitives/*.txt', {
    query: '?raw',
    import: 'default',
    eager: true,
}) as Record<string, string>;

const handles: Record<string, ModelHandle> = {};
for (const [path, text] of Object.entries(primitiveTexts)) {
    const name = path.split('/').pop()!.replace('.txt', '');
    const model = buildModel(text);
    handles[name] = renderer.upload(model.meshes, model.texture);
}

// --- Input: a set of currently-held keys -----------------------------------
const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
    keys.add(e.key.toLowerCase());
    if (e.key.startsWith('Arrow')) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// --- init / update / draw loop ---------------------------------------------
const world = createWorld(handles);
init(world);

const hud = document.querySelector<HTMLDivElement>('#hud')!;
function drawHud(): void {
    const p = world.player;
    const hearts = '♥'.repeat(p.hp) + '♡'.repeat(p.maxHp - p.hp);
    hud.textContent = `${hearts}   enemies ${world.enemies.length}`;
}

let last = performance.now();
function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    update(world, dt, keys);
    renderer.render(viewProjection(world.camera, renderer.aspect), cameraLightDir(world.camera), draw(world));
    drawHud();
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

Object.assign(window as unknown as Record<string, unknown>, { world });
