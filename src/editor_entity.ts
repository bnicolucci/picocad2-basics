// Entity Editor — curates the generated src/assets/entities.ts: compose an
// entity from parts (custom models and/or primitives), set each part's
// transform + look, and the entity's rest facing / collider radius / tags.
// The preview drives the real loader/renderer; `forward` is the VISIBLE nose
// direction (as seen here and in picoCAD2 — never raw file space), shown by
// the arrow, and it is exactly what faceToward aligns to movement in-game.
//
// Dev-only page; Save POSTs the regenerated module to the editor-save
// middleware in vite.config.ts and round-trips its state out of the
// generated file itself.

import { entities as savedEntities } from './assets/entities';
import cubeText from './assets/primitives/mesh_cube.txt?raw';
import { restoreSavedMessage, saveGenerated, statusReporter } from './lib/editorPage';
import { createEditorViewport } from './lib/editorViewport';
import type { EntityBlueprint, EntityPart } from './lib/entity';
import { createsCycle, insertWithParents, instantiateEntity, removeWithParents, resolveParent } from './lib/entity';
import { textureRgba, tileAtPixel, tileGrid } from './lib/editorTexture';
import { PicoCad2Loader, type PicoCadModel } from './lib/loader';
import { type Forward, Object3D } from './lib/object3d';
import { modelBaseName } from './lib/picocad2_animation_extract';
import { picoCadPalettes } from './assets/palettes/picocad_palettes';
import type { BuiltTexture } from './lib/picocad2';
import { computeUvBounds, type UvTransform } from './lib/renderer';

