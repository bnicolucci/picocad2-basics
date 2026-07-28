import { type PicoCadAnimator, playClip } from './animator';
import { createEditorViewport } from './editorViewport';
import { PicoCad2Loader } from './loader';
import type { Object3D } from './object3d';
import { computeGraphBounds, type PicoCadAnimationClip } from './picocad2';

// Single-model preview for the Animation editor: one viewport for the page's
// lifetime, the model inside it swapped per selection. Playback runs through
// the real loader + animator, so what plays here is what plays in-game.

export type AnimPreview = {
    /** Swap in a model; false if the text failed to parse. */
    setModel(text: string): boolean;
    /** Remove the current model (and stop playback). */
    clear(): void;
    /** Play a clip on the current model; null when no model is loaded. */
    play(clip: PicoCadAnimationClip): PicoCadAnimator | null;
    stop(): void;
};

export function createAnimPreview(canvas: HTMLCanvasElement): AnimPreview {
    const viewport = createEditorViewport(canvas, { background: '#1a1f24' });
    const loader = new PicoCad2Loader();

    let model: Object3D | null = null;
    let animator: PicoCadAnimator | null = null;

    function stop(): void {
        animator?.stop();
        animator = null;
    }

    function clear(): void {
        stop();
        if (model) viewport.scene.remove(model);
        model = null;
    }

    return {
        setModel(text: string): boolean {
            clear();
            try {
                const parsed = loader.parse(text);
                model = parsed.instantiate();
                viewport.scene.add(model);
                // Frame the orbit to the model's bounds. The mirror negates the
                // visible X of the raw graph center; Y/Z are unchanged.
                const b = parsed.data.graph ? computeGraphBounds(parsed.data.graph) : null;
                if (b) {
                    const radius = Math.max(0.5, 0.5 * Math.hypot(b.sizeX, b.sizeY, b.sizeZ));
                    viewport.frame({ x: -b.centerX, y: b.centerY, z: b.centerZ }, radius);
                }
                return true;
            } catch {
                model = null;
                return false;
            }
        },
        clear,
        play(clip: PicoCadAnimationClip): PicoCadAnimator | null {
            if (!model) return null;
            stop();
            animator = playClip(model, clip, { start: viewport.clock() });
            return animator;
        },
        stop,
    };
}
