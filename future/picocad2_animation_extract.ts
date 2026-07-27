import type { PicoCad2Data, PicoCad2MotionSegment, PicoCad2Node, PicoCadAnimationClip } from './picocad2';

// Pure, DOM-free extraction of native animation clips from picoCAD2
// "<mesh>-anim-<clipName>.txt" export variants. Shared by the Animation editor
// (browser) and any future headless build script — the same code path either
// way, exactly like picocad2_compact.ts is shared by the Vite plugin + runtime.
//
// The picoCAD->engine mirror is a single per-model reflection applied at
// PLAYBACK (see PICO_MODEL_MIRROR_AXIS in scene.ts), so extraction is fully
// mechanical and sign-free: parse raw, copy each animated node's motions.tracks
// VERBATIM. No coordinate reasoning happens here.

const ANIM_SOURCE_INFIX = '-anim-';
const DEFAULT_TEXTURE_SIZE = 128;

export type AnimSourceFileInfo = {
    mesh: string;
    clipName: string;
};

// "<mesh>-anim-<clipName>.txt" -> { mesh, clipName }. Returns null for names
// that aren't animation sources (including the base model and the trailing
// "-anim" capability variant, which carries no clip name).
export function parseAnimSourceFileName(fileName: string): AnimSourceFileInfo | null {
    const base = fileName.split('/').pop()?.replace(/\.txt$/i, '') ?? fileName;
    const idx = base.indexOf(ANIM_SOURCE_INFIX);
    if (idx <= 0) return null;
    const clipName = base.slice(idx + ANIM_SOURCE_INFIX.length);
    if (!clipName) return null;
    return { mesh: base.slice(0, idx), clipName };
}

function nodeHasMotion(node: PicoCad2Node): boolean {
    return !!node.motions?.tracks?.some((slot) => slot.length > 0);
}

export type AnimatedNode = {
    nodeName: string;
    tracks: PicoCad2MotionSegment[][];
};

// Every node in the export that carries non-empty motion tracks, in graph order.
// Nameless nodes are skipped (clips key on node name). If two nodes somehow share
// a name the first wins — picoCAD2 node names are unique in practice.
export function collectAnimatedNodes(data: PicoCad2Data): AnimatedNode[] {
    const out: AnimatedNode[] = [];
    const seen = new Set<string>();
    const walk = (node: PicoCad2Node): void => {
        if (node.name && !seen.has(node.name) && nodeHasMotion(node)) {
            seen.add(node.name);
            out.push({ nodeName: node.name, tracks: node.motions!.tracks! });
        }
        node.children?.forEach(walk);
    };
    if (data.graph) walk(data.graph);
    return out;
}

// Build a clip from a parsed export, keeping only the chosen nodes (defaults to
// all animated nodes when includedNodeNames is omitted). Tracks are copied
// verbatim; texture size comes from the export, defaulting to 128×128.
export function extractClip(data: PicoCad2Data, includedNodeNames?: Iterable<string>): PicoCadAnimationClip {
    const include = includedNodeNames ? new Set(includedNodeNames) : null;
    const tracks: Record<string, PicoCad2MotionSegment[][]> = {};
    for (const { nodeName, tracks: nodeTracks } of collectAnimatedNodes(data)) {
        if (!include || include.has(nodeName)) tracks[nodeName] = nodeTracks;
    }
    return {
        tracks,
        textureWidth: data.texture?.width ?? DEFAULT_TEXTURE_SIZE,
        textureHeight: data.texture?.height ?? DEFAULT_TEXTURE_SIZE,
    };
}

// Nodes whose motion is identical across two or more clips — almost always a
// shared idle (e.g. treads rolling / a slow spin baked into every export). The
// editor defaults these OFF so a clip captures only its distinctive motion, the
// same curation the hand-authored thinktank clips did by hand.
export function detectSharedNodes(clipsByName: Record<string, PicoCadAnimationClip>): Set<string> {
    const signatures = new Map<string, Set<string>>(); // nodeName -> set of distinct track-JSONs seen
    const counts = new Map<string, number>(); // nodeName -> how many clips contain it
    for (const clip of Object.values(clipsByName)) {
        for (const [nodeName, nodeTracks] of Object.entries(clip.tracks)) {
            counts.set(nodeName, (counts.get(nodeName) ?? 0) + 1);
            const sig = JSON.stringify(nodeTracks);
            (signatures.get(nodeName) ?? signatures.set(nodeName, new Set()).get(nodeName)!).add(sig);
        }
    }
    const shared = new Set<string>();
    for (const [nodeName, count] of counts) {
        // In ≥2 clips AND identical everywhere it appears → shared idle motion.
        if (count >= 2 && signatures.get(nodeName)!.size === 1) shared.add(nodeName);
    }
    return shared;
}

// Generate the "<mesh>_animations.ts" registry module text from finished clips.
// Matches the hand-authored convention: exactly one exported registry named
// "<mesh>Animations", keyed by clip name, tracks serialized compactly. The
// editor round-trips its include/exclude state straight out of this file (nodes
// present here = included), so no sidecar save is needed.
export function generateAnimationsModule(mesh: string, clipsByName: Record<string, PicoCadAnimationClip>): string {
    const registryName = `${mesh.replace(/[^A-Za-z0-9]/g, '_')}Animations`;
    const clipEntries = Object.entries(clipsByName).map(([clipName, clip]) => {
        const trackLines = Object.entries(clip.tracks)
            .map(([nodeName, nodeTracks]) => `            ${JSON.stringify(nodeName)}: ${JSON.stringify(nodeTracks)},`)
            .join('\n');
        return [
            `    ${JSON.stringify(clipName)}: {`,
            `        textureWidth: ${clip.textureWidth},`,
            `        textureHeight: ${clip.textureHeight},`,
            `        tracks: {`,
            trackLines,
            `        },`,
            `    },`,
        ].join('\n');
    });
    return [
        `// GENERATED by the Animation editor from ${mesh}${ANIM_SOURCE_INFIX}<clip>.txt exports.`,
        `// One registry per file, keyed by clip name; tracks copied verbatim from the`,
        `// source motion data. Re-open the Animation editor to change which clips/nodes`,
        `// are included — do not hand-edit the track data here.`,
        `import type { PicoCadAnimationClip } from '../../picocad2';`,
        ``,
        `export const ${registryName} = {`,
        clipEntries.join('\n'),
        `} as const satisfies Record<string, PicoCadAnimationClip>;`,
        ``,
    ].join('\n');
}
