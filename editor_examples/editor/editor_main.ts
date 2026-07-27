import { get_orbit_camera_pick_ray, install_orbit_camera_controls, OrbitCamera, OrbitCameraController } from '../core/camera';
import type { LoadedBlueprint } from '../core/game';
import { isPrimitiveShape, type PrimitiveSpec } from '../core/primitives';
import {
    createPrimitiveUvAtlasTransform,
    findFirstMeshNodePath,
    type PrimitiveUvAtlasTransform,
    remapPrimitiveNodeUvs,
} from '../core/uv_remap';
import { load_model_blueprint } from '../blueprints/load_model_blueprint';
import { buildLocalMeshFromMeshAsset, buildMeshAssetFromPicoNode } from '../mesh';
import { buildTextureRGBA, computeGraphBounds, type MeshBounds, parsePicoCad2, type PicoCad2Node } from '../picocad2';
import { makePicoModelMirrorMatrix } from '../scene';
import {
    isPicoCadPaletteId,
    picoCadPaletteOverride,
    picoCadPalettes,
    type PicoCadPaletteId,
} from '../palettes/picocad_palettes';
import { isTextureAssetId, textureAssetOverride, textureAssets } from '../textures/texture_assets';
import type { StageDefinition, StageObjectDefinition } from '../stages/stage';
import {
    type ColliderOverlayBody,
    EditorRenderer,
    type PlacedInstance,
    type TransformAxis,
    type TransformMode,
} from './editor_game_renderer';
import {
    angleDeltaDeg,
    boundsToFootprint,
    buildModelMatrix,
    computeWorldAABB,
    findNodeByMeshId,
    formatInspectorNumber,
    formatNumber,
    identityMatrix,
    isEditableTarget,
    meshIdToPath,
    multiplyMat4,
    outlinerNodeName,
    parseInspectorNumber,
    rayHitsAABB,
    rotateRingGeometry,
    rotateScaledLocalOffset,
    screenDistanceToSegment,
    snapDegrees,
} from './editor_math';
import {
    cloneCamera,
    type SaveData,
    type SavedEditorCamera,
    type SaveObject,
    type SaveObjectUvOverride,
    sanitizeCamera,
} from './editor_scene_save';

// ---------------------------------------------------------------------------
// Blueprint discovery
// ---------------------------------------------------------------------------

type BlueprintModule = Record<string, unknown>;
type StageModule = Record<string, unknown>;

const BLUEPRINT_FILES = import.meta.glob('../blueprints/blu_*.ts') as Record<string, () => Promise<BlueprintModule>>;
const STAGE_FILES = import.meta.glob('../stages/stg_*.ts') as Record<string, () => Promise<StageModule>>;

