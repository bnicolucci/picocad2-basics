import type { Mat4 } from './math';
import { multiply } from './math';
import { type GpuMesh, VERTEX_FLOATS } from './mesh';
import type { BuiltTexture } from './picocad2';

const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec3 a_normal;
layout(location = 3) in float a_colorIndex;
layout(location = 4) in float a_faceFlags;

uniform mat4 u_viewProj;
uniform mat4 u_model;

out vec2 v_uv;
out vec3 v_normal;
out float v_colorIndex;
out float v_faceFlags;

void main() {
  v_uv = a_uv;
  v_normal = mat3(u_model) * a_normal;
  v_colorIndex = a_colorIndex;
  v_faceFlags = a_faceFlags;
  gl_Position = u_viewProj * u_model * vec4(a_position, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec3 v_normal;
in float v_colorIndex;
in float v_faceFlags;

uniform sampler2D u_indexTexture;
uniform sampler2D u_paletteTexture;
uniform vec3 u_lightDir;
uniform float u_ambient;
uniform float u_transparentIndex;
// >= 0: draw every face in this flat (still shaded) palette colour.
uniform float u_colorOverride;

// Per-instance UV atlas transform. u_uvSrc is the model's own UV rect
// (origin.xy, size.zw); u_uvDst is the target tile rect. Sampled UVs are
// normalized within src, repeated, then mapped into dst.
uniform vec4 u_uvSrc;
uniform vec4 u_uvDst;
uniform vec2 u_uvRepeat;
uniform bool u_useUv;

out vec4 outColor;

vec2 applyUv(vec2 uv) {
  if (!u_useUv) return uv;
  vec2 local = (uv - u_uvSrc.xy) / max(u_uvSrc.zw, vec2(1e-6));
  local = fract(local * u_uvRepeat);
  return u_uvDst.xy + local * u_uvDst.zw;
}

void main() {
  int flags = int(v_faceFlags + 0.5);
  bool noShade = (flags & 1) != 0;
  bool noTex = (flags & 2) != 0;

  float colorIndex = v_colorIndex;
  if (u_colorOverride >= 0.0) {
    colorIndex = u_colorOverride;
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

// Internal render resolution as a fraction of the displayed canvas size.
// Mutable so it can be dialed in live (`retro.scale = 0.25` in the console).
export const retro = { scale: 0.5 };

type DrawMesh = { vao: WebGLVertexArrayObject; vbo: WebGLBuffer; count: number; localMatrix: Mat4 };

// An uploaded model: its per-node draw calls plus its own textures.
type UploadedModel = {
    meshes: DrawMesh[];
    indexTexture: WebGLTexture;
    paletteTexture: WebGLTexture;
    transparentIndex: number;
    // The model's own UV bounding rect [minU, minV, sizeU, sizeV], used as the
    // source rect for per-instance UV transforms.
    uvBounds: [number, number, number, number];
};

// Per-instance UV atlas transform. `repeatU/V` tiles the texture across the
// surface; `tile` optionally re-points to a different 16px atlas tile
// (1-based column/row). Atlas is 128px.
export type UvTransform = {
    repeatU?: number;
    repeatV?: number;
    tile?: { u: number; v: number; size?: number };
};

// One thing to draw this frame: which uploaded model, where, and how its
// texture is mapped. The scene layer additionally supplies per-mesh world
// matrices (`null` = that mesh is hidden this frame), a flat palette-colour
// override, and pending vertex rewrites from UV-scroll animation.
export type Instance = {
    model: ModelHandle;
    matrix: Mat4;
    uv?: UvTransform;
    color?: number;
    meshMatrices?: (Mat4 | null)[];
    updates?: { meshIndex: number; vertices: Float32Array }[];
};

// Opaque index into the renderer's uploaded-model list.
export type ModelHandle = number;

const ATLAS = 128;

export class Renderer {
    private gl: WebGL2RenderingContext;
    private program: WebGLProgram;
    private u: Record<string, WebGLUniformLocation | null> = {};
    private models: UploadedModel[] = [];
    canvas: HTMLCanvasElement;

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
            'u_viewProj', 'u_model', 'u_indexTexture', 'u_paletteTexture', 'u_lightDir', 'u_ambient', 'u_transparentIndex',
            'u_uvSrc', 'u_uvDst', 'u_uvRepeat', 'u_useUv', 'u_colorOverride',
        ];
        for (const name of uniformNames) {
            this.u[name] = gl.getUniformLocation(program, name);
        }

        gl.enable(gl.DEPTH_TEST);
    }

    // Upload a model's geometry + textures once; returns a handle to draw it
    // any number of times via render() instances.
    upload(meshes: GpuMesh[], texture: BuiltTexture): ModelHandle {
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

            drawMeshes.push({ vao, vbo, count: mesh.indices.length, localMatrix: mesh.localMatrix });
        }

        gl.bindVertexArray(null);
        this.models.push({
            meshes: drawMeshes,
            indexTexture: this.makeIndexTexture(texture),
            paletteTexture: this.makePaletteTexture(texture),
            transparentIndex: texture.transparentIndex,
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

    // Clear colour as [r, g, b] in 0..1. The scene layer sets this from
    // `scene.background`.
    background: [number, number, number] = [0.06, 0.08, 0.09];

    render(viewProj: Mat4, lightDir: [number, number, number], instances: Instance[]): void {
        const gl = this.gl;
        // Render at a fraction of display resolution and let CSS upscale it
        // (image-rendering: pixelated) for the chunky retro look.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr * retro.scale));
        const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr * retro.scale));
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

        let boundModel = -1;
        for (const inst of instances) {
            const model = this.models[inst.model];
            if (!model) continue;
            if (inst.model !== boundModel) {
                gl.uniform1f(this.u.u_transparentIndex, model.transparentIndex);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, model.indexTexture);
                gl.uniform1i(this.u.u_indexTexture, 0);
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, model.paletteTexture);
                gl.uniform1i(this.u.u_paletteTexture, 1);
                boundModel = inst.model;
            }

            if (inst.uv) {
                const [sx, sy, sw, sh] = model.uvBounds;
                const size = (inst.uv.tile?.size ?? 16) / ATLAS;
                const dst = inst.uv.tile
                    ? [(inst.uv.tile.u - 1) * size, (inst.uv.tile.v - 1) * size, size, size]
                    : [sx, sy, sw, sh];
                gl.uniform1i(this.u.u_useUv, 1);
                gl.uniform4f(this.u.u_uvSrc, sx, sy, sw, sh);
                gl.uniform4f(this.u.u_uvDst, dst[0], dst[1], dst[2], dst[3]);
                gl.uniform2f(this.u.u_uvRepeat, inst.uv.repeatU ?? 1, inst.uv.repeatV ?? 1);
            } else {
                gl.uniform1i(this.u.u_useUv, 0);
            }
            gl.uniform1f(this.u.u_colorOverride, inst.color ?? -1);

            if (inst.updates) {
                for (const { meshIndex, vertices } of inst.updates) {
                    const mesh = model.meshes[meshIndex];
                    if (!mesh) continue;
                    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
                    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices);
                }
            }

            for (let i = 0; i < model.meshes.length; i++) {
                const mesh = model.meshes[i];
                let matrix: Mat4;
                if (inst.meshMatrices) {
                    const m = inst.meshMatrices[i];
                    if (!m) continue;
                    matrix = m;
                } else {
                    matrix = multiply(inst.matrix, mesh.localMatrix);
                }
                gl.uniformMatrix4fv(this.u.u_model, false, matrix);
                gl.bindVertexArray(mesh.vao);
                gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
            }
        }
        gl.bindVertexArray(null);
    }

    // Upload-once cache for models built by the loader: the same Model object
    // always maps to the same handle on this renderer.
    private handleCache = new WeakMap<object, ModelHandle>();

    handleFor(model: { meshes: GpuMesh[]; texture: BuiltTexture }): ModelHandle {
        let handle = this.handleCache.get(model);
        if (handle === undefined) {
            handle = this.upload(model.meshes, model.texture);
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
