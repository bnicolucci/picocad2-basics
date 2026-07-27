import { install_orbit_camera_controls, OrbitCamera, OrbitCameraController } from '../core/camera';
import type { LoadedBlueprint } from '../core/game';
import type { PrimitiveSpec } from '../core/primitives';
import {
    createPrimitiveUvAtlasTransform,
    type PrimitiveUvAtlasTransform,
    remapPrimitiveNodeUvs,
} from '../core/uv_remap';
import { buildLocalMeshFromMeshAsset, buildMeshAssetFromPicoNode } from '../mesh';
import type { PicoCad2Node } from '../picocad2';
import { makePicoModelMirrorMatrix } from '../scene';
import { type ColliderOverlayBody, EditorRenderer, type PlacedInstance } from './editor_game_renderer';
import { buildModelMatrix, findNodeByMeshId, identityMatrix, meshIdToPath, multiplyMat4, rotateScaledLocalOffset } from './editor_math';
import { cloneCamera, type SaveData, type SavedEditorCamera, type SaveObject, sanitizeCamera } from './editor_scene_save';

type BlueprintModule = Record<string, unknown>;
type ModelMeshPart = {
    meshId: string;
    localMatrix: Float32Array;
    uvAtlasTransform?: PrimitiveUvAtlasTransform;
};
type LoadedModel = {
    parts: ModelMeshPart[];
    materialId: string;
    blueprint: LoadedBlueprint;
};
type PreviewSceneModel = SaveObject & {
    id: string;
    loadedModel: LoadedModel;
    uvRootPart?: ModelMeshPart;
};

const BLUEPRINT_FILES = import.meta.glob('../blueprints/blu_*.ts') as Record<string, () => Promise<BlueprintModule>>;

type NumberCameraKey =
    | 'fovYRadians'
    | 'near'
    | 'far'
    | 'minDistance'
    | 'maxDistance'
    | 'minPitch'
    | 'maxPitch'
    | 'rotateSpeed'
    | 'panSpeed'
    | 'wheelZoomSpeed'
    | 'touchRotateSpeed'
    | 'touchPanSpeed'
    | 'touchPinchZoomSpeed';

const OPTIONAL_NUMBERS: Array<{ key: NumberCameraKey; label: string; step: string }> = [
    { key: 'fovYRadians', label: 'fovYRadians', step: '0.001' },
    { key: 'near', label: 'near', step: '0.01' },
    { key: 'far', label: 'far', step: '0.1' },
    { key: 'minDistance', label: 'minDistance', step: '0.01' },
    { key: 'maxDistance', label: 'maxDistance', step: '0.01' },
    { key: 'minPitch', label: 'minPitch', step: '0.001' },
    { key: 'maxPitch', label: 'maxPitch', step: '0.001' },
    { key: 'rotateSpeed', label: 'rotateSpeed', step: '0.001' },
    { key: 'panSpeed', label: 'panSpeed', step: '0.001' },
    { key: 'wheelZoomSpeed', label: 'wheelZoomSpeed', step: '0.0001' },
    { key: 'touchRotateSpeed', label: 'touchRotateSpeed', step: '0.001' },
    { key: 'touchPanSpeed', label: 'touchPanSpeed', step: '0.001' },
    { key: 'touchPinchZoomSpeed', label: 'touchPinchZoomSpeed', step: '0.0001' },
];

const query = new URLSearchParams(window.location.search);

let saveData: SaveData = { version: 1, objects: [], cameras: [] };
let activeCameraName: string | null = null;

const canvas = byId<HTMLCanvasElement>('viewport');
const viewportWrap = byId<HTMLElement>('viewport-wrap');
const renderer = EditorRenderer.create(canvas);
const ro = new ResizeObserver(() => renderer.resize());
ro.observe(viewportWrap);
renderer.resize();
const orbit = new OrbitCamera([0, 1.4, 0], 15);
orbit.yaw = 2.35;
orbit.pitch = 0.38;
orbit.distance = 15;
orbit.minDistance = 0.05;
orbit.maxDistance = 1000;
const orbitCtrl = new OrbitCameraController(orbit, {
    rotateSpeed: 0.008,
    wheelZoomSpeed: 0.001,
    panSpeed: 1.0,
});
install_orbit_camera_controls(canvas, orbitCtrl);
let lastPreviewTime = performance.now();
let syncingOrbitFromForm = false;
let syncingFormFromOrbit = false;

