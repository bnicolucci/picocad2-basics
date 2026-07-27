// Loads the dungeon's part library from src/assets/dungeon/*.txt.
//
// Convention:
//   - Each .txt is a picoCAD2 model file; its FILENAME is a category
//     ("walls", "grounds", "props", ...).
//   - Each named mesh node inside the file is a selectable PART; the node's
//     NAME is the part name ("wall", "pillar", "ground", "gem", ...).
//   - Author parts sitting on the ground plane (y = 0 is the floor), centered
//     on x/z, at their final proportions ~1 tile wide. They are placed at a
//     uniform tile scale at runtime — no per-type stretch — so what you model
//     is what you get. (See dungeon_main.ts for placement.)
//
// Each category also carries a real material built from the file's painted
// texture (parts in one file share the file's texture and differ by UVs, e.g.
// grassy/dirty/sandy grounds), plus a darkened variant for fog-of-war dimming.
//
// This generalizes dungeon_primitives.loadPrimitiveMesh (which only takes the
// FIRST mesh in a file, flat-coloured) to collect EVERY named mesh node and
// keep the authored texture.

import { type BuiltMesh, buildLocalMeshFromMeshAsset, buildMeshAssetFromPicoNode } from '../mesh';
import { picoCadPalettes, type PicoCadPaletteId } from '../palettes/picocad_palettes';
import { buildTextureRGBA, parsePicoCad2, type PicoCad2Node, type PicoCadPaletteOverride } from '../picocad2';
import type { MaterialTextureData, TextureData } from '../renderer';
import { type DungeonPlacement, type DungeonPrim, TILE_GAP, TILE_SIZE } from './dungeon_geometry';
import { dungeonInstanceMatrix } from './dungeon_primitives';

export type DungeonPart = {
    /** Category = source filename (e.g. "walls"). */
    category: string;
    /** Part name = the mesh node's name (e.g. "pillar"). */
    name: string;
    /** Renderer mesh id, unique per category+part. */
    meshId: string;
    builtMesh: BuiltMesh;
    /** Representative RGB (0-255) sampled from the part's texture, for editor UI swatches/preview. */
    previewColor: [number, number, number];
};

export type DungeonCategory = {
    name: string;
    /** Parts in file order. */
    parts: DungeonPart[];
    /** The file's painted texture as a renderer material. */
    material: MaterialTextureData;
    /** Darkened copy of `material` for fog-of-war dimming. */
    materialDim: MaterialTextureData;
};

/** category name -> its parts + materials. */
export type DungeonCatalog = Map<string, DungeonCategory>;

// Every mesh-bearing node in the graph, with the graph path (for stable ids).
// Recurses so nested meshes are found too.
function collectMeshNodes(node: PicoCad2Node, path: number[], out: Array<{ node: PicoCad2Node; path: number[] }>): void {
    if (node.mesh?.vertices?.length && node.mesh.faces?.length) out.push({ node, path });
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++) collectMeshNodes(children[i]!, [...path, i], out);
}

// A darkened copy of a texture (palette RGB scaled) for the fog "visited but
// off-screen" look — mirrors the flat-material bright/dim pair in dungeon_main.
function darkenTexture(tex: TextureData, factor: number): TextureData {
    const palettePixels = new Uint8Array(tex.palettePixels);
    for (let i = 0; i < palettePixels.length; i += 4) {
        palettePixels[i + 0] = Math.round(palettePixels[i + 0]! * factor);
        palettePixels[i + 1] = Math.round(palettePixels[i + 1]! * factor);
        palettePixels[i + 2] = Math.round(palettePixels[i + 2]! * factor);
        // alpha (i+3) untouched
    }
    return { ...tex, palettePixels };
}

