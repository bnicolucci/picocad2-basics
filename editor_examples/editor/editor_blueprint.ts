import { get_orbit_camera_pick_ray, install_orbit_camera_controls, OrbitCamera, OrbitCameraController } from '../core/camera';
import { findPrimitiveNodeByName, isPrimitiveShape, type PrimitiveShape } from '../core/primitives';
import { createPrimitiveUvAtlasTransform, remapPrimitiveNodeUvs } from '../core/uv_remap';
import { buildLocalMeshFromMeshAsset, buildMeshAssetFromPicoNode } from '../mesh';
import {
    buildTextureRGBA,
    computeGraphBounds,
    type MeshBounds,
    type PicoCad2Data,
    type PicoCad2Node,
    parsePicoCad2,
} from '../picocad2';
import { encodePicoCad2Compact, PICO_CAD2_COMPACT_PREFIX } from '../picocad2_compact';
import { makePicoModelMirrorMatrix } from '../scene';
import {
    isPicoCadPaletteId,
    picoCadPaletteOverride,
    picoCadPalettes,
    type PicoCadPaletteId,
} from '../palettes/picocad_palettes';
import { isTextureAssetId, textureAssetOverride, textureAssets } from '../textures/texture_assets';
import {
    type ColliderOverlayBody,
    EditorRenderer,
    type PlacedInstance,
    type TransformAxis,
    type TransformMode,
} from './editor_game_renderer';
import {
    type AABB,
    angleDeltaDeg,
    boundsToFootprint,
    buildModelMatrix,
    computeWorldAABB,
    findNodeByMeshId,
    formatInspectorNumber,
    formatNumber,
    isEditableTarget,
    meshIdToPath,
    multiplyMat4,
    outlinerNodeName,
    parseInspectorNumber,
    rayHitsAABB,
    rotateRingGeometry,
    screenDistanceToSegment,
    snapDegrees,
} from './editor_math';

// ---------------------------------------------------------------------------
// Asset discovery
// ---------------------------------------------------------------------------

