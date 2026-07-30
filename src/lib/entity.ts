import { PicoCad2Loader, type PicoCadModel } from './loader';
import { type Forward, Object3D } from './object3d';
import type { UvTransform } from './renderer';

// Entities: reusable game things composed of PARTS — custom models or the
// stock primitives — plus the gameplay facts the engine needs (rest facing,
// collider radius, tags). Blueprints live in the GENERATED src/assets/
// entities.ts (curated in /editor_entity.html); spawnEntity there builds one.

export type EntityVec = readonly [number, number, number];

export type EntityPart = {
    /** Mesh name: a model ('pig') or primitive ('mesh_sphere'). */
    mesh: string;
    pos?: EntityVec;
    /** Degrees (hand-readable in the registry); converted at spawn. */
    rot?: EntityVec;
    scale?: EntityVec;
    /** Flat (still shaded) palette colour override. */
    color?: number;
    uv?: UvTransform;
    /** Index of the part this one hangs off, within the same `parts` array.
        Absent means it sits on the entity root. A child's transform is relative
        to its parent, so moving or rotating the parent carries it along. Parts
        may reference a parent that appears later in the array. */
    parent?: number;
};

export type EntityBlueprint = {
    /** The visible nose direction (as seen in picoCAD2). Default 'z+'. */
    forward?: Forward;
    /** Circle collider radius; absent = not solid. */
    radius?: number;
    tags?: readonly string[];
    parts: readonly EntityPart[];
};

const DEG = Math.PI / 180;

// One parsed model per mesh text, shared by every entity that uses it.
const modelCache = new Map<string, PicoCadModel>();
const loader = new PicoCad2Loader();

function modelFor(text: string): PicoCadModel {
    let model = modelCache.get(text);
    if (!model) {
        model = loader.parse(text);
        modelCache.set(text, model);
    }
    return model;
}

/**
 * Build a blueprint into an Object3D group. `meshText` resolves a part's mesh
 * name to its model text — the generated registry passes its own imports, so
 * only meshes entities actually use are bundled.
 */
export function instantiateEntity(blueprint: EntityBlueprint, meshText: (mesh: string) => string | undefined): Object3D {
    const group = new Object3D();
    group.forward = blueprint.forward ?? 'z+';

    const parts = blueprint.parts;
    const objects = parts.map((part) => {
        const text = meshText(part.mesh);
        if (text === undefined) throw new Error(`Entity part mesh "${part.mesh}" has no model text`);
        const object = modelFor(text).instantiate({ color: part.color, uv: part.uv });
        if (part.pos) object.position.set(part.pos[0], part.pos[1], part.pos[2]);
        if (part.rot) object.rotation.set(part.rot[0] * DEG, part.rot[1] * DEG, part.rot[2] * DEG);
        if (part.scale) object.scale.set(part.scale[0], part.scale[1], part.scale[2]);
        return object;
    });

    // Linked after building them all, so a part may name a parent that comes
    // later in the array.
    parts.forEach((_, index) => {
        const parent = resolveParent(parts, index);
        (parent === null ? group : objects[parent]).add(objects[index]);
    });
    return group;
}

/**
 * The parent index to actually use for a part, or null for "sits on the root".
 * A missing, self-referencing, out-of-range or looping parent resolves to the
 * root rather than throwing — the registry is generated, and a stale index
 * should cost you the nesting, not the whole entity.
 */
export function resolveParent(parts: readonly EntityPart[], index: number): number | null {
    const usable = (value: number | undefined, self: number): value is number =>
        value !== undefined && Number.isInteger(value) && value >= 0 && value < parts.length && value !== self;

    const parent = parts[index]?.parent;
    if (!usable(parent, index)) return null;

    // Walk up the chain; coming back to a part already seen means a loop, and
    // dropping this link is what breaks it.
    const seen = new Set<number>([index]);
    let step: number | undefined = parent;
    while (usable(step, -1)) {
        if (seen.has(step)) return null;
        seen.add(step);
        step = parts[step].parent;
    }
    return parent;
}

// --- editing a parts list ---------------------------------------------------
// Parents are indices, so anything that shifts them has to carry every
// reference along. Getting this wrong silently re-parents unrelated parts, so
// it lives here where it can be tested rather than inside the editor page.
// Generic over "has a nullable parent index" — the editor's working parts.

export type ParentIndexed = { parent: number | null };

/** Insert at `at`, moving parent references the shift pushed along. */
export function insertWithParents<T extends ParentIndexed>(list: T[], at: number, item: T): void {
    const shift = (p: ParentIndexed): void => {
        if (p.parent !== null && p.parent >= at) p.parent += 1;
    };
    for (const p of list) shift(p);
    shift(item);
    list.splice(at, 0, item);
}

/** Remove at `index`. Its children are promoted to where it sat rather than
    orphaned, and references past it shift down. */
export function removeWithParents<T extends ParentIndexed>(list: T[], index: number): void {
    const promoted = list[index]?.parent ?? null;
    list.splice(index, 1);
    for (const p of list) {
        if (p.parent === null) continue;
        if (p.parent === index) p.parent = promoted !== null && promoted > index ? promoted - 1 : promoted;
        else if (p.parent > index) p.parent -= 1;
    }
}

/** Would parenting `child` to `parent` close a loop — i.e. is `parent` already
    somewhere below `child`? */
export function createsCycle(list: readonly ParentIndexed[], child: number, parent: number): boolean {
    const seen = new Set<number>();
    let step: number | null = parent;
    while (step !== null && !seen.has(step)) {
        if (step === child) return true;
        seen.add(step);
        step = list[step]?.parent ?? null;
    }
    return false;
}

// `forward` is the VISIBLE nose direction — what you see in picoCAD2 and the
// editors. (The model file's own X axis is mirrored on screen and never seen,
// so facings are specified in view space, not file space.) Horizontal noses
// need only a yaw offset; vertical noses (y±) are first laid horizontal by a
// 90° roll (rotation.z), which leaves them at a rest angle of π/2.
const REST_YAW: Record<Forward, number> = {
    'z+': 0,
    'z-': Math.PI,
    'x+': Math.PI / 2,
    'x-': -Math.PI / 2,
    'y+': Math.PI / 2,
    'y-': Math.PI / 2,
};

/**
 * Ground movement: yaw `object` so its nose points along (x, z) in world
 * space, honouring `object.forward`. No-op for a zero vector.
 */
export function faceToward(object: Object3D, x: number, z: number): void {
    if (x === 0 && z === 0) return;
    const forward = object.forward;
    const yaw = Math.atan2(x, z) - REST_YAW[forward];
    if (forward === 'y+') object.rotation.set(0, yaw, -Math.PI / 2);
    else if (forward === 'y-') object.rotation.set(0, yaw, Math.PI / 2);
    else object.rotation.set(0, yaw, 0);
}
