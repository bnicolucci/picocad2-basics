import type { CameraFog } from '../core/camera';
import { build_camera_frame, type Camera, create_camera } from '../core/camera';
import type { PrimitiveUvAtlasTransform } from '../core/uv_remap';
import type { BuiltMesh } from '../mesh';
import { type MaterialTextureData, type PickHit, Renderer } from '../renderer';
import type { RenderInstance } from '../scene';

export type EditorMaterialData = {
    width: number;
    height: number;
    pixels: Uint8Array;
    palettePixels: Uint8Array;
    transparentIndex: number;
};

export type PlacedInstance = {
    id: string;
    meshId: string;
    materialId: string;
    worldMatrix: Float32Array;
    selected?: boolean;
    uvAtlasTransform?: PrimitiveUvAtlasTransform;
};

export type HoverSnap = {
    pos: [number, number, number];
    footprint: [number, number, number, number];
} | null;

export type RotateRing = {
    pos: [number, number, number];
    footprint: [number, number, number, number];
    active?: boolean;
} | null;

export type TransformMode = 'translate' | 'rotate' | 'scale';
export type TransformAxis = 'x' | 'y' | 'z' | 'xy' | 'xz' | 'yz' | null;

export type TransformGizmo = {
    pos: [number, number, number];
    radius: number;
    mode: TransformMode | null;
    axis: TransformAxis;
} | null;

export type ColliderOverlayBody = {
    shape: 'box' | 'sphere';
    matrix: Float32Array;
    halfX: number;
    halfY: number;
    halfZ: number;
    radius: number;
};

function axisColor(axis: 'x' | 'y' | 'z', active: boolean): string {
    const a = active ? 1 : 0.55;
    if (axis === 'x') return `rgba(240, 52, 42, ${a})`;
    if (axis === 'y') return `rgba(76, 230, 62, ${a})`;
    return `rgba(62, 123, 245, ${a})`;
}

function axisColorFill(axis: 'x' | 'y' | 'z', active: boolean): string {
    const a = active ? 0.35 : 0.12;
    if (axis === 'x') return `rgba(240, 52, 42, ${a})`;
    if (axis === 'y') return `rgba(76, 230, 62, ${a})`;
    return `rgba(62, 123, 245, ${a})`;
}

function editorMatrixToRendererWorldMatrix(matrix: Float32Array): Float32Array {
    return new Float32Array(matrix);
}

export class EditorRenderer {
    private canvas: HTMLCanvasElement;
    private overlay: HTMLCanvasElement;
    private overlayCtx: CanvasRenderingContext2D;
    private gameRenderer: Renderer | null = null;
    private rebuildPromise: Promise<void> | null = null;
    private rebuildVersion = 0;
    private meshes = new Map<string, BuiltMesh>();
    private materials = new Map<string, MaterialTextureData>();
    private instances: PlacedInstance[] = [];
    private hoverSnap: HoverSnap = null;
    private rotateRing: RotateRing = null;
    private transformGizmo: TransformGizmo = null;
    private colliderShapes: ColliderOverlayBody[] = [];
    private colliderOverlayEnabled = true;
    private wireframeEnabled = false;
    private camera: Camera = create_camera();
    private lastViewProjection: Float32Array | null = null;

    private constructor(canvas: HTMLCanvasElement, overlay: HTMLCanvasElement, overlayCtx: CanvasRenderingContext2D) {
        this.canvas = canvas;
        this.overlay = overlay;
        this.overlayCtx = overlayCtx;
    }

    static create(canvas: HTMLCanvasElement): EditorRenderer {
        const overlay = document.createElement('canvas');
        overlay.style.position = 'absolute';
        overlay.style.inset = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.pointerEvents = 'none';
        overlay.style.zIndex = '1';
        canvas.style.position = 'relative';
        canvas.style.zIndex = '0';
        canvas.parentElement?.appendChild(overlay);

        const ctx = overlay.getContext('2d');
        if (!ctx) throw new Error('2D overlay canvas is not available');

        return new EditorRenderer(canvas, overlay, ctx);
    }

