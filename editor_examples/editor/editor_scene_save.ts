import type { SceneCameraDefinition } from '../core/game';
import type { PicoCadPaletteId } from '../palettes/picocad_palettes';

type EditorFogSettings = NonNullable<SceneCameraDefinition['fog']>;

export type SaveObjectUvOverride = {
    u: number;
    v: number;
    tileSize: number;
    repeatU?: number;
    repeatV?: number;
};

export type SaveObject = {
    blueprint?: string;
    model?: string;
    file?: string;
    prefab?: string;
    name?: string;
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
    uvOverride?: SaveObjectUvOverride;
    paletteOverride?: PicoCadPaletteId;
    textureOverride?: string;
};

export type SavedEditorCamera = {
    name: string;
    target: [number, number, number];
    yaw: number;
    pitch: number;
    distance: number;
    fovYRadians?: number;
    near?: number;
    far?: number;
    minDistance?: number;
    maxDistance?: number;
    minPitch?: number;
    maxPitch?: number;
    rotateSpeed?: number;
    panSpeed?: number;
    wheelZoomSpeed?: number;
    touchRotateSpeed?: number;
    touchPanSpeed?: number;
    touchPinchZoomSpeed?: number;
    enableTouch?: boolean;
    fog?: EditorFogSettings;
};

export type SaveData = {
    version: 1;
    objects: SaveObject[];
    cameras?: SavedEditorCamera[];
    activeCamera?: string;
    defaultCamera?: string;
};

function isNumberTuple3(value: unknown): value is [number, number, number] {
    return Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeFog(value: unknown): EditorFogSettings | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const source = value as Partial<EditorFogSettings>;
    const fog: EditorFogSettings = {};
    if (isNumberTuple3(source.color)) fog.color = [...source.color];
    if (source.near !== undefined) fog.near = optionalNumber(source.near);
    if (source.far !== undefined) fog.far = optionalNumber(source.far);
    if (source.enabled !== undefined) fog.enabled = source.enabled === true;
    return Object.keys(fog).length > 0 ? fog : undefined;
}

export function sanitizeCamera(value: unknown): SavedEditorCamera | null {
    if (!value || typeof value !== 'object') return null;
    const source = value as Partial<SavedEditorCamera>;
    if (
        typeof source.name !== 'string' ||
        !isNumberTuple3(source.target) ||
        typeof source.yaw !== 'number' ||
        typeof source.pitch !== 'number' ||
        typeof source.distance !== 'number'
    ) {
        return null;
    }

    const camera: SavedEditorCamera = {
        name: source.name,
        target: [...source.target],
        yaw: source.yaw,
        pitch: source.pitch,
        distance: source.distance,
    };

    for (const key of [
        'fovYRadians',
        'near',
        'far',
        'minDistance',
        'maxDistance',
        'minPitch',
        'maxPitch',
        'rotateSpeed',
        'panSpeed',
        'wheelZoomSpeed',
        'touchRotateSpeed',
        'touchPanSpeed',
        'touchPinchZoomSpeed',
    ] as const) {
        const next = optionalNumber(source[key]);
        if (next !== undefined) camera[key] = next;
    }

    if (source.enableTouch !== undefined) camera.enableTouch = source.enableTouch === true;
    const fog = sanitizeFog(source.fog);
    if (fog) camera.fog = fog;

    return camera;
}

export function cloneCamera(camera: SavedEditorCamera): SavedEditorCamera {
    return {
        ...camera,
        target: [...camera.target],
        fog: camera.fog
            ? {
                  ...camera.fog,
                  color: camera.fog.color ? [...camera.fog.color] : undefined,
              }
            : undefined,
    };
}
