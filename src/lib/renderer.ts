import type { Mat4 } from './math';
import { type GpuMesh, VERTEX_FLOATS } from './mesh';
import type { BuiltTexture } from './picocad2';

// Per-instance data lives in vertex attributes (divisor 1), not uniforms, so
// every copy of a mesh — 200 dungeon floor tiles, say — draws in ONE
// instanced call instead of one call each. Locations 0-4 come from the shared
// mesh buffer, 5-10 from the per-mesh instance buffer.
const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec3 a_normal;
layout(location = 3) in float a_colorIndex;
layout(location = 4) in float a_faceFlags;

layout(location = 5) in vec4 i_model0;
layout(location = 6) in vec4 i_model1;
layout(location = 7) in vec4 i_model2;
layout(location = 8) in vec4 i_model3;
// The instance's target UV rect (origin.xy, size.zw).
layout(location = 9) in vec4 i_uvDst;
// colorOverride (<0 = none), useUv, repeatU, repeatV.
layout(location = 10) in vec4 i_params;

uniform mat4 u_viewProj;

out vec2 v_uv;
out vec3 v_normal;
out float v_colorIndex;
out float v_faceFlags;
flat out vec4 v_uvDst;
flat out vec4 v_params;

void main() {
  mat4 model = mat4(i_model0, i_model1, i_model2, i_model3);
  v_uv = a_uv;
  v_normal = mat3(model) * a_normal;
  v_colorIndex = a_colorIndex;
  v_faceFlags = a_faceFlags;
  v_uvDst = i_uvDst;
  v_params = i_params;
  gl_Position = u_viewProj * model * vec4(a_position, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec3 v_normal;
in float v_colorIndex;
in float v_faceFlags;
flat in vec4 v_uvDst;
flat in vec4 v_params;

uniform sampler2D u_indexTexture;
uniform sampler2D u_paletteTexture;
uniform vec3 u_lightDir;
uniform float u_ambient;
uniform float u_transparentIndex;

// The model's own UV rect (origin.xy, size.zw) — the source the per-instance
// transform maps out of. Per model, so it stays a uniform.
uniform vec4 u_uvSrc;

out vec4 outColor;

// Sampled UVs are normalized within src, repeated, then mapped into the
// instance's dst rect.
vec2 applyUv(vec2 uv) {
  if (v_params.y < 0.5) return uv;
  vec2 local = (uv - u_uvSrc.xy) / max(u_uvSrc.zw, vec2(1e-6));
  local = fract(local * v_params.zw);
  return v_uvDst.xy + local * v_uvDst.zw;
}

void main() {
  int flags = int(v_faceFlags + 0.5);
  bool noShade = (flags & 1) != 0;
  bool noTex = (flags & 2) != 0;

  float colorIndex = v_colorIndex;
  if (v_params.x >= 0.0) {
    colorIndex = v_params.x;
  } else if (!noTex) {
    colorIndex = floor(texture(u_indexTexture, applyUv(v_uv)).r * 255.0 + 0.5);
    if (abs(colorIndex - u_transparentIndex) < 0.5) discard;
  }

  // Palette rows: 0 = lit, 1 = mid, 2 = dark. Picked by a stepped light term,
  // with a checker dither between rows — the picoCAD look.
  float paletteRow = 0.0;
  if (!noShade) {
    vec3 normal = normalize(v_normal);
    if (!gl_FrontFacing) normal = -normal;
    float rawDot = -dot(normal, u_lightDir);
    float lightFactor = 1.0 - (1.0 - rawDot) * (1.0 - rawDot);
    lightFactor = clamp(lightFactor, u_ambient, 1.0);
    if (lightFactor < 0.28) {
      paletteRow = 2.0;
    } else if (lightFactor < 0.50) {
      paletteRow = 1.0;
    } else if (lightFactor < 0.80) {
      float checker = mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.0);
      paletteRow = checker < 0.5 ? 1.0 : 0.0;
    }
  }

  vec2 paletteUv = vec2((colorIndex + 0.5) / 16.0, (paletteRow + 0.5) / 3.0);
  outColor = vec4(texture(u_paletteTexture, paletteUv).rgb, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) ?? 'shader compile failed');
    }
    return shader;
}

