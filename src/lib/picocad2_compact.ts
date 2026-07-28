import { type PicoCad2Data, type PicoCad2MotionSegment, type PicoCad2Node, TEXTURE_SIZE_DEFAULT } from './picocad2';

// Compact wire encoding for parsed picoCAD2 models: tuples instead of keyed
// objects, bit-packed face flags, defaults omitted, texture pixels base64-
// packed (2 pixels/byte), and floats quantized to visually-lossless precision.
// The build plugin in vite.config.ts encodes bundled `.txt?raw` models with
// this; parsePicoCad2 transparently decodes the `pc2!` prefix at runtime. Dev
// always uses the raw files.

export const PICO_CAD2_COMPACT_PREFIX = 'pc2!';

// 1e5 keeps colours exact to well under 1/255 and positions to 0.00001 units;
// UVs are texture pixels, so 1e3 is a thousandth of a pixel.
const PRECISION = 1e5;
const UV_PRECISION = 1e3;

function round(value: number, precision = PRECISION): number {
    return Math.round(value * precision) / precision;
}

function roundAll(values: number[] | undefined, precision = PRECISION): number[] | undefined {
    return values?.map((value) => round(value, precision));
}

// One hex digit per pixel (4 bits) -> two pixels per byte -> base64.
function packPixels(pixels: string): string {
    let bytes = '';
    for (let i = 0; i < pixels.length; i += 2) {
        bytes += String.fromCharCode((parseInt(pixels[i], 16) << 4) | parseInt(pixels[i + 1] ?? '0', 16));
    }
    return btoa(bytes);
}

function unpackPixels(packed: string, pixelCount: number): string {
    const bytes = atob(packed);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return hex.slice(0, pixelCount);
}

type PicoCad2TextureData = NonNullable<PicoCad2Data['texture']>;
type PicoCad2Metadata = NonNullable<PicoCad2Data['metadata']>;
type CompactVec3 = [number | undefined, number | undefined, number | undefined];
type CompactTransform = [CompactVec3 | null, CompactVec3 | null, CompactVec3 | null];
type CompactFace = [number[] | undefined, number[] | undefined, number | undefined, number];
type CompactMesh = [number[] | undefined, CompactFace[] | undefined];
type CompactMotions = PicoCad2MotionSegment[][] | undefined;
type CompactMetadata = [string | undefined, number | undefined, number | undefined] | undefined;
type CompactNode = [
    string | undefined,
    CompactTransform | null,
    CompactMesh | null,
    CompactNode[] | undefined,
    boolean | undefined,
    CompactMotions,
];

function metadataToCompact(metadata: PicoCad2Metadata | undefined): CompactMetadata {
    if (!metadata) return undefined;
    const name = metadata.name;
    const motionDuration = metadata.motion_duration;
    const speed = metadata.export_settings?.speed;
    return name !== undefined || motionDuration !== undefined || speed !== undefined
        ? [name, motionDuration, speed]
        : undefined;
}

function metadataFromCompact(metadata: CompactMetadata): PicoCad2Data['metadata'] | undefined {
    if (!metadata) return undefined;
    const [name, motionDuration, speed] = metadata;
    return {
        name,
        motion_duration: motionDuration,
        export_settings: speed !== undefined ? { speed } : undefined,
    };
}

function vecToCompact(vec: { x?: number; y?: number; z?: number } | undefined): CompactVec3 | null {
    if (!vec || (vec.x === undefined && vec.y === undefined && vec.z === undefined)) return null;
    return [
        vec.x === undefined ? undefined : round(vec.x),
        vec.y === undefined ? undefined : round(vec.y),
        vec.z === undefined ? undefined : round(vec.z),
    ];
}

function vecFromCompact(vec: CompactVec3 | null | undefined): { x?: number; y?: number; z?: number } | undefined {
    if (!vec) return undefined;
    return { x: vec[0], y: vec[1], z: vec[2] };
}

function transformToCompact(node: PicoCad2Node): CompactTransform | null {
    const transform = node.transform;
    if (!transform) return null;

    const pos = vecToCompact(transform.pos);
    const rot = vecToCompact(transform.rot);
    const scale = vecToCompact(transform.scale);
    return pos || rot || scale ? [pos, rot, scale] : null;
}