const loadedModels = new Map<string, LoadedModel>();
const previewModels: PreviewSceneModel[] = [];

const saveFileSelect = byId<HTMLSelectElement>('save-file');
const cameraSelect = byId<HTMLSelectElement>('camera-select');
const cameraNameInput = byId<HTMLInputElement>('camera-name');
const defaultCameraInput = byId<HTMLInputElement>('default-camera');
const statusEl = byId<HTMLElement>('status');

const requiredInputs = {
    targetX: byId<HTMLInputElement>('target-x'),
    targetY: byId<HTMLInputElement>('target-y'),
    targetZ: byId<HTMLInputElement>('target-z'),
    distance: byId<HTMLInputElement>('distance'),
    yaw: byId<HTMLInputElement>('yaw'),
    pitch: byId<HTMLInputElement>('pitch'),
};

const fogInputs = {
    useFog: byId<HTMLInputElement>('use-fog'),
    color: byId<HTMLInputElement>('fog-color'),
    r: byId<HTMLInputElement>('fog-r'),
    g: byId<HTMLInputElement>('fog-g'),
    b: byId<HTMLInputElement>('fog-b'),
    near: byId<HTMLInputElement>('fog-near'),
    far: byId<HTMLInputElement>('fog-far'),
    enabled: byId<HTMLInputElement>('fog-enabled'),
};

const optionalRows = new Map<NumberCameraKey, { checkbox: HTMLInputElement; input: HTMLInputElement }>();
let enableTouchCheckbox: HTMLInputElement | null = null;
let enableTouchValueInput: HTMLInputElement | null = null;

function byId<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing #${id}`);
    return el as T;
}

function picoNodeTransformToMatrix(node: PicoCad2Node): Float32Array {
    const t = node.transform;
    if (!t) return identityMatrix();
    return buildModelMatrix(
        [t.pos?.x ?? 0, t.pos?.y ?? 0, t.pos?.z ?? 0],
        [((t.rot?.x ?? 0) * 180) / Math.PI, ((t.rot?.y ?? 0) * 180) / Math.PI, ((t.rot?.z ?? 0) * 180) / Math.PI],
        [t.scale?.x ?? 1, t.scale?.y ?? 1, t.scale?.z ?? 1],
    );
}