// Floats per instance row: mat4 (16) + uvDst (4) + params (4).
const INSTANCE_FLOATS = 24;

type DrawMesh = {
    vao: WebGLVertexArrayObject;
    vbo: WebGLBuffer;
    count: number;
    // Per-mesh instance buffer, refilled each frame with the rows for every
    // copy of this mesh visible right now.
    instanceVbo: WebGLBuffer;
    instanceData: Float32Array;
    instanceCount: number;
    /** Instances the GPU buffer is currently sized for. */
    capacity: number;
};

// An uploaded model: its per-node draw calls plus its own textures.
type UploadedModel = {
    meshes: DrawMesh[];
    indexTexture: WebGLTexture;
    paletteTexture: WebGLTexture;
    transparentIndex: number;
    // The model texture's pixel size — tile rects are expressed against it.
    textureWidth: number;
    textureHeight: number;
    // The model's own UV bounding rect [minU, minV, sizeU, sizeV], used as the
    // source rect for per-instance UV transforms.
    uvBounds: [number, number, number, number];
};

// A model's shared GPU-ready data: what the loader/primitives hand out and
// what the renderer uploads (once, cached per renderer).
export type ModelData = { meshes: GpuMesh[]; texture: BuiltTexture };

// Per-instance UV atlas transform. `repeatU/V` tiles the texture across the
// surface; `tile` optionally re-points to a different 16px atlas tile
// (1-based column/row) of the model's own texture.
export type UvTransform = {
    repeatU?: number;
    repeatV?: number;
    tile?: { u: number; v: number; size?: number };
};

// One thing to draw this frame: which model, where each of its meshes goes
// (`null` = that mesh is hidden this frame), how its texture is mapped, a flat
// palette-colour override, and pending vertex rewrites from UV-scroll
// animation.
export type Instance = {
    model: ModelData;
    meshMatrices: (Mat4 | null)[];
    uv?: UvTransform;
    color?: number;
    updates?: { meshIndex: number; vertices: Float32Array }[];
};

// Opaque index into the renderer's uploaded-model list.
type ModelHandle = number;