function transformFromCompact(transform: CompactTransform | null | undefined): PicoCad2Node['transform'] | undefined {
    if (!transform) return undefined;
    return {
        pos: vecFromCompact(transform[0]),
        rot: vecFromCompact(transform[1]),
        scale: vecFromCompact(transform[2]),
    };
}

function faceFlags(face: NonNullable<NonNullable<PicoCad2Node['mesh']>['faces']>[number]): number {
    return (
        (face.texture === false ? 1 : 0) |
        (face.notex ? 2 : 0) |
        (face.no_shade ? 4 : 0) |
        (face.double_sided ? 8 : 0) |
        (face.dbl ? 16 : 0) |
        (face.render_first ? 32 : 0)
    );
}

function meshToCompact(node: PicoCad2Node): CompactMesh | null {
    if (!node.mesh) return null;
    return [
        roundAll(node.mesh.vertices),
        node.mesh.faces?.map((face) => [face.vertex_ids, roundAll(face.uvs, UV_PRECISION), face.color, faceFlags(face)]),
    ];
}

function meshFromCompact(mesh: CompactMesh | null | undefined): PicoCad2Node['mesh'] | undefined {
    if (!mesh) return undefined;
    return {
        vertices: mesh[0],
        faces: mesh[1]?.map(([vertexIds, uvs, color, flags]) => ({
            vertex_ids: vertexIds,
            uvs,
            color,
            texture: flags & 1 ? false : undefined,
            notex: flags & 2 ? true : undefined,
            no_shade: flags & 4 ? true : undefined,
            double_sided: flags & 8 ? true : undefined,
            dbl: flags & 16 ? true : undefined,
            render_first: flags & 32 ? true : undefined,
        })),
    };
}

function motionsToCompact(node: PicoCad2Node): CompactMotions {
    const tracks = node.motions?.tracks;
    if (!tracks?.some((track) => track.length > 0)) return undefined;
    return tracks;
}

function nodeToCompact(node: PicoCad2Node): CompactNode {
    return [
        node.name,
        transformToCompact(node),
        meshToCompact(node),
        node.children?.map(nodeToCompact),
        node.visible === false ? false : undefined,
        motionsToCompact(node),
    ];
}

function nodeFromCompact(node: CompactNode): PicoCad2Node {
    return {
        name: node[0],
        transform: transformFromCompact(node[1]),
        mesh: meshFromCompact(node[2]),
        children: node[3]?.map(nodeFromCompact),
        visible: node[4],
        motions: node[5] ? { tracks: node[5] } : undefined,
    };
}

// The one entry point for encoding: parse `text`, and if it is a picoCAD2
// model (texture + graph), return the compact form; anything else -> null.
export function tryEncodePicoCad2Compact(text: string): string | null {
    let data: PicoCad2Data;
    try {
        data = JSON.parse(text) as PicoCad2Data;
    } catch {
        return null;
    }
    const { texture, graph } = data;
    if (!texture || !graph) return null;

    return `${PICO_CAD2_COMPACT_PREFIX}${JSON.stringify([
        [
            packPixels(texture.pixels),
            texture.colors.map((color) => color.map((channel) => round(channel)) as typeof color),
            texture.transparent_color,
            texture.shade_pal_1,
            texture.shade_pal_2,
            texture.background_color,
            texture.width,
            texture.height,
        ],
        nodeToCompact(graph),
        metadataToCompact(data.metadata),
    ])}`;
}

export function decodePicoCad2Compact(text: string): PicoCad2Data {
    const [texture, graph, metadata] = JSON.parse(text.slice(PICO_CAD2_COMPACT_PREFIX.length)) as [
        [string, PicoCad2TextureData['colors'], number | undefined, number[] | undefined, number[] | undefined, number | undefined, number | undefined, number | undefined],
        CompactNode,
        CompactMetadata,
    ];

    return {
        metadata: metadataFromCompact(metadata),
        texture: {
            pixels: unpackPixels(texture[0], (texture[6] ?? TEXTURE_SIZE_DEFAULT) * (texture[7] ?? TEXTURE_SIZE_DEFAULT)),
            colors: texture[1],
            transparent_color: texture[2],
            shade_pal_1: texture[3],
            shade_pal_2: texture[4],
            background_color: texture[5],
            width: texture[6],
            height: texture[7],
        },
        graph: nodeFromCompact(graph),
    };
}