function collectMeshParts(
    node: PicoCad2Node,
    modelId: string,
    path: number[],
    parentMatrix: Float32Array,
    out: ModelMeshPart[],
): void {
    const localMatrix = multiplyMat4(parentMatrix, picoNodeTransformToMatrix(node));

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

function previewModelToInstances(sm: PreviewSceneModel): PlacedInstance[] {
    const base = buildModelMatrix(sm.position, sm.rotation, sm.scale);
    const parts = sm.uvRootPart ? [sm.uvRootPart, ...sm.loadedModel.parts.slice(1)] : sm.loadedModel.parts;
    return parts.map((part, pi) => ({
        id: `${sm.id}:${pi}`,
        meshId: part.meshId,
        materialId: sm.loadedModel.materialId,
        worldMatrix: multiplyMat4(base, part.localMatrix),
        uvAtlasTransform: part.uvAtlasTransform,
    }));
}

function currentCameras(): SavedEditorCamera[] {
    if (!saveData.cameras) saveData.cameras = [];
    return saveData.cameras;
}

function currentCamera(): SavedEditorCamera | null {
    return currentCameras().find((camera) => camera.name === activeCameraName) ?? currentCameras()[0] ?? null;
}

function parseNumber(input: HTMLInputElement, fallback: number): number {
    const value = Number(input.value);
    return Number.isFinite(value) ? value : fallback;
}

function formatNumberInput(value: number | undefined): string {
    return value === undefined ? '' : Number(value.toFixed(6)).toString();
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function componentToHex(value: number): string {
    return Math.round(clamp01(value) * 255)
        .toString(16)
        .padStart(2, '0');
}

function rgbToHex(rgb: [number, number, number]): string {
    return `#${componentToHex(rgb[0])}${componentToHex(rgb[1])}${componentToHex(rgb[2])}`;
}

function hexToRgb(hex: string): [number, number, number] {
    const clean = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : '14171f';
    return [parseInt(clean.slice(0, 2), 16) / 255, parseInt(clean.slice(2, 4), 16) / 255, parseInt(clean.slice(4, 6), 16) / 255];
}

function isEditingNumberField(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLInputElement && (active.type === 'number' || active.type === 'text');
}

function cameraNameFromInput(value: string): string {
    const clean = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return clean || 'camera';
}

function uniqueCameraName(requested: string, current: SavedEditorCamera): string {
    const base = cameraNameFromInput(requested);
    let candidate = base;
    let index = 2;
    while (currentCameras().some((camera) => camera !== current && camera.name === candidate)) {
        candidate = `${base}_${index++}`;
    }
    return candidate;
}

function nextCameraName(): string {
    let index = currentCameras().length + 1;
    while (currentCameras().some((camera) => camera.name === `camera_${index}`)) index++;
    return `camera_${index}`;
}

function setStatus(message: string): void {
    statusEl.textContent = message;
}

function applyCameraToOrbit(camera: SavedEditorCamera): void {
    syncingOrbitFromForm = true;
    orbit.minDistance = Math.max(0.05, camera.minDistance ?? 0.05);
    orbit.maxDistance = Math.max(orbit.minDistance + 0.01, camera.maxDistance ?? 1000);
    orbitCtrl.snapToOrbitPose({
        targetX: camera.target[0],
        targetY: camera.target[1],
        targetZ: camera.target[2],
        yaw: camera.yaw,
        pitch: camera.pitch,
        distance: camera.distance,
    });
    orbitCtrl.setDistanceLimits({
        minDistance: camera.minDistance,
        maxDistance: camera.maxDistance,
        distance: camera.distance,
    });
    syncingOrbitFromForm = false;
}

function syncCurrentCameraFromOrbit(): void {
    if (syncingOrbitFromForm) return;
    const camera = currentCamera();
    if (!camera) return;
    syncingFormFromOrbit = true;
    camera.target = [...orbit.target];
    camera.yaw = orbit.yaw;
    camera.pitch = orbit.pitch;
    camera.distance = orbit.distance;
    if (!isEditingNumberField()) {
        requiredInputs.targetX.value = formatNumberInput(camera.target[0]);
        requiredInputs.targetY.value = formatNumberInput(camera.target[1]);
        requiredInputs.targetZ.value = formatNumberInput(camera.target[2]);
        requiredInputs.distance.value = formatNumberInput(camera.distance);
        requiredInputs.yaw.value = formatNumberInput(camera.yaw);
        requiredInputs.pitch.value = formatNumberInput(camera.pitch);
    }
    syncingFormFromOrbit = false;
}

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

async function ensureBlueprintLoaded(name: string): Promise<LoadedModel | null> {
    const cached = loadedModels.get(name);
    if (cached) return cached;

    const blueprint = await loadBlueprint(name);
    if (!blueprint?.node || !blueprint.data.texture) return null;

    const parts: ModelMeshPart[] = [];
    collectMeshParts(blueprint.node, name, [], makePicoModelMirrorMatrix(), parts);
    if (parts.length === 0) return null;

    for (const desc of parts) {
        const node = findNodeByMeshId(blueprint.node, name, desc.meshId);
        if (!node) continue;
        const asset = buildMeshAssetFromPicoNode(node, name, meshIdToPath(desc.meshId, name));
        if (!asset) continue;
        renderer.addMesh(desc.meshId, buildLocalMeshFromMeshAsset(asset));
    }

    const material = blueprint.buildMaterial(`camera-editor:${name}`);
    const tex = material.texture;
    renderer.addMaterial(material.materialId, {
        width: tex.width,
        height: tex.height,
        pixels: tex.pixels,
        palettePixels: tex.palettePixels,
        transparentIndex: tex.transparentIndex,
    });

    const loaded: LoadedModel = { parts, materialId: material.materialId, blueprint };
    loadedModels.set(name, loaded);
    return loaded;
}

function buildPreviewColliderShapes(models: PreviewSceneModel[]): ColliderOverlayBody[] {
    const shapes: ColliderOverlayBody[] = [];
    for (const sm of models) {
        const { blueprint } = sm.loadedModel;
        const collider = blueprint.collider;
        if (!collider) continue;
        const [sx, sy, sz] = sm.scale;
        const off = collider.offset ?? [0, 0, 0];
        const rotatedOff = rotateScaledLocalOffset(sm.rotation, sm.scale ?? [1, 1, 1], off);
        const adjustedPos: [number, number, number] = [
            sm.position[0] + rotatedOff[0],
            sm.position[1] + rotatedOff[1],
            sm.position[2] + rotatedOff[2],
        ];
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

async function rebuildPreviewScene(): Promise<void> {
    previewModels.length = 0;
    let index = 0;
    for (const obj of saveData.objects) {
        const blueprintName = 'blueprint' in obj ? obj.blueprint : (obj as SaveObject & { file?: string }).file;
        if (!blueprintName) continue;
        const loadedModel = await ensureBlueprintLoaded(blueprintName);
        if (!loadedModel) continue;
        const model: PreviewSceneModel = {
            id: `preview:${index++}`,
            blueprint: blueprintName,
            position: obj.position,
            rotation: obj.rotation ?? [0, 0, 0],
            scale: obj.scale ?? [1, 1, 1],
            loadedModel,
        };
        const uvOverride = (obj as SaveObject).uvOverride;
        if (uvOverride && loadedModel.blueprint.primitive) {
            const rootPart = loadedModel.parts[0];
            if (rootPart) {
                const node = findNodeByMeshId(loadedModel.blueprint.node, blueprintName, rootPart.meshId);
                if (node) {
                    const remapped = remapPrimitiveNodeUvs(node, uvOverride);
                    const meshKey = `uvoverride:${model.id}:u${uvOverride.u}v${uvOverride.v}t${uvOverride.tileSize}r${uvOverride.repeatU ?? 1}x${uvOverride.repeatV ?? 1}`;
                    const asset = buildMeshAssetFromPicoNode(remapped, meshKey, meshIdToPath(rootPart.meshId, blueprintName));
                    if (asset) {
                        renderer.addMesh(meshKey, buildLocalMeshFromMeshAsset(asset));
                        const useRepeat = (uvOverride.repeatU ?? 1) !== 1 || (uvOverride.repeatV ?? 1) !== 1;
                        model.uvRootPart = {
                            meshId: meshKey,
                            localMatrix: rootPart.localMatrix,
                            uvAtlasTransform: useRepeat
                                ? createPrimitiveUvAtlasTransform(uvOverride as PrimitiveSpec)
                                : undefined,
                        };
                    }
                }
            }
        }
        previewModels.push(model);
    }
    renderer.setInstances(previewModels.flatMap(previewModelToInstances));
    renderer.setColliderShapes(buildPreviewColliderShapes(previewModels));
}

function createOptionalRows(): void {
    const wrap = byId<HTMLElement>('optional-fields');
    for (const option of OPTIONAL_NUMBERS) {
        const row = document.createElement('div');
        row.className = 'optional-row';

        const checkWrap = document.createElement('div');
        checkWrap.className = 'check-row';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `use-${option.key}`;
        const label = document.createElement('label');
        label.htmlFor = checkbox.id;
        label.textContent = option.label;
        checkWrap.append(checkbox, label);

        const input = document.createElement('input');
        input.className = 'input';
        input.type = 'number';
        input.step = option.step;

        checkbox.addEventListener('change', () => {
            const camera = currentCamera();
            if (!camera) return;
            input.disabled = !checkbox.checked;
            if (checkbox.checked) camera[option.key] = parseNumber(input, 0);
            else delete camera[option.key];
            if (option.key === 'minDistance' || option.key === 'maxDistance') applyCameraToOrbit(camera);
        });

        input.addEventListener('input', () => {
            const camera = currentCamera();
            if (!camera || !checkbox.checked) return;
            camera[option.key] = parseNumber(input, camera[option.key] ?? 0);
            if (option.key === 'minDistance' || option.key === 'maxDistance') applyCameraToOrbit(camera);
        });

        row.append(checkWrap, input);
        wrap.appendChild(row);
        optionalRows.set(option.key, { checkbox, input });
    }

    const row = document.createElement('div');
    row.className = 'optional-row';
    const checkWrap = document.createElement('div');
    checkWrap.className = 'check-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'use-enable-touch';
    const label = document.createElement('label');
    label.htmlFor = checkbox.id;
    label.textContent = 'enableTouch';
    checkWrap.append(checkbox, label);

    const valueWrap = document.createElement('div');
    valueWrap.className = 'check-row';
    const valueCheckbox = document.createElement('input');
    valueCheckbox.type = 'checkbox';
    valueCheckbox.id = 'enable-touch-value';
    const valueLabel = document.createElement('label');
    valueLabel.htmlFor = valueCheckbox.id;
    valueLabel.textContent = 'true';
    valueWrap.append(valueCheckbox, valueLabel);

    checkbox.addEventListener('change', () => {
        const camera = currentCamera();
        if (!camera) return;
        valueCheckbox.disabled = !checkbox.checked;
        if (checkbox.checked) camera.enableTouch = valueCheckbox.checked;
        else delete camera.enableTouch;
    });
    valueCheckbox.addEventListener('change', () => {
        const camera = currentCamera();
        if (!camera || !checkbox.checked) return;
        camera.enableTouch = valueCheckbox.checked;
    });

    row.append(checkWrap, valueWrap);
    wrap.appendChild(row);
    enableTouchCheckbox = checkbox;
    enableTouchValueInput = valueCheckbox;
}

function refreshCameraSelect(): void {
    const cameras = currentCameras();
    const selected = activeCameraName ?? cameras[0]?.name ?? '';
    cameraSelect.replaceChildren();

    if (cameras.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No saved cameras';
        cameraSelect.appendChild(option);
        cameraSelect.disabled = true;
        activeCameraName = null;
        return;
    }

    cameraSelect.disabled = false;
    for (const camera of cameras) {
        const option = document.createElement('option');
        option.value = camera.name;
        option.textContent = camera.name === saveData.defaultCamera ? `${camera.name} (default)` : camera.name;
        cameraSelect.appendChild(option);
    }

    cameraSelect.value = cameras.some((camera) => camera.name === selected) ? selected : cameras[0].name;
    activeCameraName = cameraSelect.value;
}

function renderCameraForm(): void {
    const camera = currentCamera();
    const disabled = !camera;
    for (const input of Object.values(requiredInputs)) input.disabled = disabled;
    cameraNameInput.disabled = disabled;
    defaultCameraInput.disabled = disabled;

    for (const { checkbox, input } of optionalRows.values()) {
        checkbox.disabled = disabled;
        input.disabled = disabled || !checkbox.checked;
    }
    if (enableTouchCheckbox && enableTouchValueInput) {
        enableTouchCheckbox.disabled = disabled;
        enableTouchValueInput.disabled = disabled || !enableTouchCheckbox.checked;
    }
    for (const input of Object.values(fogInputs)) input.disabled = disabled;

    if (!camera) {
        cameraNameInput.value = '';
        defaultCameraInput.checked = false;
        return;
    }

    applyCameraToOrbit(camera);
    cameraNameInput.value = camera.name;
    defaultCameraInput.checked = saveData.defaultCamera === camera.name;
    requiredInputs.targetX.value = formatNumberInput(camera.target[0]);
    requiredInputs.targetY.value = formatNumberInput(camera.target[1]);
    requiredInputs.targetZ.value = formatNumberInput(camera.target[2]);
    requiredInputs.distance.value = formatNumberInput(camera.distance);
    requiredInputs.yaw.value = formatNumberInput(camera.yaw);
    requiredInputs.pitch.value = formatNumberInput(camera.pitch);

    for (const option of OPTIONAL_NUMBERS) {
        const row = optionalRows.get(option.key);
        if (!row) continue;
        const value = camera[option.key];
        row.checkbox.checked = typeof value === 'number';
        row.input.disabled = !row.checkbox.checked;
        row.input.value = formatNumberInput(typeof value === 'number' ? value : undefined);
    }
    if (enableTouchCheckbox && enableTouchValueInput) {
        enableTouchCheckbox.checked = typeof camera.enableTouch === 'boolean';
        enableTouchValueInput.checked = camera.enableTouch === true;
        enableTouchValueInput.disabled = !enableTouchCheckbox.checked;
    }

    fogInputs.useFog.checked = Boolean(camera.fog);
    fogInputs.color.value = rgbToHex(camera.fog?.color ?? [0.08, 0.09, 0.12]);
    fogInputs.r.value = formatNumberInput(camera.fog?.color?.[0]);
    fogInputs.g.value = formatNumberInput(camera.fog?.color?.[1]);
    fogInputs.b.value = formatNumberInput(camera.fog?.color?.[2]);
    fogInputs.near.value = formatNumberInput(camera.fog?.near);
    fogInputs.far.value = formatNumberInput(camera.fog?.far);
    fogInputs.enabled.checked = camera.fog?.enabled === true;
    updateFogDisabledState();
}

function updateRequiredCameraFields(): void {
    if (syncingFormFromOrbit) return;
    const camera = currentCamera();
    if (!camera) return;
    camera.target = [
        parseNumber(requiredInputs.targetX, camera.target[0]),
        parseNumber(requiredInputs.targetY, camera.target[1]),
        parseNumber(requiredInputs.targetZ, camera.target[2]),
    ];
    camera.distance = parseNumber(requiredInputs.distance, camera.distance);
    camera.yaw = parseNumber(requiredInputs.yaw, camera.yaw);
    camera.pitch = parseNumber(requiredInputs.pitch, camera.pitch);
    applyCameraToOrbit(camera);
}

function updateFogDisabledState(): void {
    const disabled = !currentCamera() || !fogInputs.useFog.checked;
    fogInputs.r.disabled = disabled;
    fogInputs.g.disabled = disabled;
    fogInputs.b.disabled = disabled;
    fogInputs.color.disabled = disabled;
    fogInputs.near.disabled = disabled;
    fogInputs.far.disabled = disabled;
    fogInputs.enabled.disabled = disabled;
}

function updateFog(source: 'numbers' | 'picker' = 'numbers'): void {
    const camera = currentCamera();
    if (!camera) return;
    if (!fogInputs.useFog.checked) {
        delete camera.fog;
        updateFogDisabledState();
        return;
    }

    const color =
        source === 'picker'
            ? hexToRgb(fogInputs.color.value)
            : ([parseNumber(fogInputs.r, 0.08), parseNumber(fogInputs.g, 0.09), parseNumber(fogInputs.b, 0.12)] as [
                  number,
                  number,
                  number,
              ]);
    camera.fog = {
        color,
        near: parseNumber(fogInputs.near, 28),
        far: parseNumber(fogInputs.far, 80),
        enabled: fogInputs.enabled.checked,
    };
    if (source === 'picker') {
        fogInputs.r.value = formatNumberInput(color[0]);
        fogInputs.g.value = formatNumberInput(color[1]);
        fogInputs.b.value = formatNumberInput(color[2]);
    } else {
        fogInputs.color.value = rgbToHex(color);
    }
    updateFogDisabledState();
}

function renderPreview(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastPreviewTime) / 1000);
    lastPreviewTime = now;
    const camera = currentCamera();
    const orbitChanged = orbitCtrl.update(dt);
    if (orbitChanged) syncCurrentCameraFromOrbit();
    renderer.resize();
    if (camera) {
        const eye = orbit.getEye();
        renderer.render(
            eye[0],
            eye[1],
            eye[2],
            orbit.target[0],
            orbit.target[1],
            orbit.target[2],
            camera.fovYRadians ?? Math.PI / 3,
            camera.near ?? 0.1,
            camera.far ?? 500,
            camera.fog
                ? {
                      color: camera.fog.color ?? [0.08, 0.09, 0.12],
                      near: camera.fog.near ?? 28,
                      far: camera.fog.far ?? 80,
                      enabled: camera.fog.enabled,
                  }
                : undefined,
        );
    } else {
        renderer.render(8, 8, 8, 0, 0, 0, Math.PI / 3, 0.1, 500);
    }
    requestAnimationFrame(renderPreview);
}

async function refreshSaveList(preferred = query.get('file') ?? 'new_scene.json'): Promise<void> {
    const res = await fetch('/__editor/list-editor-saves');
    if (!res.ok) throw new Error(`Failed to list editor saves: ${await res.text()}`);
    const data = (await res.json()) as { files?: unknown };
    const files = Array.isArray(data.files) ? data.files.filter((file): file is string => typeof file === 'string') : [];
    const selected = files.includes(preferred) ? preferred : (files[0] ?? 'new_scene.json');

    saveFileSelect.replaceChildren();
    for (const file of files.length > 0 ? files : [selected]) {
        const option = document.createElement('option');
        option.value = file;
        option.textContent = file;
        saveFileSelect.appendChild(option);
    }
    saveFileSelect.value = selected;
}

async function loadSelectedSave(): Promise<void> {
    const fileName = saveFileSelect.value || 'new_scene.json';
    const res = await fetch(`/__editor/load-editor-save?file=${encodeURIComponent(fileName)}`);
    if (!res.ok) throw new Error(`Failed to load editor save: ${await res.text()}`);
    const loaded = (await res.json()) as SaveData;
    if (loaded.version !== 1) throw new Error('Unknown scene version');

    const cameras = (loaded.cameras ?? []).map(sanitizeCamera).filter((camera): camera is SavedEditorCamera => camera !== null);
    saveData = {
        ...loaded,
        cameras,
        activeCamera:
            loaded.activeCamera && cameras.some((camera) => camera.name === loaded.activeCamera)
                ? loaded.activeCamera
                : cameras[0]?.name,
        defaultCamera:
            loaded.defaultCamera && cameras.some((camera) => camera.name === loaded.defaultCamera)
                ? loaded.defaultCamera
                : undefined,
    };
    activeCameraName = saveData.activeCamera ?? cameras[0]?.name ?? null;
    await rebuildPreviewScene();
    refreshCameraSelect();
    renderCameraForm();
    setStatus(`Loaded ${fileName}`);
}

async function saveSelectedSave(): Promise<void> {
    updateRequiredCameraFields();
    updateFog();
    const fileName = saveFileSelect.value || 'new_scene.json';
    saveData.cameras = currentCameras().map(cloneCamera);
    saveData.activeCamera = activeCameraName ?? undefined;
    const res = await fetch('/__editor/save-editor-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, source: JSON.stringify(saveData, null, 2) }),
    });

    if (!res.ok) throw new Error(`Failed to save editor save: ${await res.text()}`);
    setStatus(`Saved ${fileName}`);
}

function addCamera(): void {
    const camera: SavedEditorCamera = {
        name: nextCameraName(),
        target: [0, 1.4, 0],
        distance: 15,
        yaw: 2.35,
        pitch: 0.38,
    };
    currentCameras().push(camera);
    activeCameraName = camera.name;
    saveData.activeCamera = camera.name;
    refreshCameraSelect();
    renderCameraForm();
}

function installEvents(): void {
    byId<HTMLButtonElement>('load-save').addEventListener('click', () => {
        void loadSelectedSave().catch(showError);
    });
    byId<HTMLButtonElement>('save-save').addEventListener('click', () => {
        void saveSelectedSave().catch(showError);
    });
    byId<HTMLButtonElement>('add-camera').addEventListener('click', addCamera);
    byId<HTMLButtonElement>('scene-editor').addEventListener('click', () => {
        void saveSelectedSave()
            .then(() => {
                const params = new URLSearchParams({
                    file: saveFileSelect.value || 'new_scene.json',
                });
                if (activeCameraName) params.set('camera', activeCameraName);
                window.location.href = `editor.html?${params.toString()}`;
            })
            .catch(showError);
    });
    saveFileSelect.addEventListener('change', () => {
        void loadSelectedSave().catch(showError);
    });
    cameraSelect.addEventListener('change', () => {
        activeCameraName = cameraSelect.value || null;
        saveData.activeCamera = activeCameraName ?? undefined;
        renderCameraForm();
    });
    cameraNameInput.addEventListener('blur', () => {
        const camera = currentCamera();
        if (!camera) return;
        const oldName = camera.name;
        camera.name = uniqueCameraName(cameraNameInput.value, camera);
        if (saveData.activeCamera === oldName) saveData.activeCamera = camera.name;
        if (saveData.defaultCamera === oldName) saveData.defaultCamera = camera.name;
        activeCameraName = camera.name;
        refreshCameraSelect();
        renderCameraForm();
    });
    defaultCameraInput.addEventListener('change', () => {
        const camera = currentCamera();
        if (!camera) return;
        saveData.defaultCamera = defaultCameraInput.checked ? camera.name : undefined;
        refreshCameraSelect();
        renderCameraForm();
    });
    for (const input of Object.values(requiredInputs)) {
        input.addEventListener('input', updateRequiredCameraFields);
    }
    for (const input of Object.values(fogInputs)) {
        if (input === fogInputs.color) {
            input.addEventListener('input', () => updateFog('picker'));
            input.addEventListener('change', () => updateFog('picker'));
        } else {
            input.addEventListener('input', () => updateFog('numbers'));
            input.addEventListener('change', () => updateFog('numbers'));
        }
    }
}

function showError(err: unknown): void {
    console.error(err);
    setStatus(err instanceof Error ? err.message : String(err));
}

async function main(): Promise<void> {
    createOptionalRows();
    installEvents();
    requestAnimationFrame(renderPreview);
    await refreshSaveList();
    await loadSelectedSave();
}

main().catch(showError);