function hexToRgb(hex: string): [number, number, number] {
    const n = parseInt(hex.replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class Renderer {
    private gl: WebGL2RenderingContext;
    private program: WebGLProgram;
    private u: Record<string, WebGLUniformLocation | null> = {};
    private models: UploadedModel[] = [];
    canvas: HTMLCanvasElement;

    // Internal render resolution as a fraction of the displayed canvas size.
    // Mutable so it can be dialed in live (`renderer.retroScale = 0.25`).
    retroScale = 0.5;

    /** Draw calls issued by the last render — one per visible mesh, not per
        instance. `renderer.drawCalls` in the console to check a scene. */
    drawCalls = 0;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        // No antialiasing: picoCAD is crisp/aliased, and AA otherwise blends
        // every convex edge against the background into a dark hairline crack.
        const gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
        if (!gl) throw new Error('WebGL2 not available');
        this.gl = gl;

        const program = gl.createProgram()!;
        gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
        gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(program) ?? 'link failed');
        }
        this.program = program;
        const uniformNames = [
            'u_viewProj', 'u_indexTexture', 'u_paletteTexture', 'u_lightDir', 'u_ambient', 'u_transparentIndex', 'u_uvSrc',
        ];
        for (const name of uniformNames) {
            this.u[name] = gl.getUniformLocation(program, name);
        }

        gl.enable(gl.DEPTH_TEST);
    }

    // Upload a model's geometry + textures once; returns a handle to draw it
    // any number of times via render() instances.
    private upload({ meshes, texture }: ModelData): ModelHandle {
        const gl = this.gl;
        const drawMeshes: DrawMesh[] = [];

        for (const mesh of meshes) {
            if (mesh.indices.length === 0) continue;
            const vao = gl.createVertexArray()!;
            gl.bindVertexArray(vao);

            const vbo = gl.createBuffer()!;
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
            gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);

            const ibo = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

            const stride = VERTEX_FLOATS * 4;
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 3 * 4);
            gl.enableVertexAttribArray(2);
            gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 5 * 4);
            gl.enableVertexAttribArray(3);
            gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 8 * 4);
            gl.enableVertexAttribArray(4);
            gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 9 * 4);

            // Instance attributes: one row per copy, advanced once per instance.
            const instanceVbo = gl.createBuffer()!;
            gl.bindBuffer(gl.ARRAY_BUFFER, instanceVbo);
            const istride = INSTANCE_FLOATS * 4;
            for (let i = 0; i < 6; i++) {
                const location = 5 + i;
                gl.enableVertexAttribArray(location);
                gl.vertexAttribPointer(location, 4, gl.FLOAT, false, istride, i * 16);
                gl.vertexAttribDivisor(location, 1);
            }

            drawMeshes.push({
                vao,
                vbo,
                count: mesh.indices.length,
                instanceVbo,
                instanceData: new Float32Array(0),
                instanceCount: 0,
                capacity: 0,
            });
        }

        gl.bindVertexArray(null);
        this.models.push({
            meshes: drawMeshes,
            indexTexture: this.makeIndexTexture(texture),
            paletteTexture: this.makePaletteTexture(texture),
            transparentIndex: texture.transparentIndex,
            textureWidth: texture.width,
            textureHeight: texture.height,
            uvBounds: computeUvBounds(meshes),
        });
        return this.models.length - 1;
    }

    private makeIndexTexture(texture: BuiltTexture): WebGLTexture {
        const gl = this.gl;
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, texture.width, texture.height, 0, gl.RED, gl.UNSIGNED_BYTE, texture.indexPixels);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }

    private makePaletteTexture(texture: BuiltTexture): WebGLTexture {
        const gl = this.gl;
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 16, 3, 0, gl.RGBA, gl.UNSIGNED_BYTE, texture.palettePixels);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }

    // Clear colour, set from a hex string ('#1d2b53'); the harness passes
    // `scene.background` every frame and the conversion is cached.
    private background: [number, number, number] = [0, 0, 0];
    private backgroundHex = '';

    setBackground(hex: string): void {
        if (hex === this.backgroundHex) return;
        this.backgroundHex = hex;
        this.background = hexToRgb(hex);
    }

    render(viewProj: Mat4, lightDir: [number, number, number], instances: Instance[]): void {
        const gl = this.gl;
        // Render at a fraction of display resolution and let CSS upscale it
        // (image-rendering: pixelated) for the chunky retro look.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr * this.retroScale));
        const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr * this.retroScale));
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }

        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(this.background[0], this.background[1], this.background[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.u.u_viewProj, false, viewProj);
        gl.uniform3f(this.u.u_lightDir, lightDir[0], lightDir[1], lightDir[2]);
        gl.uniform1f(this.u.u_ambient, 0.15);

        // Uploaded on first sight, then grouped by model so every copy of a
        // mesh goes out in one instanced call and textures bind once.
        const byModel = new Map<ModelHandle, Instance[]>();
        for (const instance of instances) {
            const handle = this.handleFor(instance.model);
            const group = byModel.get(handle);
            if (group) group.push(instance);
            else byModel.set(handle, [instance]);
        }

        let drawCalls = 0;
        for (const [handle, group] of byModel) {
            const model = this.models[handle];
            for (const mesh of model.meshes) mesh.instanceCount = 0;

            for (const instance of group) {
                const row = this.instanceRow(instance, model);
                if (instance.updates) {
                    for (const { meshIndex, vertices } of instance.updates) {
                        const mesh = model.meshes[meshIndex];
                        if (!mesh) continue;
                        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
                        gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices);
                    }
                }
                for (let i = 0; i < model.meshes.length; i++) {
                    const matrix = instance.meshMatrices[i];
                    if (!matrix) continue;
                    const mesh = model.meshes[i];
                    if ((mesh.instanceCount + 1) * INSTANCE_FLOATS > mesh.instanceData.length) {
                        const grown = new Float32Array(Math.max(8, mesh.instanceCount * 2) * INSTANCE_FLOATS);
                        grown.set(mesh.instanceData);
                        mesh.instanceData = grown;
                    }
                    const offset = mesh.instanceCount * INSTANCE_FLOATS;
                    mesh.instanceData.set(matrix, offset);
                    mesh.instanceData.set(row, offset + 16);
                    mesh.instanceCount++;
                }
            }

            const [sx, sy, sw, sh] = model.uvBounds;
            gl.uniform4f(this.u.u_uvSrc, sx, sy, sw, sh);
            gl.uniform1f(this.u.u_transparentIndex, model.transparentIndex);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, model.indexTexture);
            gl.uniform1i(this.u.u_indexTexture, 0);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, model.paletteTexture);
            gl.uniform1i(this.u.u_paletteTexture, 1);

            for (const mesh of model.meshes) {
                if (mesh.instanceCount === 0) continue;
                gl.bindVertexArray(mesh.vao);
                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.instanceVbo);
                if (mesh.instanceCount > mesh.capacity) {
                    gl.bufferData(gl.ARRAY_BUFFER, mesh.instanceData.byteLength, gl.DYNAMIC_DRAW);
                    mesh.capacity = mesh.instanceData.length / INSTANCE_FLOATS;
                }
                gl.bufferSubData(gl.ARRAY_BUFFER, 0, mesh.instanceData, 0, mesh.instanceCount * INSTANCE_FLOATS);
                gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0, mesh.instanceCount);
                drawCalls++;
            }
        }
        gl.bindVertexArray(null);
        this.drawCalls = drawCalls;
    }

    /** The 8 per-instance floats after the matrix: uvDst, then colour
        override / useUv / repeat. */
    private readonly row = new Float32Array(8);

    private instanceRow(instance: Instance, model: UploadedModel): Float32Array {
        const row = this.row;
        const uv = instance.uv;
        if (uv) {
            const [sx, sy, sw, sh] = model.uvBounds;
            const size = uv.tile?.size ?? 16;
            const su = size / model.textureWidth;
            const sv = size / model.textureHeight;
            if (uv.tile) {
                row[0] = (uv.tile.u - 1) * su;
                row[1] = (uv.tile.v - 1) * sv;
                row[2] = su;
                row[3] = sv;
            } else {
                row[0] = sx;
                row[1] = sy;
                row[2] = sw;
                row[3] = sh;
            }
            row[5] = 1;
            row[6] = uv.repeatU ?? 1;
            row[7] = uv.repeatV ?? 1;
        } else {
            row[0] = row[1] = row[2] = row[3] = 0;
            row[5] = row[6] = row[7] = 0;
        }
        row[4] = instance.color ?? -1;
        return row;
    }

    // Upload-once cache for models built by the loader: the same Model object
    // always maps to the same handle on this renderer.
    private handleCache = new WeakMap<ModelData, ModelHandle>();

    private handleFor(model: ModelData): ModelHandle {
        let handle = this.handleCache.get(model);
        if (handle === undefined) {
            handle = this.upload(model);
            this.handleCache.set(model, handle);
        }
        return handle;
    }

    get aspect(): number {
        return this.canvas.width / this.canvas.height || 1;
    }
}

// UV bounding rect across all of a model's vertices (uv at floats 3,4 of 10).
function computeUvBounds(meshes: GpuMesh[]): [number, number, number, number] {
    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    for (const mesh of meshes) {
        const v = mesh.vertices;
        for (let i = 0; i < v.length; i += VERTEX_FLOATS) {
            const u = v[i + 3];
            const w = v[i + 4];
            if (u < minU) minU = u;
            if (w < minV) minV = w;
            if (u > maxU) maxU = u;
            if (w > maxV) maxV = w;
        }
    }
    if (minU > maxU) return [0, 0, 1, 1];
    return [minU, minV, maxU - minU, maxV - minV];
}