// A representative colour for a part: the mean of the texels at each face's own
// UV centre (parts in one file share the texture but map to different regions,
// so this distinguishes e.g. grassy vs sandy grounds). Sampling per face and
// then averaging the colours — rather than averaging all UVs and sampling once —
// matters because a part's faces map to scattered atlas regions, so the mean UV
// usually lands on an unrelated texel. Used only for editor UI.
function samplePreviewColor(node: PicoCad2Node, rgba: Uint8Array, width: number, height: number): [number, number, number] {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let n = 0;
    for (const face of node.mesh?.faces ?? []) {
        const uvs = face.uvs ?? [];
        if (uvs.length < 2) continue;
        let su = 0;
        let sv = 0;
        let count = 0;
        for (let i = 0; i + 1 < uvs.length; i += 2) {
            su += uvs[i]!;
            sv += uvs[i + 1]!;
            count++;
        }
        const x = Math.min(width - 1, Math.max(0, Math.floor((su / count) * width)));
        const y = Math.min(height - 1, Math.max(0, Math.floor((sv / count) * height)));
        const o = (y * width + x) * 4;
        if ((rgba[o + 3] ?? 255) === 0) continue; // transparent texel says nothing about the part
        sr += rgba[o] ?? 0;
        sg += rgba[o + 1] ?? 0;
        sb += rgba[o + 2] ?? 0;
        n++;
    }
    if (n === 0) return [128, 128, 128];
    return [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
}

/** Is this a known palette id? (narrows a loosely-typed saved value.) */
export function isPaletteId(id: string | undefined): id is PicoCadPaletteId {
    return !!id && id in picoCadPalettes;
}

// A palette theme as a texture override — recolours every dungeon part to that
// palette. (Same four fields as the main pipeline's paletteOverrideFromTheme;
// replicated here so the dungeon bundle doesn't pull in the scene builder.)
export function dungeonPaletteOverride(paletteId: string | undefined): PicoCadPaletteOverride | undefined {
    if (!isPaletteId(paletteId)) return undefined;
    const theme = picoCadPalettes[paletteId];
    return { colors: theme.colors, shadePal1: theme.shadePal1, shadePal2: theme.shadePal2, transparentIndex: theme.transparentIndex };
}

/** Parse one dungeon asset file into its parts + materials. */
export function loadDungeonCategory(category: string, text: string, dimFactor: number, palette?: PicoCadPaletteOverride): DungeonCategory {
    const data = parsePicoCad2(text);
    if (!data.graph) throw new Error(`Dungeon asset "${category}" has no graph`);
    const nodes: Array<{ node: PicoCad2Node; path: number[] }> = [];
    collectMeshNodes(data.graph, [], nodes);

    const tex = buildTextureRGBA(data, palette);

    const parts: DungeonPart[] = nodes.map(({ node, path }) => {
        const name = node.name ?? `part_${path.join('_')}`;
        const modelId = `dungeon:${category}:${name}`;
        const asset = buildMeshAssetFromPicoNode(node, modelId, path);
        if (!asset) throw new Error(`Dungeon part "${category}:${name}" mesh could not be built`);
        return {
            category,
            name,
            meshId: `mesh:${modelId}`,
            builtMesh: buildLocalMeshFromMeshAsset(asset),
            previewColor: samplePreviewColor(node, tex.rgbaPixels, tex.width, tex.height),
        };
    });

    const texture: TextureData = {
        width: tex.width,
        height: tex.height,
        pixels: tex.pixels,
        palettePixels: tex.palettePixels,
        transparentIndex: tex.transparentIndex,
        backgroundIndex: tex.backgroundIndex,
    };
    const materialId = `mat:dungeon:${category}`;
    return {
        name: category,
        parts,
        material: { materialId, texture },
        materialDim: { materialId: `${materialId}:dim`, texture: darkenTexture(texture, dimFactor) },
    };
}

// Raw text of every dungeon asset file, keyed by module path. Eager so the
// catalog is available synchronously during setup. (import.meta.glob's base is
// relative to THIS file — see CLAUDE.md; do not centralize it elsewhere.)
const DUNGEON_ASSET_FILES = import.meta.glob('../assets/dungeon/*.txt', {
    query: '?raw',
    import: 'default',
    eager: true,
}) as Record<string, string>;

/**
 * Build the whole part catalog from src/assets/dungeon/*.txt.
 * `paletteId` (a picoCadPalettes key) recolours every part to that palette;
 * omit/unknown = each file's own authored colours.
 */
export function loadDungeonCatalog(dimFactor = 0.4, paletteId?: string): DungeonCatalog {
    const palette = dungeonPaletteOverride(paletteId);
    const catalog: DungeonCatalog = new Map();
    for (const [path, text] of Object.entries(DUNGEON_ASSET_FILES)) {
        const category = path.split('/').pop()!.replace(/\.txt$/, '');
        catalog.set(category, loadDungeonCategory(category, text, dimFactor, palette));
    }
    return catalog;
}

/** Flat list of every part across all categories (e.g. to register meshes). */
export function allCatalogParts(catalog: DungeonCatalog): DungeonPart[] {
    return [...catalog.values()].flatMap((c) => c.parts);
}

/** Flat list of every material (bright + dim) across all categories. */
export function allCatalogMaterials(catalog: DungeonCatalog): MaterialTextureData[] {
    return [...catalog.values()].flatMap((c) => [c.material, c.materialDim]);
}

// Deterministic per-tile variant index in [0, n): stable across frames/room
// transitions (keyed on the tile's world x/z). Classic hash-noise.
export function tileVariant(x: number, z: number, n: number): number {
    if (n <= 1) return 0;
    const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
    return Math.floor((s - Math.floor(s)) * n) % n;
}

/** What a single tile placement renders as: mesh + bright/dim material + transform. */
export type ResolvedTile = { meshId: string; matBright: string; matDim: string; worldMatrix: Float32Array };

// Builds the one function both the runtime and the editor preview use to turn a
// DungeonPlacement into render data, so the preview matches the game exactly
// (same part meshes, same textures, same Auto/random picks, same placement).
// Floor tiles use the authored floor part when painted, else the deterministic
// per-tile pick; walls use the first "walls" part; missing categories fall back
// to the flat cube. Custom parts are authored on the ground at final size, so
// they're placed at a uniform tile scale; the cube keeps its per-type stretch.
export function makeTileResolver(catalog: DungeonCatalog, fallbackCubeMeshId: string): (p: DungeonPlacement) => ResolvedTile {
    const groundCat = catalog.get('grounds') ?? null;
    const wallCat = catalog.get('walls') ?? null;
    const propCat = catalog.get('props') ?? null;
    const groundParts = groundCat?.parts ?? [];
    const groundByName = new Map(groundParts.map((p) => [p.name, p]));
    const wallByName = new Map((wallCat?.parts ?? []).map((p) => [p.name, p]));
    const propByName = new Map((propCat?.parts ?? []).map((p) => [p.name, p]));
    const foot = TILE_SIZE - TILE_GAP;
    const uniform = (p: DungeonPlacement): Float32Array => dungeonInstanceMatrix([p.pos[0], 0, p.pos[2]], [foot, foot, foot]);
    const flatId = (kind: DungeonPrim, dim: boolean): string => `mat:${kind === 'wall' ? 'wall' : 'floor'}${dim ? '_dim' : ''}`;

    return (p: DungeonPlacement): ResolvedTile => {
        if (p.prim === 'floor' && groundCat && groundParts.length > 0) {
            // Painted floor part, else the deterministic per-tile pick.
            const part = (p.variant ? groundByName.get(p.variant) : undefined) ?? groundParts[tileVariant(p.pos[0], p.pos[2], groundParts.length)]!;
            return { meshId: part.meshId, matBright: groundCat.material.materialId, matDim: groundCat.materialDim.materialId, worldMatrix: uniform(p) };
        }
        if (p.prim === 'wall' && wallCat && wallCat.parts.length > 0) {
            // Painted wall part, else the first (plain wall) — variants aren't random.
            const part = (p.variant ? wallByName.get(p.variant) : undefined) ?? wallCat.parts[0]!;
            return { meshId: part.meshId, matBright: wallCat.material.materialId, matDim: wallCat.materialDim.materialId, worldMatrix: uniform(p) };
        }
        if (p.prim === 'prop' && propCat && propCat.parts.length > 0) {
            const part = (p.variant ? propByName.get(p.variant) : undefined) ?? propCat.parts[0]!;
            return { meshId: part.meshId, matBright: propCat.material.materialId, matDim: propCat.materialDim.materialId, worldMatrix: uniform(p) };
        }
        return { meshId: fallbackCubeMeshId, matBright: flatId(p.prim, false), matDim: flatId(p.prim, true), worldMatrix: dungeonInstanceMatrix(p.pos, p.scale) };
    };
}
