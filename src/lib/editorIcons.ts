import { PerspectiveCamera } from './camera';
import { VERTEX_FLOATS } from './mesh';
import { flattenScene, type Object3D, Scene } from './object3d';
import type { Instance } from './renderer';
import { Renderer } from './renderer';

// Small 3/4-view renders of things, for the editors' pick menus — so you see
// the actual model, in its real palette, instead of a colour chip.
//
// It draws through the REAL renderer: same meshes, same textures, same palette
// shading as the game, so an icon can't drift from what you get in play. Each
// object is framed from its own bounds, so a floor slab and a tall pillar both
// fill their icon.

/** On-screen size of an icon, in CSS px. */
export const ICON_DISPLAY_SIZE = 48;
/** Rendered at 2x so the icons stay crisp. */
const ICON_SIZE = ICON_DISPLAY_SIZE * 2;
const ICON_FOV = 34; // degrees
/** From the object toward the eye — front / right / above. */
const ICON_DIR: [number, number, number] = [0.78, 0.72, 1];
/** Breathing room around the bounding sphere so nothing touches the edge. */
const ICON_MARGIN = 1.2;

// World-space bounds of everything an instance list draws (the model-root
// mirror is already baked into the matrices, so this needs no correction).
function boundsOf(instances: Instance[]): { center: [number, number, number]; radius: number } {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const instance of instances) {
        for (let i = 0; i < instance.meshMatrices.length; i++) {
            const m = instance.meshMatrices[i];
            if (!m) continue;
            const v = instance.model.meshes[i].vertices;
            for (let o = 0; o < v.length; o += VERTEX_FLOATS) {
                const x = v[o];
                const y = v[o + 1];
                const z = v[o + 2];
                const world = [
                    m[0] * x + m[4] * y + m[8] * z + m[12],
                    m[1] * x + m[5] * y + m[9] * z + m[13],
                    m[2] * x + m[6] * y + m[10] * z + m[14],
                ];
                for (let k = 0; k < 3; k++) {
                    if (world[k] < min[k]) min[k] = world[k];
                    if (world[k] > max[k]) max[k] = world[k];
                }
            }
        }
    }
    if (!Number.isFinite(min[0])) return { center: [0, 0, 0], radius: 1 };
    const center: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    return { center, radius: Math.max(1e-3, Math.hypot(max[0] - center[0], max[1] - center[1], max[2] - center[2])) };
}

/**
 * Render each object to a PNG data URL, keyed the same way it came in.
 * Synchronous and one-shot: the icons are baked, then the GL context is
 * dropped (browsers allow only a handful at a time).
 */
export function renderIcons(items: Iterable<[string, Object3D]>, background = '#1a1a1a'): Map<string, string> {
    const icons = new Map<string, string>();
    const entries = [...items];
    if (entries.length === 0) return icons;

    // In the document (off-screen) because the renderer sizes its buffer from
    // the canvas's CSS box, which is 0 while detached.
    const canvas = document.createElement('canvas');
    canvas.style.cssText = `position: fixed; left: -9999px; top: 0; width: ${ICON_SIZE}px; height: ${ICON_SIZE}px;`;
    document.body.append(canvas);

    // The FIRST getContext's attributes win and the Renderer's later call gets
    // this same context — so claim it with preserveDrawingBuffer, or toDataURL
    // can come back blank once the frame is composited.
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });

    const renderer = new Renderer(canvas);
    renderer.retroScale = 1;
    renderer.setBackground(background);
    const camera = new PerspectiveCamera(ICON_FOV, 0.01, 200);
    const scene = new Scene();
    const dirLength = Math.hypot(ICON_DIR[0], ICON_DIR[1], ICON_DIR[2]);

    for (const [key, object] of entries) {
        scene.add(object);
        const instances = flattenScene(scene);
        const { center, radius } = boundsOf(instances);
        const distance = (radius * ICON_MARGIN) / Math.tan((ICON_FOV * Math.PI) / 360);
        camera.position.set(
            center[0] + (ICON_DIR[0] / dirLength) * distance,
            center[1] + (ICON_DIR[1] / dirLength) * distance,
            center[2] + (ICON_DIR[2] / dirLength) * distance,
        );
        camera.lookAt(center[0], center[1], center[2]);
        renderer.render(camera.viewProjection(renderer.aspect), camera.lightDir(), instances);
        icons.set(key, canvas.toDataURL('image/png'));
        scene.remove(object);
    }

    canvas.remove();
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return icons;
}