const PRIMITIVE_FILES = import.meta.glob(
    ['./assets/primitives/*.txt', '!./assets/primitives/*-anim-*.txt', '!./assets/primitives/*_anim_*.txt'],
    { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;

const MODEL_FILES = import.meta.glob(
    ['./assets/models/*.txt', '!./assets/models/*-anim-*.txt', '!./assets/models/*_anim_*.txt'],
    { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;

// mesh name -> where it lives (import path relative to src/assets, for the
// generated module) and how to load its text in the editor.
type MeshSource = { importPath: string; load: () => Promise<string> };
const meshSources = new Map<string, MeshSource>();
for (const files of [PRIMITIVE_FILES, MODEL_FILES]) {
    for (const [path, load] of Object.entries(files)) {
        meshSources.set(modelBaseName(path), { importPath: path.replace('./assets/', './'), load });
    }
}

type V3 = [number, number, number];
type WorkingPart = {
    mesh: string;
    pos: V3;
    rot: V3; // degrees
    scale: V3;
    color: number | null;
    tileU: number | null;
    tileV: number | null;
    tileSize: number | null;
    repeatU: number | null;
    repeatV: number | null;
    /** Index of the part this hangs off, or null for the entity root. */
    parent: number | null;
};
type WorkingEntity = {
    name: string;
    /** Name in the generated file, or null when never saved. Renaming or
        deleting a saved entity breaks code calling spawnEntity('<savedName>'),
        so those get a warning. */
    savedName: string | null;
    forward: Forward;
    radius: number | null;
    tags: string[];
    parts: WorkingPart[];
};

function toWorkingPart(part: EntityPart): WorkingPart {
    return {
        mesh: part.mesh,
        pos: [...(part.pos ?? [0, 0, 0])] as V3,
        rot: [...(part.rot ?? [0, 0, 0])] as V3,
        scale: [...(part.scale ?? [1, 1, 1])] as V3,
        color: part.color ?? null,
        tileU: part.uv?.tile?.u ?? null,
        tileV: part.uv?.tile?.v ?? null,
        tileSize: part.uv?.tile?.size ?? null,
        repeatU: part.uv?.repeatU ?? null,
        repeatV: part.uv?.repeatV ?? null,
        parent: part.parent ?? null,
    };
}

function toEntityPart(part: WorkingPart): EntityPart {
    const uv: UvTransform = {};
    if (part.tileU !== null && part.tileV !== null) {
        uv.tile = { u: part.tileU, v: part.tileV, ...(part.tileSize !== null ? { size: part.tileSize } : {}) };
    }
    if (part.repeatU !== null) uv.repeatU = part.repeatU;
    if (part.repeatV !== null) uv.repeatV = part.repeatV;
    return {
        mesh: part.mesh,
        ...(part.pos.some((n) => n !== 0) ? { pos: part.pos } : {}),
        ...(part.rot.some((n) => n !== 0) ? { rot: part.rot } : {}),
        ...(part.scale.some((n) => n !== 1) ? { scale: part.scale } : {}),
        ...(part.color !== null ? { color: part.color } : {}),
        ...(uv.tile || uv.repeatU !== undefined || uv.repeatV !== undefined ? { uv } : {}),
        ...(part.parent !== null ? { parent: part.parent } : {}),
    };
}

function toBlueprint(entity: WorkingEntity): EntityBlueprint {
    return {
        ...(entity.forward !== 'z+' ? { forward: entity.forward } : {}),
        ...(entity.radius !== null ? { radius: entity.radius } : {}),
        ...(entity.tags.length > 0 ? { tags: entity.tags } : {}),
        parts: entity.parts.map(toEntityPart),
    };
}

const list: WorkingEntity[] = Object.entries(savedEntities as Record<string, EntityBlueprint>).map(([name, bp]) => ({
    name,
    savedName: name,
    forward: bp.forward ?? 'z+',
    radius: bp.radius ?? null,
    tags: [...(bp.tags ?? [])],
    parts: bp.parts.map(toWorkingPart),
}));

let current: WorkingEntity | null = list[0] ?? null;
let selectedPart = current && current.parts.length > 0 ? 0 : -1;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const entitySelect = $<HTMLSelectElement>('entity-select');
const entityName = $<HTMLInputElement>('entity-name');
const partListEl = $<HTMLDivElement>('part-list');
const statusEl = $('status');
const baseStatus = statusReporter(statusEl);
const setStatus = (message: string, isError = false): void => {
    baseStatus(message, isError);
    statusEl.classList.remove('warn');
};
const setWarning = (message: string): void => {
    baseStatus(message);
    statusEl.classList.add('warn');
};
const SAVED_MESSAGE_KEY = 'entity-editor:saved';

// Saving rewrites a file this page imports, so Vite reloads the page under us.
// The selection has to be carried across by hand or the reload drops you back
// on the first entity — invisible while there is only one, and infuriating the
// moment there are two.
const SELECTION_KEY = 'entity-editor:selection';

function rememberSelection(): void {
    if (!current) return;
    sessionStorage.setItem(SELECTION_KEY, JSON.stringify({ entity: current.name, part: selectedPart }));
}

/** What to reopen after a save reload. Keyed by NAME, not index, so it survives
    entities being renamed into a different order or added alongside. */
function takeRememberedSelection(): { entity: WorkingEntity; part: number } | null {
    const raw = sessionStorage.getItem(SELECTION_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(SELECTION_KEY);
    try {
        const saved = JSON.parse(raw) as { entity?: string; part?: number };
        const entity = list.find((e) => e.name === saved.entity);
        if (!entity) return null;
        const valid = typeof saved.part === 'number' && saved.part >= 0 && saved.part < entity.parts.length;
        return { entity, part: valid ? (saved.part as number) : entity.parts.length > 0 ? 0 : -1 };
    } catch {
        return null; // a malformed hand-off just means the default selection
    }
}

// --- viewport -----------------------------------------------------------

const viewport = createEditorViewport($<HTMLCanvasElement>('viewport'), { background: '#12161b' });
const gizmoModel = new PicoCad2Loader().parse(cubeText);
let entityGroup: Object3D | null = null;
let gizmoGroup: Object3D | null = null;
let labelRadius = 3;
let rebuildToken = 0;

// `forward` IS the visible nose direction, so the arrow maps it directly.
const VISUAL_DIR: Record<Forward, V3> = {
    'x+': [1, 0, 0], 'x-': [-1, 0, 0],
    'y+': [0, 1, 0], 'y-': [0, -1, 0],
    'z+': [0, 0, 1], 'z-': [0, 0, -1],
};

function buildGizmo(forward: Forward, length: number): Object3D {
    const group = new Object3D();
    const v = VISUAL_DIR[forward];
    if (forward === 'y+') group.rotation.set(-Math.PI / 2, 0, 0);
    else if (forward === 'y-') group.rotation.set(Math.PI / 2, 0, 0);
    else group.rotation.set(0, Math.atan2(v[0], v[2]), 0);
    const shaft = gizmoModel.instantiate({ color: 9 });
    shaft.scale.set(0.06, 0.06, length);
    shaft.position.set(0, 0, length / 2);
    const tip = gizmoModel.instantiate({ color: 8 });
    tip.scale.set(0.16, 0.16, 0.22);
    tip.position.set(0, 0, length + 0.11);
    group.add(shaft, tip);
    return group;
}

function estRadius(entity: WorkingEntity): number {
    let r = 2;
    for (const part of entity.parts) {
        r = Math.max(r, Math.hypot(part.pos[0], part.pos[1], part.pos[2]) + 1.5);
    }
    return r;
}

const textCache = new Map<string, string>();

async function rebuildPreview(frame = false): Promise<void> {
    const token = ++rebuildToken;
    const entity = current;
    if (entityGroup) viewport.scene.remove(entityGroup);
    if (gizmoGroup) viewport.scene.remove(gizmoGroup);
    entityGroup = null;
    gizmoGroup = null;
    if (!entity) return;

    const missing = entity.parts.map((p) => p.mesh).filter((m) => !textCache.has(m));
    if (missing.length > 0) {
        await Promise.all(
            [...new Set(missing)].map(async (mesh) => {
                const source = meshSources.get(mesh);
                if (source) textCache.set(mesh, await source.load());
            }),
        );
        if (token !== rebuildToken) return;
    }

    const unresolved = entity.parts.filter((p) => !textCache.has(p.mesh)).map((p) => p.mesh);
    if (unresolved.length > 0) {
        setStatus(`Missing mesh file(s): ${[...new Set(unresolved)].join(', ')}`, true);
        return;
    }
    // The picker needs the mesh text, which may only have arrived just now.
    drawUv();

    try {
        entityGroup = instantiateEntity(toBlueprint(entity), (mesh) => textCache.get(mesh));
    } catch (error) {
        setStatus(`Preview failed: ${error instanceof Error ? error.message : error}`, true);
        return;
    }
    viewport.scene.add(entityGroup);

    labelRadius = estRadius(entity);
    gizmoGroup = buildGizmo(entity.forward, labelRadius * 0.7);
    viewport.scene.add(gizmoGroup);
    if (frame) viewport.frame({ x: 0, y: labelRadius * 0.25, z: 0 }, labelRadius);
}

// Axis labels track the projected axis endpoints every frame.
const axisLabels: [HTMLElement, () => V3][] = [
    [$('axis-px'), () => [labelRadius, 0, 0]],
    [$('axis-nx'), () => [-labelRadius, 0, 0]],
    [$('axis-pz'), () => [0, 0, labelRadius]],
    [$('axis-nz'), () => [0, 0, -labelRadius]],
];
(function placeLabels(): void {
    for (const [el, at] of axisLabels) {
        const [x, y, z] = at();
        const p = viewport.project(x, y, z);
        el.style.display = p ? '' : 'none';
        if (p) {
            el.style.left = `${p.x}px`;
            el.style.top = `${p.y}px`;
        }
    }
    requestAnimationFrame(placeLabels);
})();

// --- inspector ----------------------------------------------------------

function num(id: string): HTMLInputElement {
    return $<HTMLInputElement>(id);
}

// A bigger tile size means fewer tiles, which can leave the chosen one off the
// grid — so this one input needs its own follow-up.
const tileSizeInput = num('l-tile-size');

const transformInputs: [HTMLInputElement, (p: WorkingPart, v: number | null) => void, (p: WorkingPart) => number | null][] = [
    [num('t-pos-x'), (p, v) => { p.pos[0] = v ?? 0; }, (p) => p.pos[0]],
    [num('t-pos-y'), (p, v) => { p.pos[1] = v ?? 0; }, (p) => p.pos[1]],
    [num('t-pos-z'), (p, v) => { p.pos[2] = v ?? 0; }, (p) => p.pos[2]],
    [num('t-rot-x'), (p, v) => { p.rot[0] = v ?? 0; }, (p) => p.rot[0]],
    [num('t-rot-y'), (p, v) => { p.rot[1] = v ?? 0; }, (p) => p.rot[1]],
    [num('t-rot-z'), (p, v) => { p.rot[2] = v ?? 0; }, (p) => p.rot[2]],
    [num('t-scale-x'), (p, v) => { p.scale[0] = v ?? 1; }, (p) => p.scale[0]],
    [num('t-scale-y'), (p, v) => { p.scale[1] = v ?? 1; }, (p) => p.scale[1]],
    [num('t-scale-z'), (p, v) => { p.scale[2] = v ?? 1; }, (p) => p.scale[2]],
    [num('l-tile-u'), (p, v) => { p.tileU = v; }, (p) => p.tileU],
    [num('l-tile-v'), (p, v) => { p.tileV = v; }, (p) => p.tileV],
    [tileSizeInput, (p, v) => { p.tileSize = v; }, (p) => p.tileSize],
    [num('l-repeat-u'), (p, v) => { p.repeatU = v; }, (p) => p.repeatU],
    [num('l-repeat-v'), (p, v) => { p.repeatV = v; }, (p) => p.repeatV],
];

for (const [input, set] of transformInputs) {
    input.addEventListener('input', () => {
        const part = current?.parts[selectedPart];
        if (!part) return;
        const v = input.value.trim() === '' ? null : Number(input.value);
        set(part, v !== null && Number.isFinite(v) ? v : null);
        if (input === tileSizeInput) {
            clampTile(part);
            fillPartInputs(); // redraws the picker too
        } else {
            drawUv();
        }
        void rebuildPreview();
    });
}

/** Pull a chosen tile back inside the grid — the grid shrinks when the tile
    size grows, and an off-grid tile samples nothing. */
function clampTile(part: WorkingPart): void {
    if (part.tileU === null || part.tileV === null) return;
    const model = modelFor(part.mesh);
    if (!model) return;
    const { cols, rows } = tileGrid(model.texture, part.tileSize ?? DEFAULT_TILE_SIZE);
    part.tileU = Math.min(cols, Math.max(1, part.tileU));
    part.tileV = Math.min(rows, Math.max(1, part.tileV));
}

function fillPartInputs(): void {
    const part = current?.parts[selectedPart] ?? null;
    for (const [input, , get] of transformInputs) {
        input.disabled = !part;
        const value = part ? get(part) : null;
        input.value = value === null ? '' : String(value);
    }
    renderColorSwatches();
    drawUv();
}

// --- solid colour -------------------------------------------------------
// `color` is a palette index, so a number box means guessing what 7 looks like.
// The swatches are drawn from the part's OWN model palette, so they are the
// colours you will actually get.

const colorSwatchesEl = $('color-swatches');

/** Palette row 0 (the lit colour) of a model, as 16 CSS colours. */
function paletteCss(texture: BuiltTexture): string[] {
    return Array.from({ length: 16 }, (_, i) => {
        const o = i * 4;
        return `rgb(${texture.palettePixels[o]}, ${texture.palettePixels[o + 1]}, ${texture.palettePixels[o + 2]})`;
    });
}

function renderColorSwatches(): void {
    colorSwatchesEl.replaceChildren();
    const part = current?.parts[selectedPart] ?? null;
    if (!part) return;
    const texture = modelFor(part.mesh)?.texture ?? gizmoModel.texture;
    const colors = paletteCss(texture);

    const swatch = (label: string, title: string, value: number | null, css?: string): HTMLButtonElement => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `color-swatch${value === null ? ' none' : ''}${part.color === value ? ' active' : ''}`;
        button.title = title;
        button.setAttribute('aria-label', label);
        if (css) button.style.background = css;
        button.addEventListener('click', () => {
            part.color = value;
            renderColorSwatches();
            void rebuildPreview();
        });
        return button;
    };

    colorSwatchesEl.appendChild(swatch('none', 'None — keep the texture', null));
    colors.forEach((css, index) => {
        colorSwatchesEl.appendChild(swatch(String(index), `Colour ${index}`, index, css));
    });
}

// --- entity palette -----------------------------------------------------
// The primitives are authored against one 16-colour palette; this shows it, and
// lets you hold any of the other picoCAD palettes up against it.

const basePaletteEl = $('base-palette');
const paletteSelect = $<HTMLSelectElement>('palette-select');
const palettePreviewEl = $('palette-preview');
const paletteNoteEl = $('palette-note');

function fillSwatchRow(el: HTMLElement, colors: string[], titles: (i: number) => string): void {
    el.replaceChildren();
    el.classList.add('readonly', 'palette');
    colors.forEach((css, index) => {
        const chip = document.createElement('div');
        chip.className = 'color-swatch';
        chip.style.background = css;
        chip.title = titles(index);
        el.appendChild(chip);
    });
}

function renderPalettes(): void {
    const base = paletteCss(gizmoModel.texture);
    fillSwatchRow(basePaletteEl, base, (i) => `${i}: ${base[i]}`);

    const chosen = picoCadPalettes[paletteSelect.value as keyof typeof picoCadPalettes];
    if (!chosen) return;
    const colors = chosen.colors.map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`);
    fillSwatchRow(palettePreviewEl, colors, (i) => `${i}: ${colors[i]}`);
    paletteNoteEl.textContent = `${chosen.name} — ${chosen.author}. Reference only: a part's colours come from its own model file.`;
}

for (const [id, palette] of Object.entries(picoCadPalettes)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = palette.name;
    paletteSelect.appendChild(option);
}
paletteSelect.addEventListener('change', renderPalettes);
renderPalettes();

// --- UV picker ----------------------------------------------------------
// The part's texture, drawn at native size and CSS-scaled up, with the tile
// grid over it. A `uv.tile` is a 1-based column/row into that grid, so picking
// one is just working out which cell was clicked — the numbers above the canvas
// and the canvas itself are two views of the same two values.

const uvCanvas = $<HTMLCanvasElement>('uv-canvas');
const uvCtx = uvCanvas.getContext('2d')!;
const uvHint = $('uv-hint');
const uvClear = $<HTMLButtonElement>('uv-clear');

const DEFAULT_TILE_SIZE = 16;
const uvLoader = new PicoCad2Loader();
const modelCache = new Map<string, PicoCadModel>();

/** The parsed model for a mesh, once its text has been loaded by the preview. */
function modelFor(mesh: string): PicoCadModel | null {
    const cached = modelCache.get(mesh);
    if (cached) return cached;
    const text = textCache.get(mesh);
    if (!text) return null;
    try {
        const model = uvLoader.parse(text);
        modelCache.set(mesh, model);
        return model;
    } catch {
        return null;
    }
}

function drawUv(): void {
    const part = current?.parts[selectedPart] ?? null;
    const model = part ? modelFor(part.mesh) : null;

    if (!part || !model) {
        uvCtx.clearRect(0, 0, uvCanvas.width, uvCanvas.height);
        uvCanvas.classList.add('disabled');
        uvHint.textContent = part ? 'Loading texture…' : 'Select a part to pick its UV.';
        uvClear.disabled = true;
        return;
    }
    uvCanvas.classList.remove('disabled');

    const tex = model.texture;
    if (uvCanvas.width !== tex.width || uvCanvas.height !== tex.height) {
        uvCanvas.width = tex.width;
        uvCanvas.height = tex.height;
    }
    const image = new ImageData(textureRgba(tex), tex.width, tex.height);
    uvCtx.putImageData(image, 0, 0);

    const size = Math.max(1, part.tileSize ?? DEFAULT_TILE_SIZE);
    const { cols, rows } = tileGrid(tex, size);
    const hasTile = part.tileU !== null && part.tileV !== null;

    // Everything outside the chosen tile is dimmed, then that tile is put back
    // at full brightness — the same pixels, so what you see is what samples.
    if (hasTile) {
        const x = (part.tileU! - 1) * size;
        const y = (part.tileV! - 1) * size;
        uvCtx.fillStyle = 'rgba(0, 0, 0, 0.62)';
        uvCtx.fillRect(0, 0, tex.width, tex.height);
        uvCtx.putImageData(image, 0, 0, x, y, size, size);
    }

    uvCtx.lineWidth = 1;
    uvCtx.strokeStyle = 'rgba(255, 255, 255, 0.13)';
    uvCtx.beginPath();
    for (let c = 1; c < cols; c++) {
        uvCtx.moveTo(c * size + 0.5, 0);
        uvCtx.lineTo(c * size + 0.5, rows * size);
    }
    for (let r = 1; r < rows; r++) {
        uvCtx.moveTo(0, r * size + 0.5);
        uvCtx.lineTo(cols * size, r * size + 0.5);
    }
    uvCtx.stroke();

    if (hasTile) {
        const offGrid = part.tileU! > cols || part.tileV! > rows;
        uvCtx.strokeStyle = offGrid ? '#e06060' : '#ffd23c';
        uvCtx.strokeRect((part.tileU! - 1) * size + 0.5, (part.tileV! - 1) * size + 0.5, size - 1, size - 1);
        uvHint.textContent = offGrid
            ? `tile ${part.tileU},${part.tileV} is outside the ${cols}×${rows} grid — it samples nothing`
            : `tile ${part.tileU},${part.tileV} · ${size}px · grid ${cols}×${rows}`;
    } else {
        // No override: outline the patch this model samples on its own, so you
        // can see what you are about to replace.
        const [bu, bv, bw, bh] = computeUvBounds(model.meshes);
        uvCtx.strokeStyle = '#6ab0ff';
        uvCtx.setLineDash([2, 2]);
        uvCtx.strokeRect(bu * tex.width + 0.5, bv * tex.height + 0.5, Math.max(1, bw * tex.width) - 1, Math.max(1, bh * tex.height) - 1);
        uvCtx.setLineDash([]);
        uvHint.textContent = `model's own UVs (dashed) · click a tile to override · grid ${cols}×${rows}`;
    }
    uvClear.disabled = !hasTile;
}

function pickTile(event: PointerEvent): void {
    const part = current?.parts[selectedPart];
    const model = part ? modelFor(part.mesh) : null;
    if (!part || !model) return;

    // The canvas is drawn at texture size and stretched by CSS, so go through
    // its displayed rect rather than assuming a 1:1 pixel ratio.
    const rect = uvCanvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * uvCanvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * uvCanvas.height;
    const { u, v } = tileAtPixel(x, y, part.tileSize ?? DEFAULT_TILE_SIZE, model.texture);
    if (part.tileU === u && part.tileV === v) return;

    part.tileU = u;
    part.tileV = v;
    fillPartInputs();
    void rebuildPreview();
}

uvCanvas.addEventListener('pointerdown', (event) => {
    if (!current?.parts[selectedPart]) return;
    uvCanvas.setPointerCapture(event.pointerId);
    pickTile(event);
});
uvCanvas.addEventListener('pointermove', (event) => {
    if (uvCanvas.hasPointerCapture(event.pointerId)) pickTile(event);
});
uvCanvas.addEventListener('pointerup', (event) => uvCanvas.releasePointerCapture(event.pointerId));

uvClear.addEventListener('click', () => {
    const part = current?.parts[selectedPart];
    if (!part) return;
    part.tileU = null;
    part.tileV = null;
    part.tileSize = null;
    fillPartInputs();
    void rebuildPreview();
});

// --- outliner -----------------------------------------------------------
// Parents are stored as indices into the parts array, so anything that shifts
// those indices has to carry the references with it. Getting this wrong
// silently re-parents unrelated parts, so insert and remove go through here.

/** The parent the runtime will actually use — same rules, so the outliner can
    never show a nesting the game would not build. */
function effectiveParent(parts: WorkingPart[], index: number): number | null {
    return resolveParent(
        parts.map((p) => ({ mesh: p.mesh, ...(p.parent !== null ? { parent: p.parent } : {}) })),
        index,
    );
}

function setParent(index: number, parent: number | null): void {
    const entity = current;
    if (!entity || index === parent) return;
    if (parent !== null && createsCycle(entity.parts, index, parent)) {
        setWarning(`Part ${index} is already above part ${parent} — that would loop.`);
        return;
    }
    entity.parts[index].parent = parent;
    renderParts();
    void rebuildPreview();
}

let dragIndex: number | null = null;

function partRow(entity: WorkingEntity, index: number, depth: number): HTMLDivElement {
    const part = entity.parts[index];
    const row = document.createElement('div');
    row.className = `part-row${index === selectedPart ? ' active' : ''}`;
    row.style.marginLeft = `${depth * 12}px`;
    row.draggable = true;

    const name = document.createElement('span');
    name.className = 'part-name';
    name.textContent = `${index}: ${part.mesh}`;
    row.appendChild(name);
    row.addEventListener('click', () => {
        selectedPart = index;
        renderParts();
        fillPartInputs();
    });

    row.addEventListener('dragstart', (event) => {
        dragIndex = index;
        event.dataTransfer?.setData('text/plain', String(index));
    });
    row.addEventListener('dragend', () => {
        dragIndex = null;
        renderParts();
    });
    row.addEventListener('dragover', (event) => {
        if (dragIndex === null || dragIndex === index) return;
        event.preventDefault();
        row.classList.add('drop-into');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-into'));
    row.addEventListener('drop', (event) => {
        event.preventDefault();
        event.stopPropagation(); // otherwise the list below unparents it again
        row.classList.remove('drop-into');
        if (dragIndex !== null) setParent(dragIndex, index);
        dragIndex = null;
    });

    const dup = document.createElement('button');
    dup.className = 'part-mini';
    dup.type = 'button';
    dup.textContent = '⧉';
    dup.title = 'Duplicate part';
    dup.addEventListener('click', (e) => {
        e.stopPropagation();
        insertWithParents(entity.parts, index + 1, structuredClone(part));
        selectedPart = index + 1;
        renderParts();
        fillPartInputs();
        void rebuildPreview();
    });

    const del = document.createElement('button');
    del.className = 'part-mini';
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Remove part (its children move up)';
    del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeWithParents(entity.parts, index);
        selectedPart = Math.min(selectedPart, entity.parts.length - 1);
        renderParts();
        fillPartInputs();
        void rebuildPreview();
    });

    row.append(dup, del);
    return row;
}

function renderParts(): void {
    partListEl.replaceChildren();
    const entity = current;
    if (!entity) return;

    // Group by the parent the runtime would use, then walk roots downwards so
    // the list reads as the tree it builds.
    const childrenOf = new Map<number | null, number[]>();
    entity.parts.forEach((_, index) => {
        const key = effectiveParent(entity.parts, index);
        const bucket = childrenOf.get(key);
        if (bucket) bucket.push(index);
        else childrenOf.set(key, [index]);
    });

    const emit = (parent: number | null, depth: number): void => {
        for (const index of childrenOf.get(parent) ?? []) {
            partListEl.appendChild(partRow(entity, index, depth));
            emit(index, depth + 1);
        }
    };
    emit(null, 0);
}

// Dropping on the empty space below the rows detaches a part back to the root.
partListEl.addEventListener('dragover', (event) => {
    if (dragIndex !== null) event.preventDefault();
});
partListEl.addEventListener('drop', (event) => {
    event.preventDefault();
    if (dragIndex !== null) setParent(dragIndex, null);
    dragIndex = null;
});

const facingButtons = [...document.querySelectorAll<HTMLButtonElement>('.facing-btn')];
for (const btn of facingButtons) {
    btn.addEventListener('click', () => {
        if (!current) return;
        current.forward = btn.dataset.forward as Forward;
        renderEntityFields();
        void rebuildPreview();
    });
}

const radiusInput = num('e-radius');
radiusInput.addEventListener('input', () => {
    if (!current) return;
    const v = radiusInput.value.trim() === '' ? null : Number(radiusInput.value);
    current.radius = v !== null && Number.isFinite(v) && v > 0 ? v : null;
});

const tagsInput = $<HTMLInputElement>('e-tags');
tagsInput.addEventListener('input', () => {
    if (!current) return;
    current.tags = tagsInput.value.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
});

entityName.addEventListener('input', () => {
    if (!current) return;
    current.name = entityName.value.trim();
    renderEntitySelect();
    // Renaming is not a way to create an entity — say so, since silently
    // losing the old name is the easiest mistake to make here.
    if (current.savedName && current.name !== current.savedName) {
        setWarning(`Renaming "${current.savedName}" → "${current.name}". Code calling spawnEntity('${current.savedName}') must be updated — use "+ New" to add an entity instead.`);
    } else {
        setStatus('');
    }
});

function renderEntityFields(): void {
    const entity = current;
    entityName.value = entity?.name ?? '';
    entityName.disabled = !entity;
    radiusInput.value = entity?.radius != null ? String(entity.radius) : '';
    radiusInput.disabled = !entity;
    tagsInput.value = entity ? entity.tags.join(', ') : '';
    tagsInput.disabled = !entity;
    for (const btn of facingButtons) {
        btn.classList.toggle('active', !!entity && btn.dataset.forward === entity.forward);
        btn.disabled = !entity;
    }
}

// --- entity list --------------------------------------------------------

function renderEntitySelect(): void {
    const index = current ? list.indexOf(current) : -1;
    entitySelect.replaceChildren();
    list.forEach((entity, i) => {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = entity.name || '(unnamed)';
        entitySelect.appendChild(option);
    });
    entitySelect.value = String(index);
}

function switchTo(entity: WorkingEntity | null): void {
    current = entity;
    selectedPart = entity && entity.parts.length > 0 ? 0 : -1;
    renderEntitySelect();
    renderParts();
    fillPartInputs();
    renderEntityFields();
    void rebuildPreview(true);
}

entitySelect.addEventListener('change', () => {
    switchTo(list[Number(entitySelect.value)] ?? null);
    setStatus('');
});

function freshName(base: string): string {
    if (!list.some((e) => e.name === base)) return base;
    let n = 2;
    while (list.some((e) => e.name === `${base}${n}`)) n++;
    return `${base}${n}`;
}

$('new-btn').addEventListener('click', () => {
    const entity: WorkingEntity = { name: freshName('entity'), savedName: null, forward: 'z+', radius: null, tags: [], parts: [] };
    list.push(entity);
    switchTo(entity);
    setStatus(`New entity "${entity.name}" — add parts, then rename it and Save.`);
});

$('dup-btn').addEventListener('click', () => {
    if (!current) return;
    const entity: WorkingEntity = {
        ...structuredClone({ ...current, savedName: null }),
        name: freshName(current.name),
        savedName: null,
    };
    list.push(entity);
    switchTo(entity);
    setStatus(`Duplicated into "${entity.name}".`);
});

$('delete-btn').addEventListener('click', () => {
    if (!current) return;
    const index = list.indexOf(current);
    const gone = current;
    list.splice(index, 1);
    switchTo(list[Math.min(index, list.length - 1)] ?? null);
    if (gone.savedName) {
        setWarning(`Deleted "${gone.savedName}" — it stays in the file until you Save, and code calling spawnEntity('${gone.savedName}') will stop compiling.`);
    } else {
        setStatus(`Deleted "${gone.name}".`);
    }
});

// --- mesh palette -------------------------------------------------------

function renderMeshList(el: HTMLElement, files: Record<string, () => Promise<string>>): void {
    const names = Object.keys(files).map(modelBaseName).sort();
    for (const name of names) {
        const item = document.createElement('div');
        item.className = 'mesh-item';
        item.textContent = name;
        item.addEventListener('click', () => {
            if (!current) return;
            current.parts.push({
                mesh: name,
                pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1],
                color: null, tileU: null, tileV: null, tileSize: null, repeatU: null, repeatV: null, parent: null,
            });
            selectedPart = current.parts.length - 1;
            renderParts();
            fillPartInputs();
            void rebuildPreview();
        });
        el.appendChild(item);
    }
}
renderMeshList($('primitive-list'), PRIMITIVE_FILES);
renderMeshList($('model-list'), MODEL_FILES);

// --- save ---------------------------------------------------------------

function meshIdent(mesh: string): string {
    return `${mesh.replace(/[^A-Za-z0-9_$]/g, '_')}Text`;
}

function serializePart(part: EntityPart): string {
    const fields: string[] = [`mesh: ${JSON.stringify(part.mesh)}`];
    if (part.pos) fields.push(`pos: [${part.pos.join(', ')}]`);
    if (part.rot) fields.push(`rot: [${part.rot.join(', ')}]`);
    if (part.scale) fields.push(`scale: [${part.scale.join(', ')}]`);
    if (part.color !== undefined) fields.push(`color: ${part.color}`);
    if (part.uv) fields.push(`uv: ${JSON.stringify(part.uv).replace(/"([^"]+)":/g, '$1: ').replace(/,/g, ', ').replace(/\{/g, '{ ').replace(/\}/g, ' }')}`);
    if (part.parent !== undefined) fields.push(`parent: ${part.parent}`);
    return `            { ${fields.join(', ')} },`;
}

function generateEntitiesModule(entities: WorkingEntity[]): string {
    const usedMeshes: string[] = [];
    for (const entity of entities) {
        for (const part of entity.parts) {
            if (!usedMeshes.includes(part.mesh)) usedMeshes.push(part.mesh);
        }
    }
    const imports = usedMeshes
        .map((mesh) => `import ${meshIdent(mesh)} from '${meshSources.get(mesh)!.importPath}?raw';`)
        .sort();

    const entityEntries = entities.map((entity) => {
        const bp = toBlueprint(entity);
        const lines = [`    ${JSON.stringify(entity.name)}: {`];
        if (bp.forward) lines.push(`        forward: ${JSON.stringify(bp.forward)},`);
        if (bp.radius !== undefined) lines.push(`        radius: ${bp.radius},`);
        if (bp.tags) lines.push(`        tags: [${bp.tags.map((t) => JSON.stringify(t)).join(', ')}],`);
        lines.push('        parts: [');
        for (const part of bp.parts) lines.push(serializePart(part));
        lines.push('        ],');
        lines.push('    },');
        return lines.join('\n');
    });

    return [
        '// GENERATED by the Entity editor (/editor_entity.html) — Save regenerates',
        '// this file via the editor-save middleware. An entity = parts (models and/or',
        '// primitives, each with its own transform + look) plus rest facing, collider',
        "// radius, and tags. Entity names are typed: spawnEntity('pig') autocompletes",
        '// and a stale name is a compile error. Only meshes entities actually use are',
        '// imported, so everything else tree-shakes out of the build.',
        "import { type EntityBlueprint, instantiateEntity } from '../lib/entity';",
        "import type { Object3D } from '../lib/object3d';",
        ...imports,
        '',
        'const meshTexts: Record<string, string> = {',
        ...usedMeshes.map((mesh) => `    ${JSON.stringify(mesh)}: ${meshIdent(mesh)},`),
        '};',
        '',
        'export const entities = {',
        ...entityEntries,
        '} as const satisfies Record<string, EntityBlueprint>;',
        '',
        'export type EntityName = keyof typeof entities;',
        '',
        'export const spawnEntity = (name: EntityName): Object3D => instantiateEntity(entities[name], (mesh) => meshTexts[mesh]);',
        '',
    ].join('\n');
}

$('save-btn').addEventListener('click', () => {
    const names = new Set<string>();
    for (const entity of list) {
        if (!entity.name || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entity.name)) {
            setStatus(`"${entity.name || '(unnamed)'}" is not a valid entity name (identifier-like, e.g. snowman).`, true);
            return;
        }
        if (names.has(entity.name)) {
            setStatus(`Duplicate entity name "${entity.name}".`, true);
            return;
        }
        names.add(entity.name);
        for (const part of entity.parts) {
            if (!meshSources.has(part.mesh)) {
                setStatus(`"${entity.name}" uses mesh "${part.mesh}" which has no file on disk.`, true);
                return;
            }
        }
    }
    rememberSelection();
    void saveGenerated(
        setStatus,
        '/__editor/save-entities',
        { source: generateEntitiesModule(list) },
        SAVED_MESSAGE_KEY,
        `Saved src/assets/entities.ts (${list.length} entities).`,
    );
});

const reopen = takeRememberedSelection();
switchTo(reopen?.entity ?? current);
if (reopen && reopen.part !== selectedPart) {
    selectedPart = reopen.part;
    renderParts();
    fillPartInputs();
}
restoreSavedMessage(setStatus, SAVED_MESSAGE_KEY);

Object.assign(window as unknown as Record<string, unknown>, { viewport });
