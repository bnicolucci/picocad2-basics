import { VERTEX_FLOATS } from './mesh';
import type { Object3D } from './object3d';
import type { MotionTracks, PicoCadAnimationClip } from './picocad2';

// Plays a PicoCadAnimationClip (a "<mesh>_animations.ts" registry entry) over
// an instantiated model's node tree. Clips bind by node NAME; deltas are
// applied on top of each node's rest transform, exactly like picoCAD2's own
// player: pos/scale add, rot adds in turns (×2π), `visible` segments hide the
// node inside their window, and `tex` segments scroll a face's UVs.
//
// The editor preview and the game drive playback through this same code, so
// what plays in the editor is what plays in-game.

const TAU = Math.PI * 2;
const UV_U = 3;
const UV_V = 4;

type Segment = {
    axises: readonly string[];
    prop: string;
    curve: string;
    start: number;
    stop: number;
    delta: number;
    pingpong: boolean;
    times?: number;
};

type TexSegment = {
    axis: 'x' | 'y';
    faceIndex: number;
    start: number;
    stop: number;
    frames: number;
    step: number;
    returnUv: boolean;
};

function applyEaseCurve(p: number, curve: string): number {
    p = Math.max(0, Math.min(1, p));
    if (curve === 'ease in' || curve === 'ease_in') return p ** 5;
    if (curve === 'ease out' || curve === 'ease_out') {
        const q = p - 1;
        return q ** 5 + 1;
    }
    if (curve === 'soft') {
        const t = p * 2;
        if (t < 1) return 0.5 * t * t;
        const t2 = t - 1;
        return -0.5 * (t2 * (t2 - 2) - 1);
    }
    if (curve === 'elastic') {
        const s = 1.70158;
        const q = p - 1;
        return q * q * ((s + 1) * q + s) + 1;
    }
    if (curve === 'bounce') {
        const n = 7.5625;
        const d = 2.75;
        if (p < 1 / d) return n * p * p;
        if (p < 2 / d) {
            const pp = p - 1.5 / d;
            return n * pp * pp + 0.75;
        }
        if (p < 2.5 / d) {
            const pp = p - 2.25 / d;
            return n * pp * pp + 0.9375;
        }
        const pp = p - 2.625 / d;
        return n * pp * pp + 0.984375;
    }
    if (curve === 'instant') return p > 0 ? 1 : 0;
    return p;
}

function evalSegment(seg: Segment, beat: number): number {
    const { start, stop, delta, curve, pingpong, times } = seg;
    if (times !== undefined) {
        if (beat < start) return 0;
        const t = Math.min(beat, stop);
        const duration = Math.max(1e-6, stop - start);
        const phase = (times * TAU * (t - start)) / duration;
        return seg.prop === 'rot' ? (delta / 2) * Math.sin(phase) : delta * Math.sin(phase);
    }
    if (stop <= start) return 0;
    if (pingpong) {
        const mid = (start + stop) / 2;
        if (beat <= start || beat >= stop) return 0;
        if (beat <= mid) return delta * applyEaseCurve((beat - start) / (mid - start), curve);
        return delta * applyEaseCurve((stop - beat) / (stop - mid), curve);
    }
    if (beat <= start) return 0;
    if (beat >= stop) return delta;
    return delta * applyEaseCurve((beat - start) / (stop - start), curve);
}

function sumAxis(segments: Segment[], prop: string, axis: string, beat: number): number {
    let total = 0;
    for (const seg of segments) {
        if (seg.prop !== prop || !seg.axises.includes(axis)) continue;
        total += evalSegment(seg, beat);
    }
    return total;
}

// Frame N shows the Nth tile over (offset (frameIndex+1)*step), continuous
// with the post-stop hold value — matches picoCAD2's Blender importer.
function evalTexFramePx(seg: TexSegment, beat: number): number {
    const { start, stop, frames, step, returnUv } = seg;
    if (beat < start) return 0;
    if (beat >= stop) return returnUv ? 0 : frames * step;
    const duration = Math.max(1e-6, stop - start);
    const frameLen = duration / frames;
    const frameIndex = Math.min(frames - 1, Math.floor((beat - start) / frameLen));
    return (frameIndex + 1) * step;
}

