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
import { instantiateEntity } from './lib/entity';
import { PicoCad2Loader } from './lib/loader';
import { type Forward, Object3D } from './lib/object3d';
import { modelBaseName } from './lib/picocad2_animation_extract';
import type { UvTransform } from './lib/renderer';

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
    [num('l-color'), (p, v) => { p.color = v; }, (p) => p.color],
    [num('l-tile-u'), (p, v) => { p.tileU = v; }, (p) => p.tileU],
    [num('l-tile-v'), (p, v) => { p.tileV = v; }, (p) => p.tileV],
    [num('l-tile-size'), (p, v) => { p.tileSize = v; }, (p) => p.tileSize],
    [num('l-repeat-u'), (p, v) => { p.repeatU = v; }, (p) => p.repeatU],
    [num('l-repeat-v'), (p, v) => { p.repeatV = v; }, (p) => p.repeatV],
];

for (const [input, set] of transformInputs) {
    input.addEventListener('input', () => {
        const part = current?.parts[selectedPart];
        if (!part) return;
        const v = input.value.trim() === '' ? null : Number(input.value);
        set(part, v !== null && Number.isFinite(v) ? v : null);
        void rebuildPreview();
    });
}

function fillPartInputs(): void {
    const part = current?.parts[selectedPart] ?? null;
    for (const [input, , get] of transformInputs) {
        input.disabled = !part;
        const value = part ? get(part) : null;
        input.value = value === null ? '' : String(value);
    }
}

function renderParts(): void {
    partListEl.replaceChildren();
    const entity = current;
    if (!entity) return;
    entity.parts.forEach((part, index) => {
        const row = document.createElement('div');
        row.className = `part-row${index === selectedPart ? ' active' : ''}`;
        const name = document.createElement('span');
        name.className = 'part-name';
        name.textContent = `${index}: ${part.mesh}`;
        row.appendChild(name);
        row.addEventListener('click', () => {
            selectedPart = index;
            renderParts();
            fillPartInputs();
        });

        const dup = document.createElement('button');
        dup.className = 'part-mini';
        dup.type = 'button';
        dup.textContent = '⧉';
        dup.title = 'Duplicate part';
        dup.addEventListener('click', (e) => {
            e.stopPropagation();
            entity.parts.splice(index + 1, 0, structuredClone(part));
            selectedPart = index + 1;
            renderParts();
            fillPartInputs();
            void rebuildPreview();
        });

        const del = document.createElement('button');
        del.className = 'part-mini';
        del.type = 'button';
        del.textContent = '×';
        del.title = 'Remove part';
        del.addEventListener('click', (e) => {
            e.stopPropagation();
            entity.parts.splice(index, 1);
            selectedPart = Math.min(selectedPart, entity.parts.length - 1);
            renderParts();
            fillPartInputs();
            void rebuildPreview();
        });

        row.append(dup, del);
        partListEl.appendChild(row);
    });
}

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
                color: null, tileU: null, tileV: null, tileSize: null, repeatU: null, repeatV: null,
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
    void saveGenerated(
        setStatus,
        '/__editor/save-entities',
        { source: generateEntitiesModule(list) },
        SAVED_MESSAGE_KEY,
        `Saved src/assets/entities.ts (${list.length} entities).`,
    );
});

switchTo(current);
restoreSavedMessage(setStatus, SAVED_MESSAGE_KEY);

Object.assign(window as unknown as Record<string, unknown>, { viewport });