    addMesh(meshId: string, mesh: BuiltMesh): void {
        this.meshes.set(meshId, mesh);
        this.scheduleRendererRebuild();
    }

    addMaterial(materialId: string, data: EditorMaterialData): void {
        this.materials.set(materialId, {
            materialId,
            texture: {
                width: data.width,
                height: data.height,
                pixels: data.pixels,
                palettePixels: data.palettePixels,
                transparentIndex: data.transparentIndex,
            },
        });
        this.scheduleRendererRebuild();
    }

    setInstances(instances: PlacedInstance[]): void {
        this.instances = instances;
        this.updateGameRenderInstances();
    }

    setHoverSnap(snap: HoverSnap): void {
        this.hoverSnap = snap;
    }

    setRotateRing(ring: RotateRing): void {
        this.rotateRing = ring;
    }

    setTransformGizmo(gizmo: TransformGizmo): void {
        this.transformGizmo = gizmo;
    }

    setColliderShapes(shapes: ColliderOverlayBody[]): void {
        this.colliderShapes = shapes;
    }

    toggleWireframe(): void {
        this.wireframeEnabled = !this.wireframeEnabled;
        this.gameRenderer?.setWireframeEnabled(this.wireframeEnabled);
    }

    toggleColliderOverlay(): void {
        this.colliderOverlayEnabled = !this.colliderOverlayEnabled;
    }

    pick(clientXOrEvent: number | { clientX: number; clientY: number }, clientY?: number): PickHit | null {
        return this.gameRenderer?.pick(clientXOrEvent, clientY) ?? null;
    }