const MODEL_FILES = import.meta.glob(
    ['../assets/models/*.txt', '../assets/primitives/*.txt', '!../assets/models/*-anim-*.txt', '!../assets/primitives/*-anim-*.txt'],
    { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;

function nameFromPath(path: string): string {
    return path.split('/').pop()?.replace(/\.(ts|txt)$/, '') ?? path;
}

// Straight-model placements are keyed "model:<name>" everywhere a blueprint
// name is expected (SceneModel.blueprintName, save files, bounds cache), so
// the two kinds share one placement/save/export pipeline.
const MODEL_KEY_PREFIX = 'model:';

function modelNameFromKey(key: string): string | null {
    return key.startsWith(MODEL_KEY_PREFIX) ? key.slice(MODEL_KEY_PREFIX.length) : null;
}

type TransformState = {
    mode: TransformMode;
    axis: TransformAxis;
    source: 'hotkey' | 'gizmo';
    modelId: string;
    startPosition: [number, number, number];
    startRotation: [number, number, number];
    startScale: [number, number, number];
    startGround: [number, number, number] | null;
    startAngle: number;
    startDistance: number;
    startClientX: number;
    startClientY: number;
};

function picoNodeTransformToEditorMatrix(node: PicoCad2Node): Float32Array {
    const transform = node.transform;
    if (!transform) return identityMatrix();
    const pos = transform.pos;
    const rot = transform.rot;
    const scale = transform.scale;
    return buildModelMatrix(
        [pos?.x ?? 0, pos?.y ?? 0, pos?.z ?? 0],
        [((rot?.x ?? 0) * 180) / Math.PI, ((rot?.y ?? 0) * 180) / Math.PI, ((rot?.z ?? 0) * 180) / Math.PI],
        [scale?.x ?? 1, scale?.y ?? 1, scale?.z ?? 1],
    );
}

// ---------------------------------------------------------------------------
// Mesh helpers
// ---------------------------------------------------------------------------

type ModelMeshPart = {
    meshId: string;
    localMatrix: Float32Array;
    uvAtlasTransform?: PrimitiveUvAtlasTransform;
};

function collectMeshParts(
    node: PicoCad2Node,
    modelId: string,
    path: number[],
    parentMatrix: Float32Array,
    out: ModelMeshPart[],
): void {
    const localMatrix = multiplyMat4(parentMatrix, picoNodeTransformToEditorMatrix(node));

    if (node.mesh?.vertices?.length && node.mesh.faces?.length) {
        const meshId = path.length === 0 ? `mesh:${modelId}:root` : `mesh:${modelId}:${path.join('/')}`;
        const nodePrimitive = (node as { primitive?: PrimitiveSpec }).primitive;
        const uvAtlasTransform =
            nodePrimitive && ((nodePrimitive.repeatU ?? 1) !== 1 || (nodePrimitive.repeatV ?? 1) !== 1)
                ? createPrimitiveUvAtlasTransform(nodePrimitive)
                : undefined;
        out.push({ meshId, localMatrix, uvAtlasTransform });
    }

    for (const [i, child] of (node.children ?? []).entries()) {
        collectMeshParts(child, modelId, [...path, i], localMatrix, out);
    }
}

// ---------------------------------------------------------------------------
// Loaded model cache
// ---------------------------------------------------------------------------

type LoadedModel = {
    parts: ModelMeshPart[];
    materialId: string;
    blueprint: LoadedBlueprint;
    textureData: ReturnType<typeof buildTextureRGBA>;
    textureImageData: ImageData | null;
};

// ---------------------------------------------------------------------------
// Scene model
// ---------------------------------------------------------------------------

type SceneModel = {
    id: string;
    blueprintName: string;
    customName?: string;
    position: [number, number, number];
    rotation: [number, number, number]; // euler degrees XYZ (Ry*Rx*Rz order)
    scale: [number, number, number];
    loadedModel: LoadedModel;
    meshBounds: MeshBounds | null;
    uvOverride?: SaveObjectUvOverride;
    uvRootPart?: ModelMeshPart;
    paletteOverride?: PicoCadPaletteId;
    textureOverride?: string;
    overrideMaterialId?: string;
};

type SceneSnapshot = Array<{
    id: string;
    blueprintName: string;
    customName?: string;
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
    uvOverride?: SaveObjectUvOverride;
    paletteOverride?: PicoCadPaletteId;
    textureOverride?: string;
}>;

function sceneModelToInstances(sm: SceneModel, isSelected: boolean, selectedInstanceId: string | null): PlacedInstance[] {
    const base = buildModelMatrix(sm.position, sm.rotation, sm.scale);
    const parts = sm.uvRootPart ? [sm.uvRootPart, ...sm.loadedModel.parts.slice(1)] : sm.loadedModel.parts;
    const materialId = sm.overrideMaterialId ?? sm.loadedModel.materialId;

    return parts.map((part, pi) => ({
        id: `${sm.id}:${pi}`,
        meshId: part.meshId,
        materialId,
        worldMatrix: multiplyMat4(base, part.localMatrix),
        selected: selectedInstanceId ? `${sm.id}:${pi}` === selectedInstanceId : isSelected,
        uvAtlasTransform: part.uvAtlasTransform,
    }));
}

function sceneModelToStableYawFootprint(sm: SceneModel): [number, number, number, number] {
    if (!sm.meshBounds) return [-0.5, 0.5, -0.5, 0.5];
    const box = computeWorldAABB(sm.meshBounds, buildModelMatrix([0, 0, 0], [sm.rotation[0], 0, sm.rotation[2]], sm.scale));
    return [box.minX, box.maxX, box.minZ, box.maxZ];
}

function buildSceneColliderOverlayShapes(models: SceneModel[]): ColliderOverlayBody[] {
    const shapes: ColliderOverlayBody[] = [];
    for (const sm of models) {
        const collider = sm.loadedModel.blueprint.collider;
        if (!collider) continue;
        const off = collider.offset ?? [0, 0, 0];
        const rotatedOff = rotateScaledLocalOffset(sm.rotation, sm.scale, off);
        const adjustedPos: [number, number, number] = [
            sm.position[0] + rotatedOff[0],
            sm.position[1] + rotatedOff[1],
            sm.position[2] + rotatedOff[2],
        ];
        const [sx, sy, sz] = sm.scale;
        if (collider.shape === 'box') {
            const matrix = buildModelMatrix(adjustedPos, sm.rotation, sm.scale);
            shapes.push({
                shape: 'box',
                matrix,
                halfX: (collider.length ?? 1) / 2,
                halfY: (collider.height ?? 1) / 2,
                halfZ: (collider.width ?? collider.length ?? 1) / 2,
                radius: 0,
            });
        } else if (collider.shape === 'sphere') {
            const matrix = buildModelMatrix(adjustedPos, sm.rotation, [1, 1, 1]);
            const r = (collider.radius ?? 0.5) * Math.max(Math.abs(sx), Math.abs(sy), Math.abs(sz));
            shapes.push({ shape: 'sphere', matrix, halfX: 0, halfY: 0, halfZ: 0, radius: r });
        }
    }
    return shapes;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const initialParams = new URLSearchParams(window.location.search);
    const initialSaveFile = initialParams.get('file') ?? undefined;
    const initialCameraName = initialParams.get('camera') ?? undefined;
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
    let editorSaveSelect: HTMLSelectElement | null = null;
    let stageSelect: HTMLSelectElement | null = null;
    let cameraSelect: HTMLSelectElement | null = null;
    const savedCameras: SavedEditorCamera[] = [];
    let activeCameraName: string | null = null;
    let defaultCameraName: string | null = null;
    const undoStack: SceneSnapshot[] = [];
    const redoStack: SceneSnapshot[] = [];
    const MAX_HISTORY = 50;
    let inspectorPushModelId: string | null = null;
    let uvPushModelId: string | null = null;
    let skipNextTransformHistoryPush = false;
    const outlinerListEl = document.getElementById('outliner-list') as HTMLElement | null;
    const selectedNameEl = document.getElementById('selected-name') as HTMLElement | null;
    const selectedNameInput = document.getElementById('selected-name-input') as HTMLInputElement | null;
    const expandedOutlinerNodeIds = new Set<string>();
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
    let syncingInspector = false;
    for (const input of transformInputList) {
        input.addEventListener('input', applyInspectorTransform);
        input.addEventListener('change', applyInspectorTransform);
    }

    selectedNameInput?.addEventListener('input', () => {
        const sm = selectedModel();
        if (!sm) return;
        if (!inspectorPushModelId) {
            pushHistory();
            inspectorPushModelId = sm.id;
        }
        const next = selectedNameInput.value.trim();
        sm.customName = next || undefined;
        refreshInspector();
    });

    // ---- UV inspector -------------------------------------------------------

    const uvHeaderEl = document.getElementById('uv-header') as HTMLElement | null;
    const uvSectionEl = document.getElementById('uv-section') as HTMLElement | null;
    const uvCanvasEl = document.getElementById('uv-canvas') as HTMLCanvasElement | null;
    const uvInputs = {
        u: document.getElementById('uv-u') as HTMLInputElement | null,
        v: document.getElementById('uv-v') as HTMLInputElement | null,
        tileSize: document.getElementById('uv-tilesize') as HTMLInputElement | null,
        repeatU: document.getElementById('uv-repeatu') as HTMLInputElement | null,
        repeatV: document.getElementById('uv-repeatv') as HTMLInputElement | null,
    };
    const uvPaletteSelect = document.getElementById('uv-palette') as HTMLSelectElement | null;
    const uvTextureSelect = document.getElementById('uv-texture') as HTMLSelectElement | null;

    if (uvPaletteSelect) {
        uvPaletteSelect.replaceChildren();
        uvPaletteSelect.append(new Option('Model Palette', ''));
        for (const palette of Object.values(picoCadPalettes)) {
            uvPaletteSelect.append(new Option(palette.name, palette.id));
        }
    }

    if (uvTextureSelect) {
        uvTextureSelect.replaceChildren();
        uvTextureSelect.append(new Option('Model Texture', ''));
        for (const asset of textureAssets) {
            uvTextureSelect.append(new Option(asset.name, asset.id));
        }
    }

    function smHasUvControls(sm: SceneModel): boolean {
        return sm.loadedModel.parts.length > 0 && sm.loadedModel.textureImageData !== null;
    }

    function effectiveUv(sm: SceneModel): SaveObjectUvOverride {
        if (sm.uvOverride) return sm.uvOverride;
        const p = sm.loadedModel.blueprint.primitive;
        return { u: p?.u ?? 1, v: p?.v ?? 1, tileSize: p?.tileSize ?? 16, repeatU: p?.repeatU, repeatV: p?.repeatV };
    }

    function drawUvCanvas(sm: SceneModel | null): void {
        const canvas = uvCanvasEl;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const tex = sm ? textureImageDataForSceneModel(sm) : null;
        if (!tex) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }
        if (canvas.width !== tex.width || canvas.height !== tex.height) {
            canvas.width = tex.width;
            canvas.height = tex.height;
        }
        const uv = sm ? effectiveUv(sm) : { u: 1, v: 1, tileSize: 16 };
        const ts = Math.max(1, uv.tileSize);
        const tx = (uv.u - 1) * ts;
        const ty = (uv.v - 1) * ts;
        ctx.putImageData(tex, 0, 0);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(0, 0, tex.width, tex.height);
        ctx.putImageData(tex, 0, 0, tx, ty, ts, ts);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(tx + 0.5, ty + 0.5, ts - 1, ts - 1);
    }

    function overrideTextureForSceneModel(sm: SceneModel): ReturnType<typeof buildTextureRGBA> {
        const palette = sm.paletteOverride ? picoCadPaletteOverride(sm.paletteOverride) : undefined;
        const texture = sm.textureOverride ? textureAssetOverride(sm.textureOverride) : undefined;
        return buildTextureRGBA(sm.loadedModel.blueprint.data, palette, texture);
    }

    function textureImageDataForSceneModel(sm: SceneModel): ImageData | null {
        if (!sm.paletteOverride && !sm.textureOverride) return sm.loadedModel.textureImageData;
        try {
            const overrideTexture = overrideTextureForSceneModel(sm);
            return new ImageData(new Uint8ClampedArray(overrideTexture.rgbaPixels), overrideTexture.width, overrideTexture.height);
        } catch {
            return sm.loadedModel.textureImageData;
        }
    }

    function rebuildInstanceUvMesh(sm: SceneModel): void {
        const blueprint = sm.loadedModel.blueprint;
        const firstMeshPath = findFirstMeshNodePath(blueprint.node);
        if (!firstMeshPath) return;
        const meshId = firstMeshPath.length === 0 ? `mesh:${sm.blueprintName}:root` : `mesh:${sm.blueprintName}:${firstMeshPath.join('/')}`;
        const sourcePart = sm.loadedModel.parts.find((part) => part.meshId === meshId) ?? sm.loadedModel.parts[0];
        if (!sourcePart) return;
        const node = findNodeByMeshId(blueprint.node, sm.blueprintName, sourcePart.meshId);
        if (!node) return;
        const uv = effectiveUv(sm);
        const textureWidth = blueprint.data.texture?.width ?? 128;
        const remapped = remapPrimitiveNodeUvs(node, uv, textureWidth);
        const meshKey = `uvoverride:${sm.id}:u${uv.u}v${uv.v}t${uv.tileSize}r${uv.repeatU ?? 1}x${uv.repeatV ?? 1}`;
        const asset = buildMeshAssetFromPicoNode(remapped, meshKey, meshIdToPath(sourcePart.meshId, sm.blueprintName));
        if (!asset) return;
        renderer.addMesh(meshKey, buildLocalMeshFromMeshAsset(asset));
        const useRepeat = (uv.repeatU ?? 1) !== 1 || (uv.repeatV ?? 1) !== 1;
        const uvAtlasTransform = useRepeat ? createPrimitiveUvAtlasTransform(uv, textureWidth) : undefined;
        sm.uvRootPart = { meshId: meshKey, localMatrix: sourcePart.localMatrix, uvAtlasTransform };
    }

    function syncInspectorUvFields(sm: SceneModel | null): void {
        if (!sm || !smHasUvControls(sm)) {
            if (uvHeaderEl) uvHeaderEl.style.display = 'none';
            if (uvSectionEl) uvSectionEl.style.display = 'none';
            return;
        }
        if (uvHeaderEl) uvHeaderEl.style.display = '';
        if (uvSectionEl) uvSectionEl.style.display = '';
        const uv = effectiveUv(sm);
        syncingInspector = true;
        if (uvInputs.u) uvInputs.u.value = String(uv.u);
        if (uvInputs.v) uvInputs.v.value = String(uv.v);
        if (uvInputs.tileSize) uvInputs.tileSize.value = String(uv.tileSize);
        if (uvInputs.repeatU) uvInputs.repeatU.value = uv.repeatU !== undefined ? String(uv.repeatU) : '';
        if (uvInputs.repeatV) uvInputs.repeatV.value = uv.repeatV !== undefined ? String(uv.repeatV) : '';
        if (uvPaletteSelect) uvPaletteSelect.value = sm.paletteOverride ?? '';
        if (uvTextureSelect) uvTextureSelect.value = sm.textureOverride ?? '';
        syncingInspector = false;
        drawUvCanvas(sm);
    }

    function captureSnapshot(): SceneSnapshot {
        return sceneModels.map((sm) => ({
            id: sm.id,
            blueprintName: sm.blueprintName,
            customName: sm.customName,
            position: [...sm.position] as [number, number, number],
            rotation: [...sm.rotation] as [number, number, number],
            scale: [...sm.scale] as [number, number, number],
            uvOverride: sm.uvOverride ? { ...sm.uvOverride } : undefined,
            paletteOverride: sm.paletteOverride,
            textureOverride: sm.textureOverride,
        }));
    }

    function pushHistory(): void {
        undoStack.push(captureSnapshot());
        if (undoStack.length > MAX_HISTORY) undoStack.shift();
        redoStack.length = 0;
        inspectorPushModelId = null;
        uvPushModelId = null;
    }

    function restoreSnapshot(snapshot: SceneSnapshot): void {
        sceneModels.length = 0;
        for (const entry of snapshot) {
            const loadedModel = loadedModels.get(entry.blueprintName);
            if (!loadedModel) continue;
            const sm: SceneModel = {
                id: entry.id,
                blueprintName: entry.blueprintName,
                customName: entry.customName,
                position: [...entry.position] as [number, number, number],
                rotation: [...entry.rotation] as [number, number, number],
                scale: [...entry.scale] as [number, number, number],
                loadedModel,
                meshBounds: boundsCache.get(entry.blueprintName) ?? null,
                uvOverride: entry.uvOverride ? { ...entry.uvOverride } : undefined,
                paletteOverride: entry.paletteOverride,
                textureOverride: entry.textureOverride,
            };
            if (sm.uvOverride) rebuildInstanceUvMesh(sm);
            sceneModels.push(sm);
        }
        selectedModelId = null;
        selectedInstanceId = null;
        transformState = null;
        inspectorPushModelId = null;
        uvPushModelId = null;
        rebuildInstances();
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

    function applyUvFromInputs(): void {
        if (syncingInspector) return;
        const sm = selectedModel();
        if (!sm || !smHasUvControls(sm)) return;
        if (sm.id !== uvPushModelId) {
            pushHistory();
            uvPushModelId = sm.id;
        }
        const prev = effectiveUv(sm);
        const repeatUStr = uvInputs.repeatU?.value.trim() ?? '';
        const repeatVStr = uvInputs.repeatV?.value.trim() ?? '';
        sm.uvOverride = {
            u: Math.max(1, Math.round(Number(uvInputs.u?.value) || prev.u)),
            v: Math.max(1, Math.round(Number(uvInputs.v?.value) || prev.v)),
            tileSize: Math.max(1, Math.round(Number(uvInputs.tileSize?.value) || prev.tileSize)),
            repeatU: repeatUStr !== '' ? Math.max(1, Math.round(Number(repeatUStr))) : undefined,
            repeatV: repeatVStr !== '' ? Math.max(1, Math.round(Number(repeatVStr))) : undefined,
        };
        rebuildInstanceUvMesh(sm);
        drawUvCanvas(sm);
        rebuildInstances();
    }

    for (const input of Object.values(uvInputs)) {
        if (!input) continue;
        input.addEventListener('input', applyUvFromInputs);
        input.addEventListener('change', applyUvFromInputs);
    }

    uvPaletteSelect?.addEventListener('change', () => {
        if (syncingInspector) return;
        const sm = selectedModel();
        if (!sm || !smHasUvControls(sm)) return;
        if (sm.id !== uvPushModelId) {
            pushHistory();
            uvPushModelId = sm.id;
        }
        const next = uvPaletteSelect.value;
        sm.paletteOverride = isPicoCadPaletteId(next) ? next : undefined;
        sm.overrideMaterialId = undefined;
        drawUvCanvas(sm);
        rebuildInstances();
    });

    uvTextureSelect?.addEventListener('change', () => {
        if (syncingInspector) return;
        const sm = selectedModel();
        if (!sm || !smHasUvControls(sm)) return;
        if (sm.id !== uvPushModelId) {
            pushHistory();
            uvPushModelId = sm.id;
        }
        const next = uvTextureSelect.value;
        sm.textureOverride = isTextureAssetId(next) ? next : undefined;
        sm.overrideMaterialId = undefined;
        drawUvCanvas(sm);
        rebuildInstances();
    });

    if (uvCanvasEl) {
        uvCanvasEl.addEventListener('click', (e) => {
            const sm = selectedModel();
            if (!sm || !smHasUvControls(sm)) return;
            if (sm.id !== uvPushModelId) {
                pushHistory();
                uvPushModelId = sm.id;
            }
            const rect = uvCanvasEl.getBoundingClientRect();
            const scaleX = (uvCanvasEl.width || 128) / rect.width;
            const scaleY = (uvCanvasEl.height || 128) / rect.height;
            const px = (e.clientX - rect.left) * scaleX;
            const py = (e.clientY - rect.top) * scaleY;
            const uv = effectiveUv(sm);
            const ts = Math.max(1, uv.tileSize);
            const maxTile = Math.floor((uvCanvasEl.width || 128) / ts);
            const newU = Math.max(1, Math.min(Math.floor(px / ts) + 1, maxTile));
            const newV = Math.max(1, Math.min(Math.floor(py / ts) + 1, maxTile));
            sm.uvOverride = { ...uv, u: newU, v: newV };
            syncingInspector = true;
            if (uvInputs.u) uvInputs.u.value = String(newU);
            if (uvInputs.v) uvInputs.v.value = String(newV);
            syncingInspector = false;
            rebuildInstanceUvMesh(sm);
            drawUvCanvas(sm);
            rebuildInstances();
        });
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
        renderer.setColliderShapes(buildSceneColliderOverlayShapes(sceneModels));
        updateTransformGizmo();
        refreshInspector();
    }

    function selectedModel(): SceneModel | null {
        return selectedModelId ? (sceneModels.find((sm) => sm.id === selectedModelId) ?? null) : null;
    }

    function sceneModelDisplayName(sm: SceneModel, index = sceneModels.indexOf(sm)): string {
        const customName = sm.customName?.trim();
        if (customName) return customName;
        // blueprintName carries the internal "model:<name>" key for straight
        // model placements — show the bare model name instead.
        return `${index + 1}. ${modelNameFromKey(sm.blueprintName) ?? sm.blueprintName}`;
    }

    function sceneModelParts(sm: SceneModel): ModelMeshPart[] {
        return sm.uvRootPart ? [sm.uvRootPart, ...sm.loadedModel.parts.slice(1)] : sm.loadedModel.parts;
    }

    function instanceIdForMeshId(sm: SceneModel, meshId: string): string | null {
        const index = sceneModelParts(sm).findIndex((part) => part.meshId === meshId);
        return index >= 0 ? `${sm.id}:${index}` : null;
    }

    function selectSceneModelFromOutliner(sm: SceneModel, instanceId: string | null = null): void {
        selectedModelId = sm.id;
        selectedInstanceId = instanceId;
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
                    ? `mesh:${sm.blueprintName}:root`
                    : `mesh:${sm.blueprintName}:${nodeId.slice(`${sm.id}/`.length)}`
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
        return transformInputList.some((input) => input === document.activeElement) || selectedNameInput === document.activeElement;
    }

    function setTransformInputsEnabled(enabled: boolean): void {
        for (const input of transformInputList) input.disabled = !enabled;
        if (selectedNameInput) selectedNameInput.disabled = !enabled;
    }

    function syncInspectorTransformFields(sm: SceneModel | null): void {
        if (!sm) {
            if (selectedNameEl) selectedNameEl.textContent = 'No selection';
            if (selectedNameInput) {
                selectedNameInput.value = '';
                selectedNameInput.placeholder = 'No selection';
            }
            setTransformInputsEnabled(false);
            for (const input of transformInputList) input.value = '';
            return;
        }
        if (selectedNameEl) selectedNameEl.textContent = sceneModelDisplayName(sm);
        if (selectedNameInput) {
            selectedNameInput.placeholder = entityIdFor(sm, sceneModels.indexOf(sm));
            if (document.activeElement !== selectedNameInput) selectedNameInput.value = sm.customName ?? '';
        }
        setTransformInputsEnabled(true);
        if (inspectorHasFocus()) return;
        syncingInspector = true;
        if (transformInputs.posX) transformInputs.posX.value = formatInspectorNumber(sm.position[0]);
        if (transformInputs.posY) transformInputs.posY.value = formatInspectorNumber(sm.position[1]);
        if (transformInputs.posZ) transformInputs.posZ.value = formatInspectorNumber(sm.position[2]);
        if (transformInputs.rotX) transformInputs.rotX.value = formatInspectorNumber(sm.rotation[0]);
        if (transformInputs.rotY) transformInputs.rotY.value = formatInspectorNumber(sm.rotation[1]);
        if (transformInputs.rotZ) transformInputs.rotZ.value = formatInspectorNumber(sm.rotation[2]);
        if (transformInputs.scaleX) transformInputs.scaleX.value = formatInspectorNumber(sm.scale[0]);
        if (transformInputs.scaleY) transformInputs.scaleY.value = formatInspectorNumber(sm.scale[1]);
        if (transformInputs.scaleZ) transformInputs.scaleZ.value = formatInspectorNumber(sm.scale[2]);
        syncingInspector = false;
    }

    function refreshInspector(): void {
        if (outlinerListEl) {
            outlinerListEl.replaceChildren();
            for (const [index, sm] of sceneModels.entries()) {
                renderOutlinerNode(
                    sm,
                    sm.loadedModel.blueprint.node,
                    sm.id,
                    sceneModelDisplayName(sm, index),
                    0,
                    sm.id === selectedModelId,
                );
            }
        }
        const sm = selectedModel();
        syncInspectorTransformFields(sm);
        syncInspectorUvFields(sm);
    }

    function applyInspectorTransform(): void {
        if (syncingInspector) return;
        const sm = selectedModel();
        if (!sm) return;
        if (sm.id !== inspectorPushModelId) {
            pushHistory();
            inspectorPushModelId = sm.id;
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
            blueprintName: sm.blueprintName,
            customName: sm.customName ? `${sm.customName}_copy` : undefined,
            position: [...sm.position],
            rotation: [...sm.rotation],
            scale: [...sm.scale],
            loadedModel: sm.loadedModel,
            meshBounds: sm.meshBounds,
            uvOverride: sm.uvOverride ? { ...sm.uvOverride } : undefined,
            paletteOverride: sm.paletteOverride,
            textureOverride: sm.textureOverride,
        };
        if (clone.uvOverride) rebuildInstanceUvMesh(clone);
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
        const blueprintName = payload.startsWith('blueprint:') ? payload.slice('blueprint:'.length) : payload;
        return boundsToFootprint(boundsCache.get(blueprintName) ?? null);
    }

    function beginSidebarModelSelection(payload: string): void {
        selectedModelId = null;
        selectedInstanceId = null;
        transformState = null;
        dragFootprint = footprintFromSidebarPayload(payload);
        renderer.setHoverSnap(null);
        rebuildInstances();
    }

    // ---- Blueprint loading (idempotent) ------------------------------------

    async function loadBlueprint(name: string): Promise<LoadedBlueprint | null> {
        const loader = BLUEPRINT_FILES[`../blueprints/${name}.ts`];
        if (!loader) {
            console.warn(`No blueprint found for "${name}"`);
            return null;
        }

        let mod: BlueprintModule;
        try {
            mod = await loader();
        } catch (err) {
            console.error(`Failed to import blueprint "${name}":`, err);
            return null;
        }

        const blueprintFactory = mod[name];
        if (typeof blueprintFactory !== 'function') {
            console.warn(`Blueprint "${name}" does not export function ${name}()`);
            return null;
        }

        try {
            return await (blueprintFactory as () => Promise<LoadedBlueprint>)();
        } catch (err) {
            console.error(`Failed to load blueprint "${name}":`, err);
            return null;
        }
    }

    async function loadModelAsBlueprint(modelName: string): Promise<LoadedBlueprint | null> {
        try {
            return await load_model_blueprint(modelName);
        } catch (err) {
            console.error(`Failed to load model "${modelName}":`, err);
            return null;
        }
    }

    async function ensureBlueprintLoaded(name: string): Promise<LoadedModel | null> {
        const cached = loadedModels.get(name);
        if (cached) return cached;

        const modelName = modelNameFromKey(name);
        const blueprint = modelName ? await loadModelAsBlueprint(modelName) : await loadBlueprint(name);
        if (!blueprint?.node || !blueprint.data.texture) {
            console.warn(`"${name}" is missing blueprint node or texture`);
            return null;
        }

        const partDescriptors: ModelMeshPart[] = [];
        collectMeshParts(blueprint.node, name, [], makePicoModelMirrorMatrix(), partDescriptors);

        if (partDescriptors.length === 0) {
            console.warn(`"${name}" has no mesh nodes`);
            return null;
        }

        for (const desc of partDescriptors) {
            const node = findNodeByMeshId(blueprint.node, name, desc.meshId);
            if (!node) continue;
            const asset = buildMeshAssetFromPicoNode(node, name, meshIdToPath(desc.meshId, name));
            if (!asset) continue;
            renderer.addMesh(desc.meshId, buildLocalMeshFromMeshAsset(asset));
        }

        const material = blueprint.buildMaterial(`editor:${name}`);
        const materialId = material.materialId;
        const tex = material.texture;
        renderer.addMaterial(materialId, {
            width: tex.width,
            height: tex.height,
            pixels: tex.pixels,
            palettePixels: tex.palettePixels,
            transparentIndex: tex.transparentIndex,
        });

        boundsCache.set(name, computeGraphBounds(blueprint.node));

        const textureData = buildTextureRGBA(blueprint.data);
        let textureImageData: ImageData | null = null;
        try {
            textureImageData = new ImageData(
                new Uint8ClampedArray(textureData.rgbaPixels),
                textureData.width,
                textureData.height,
            );
        } catch {
            // canvas API unavailable
        }

        const entry: LoadedModel = { parts: partDescriptors, materialId, blueprint, textureData, textureImageData };
        loadedModels.set(name, entry);
        return entry;
    }

    // ---- Save / load -------------------------------------------------------

    function toStageName(input: string | null): string {
        const raw = (input ?? '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_]+/g, '_')
            .replace(/^_+|_+$/g, '');
        const base = raw.length > 0 ? raw : 'current';
        if (base.startsWith('stg_')) return base;
        if (base.startsWith('sce_')) return `stg_${base.slice('sce_'.length)}`;
        return `stg_${base}`;
    }

    function formatTuple(values: [number, number, number]): string {
        return `[${values.map(formatNumber).join(', ')}]`;
    }

    function rotationToRadians(rotationDeg: [number, number, number]): [number, number, number] {
        return rotationDeg.map((deg) => (deg * Math.PI) / 180) as [number, number, number];
    }

    function positionToGameScene(position: [number, number, number]): [number, number, number] {
        return [position[0], position[1], position[2]];
    }

    function rotationToGameSceneRadians(rotationDeg: [number, number, number]): [number, number, number] {
        const [rx, ry, rz] = rotationToRadians(rotationDeg);
        return [rx, ry, rz];
    }

    function cameraToGameScene(camera: SavedEditorCamera): SavedEditorCamera {
        return cloneCamera(camera);
    }

    function currentOrbitCamera(name: string): SavedEditorCamera {
        return {
            name,
            target: [...orbit.target],
            yaw: orbit.yaw,
            pitch: orbit.pitch,
            distance: orbit.distance,
        };
    }

    function nextCameraName(): string {
        let index = savedCameras.length + 1;
        while (savedCameras.some((camera) => camera.name === `camera_${index}`)) index++;
        return `camera_${index}`;
    }

    function refreshCameraSelect(): void {
        if (!cameraSelect) return;
        const selectedName = activeCameraName ?? savedCameras[0]?.name ?? '';
        cameraSelect.replaceChildren();

        if (savedCameras.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No saved cameras';
            cameraSelect.appendChild(option);
            cameraSelect.disabled = true;
            return;
        }

        cameraSelect.disabled = false;
        for (const camera of savedCameras) {
            const option = document.createElement('option');
            option.value = camera.name;
            option.textContent = camera.name === defaultCameraName ? `${camera.name} (default)` : camera.name;
            cameraSelect.appendChild(option);
        }
        cameraSelect.value = savedCameras.some((camera) => camera.name === selectedName) ? selectedName : savedCameras[0].name;
    }

    function applySavedCamera(name: string): void {
        const camera = savedCameras.find((candidate) => candidate.name === name);
        if (!camera) return;
        activeCameraName = camera.name;
        orbitCtrl.onPointerUp();
        orbitCtrl.snapToOrbitPose({
            targetX: camera.target[0],
            targetY: camera.target[1],
            targetZ: camera.target[2],
            yaw: camera.yaw,
            pitch: camera.pitch,
            distance: camera.distance,
        });
        refreshCameraSelect();
    }

    function saveCurrentCamera(): void {
        const saved = currentOrbitCamera(nextCameraName());
        savedCameras.push(saved);
        activeCameraName = saved.name;
        refreshCameraSelect();
    }

    function activeExportCamera(): SavedEditorCamera {
        const selectedName = defaultCameraName ?? activeCameraName;
        const selected = selectedName ? savedCameras.find((camera) => camera.name === selectedName) : null;
        return cameraToGameScene(selected ?? currentOrbitCamera('current_orbit_camera'));
    }

    function formatOptionalCameraNumber(camera: SavedEditorCamera, key: keyof SavedEditorCamera): string {
        const value = camera[key];
        return typeof value === 'number' ? `            ${key}: ${formatNumber(value)},\n` : '';
    }

    function formatOptionalCameraBoolean(camera: SavedEditorCamera, key: keyof SavedEditorCamera): string {
        const value = camera[key];
        return typeof value === 'boolean' ? `            ${key}: ${value},\n` : '';
    }

    function formatCameraBlock(camera: SavedEditorCamera): string {
        const fog = camera.fog
            ? `            fog: {\n` +
              (camera.fog.color ? `                color: ${formatTuple(camera.fog.color)},\n` : '') +
              (typeof camera.fog.near === 'number' ? `                near: ${formatNumber(camera.fog.near)},\n` : '') +
              (typeof camera.fog.far === 'number' ? `                far: ${formatNumber(camera.fog.far)},\n` : '') +
              (typeof camera.fog.enabled === 'boolean' ? `                enabled: ${camera.fog.enabled},\n` : '') +
              `            },\n`
            : '';

        return (
            `        camera: {\n` +
            `            mode: 'orbit',\n` +
            `            target: ${formatTuple(camera.target)},\n` +
            `            distance: ${formatNumber(camera.distance)},\n` +
            `            yaw: ${formatNumber(camera.yaw)},\n` +
            `            pitch: ${formatNumber(camera.pitch)},\n` +
            formatOptionalCameraNumber(camera, 'fovYRadians') +
            formatOptionalCameraNumber(camera, 'near') +
            formatOptionalCameraNumber(camera, 'far') +
            formatOptionalCameraNumber(camera, 'minDistance') +
            formatOptionalCameraNumber(camera, 'maxDistance') +
            formatOptionalCameraNumber(camera, 'minPitch') +
            formatOptionalCameraNumber(camera, 'maxPitch') +
            formatOptionalCameraNumber(camera, 'rotateSpeed') +
            formatOptionalCameraNumber(camera, 'panSpeed') +
            formatOptionalCameraNumber(camera, 'wheelZoomSpeed') +
            formatOptionalCameraNumber(camera, 'touchRotateSpeed') +
            formatOptionalCameraNumber(camera, 'touchPanSpeed') +
            formatOptionalCameraNumber(camera, 'touchPinchZoomSpeed') +
            formatOptionalCameraBoolean(camera, 'enableTouch') +
            fog +
            `        },\n`
        );
    }

    function sanitizeEntityId(value: string): string {
        return value
            .trim()
            .replace(/^blu_/, '')
            .replace(/[^a-z0-9_]+/gi, '_')
            .replace(/^_+|_+$/g, '')
            .toLowerCase();
    }

    function defaultEntityIdFor(sm: SceneModel, index: number): string {
        return sanitizeEntityId(`${sm.blueprintName.replace(/^blu_/, '')}_${index + 1}`) || `entity_${index + 1}`;
    }

    function entityIdFor(sm: SceneModel, index: number): string {
        const customName = sm.customName?.trim();
        return customName ? sanitizeEntityId(customName) || defaultEntityIdFor(sm, index) : defaultEntityIdFor(sm, index);
    }

    function resolveEntityIds(): Map<string, string> {
        const used = new Set<string>();
        const result = new Map<string, string>();
        for (const [index, sm] of sceneModels.entries()) {
            const base = entityIdFor(sm, index);
            let candidate = base;
            let suffix = 2;
            while (used.has(candidate)) candidate = `${base}_${suffix++}`;
            used.add(candidate);
            result.set(sm.id, candidate);
        }
        return result;
    }

    function formatUvOverride(uv: SaveObjectUvOverride | undefined): string {
        if (!uv) return '';
        const repeatU = uv.repeatU !== undefined ? `,\n                    repeatU: ${formatNumber(uv.repeatU)}` : '';
        const repeatV = uv.repeatV !== undefined ? `,\n                    repeatV: ${formatNumber(uv.repeatV)}` : '';
        return `,\n                uvOverride: {\n                    u: ${formatNumber(uv.u)},\n                    v: ${formatNumber(uv.v)},\n                    tileSize: ${formatNumber(uv.tileSize)}${repeatU}${repeatV},\n                }`;
    }

    function formatPaletteOverride(palette: PicoCadPaletteId | undefined): string {
        return palette ? `,\n                paletteOverride: '${palette}'` : '';
    }

    function formatTextureOverride(texture: string | undefined): string {
        return texture ? `,\n                textureOverride: '${texture}'` : '';
    }

    function stageModelRawImportName(modelName: string): string {
        const cleanName = modelName
            .replace(/[^a-z0-9_]+/gi, '_')
            .replace(/^_+|_+$/g, '')
            .toLowerCase();
        return `${cleanName || 'model'}Raw`;
    }

    function buildStageImports(): string {
        const blueprintNames = new Set<string>();
        const modelNames = new Set<string>();
        for (const sm of sceneModels) {
            const modelName = modelNameFromKey(sm.blueprintName);
            if (modelName) {
                modelNames.add(modelName);
            } else {
                blueprintNames.add(sm.blueprintName);
            }
        }

        const lines = [`import type { StageDefinition } from './stage';`];
        for (const name of [...blueprintNames].sort()) {
            lines.push(`import { ${name} } from '../blueprints/${name}';`);
        }
        if (modelNames.size > 0) {
            lines.push(`import { create_model_blueprint } from '../blueprints/model_blueprint';`);
            for (const name of [...modelNames].sort()) {
                const folder = isPrimitiveShape(name) ? 'primitives' : 'models';
                lines.push(`import ${stageModelRawImportName(name)} from '../assets/${folder}/${name}.txt?compact';`);
            }
        }

        return `${lines.join('\n')}\n\n`;
    }

    function formatStageObjectKind(sm: SceneModel): string {
        const modelName = modelNameFromKey(sm.blueprintName);
        return modelName
            ? `model: '${modelName}',\n            blueprint: async () => create_model_blueprint('${modelName}', ${stageModelRawImportName(modelName)}),`
            : `blueprintId: '${sm.blueprintName}',\n            blueprint: ${sm.blueprintName},`;
    }

    function buildStageSource(stageName: string): string {
        const camera = activeExportCamera();
        const entityIds = resolveEntityIds();
        const objects = sceneModels
            .map((sm, i) => {
                return `        {
            id: '${entityIds.get(sm.id) ?? entityIdFor(sm, i)}',
            ${formatStageObjectKind(sm)}
            position: ${formatTuple(positionToGameScene(sm.position))},
            rotation: ${formatTuple(rotationToGameSceneRadians(sm.rotation))},
            scale: ${formatTuple(sm.scale)}${formatUvOverride(sm.uvOverride)}${formatPaletteOverride(sm.paletteOverride)}${formatTextureOverride(sm.textureOverride)},
        }`;
            })
            .join(',\n');

        return (
            buildStageImports() +
            `// >>> STAGE EDITOR GENERATED - do not hand-edit below >>>\n` +
            `export const ${stageName} = {\n` +
            `    name: '${stageName.replace(/^stg_/, '')}',\n` +
            formatCameraBlock(camera).replace(/^        /gm, '    ') +
            `    objects: [\n${objects}\n    ],\n` +
            `} satisfies StageDefinition;\n` +
            `// <<< STAGE EDITOR GENERATED END - your code below this line is preserved <<<\n`
        );
    }

    async function saveStageFile(fileName: string, source: string, options: { showAlert?: boolean } = {}): Promise<void> {
        const res = await fetch('/__editor/save-stage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName, source }),
        });

        if (res.ok) {
            if (options.showAlert ?? true) window.alert(`Saved src/stages/${fileName}`);
            return;
        }

        const message = await res.text();
        throw new Error(
            res.status === 404
                ? 'Stage save endpoint was not found. Restart bun run dev so Vite loads vite.config.ts.'
                : `Stage save failed: ${message}`,
        );
    }

    async function saveStage(): Promise<void> {
        if (sceneModels.length === 0) {
            window.alert('Place at least one blueprint or model before saving a stage.');
            return;
        }

        const sceneNameInput = document.getElementById('scene-name') as HTMLInputElement | null;
        const stageName = toStageName(sceneNameInput?.value ?? 'stg_current');
        if (sceneNameInput) sceneNameInput.value = stageName;
        await saveStageFile(`${stageName}.ts`, buildStageSource(stageName));
    }

    // Preview = write the working stage to stg_current.ts; sce_current.ts loads
    // that stage through sceneFromStage().
    async function previewStage(): Promise<void> {
        if (sceneModels.length === 0) {
            window.alert('Place at least one blueprint or model before previewing.');
            return;
        }
        await saveStageFile('stg_current.ts', buildStageSource('stg_current'), { showAlert: false });
        window.open('index.html', '_blank');
    }

    async function loadScene(data: SaveData, preferredCameraName?: string): Promise<void> {
        sceneModels.length = 0;
        sceneModelCounter = 0;
        expandedOutlinerNodeIds.clear();
        selectedInstanceId = null;
        for (const obj of data.objects) {
            const rawName = obj.blueprint ?? obj.model ?? obj.file ?? (obj.prefab ? `blu_${obj.prefab}` : undefined);
            const blueprintName =
                rawName?.startsWith(MODEL_KEY_PREFIX) || rawName?.startsWith('blu_')
                    ? rawName
                    : rawName
                      ? `${MODEL_KEY_PREFIX}${rawName}`
                      : undefined;
            if (!blueprintName) continue;
            const loadedModel = await ensureBlueprintLoaded(blueprintName);
            if (!loadedModel) continue;
            const uvOverride = (obj as SaveObject).uvOverride;
            const rawPaletteOverride = (obj as SaveObject).paletteOverride;
            const rawTextureOverride = (obj as SaveObject).textureOverride;
            const sm: SceneModel = {
                id: `sm:${sceneModelCounter++}`,
                blueprintName,
                customName: obj.name,
                position: obj.position,
                rotation: obj.rotation ?? [0, 0, 0],
                scale: obj.scale ?? [1, 1, 1],
                loadedModel,
                meshBounds: boundsCache.get(blueprintName) ?? null,
                uvOverride,
                paletteOverride: isPicoCadPaletteId(rawPaletteOverride) ? rawPaletteOverride : undefined,
                textureOverride: isTextureAssetId(rawTextureOverride) ? rawTextureOverride : undefined,
            };
            if (uvOverride) rebuildInstanceUvMesh(sm);
            sceneModels.push(sm);
        }
        savedCameras.length = 0;
        savedCameras.push(
            ...(data.cameras ?? []).map(sanitizeCamera).filter((camera): camera is SavedEditorCamera => camera !== null),
        );
        activeCameraName =
            preferredCameraName && savedCameras.some((camera) => camera.name === preferredCameraName)
                ? preferredCameraName
                : data.activeCamera && savedCameras.some((camera) => camera.name === data.activeCamera)
                  ? data.activeCamera
                  : (savedCameras[0]?.name ?? null);
        defaultCameraName =
            data.defaultCamera && savedCameras.some((camera) => camera.name === data.defaultCamera) ? data.defaultCamera : null;
        refreshCameraSelect();
        if (activeCameraName) applySavedCamera(activeCameraName);
        rebuildInstances();
    }

    function buildEditorSaveJson(): string {
        const objects = sceneModels.map((sm) => ({
            blueprint: sm.blueprintName,
            ...(sm.customName?.trim() ? { name: sm.customName.trim() } : {}),
            position: sm.position,
            rotation: sm.rotation,
            scale: sm.scale,
            ...(sm.uvOverride ? { uvOverride: sm.uvOverride } : {}),
            ...(sm.paletteOverride ? { paletteOverride: sm.paletteOverride } : {}),
            ...(sm.textureOverride ? { textureOverride: sm.textureOverride } : {}),
        }));
        const data: SaveData = {
            version: 1,
            objects,
            cameras: savedCameras.map(cloneCamera),
            activeCamera: activeCameraName ?? undefined,
            defaultCamera: defaultCameraName ?? undefined,
        };
        return JSON.stringify(data, null, 2);
    }

    function stageObjectToSaveObject(object: StageObjectDefinition): SaveObject {
        const blueprint = object.model
            ? `${MODEL_KEY_PREFIX}${object.model}`
            : (object.blueprintId ?? (typeof object.blueprint === 'string' ? object.blueprint : undefined));
        return {
            blueprint,
            position: object.position ?? [0, 0, 0],
            rotation: object.rotation ? rotationRadiansToEditorDegrees(object.rotation) : [0, 0, 0],
            scale: object.scale ?? [1, 1, 1],
            uvOverride: object.uvOverride,
            paletteOverride: object.paletteOverride,
            textureOverride: object.textureOverride,
            name: object.id,
        };
    }

    function rotationRadiansToEditorDegrees(rotation: [number, number, number]): [number, number, number] {
        return rotation.map((radians) => (radians * 180) / Math.PI) as [number, number, number];
    }

    function stageToSaveData(stage: StageDefinition): SaveData {
        const camera: SavedEditorCamera | undefined =
            stage.camera?.mode === 'orbit'
                ? {
                      name: `${stage.name || 'stage'}_camera`,
                      target: stage.camera.target ?? [0, 0, 0],
                      yaw: stage.camera.yaw ?? 0,
                      pitch: stage.camera.pitch ?? 0,
                      distance: stage.camera.distance ?? 12,
                      fovYRadians: stage.camera.fovYRadians,
                      near: stage.camera.near,
                      far: stage.camera.far,
                      minDistance: stage.camera.minDistance,
                      maxDistance: stage.camera.maxDistance,
                      minPitch: stage.camera.minPitch,
                      maxPitch: stage.camera.maxPitch,
                      rotateSpeed: stage.camera.rotateSpeed,
                      panSpeed: stage.camera.panSpeed,
                      wheelZoomSpeed: stage.camera.wheelZoomSpeed,
                      touchRotateSpeed: stage.camera.touchRotateSpeed,
                      touchPanSpeed: stage.camera.touchPanSpeed,
                      touchPinchZoomSpeed: stage.camera.touchPinchZoomSpeed,
                      enableTouch: stage.camera.enableTouch,
                      fog: stage.camera.fog,
                  }
                : undefined;

        return {
            version: 1,
            objects: stage.objects.map(stageObjectToSaveObject),
            cameras: camera ? [camera] : undefined,
            activeCamera: camera?.name,
            defaultCamera: camera?.name,
        };
    }

    async function loadStage(stageName: string): Promise<void> {
        const fileName = stageName.endsWith('.ts') ? stageName : `${stageName}.ts`;
        const modulePath = `../stages/${fileName}`;
        const loader = STAGE_FILES[modulePath];
        if (!loader) throw new Error(`No stage file found for "${fileName}"`);
        const mod = await loader();
        const exportName = fileName.replace(/\.ts$/, '');
        const stage = mod[exportName];
        if (!stage || typeof stage !== 'object' || !Array.isArray((stage as StageDefinition).objects)) {
            throw new Error(`Stage "${fileName}" does not export ${exportName}`);
        }
        await loadScene(stageToSaveData(stage as StageDefinition));
        const sceneNameInput = document.getElementById('scene-name') as HTMLInputElement | null;
        if (sceneNameInput) sceneNameInput.value = exportName;
    }

    function refreshStageSelect(preferredStage = 'stg_current'): void {
        if (!stageSelect) return;
        const stages = Object.keys(STAGE_FILES).map(nameFromPath).sort();
        stageSelect.replaceChildren();
        for (const stage of stages) {
            const option = document.createElement('option');
            option.value = stage;
            option.textContent = stage;
            stageSelect.appendChild(option);
        }
        stageSelect.value = stages.includes(preferredStage) ? preferredStage : (stages[0] ?? '');
    }

    function selectedEditorSaveFileName(): string {
        return editorSaveSelect?.value || 'new_scene.json';
    }

    async function refreshEditorSaveList(preferredFileName = selectedEditorSaveFileName()): Promise<void> {
        if (!editorSaveSelect) return;
        const res = await fetch('/__editor/list-editor-saves');
        if (!res.ok) throw new Error(`Failed to list editor saves: ${await res.text()}`);
        const data = (await res.json()) as { files?: unknown };
        const files = Array.isArray(data.files)
            ? data.files.filter((file): file is string => typeof file === 'string' && !file.startsWith('blu_'))
            : [];
        const selected = files.includes(preferredFileName)
            ? preferredFileName
            : files.includes('new_scene.json')
              ? 'new_scene.json'
              : (files[0] ?? 'new_scene.json');

        editorSaveSelect.replaceChildren();
        for (const file of files.length > 0 ? files : [selected]) {
            const option = document.createElement('option');
            option.value = file;
            option.textContent = file;
            editorSaveSelect.appendChild(option);
        }
        editorSaveSelect.value = selected;
    }

    async function saveEditorJson(options: { showAlert?: boolean } = {}): Promise<void> {
        const fileName = selectedEditorSaveFileName();
        const res = await fetch('/__editor/save-editor-save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName, source: buildEditorSaveJson() }),
        });

        if (!res.ok) {
            throw new Error(
                res.status === 404
                    ? 'Editor save endpoint was not found. Restart bun run dev so Vite loads vite.config.ts.'
                    : `Editor save failed: ${await res.text()}`,
            );
        }

        await refreshEditorSaveList(fileName);
        if (options.showAlert ?? true) window.alert(`Saved src/editor/saves/${fileName}`);
    }

    async function loadEditorJson(preferredCameraName?: string): Promise<void> {
        const fileName = selectedEditorSaveFileName();
        const res = await fetch(`/__editor/load-editor-save?file=${encodeURIComponent(fileName)}`);
        if (!res.ok) {
            throw new Error(
                res.status === 404
                    ? 'Editor load endpoint was not found. Restart bun run dev so Vite loads vite.config.ts.'
                    : `Editor load failed: ${await res.text()}`,
            );
        }

        const data = (await res.json()) as SaveData;
        if (data.version !== 1) throw new Error('Unknown scene version');
        await loadScene(data, preferredCameraName);
    }

    // ---- Sidebar -----------------------------------------------------------

    function makeDraggable(el: HTMLElement, payload: string): void {
        el.draggable = true;
        el.addEventListener('pointerdown', () => {
            beginSidebarModelSelection(payload);
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

    // Scene actions panel
    const actionsEl = document.getElementById('scene-actions')!;

    // Row 1: Legacy JSON Save + Load
    const saveJsonBtn = document.createElement('button');
    saveJsonBtn.type = 'button';
    saveJsonBtn.className = 'action-btn';
    saveJsonBtn.textContent = 'Save Draft';
    saveJsonBtn.addEventListener('click', () => {
        void saveEditorJson().catch((err) => {
            console.error('Failed to save editor scene:', err);
            window.alert(err instanceof Error ? err.message : String(err));
        });
    });
    actionsEl.appendChild(saveJsonBtn);

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'action-btn';
    loadBtn.textContent = 'Load Draft';
    loadBtn.addEventListener('click', () => {
        void loadEditorJson().catch((err) => {
            console.error('Failed to load editor scene:', err);
            window.alert(err instanceof Error ? err.message : String(err));
        });
    });
    actionsEl.appendChild(loadBtn);

    editorSaveSelect = document.createElement('select');
    editorSaveSelect.className = 'action-input';
    actionsEl.appendChild(editorSaveSelect);

    stageSelect = document.createElement('select');
    stageSelect.className = 'action-input';
    actionsEl.appendChild(stageSelect);
    refreshStageSelect('stg_current');

    const loadStageBtn = document.createElement('button');
    loadStageBtn.type = 'button';
    loadStageBtn.className = 'action-btn';
    loadStageBtn.textContent = 'Load Stage';
    loadStageBtn.addEventListener('click', () => {
        if (!stageSelect?.value) return;
        void loadStage(stageSelect.value).catch((err) => {
            console.error('Failed to load stage:', err);
            window.alert(err instanceof Error ? err.message : String(err));
        });
    });
    actionsEl.appendChild(loadStageBtn);

    cameraSelect = document.createElement('select');
    cameraSelect.className = 'action-input';
    const applySelectedCamera = () => {
        if (cameraSelect?.value) applySavedCamera(cameraSelect.value);
    };
    cameraSelect.addEventListener('input', applySelectedCamera);
    cameraSelect.addEventListener('change', applySelectedCamera);
    actionsEl.appendChild(cameraSelect);
    refreshCameraSelect();

    const saveCameraBtn = document.createElement('button');
    saveCameraBtn.type = 'button';
    saveCameraBtn.className = 'action-btn';
    saveCameraBtn.textContent = 'Save Camera';
    saveCameraBtn.addEventListener('click', () => {
        saveCurrentCamera();
    });
    actionsEl.appendChild(saveCameraBtn);

    const editCameraBtn = document.createElement('button');
    editCameraBtn.type = 'button';
    editCameraBtn.className = 'action-btn';
    editCameraBtn.textContent = 'Camera Edit';
    editCameraBtn.addEventListener('click', () => {
        void saveEditorJson({ showAlert: false })
            .then(() => {
                window.location.href = `editor_camera.html?file=${encodeURIComponent(selectedEditorSaveFileName())}`;
            })
            .catch((err) => {
                console.error('Failed to save before camera edit:', err);
                window.alert(err instanceof Error ? err.message : String(err));
            });
    });
    actionsEl.appendChild(editCameraBtn);

    // Row 2: stage name input
    const sceneNameInput = document.createElement('input');
    sceneNameInput.id = 'scene-name';
    sceneNameInput.className = 'action-input';
    sceneNameInput.type = 'text';
    sceneNameInput.value = 'stg_current';
    sceneNameInput.autocomplete = 'off';
    sceneNameInput.spellcheck = false;
    actionsEl.appendChild(sceneNameInput);

    // Row 3: Save Stage (saves stg_*.ts for the game)
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'action-btn action-btn-full';
    exportBtn.textContent = 'Save Stage';
    exportBtn.addEventListener('click', () => {
        void saveStage().catch((err) => {
            console.error('Failed to save stage:', err);
            window.alert(err instanceof Error ? err.message : String(err));
        });
    });
    actionsEl.appendChild(exportBtn);

    // Preview: writes stg_current.ts and opens the game in a new tab.
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'action-btn action-btn-full';
    previewBtn.textContent = 'Preview Stage';
    previewBtn.addEventListener('click', () => {
        void previewStage().catch((err) => {
            console.error('Failed to preview stage:', err);
            window.alert(err instanceof Error ? err.message : String(err));
        });
    });
    actionsEl.appendChild(previewBtn);

    // Separator
    const sep = document.createElement('div');
    sep.className = 'actions-sep';
    actionsEl.appendChild(sep);

    // Blueprint Editor button
    const blueprintEditorBtn = document.createElement('button');
    blueprintEditorBtn.type = 'button';
    blueprintEditorBtn.className = 'action-btn action-btn-full';
    blueprintEditorBtn.textContent = 'Blueprint Editor';
    blueprintEditorBtn.addEventListener('click', () => {
        window.location.href = 'editor_blueprint.html';
    });
    actionsEl.appendChild(blueprintEditorBtn);

    // Game Controls editor button
    const controlsEditorBtn = document.createElement('button');
    controlsEditorBtn.type = 'button';
    controlsEditorBtn.className = 'action-btn action-btn-full';
    controlsEditorBtn.textContent = 'Game Controls';
    controlsEditorBtn.addEventListener('click', () => {
        window.location.href = 'editor_controls.html';
    });
    actionsEl.appendChild(controlsEditorBtn);

    // Animation Editor button
    const animationEditorBtn = document.createElement('button');
    animationEditorBtn.type = 'button';
    animationEditorBtn.className = 'action-btn action-btn-full';
    animationEditorBtn.textContent = 'Animation Editor';
    animationEditorBtn.addEventListener('click', () => {
        window.location.href = 'editor_animation.html';
    });
    actionsEl.appendChild(animationEditorBtn);

    void refreshEditorSaveList(initialSaveFile)
        .then(() => {
            if (initialSaveFile) return loadEditorJson(initialCameraName);
            return loadStage('stg_current');
        })
        .catch((err) => {
            console.error('Failed to initialize editor:', err);
            window.alert(err instanceof Error ? err.message : String(err));
        });

    // Precompute footprints so drag previews match the asset shape.
    void Promise.all([
        ...Object.keys(BLUEPRINT_FILES).map(async (filePath) => {
            const name = nameFromPath(filePath);
            try {
                const blueprint = await loadBlueprint(name);
                boundsCache.set(name, blueprint ? computeGraphBounds(blueprint.node) : null);
            } catch {
                /* ignore */
            }
        }),
        ...Object.entries(MODEL_FILES).map(async ([filePath, loader]) => {
            const name = nameFromPath(filePath);
            try {
                const data = parsePicoCad2(await loader());
                boundsCache.set(`${MODEL_KEY_PREFIX}${name}`, data.graph ? computeGraphBounds(data.graph) : null);
            } catch {
                /* ignore */
            }
        }),
    ]);

    function appendSidebarItem(label: string, payload: string): void {
        const item = document.createElement('div');
        item.className = 'model-item';
        item.textContent = label;
        makeDraggable(item, payload);
        modelListEl.appendChild(item);
    }

    addSectionHeader('Blueprints');
    for (const name of Object.keys(BLUEPRINT_FILES).map(nameFromPath).sort()) {
        appendSidebarItem(name, `blueprint:${name}`);
    }

    // Models + Primitives sections — mesh_*.txt files are the reusable
    // primitive building blocks, grouped apart from actual content models.
    const modelNames = Object.keys(MODEL_FILES).map(nameFromPath).sort();

    addSectionHeader('Models');
    for (const name of modelNames.filter((name) => !isPrimitiveShape(name))) {
        appendSidebarItem(name, `${MODEL_KEY_PREFIX}${name}`);
    }

    addSectionHeader('Primitives');
    for (const name of modelNames.filter(isPrimitiveShape)) {
        appendSidebarItem(name, `${MODEL_KEY_PREFIX}${name}`);
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
        if (!sm || transformState) return null;
        const rect = canvas.getBoundingClientRect();
        const dprX = canvas.width / Math.max(1, rect.width);
        const dprY = canvas.height / Math.max(1, rect.height);
        const px = (e.clientX - rect.left) * dprX;
        const py = (e.clientY - rect.top) * dprY;
        const len = selectedGizmoRadius(sm);
        const hitRadius = 14 * Math.max(dprX, dprY);
        const [cx, cy, cz] = sm.position;
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

        // Plane square hit test: project all 4 corners, point-in-quad + AABB+margin fallback
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
        renderer.setRotateRing(null);
        renderer.setTransformGizmo(
            sm
                ? {
                      pos: sm.position,
                      radius: selectedGizmoRadius(sm),
                      mode: transformState?.modelId === sm.id ? transformState.mode : stickyGizmoMode,
                      axis: transformState?.modelId === sm.id ? transformState.axis : null,
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
        if (!sm) return;
        if (!transformState && !skipNextTransformHistoryPush) pushHistory();
        skipNextTransformHistoryPush = false;
        const startEvent = transformEventForModel(sm);
        const startGround: [number, number, number] =
            axis === 'xy'
                ? (axisPlanePointFromEvent(startEvent, 'z', sm.position[2]) ?? [sm.position[0], sm.position[1], sm.position[2]])
                : axis === 'yz'
                  ? (axisPlanePointFromEvent(startEvent, 'x', sm.position[0]) ?? [sm.position[0], sm.position[1], sm.position[2]])
                  : (groundPointFromEvent(startEvent) ?? [sm.position[0], 0, sm.position[2]]);
        renderer.setHoverSnap(null);
        orbitCtrl.onPointerUp();
        transformState = {
            mode,
            axis,
            source,
            modelId: sm.id,
            startPosition: [...sm.position],
            startRotation: [...sm.rotation],
            startScale: [...sm.scale],
            startGround,
            startAngle: pointerAngleForModel(sm, startEvent),
            startDistance: pointerDistanceForModel(sm, startEvent),
            startClientX: startEvent.clientX,
            startClientY: startEvent.clientY,
        };
        updateTransformGizmo();
    }

    function cancelTransform(): void {
        if (!transformState) return;
        const sm = sceneModels.find((m) => m.id === transformState?.modelId);
        if (sm) {
            sm.position = [...transformState.startPosition];
            sm.rotation = [...transformState.startRotation];
            sm.scale = [...transformState.startScale];
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

    function updateActiveTransform(e: { clientX: number; clientY: number }): void {
        if (!transformState) return;
        const sm = sceneModels.find((m) => m.id === transformState?.modelId);
        if (!sm) return;

        if (transformState.mode === 'translate') {
            if (!transformState.startGround) return;
            sm.position = [...transformState.startPosition];
            if (transformState.axis === 'xy') {
                const p = axisPlanePointFromEvent(e, 'z', transformState.startGround[2]);
                if (!p) return;
                sm.position[0] = Math.round(transformState.startPosition[0] + p[0] - transformState.startGround[0]);
                sm.position[1] = Math.round(transformState.startPosition[1] + p[1] - transformState.startGround[1]);
            } else if (transformState.axis === 'yz') {
                const p = axisPlanePointFromEvent(e, 'x', transformState.startGround[0]);
                if (!p) return;
                sm.position[1] = Math.round(transformState.startPosition[1] + p[1] - transformState.startGround[1]);
                sm.position[2] = Math.round(transformState.startPosition[2] + p[2] - transformState.startGround[2]);
            } else {
                const p = groundPointFromEvent(e);
                if (!p || !transformState.startGround) return;
                const dx = p[0] - transformState.startGround[0];
                const dz = p[2] - transformState.startGround[2];
                const dy = -(e.clientY - transformState.startClientY) * 0.03;
                if (transformState.axis === 'x') sm.position[0] = Math.round(transformState.startPosition[0] + dx);
                else if (transformState.axis === 'y') sm.position[1] = Math.round(transformState.startPosition[1] + dy);
                else if (transformState.axis === 'z') sm.position[2] = Math.round(transformState.startPosition[2] + dz);
                else {
                    // 'xz' or null — both move in the ground plane
                    sm.position[0] = Math.round(transformState.startPosition[0] + dx);
                    sm.position[2] = Math.round(transformState.startPosition[2] + dz);
                }
            }
        } else if (transformState.mode === 'rotate') {
            const pointerAngle = pointerAngleForModel(sm, e);
            const delta = -angleDeltaDeg(transformState.startAngle, pointerAngle);
            sm.rotation = [...transformState.startRotation];
            if (transformState.axis === 'x') sm.rotation[0] = snapDegrees(transformState.startRotation[0] + delta, 15);
            else if (transformState.axis === 'z') sm.rotation[2] = snapDegrees(transformState.startRotation[2] + delta, 15);
            else sm.rotation[1] = snapDegrees(transformState.startRotation[1] + delta, 15);
        } else {
            const snap025 = (v: number) => Math.max(0.25, Math.round(v * 4) / 4);
            const dist = pointerDistanceForModel(sm, e);
            sm.scale = [...transformState.startScale];
            const factor = Math.max(0.05, dist / transformState.startDistance);
            if (transformState.axis === null) {
                sm.scale = transformState.startScale.map((s) => snap025(s * factor)) as [number, number, number];
            } else if (transformState.axis === 'xz') {
                sm.scale[0] = snap025(transformState.startScale[0] * factor);
                sm.scale[2] = snap025(transformState.startScale[2] * factor);
            } else if (transformState.axis === 'xy') {
                sm.scale[0] = snap025(transformState.startScale[0] * factor);
                sm.scale[1] = snap025(transformState.startScale[1] * factor);
            } else if (transformState.axis === 'yz') {
                sm.scale[1] = snap025(transformState.startScale[1] * factor);
                sm.scale[2] = snap025(transformState.startScale[2] * factor);
            } else {
                const p = groundPointFromEvent(e);
                const dx = p && transformState.startGround ? p[0] - transformState.startGround[0] : 0;
                const dz = p && transformState.startGround ? p[2] - transformState.startGround[2] : 0;
                const dy = -(e.clientY - transformState.startClientY) * 0.03;
                if (transformState.axis === 'x') sm.scale[0] = snap025(transformState.startScale[0] + dx * 0.1);
                else if (transformState.axis === 'y') sm.scale[1] = snap025(transformState.startScale[1] + dy * 0.1);
                else sm.scale[2] = snap025(transformState.startScale[2] + dz * 0.1);
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

        let closest: SceneModel | null = null;
        let closestT = Infinity;
        for (const sm of sceneModels) {
            if (!sm.meshBounds) continue;
            const m = buildModelMatrix(sm.position, sm.rotation, sm.scale);
            const box = computeWorldAABB(sm.meshBounds, m);
            const t = rayHitsAABB(o[0], o[1], o[2], d[0], d[1], d[2], box);
            if (t !== null && t < closestT) {
                closestT = t;
                closest = sm;
            }
        }

        if (closest) {
            const willSelect = selectedModelId !== closest.id;
            if (willSelect) stickyGizmoMode = 'translate';
            selectedModelId = willSelect ? closest.id : null;
            selectedInstanceId = null;
            transformState = null;
            rebuildInstances();
            renderer.setHoverSnap(null);
            return;
        } else {
            selectedModelId = null;
            selectedInstanceId = null;
            transformState = null;
        }
        rebuildInstances();
        renderer.setHoverSnap(null);
    }

    window.addEventListener('keydown', (e) => {
        if (isEditableTarget(e.target)) return;
        const key = e.key.toLowerCase();
        if (key === 'delete' || key === 'backspace') {
            if (deleteSelectedModel()) {
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
        } else if (key === 'c' && !e.shiftKey) {
            renderer.toggleColliderOverlay();
            e.preventDefault();
        } else if (key === 'c' && e.shiftKey) {
            saveCurrentCamera();
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

    canvas.addEventListener('drop', async (e) => {
        e.preventDefault();
        isDraggingFromSidebar = false;
        dropOverlay.classList.remove('active');
        renderer.setHoverSnap(null);

        const payload = e.dataTransfer?.getData('text/plain')?.trim();
        if (!payload) return;

        const pos: [number, number, number] = groundSnapFromEvent(e) ?? [0, 0, 0];

        const blueprintName = payload.startsWith('blueprint:') ? payload.slice('blueprint:'.length) : payload;
        const loadedModel = await ensureBlueprintLoaded(blueprintName);
        if (!loadedModel) return;
        pushHistory();
        sceneModels.push({
            id: `sm:${sceneModelCounter++}`,
            blueprintName,
            position: pos,
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            loadedModel,
            meshBounds: boundsCache.get(blueprintName) ?? null,
        });

        rebuildInstances();
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
        const eye = orbit.getEye();
        renderer.render(eye[0], eye[1], eye[2], orbit.target[0], orbit.target[1], orbit.target[2], FOV_Y, 0.1, 500);
        updateAxisLabels();
        requestAnimationFrame(loop);
    }

    requestAnimationFrame(loop);
}

main().catch(console.error);
