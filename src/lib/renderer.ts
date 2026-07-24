import type { Mat4 } from './math';
import { multiply } from './math';
import type { GpuMesh } from './mesh';
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

out vec4 outColor;

void main() {
  int flags = int(v_faceFlags + 0.5);
  bool noShade = (flags & 1) != 0;
  bool noTex = (flags & 2) != 0;

  float colorIndex = v_colorIndex;
  if (!noTex) {
    colorIndex = floor(texture(u_indexTexture, v_uv).r * 255.0 + 0.5);
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
const RETRO_SCALE = 0.5;

type DrawMesh = { vao: WebGLVertexArrayObject; count: number; localMatrix: Mat4 };

// An uploaded model: its per-node draw calls plus its own textures.
type UploadedModel = {
    meshes: DrawMesh[];
    indexTexture: WebGLTexture;
    paletteTexture: WebGLTexture;
    transparentIndex: number;
};

// One thing to draw this frame: which uploaded model, and where.
export type Instance = { model: ModelHandle; matrix: Mat4 };

// Opaque index into the renderer's uploaded-model list.
export type ModelHandle = number;

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
        for (const name of ['u_viewProj', 'u_model', 'u_indexTexture', 'u_paletteTexture', 'u_lightDir', 'u_ambient', 'u_transparentIndex']) {
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

            const vbo = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
            gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);

            const ibo = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

            const stride = 10 * 4;
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

            drawMeshes.push({ vao, count: mesh.indices.length, localMatrix: mesh.localMatrix });
        }

        gl.bindVertexArray(null);
        this.models.push({
            meshes: drawMeshes,
            indexTexture: this.makeIndexTexture(texture),
            paletteTexture: this.makePaletteTexture(texture),
            transparentIndex: texture.transparentIndex,
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

    render(viewProj: Mat4, lightDir: [number, number, number], instances: Instance[]): void {
        const gl = this.gl;
        // Render at a fraction of display resolution and let CSS upscale it
        // (image-rendering: pixelated) for the chunky retro look.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr * RETRO_SCALE));
        const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr * RETRO_SCALE));
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }

        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0.06, 0.08, 0.09, 1);
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
            for (const mesh of model.meshes) {
                gl.uniformMatrix4fv(this.u.u_model, false, multiply(inst.matrix, mesh.localMatrix));
                gl.bindVertexArray(mesh.vao);
                gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
            }
        }
        gl.bindVertexArray(null);
    }

    get aspect(): number {
        return this.canvas.width / this.canvas.height || 1;
    }
}
