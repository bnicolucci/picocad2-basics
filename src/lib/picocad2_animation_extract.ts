import type { PicoCad2Data, PicoCad2MotionSegment, PicoCad2Node, PicoCadAnimationClip } from './picocad2';

// Pure, DOM-free extraction of animation clips from picoCAD2
// "<mesh>-anim-<clipName>.txt" export variants (also accepts "_anim_").
// Shared by the Animation editor (browser) and any future headless script.
//
// Extraction is fully mechanical: parse raw, copy each animated node's
// motions.tracks VERBATIM. No coordinate reasoning happens here — the
// picoCAD->engine mirror is applied at playback.

const ANIM_INFIXES = ['-anim-', '_anim_'];
const DEFAULT_TEXTURE_SIZE = 128;

export type AnimSourceFileInfo = {
    mesh: string;
    clipName: string;
};

// "<mesh>-anim-<clipName>.txt" -> { mesh, clipName }. Returns null for names
// that aren't animation sources (including the base model itself).
export function parseAnimSourceFileName(fileName: string): AnimSourceFileInfo | null {
    const base = fileName.split('/').pop()?.replace(/\.txt$/i, '') ?? fileName;
    for (const infix of ANIM_INFIXES) {
        const idx = base.indexOf(infix);
        if (idx <= 0) continue;
        const clipName = base.slice(idx + infix.length);
        if (!clipName) continue;
        return { mesh: base.slice(0, idx), clipName };
    }
    return null;
}

function nodeHasMotion(node: PicoCad2Node): boolean {
    return !!node.motions?.tracks?.some((slot) => slot.length > 0);
}

export type AnimatedNode = {
    nodeName: string;
    tracks: PicoCad2MotionSegment[][];
};

// Every node in the export that carries non-empty motion tracks, in graph order.
// Nameless nodes are skipped (clips key on node name); on a duplicate name the
// first wins — picoCAD2 node names are unique in practice.
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
// all animated nodes). Tracks are copied verbatim.
export function extractClip(data: PicoCad2Data, includedNodeNames?: Iterable<string>): PicoCadAnimationClip {
    const include = includedNodeNames ? new Set(includedNodeNames) : null;
    const tracks: Record<string, PicoCad2MotionSegment[][]> = {};
    let maxStop = 0;
    for (const { nodeName, tracks: nodeTracks } of collectAnimatedNodes(data)) {
        if (include && !include.has(nodeName)) continue;
        tracks[nodeName] = nodeTracks;
        for (const slot of nodeTracks) {
            for (const seg of slot) {
                if ((seg.stop ?? 0) > maxStop) maxStop = seg.stop ?? 0;
            }
        }
    }
    return {
        tracks,
        textureWidth: data.texture?.width ?? DEFAULT_TEXTURE_SIZE,
        textureHeight: data.texture?.height ?? DEFAULT_TEXTURE_SIZE,
        motionDuration: data.metadata?.motion_duration ?? (maxStop > 1e-4 ? maxStop : 1),
    };
}

// Nodes whose motion is identical across two or more clips — almost always a
// shared idle baked into every export (e.g. treads rolling). The editor
// defaults these OFF so each clip captures only its distinctive motion.
export function detectSharedNodes(clipsByName: Record<string, PicoCadAnimationClip>): Set<string> {
    const signatures = new Map<string, Set<string>>();
    const counts = new Map<string, number>();
    for (const clip of Object.values(clipsByName)) {
        for (const [nodeName, nodeTracks] of Object.entries(clip.tracks)) {
            counts.set(nodeName, (counts.get(nodeName) ?? 0) + 1);
            const sig = JSON.stringify(nodeTracks);
            (signatures.get(nodeName) ?? signatures.set(nodeName, new Set()).get(nodeName)!).add(sig);
        }
    }
    const shared = new Set<string>();
    for (const [nodeName, count] of counts) {
        if (count >= 2 && signatures.get(nodeName)!.size === 1) shared.add(nodeName);
    }
    return shared;
}

// Generate the "<mesh>_animations.ts" registry module text: exactly one export
// named "<mesh>Animations", keyed by clip name, tracks serialized compactly.
// The editor round-trips its include/exclude state straight out of this file
// (nodes present here = included), so no sidecar save is needed.
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
            `        motionDuration: ${clip.motionDuration},`,
            `        tracks: {`,
            trackLines,
            `        },`,
            `    },`,
        ].join('\n');
    });
    return [
        `// GENERATED by the Animation editor from ${mesh}-anim-<clip>.txt exports.`,
        `// One registry per file, keyed by clip name; tracks copied verbatim from the`,
        `// source motion data. Re-open the Animation editor to change which clips/nodes`,
        `// are included — do not hand-edit the track data here.`,
        `import type { PicoCadAnimationClip } from '../../lib/picocad2';`,
        ``,
        `export const ${registryName} = {`,
        clipEntries.join('\n'),
        `} as const satisfies Record<string, PicoCadAnimationClip>;`,
        ``,
    ].join('\n');
}