/** A clip's timeline length: picoCAD2's motion_duration, else the last stop. */
export function clipDuration(clip: PicoCadAnimationClip): number {
    if (clip.motionDuration > 1e-4) return clip.motionDuration;
    let maxStop = 0;
    for (const tracks of Object.values(clip.tracks)) {
        for (const slot of tracks) {
            for (const seg of slot) {
                if ((seg.stop ?? 0) > maxStop) maxStop = seg.stop ?? 0;
            }
        }
    }
    return maxStop > 1e-4 ? maxStop : 1;
}

type Binding = {
    object: Object3D;
    segments: Segment[];
    hasVisible: boolean;
    orig: { px: number; py: number; pz: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number; visible: boolean };
    tex: { meshIndex: number; original: Float32Array; work: Float32Array; ranges: { start: number; count: number }[]; segments: TexSegment[] } | null;
};

const active = new Set<PicoCadAnimator>();

/** Advance every playing animator; called once per frame by the run loop. */
export function advanceAnimators(clock: number): void {
    for (const animator of active) animator.advance(clock);
}

export type PlayOptions = {
    loop?: boolean;
    speed?: number;
    /** Clock value (seconds) playback starts from; defaults to 0. */
    start?: number;
};

export class PicoCadAnimator {
    readonly duration: number;
    /** Clip node names the model has no node for — the "nothing happened" trap. */
    readonly unmatched: string[] = [];
    private readonly bindings: Binding[] = [];
    private readonly root: Object3D;
    private readonly loop: boolean;
    private readonly speed: number;
    private readonly startClock: number;
    private readonly textureWidth: number;
    private readonly textureHeight: number;

    constructor(root: Object3D, clip: PicoCadAnimationClip, opts: PlayOptions = {}) {
        this.root = root;
        this.loop = opts.loop ?? true;
        this.speed = opts.speed ?? 1;
        this.startClock = opts.start ?? 0;
        this.duration = clipDuration(clip);
        this.textureWidth = clip.textureWidth || 128;
        this.textureHeight = clip.textureHeight || 128;

        for (const [nodeName, tracks] of Object.entries(clip.tracks)) {
            const object = root.getObjectByName(nodeName);
            if (!object) {
                this.unmatched.push(nodeName);
                continue;
            }
            const binding = this.bind(object, tracks);
            if (binding) this.bindings.push(binding);
        }
        if (this.bindings.length > 0) active.add(this);
    }

    get isPlaying(): boolean {
        return active.has(this);
    }

    private bind(object: Object3D, tracks: MotionTracks): Binding | null {
        const segments: Segment[] = [];
        const texSegments: TexSegment[] = [];
        for (const slot of tracks) {
            for (const seg of slot) {
                if (seg.prop === 'tex') {
                    if (seg.face_id === undefined) continue;
                    for (const axis of seg.axises ?? []) {
                        if (axis !== 'x' && axis !== 'y') continue;
                        texSegments.push({
                            axis,
                            faceIndex: seg.face_id - 1,
                            start: seg.start ?? 0,
                            stop: seg.stop ?? 0,
                            frames: Math.max(1, seg.frames ?? 1),
                            step: seg.step ?? 0,
                            returnUv: seg.return_uv ?? false,
                        });
                    }
                    continue;
                }
                if (!seg.prop) continue;
                segments.push({
                    axises: seg.axises ?? [],
                    prop: seg.prop,
                    curve: seg.curve ?? 'linear',
                    start: seg.start ?? 0,
                    stop: seg.stop ?? 0,
                    delta: seg.delta ?? 0,
                    pingpong: seg.pingpong ?? false,
                    times: seg.times,
                });
            }
        }

        let tex: Binding['tex'] = null;
        if (texSegments.length > 0 && object.meshIndex !== null && this.root.model) {
            const mesh = this.root.model.model.meshes[object.meshIndex];
            if (mesh) {
                tex = {
                    meshIndex: object.meshIndex,
                    original: mesh.vertices,
                    work: new Float32Array(mesh.vertices),
                    ranges: mesh.faceVertexRanges,
                    segments: texSegments,
                };
            }
        }

        if (segments.length === 0 && !tex) return null;
        return {
            object,
            segments,
            hasVisible: segments.some((s) => s.prop === 'visible'),
            orig: {
                px: object.position.x, py: object.position.y, pz: object.position.z,
                rx: object.rotation.x, ry: object.rotation.y, rz: object.rotation.z,
                sx: object.scale.x, sy: object.scale.y, sz: object.scale.z,
                visible: object.visible,
            },
            tex,
        };
    }