const MODEL_FILES = import.meta.glob(
    ['../assets/models/*.txt', '../assets/primitives/*.txt', '!../assets/models/*-anim-*.txt', '!../assets/primitives/*-anim-*.txt'],
    { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;

const MULTI_FILES = import.meta.glob('../assets/models/multi/*.txt', {
    query: '?raw',
    import: 'default',
}) as Record<string, () => Promise<string>>;


function nameFromPath(path: string): string {
    return (
        path
            .split('/')
            .pop()
            ?.replace(/\.txt$/, '') ?? path
    );
}

type TransformState = {
    mode: TransformMode;
    axis: TransformAxis;
    source: 'hotkey' | 'gizmo';
    modelId: string;
    colliderBodyId?: string;
    partMeshId?: string;
    startPosition: [number, number, number];
    startRotation: [number, number, number];
    startScale: [number, number, number];
    startGround: [number, number, number] | null;
    startAngle: number;
    startDistance: number;
    startClientX: number;
    startClientY: number;
};

function invertMat4(m: Float32Array): Float32Array | null {
    const a00 = m[0],
        a01 = m[1],
        a02 = m[2],
        a03 = m[3];
    const a10 = m[4],
        a11 = m[5],
        a12 = m[6],
        a13 = m[7];
    const a20 = m[8],
        a21 = m[9],
        a22 = m[10],
        a23 = m[11];
    const a30 = m[12],
        a31 = m[13],
        a32 = m[14],
        a33 = m[15];
    const b00 = a00 * a11 - a01 * a10,
        b01 = a00 * a12 - a02 * a10,
        b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11,
        b04 = a01 * a13 - a03 * a11,
        b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30,
        b07 = a20 * a32 - a22 * a30,
        b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31,
        b10 = a21 * a33 - a23 * a31,
        b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (Math.abs(det) < 1e-10) return null;
    det = 1 / det;
    const out = new Float32Array(16);
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
}

function buildPicoNodeMatrix(node: PicoCad2Node): Float32Array {
    const t = node.transform;
    const px = t?.pos?.x ?? 0,
        py = t?.pos?.y ?? 0,
        pz = t?.pos?.z ?? 0;
    const rx = t?.rot?.x ?? 0,
        ry = t?.rot?.y ?? 0,
        rz = t?.rot?.z ?? 0;
    const sx = t?.scale?.x ?? 1,
        sy = t?.scale?.y ?? 1,
        sz = t?.scale?.z ?? 1;
    const cx = Math.cos(rx),
        sxn = Math.sin(rx);
    const cy = Math.cos(ry),
        syn = Math.sin(ry);
    const cz = Math.cos(rz),
        szn = Math.sin(rz);
    return new Float32Array([
        cz * cy * sx,
        szn * cy * sx,
        -syn * sx,
        0,
        (cz * syn * sxn - szn * cx) * sy,
        (szn * syn * sxn + cz * cx) * sy,
        cy * sxn * sy,
        0,
        (cz * syn * cx + szn * sxn) * sz,
        (szn * syn * cx - cz * sxn) * sz,
        cy * cx * sz,
        0,
        px,
        py,
        pz,
        1,
    ]);
}

// ---------------------------------------------------------------------------
// Mesh helpers
// ---------------------------------------------------------------------------

type ModelMeshPart = {
    meshId: string;
    nodeMatrix: Float32Array;
};

function collectMeshParts(
    node: PicoCad2Node,
    modelId: string,
    path: number[],
    parentMatrix: Float32Array,
    out: ModelMeshPart[],
): void {
    const nodeMatrix = multiplyMat4(parentMatrix, buildPicoNodeMatrix(node));

    if (node.mesh?.vertices?.length && node.mesh.faces?.length) {
        const meshId = path.length === 0 ? `mesh:${modelId}:root` : `mesh:${modelId}:${path.join('/')}`;
        out.push({ meshId, nodeMatrix });
    }

    for (const [i, child] of (node.children ?? []).entries()) {
        collectMeshParts(child, modelId, [...path, i], nodeMatrix, out);
    }
}

// ---------------------------------------------------------------------------
// Loaded model cache
// ---------------------------------------------------------------------------

type LoadedModel = {
    parts: ModelMeshPart[];
    materialId: string;
    data: PicoCad2Data;
    rawText: string;
    textureImageData?: ImageData;
    graphRoot?: PicoCad2Node;
};

// ---------------------------------------------------------------------------
// Scene model
// ---------------------------------------------------------------------------

type UvSpec = {
    u: number;
    v: number;
    tileSize: number;
    repeatU?: number;
    repeatV?: number;
};

type ColliderShape = 'box' | 'sphere';

type PartTransformOverride = {
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
};

type ColliderBodyEntry = {
    id: string;
    colliderShape: ColliderShape;
    length: number;
    width: number;
    height: number;
    radius: number;
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
};

const DEFAULT_COLLIDER_BODY: Omit<ColliderBodyEntry, 'id'> = {
    colliderShape: 'box',
    length: 1,
    width: 1,
    height: 1,
    radius: 0.5,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
};

type SceneModel = {
    id: string;
    fileName: string;
    isMulti: boolean;
    childIndex?: number;
    position: [number, number, number];
    rotation: [number, number, number]; // euler degrees XYZ (Ry*Rx*Rz order)
    scale: [number, number, number];
    loadedModel: LoadedModel;
    partPrefix?: string;
    meshBounds: MeshBounds | null;
    uvSpec?: UvSpec;
    uvMeshParts?: ModelMeshPart[];
    paletteOverride?: PicoCadPaletteId;
    textureOverride?: string;
    overrideMaterialId?: string;
    partOverrides?: Record<string, PartTransformOverride>;
};

type BlueprintSnapshot = {
    models: Array<{
        id: string;
        fileName: string;
        isMulti: boolean;
        childIndex?: number;
        position: [number, number, number];
        rotation: [number, number, number];
        scale: [number, number, number];
        partPrefix?: string;
        uvSpec?: UvSpec;
        paletteOverride?: PicoCadPaletteId;
        textureOverride?: string;
        partOverrides?: Record<string, PartTransformOverride>;
    }>;
    colliderBodies: ColliderBodyEntry[];
    ecsComponents: EcsComponentDef[];
};

type BlueprintPrimitivePlacement = {
    name: string;
    shape: PrimitiveShape;
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
    u: number;
    v: number;
    tileSize: number;
    repeatU?: number;
    repeatV?: number;
    paletteOverride?: PicoCadPaletteId;
};

function applyAncestorOverrides(
    partMeshId: string,
    nodeMatrix: Float32Array,
    partOverrides: Record<string, PartTransformOverride>,
    allParts: ModelMeshPart[],
): Float32Array {
    const prefixEnd = partMeshId.indexOf(':', partMeshId.indexOf(':') + 1) + 1;
    const meshPrefix = partMeshId.slice(0, prefixEnd);
    const pathSuffix = partMeshId.slice(prefixEnd);
    if (pathSuffix === 'root') return nodeMatrix;
    const segments = pathSuffix.split('/');

    let matrix = nodeMatrix;

    // Apply root override if present
    const rootMeshId = `${meshPrefix}root`;
    const rootOverride = partOverrides[rootMeshId];
    if (rootOverride) {
        const rootPart = allParts.find((p) => p.meshId === rootMeshId);
        if (rootPart) {
            const inv = invertMat4(rootPart.nodeMatrix);
            if (inv) {
                const [ax, ay, az] = [rootPart.nodeMatrix[12], rootPart.nodeMatrix[13], rootPart.nodeMatrix[14]];
                const eff = buildModelMatrix(
                    [ax + rootOverride.position[0], ay + rootOverride.position[1], az + rootOverride.position[2]],
                    rootOverride.rotation,
                    rootOverride.scale,
                );
                matrix = multiplyMat4(eff, multiplyMat4(inv, matrix));
            }
        } else {
            // Root has no mesh — treat original as identity
            const eff = buildModelMatrix(rootOverride.position, rootOverride.rotation, rootOverride.scale);
            matrix = multiplyMat4(eff, matrix);
        }
    }

    // Apply each ancestor's override by reparenting: newChild = ancestorEff × ancestorOrigInv × child
    for (let len = 1; len < segments.length; len++) {
        const ancestorMeshId = meshPrefix + segments.slice(0, len).join('/');
        const override = partOverrides[ancestorMeshId];
        if (!override) continue;
        const ancestorPart = allParts.find((p) => p.meshId === ancestorMeshId);
        if (!ancestorPart) continue;
        const inv = invertMat4(ancestorPart.nodeMatrix);
        if (!inv) continue;
        const [ax, ay, az] = [ancestorPart.nodeMatrix[12], ancestorPart.nodeMatrix[13], ancestorPart.nodeMatrix[14]];
        const eff = buildModelMatrix(
            [ax + override.position[0], ay + override.position[1], az + override.position[2]],
            override.rotation,
            override.scale,
        );
        matrix = multiplyMat4(eff, multiplyMat4(inv, matrix));
    }

    return matrix;
}

function sceneModelToInstances(sm: SceneModel, isSelected: boolean, selectedInstanceId: string | null): PlacedInstance[] {
    const parts =
        sm.uvMeshParts ??
        (sm.partPrefix
            ? sm.loadedModel.parts.filter((p) => p.meshId === sm.partPrefix || p.meshId.startsWith(`${sm.partPrefix}/`))
            : sm.loadedModel.parts);

    const base = buildModelMatrix(sm.position, sm.rotation, sm.scale);
    const uv = sm.uvSpec;
    const materialId = sm.overrideMaterialId ?? sm.loadedModel.materialId;
    const uvAtlasTransform =
        sm.uvMeshParts && uv && ((uv.repeatU ?? 1) !== 1 || (uv.repeatV ?? 1) !== 1)
            ? createPrimitiveUvAtlasTransform(uv as Parameters<typeof createPrimitiveUvAtlasTransform>[0])
            : undefined;

    return parts.map((part, pi) => ({
        id: `${sm.id}:${pi}`,
        meshId: part.meshId,
        materialId,
        worldMatrix: (() => {
            const override = sm.partOverrides?.[part.meshId];
            const effectiveMatrix = sm.partOverrides
                ? applyAncestorOverrides(part.meshId, part.nodeMatrix, sm.partOverrides, sm.loadedModel.parts)
                : part.nodeMatrix;
            if (!override) return multiplyMat4(base, effectiveMatrix);
            return multiplyMat4(
                base,
                buildModelMatrix(
                    [
                        effectiveMatrix[12] + override.position[0],
                        effectiveMatrix[13] + override.position[1],
                        effectiveMatrix[14] + override.position[2],
                    ],
                    override.rotation,
                    override.scale,
                ),
            );
        })(),
        selected: selectedInstanceId ? `${sm.id}:${pi}` === selectedInstanceId : isSelected,
        uvAtlasTransform,
    }));
}

function sceneModelToStableYawFootprint(sm: SceneModel): [number, number, number, number] {
    if (!sm.meshBounds) return [-0.5, 0.5, -0.5, 0.5];
    const box = computeWorldAABB(sm.meshBounds, buildModelMatrix([0, 0, 0], [sm.rotation[0], 0, sm.rotation[2]], sm.scale));
    return [box.minX, box.maxX, box.minZ, box.maxZ];
}

function clonePartOverrides(
    overrides: Record<string, PartTransformOverride> | undefined,
): Record<string, PartTransformOverride> | undefined {
    if (!overrides) return undefined;
    return Object.fromEntries(
        Object.entries(overrides).map(([meshId, override]) => [
            meshId,
            {
                position: [...override.position] as [number, number, number],
                rotation: [...override.rotation] as [number, number, number],
                scale: [...override.scale] as [number, number, number],
            },
        ]),
    );
}

function toBlueprintName(input: string | null): string {
    const raw = (input ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    const base = raw.length > 0 ? raw : 'custom';
    return base.startsWith('blu_') ? base : `blu_${base}`;
}

function formatVec3Object([x, y, z]: [number, number, number], indent: string): string {
    return `{\n${indent}    x: ${formatNumber(x)},\n${indent}    y: ${formatNumber(y)},\n${indent}    z: ${formatNumber(z)},\n${indent}}`;
}

function formatPrimitiveSpec(
    p: { shape: PrimitiveShape; u: number; v: number; tileSize: number; repeatU?: number; repeatV?: number },
    indent: string,
): string {
    const inner = `${indent}    `;
    const repeatU = p.repeatU !== undefined ? `\n${inner}repeatU: ${p.repeatU},` : '';
    const repeatV = p.repeatV !== undefined ? `\n${inner}repeatV: ${p.repeatV},` : '';
    return `{\n${inner}shape: '${p.shape}',\n${inner}u: ${p.u},\n${inner}v: ${p.v},\n${inner}tileSize: ${p.tileSize},${repeatU}${repeatV}\n${indent}}`;
}

function formatTransform(
    position: [number, number, number],
    rotation: [number, number, number],
    scale: [number, number, number],
    indent: string,
): string {
    const gamePos: [number, number, number] = [position[0], position[1], position[2]];
    const rotationRadians = rotation.map((deg) => (deg * Math.PI) / 180) as [number, number, number];
    return (
        `{\n${indent}    pos: ${formatVec3Object(gamePos, `${indent}    `)},\n` +
        `${indent}    rot: ${formatVec3Object(rotationRadians, `${indent}    `)},\n` +
        `${indent}    scale: ${formatVec3Object(scale, `${indent}    `)},\n${indent}}`
    );
}

function formatChildPlacement(child: BlueprintPrimitivePlacement, rootPosition: [number, number, number]): string {
    const relativePosition: [number, number, number] = [
        child.position[0] - rootPosition[0],
        child.position[1] - rootPosition[1],
        child.position[2] - rootPosition[2],
    ];
    return (
        `        {\n` +
        `            name: '${child.name}',\n` +
        `            primitive: ${formatPrimitiveSpec(child, '            ')},\n` +
        `            transform: ${formatTransform(relativePosition, child.rotation, child.scale, '            ')},\n` +
        `        }`
    );
}

function formatCollider(body: ColliderBodyEntry | undefined, indent: string): string {
    if (!body) return '';
    const inner = `${indent}    `;
    const [sx, sy, sz] = [Math.abs(body.scale[0]), Math.abs(body.scale[1]), Math.abs(body.scale[2])];
    const [ox, oy, oz] = body.position;
    let result = `${indent}collider: {\n${inner}shape: '${body.colliderShape}',\n`;
    if (body.colliderShape === 'box') {
        result += `${inner}length: ${formatNumber(body.length * sx)},\n`;
        result += `${inner}width: ${formatNumber(body.width * sz)},\n`;
        result += `${inner}height: ${formatNumber(body.height * sy)},\n`;
    } else {
        result += `${inner}radius: ${formatNumber(body.radius * Math.max(sx, sy, sz))},\n`;
    }
    if (ox !== 0 || oy !== 0 || oz !== 0) {
        result += `${inner}offset: [${formatNumber(ox)}, ${formatNumber(oy)}, ${formatNumber(oz)}],\n`;
    }
    result += `${indent}},\n`;
    return result;
}

// A fixed half-turn quaternion around the chosen axis — matches the
// "direction indicator" convention used throughout the ECS movement system
// (see sys_ecs_control_player.ts): the actual turn rate comes from the
// entity's own Move.rotationSpeed easing toward this every frame, not from
// the magnitude of the quaternion itself.
function formatAxisQuat(axis: 'x' | 'y' | 'z' | null, direction: 1 | -1): string {
    if (!axis) return 'null';
    const vec = axis === 'x' ? [direction, 0, 0] : axis === 'y' ? [0, direction, 0] : [0, 0, direction];
    return `[${vec[0]}, ${vec[1]}, ${vec[2]}, 0]`;
}

function formatControlMoveArgs(comp: Extract<EcsComponentDef, { type: 'control_move' }>): string {
    const [dx, dy, dz] = comp.direction;
    const directionLiteral = dx !== 0 || dy !== 0 || dz !== 0 ? `[${dx}, ${dy}, ${dz}]` : 'null';
    return `${directionLiteral}, ${formatAxisQuat(comp.rotAxis, comp.rotDirection)}`;
}

function buildEcsSetupSource(components: EcsComponentDef[]): { ecsImports: string[]; ecsMethod: string } {
    const ecsImports: string[] = ["import { instantiate } from '../ecs/world';"];
    const hasControlMove = components.some((c) => c.type === 'control_move');
    const bodyLines: string[] = [];

    if (hasControlMove) {
        bodyLines.push('            const rootNode = game.nodeById.get(`model:$' + '{entityId}`);');
        bodyLines.push('            if (!rootNode) return;');
    }

    const instantiateArgs: string[] = ['                game.ecsWorld!,'];
    for (const comp of components) {
        if (comp.type === 'control_player') {
            ecsImports.push("import { control_player } from '../ecs/components/com_control_player';");
            instantiateArgs.push(`                control_player(${comp.move}, ${comp.yaw}, ${comp.pitch}),`);
        } else if (comp.type === 'control_move') {
            ecsImports.push("import { control_move } from '../ecs/components/com_control_move';");
            ecsImports.push("import { move } from '../ecs/components/com_move';");
            ecsImports.push("import { transform } from '../ecs/components/com_transform';");
            ecsImports.push("import { collectDescendantNodeIdsByName } from '../core/utils/scene_helpers';");
            const nodeNamesLiteral = JSON.stringify(comp.nodeNames);
            const argsLiteral = formatControlMoveArgs(comp);
            bodyLines.push(
                `            for (const nodeId of collectDescendantNodeIdsByName(rootNode, new Set(${nodeNamesLiteral}))) {`,
                `                const node = game.nodeById.get(nodeId);`,
                `                if (!node) continue;`,
                `                instantiate(`,
                `                    game.ecsWorld!,`,
                `                    transform(`,
                `                        node.transform.pos.x,`,
                `                        node.transform.pos.y,`,
                `                        node.transform.pos.z,`,
                `                        node.id,`,
                `                        node.transform.rot,`,
                `                    ),`,
                `                    move(1, 5),`,
                `                    control_move(${argsLiteral}),`,
                `                );`,
                `            }`,
            );
        }
    }

    const nonControlMoveComps = components.filter((c) => c.type !== 'control_move');
    if (nonControlMoveComps.length > 0) {
        bodyLines.push('            instantiate(', ...instantiateArgs, '            );');
    }

    const ecsMethod = `        ecsSetup(entityId: string, game: Game) {\n${bodyLines.join('\n')}\n        },\n`;

    return { ecsImports: [...new Set(ecsImports)], ecsMethod };
}

function buildBlueprintSource(
    blueprintId: string,
    placements: BlueprintPrimitivePlacement[],
    colliderBody?: ColliderBodyEntry,
    ecsComps: EcsComponentDef[] = [],
): string {
    const [root, ...children] = placements;
    if (!root) throw new Error('Cannot build a blueprint with no primitive placements');

    const childSource =
        children.length > 0
            ? `,\n        children: [\n${children.map((child) => formatChildPlacement(child, root.position)).join(',\n')},\n        ]`
            : '';

    const colliderSource = formatCollider(colliderBody, '        ');
    const paletteOverride = root.paletteOverride ? `,\n        paletteOverride: '${root.paletteOverride}',\n` : ',\n';

    const loadArgs =
        `        blueprintId: '${blueprintId}',\n` +
        `        name: '${root.name}',\n` +
        `        primitive: ${formatPrimitiveSpec(root, '        ')},\n` +
        `        transform: ${formatTransform(root.position, root.rotation, root.scale, '        ')}` +
        `${childSource}` +
        paletteOverride +
        colliderSource;

    if (ecsComps.length === 0) {
        return (
            `import { load_primitive_blueprint } from './load_primitive_blueprint';\n` +
            `\n` +
            `export async function ${blueprintId}() {\n` +
            `    return load_primitive_blueprint({\n` +
            loadArgs +
            `    });\n` +
            `}\n`
        );
    }

    const { ecsImports, ecsMethod } = buildEcsSetupSource(ecsComps);
    return (
        `import type { Game, LoadedBlueprint } from '../core/game';\n` +
        ecsImports.join('\n') +
        '\n' +
        `import { load_primitive_blueprint } from './load_primitive_blueprint';\n` +
        `\n` +
        `export async function ${blueprintId}(): Promise<LoadedBlueprint> {\n` +
        `    const base = await load_primitive_blueprint({\n` +
        loadArgs +
        `    });\n` +
        `    return {\n` +
        `        ...base,\n` +
        ecsMethod +
        `    };\n` +
        `}\n`
    );
}

function buildModelBlueprintSource(
    blueprintId: string,
    sm: SceneModel,
    colliderBody?: ColliderBodyEntry,
    ecsComps: EcsComponentDef[] = [],
): string {
    const rawText = sm.loadedModel.rawText.trimStart().startsWith(PICO_CAD2_COMPACT_PREFIX)
        ? sm.loadedModel.rawText
        : encodePicoCad2Compact(JSON.parse(sm.loadedModel.rawText) as PicoCad2Data);
    const pathFromMeshId = (meshId: string): number[] => {
        const suffix = meshId.slice(`mesh:${sm.fileName}:`.length);
        if (suffix === 'root') return [];
        return suffix.split('/').map(Number).filter(Number.isFinite);
    };
    const nodeNameFromPath = (path: number[]): string => {
        let node = sm.loadedModel.graphRoot;
        for (const index of path) node = node?.children?.[index];
        return node?.name?.trim() || (path.length === 0 ? 'root' : `node ${JSON.stringify(path)}`);
    };
    const commentSafeNodeName = (name: string): string => name.replace(/\*\//g, '* /');
    const overrideEntries = Object.entries(sm.partOverrides ?? {})
        .map(([meshId, override]) => ({
            path: pathFromMeshId(meshId),
            name: nodeNameFromPath(pathFromMeshId(meshId)),
            position: override.position,
            rotation: override.rotation.map((deg) => (deg * Math.PI) / 180),
            scale: override.scale,
        }))
        .filter(
            (entry) => entry.path.length > 0 || Object.keys(sm.partOverrides ?? {}).some((meshId) => meshId.endsWith(':root')),
        );
    const overrideSource =
        overrideEntries.length > 0
            ? `\n` +
              `    const nodeAtPath = (path: number[]) => {\n` +
              `        let node: typeof data.graph | undefined = data.graph;\n` +
              `        for (const index of path) node = node?.children?.[index];\n` +
              `        return node;\n` +
              `    };\n\n` +
              overrideEntries
                  .map(
                      (entry) =>
                          `    {\n` +
                          `        // ${commentSafeNodeName(entry.name)} ${JSON.stringify(entry.path)}\n` +
                          `        const node = nodeAtPath(${JSON.stringify(entry.path)});\n` +
                          `        if (node) {\n` +
                          `            const t = node.transform ?? {};\n` +
                          `            node.transform = {\n` +
                          `                ...t,\n` +
                          `                pos: {\n` +
                          `                    x: (t.pos?.x ?? 0) + ${formatNumber(entry.position[0])},\n` +
                          `                    y: (t.pos?.y ?? 0) + ${formatNumber(entry.position[1])},\n` +
                          `                    z: (t.pos?.z ?? 0) + ${formatNumber(entry.position[2])},\n` +
                          `                },\n` +
                          `                rot: {\n` +
                          `                    x: (t.rot?.x ?? 0) + ${formatNumber(entry.rotation[0])},\n` +
                          `                    y: (t.rot?.y ?? 0) + ${formatNumber(entry.rotation[1])},\n` +
                          `                    z: (t.rot?.z ?? 0) + ${formatNumber(entry.rotation[2])},\n` +
                          `                },\n` +
                          `                scale: {\n` +
                          `                    x: (t.scale?.x ?? 1) * ${formatNumber(entry.scale[0])},\n` +
                          `                    y: (t.scale?.y ?? 1) * ${formatNumber(entry.scale[1])},\n` +
                          `                    z: (t.scale?.z ?? 1) * ${formatNumber(entry.scale[2])},\n` +
                          `                },\n` +
                          `            };\n` +
                          `        }\n` +
                          `    }\n`,
                  )
                  .join('\n')
            : '';
    const gameTypeImport =
        ecsComps.length > 0
            ? `import type { Game, LoadedBlueprint } from '../core/game';\n`
            : `import type { LoadedBlueprint } from '../core/game';\n`;
    const { ecsImports, ecsMethod } = ecsComps.length > 0 ? buildEcsSetupSource(ecsComps) : { ecsImports: [], ecsMethod: '' };
    const ecsImportBlock = ecsImports.length > 0 ? `${ecsImports.join('\n')}\n` : '';
    const paletteImport = sm.paletteOverride ? `import { picoCadPaletteOverride } from '../palettes/picocad_palettes';\n` : '';
    const textureImport = sm.textureOverride
        ? `import { textureAssetOverride } from '../textures/texture_assets';\n`
        : '';
    const paletteArg = sm.paletteOverride ? `picoCadPaletteOverride('${sm.paletteOverride}')` : 'undefined';
    const textureExpr = sm.textureOverride
        ? `buildTextureRGBA(data, ${paletteArg}, textureAssetOverride('${sm.textureOverride}'))`
        : sm.paletteOverride
          ? `buildTextureRGBA(data, ${paletteArg})`
          : 'buildTextureRGBA(data)';

    return (
        gameTypeImport +
        `import { buildTextureRGBA, parsePicoCad2 } from '../picocad2';\n` +
        `import { makeMaterialId } from '../scene';\n` +
        paletteImport +
        textureImport +
        ecsImportBlock +
        `\n` +
        `/**\n * Blueprint exported from the blueprint editor.\n */\n` +
        `export async function ${blueprintId}(): Promise<LoadedBlueprint> {\n` +
        `    const rawText = ${JSON.stringify(rawText)};\n` +
        `    const data = parsePicoCad2(rawText);\n\n` +
        `    if (!data.graph) {\n` +
        `        throw new Error('${sm.fileName}.txt is missing a graph root');\n` +
        `    }\n\n` +
        `    data.graph.transform = ${formatTransform(sm.position, sm.rotation, sm.scale, '    ')};\n` +
        overrideSource +
        `\n` +
        `    return {\n` +
        `        blueprintId: '${blueprintId}',\n` +
        `        data,\n` +
        `        node: data.graph,\n` +
        `        buildMaterial: (instanceId) => ({\n` +
        `            materialId: makeMaterialId(instanceId),\n` +
        `            texture: ${textureExpr},\n` +
        `        }),\n` +
        formatCollider(colliderBody, '        ') +
        ecsMethod +
        `    };\n` +
        `}\n`
    );
}

async function saveTextFile(fileName: string, text: string): Promise<void> {
    const res = await fetch('/__editor/save-blueprint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, source: text }),
    });

    if (res.ok) {
        window.alert(`Saved src/blueprints/${fileName}`);
        return;
    }

    const message = await res.text();
    throw new Error(
        res.status === 404
            ? 'Blueprint save endpoint was not found. Restart bun run dev so Vite loads vite.config.ts.'
            : `Blueprint save failed: ${message}`,
    );
}

// ---------------------------------------------------------------------------
// Save / load format
// ---------------------------------------------------------------------------

type SaveObject = {
    file: string;
    isMulti: boolean;
    childIndex?: number;
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
    uvSpec?: UvSpec;
    paletteOverride?: PicoCadPaletteId;
    textureOverride?: string;
    partOverrides?: Record<string, PartTransformOverride>;
};

type EcsComponentDef =
    | { type: 'control_player'; move: boolean; yaw: boolean; pitch: boolean }
    | {
          type: 'control_move';
          nodeNames: string[];
          direction: [number, number, number];
          rotAxis: 'x' | 'y' | 'z' | null;
          rotDirection: 1 | -1;
      };

type SaveData = {
    version: 1;
    objects: SaveObject[];
    colliderBodies?: ColliderBodyEntry[];
    ecsComponents?: EcsComponentDef[];
};

function cloneEcsComponent(comp: EcsComponentDef): EcsComponentDef {
    if (comp.type === 'control_move') {
        return { ...comp, nodeNames: [...comp.nodeNames], direction: [...comp.direction] };
    }
    return { ...comp };
}

function buildColliderOverlayShapes(bodies: ColliderBodyEntry[]): ColliderOverlayBody[] {
    const shapes: ColliderOverlayBody[] = [];
    for (const pb of bodies) {
        const [sx, sy, sz] = [Math.abs(pb.scale[0]), Math.abs(pb.scale[1]), Math.abs(pb.scale[2])];
        if (pb.colliderShape === 'box') {
            const matrix = buildModelMatrix(pb.position, pb.rotation, pb.scale);
            shapes.push({
                shape: 'box',
                matrix,
                halfX: pb.length / 2,
                halfY: pb.height / 2,
                halfZ: pb.width / 2,
                radius: 0,
            });
        } else if (pb.colliderShape === 'sphere') {
            const matrix = buildModelMatrix(pb.position, pb.rotation, [1, 1, 1]);
            shapes.push({
                shape: 'sphere',
                matrix,
                halfX: 0,
                halfY: 0,
                halfZ: 0,
                radius: pb.radius * Math.max(sx, sy, sz),
            });
        }
    }
    return shapes;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const canvas = document.getElementById('viewport') as HTMLCanvasElement;
    const modelListEl = document.getElementById('model-list') as HTMLElement;
    const viewportWrap = document.getElementById('viewport-wrap') as HTMLElement;
    const dropOverlay = document.getElementById('drop-overlay') as HTMLElement;

    // ---- Renderer ----------------------------------------------------------

    const renderer = EditorRenderer.create(canvas);

    const ro = new ResizeObserver(() => renderer.resize());
    ro.observe(viewportWrap);
    renderer.resize();

    // ---- Orbit camera ------------------------------------------------------

    const orbit = new OrbitCamera([0, 0, 0], 12);
    orbit.yaw = Math.PI - 0.6;
    orbit.pitch = 0.45;
    orbit.distance = 22;
    orbit.minDistance = 1;
    orbit.maxDistance = 300;

    const orbitCtrl = new OrbitCameraController(orbit, {
        rotateSpeed: 0.008,
        wheelZoomSpeed: 0.001,
        panSpeed: 1.0,
    });

    install_orbit_camera_controls(canvas, orbitCtrl);

    // ---- Editor state ------------------------------------------------------

    const sceneModels: SceneModel[] = [];
    let sceneModelCounter = 0;
    const loadedModels = new Map<string, LoadedModel>();
    const boundsCache = new Map<string, MeshBounds | null>();
    const multiChildNames = new Map<string, string>();
    let dragFootprint: [number, number, number, number] = [-0.5, 0.5, -0.5, 0.5];
    let selectedModelId: string | null = null;
    let selectedInstanceId: string | null = null;
    let isDraggingFromSidebar = false;
    let mouseDownX = 0,
        mouseDownY = 0;
    let lastMouseEvent: { clientX: number; clientY: number } | null = null;
    let transformState: TransformState | null = null;
    let stickyGizmoMode: TransformMode = 'translate';
    let suppressNextClick = false;
    let blueprintSaveSelect: HTMLSelectElement | null = null;
    const outlinerListEl = document.getElementById('outliner-list') as HTMLElement | null;
    const selectedNameEl = document.getElementById('selected-name') as HTMLElement | null;
    const expandedOutlinerNodeIds = new Set<string>();
    const colliderBodies: ColliderBodyEntry[] = [];
    let selectedColliderBodyId: string | null = null;
    let colliderBodyCounter = 0;
    const ecsComponents: EcsComponentDef[] = [];
    const undoStack: BlueprintSnapshot[] = [];
    const redoStack: BlueprintSnapshot[] = [];
    const MAX_HISTORY = 50;
    let inspectorPushKey: string | null = null;
    let uvPushModelId: string | null = null;
    let colliderPushBodyId: string | null = null;
    let ecsFieldPushed = false;
    let skipNextTransformHistoryPush = false;
    const colliderOutlinerListEl = document.getElementById('collider-outliner-list') as HTMLElement | null;
    const colliderAddShapeEl = document.getElementById('collider-add-shape') as HTMLSelectElement | null;
    const colliderAddBtnEl = document.getElementById('collider-add-btn') as HTMLButtonElement | null;
    const colliderBodyPropsEl = document.getElementById('collider-body-props') as HTMLElement | null;
    const ecsComponentsListEl = document.getElementById('ecs-components-list') as HTMLElement | null;
    const ecsAddTypeEl = document.getElementById('ecs-add-type') as HTMLSelectElement | null;
    const ecsAddBtnEl = document.getElementById('ecs-add-btn') as HTMLButtonElement | null;
    const transformInputs = {
        posX: document.getElementById('transform-pos-x') as HTMLInputElement | null,
        posY: document.getElementById('transform-pos-y') as HTMLInputElement | null,
        posZ: document.getElementById('transform-pos-z') as HTMLInputElement | null,
        rotX: document.getElementById('transform-rot-x') as HTMLInputElement | null,
        rotY: document.getElementById('transform-rot-y') as HTMLInputElement | null,
        rotZ: document.getElementById('transform-rot-z') as HTMLInputElement | null,
        scaleX: document.getElementById('transform-scale-x') as HTMLInputElement | null,
        scaleY: document.getElementById('transform-scale-y') as HTMLInputElement | null,
        scaleZ: document.getElementById('transform-scale-z') as HTMLInputElement | null,
    };
    const transformInputList = Object.values(transformInputs).filter((input): input is HTMLInputElement => input !== null);
    const uvInputs = {
        u: document.getElementById('uv-u') as HTMLInputElement | null,
        v: document.getElementById('uv-v') as HTMLInputElement | null,
        tileSize: document.getElementById('uv-tilesize') as HTMLInputElement | null,
        repeatU: document.getElementById('uv-repeatu') as HTMLInputElement | null,
        repeatV: document.getElementById('uv-repeatv') as HTMLInputElement | null,
    };
    const uvInputList = Object.values(uvInputs).filter((input): input is HTMLInputElement => input !== null);
    const uvHeaderEl = document.getElementById('uv-header') as HTMLElement | null;
    const uvSectionEl = document.getElementById('uv-section') as HTMLElement | null;
    const uvCanvasEl = document.getElementById('uv-canvas') as HTMLCanvasElement | null;
    const uvPaletteSelect = document.getElementById('uv-palette') as HTMLSelectElement | null;
    if (uvPaletteSelect) {
        uvPaletteSelect.replaceChildren();
        uvPaletteSelect.append(new Option('Model Palette', ''));
        for (const palette of Object.values(picoCadPalettes)) {
            uvPaletteSelect.append(new Option(palette.name, palette.id));
        }
    }
    const uvTextureSelect = document.getElementById('uv-texture') as HTMLSelectElement | null;
    if (uvTextureSelect) {
        uvTextureSelect.replaceChildren();
        uvTextureSelect.append(new Option('Model Texture', ''));
        for (const asset of textureAssets) {
            uvTextureSelect.append(new Option(asset.name, asset.id));
        }
    }
    const colliderInputs = {
        colliderShape: document.getElementById('collider-shape') as HTMLSelectElement | null,
        length: document.getElementById('collider-length') as HTMLInputElement | null,
        width: document.getElementById('collider-width') as HTMLInputElement | null,
        boxHeight: document.getElementById('collider-box-height') as HTMLInputElement | null,
        sphereRadius: document.getElementById('collider-sphere-radius') as HTMLInputElement | null,
    };
    const colliderSelectList: HTMLSelectElement[] = [colliderInputs.colliderShape].filter(
        (el): el is HTMLSelectElement => el !== null,
    );
    const colliderValueInputList: HTMLInputElement[] = [
        colliderInputs.length,
        colliderInputs.width,
        colliderInputs.boxHeight,
        colliderInputs.sphereRadius,
    ].filter((el): el is HTMLInputElement => el !== null);
    const colliderAllInputList: HTMLElement[] = [...colliderSelectList, ...colliderValueInputList];
    const transformHeaderEl = document.getElementById('transform-header') as HTMLElement | null;
    const transformSectionEl = document.getElementById('transform-section') as HTMLElement | null;
    const visualCollapseBtn = document.getElementById('visual-section-collapse-btn') as HTMLButtonElement | null;
    const transformCollapseBtn = document.getElementById('transform-collapse-btn') as HTMLButtonElement | null;
    const uvCollapseBtn = document.getElementById('uv-collapse-btn') as HTMLButtonElement | null;
    let visualGroupCollapsed = false;
    let transformSectionCollapsed = false;
    let uvSectionCollapsed = false;
    const colliderDimsBoxEl = document.getElementById('collider-dims-box') as HTMLElement | null;
    const colliderDimsSphereEl = document.getElementById('collider-dims-sphere') as HTMLElement | null;
    let syncingInspector = false;
    for (const input of transformInputList) {
        input.addEventListener('input', applyInspectorTransform);
        input.addEventListener('change', applyInspectorTransform);
    }
    for (const input of uvInputList) {
        input.addEventListener('input', applyUvFromInputs);
        input.addEventListener('change', applyUvFromInputs);
    }
    uvPaletteSelect?.addEventListener('change', () => {
        if (syncingInspector) return;
        const sm = selectedModel();
        if (!sm) return;
        if (sm.id !== uvPushModelId) {
            pushHistory();
            uvPushModelId = sm.id;
        }
        const next = uvPaletteSelect.value;
        sm.paletteOverride = isPicoCadPaletteId(next) ? next : undefined;
        sm.overrideMaterialId = undefined;
        drawUvCanvas(primitiveShapeFromSceneModel(sm) ? sm : null);
        rebuildInstances();
    });
    // Texture-atlas override is model-only — a primitive maps to tiles of the
    // shared primitive atlas, so swapping the whole atlas is meaningless there
    // (the dropdown is disabled for primitives in syncInspectorTransformFields).
    uvTextureSelect?.addEventListener('change', () => {
        if (syncingInspector) return;
        const sm = selectedModel();
        if (!sm || primitiveShapeFromSceneModel(sm)) return;
        if (sm.id !== uvPushModelId) {
            pushHistory();
            uvPushModelId = sm.id;
        }
        const next = uvTextureSelect.value;
        sm.textureOverride = isTextureAssetId(next) ? next : undefined;
        sm.overrideMaterialId = undefined;
        rebuildInstances();
    });
    function updateCollapseUI(): void {
        if (visualCollapseBtn) visualCollapseBtn.textContent = visualGroupCollapsed ? '▶' : '▼';
        if (transformCollapseBtn) transformCollapseBtn.textContent = transformSectionCollapsed ? '▶' : '▼';
        if (uvCollapseBtn) uvCollapseBtn.textContent = uvSectionCollapsed ? '▶' : '▼';
    }

    visualCollapseBtn?.addEventListener('click', () => {
        visualGroupCollapsed = !visualGroupCollapsed;
        updateCollapseUI();
        syncInspectorTransformFields(selectedModel());
    });
    transformCollapseBtn?.addEventListener('click', () => {
        transformSectionCollapsed = !transformSectionCollapsed;
        updateCollapseUI();
        syncInspectorTransformFields(selectedModel());
    });
    uvCollapseBtn?.addEventListener('click', () => {
        uvSectionCollapsed = !uvSectionCollapsed;
        updateCollapseUI();
        syncInspectorTransformFields(selectedModel());
    });

    for (const sel of colliderSelectList) sel.addEventListener('change', applyColliderFromInputs);
    for (const input of colliderValueInputList) {
        input.addEventListener('input', applyColliderFromInputs);
        input.addEventListener('change', applyColliderFromInputs);
    }

    function overrideTextureForSceneModel(sm: SceneModel): ReturnType<typeof buildTextureRGBA> {
        const palette = sm.paletteOverride ? picoCadPaletteOverride(sm.paletteOverride) : undefined;
        const texture = sm.textureOverride ? textureAssetOverride(sm.textureOverride) : undefined;
        return buildTextureRGBA(sm.loadedModel.data, palette, texture);
    }

    function ensureSceneModelMaterial(sm: SceneModel): void {
        if (!sm.paletteOverride && !sm.textureOverride) {
            sm.overrideMaterialId = undefined;
            return;
        }
        const materialId = `override:${sm.id}:${sm.paletteOverride ?? ''}:${sm.textureOverride ?? ''}`;
        if (sm.overrideMaterialId === materialId) return;
        const tex = overrideTextureForSceneModel(sm);
        renderer.addMaterial(materialId, {
            width: tex.width,
            height: tex.height,
            pixels: tex.pixels,
            palettePixels: tex.palettePixels,
            transparentIndex: tex.transparentIndex,
        });
        sm.overrideMaterialId = materialId;
    }

    function rebuildInstances(): void {
        for (const sm of sceneModels) ensureSceneModelMaterial(sm);
        renderer.setInstances(
            sceneModels.flatMap((sm) => sceneModelToInstances(sm, sm.id === selectedModelId, selectedInstanceId)),
        );
        renderer.setColliderShapes(buildColliderOverlayShapes(colliderBodies));
        updateTransformGizmo();
        refreshInspector();
    }

    function selectedModel(): SceneModel | null {
        return selectedModelId ? (sceneModels.find((sm) => sm.id === selectedModelId) ?? null) : null;
    }

    function sceneModelParts(sm: SceneModel): ModelMeshPart[] {
        return (
            sm.uvMeshParts ??
            (sm.partPrefix
                ? sm.loadedModel.parts.filter((p) => p.meshId === sm.partPrefix || p.meshId.startsWith(`${sm.partPrefix}/`))
                : sm.loadedModel.parts)
        );
    }

    function instanceIdForMeshId(sm: SceneModel, meshId: string): string | null {
        const index = sceneModelParts(sm).findIndex((part) => part.meshId === meshId);
        return index >= 0 ? `${sm.id}:${index}` : null;
    }

    function selectedPart(): { sm: SceneModel; part: ModelMeshPart; instanceId: string } | null {
        const sm = selectedModel();
        if (!sm || !selectedInstanceId) return null;
        const prefix = `${sm.id}:`;
        if (!selectedInstanceId.startsWith(prefix)) return null;
        const index = Number(selectedInstanceId.slice(prefix.length));
        const part = sceneModelParts(sm)[index];
        return part ? { sm, part, instanceId: selectedInstanceId } : null;
    }

    function defaultPartOverride(): PartTransformOverride {
        return {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
        };
    }

    function ensurePartOverride(sm: SceneModel, meshId: string): PartTransformOverride {
        sm.partOverrides ??= {};
        sm.partOverrides[meshId] ??= defaultPartOverride();
        return sm.partOverrides[meshId];
    }

    function sceneModelDisplayName(sm: SceneModel, index = sceneModels.indexOf(sm)): string {
        if (sm.isMulti) {
            const childName = sm.childIndex === undefined ? null : multiChildNames.get(`multi:${sm.fileName}:${sm.childIndex}`);
            return `${index + 1}. ${sm.fileName}/${childName ?? sm.childIndex ?? 'child'}`;
        }
        return `${index + 1}. ${sm.fileName}`;
    }

    function outlinerRootNode(sm: SceneModel): PicoCad2Node | null {
        const root = sm.loadedModel.graphRoot;
        if (!root) return null;
        if (!sm.isMulti || sm.childIndex === undefined) return root;
        return root.children?.[sm.childIndex] ?? null;
    }

    function selectSceneModelFromOutliner(sm: SceneModel, instanceId: string | null = null): void {
        selectedModelId = sm.id;
        selectedInstanceId = instanceId;
        selectedColliderBodyId = null;
        transformState = null;
        renderer.setHoverSnap(null);
        rebuildInstances();
    }

    function renderOutlinerNode(
        sm: SceneModel,
        node: PicoCad2Node,
        nodeId: string,
        label: string,
        depth: number,
        active: boolean,
    ): void {
        if (!outlinerListEl) return;

        const children = node.children ?? [];
        const hasChildren = children.length > 0;
        const expanded = expandedOutlinerNodeIds.has(nodeId);

        const row = document.createElement('div');
        const nodeMeshId =
            node.mesh?.vertices?.length && node.mesh.faces?.length
                ? depth === 0
                    ? sceneModelParts(sm)[0]?.meshId
                    : `mesh:${sm.fileName}:${nodeId.slice(`${sm.id}/`.length)}`
                : null;
        const instanceId = nodeMeshId ? instanceIdForMeshId(sm, nodeMeshId) : null;
        row.className = `outliner-item${active || instanceId === selectedInstanceId ? ' active' : ''}`;
        row.style.paddingLeft = `${8 + depth * 14}px`;
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.addEventListener('click', () => selectSceneModelFromOutliner(sm, instanceId));
        row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectSceneModelFromOutliner(sm, instanceId);
            }
        });

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = `outliner-toggle${hasChildren ? '' : ' placeholder'}`;
        toggle.textContent = hasChildren ? (expanded ? 'v' : '>') : '.';
        toggle.tabIndex = hasChildren ? 0 : -1;
        toggle.setAttribute('aria-label', expanded ? `Collapse ${label}` : `Expand ${label}`);
        if (hasChildren) {
            toggle.addEventListener('click', (event) => {
                event.stopPropagation();
                if (expanded) expandedOutlinerNodeIds.delete(nodeId);
                else expandedOutlinerNodeIds.add(nodeId);
                refreshInspector();
            });
        }
        row.appendChild(toggle);

        const labelEl = document.createElement('span');
        labelEl.className = 'outliner-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);

        outlinerListEl.appendChild(row);

        if (!expanded) return;
        for (const [index, child] of children.entries()) {
            const childId = `${nodeId}/${index}`;
            renderOutlinerNode(sm, child, childId, outlinerNodeName(child, `node_${index}`), depth + 1, false);
        }
    }

    function inspectorHasFocus(): boolean {
        const active = document.activeElement;
        return (
            transformInputList.some((i) => i === active) ||
            uvInputList.some((i) => i === active) ||
            uvPaletteSelect === active ||
            uvTextureSelect === active ||
            colliderAllInputList.some((i) => i === active)
        );
    }

    function setTransformInputsEnabled(enabled: boolean): void {
        for (const input of transformInputList) input.disabled = !enabled;
    }

    function syncInspectorTransformFields(sm: SceneModel | null, pb?: ColliderBodyEntry): void {
        const isPrimitive = sm !== null && primitiveShapeFromSceneModel(sm) !== null;
        const hasAppearance = sm !== null && sm.loadedModel.textureImageData !== undefined;
        if (transformHeaderEl) transformHeaderEl.style.display = visualGroupCollapsed ? 'none' : '';
        if (transformSectionEl)
            transformSectionEl.style.display = visualGroupCollapsed || transformSectionCollapsed ? 'none' : '';
        if (uvHeaderEl) uvHeaderEl.style.display = hasAppearance && !visualGroupCollapsed ? '' : 'none';
        if (uvSectionEl) uvSectionEl.style.display = hasAppearance && !visualGroupCollapsed && !uvSectionCollapsed ? '' : 'none';

        if (pb) {
            if (selectedNameEl) selectedNameEl.textContent = `${pb.colliderShape} body`;
            setTransformInputsEnabled(true);
            if (!inspectorHasFocus()) {
                syncingInspector = true;
                if (transformInputs.posX) transformInputs.posX.value = formatInspectorNumber(pb.position[0]);
                if (transformInputs.posY) transformInputs.posY.value = formatInspectorNumber(pb.position[1]);
                if (transformInputs.posZ) transformInputs.posZ.value = formatInspectorNumber(pb.position[2]);
                if (transformInputs.rotX) transformInputs.rotX.value = formatInspectorNumber(pb.rotation[0]);
                if (transformInputs.rotY) transformInputs.rotY.value = formatInspectorNumber(pb.rotation[1]);
                if (transformInputs.rotZ) transformInputs.rotZ.value = formatInspectorNumber(pb.rotation[2]);
                if (transformInputs.scaleX) transformInputs.scaleX.value = formatInspectorNumber(pb.scale[0]);
                if (transformInputs.scaleY) transformInputs.scaleY.value = formatInspectorNumber(pb.scale[1]);
                if (transformInputs.scaleZ) transformInputs.scaleZ.value = formatInspectorNumber(pb.scale[2]);
                syncingInspector = false;
            }
            return;
        }

        if (!sm) {
            if (selectedNameEl) selectedNameEl.textContent = 'No selection';
            setTransformInputsEnabled(false);
            for (const input of transformInputList) input.value = '';
            return;
        }
        const partSelection = selectedPart();
        if (selectedNameEl)
            selectedNameEl.textContent = partSelection
                ? `${sceneModelDisplayName(sm)} / ${partSelection.part.meshId.split(':').pop() ?? 'part'}`
                : sceneModelDisplayName(sm);
        setTransformInputsEnabled(true);
        if (inspectorHasFocus()) return;
        syncingInspector = true;
        const transform = partSelection
            ? (sm.partOverrides?.[partSelection.part.meshId] ?? defaultPartOverride())
            : { position: sm.position, rotation: sm.rotation, scale: sm.scale };
        if (transformInputs.posX) transformInputs.posX.value = formatInspectorNumber(transform.position[0]);
        if (transformInputs.posY) transformInputs.posY.value = formatInspectorNumber(transform.position[1]);
        if (transformInputs.posZ) transformInputs.posZ.value = formatInspectorNumber(transform.position[2]);
        if (transformInputs.rotX) transformInputs.rotX.value = formatInspectorNumber(transform.rotation[0]);
        if (transformInputs.rotY) transformInputs.rotY.value = formatInspectorNumber(transform.rotation[1]);
        if (transformInputs.rotZ) transformInputs.rotZ.value = formatInspectorNumber(transform.rotation[2]);
        if (transformInputs.scaleX) transformInputs.scaleX.value = formatInspectorNumber(transform.scale[0]);
        if (transformInputs.scaleY) transformInputs.scaleY.value = formatInspectorNumber(transform.scale[1]);
        if (transformInputs.scaleZ) transformInputs.scaleZ.value = formatInspectorNumber(transform.scale[2]);
        if (isPrimitive) {
            const uv = sm.uvSpec ?? { u: 1, v: 1, tileSize: 16 };
            if (uvInputs.u) uvInputs.u.value = String(uv.u);
            if (uvInputs.v) uvInputs.v.value = String(uv.v);
            if (uvInputs.tileSize) uvInputs.tileSize.value = String(uv.tileSize);
            if (uvInputs.repeatU) uvInputs.repeatU.value = uv.repeatU !== undefined ? String(uv.repeatU) : '';
            if (uvInputs.repeatV) uvInputs.repeatV.value = uv.repeatV !== undefined ? String(uv.repeatV) : '';
        }
        for (const input of uvInputList) input.disabled = !isPrimitive;
        if (uvCanvasEl) uvCanvasEl.style.display = isPrimitive ? 'block' : 'none';
        if (uvPaletteSelect) uvPaletteSelect.value = sm.paletteOverride ?? '';
        if (uvTextureSelect) {
            // Atlas swap only applies to whole models, not primitive tiles.
            uvTextureSelect.value = sm.textureOverride ?? '';
            uvTextureSelect.disabled = isPrimitive;
        }
        syncingInspector = false;
        drawUvCanvas(isPrimitive ? sm : null);
    }

    function refreshInspector(): void {
        if (outlinerListEl) {
            outlinerListEl.replaceChildren();
            for (const [index, sm] of sceneModels.entries()) {
                const root = outlinerRootNode(sm);
                if (root) renderOutlinerNode(sm, root, sm.id, sceneModelDisplayName(sm, index), 0, sm.id === selectedModelId);
            }
            outlinerListEl.classList.toggle('outliner-list-dimmed', selectedColliderBodyId !== null);
        }
        const selectedPb = colliderBodies.find((b) => b.id === selectedColliderBodyId);
        syncInspectorTransformFields(selectedModel(), selectedPb);
        refreshColliderOutliner();
        syncColliderBodyPropsPanel();
        renderEcsComponents();
    }

    function captureSnapshot(): BlueprintSnapshot {
        return {
            models: sceneModels.map((sm) => ({
                id: sm.id,
                fileName: sm.fileName,
                isMulti: sm.isMulti,
                childIndex: sm.childIndex,
                position: [...sm.position] as [number, number, number],
                rotation: [...sm.rotation] as [number, number, number],
                scale: [...sm.scale] as [number, number, number],
                partPrefix: sm.partPrefix,
                uvSpec: sm.uvSpec ? { ...sm.uvSpec } : undefined,
                paletteOverride: sm.paletteOverride,
                textureOverride: sm.textureOverride,
                partOverrides: clonePartOverrides(sm.partOverrides),
            })),
            colliderBodies: colliderBodies.map((pb) => ({ ...pb })),
            ecsComponents: ecsComponents.map(cloneEcsComponent),
        };
    }

    function pushHistory(): void {
        undoStack.push(captureSnapshot());
        if (undoStack.length > MAX_HISTORY) undoStack.shift();
        redoStack.length = 0;
        inspectorPushKey = null;
        uvPushModelId = null;
        colliderPushBodyId = null;
        ecsFieldPushed = false;
    }

    function restoreSnapshot(snapshot: BlueprintSnapshot): void {
        sceneModels.length = 0;
        for (const entry of snapshot.models) {
            const loadedModel = loadedModels.get(entry.isMulti ? `multi:${entry.fileName}` : `model:${entry.fileName}`);
            if (!loadedModel) continue;
            const sm: SceneModel = {
                id: entry.id,
                fileName: entry.fileName,
                isMulti: entry.isMulti,
                childIndex: entry.childIndex,
                position: [...entry.position] as [number, number, number],
                rotation: [...entry.rotation] as [number, number, number],
                scale: [...entry.scale] as [number, number, number],
                loadedModel,
                partPrefix: entry.partPrefix,
                meshBounds:
                    boundsCache.get(entry.isMulti ? `multi:${entry.fileName}:${entry.childIndex}` : `model:${entry.fileName}`) ??
                    null,
                uvSpec: entry.uvSpec ? { ...entry.uvSpec } : undefined,
                paletteOverride: entry.paletteOverride,
                textureOverride: entry.textureOverride,
                partOverrides: clonePartOverrides(entry.partOverrides),
            };
            if (sm.uvSpec) rebuildPrimitiveUvMesh(sm);
            sceneModels.push(sm);
        }
        colliderBodies.length = 0;
        colliderBodies.push(...snapshot.colliderBodies.map((pb) => ({ ...pb })));
        ecsComponents.length = 0;
        ecsComponents.push(...snapshot.ecsComponents.map(cloneEcsComponent));
        selectedModelId = null;
        selectedInstanceId = null;
        selectedColliderBodyId = null;
        transformState = null;
        inspectorPushKey = null;
        uvPushModelId = null;
        colliderPushBodyId = null;
        ecsFieldPushed = false;
        rebuildInstances();
        refreshColliderOutliner();
        renderEcsComponents();
    }

    function undo(): void {
        if (undoStack.length === 0) return;
        redoStack.push(captureSnapshot());
        restoreSnapshot(undoStack.pop()!);
    }

    function redo(): void {
        if (redoStack.length === 0) return;
        undoStack.push(captureSnapshot());
        restoreSnapshot(redoStack.pop()!);
    }

    function applyInspectorTransform(): void {
        if (syncingInspector) return;
        const pb = colliderBodies.find((b) => b.id === selectedColliderBodyId);
        if (pb) {
            const key = `pb:${pb.id}`;
            if (key !== inspectorPushKey) {
                pushHistory();
                inspectorPushKey = key;
            }
            pb.position = [
                parseInspectorNumber(transformInputs.posX, pb.position[0]),
                parseInspectorNumber(transformInputs.posY, pb.position[1]),
                parseInspectorNumber(transformInputs.posZ, pb.position[2]),
            ];
            pb.rotation = [
                parseInspectorNumber(transformInputs.rotX, pb.rotation[0]),
                parseInspectorNumber(transformInputs.rotY, pb.rotation[1]),
                parseInspectorNumber(transformInputs.rotZ, pb.rotation[2]),
            ];
            pb.scale = [
                Math.max(0.01, parseInspectorNumber(transformInputs.scaleX, pb.scale[0])),
                Math.max(0.01, parseInspectorNumber(transformInputs.scaleY, pb.scale[1])),
                Math.max(0.01, parseInspectorNumber(transformInputs.scaleZ, pb.scale[2])),
            ];
            rebuildInstances();
            return;
        }
        const sm = selectedModel();
        if (!sm) return;
        const partSelection = selectedPart();
        if (partSelection) {
            const key = `${sm.id}:${partSelection.part.meshId}`;
            if (key !== inspectorPushKey) {
                pushHistory();
                inspectorPushKey = key;
            }
            const override = ensurePartOverride(sm, partSelection.part.meshId);
            override.position = [
                parseInspectorNumber(transformInputs.posX, override.position[0]),
                parseInspectorNumber(transformInputs.posY, override.position[1]),
                parseInspectorNumber(transformInputs.posZ, override.position[2]),
            ];
            override.rotation = [
                parseInspectorNumber(transformInputs.rotX, override.rotation[0]),
                parseInspectorNumber(transformInputs.rotY, override.rotation[1]),
                parseInspectorNumber(transformInputs.rotZ, override.rotation[2]),
            ];
            override.scale = [
                Math.max(0.05, parseInspectorNumber(transformInputs.scaleX, override.scale[0])),
                Math.max(0.05, parseInspectorNumber(transformInputs.scaleY, override.scale[1])),
                Math.max(0.05, parseInspectorNumber(transformInputs.scaleZ, override.scale[2])),
            ];
            transformState = null;
            renderer.setHoverSnap(null);
            rebuildInstances();
            return;
        }
        if (sm.id !== inspectorPushKey) {
            pushHistory();
            inspectorPushKey = sm.id;
        }
        sm.position = [
            parseInspectorNumber(transformInputs.posX, sm.position[0]),
            parseInspectorNumber(transformInputs.posY, sm.position[1]),
            parseInspectorNumber(transformInputs.posZ, sm.position[2]),
        ];
        sm.rotation = [
            parseInspectorNumber(transformInputs.rotX, sm.rotation[0]),
            parseInspectorNumber(transformInputs.rotY, sm.rotation[1]),
            parseInspectorNumber(transformInputs.rotZ, sm.rotation[2]),
        ];
        sm.scale = [
            Math.max(0.05, parseInspectorNumber(transformInputs.scaleX, sm.scale[0])),
            Math.max(0.05, parseInspectorNumber(transformInputs.scaleY, sm.scale[1])),
            Math.max(0.05, parseInspectorNumber(transformInputs.scaleZ, sm.scale[2])),
        ];
        transformState = null;
        renderer.setHoverSnap(null);
        rebuildInstances();
    }

    function rebuildPrimitiveUvMesh(sm: SceneModel): void {
        const shape = primitiveShapeFromSceneModel(sm);
        const root = sm.loadedModel.graphRoot;
        if (!shape || !root) return;
        const uv = sm.uvSpec ?? { u: 1, v: 1, tileSize: 16 };
        const sourceNode = findPrimitiveNodeByName(root, shape);
        if (!sourceNode) return;
        const remapped = remapPrimitiveNodeUvs(sourceNode, uv);
        const meshKey = `uvmesh:${sm.fileName}:u${uv.u}v${uv.v}t${uv.tileSize}r${uv.repeatU ?? 1}x${uv.repeatV ?? 1}`;
        const asset = buildMeshAssetFromPicoNode(remapped, meshKey, []);
        if (!asset) return;
        renderer.addMesh(meshKey, buildLocalMeshFromMeshAsset(asset));
        sm.uvMeshParts = [{ meshId: meshKey, nodeMatrix: makePicoModelMirrorMatrix() }];
    }

    function applyUvFromInputs(): void {
        if (syncingInspector) return;
        const sm = selectedModel();
        if (!sm || !primitiveShapeFromSceneModel(sm)) return;
        if (sm.id !== uvPushModelId) {
            pushHistory();
            uvPushModelId = sm.id;
        }
        const prev = sm.uvSpec ?? { u: 1, v: 1, tileSize: 16 };
        const repeatUStr = uvInputs.repeatU?.value.trim() ?? '';
        const repeatVStr = uvInputs.repeatV?.value.trim() ?? '';
        sm.uvSpec = {
            u: Math.max(1, Math.round(parseInspectorNumber(uvInputs.u, prev.u))),
            v: Math.max(1, Math.round(parseInspectorNumber(uvInputs.v, prev.v))),
            tileSize: Math.max(1, Math.round(parseInspectorNumber(uvInputs.tileSize, prev.tileSize))),
            repeatU: repeatUStr !== '' ? Math.max(1, Math.round(Number(repeatUStr))) : undefined,
            repeatV: repeatVStr !== '' ? Math.max(1, Math.round(Number(repeatVStr))) : undefined,
        };
        rebuildPrimitiveUvMesh(sm);
        drawUvCanvas(sm);
        rebuildInstances();
    }

    function syncColliderDimPanel(shape: ColliderShape): void {
        if (colliderDimsBoxEl) colliderDimsBoxEl.style.display = shape === 'box' ? '' : 'none';
        if (colliderDimsSphereEl) colliderDimsSphereEl.style.display = shape === 'sphere' ? '' : 'none';
    }

    function applyColliderFromInputs(): void {
        if (syncingInspector) return;
        const body = colliderBodies.find((b) => b.id === selectedColliderBodyId);
        if (!body) return;
        if (body.id !== colliderPushBodyId) {
            pushHistory();
            colliderPushBodyId = body.id;
        }
        const colliderShape = (colliderInputs.colliderShape?.value ?? body.colliderShape) as ColliderShape;
        body.colliderShape = colliderShape;
        body.length = Math.max(0.01, parseInspectorNumber(colliderInputs.length, body.length));
        body.width = Math.max(0.01, parseInspectorNumber(colliderInputs.width, body.width));
        body.height = Math.max(0.01, parseInspectorNumber(colliderInputs.boxHeight, body.height));
        body.radius = Math.max(0.01, parseInspectorNumber(colliderInputs.sphereRadius, body.radius));
        syncColliderDimPanel(colliderShape);
        refreshColliderOutliner();
    }

    function syncColliderBodyPropsPanel(): void {
        const body = colliderBodies.find((b) => b.id === selectedColliderBodyId);
        if (!colliderBodyPropsEl) return;
        if (!body) {
            colliderBodyPropsEl.style.display = 'none';
            return;
        }
        colliderBodyPropsEl.style.display = '';
        syncingInspector = true;
        if (colliderInputs.colliderShape) colliderInputs.colliderShape.value = body.colliderShape;
        if (colliderInputs.length) colliderInputs.length.value = String(body.length);
        if (colliderInputs.width) colliderInputs.width.value = String(body.width);
        if (colliderInputs.boxHeight) colliderInputs.boxHeight.value = String(body.height);
        if (colliderInputs.sphereRadius) colliderInputs.sphereRadius.value = String(body.radius);
        syncColliderDimPanel(body.colliderShape);
        syncingInspector = false;
    }

    function refreshColliderOutliner(): void {
        if (!colliderOutlinerListEl) return;
        colliderOutlinerListEl.replaceChildren();
        for (const [i, body] of colliderBodies.entries()) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = `outliner-item${body.id === selectedColliderBodyId ? ' active' : ''}`;
            row.textContent = `${i + 1}. ${body.colliderShape}`;
            row.addEventListener('click', () => selectColliderBody(body.id));
            colliderOutlinerListEl.appendChild(row);
        }
        colliderOutlinerListEl.classList.toggle('outliner-list-dimmed', selectedModelId !== null);
    }

    function selectColliderBody(id: string | null): void {
        selectedColliderBodyId = id;
        if (id !== null) {
            selectedModelId = null;
            selectedInstanceId = null;
            transformState = null;
            renderer.setHoverSnap(null);
            rebuildInstances();
        } else {
            refreshColliderOutliner();
            syncColliderBodyPropsPanel();
        }
    }

    function deleteSelectedColliderBody(): boolean {
        if (!selectedColliderBodyId) return false;
        const index = colliderBodies.findIndex((b) => b.id === selectedColliderBodyId);
        if (index < 0) return false;
        pushHistory();
        colliderBodies.splice(index, 1);
        selectedColliderBodyId = null;
        transformState = null;
        renderer.setHoverSnap(null);
        rebuildInstances();
        return true;
    }

    // Only one collider body per blueprint — adding a new one replaces the existing one.
    colliderAddBtnEl?.addEventListener('click', () => {
        pushHistory();
        const shape = (colliderAddShapeEl?.value ?? 'box') as ColliderShape;
        const body: ColliderBodyEntry = { id: `cb:${colliderBodyCounter++}`, ...DEFAULT_COLLIDER_BODY, colliderShape: shape };
        colliderBodies.length = 0;
        colliderBodies.push(body);
        selectColliderBody(body.id);
    });

    function collectAllNodeNames(): string[] {
        const names = new Set<string>();
        function visit(node: PicoCad2Node): void {
            if (node.name?.trim()) names.add(node.name.trim());
            for (const child of node.children ?? []) visit(child);
        }
        for (const sm of sceneModels) {
            const root = sm.loadedModel.graphRoot;
            if (root) visit(root);
        }
        return [...names].sort();
    }

    function makeEcsFieldRow(labelText: string, type: string, value: string, onChange: (v: string) => void): HTMLElement {
        const row = document.createElement('div');
        row.style.cssText = 'display:grid;grid-template-columns:52px 1fr;gap:4px;align-items:center';
        const label = document.createElement('label');
        label.style.cssText = 'font:10px monospace;color:#777';
        label.textContent = labelText;
        const input = document.createElement('input');
        input.className = 'transform-input';
        input.type = type;
        input.value = value;
        if (type === 'number') input.step = 'any';
        input.addEventListener('change', () => onChange(input.value));
        input.addEventListener('input', () => onChange(input.value));
        row.appendChild(label);
        row.appendChild(input);
        return row;
    }

    function makeEcsCheckboxRow(labelText: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
        const row = document.createElement('div');
        row.style.cssText = 'display:grid;grid-template-columns:52px 1fr;gap:4px;align-items:center';
        const label = document.createElement('label');
        label.style.cssText = 'font:10px monospace;color:#777';
        label.textContent = labelText;
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = checked;
        input.addEventListener('change', () => onChange(input.checked));
        row.appendChild(label);
        row.appendChild(input);
        return row;
    }

    function renderEcsComponents(): void {
        if (!ecsComponentsListEl) return;
        ecsComponentsListEl.replaceChildren();
        const nodeNames = collectAllNodeNames();

        for (const [index, comp] of ecsComponents.entries()) {
            const card = document.createElement('div');
            card.style.cssText =
                'background:#1a1a1a;border:1px solid #2c2c2c;border-radius:2px;padding:5px 6px;display:grid;gap:4px';

            const header = document.createElement('div');
            header.style.cssText = 'display:flex;align-items:center;justify-content:space-between';
            const typeLabel = document.createElement('span');
            typeLabel.style.cssText = 'font:10px monospace;color:#4ac';
            typeLabel.textContent = comp.type;
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.style.cssText =
                'background:transparent;border:0;color:#555;font:11px monospace;cursor:pointer;padding:0 2px;line-height:1';
            removeBtn.textContent = '✕';
            removeBtn.addEventListener('mouseenter', () => {
                removeBtn.style.color = '#e44';
            });
            removeBtn.addEventListener('mouseleave', () => {
                removeBtn.style.color = '#555';
            });
            removeBtn.addEventListener('click', () => {
                pushHistory();
                ecsComponents.splice(index, 1);
                renderEcsComponents();
            });
            header.appendChild(typeLabel);
            header.appendChild(removeBtn);
            card.appendChild(header);

            if (comp.type === 'control_player') {
                card.appendChild(
                    makeEcsCheckboxRow('Move', comp.move, (v) => {
                        if (!ecsFieldPushed) {
                            pushHistory();
                            ecsFieldPushed = true;
                        }
                        comp.move = v;
                    }),
                );
                card.appendChild(
                    makeEcsCheckboxRow('Yaw', comp.yaw, (v) => {
                        if (!ecsFieldPushed) {
                            pushHistory();
                            ecsFieldPushed = true;
                        }
                        comp.yaw = v;
                    }),
                );
                card.appendChild(
                    makeEcsCheckboxRow('Pitch', comp.pitch, (v) => {
                        if (!ecsFieldPushed) {
                            pushHistory();
                            ecsFieldPushed = true;
                        }
                        comp.pitch = v;
                    }),
                );
            } else if (comp.type === 'control_move') {
                const nodeInput = makeEcsFieldRow('Nodes', 'text', comp.nodeNames.join(', '), (v) => {
                    if (!ecsFieldPushed) {
                        pushHistory();
                        ecsFieldPushed = true;
                    }
                    comp.nodeNames = v
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean);
                });
                const textInput = nodeInput.querySelector('input');
                if (textInput && nodeNames.length > 0) {
                    const listId = 'ecs-node-datalist';
                    let dl = document.getElementById(listId) as HTMLDataListElement | null;
                    if (!dl) {
                        dl = document.createElement('datalist');
                        dl.id = listId;
                        document.body.appendChild(dl);
                    }
                    dl.replaceChildren(
                        ...nodeNames.map((n) => {
                            const opt = document.createElement('option');
                            opt.value = n;
                            return opt;
                        }),
                    );
                    textInput.setAttribute('list', listId);
                }
                card.appendChild(nodeInput);
                for (const [axisIndex, axisName] of (['x', 'y', 'z'] as const).entries()) {
                    card.appendChild(
                        makeEcsFieldRow(`Dir ${axisName.toUpperCase()}`, 'number', String(comp.direction[axisIndex]), (v) => {
                            if (!ecsFieldPushed) {
                                pushHistory();
                                ecsFieldPushed = true;
                            }
                            const next = [...comp.direction] as [number, number, number];
                            next[axisIndex] = Number.parseFloat(v) || 0;
                            comp.direction = next;
                        }),
                    );
                }
                const axisRow = document.createElement('div');
                axisRow.style.cssText = 'display:grid;grid-template-columns:52px 1fr;gap:4px;align-items:center';
                const axisLabel = document.createElement('label');
                axisLabel.style.cssText = 'font:10px monospace;color:#777';
                axisLabel.textContent = 'Rot Axis';
                const axisSel = document.createElement('select');
                axisSel.className = 'transform-input';
                const noneOpt = document.createElement('option');
                noneOpt.value = '';
                noneOpt.textContent = 'none';
                if (!comp.rotAxis) noneOpt.selected = true;
                axisSel.appendChild(noneOpt);
                for (const ax of ['x', 'y', 'z'] as const) {
                    const opt = document.createElement('option');
                    opt.value = ax;
                    opt.textContent = ax;
                    if (ax === comp.rotAxis) opt.selected = true;
                    axisSel.appendChild(opt);
                }
                axisSel.addEventListener('change', () => {
                    if (!ecsFieldPushed) {
                        pushHistory();
                        ecsFieldPushed = true;
                    }
                    comp.rotAxis = axisSel.value ? (axisSel.value as 'x' | 'y' | 'z') : null;
                });
                axisRow.appendChild(axisLabel);
                axisRow.appendChild(axisSel);
                card.appendChild(axisRow);
                card.appendChild(
                    makeEcsCheckboxRow('Flip', comp.rotDirection === -1, (v) => {
                        if (!ecsFieldPushed) {
                            pushHistory();
                            ecsFieldPushed = true;
                        }
                        comp.rotDirection = v ? -1 : 1;
                    }),
                );
            }

            ecsComponentsListEl.appendChild(card);
        }
    }

    ecsAddBtnEl?.addEventListener('click', () => {
        pushHistory();
        const type = (ecsAddTypeEl?.value ?? 'control_player') as EcsComponentDef['type'];
        if (type === 'control_player') {
            ecsComponents.push({ type: 'control_player', move: true, yaw: true, pitch: false });
        } else {
            ecsComponents.push({ type: 'control_move', nodeNames: [], direction: [0, 0, 0], rotAxis: 'y', rotDirection: 1 });
        }
        renderEcsComponents();
    });

    function drawUvCanvas(sm: SceneModel | null): void {
        const canvas = uvCanvasEl;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const tex = sm ? textureImageDataForSceneModel(sm) : undefined;
        if (!tex) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }
        if (canvas.width !== tex.width || canvas.height !== tex.height) {
            canvas.width = tex.width;
            canvas.height = tex.height;
        }
        const uv = sm?.uvSpec ?? { u: 1, v: 1, tileSize: 16 };
        const ts = Math.max(1, uv.tileSize);
        const tx = (uv.u - 1) * ts;
        const ty = (uv.v - 1) * ts;

        // Draw full texture, darken non-selected area, then restore selected tile
        ctx.putImageData(tex, 0, 0);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(0, 0, tex.width, tex.height);
        ctx.putImageData(tex, 0, 0, tx, ty, ts, ts);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(tx + 0.5, ty + 0.5, ts - 1, ts - 1);
    }

    function textureImageDataForSceneModel(sm: SceneModel): ImageData | undefined {
        if (!sm.paletteOverride && !sm.textureOverride) return sm.loadedModel.textureImageData;
        try {
            const tex = overrideTextureForSceneModel(sm);
            return new ImageData(new Uint8ClampedArray(tex.rgbaPixels), tex.width, tex.height);
        } catch {
            return sm.loadedModel.textureImageData;
        }
    }

    if (uvCanvasEl) {
        uvCanvasEl.addEventListener('click', (e) => {
            const sm = selectedModel();
            if (!sm || !primitiveShapeFromSceneModel(sm)) return;
            if (sm.id !== uvPushModelId) {
                pushHistory();
                uvPushModelId = sm.id;
            }
            const rect = uvCanvasEl.getBoundingClientRect();
            const scaleX = (uvCanvasEl.width || 128) / rect.width;
            const scaleY = (uvCanvasEl.height || 128) / rect.height;
            const px = (e.clientX - rect.left) * scaleX;
            const py = (e.clientY - rect.top) * scaleY;
            const uv = sm.uvSpec ?? { u: 1, v: 1, tileSize: 16 };
            const ts = Math.max(1, uv.tileSize);
            const maxTile = Math.floor((uvCanvasEl.width || 128) / ts);
            const newU = Math.max(1, Math.min(Math.floor(px / ts) + 1, maxTile));
            const newV = Math.max(1, Math.min(Math.floor(py / ts) + 1, maxTile));
            sm.uvSpec = { ...uv, u: newU, v: newV };
            syncingInspector = true;
            if (uvInputs.u) uvInputs.u.value = String(newU);
            if (uvInputs.v) uvInputs.v.value = String(newV);
            syncingInspector = false;
            rebuildPrimitiveUvMesh(sm);
            drawUvCanvas(sm);
            rebuildInstances();
        });
    }

    function deleteSelectedModel(): boolean {
        if (!selectedModelId) return false;
        const index = sceneModels.findIndex((sm) => sm.id === selectedModelId);
        if (index < 0) return false;
        pushHistory();
        sceneModels.splice(index, 1);
        selectedModelId = null;
        selectedInstanceId = null;
        transformState = null;
        suppressNextClick = false;
        renderer.setHoverSnap(null);
        rebuildInstances();
        return true;
    }

    function cloneSelectedModel(): boolean {
        const sm = selectedModel();
        if (!sm) return false;
        pushHistory();
        const clone: SceneModel = {
            id: `sm:${sceneModelCounter++}`,
            fileName: sm.fileName,
            isMulti: sm.isMulti,
            childIndex: sm.childIndex,
            position: [...sm.position],
            rotation: [...sm.rotation],
            scale: [...sm.scale],
            loadedModel: sm.loadedModel,
            partPrefix: sm.partPrefix,
            meshBounds: sm.meshBounds,
            uvSpec: sm.uvSpec ? { ...sm.uvSpec } : undefined,
            paletteOverride: sm.paletteOverride,
            textureOverride: sm.textureOverride,
            partOverrides: clonePartOverrides(sm.partOverrides),
        };
        if (clone.uvSpec) rebuildPrimitiveUvMesh(clone);
        sceneModels.push(clone);
        selectedModelId = clone.id;
        selectedInstanceId = null;
        transformState = null;
        suppressNextClick = false;
        renderer.setHoverSnap(null);
        rebuildInstances();
        skipNextTransformHistoryPush = true;
        beginTransform('translate');
        return true;
    }

    function footprintFromSidebarPayload(payload: string): [number, number, number, number] {
        const cacheKey = payload.startsWith('multi:') ? payload : `model:${payload.slice(6)}`;
        return boundsToFootprint(boundsCache.get(cacheKey) ?? null);
    }

    function primitiveShapeFromSceneModel(sm: SceneModel): PrimitiveShape | null {
        if (sm.isMulti || !isPrimitiveShape(sm.fileName)) return null;
        return sm.fileName;
    }

    function sceneModelToBlueprintPlacement(sm: SceneModel): BlueprintPrimitivePlacement | null {
        const shape = primitiveShapeFromSceneModel(sm);
        if (!shape) return null;
        const uv = sm.uvSpec ?? { u: 1, v: 1, tileSize: 16 };
        return {
            name: shape,
            shape,
            position: sm.position,
            rotation: sm.rotation,
            scale: sm.scale,
            u: uv.u,
            v: uv.v,
            tileSize: uv.tileSize,
            repeatU: uv.repeatU,
            repeatV: uv.repeatV,
            paletteOverride: sm.paletteOverride,
        };
    }

    function beginSidebarModelSelection(payload: string): void {
        selectedModelId = null;
        selectedInstanceId = null;
        transformState = null;
        dragFootprint = footprintFromSidebarPayload(payload);
        renderer.setHoverSnap(null);
        rebuildInstances();
    }

    // ---- Model loading (idempotent) ----------------------------------------

    async function ensureModelLoaded(name: string, isMulti = false): Promise<LoadedModel | null> {
        const cacheKey = isMulti ? `multi:${name}` : `model:${name}`;
        const cached = loadedModels.get(cacheKey);
        if (cached) return cached;

        const globs = isMulti ? MULTI_FILES : MODEL_FILES;
        const filePath = isMulti
            ? `../assets/models/multi/${name}.txt`
            : `../assets/${isPrimitiveShape(name) ? 'primitives' : 'models'}/${name}.txt`;
        const loader = globs[filePath];
        if (!loader) {
            console.warn(`No file found for "${name}" (isMulti=${isMulti})`);
            return null;
        }

        let raw: string;
        try {
            raw = (await loader()) as string;
        } catch (err) {
            console.error(`Failed to load "${name}":`, err);
            return null;
        }

        const data = parsePicoCad2(raw);
        if (!data.graph || !data.texture) {
            console.warn(`"${name}" is missing graph or texture`);
            return null;
        }

        const partDescriptors: ModelMeshPart[] = [];
        collectMeshParts(data.graph, name, [], makePicoModelMirrorMatrix(), partDescriptors);

        if (partDescriptors.length === 0) {
            console.warn(`"${name}" has no mesh nodes`);
            return null;
        }

        for (const desc of partDescriptors) {
            const node = findNodeByMeshId(data.graph, name, desc.meshId);
            if (!node) continue;
            const asset = buildMeshAssetFromPicoNode(node, name, meshIdToPath(desc.meshId, name));
            if (!asset) continue;
            renderer.addMesh(desc.meshId, buildLocalMeshFromMeshAsset(asset));
        }

        const materialId = `mat:${name}`;
        const tex = buildTextureRGBA(data);
        renderer.addMaterial(materialId, {
            width: tex.width,
            height: tex.height,
            pixels: tex.pixels,
            palettePixels: tex.palettePixels,
            transparentIndex: tex.transparentIndex,
        });

        // Cache bounds per child for multi files, or whole graph for regular models
        if (!boundsCache.has(cacheKey)) {
            if (isMulti) {
                for (const [i, child] of (data.graph.children ?? []).entries()) {
                    boundsCache.set(`multi:${name}:${i}`, computeGraphBounds(child));
                }
            } else {
                boundsCache.set(cacheKey, computeGraphBounds(data.graph));
            }
        }

        let textureImageData: ImageData | undefined;
        try {
            textureImageData = new ImageData(new Uint8ClampedArray(tex.rgbaPixels), tex.width, tex.height);
        } catch {
            /* canvas API unavailable */
        }

        const entry: LoadedModel = {
            parts: partDescriptors,
            materialId,
            data,
            rawText: raw,
            textureImageData,
            graphRoot: data.graph,
        };
        loadedModels.set(cacheKey, entry);
        return entry;
    }

    // ---- Save / load -------------------------------------------------------

    async function exportBlueprint(): Promise<void> {
        if (sceneModels.length === 0) {
            window.alert('Place at least one model or primitive before exporting a blueprint.');
            return;
        }

        const nameInput = document.getElementById('blueprint-name') as HTMLInputElement | null;
        const blueprintId = toBlueprintName(nameInput?.value ?? 'blu_custom');
        if (nameInput) nameInput.value = blueprintId;

        const placements = sceneModels.map((sm) => sceneModelToBlueprintPlacement(sm));
        const unsupported = sceneModels.filter((_, i) => placements[i] === null);
        if (unsupported.length === 0) {
            const palettes = new Set(
                (placements as BlueprintPrimitivePlacement[])
                    .map((placement) => placement.paletteOverride)
                    .filter((palette): palette is PicoCadPaletteId => palette !== undefined),
            );
            if (palettes.size > 1) {
                window.alert('Primitive composition export supports one shared palette. Select the same palette for every primitive or use Model Palette.');
                return;
            }
            const [paletteOverride] = [...palettes];
            const primitivePlacements = (placements as BlueprintPrimitivePlacement[]).map((placement) => ({
                ...placement,
                paletteOverride,
            }));
            const source = buildBlueprintSource(
                blueprintId,
                primitivePlacements,
                colliderBodies[0],
                ecsComponents,
            );
            await saveTextFile(`${blueprintId}.ts`, source);
            await saveJsonToServer(blueprintId);
            return;
        }

        if (sceneModels.length !== 1) {
            window.alert('Blueprint export supports either primitives compositions or one regular model file.');
            return;
        }

        const [onlyModel] = sceneModels;
        if (!onlyModel || onlyModel.isMulti) {
            window.alert('Regular model blueprint export supports one item from Models, such as scorpio.');
            return;
        }

        const source = buildModelBlueprintSource(blueprintId, onlyModel, colliderBodies[0], ecsComponents);
        await saveTextFile(`${blueprintId}.ts`, source);
        await saveJsonToServer(blueprintId);
    }

    function buildBlueprintSaveData(): SaveData {
        return {
            version: 1,
            objects: sceneModels.map((sm) => ({
                file: sm.fileName,
                isMulti: sm.isMulti,
                childIndex: sm.childIndex,
                position: sm.position,
                rotation: sm.rotation,
                scale: sm.scale,
                uvSpec: sm.uvSpec,
                paletteOverride: sm.paletteOverride,
                textureOverride: sm.textureOverride,
                partOverrides: clonePartOverrides(sm.partOverrides),
            })),
            colliderBodies: colliderBodies.length > 0 ? [...colliderBodies] : undefined,
            ecsComponents: ecsComponents.length > 0 ? ecsComponents.map(cloneEcsComponent) : undefined,
        };
    }

    async function saveJsonToServer(blueprintId: string): Promise<void> {
        const fileName = `${blueprintId}.json`;
        const res = await fetch('/__editor/save-editor-save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName, source: JSON.stringify(buildBlueprintSaveData(), null, 2) }),
        });
        if (!res.ok) throw new Error(`Save failed: ${await res.text()}`);
        await refreshBlueprintSaveList(fileName);
    }

    async function refreshBlueprintSaveList(preferFile?: string): Promise<void> {
        if (!blueprintSaveSelect) return;
        const res = await fetch('/__editor/list-editor-saves');
        if (!res.ok) return;
        const data = (await res.json()) as { files?: unknown };
        const files = Array.isArray(data.files)
            ? data.files.filter((f): f is string => typeof f === 'string' && f.startsWith('blu_'))
            : [];
        const selected = preferFile && files.includes(preferFile) ? preferFile : (files[0] ?? '');
        blueprintSaveSelect.replaceChildren();
        for (const file of files) {
            const opt = document.createElement('option');
            opt.value = file;
            opt.textContent = file.replace(/\.json$/, '');
            blueprintSaveSelect.appendChild(opt);
        }
        blueprintSaveSelect.value = selected;
    }

    async function loadBlueprintFromServer(): Promise<void> {
        const fileName = blueprintSaveSelect?.value;
        if (!fileName) return;
        const res = await fetch(`/__editor/load-editor-save?file=${encodeURIComponent(fileName)}`);
        if (!res.ok) throw new Error(`Load failed: ${await res.text()}`);
        const data = (await res.json()) as SaveData;
        if (data.version !== 1) throw new Error('Unknown blueprint save version');
        const nameInput = document.getElementById('blueprint-name') as HTMLInputElement | null;
        if (nameInput) nameInput.value = fileName.replace(/\.json$/, '');
        await loadScene(data);
    }

    async function loadScene(data: SaveData): Promise<void> {
        sceneModels.length = 0;
        sceneModelCounter = 0;
        expandedOutlinerNodeIds.clear();
        selectedInstanceId = null;
        colliderBodies.length = 0;
        colliderBodyCounter = 0;
        selectedColliderBodyId = null;
        ecsComponents.length = 0;
        if (data.ecsComponents) ecsComponents.push(...data.ecsComponents.map(cloneEcsComponent));
        if (data.colliderBodies) {
            for (const pb of data.colliderBodies) {
                colliderBodies.push(pb);
                const idx = Number(pb.id.replace(/^\D+/, ''));
                if (!Number.isNaN(idx)) colliderBodyCounter = Math.max(colliderBodyCounter, idx + 1);
            }
        }
        for (const obj of data.objects) {
            const loadedModel = await ensureModelLoaded(obj.file, obj.isMulti);
            if (!loadedModel) continue;
            const partPrefix = obj.isMulti && obj.childIndex !== undefined ? `mesh:${obj.file}:${obj.childIndex}` : undefined;
            const boundsKey =
                obj.isMulti && obj.childIndex !== undefined ? `multi:${obj.file}:${obj.childIndex}` : `model:${obj.file}`;
            sceneModels.push({
                id: `sm:${sceneModelCounter++}`,
                fileName: obj.file,
                isMulti: obj.isMulti,
                childIndex: obj.childIndex,
                position: obj.position,
                rotation: obj.rotation ?? [0, 0, 0],
                scale: obj.scale ?? [1, 1, 1],
                loadedModel,
                partPrefix,
                meshBounds: boundsCache.get(boundsKey) ?? null,
                uvSpec: obj.uvSpec,
                paletteOverride: isPicoCadPaletteId(obj.paletteOverride) ? obj.paletteOverride : undefined,
                textureOverride: isTextureAssetId(obj.textureOverride) ? obj.textureOverride : undefined,
                partOverrides: clonePartOverrides(obj.partOverrides),
            });
            const newSm = sceneModels[sceneModels.length - 1];
            if (newSm?.uvSpec) rebuildPrimitiveUvMesh(newSm);
        }
        rebuildInstances();
    }

    // ---- Sidebar -----------------------------------------------------------

    function makeDraggable(el: HTMLElement, payload: string): void {
        el.draggable = true;
        el.addEventListener('pointerdown', () => {
            beginSidebarModelSelection(payload);
        });
        el.addEventListener('dblclick', () => {
            void placeModelFromPayload(payload, [0, 0, 0]);
        });
        el.addEventListener('dragstart', (e) => {
            e.dataTransfer!.setData('text/plain', payload);
            e.dataTransfer!.effectAllowed = 'copy';
            el.classList.add('dragging');
            beginSidebarModelSelection(payload);
        });
        el.addEventListener('dragend', () => el.classList.remove('dragging'));
    }

    function addSectionHeader(label: string): void {
        const h = document.createElement('div');
        h.className = 'sidebar-section';
        h.textContent = label;
        modelListEl.appendChild(h);
    }

    // Scene actions (save / load)
    const actionsEl = document.getElementById('scene-actions')!;

    const blueprintNameInput = document.createElement('input');
    blueprintNameInput.id = 'blueprint-name';
    blueprintNameInput.className = 'action-input';
    blueprintNameInput.type = 'text';
    blueprintNameInput.value = 'blu_custom';
    blueprintNameInput.autocomplete = 'off';
    blueprintNameInput.spellcheck = false;
    actionsEl.appendChild(blueprintNameInput);

    const exportBtn = document.createElement('button');
    exportBtn.className = 'action-btn';
    exportBtn.textContent = 'Export';
    exportBtn.addEventListener('click', () => {
        void exportBlueprint().catch((err) => {
            console.error('Failed to export blueprint:', err);
            window.alert(err instanceof Error ? err.message : String(err));
        });
    });
    actionsEl.appendChild(exportBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'action-btn';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
        const nameInput = document.getElementById('blueprint-name') as HTMLInputElement | null;
        const id = toBlueprintName(nameInput?.value ?? 'blu_custom');
        void saveJsonToServer(id).catch((err) => {
            console.error('Failed to save:', err);
            window.alert(err instanceof Error ? err.message : String(err));
        });
    });
    actionsEl.appendChild(saveBtn);

    blueprintSaveSelect = document.createElement('select');
    blueprintSaveSelect.className = 'action-input';
    actionsEl.appendChild(blueprintSaveSelect);

    const loadBtn = document.createElement('button');
    loadBtn.className = 'action-btn';
    loadBtn.textContent = 'Load';
    loadBtn.addEventListener('click', () => {
        void loadBlueprintFromServer().catch((err) => {
            console.error('Failed to load blueprint:', err);
            window.alert(err instanceof Error ? err.message : String(err));
        });
    });
    actionsEl.appendChild(loadBtn);

    const sceneEditorBtn = document.createElement('button');
    sceneEditorBtn.type = 'button';
    sceneEditorBtn.className = 'action-btn';
    sceneEditorBtn.textContent = 'Scene Editor';
    sceneEditorBtn.addEventListener('click', () => {
        window.location.href = 'editor.html';
    });
    actionsEl.appendChild(sceneEditorBtn);

    // The ECS Components panel below authors control_player/control_move; the
    // action buttons those map to are edited in one place, over there.
    const controlsEditorBtn = document.createElement('button');
    controlsEditorBtn.type = 'button';
    controlsEditorBtn.className = 'action-btn';
    controlsEditorBtn.textContent = 'Game Controls';
    controlsEditorBtn.addEventListener('click', () => {
        window.location.href = 'editor_controls.html';
    });
    actionsEl.appendChild(controlsEditorBtn);

    const animationEditorBtn = document.createElement('button');
    animationEditorBtn.type = 'button';
    animationEditorBtn.className = 'action-btn';
    animationEditorBtn.textContent = 'Animation Editor';
    animationEditorBtn.addEventListener('click', () => {
        window.location.href = 'editor_animation.html';
    });
    actionsEl.appendChild(animationEditorBtn);

    // Precompute footprints for model files (no GPU upload needed, just parse)
    void Promise.all(
        Object.keys(MODEL_FILES).map(async (filePath) => {
            const name = nameFromPath(filePath);
            try {
                const raw = (await MODEL_FILES[filePath]()) as string;
                const data = parsePicoCad2(raw);
                if (data.graph) {
                    boundsCache.set(`model:${name}`, computeGraphBounds(data.graph));
                }
            } catch {
                /* ignore */
            }
        }),
    );

    const modelNames = Object.keys(MODEL_FILES).map(nameFromPath).sort();

    // Models section
    addSectionHeader('Models');
    for (const name of modelNames.filter((name) => !isPrimitiveShape(name))) {
        const item = document.createElement('div');
        item.className = 'model-item';
        item.textContent = name;
        makeDraggable(item, `model:${name}`);
        modelListEl.appendChild(item);
    }

    // Libraries section
    const multiNames = Object.keys(MULTI_FILES).map(nameFromPath).sort();
    if (multiNames.length > 0) {
        addSectionHeader('Libraries');
        for (const fileName of multiNames) {
            const filePath = `../assets/models/multi/${fileName}.txt`;
            const loader = MULTI_FILES[filePath];
            if (!loader) continue;

            let childNames: string[] = [];
            try {
                const raw = (await loader()) as string;
                const data = parsePicoCad2(raw);
                const children = data.graph?.children ?? [];
                childNames = children.map((c, i) => c.name ?? `node_${i}`);
                for (const [i, child] of children.entries()) {
                    multiChildNames.set(`multi:${fileName}:${i}`, childNames[i] ?? `node_${i}`);
                    boundsCache.set(`multi:${fileName}:${i}`, computeGraphBounds(child));
                }
            } catch {
                /* leave empty */
            }

            const group = document.createElement('details');
            group.className = 'multi-group';

            const summary = document.createElement('summary');
            summary.className = 'multi-group-name';
            summary.textContent = fileName;
            group.appendChild(summary);

            for (const [i, nodeName] of childNames.entries()) {
                const item = document.createElement('div');
                item.className = 'model-item multi-item';
                item.textContent = nodeName;
                makeDraggable(item, `multi:${fileName}:${i}`);
                group.appendChild(item);
            }

            modelListEl.appendChild(group);
        }
    }

    // Primitives section
    addSectionHeader('Primitives');
    for (const name of modelNames.filter(isPrimitiveShape)) {
        const item = document.createElement('div');
        item.className = 'model-item';
        item.textContent = name;
        makeDraggable(item, `model:${name}`);
        modelListEl.appendChild(item);
    }

    // ---- Canvas drop target ------------------------------------------------

    function groundPointFromEvent(e: { clientX: number; clientY: number }): [number, number, number] | null {
        const rect = canvas.getBoundingClientRect();
        const ray = get_orbit_camera_pick_ray(orbit, e.clientX, e.clientY, rect, canvas.width, canvas.height, FOV_Y);
        if (!ray) return null;
        const { origin: o, direction: d } = ray;
        if (Math.abs(d[1]) < 1e-6) return null;
        const t = -o[1] / d[1];
        if (t <= 0) return null;
        return [o[0] + d[0] * t, 0, o[2] + d[2] * t];
    }

    function axisPlanePointFromEvent(
        e: { clientX: number; clientY: number },
        lockAxis: 'x' | 'y' | 'z',
        lockValue: number,
    ): [number, number, number] | null {
        const rect = canvas.getBoundingClientRect();
        const ray = get_orbit_camera_pick_ray(orbit, e.clientX, e.clientY, rect, canvas.width, canvas.height, FOV_Y);
        if (!ray) return null;
        const { origin: o, direction: d } = ray;
        const idx = lockAxis === 'x' ? 0 : lockAxis === 'y' ? 1 : 2;
        if (Math.abs(d[idx]) < 1e-6) return null;
        const t = (lockValue - o[idx]) / d[idx];
        if (t <= 0) return null;
        return [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    }

    function groundSnapFromEvent(e: { clientX: number; clientY: number }): [number, number, number] | null {
        const p = groundPointFromEvent(e);
        if (!p) return null;
        const [x, , z] = p;
        return [Math.round(x), 0, Math.round(z)];
    }

    function selectedGizmoRadius(sm: SceneModel): number {
        const footprint = sceneModelToStableYawFootprint(sm);
        const [, rx1, , rz1] = footprint;
        const [rx0, , rz0] = footprint;
        return Math.max(1.6, Math.hypot(Math.abs(rx1 - rx0) * 0.5, Math.abs(rz1 - rz0) * 0.5) + 1.1);
    }

    function gizmoAxisHitFromEvent(e: { clientX: number; clientY: number }): Exclude<TransformAxis, null> | null {
        const sm = selectedModel();
        const pb = !sm ? colliderBodies.find((b) => b.id === selectedColliderBodyId) : null;
        if ((!sm && !pb) || transformState) return null;
        const rect = canvas.getBoundingClientRect();
        const dprX = canvas.width / Math.max(1, rect.width);
        const dprY = canvas.height / Math.max(1, rect.height);
        const px = (e.clientX - rect.left) * dprX;
        const py = (e.clientY - rect.top) * dprY;
        const len = pb ? 2.0 : selectedGizmoRadius(sm!);
        const hitRadius = 14 * Math.max(dprX, dprY);
        const [cx, cy, cz] = pb ? pb.position : sm!.position;
        const baseY = cy + 0.08;
        const sqO = len * 0.2;
        const sq = len * 0.32;

        const axes: Array<{ axis: Exclude<TransformAxis, null>; a: [number, number, number]; b: [number, number, number] }> = [
            { axis: 'x', a: [cx, baseY, cz], b: [cx + len, baseY, cz] },
            { axis: 'y', a: [cx, cy, cz], b: [cx, cy + len, cz] },
            { axis: 'z', a: [cx, baseY, cz], b: [cx, baseY, cz + len] },
        ];

        let best: Exclude<TransformAxis, null> | null = null;
        let bestDist = Infinity;
        for (const candidate of axes) {
            const a = renderer.projectToScreen(candidate.a[0], candidate.a[1], candidate.a[2], canvas.width, canvas.height);
            const b = renderer.projectToScreen(candidate.b[0], candidate.b[1], candidate.b[2], canvas.width, canvas.height);
            if (!a || !b) continue;
            const dist = screenDistanceToSegment(px, py, a[0], a[1], b[0], b[1]);
            if (dist < bestDist) {
                bestDist = dist;
                best = candidate.axis;
            }
        }

        const planeMargin = 8 * Math.max(dprX, dprY);
        const planeSquares: Array<{ axis: Exclude<TransformAxis, null>; corners: [number, number, number][] }> = [
            {
                axis: 'xz',
                corners: [
                    [cx + sqO, baseY, cz + sqO],
                    [cx + sqO + sq, baseY, cz + sqO],
                    [cx + sqO + sq, baseY, cz + sqO + sq],
                    [cx + sqO, baseY, cz + sqO + sq],
                ],
            },
            {
                axis: 'xy',
                corners: [
                    [cx + sqO, cy + sqO, cz],
                    [cx + sqO + sq, cy + sqO, cz],
                    [cx + sqO + sq, cy + sqO + sq, cz],
                    [cx + sqO, cy + sqO + sq, cz],
                ],
            },
            {
                axis: 'yz',
                corners: [
                    [cx, cy + sqO, cz + sqO],
                    [cx, cy + sqO, cz + sqO + sq],
                    [cx, cy + sqO + sq, cz + sqO + sq],
                    [cx, cy + sqO + sq, cz + sqO],
                ],
            },
        ];
        let planeBest: Exclude<TransformAxis, null> | null = null;
        let planeBestDist = Infinity;
        for (const plane of planeSquares) {
            const ss = plane.corners.map((c) => renderer.projectToScreen(c[0], c[1], c[2], canvas.width, canvas.height));
            if (ss.some((p) => !p)) continue;
            const pts = ss as [number, number][];
            const scx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) * 0.25;
            const scy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) * 0.25;
            let sign = 0,
                inside = true;
            for (let i = 0; i < 4 && inside; i++) {
                const ax2 = pts[i][0],
                    ay2 = pts[i][1];
                const bx2 = pts[(i + 1) % 4][0],
                    by2 = pts[(i + 1) % 4][1];
                const cross = (bx2 - ax2) * (py - ay2) - (by2 - ay2) * (px - ax2);
                if (Math.abs(cross) < 0.5) continue;
                const s = cross > 0 ? 1 : -1;
                if (!sign) sign = s;
                else if (s !== sign) inside = false;
            }
            let dist: number;
            if (inside) {
                dist = 0;
            } else {
                const mnX = Math.min(pts[0][0], pts[1][0], pts[2][0], pts[3][0]);
                const mxX = Math.max(pts[0][0], pts[1][0], pts[2][0], pts[3][0]);
                const mnY = Math.min(pts[0][1], pts[1][1], pts[2][1], pts[3][1]);
                const mxY = Math.max(pts[0][1], pts[1][1], pts[2][1], pts[3][1]);
                if (px < mnX - planeMargin || px > mxX + planeMargin || py < mnY - planeMargin || py > mxY + planeMargin)
                    continue;
                dist = Math.hypot(px - scx, py - scy);
            }
            if (dist < planeBestDist) {
                planeBestDist = dist;
                planeBest = plane.axis;
            }
        }

        if (planeBest !== null && planeBestDist === 0) return planeBest;
        if (bestDist <= hitRadius && (planeBest === null || bestDist < planeBestDist)) return best;
        if (planeBest !== null) return planeBest;
        return null;
    }

    function updateTransformGizmo(): void {
        const sm = selectedModel();
        const pb = !sm ? colliderBodies.find((b) => b.id === selectedColliderBodyId) : null;
        const partSelection = selectedPart();
        const partOverride = partSelection ? (sm?.partOverrides?.[partSelection.part.meshId] ?? defaultPartOverride()) : null;
        const gizmoPos: [number, number, number] | null = pb
            ? pb.position
            : sm
              ? partSelection && partOverride
                  ? [
                        sm.position[0] + partSelection.part.nodeMatrix[12] + partOverride.position[0],
                        sm.position[1] + partSelection.part.nodeMatrix[13] + partOverride.position[1],
                        sm.position[2] + partSelection.part.nodeMatrix[14] + partOverride.position[2],
                    ]
                  : sm.position
              : null;
        renderer.setRotateRing(null);
        renderer.setTransformGizmo(
            gizmoPos
                ? {
                      pos: gizmoPos,
                      radius: pb ? 2.0 : selectedGizmoRadius(sm!),
                      mode: transformState?.colliderBodyId
                          ? transformState.mode
                          : transformState !== null && transformState.modelId === sm?.id
                            ? transformState.mode
                            : stickyGizmoMode,
                      axis: transformState?.colliderBodyId
                          ? transformState.axis
                          : transformState !== null && transformState.modelId === sm?.id
                            ? transformState.axis
                            : null,
                  }
                : null,
        );
    }

    function pointerAngleForModel(sm: SceneModel, e: { clientX: number; clientY: number }): number {
        const p = groundPointFromEvent(e);
        if (!p) return 0;
        const { centerX, centerZ } = rotateRingGeometry(sm.position, sceneModelToStableYawFootprint(sm));
        return (Math.atan2(p[2] - centerZ, p[0] - centerX) * 180) / Math.PI;
    }

    function pointerDistanceForModel(sm: SceneModel, e: { clientX: number; clientY: number }): number {
        const p = groundPointFromEvent(e);
        if (!p) return 1;
        const { centerX, centerZ } = rotateRingGeometry(sm.position, sceneModelToStableYawFootprint(sm));
        return Math.max(0.001, Math.hypot(p[0] - centerX, p[2] - centerZ));
    }

    function transformEventForModel(sm: SceneModel): { clientX: number; clientY: number } {
        if (lastMouseEvent) return lastMouseEvent;
        const rect = canvas.getBoundingClientRect();
        const projected = renderer.projectToScreen(sm.position[0], sm.position[1], sm.position[2], canvas.width, canvas.height);
        if (!projected) {
            return {
                clientX: rect.left + rect.width * 0.5,
                clientY: rect.top + rect.height * 0.5,
            };
        }
        const dprX = canvas.width / Math.max(1, rect.width);
        const dprY = canvas.height / Math.max(1, rect.height);
        return {
            clientX: rect.left + projected[0] / dprX,
            clientY: rect.top + projected[1] / dprY,
        };
    }

    function beginTransform(mode: TransformMode, axis: TransformAxis = null, source: TransformState['source'] = 'hotkey'): void {
        const sm = selectedModel();
        const pb = !sm ? colliderBodies.find((b) => b.id === selectedColliderBodyId) : null;
        if (!sm && !pb) return;
        if (!transformState && !skipNextTransformHistoryPush) pushHistory();
        skipNextTransformHistoryPush = false;

        if (pb) {
            const startEvent =
                lastMouseEvent ??
                (() => {
                    const rect = canvas.getBoundingClientRect();
                    const projected = renderer.projectToScreen(
                        pb.position[0],
                        pb.position[1],
                        pb.position[2],
                        canvas.width,
                        canvas.height,
                    );
                    if (!projected) return { clientX: rect.left + rect.width * 0.5, clientY: rect.top + rect.height * 0.5 };
                    const dprX = canvas.width / Math.max(1, rect.width);
                    const dprY = canvas.height / Math.max(1, rect.height);
                    return { clientX: rect.left + projected[0] / dprX, clientY: rect.top + projected[1] / dprY };
                })();
            const startGround: [number, number, number] =
                axis === 'xy'
                    ? (axisPlanePointFromEvent(startEvent, 'z', pb.position[2]) ?? [...pb.position])
                    : axis === 'yz'
                      ? (axisPlanePointFromEvent(startEvent, 'x', pb.position[0]) ?? [...pb.position])
                      : (groundPointFromEvent(startEvent) ?? [pb.position[0], 0, pb.position[2]]);
            const p = groundPointFromEvent(startEvent);
            renderer.setHoverSnap(null);
            orbitCtrl.onPointerUp();
            transformState = {
                mode,
                axis,
                source,
                modelId: pb.id,
                colliderBodyId: pb.id,
                startPosition: [...pb.position],
                startRotation: [...pb.rotation],
                startScale: [...pb.scale],
                startGround,
                startAngle: p ? (Math.atan2(p[2] - pb.position[2], p[0] - pb.position[0]) * 180) / Math.PI : 0,
                startDistance: p ? Math.max(0.001, Math.hypot(p[0] - pb.position[0], p[2] - pb.position[2])) : 1,
                startClientX: startEvent.clientX,
                startClientY: startEvent.clientY,
            };
            updateTransformGizmo();
            return;
        }

        const partSelection = selectedPart();
        const partOverride = partSelection ? ensurePartOverride(sm!, partSelection.part.meshId) : null;
        const startEvent = transformEventForModel(sm!);
        const startGround: [number, number, number] =
            axis === 'xy'
                ? (axisPlanePointFromEvent(startEvent, 'z', sm!.position[2]) ?? [
                      sm!.position[0],
                      sm!.position[1],
                      sm!.position[2],
                  ])
                : axis === 'yz'
                  ? (axisPlanePointFromEvent(startEvent, 'x', sm!.position[0]) ?? [
                        sm!.position[0],
                        sm!.position[1],
                        sm!.position[2],
                    ])
                  : (groundPointFromEvent(startEvent) ?? [sm!.position[0], 0, sm!.position[2]]);
        renderer.setHoverSnap(null);
        orbitCtrl.onPointerUp();
        transformState = {
            mode,
            axis,
            source,
            modelId: sm!.id,
            partMeshId: partSelection?.part.meshId,
            startPosition: partOverride ? [...partOverride.position] : [...sm!.position],
            startRotation: partOverride ? [...partOverride.rotation] : [...sm!.rotation],
            startScale: partOverride ? [...partOverride.scale] : [...sm!.scale],
            startGround,
            startAngle: pointerAngleForModel(sm!, startEvent),
            startDistance: pointerDistanceForModel(sm!, startEvent),
            startClientX: startEvent.clientX,
            startClientY: startEvent.clientY,
        };
        updateTransformGizmo();
    }

    function cancelTransform(): void {
        if (!transformState) return;
        if (transformState.colliderBodyId) {
            const pb = colliderBodies.find((b) => b.id === transformState!.colliderBodyId);
            if (pb) {
                pb.position = [...transformState.startPosition];
                pb.rotation = [...transformState.startRotation];
                pb.scale = [...transformState.startScale];
            }
        } else {
            const sm = sceneModels.find((m) => m.id === transformState?.modelId);
            if (sm) {
                if (transformState.partMeshId) {
                    const override = ensurePartOverride(sm, transformState.partMeshId);
                    override.position = [...transformState.startPosition];
                    override.rotation = [...transformState.startRotation];
                    override.scale = [...transformState.startScale];
                } else {
                    sm.position = [...transformState.startPosition];
                    sm.rotation = [...transformState.startRotation];
                    sm.scale = [...transformState.startScale];
                }
            }
        }
        transformState = null;
        rebuildInstances();
    }

    function confirmTransform(): void {
        if (!transformState) return;
        transformState = null;
        updateTransformGizmo();
        rebuildInstances();
    }

    function setTransformAxis(axis: Exclude<TransformAxis, null>): void {
        if (!transformState) return;
        transformState.axis = transformState.axis === axis ? null : axis;
        updateTransformGizmo();
    }

    function updateActiveTransform(e: { clientX: number; clientY: number; ctrlKey: boolean }): void {
        if (!transformState) return;
        const snap = e.ctrlKey;
        const snapPos = (v: number) => (snap ? Math.round(v) : v);
        const snapRot = (start: number, delta: number) => (snap ? snapDegrees(start + delta, 15) : start + delta);
        const snapScale = (v: number) => (snap ? Math.max(0.25, Math.round(v * 4) / 4) : Math.max(0.01, v));

        if (transformState.colliderBodyId) {
            const pb = colliderBodies.find((b) => b.id === transformState!.colliderBodyId);
            if (!pb) return;
            if (transformState.mode === 'translate') {
                if (!transformState.startGround) return;
                pb.position = [...transformState.startPosition];
                if (transformState.axis === 'xy') {
                    const p = axisPlanePointFromEvent(e, 'z', transformState.startGround[2]);
                    if (!p) return;
                    pb.position[0] = snapPos(transformState.startPosition[0] + p[0] - transformState.startGround[0]);
                    pb.position[1] = snapPos(transformState.startPosition[1] + p[1] - transformState.startGround[1]);
                } else if (transformState.axis === 'yz') {
                    const p = axisPlanePointFromEvent(e, 'x', transformState.startGround[0]);
                    if (!p) return;
                    pb.position[1] = snapPos(transformState.startPosition[1] + p[1] - transformState.startGround[1]);
                    pb.position[2] = snapPos(transformState.startPosition[2] + p[2] - transformState.startGround[2]);
                } else {
                    const p = groundPointFromEvent(e);
                    if (!p || !transformState.startGround) return;
                    const dx = p[0] - transformState.startGround[0];
                    const dz = p[2] - transformState.startGround[2];
                    const dy = -(e.clientY - transformState.startClientY) * 0.03;
                    if (transformState.axis === 'x') pb.position[0] = snapPos(transformState.startPosition[0] + dx);
                    else if (transformState.axis === 'y') pb.position[1] = snapPos(transformState.startPosition[1] + dy);
                    else if (transformState.axis === 'z') pb.position[2] = snapPos(transformState.startPosition[2] + dz);
                    else {
                        pb.position[0] = snapPos(transformState.startPosition[0] + dx);
                        pb.position[2] = snapPos(transformState.startPosition[2] + dz);
                    }
                }
            } else if (transformState.mode === 'rotate') {
                const p = groundPointFromEvent(e);
                const pointerAngle = p ? (Math.atan2(p[2] - pb.position[2], p[0] - pb.position[0]) * 180) / Math.PI : 0;
                const delta = -angleDeltaDeg(transformState.startAngle, pointerAngle);
                pb.rotation = [...transformState.startRotation];
                if (transformState.axis === 'x') pb.rotation[0] = snapRot(transformState.startRotation[0], delta);
                else if (transformState.axis === 'z') pb.rotation[2] = snapRot(transformState.startRotation[2], delta);
                else pb.rotation[1] = snapRot(transformState.startRotation[1], delta);
            } else {
                const p = groundPointFromEvent(e);
                const dist = p ? Math.max(0.001, Math.hypot(p[0] - pb.position[0], p[2] - pb.position[2])) : 1;
                const factor = Math.max(0.05, dist / transformState.startDistance);
                pb.scale = [...transformState.startScale];
                if (transformState.axis === null) {
                    pb.scale = transformState.startScale.map((s) => snapScale(s * factor)) as [number, number, number];
                } else if (transformState.axis === 'xz') {
                    pb.scale[0] = snapScale(transformState.startScale[0] * factor);
                    pb.scale[2] = snapScale(transformState.startScale[2] * factor);
                } else if (transformState.axis === 'xy') {
                    pb.scale[0] = snapScale(transformState.startScale[0] * factor);
                    pb.scale[1] = snapScale(transformState.startScale[1] * factor);
                } else if (transformState.axis === 'yz') {
                    pb.scale[1] = snapScale(transformState.startScale[1] * factor);
                    pb.scale[2] = snapScale(transformState.startScale[2] * factor);
                } else {
                    const dx = p && transformState.startGround ? p[0] - transformState.startGround[0] : 0;
                    const dz = p && transformState.startGround ? p[2] - transformState.startGround[2] : 0;
                    const dy = -(e.clientY - transformState.startClientY) * 0.03;
                    if (transformState.axis === 'x') pb.scale[0] = snapScale(transformState.startScale[0] + dx * 0.1);
                    else if (transformState.axis === 'y') pb.scale[1] = snapScale(transformState.startScale[1] + dy * 0.1);
                    else pb.scale[2] = snapScale(transformState.startScale[2] + dz * 0.1);
                }
            }
            rebuildInstances();
            return;
        }

        const sm = sceneModels.find((m) => m.id === transformState?.modelId);
        if (!sm) return;
        const target = transformState.partMeshId ? ensurePartOverride(sm, transformState.partMeshId) : sm;

        if (transformState.mode === 'translate') {
            if (!transformState.startGround) return;
            target.position = [...transformState.startPosition];
            if (transformState.axis === 'xy') {
                const p = axisPlanePointFromEvent(e, 'z', transformState.startGround[2]);
                if (!p) return;
                target.position[0] = snapPos(transformState.startPosition[0] + p[0] - transformState.startGround[0]);
                target.position[1] = snapPos(transformState.startPosition[1] + p[1] - transformState.startGround[1]);
            } else if (transformState.axis === 'yz') {
                const p = axisPlanePointFromEvent(e, 'x', transformState.startGround[0]);
                if (!p) return;
                target.position[1] = snapPos(transformState.startPosition[1] + p[1] - transformState.startGround[1]);
                target.position[2] = snapPos(transformState.startPosition[2] + p[2] - transformState.startGround[2]);
            } else {
                const p = groundPointFromEvent(e);
                if (!p || !transformState.startGround) return;
                const dx = p[0] - transformState.startGround[0];
                const dz = p[2] - transformState.startGround[2];
                const dy = -(e.clientY - transformState.startClientY) * 0.03;
                if (transformState.axis === 'x') target.position[0] = snapPos(transformState.startPosition[0] + dx);
                else if (transformState.axis === 'y') target.position[1] = snapPos(transformState.startPosition[1] + dy);
                else if (transformState.axis === 'z') target.position[2] = snapPos(transformState.startPosition[2] + dz);
                else {
                    target.position[0] = snapPos(transformState.startPosition[0] + dx);
                    target.position[2] = snapPos(transformState.startPosition[2] + dz);
                }
            }
        } else if (transformState.mode === 'rotate') {
            const pointerAngle = pointerAngleForModel(sm, e);
            const delta = -angleDeltaDeg(transformState.startAngle, pointerAngle);
            target.rotation = [...transformState.startRotation];
            if (transformState.axis === 'x') target.rotation[0] = snapRot(transformState.startRotation[0], delta);
            else if (transformState.axis === 'z') target.rotation[2] = snapRot(transformState.startRotation[2], delta);
            else target.rotation[1] = snapRot(transformState.startRotation[1], delta);
        } else {
            const dist = pointerDistanceForModel(sm, e);
            target.scale = [...transformState.startScale];
            const factor = Math.max(0.05, dist / transformState.startDistance);
            if (transformState.axis === null) {
                target.scale = transformState.startScale.map((s) => snapScale(s * factor)) as [number, number, number];
            } else if (transformState.axis === 'xz') {
                target.scale[0] = snapScale(transformState.startScale[0] * factor);
                target.scale[2] = snapScale(transformState.startScale[2] * factor);
            } else if (transformState.axis === 'xy') {
                target.scale[0] = snapScale(transformState.startScale[0] * factor);
                target.scale[1] = snapScale(transformState.startScale[1] * factor);
            } else if (transformState.axis === 'yz') {
                target.scale[1] = snapScale(transformState.startScale[1] * factor);
                target.scale[2] = snapScale(transformState.startScale[2] * factor);
            } else {
                const p = groundPointFromEvent(e);
                const dx = p && transformState.startGround ? p[0] - transformState.startGround[0] : 0;
                const dz = p && transformState.startGround ? p[2] - transformState.startGround[2] : 0;
                const dy = -(e.clientY - transformState.startClientY) * 0.03;
                if (transformState.axis === 'x') target.scale[0] = snapScale(transformState.startScale[0] + dx * 0.1);
                else if (transformState.axis === 'y') target.scale[1] = snapScale(transformState.startScale[1] + dy * 0.1);
                else target.scale[2] = snapScale(transformState.startScale[2] + dz * 0.1);
            }
        }

        rebuildInstances();
    }

    // ---- Selection / transform hotkeys -------------------------------------

    canvas.addEventListener(
        'mousedown',
        (e) => {
            lastMouseEvent = e;
            mouseDownX = e.clientX;
            mouseDownY = e.clientY;
            if (transformState && e.button === 0) {
                confirmTransform();
                suppressNextClick = true;
                e.preventDefault();
                e.stopImmediatePropagation();
                return;
            }
            if (e.button === 0 && !isDraggingFromSidebar && stickyGizmoMode !== 'rotate') {
                const axis = gizmoAxisHitFromEvent(e);
                if (axis) {
                    beginTransform(stickyGizmoMode, axis, 'gizmo');
                    suppressNextClick = true;
                    e.preventDefault();
                    e.stopImmediatePropagation();
                }
            }
        },
        true,
    );

    canvas.addEventListener('mouseup', (e) => {
        lastMouseEvent = e;
        if (transformState?.source === 'gizmo') {
            confirmTransform();
            suppressNextClick = false;
            return;
        }
        if (suppressNextClick) {
            suppressNextClick = false;
            return;
        }
        if (isDraggingFromSidebar || transformState) return;
        const dx = e.clientX - mouseDownX,
            dy = e.clientY - mouseDownY;
        if (dx * dx + dy * dy > 25) return; // drag, not click
        handleCanvasClick(e);
    });

    canvas.addEventListener('mousemove', (e) => {
        lastMouseEvent = e;
        updateActiveTransform(e);
    });

    window.addEventListener(
        'mousemove',
        (e) => {
            lastMouseEvent = e;
            if (transformState) {
                updateActiveTransform(e);
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        },
        true,
    );

    window.addEventListener(
        'mouseup',
        (e) => {
            if (!transformState) return;
            if (transformState.source === 'gizmo') {
                confirmTransform();
                suppressNextClick = true;
            }
            orbitCtrl.onPointerUp();
            e.preventDefault();
            e.stopImmediatePropagation();
        },
        true,
    );

    canvas.addEventListener(
        'wheel',
        (e) => {
            if (!transformState) return;
            e.preventDefault();
            e.stopImmediatePropagation();
        },
        { capture: true, passive: false },
    );

    canvas.addEventListener('mouseleave', () => {
        if (!isDraggingFromSidebar) renderer.setHoverSnap(null);
    });

    function handleCanvasClick(e: MouseEvent): void {
        const hit = renderer.pick(e);
        if (hit) {
            const instanceId = hit.nodeId;
            const sm = sceneModels.find((model) => instanceId.startsWith(`${model.id}:`));
            if (sm) {
                if (sm.id !== selectedModelId) stickyGizmoMode = 'translate';
                selectedModelId = sm.id;
                selectedInstanceId = instanceId;
                selectedColliderBodyId = null;
                transformState = null;
                renderer.setHoverSnap(null);
                rebuildInstances();
                return;
            }
        }

        const rect = canvas.getBoundingClientRect();
        const ray = get_orbit_camera_pick_ray(orbit, e.clientX, e.clientY, rect, canvas.width, canvas.height, FOV_Y);
        if (!ray) return;
        const { origin: o, direction: d } = ray;

        let closestModel: SceneModel | null = null;
        let closestModelT = Infinity;
        for (const sm of sceneModels) {
            if (!sm.meshBounds) continue;
            const m = buildModelMatrix(sm.position, sm.rotation, sm.scale);
            const box = computeWorldAABB(sm.meshBounds, m);
            const t = rayHitsAABB(o[0], o[1], o[2], d[0], d[1], d[2], box);
            if (t !== null && t < closestModelT) {
                closestModelT = t;
                closestModel = sm;
            }
        }

        let closestBody: ColliderBodyEntry | null = null;
        let closestBodyT = Infinity;
        for (const pb of colliderBodies) {
            const [sx, sy, sz] = [Math.abs(pb.scale[0]), Math.abs(pb.scale[1]), Math.abs(pb.scale[2])];
            let box: AABB;
            if (pb.colliderShape === 'sphere') {
                const r = pb.radius * Math.max(sx, sy, sz);
                box = {
                    minX: pb.position[0] - r,
                    maxX: pb.position[0] + r,
                    minY: pb.position[1] - r,
                    maxY: pb.position[1] + r,
                    minZ: pb.position[2] - r,
                    maxZ: pb.position[2] + r,
                };
            } else {
                const hx = (pb.length / 2) * sx,
                    hy = (pb.height / 2) * sy,
                    hz = (pb.width / 2) * sz;
                box = {
                    minX: pb.position[0] - hx,
                    maxX: pb.position[0] + hx,
                    minY: pb.position[1] - hy,
                    maxY: pb.position[1] + hy,
                    minZ: pb.position[2] - hz,
                    maxZ: pb.position[2] + hz,
                };
            }
            const t = rayHitsAABB(o[0], o[1], o[2], d[0], d[1], d[2], box);
            if (t !== null && t < closestBodyT) {
                closestBodyT = t;
                closestBody = pb;
            }
        }

        if (closestBody && closestBodyT <= closestModelT) {
            const willSelect = closestBody.id !== selectedColliderBodyId;
            selectColliderBody(willSelect ? closestBody.id : null);
            renderer.setHoverSnap(null);
            return;
        }

        if (closestModel) {
            const willSelect = selectedModelId !== closestModel.id;
            if (willSelect) stickyGizmoMode = 'translate';
            selectedModelId = willSelect ? closestModel.id : null;
            selectedInstanceId = null;
            selectedColliderBodyId = null;
            transformState = null;
            rebuildInstances();
            renderer.setHoverSnap(null);
            return;
        } else {
            selectedModelId = null;
            selectedInstanceId = null;
            selectedColliderBodyId = null;
            transformState = null;
        }
        rebuildInstances();
        renderer.setHoverSnap(null);
    }

    window.addEventListener('keydown', (e) => {
        if (isEditableTarget(e.target)) return;
        const key = e.key.toLowerCase();
        if (key === 'delete' || key === 'backspace') {
            if (deleteSelectedModel() || deleteSelectedColliderBody()) {
                e.preventDefault();
            }
        } else if (key === 'd' && e.shiftKey) {
            if (cloneSelectedModel()) {
                e.preventDefault();
            }
        } else if (key === 'escape') {
            if (transformState) {
                cancelTransform();
                e.preventDefault();
                return;
            }
            selectedModelId = null;
            transformState = null;
            renderer.setHoverSnap(null);
            rebuildInstances();
        } else if (key === 'enter') {
            confirmTransform();
            e.preventDefault();
        } else if (key === 'g') {
            stickyGizmoMode = 'translate';
            beginTransform('translate');
            e.preventDefault();
        } else if (key === 'r') {
            stickyGizmoMode = 'rotate';
            beginTransform('rotate');
            e.preventDefault();
        } else if (key === 's') {
            stickyGizmoMode = 'scale';
            beginTransform('scale');
            e.preventDefault();
        } else if (key === 'w') {
            renderer.toggleWireframe();
            e.preventDefault();
        } else if (key === 'c') {
            renderer.toggleColliderOverlay();
            e.preventDefault();
        } else if (key === 'z' && e.ctrlKey) {
            if (e.shiftKey) redo();
            else undo();
            e.preventDefault();
        } else if (key === 'y' && e.ctrlKey) {
            redo();
            e.preventDefault();
        } else if (key === 'x' || key === 'y' || key === 'z') {
            setTransformAxis(key);
            e.preventDefault();
        }
    });

    // ---- Canvas drop target ------------------------------------------------

    canvas.addEventListener('dragenter', (e) => {
        if (e.dataTransfer?.types.includes('text/plain')) {
            isDraggingFromSidebar = true;
            e.preventDefault();
            dropOverlay.classList.add('active');
        }
    });

    canvas.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'copy';
        const pos = groundSnapFromEvent(e);
        renderer.setHoverSnap(pos ? { pos, footprint: dragFootprint } : null);
    });

    canvas.addEventListener('dragleave', (e) => {
        if (!viewportWrap.contains(e.relatedTarget as Node | null)) {
            isDraggingFromSidebar = false;
            dropOverlay.classList.remove('active');
            renderer.setHoverSnap(null);
        }
    });

    async function placeModelFromPayload(payload: string, pos: [number, number, number]): Promise<void> {
        pushHistory();
        if (payload.startsWith('multi:')) {
            const [, fileName, childIndexStr] = payload.split(':');
            const childIndex = Number(childIndexStr);
            const loadedModel = await ensureModelLoaded(fileName, true);
            if (!loadedModel) return;
            sceneModels.push({
                id: `sm:${sceneModelCounter++}`,
                fileName,
                isMulti: true,
                childIndex,
                position: pos,
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
                loadedModel,
                partPrefix: `mesh:${fileName}:${childIndex}`,
                meshBounds: boundsCache.get(`multi:${fileName}:${childIndex}`) ?? null,
            });
        } else {
            const fileName = payload.startsWith('model:') ? payload.slice(6) : payload;
            const loadedModel = await ensureModelLoaded(fileName);
            if (!loadedModel) return;
            const uvSpec: UvSpec | undefined = isPrimitiveShape(fileName) ? { u: 1, v: 1, tileSize: 16 } : undefined;
            sceneModels.push({
                id: `sm:${sceneModelCounter++}`,
                fileName,
                isMulti: false,
                position: pos,
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
                loadedModel,
                meshBounds: boundsCache.get(`model:${fileName}`) ?? null,
                uvSpec,
            });
            const newSm = sceneModels[sceneModels.length - 1];
            if (newSm && uvSpec) rebuildPrimitiveUvMesh(newSm);
        }
        const newSm = sceneModels[sceneModels.length - 1];
        if (newSm) {
            selectedModelId = newSm.id;
            selectedInstanceId = null;
        }
        rebuildInstances();
    }

    canvas.addEventListener('drop', async (e) => {
        e.preventDefault();
        isDraggingFromSidebar = false;
        dropOverlay.classList.remove('active');
        renderer.setHoverSnap(null);
        const payload = e.dataTransfer?.getData('text/plain')?.trim();
        if (!payload) return;
        const pos: [number, number, number] = groundSnapFromEvent(e) ?? [0, 0, 0];
        await placeModelFromPayload(payload, pos);
    });

    viewportWrap.addEventListener('dragleave', (e) => {
        if (!viewportWrap.contains(e.relatedTarget as Node | null)) {
            dropOverlay.classList.remove('active');
        }
    });

    // ---- Axis labels -------------------------------------------------------

    const axisLabels: Array<{ el: HTMLElement; x: number; y: number; z: number }> = [
        { el: document.getElementById('axis-px')!, x: 22, y: 0.4, z: 0 },
        { el: document.getElementById('axis-nx')!, x: -22, y: 0.4, z: 0 },
        { el: document.getElementById('axis-pz')!, x: 0, y: 0.4, z: 22 },
        { el: document.getElementById('axis-nz')!, x: 0, y: 0.4, z: -22 },
    ];

    function updateAxisLabels(): void {
        const dpr = Math.min(devicePixelRatio, 2);
        for (const { el, x, y, z } of axisLabels) {
            const p = renderer.projectToScreen(x, y, z, canvas.width, canvas.height);
            if (p) {
                el.style.left = `${p[0] / dpr}px`;
                el.style.top = `${p[1] / dpr}px`;
                el.style.display = '';
            } else {
                el.style.display = 'none';
            }
        }
    }

    // ---- Render loop -------------------------------------------------------

    const FOV_Y = Math.PI / 3;
    let lastTime = performance.now();

    function loop(now: number): void {
        const dt = Math.min(0.1, (now - lastTime) / 1000);
        lastTime = now;
        orbitCtrl.update(dt);
        renderer.resize();
        renderer.setColliderShapes(buildColliderOverlayShapes(colliderBodies));
        const eye = orbit.getEye();
        renderer.render(eye[0], eye[1], eye[2], orbit.target[0], orbit.target[1], orbit.target[2], FOV_Y, 0.1, 500);
        updateAxisLabels();
        requestAnimationFrame(loop);
    }

    requestAnimationFrame(loop);

    void refreshBlueprintSaveList();
}

main().catch(console.error);
