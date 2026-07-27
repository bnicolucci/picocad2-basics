import type { PicoCadAnimationClip } from '../../lib/picocad2';

// The generated `<mesh>_animations.ts` clip registries, looked up by mesh name.
// This is the only form a clip ships in — the `-anim-` sources it came from are
// editor input and never reach a build.
const REGISTRIES = import.meta.glob('./*_animations.ts') as Record<
    string,
    () => Promise<Record<string, unknown>>
>;

/**
 * A mesh's saved clips, keyed by clip name; empty when it has no registry.
 *
 * `generateAnimationsModule` writes exactly one export per file (the type
 * import erases), which is why taking the first one is enough.
 */
export async function loadAnimationClips(mesh: string): Promise<Record<string, PicoCadAnimationClip>> {
    const load = REGISTRIES[`./${mesh}_animations.ts`];
    if (!load) return {};
    try {
        return (Object.values(await load())[0] ?? {}) as Record<string, PicoCadAnimationClip>;
    } catch {
        return {};
    }
}