    advance(clock: number): void {
        const elapsed = (clock - this.startClock) * this.speed;
        // A finished one-shot restores the rest pose and unregisters itself.
        if (!this.loop && elapsed >= this.duration) {
            this.stop();
            return;
        }
        const beat = this.loop
            ? ((elapsed % this.duration) + this.duration) % this.duration
            : Math.min(elapsed, this.duration);

        for (const binding of this.bindings) {
            const { object, segments, orig } = binding;
            object.position.set(
                orig.px + sumAxis(segments, 'pos', 'x', beat),
                orig.py + sumAxis(segments, 'pos', 'y', beat),
                orig.pz + sumAxis(segments, 'pos', 'z', beat),
            );
            object.rotation.set(
                orig.rx + sumAxis(segments, 'rot', 'x', beat) * TAU,
                orig.ry + sumAxis(segments, 'rot', 'y', beat) * TAU,
                orig.rz + sumAxis(segments, 'rot', 'z', beat) * TAU,
            );
            object.scale.set(
                orig.sx + sumAxis(segments, 'scale', 'x', beat),
                orig.sy + sumAxis(segments, 'scale', 'y', beat),
                orig.sz + sumAxis(segments, 'scale', 'z', beat),
            );

            if (binding.hasVisible) {
                let hidden = !orig.visible;
                for (const seg of segments) {
                    if (seg.prop !== 'visible') continue;
                    if (beat >= seg.start && beat < seg.stop) {
                        hidden = true;
                        break;
                    }
                }
                object.visible = !hidden;
            }

            if (binding.tex) this.applyTex(binding.tex, beat);
        }
    }

    // Reset UVs to the original mesh, then offset each animated face's UVs by
    // its accumulated scroll, summed per face in timeline order.
    private applyTex(tex: NonNullable<Binding['tex']>, beat: number): void {
        const { original, work, ranges, segments, meshIndex } = tex;
        work.set(original);
        const sorted = [...segments].sort((a, b) => a.start - b.start);
        const accum = new Map<number, { u: number; v: number }>();
        for (const seg of sorted) {
            const prev = accum.get(seg.faceIndex) ?? { u: 0, v: 0 };
            const px = evalTexFramePx(seg, beat);
            accum.set(seg.faceIndex, {
                u: prev.u + (seg.axis === 'x' ? px / this.textureWidth : 0),
                v: prev.v + (seg.axis === 'y' ? px / this.textureHeight : 0),
            });
        }
        for (const [faceIndex, { u, v }] of accum) {
            const range = ranges[faceIndex];
            if (!range || range.count === 0) continue;
            for (let i = 0; i < range.count; i++) {
                const base = (range.start + i) * VERTEX_FLOATS;
                work[base + UV_U] += u;
                work[base + UV_V] -= v;
            }
        }
        this.root.model?.pendingUpdates.set(meshIndex, work);
    }

    /** Restore every bound node to its rest state and stop advancing. */
    stop(): void {
        for (const binding of this.bindings) {
            const { object, orig } = binding;
            object.position.set(orig.px, orig.py, orig.pz);
            object.rotation.set(orig.rx, orig.ry, orig.rz);
            object.scale.set(orig.sx, orig.sy, orig.sz);
            object.visible = orig.visible;
            if (binding.tex) this.root.model?.pendingUpdates.set(binding.tex.meshIndex, binding.tex.original);
        }
        active.delete(this);
    }
}

/** Play a clip on an instantiated model; returns the animator (loops by default). */
export function playClip(root: Object3D, clip: PicoCadAnimationClip, opts?: PlayOptions): PicoCadAnimator {
    return new PicoCadAnimator(root, clip, opts);
}