    resize(): void {
        const dpr = Math.min(devicePixelRatio || 1, 2);
        const rect = this.canvas.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width * dpr));
        const height = Math.max(1, Math.round(rect.height * dpr));
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
        if (this.overlay.width !== width || this.overlay.height !== height) {
            this.overlay.width = width;
            this.overlay.height = height;
        }
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
    }

    projectToScreen(x: number, y: number, z: number, cw: number, ch: number): [number, number] | null {
        if (!this.lastViewProjection) return null;
        const m = this.lastViewProjection;
        const clipX = m[0] * x + m[4] * y + m[8] * z + m[12];
        const clipY = m[1] * x + m[5] * y + m[9] * z + m[13];
        const clipW = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (clipW <= 0) return null;
        const ndcX = clipX / clipW;
        const ndcY = clipY / clipW;
        return [(ndcX + 1) * 0.5 * cw, (1 - ndcY) * 0.5 * ch];
    }

    render(
        ex: number,
        ey: number,
        ez: number,
        tx: number,
        ty: number,
        tz: number,
        fovY = Math.PI / 3,
        near = 0.1,
        far = 500,
        fog?: CameraFog,
    ): void {
        this.resize();
        this.camera = create_camera({
            position: [ex, ey, ez],
            target: [tx, ty, tz],
            up: [0, 1, 0],
            fovYRadians: fovY,
            near,
            far,
            fog,
        });
        const frame = build_camera_frame(this.camera, Math.max(1, this.canvas.width) / Math.max(1, this.canvas.height));
        this.lastViewProjection = frame.viewProjection;
        if (this.gameRenderer) {
            this.gameRenderer.updateCamera(this.camera);
            this.updateGameRenderInstances();
        }
        this.drawOverlay();
    }

    private scheduleRendererRebuild(): void {
        const version = ++this.rebuildVersion;
        if (this.rebuildPromise) return;
        this.rebuildPromise = Promise.resolve().then(async () => {
            this.rebuildPromise = null;
            if (version !== this.rebuildVersion) {
                this.scheduleRendererRebuild();
                return;
            }
            await this.rebuildGameRenderer();
        });
    }

    private async rebuildGameRenderer(): Promise<void> {
        if (this.meshes.size === 0 || this.materials.size === 0) return;
        const previous = this.gameRenderer;
        previous?.stopAnimationLoop();
        const renderer = await Renderer.create(
            this.canvas,
            [...this.materials.values()],
            new Map(this.meshes),
            this.toRenderInstances(),
            this.camera,
            {
                retroRenderScale: 1,
                maxPixelRatio: 2,
                lockAspectRatio: false,
                viewBackgroundColor: '#1a1f24',
            },
        );
        this.gameRenderer = renderer;
        this.resize();
        renderer.setWireframeEnabled(this.wireframeEnabled);
        renderer.setSelectedNodeId(this.selectedNodeId());
        renderer.setAnimationLoop(() => {
            renderer.updateCamera(this.camera);
            renderer.updateRenderInstances(this.toRenderInstances());
        });
    }

    private updateGameRenderInstances(): void {
        if (!this.gameRenderer) return;
        this.gameRenderer.setSelectedNodeId(this.selectedNodeId());
        this.gameRenderer.updateRenderInstances(this.toRenderInstances());
    }

    private selectedNodeId(): string | null {
        const selected = this.instances.find((instance) => instance.selected);
        return selected?.id ?? null;
    }

    private toRenderInstances(): RenderInstance[] {
        return this.instances.map((instance) => {
            const ri: RenderInstance & { uvAtlasTransform?: PrimitiveUvAtlasTransform } = {
                nodeId: instance.id,
                nodeName: instance.id,
                meshAssetId: instance.meshId,
                materialId: instance.materialId,
                visible: true,
                worldMatrix: editorMatrixToRendererWorldMatrix(instance.worldMatrix),
            };
            if (instance.uvAtlasTransform) ri.uvAtlasTransform = instance.uvAtlasTransform;
            return ri;
        });
    }

    private drawOverlay(): void {
        const ctx = this.overlayCtx;
        const w = this.overlay.width;
        const h = this.overlay.height;
        ctx.clearRect(0, 0, w, h);
        ctx.lineCap = 'round';
        this.drawGrid();
        this.drawColliderShapes();
        this.drawHoverSnap();
        this.drawRotateRing();
        this.drawTransformGizmo();
    }

    private line(a: [number, number, number], b: [number, number, number], color: string, width = 1): void {
        const pa = this.projectToScreen(a[0], a[1], a[2], this.overlay.width, this.overlay.height);
        const pb = this.projectToScreen(b[0], b[1], b[2], this.overlay.width, this.overlay.height);
        if (!pa || !pb) return;
        const ctx = this.overlayCtx;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(pa[0], pa[1]);
        ctx.lineTo(pb[0], pb[1]);
        ctx.stroke();
    }

    private transformLocalPoint(m: Float32Array, vx: number, vy: number, vz: number): [number, number, number] {
        return [
            m[0] * vx + m[4] * vy + m[8] * vz + m[12],
            m[1] * vx + m[5] * vy + m[9] * vz + m[13],
            m[2] * vx + m[6] * vy + m[10] * vz + m[14],
        ];
    }

    private drawColliderShapes(): void {
        if (!this.colliderOverlayEnabled) return;
        const color = 'rgba(40, 255, 65, 0.85)';
        for (const body of this.colliderShapes) {
            const m = body.matrix;
            const tp = (vx: number, vy: number, vz: number): [number, number, number] => this.transformLocalPoint(m, vx, vy, vz);

            if (body.shape === 'box') {
                const { halfX: hx, halfY: hy, halfZ: hz } = body;
                for (const sy of [-1, 1] as const)
                    for (const sz of [-1, 1] as const) this.line(tp(-hx, sy * hy, sz * hz), tp(hx, sy * hy, sz * hz), color, 1.5);
                for (const sx of [-1, 1] as const)
                    for (const sz of [-1, 1] as const) this.line(tp(sx * hx, -hy, sz * hz), tp(sx * hx, hy, sz * hz), color, 1.5);
                for (const sx of [-1, 1] as const)
                    for (const sy of [-1, 1] as const) this.line(tp(sx * hx, sy * hy, -hz), tp(sx * hx, sy * hy, hz), color, 1.5);
            } else if (body.shape === 'sphere') {
                const r = body.radius;
                const segs = 32;
                for (let i = 0; i < segs; i++) {
                    const a0 = (i / segs) * Math.PI * 2;
                    const a1 = ((i + 1) / segs) * Math.PI * 2;
                    this.line(tp(r * Math.cos(a0), 0, r * Math.sin(a0)), tp(r * Math.cos(a1), 0, r * Math.sin(a1)), color, 1.5);
                    this.line(tp(r * Math.cos(a0), r * Math.sin(a0), 0), tp(r * Math.cos(a1), r * Math.sin(a1), 0), color, 1.5);
                    this.line(tp(0, r * Math.cos(a0), r * Math.sin(a0)), tp(0, r * Math.cos(a1), r * Math.sin(a1)), color, 1.5);
                }
            }
        }
    }

    private drawGrid(): void {
        for (let i = -20; i <= 20; i++) {
            const color = i === 0 ? 'rgba(120, 115, 105, 0.65)' : 'rgba(80, 80, 80, 0.35)';
            this.line([i, 0, -20], [i, 0, 20], color);
            this.line([-20, 0, i], [20, 0, i], color);
        }
        this.line([-22, 0.01, 0], [22, 0.01, 0], 'rgba(220, 50, 50, 0.9)', 1.5);
        this.line([0, 0.01, -22], [0, 0.01, 22], 'rgba(60, 120, 240, 0.9)', 1.5);
    }

    private drawHoverSnap(): void {
        if (!this.hoverSnap) return;
        const {
            pos: [sx, , sz],
            footprint: [rx0, rx1, rz0, rz1],
        } = this.hoverSnap;
        const x0 = sx + rx0,
            x1 = sx + rx1,
            z0 = sz + rz0,
            z1 = sz + rz1;
        const pts = [
            this.projectToScreen(x0, 0.02, z0, this.overlay.width, this.overlay.height),
            this.projectToScreen(x1, 0.02, z0, this.overlay.width, this.overlay.height),
            this.projectToScreen(x1, 0.02, z1, this.overlay.width, this.overlay.height),
            this.projectToScreen(x0, 0.02, z1, this.overlay.width, this.overlay.height),
        ];
        if (pts.some((p) => !p)) return;
        const ctx = this.overlayCtx;
        ctx.fillStyle = 'rgba(255, 210, 45, 0.16)';
        ctx.strokeStyle = 'rgba(255, 220, 60, 0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pts[0]![0], pts[0]![1]);
        for (const p of pts.slice(1)) ctx.lineTo(p![0], p![1]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        this.line([x0, 0.03, (z0 + z1) * 0.5], [x1, 0.03, (z0 + z1) * 0.5], 'rgba(255, 220, 60, 0.75)', 1.5);
        this.line([(x0 + x1) * 0.5, 0.03, z0], [(x0 + x1) * 0.5, 0.03, z1], 'rgba(255, 220, 60, 0.75)', 1.5);
    }

    private drawRotateRing(): void {
        if (!this.rotateRing) return;
        const {
            pos: [sx, , sz],
            footprint: [rx0, rx1, rz0, rz1],
            active,
        } = this.rotateRing;
        const cx = sx + (rx0 + rx1) * 0.5;
        const cz = sz + (rz0 + rz1) * 0.5;
        const radius = Math.max(0.75, Math.hypot(Math.abs(rx1 - rx0) * 0.5, Math.abs(rz1 - rz0) * 0.5) + 0.45);
        const color = active ? 'rgba(64, 255, 190, 0.95)' : 'rgba(64, 240, 190, 0.75)';
        let prev: [number, number, number] | null = null;
        for (let i = 0; i <= 96; i++) {
            const a = (i / 96) * Math.PI * 2;
            const p: [number, number, number] = [cx + Math.cos(a) * radius, 0.06, cz + Math.sin(a) * radius];
            if (prev) this.line(prev, p, color, 4);
            prev = p;
        }
    }

    private drawArrowhead(tip: [number, number], dirX: number, dirY: number, size: number, color: string): void {
        const ctx = this.overlayCtx;
        const perpX = -dirY;
        const perpY = dirX;
        const baseX = tip[0] - dirX * size;
        const baseY = tip[1] - dirY * size;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(tip[0], tip[1]);
        ctx.lineTo(baseX + perpX * size * 0.45, baseY + perpY * size * 0.45);
        ctx.lineTo(baseX - perpX * size * 0.45, baseY - perpY * size * 0.45);
        ctx.closePath();
        ctx.fill();
    }

    private drawPlaneSquareWorld(corners: [number, number, number][], fillColor: string, strokeColor: string): void {
        const w = this.overlay.width;
        const h = this.overlay.height;
        const pts = corners.map((c) => this.projectToScreen(c[0], c[1], c[2], w, h));
        if (pts.some((p) => !p)) return;
        const ctx = this.overlayCtx;
        ctx.fillStyle = fillColor;
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(pts[0]![0], pts[0]![1]);
        for (const p of pts.slice(1)) ctx.lineTo(p![0], p![1]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }

    private drawScaleHandleSS(screenPos: [number, number], size: number, color: string): void {
        const ctx = this.overlayCtx;
        ctx.fillStyle = color;
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(screenPos[0] - size * 0.5, screenPos[1] - size * 0.5, size, size);
        ctx.fill();
        ctx.stroke();
    }

    private drawTranslateGizmo(cx: number, cy: number, cz: number, len: number, axis: TransformAxis): void {
        const w = this.overlay.width;
        const h = this.overlay.height;
        const baseY = cy + 0.08;
        const sqO = len * 0.2;
        const sq = len * 0.32;

        // Plane squares (drawn first so axis arrows render on top)
        // XZ plane (Y locked → green)
        this.drawPlaneSquareWorld(
            [
                [cx + sqO, baseY, cz + sqO],
                [cx + sqO + sq, baseY, cz + sqO],
                [cx + sqO + sq, baseY, cz + sqO + sq],
                [cx + sqO, baseY, cz + sqO + sq],
            ],
            axisColorFill('y', axis === 'xz'),
            axisColor('y', axis === 'xz'),
        );
        // XY plane (Z locked → blue)
        this.drawPlaneSquareWorld(
            [
                [cx + sqO, cy + sqO, cz],
                [cx + sqO + sq, cy + sqO, cz],
                [cx + sqO + sq, cy + sqO + sq, cz],
                [cx + sqO, cy + sqO + sq, cz],
            ],
            axisColorFill('z', axis === 'xy'),
            axisColor('z', axis === 'xy'),
        );
        // YZ plane (X locked → red)
        this.drawPlaneSquareWorld(
            [
                [cx, cy + sqO, cz + sqO],
                [cx, cy + sqO, cz + sqO + sq],
                [cx, cy + sqO + sq, cz + sqO + sq],
                [cx, cy + sqO + sq, cz + sqO],
            ],
            axisColorFill('x', axis === 'yz'),
            axisColor('x', axis === 'yz'),
        );

        const drawAxisArrow = (tip: [number, number, number], origin: [number, number, number], a: 'x' | 'y' | 'z'): void => {
            const active = axis === a;
            this.line(origin, tip, axisColor(a, active), active ? 4 : 2.5);
            const tipSS = this.projectToScreen(tip[0], tip[1], tip[2], w, h);
            const orgSS = this.projectToScreen(origin[0], origin[1], origin[2], w, h);
            if (tipSS && orgSS) {
                const dx = tipSS[0] - orgSS[0];
                const dy = tipSS[1] - orgSS[1];
                const l = Math.hypot(dx, dy);
                if (l > 0.1) this.drawArrowhead(tipSS, dx / l, dy / l, 10, axisColor(a, active));
            }
        };

        drawAxisArrow([cx + len, baseY, cz], [cx, baseY, cz], 'x');
        drawAxisArrow([cx, cy + len, cz], [cx, cy, cz], 'y');
        drawAxisArrow([cx, baseY, cz + len], [cx, baseY, cz], 'z');
    }

    private drawRotateGizmo(cx: number, cy: number, cz: number, len: number, axis: TransformAxis): void {
        const segs = 64;
        const rings: Array<{ a: 'x' | 'y' | 'z'; pt: (ang: number) => [number, number, number] }> = [
            { a: 'x', pt: (ang) => [cx, cy + len * Math.cos(ang), cz + len * Math.sin(ang)] },
            { a: 'y', pt: (ang) => [cx + len * Math.cos(ang), cy, cz + len * Math.sin(ang)] },
            { a: 'z', pt: (ang) => [cx + len * Math.cos(ang), cy + len * Math.sin(ang), cz] },
        ];
        for (const { a, pt } of rings) {
            const active = axis === a;
            const color = axisColor(a, active);
            const lw = active ? 3 : 2;
            let prev: [number, number, number] | null = null;
            for (let i = 0; i <= segs; i++) {
                const p = pt((i / segs) * Math.PI * 2);
                if (prev) this.line(prev, p, color, lw);
                prev = p;
            }
        }
    }

    private drawScaleGizmo(cx: number, cy: number, cz: number, len: number, axis: TransformAxis): void {
        const w = this.overlay.width;
        const h = this.overlay.height;
        const baseY = cy + 0.08;
        const handleSize = 9;
        const sqO = len * 0.2;
        const sq = len * 0.32;

        // Plane squares (drawn first so axis lines render on top)
        this.drawPlaneSquareWorld(
            [
                [cx + sqO, baseY, cz + sqO],
                [cx + sqO + sq, baseY, cz + sqO],
                [cx + sqO + sq, baseY, cz + sqO + sq],
                [cx + sqO, baseY, cz + sqO + sq],
            ],
            axisColorFill('y', axis === 'xz'),
            axisColor('y', axis === 'xz'),
        );
        this.drawPlaneSquareWorld(
            [
                [cx + sqO, cy + sqO, cz],
                [cx + sqO + sq, cy + sqO, cz],
                [cx + sqO + sq, cy + sqO + sq, cz],
                [cx + sqO, cy + sqO + sq, cz],
            ],
            axisColorFill('z', axis === 'xy'),
            axisColor('z', axis === 'xy'),
        );
        this.drawPlaneSquareWorld(
            [
                [cx, cy + sqO, cz + sqO],
                [cx, cy + sqO, cz + sqO + sq],
                [cx, cy + sqO + sq, cz + sqO + sq],
                [cx, cy + sqO + sq, cz + sqO],
            ],
            axisColorFill('x', axis === 'yz'),
            axisColor('x', axis === 'yz'),
        );

        const drawScaleAxis = (tip: [number, number, number], origin: [number, number, number], a: 'x' | 'y' | 'z'): void => {
            const active = axis === a;
            this.line(origin, tip, axisColor(a, active), active ? 4 : 2.5);
            const tipSS = this.projectToScreen(tip[0], tip[1], tip[2], w, h);
            if (tipSS) this.drawScaleHandleSS(tipSS, handleSize, axisColor(a, active));
        };

        drawScaleAxis([cx + len, baseY, cz], [cx, baseY, cz], 'x');
        drawScaleAxis([cx, cy + len, cz], [cx, cy, cz], 'y');
        drawScaleAxis([cx, baseY, cz + len], [cx, baseY, cz], 'z');

        // Center uniform-scale handle
        const centerSS = this.projectToScreen(cx, baseY, cz, w, h);
        if (centerSS) {
            const uniActive = axis === null;
            this.drawScaleHandleSS(centerSS, handleSize * 1.4, uniActive ? 'rgba(255,255,255,0.95)' : 'rgba(200,200,200,0.65)');
        }
    }

    private drawTransformGizmo(): void {
        if (!this.transformGizmo) return;
        const {
            pos: [cx, cy, cz],
            radius,
            mode,
            axis,
        } = this.transformGizmo;
        const len = Math.max(1.4, radius);
        if (mode === 'rotate') {
            this.drawRotateGizmo(cx, cy, cz, len, axis);
        } else if (mode === 'scale') {
            this.drawScaleGizmo(cx, cy, cz, len, axis);
        } else {
            this.drawTranslateGizmo(cx, cy, cz, len, axis);
        }
    }
}
