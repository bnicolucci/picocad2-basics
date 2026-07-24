import { compose, identity, multiply, type Mat4, type Vec3 } from './math';
import type { PicoCad2Data, PicoCad2Node } from './picocad2';

// A GPU-ready mesh: one interleaved vertex buffer plus the baked local matrix
// that places this node inside the model. The user's model transform is applied
// on top of localMatrix each frame (see main.ts).
//
// Vertex layout (10 floats): position.xyz, uv.xy, normal.xyz, colorIndex, faceFlags
export const VERTEX_FLOATS = 10;

export type GpuMesh = {
    name: string;
    visible: boolean;
    vertices: Float32Array;
    indices: Uint32Array;
    localMatrix: Mat4;
};

// picoCAD2 model space is X-mirrored relative to a right-handed WebGL world.
// Applied once as the innermost transform of every model.
function mirrorMatrix(): Mat4 {
    const m = identity();
    m[0] = -1;
    return m;
}

function vec(v: { x?: number; y?: number; z?: number } | undefined, d: number): Vec3 {
    return { x: v?.x ?? d, y: v?.y ?? d, z: v?.z ?? d };
}

function nodeLocalMatrix(node: PicoCad2Node): Mat4 {
    const t = node.transform;
    return compose(vec(t?.pos, 0), vec(t?.rot, 0), vec(t?.scale, 1));
}

function cross(ax: number, ay: number, az: number, bx: number, by: number, bz: number): [number, number, number] {
    return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function buildNodeMesh(node: PicoCad2Node, parentMatrix: Mat4): GpuMesh | null {
    const raw = node.mesh;
    if (!raw?.vertices?.length || !raw.faces?.length) return null;

    const verts = raw.vertices;
    const out: number[] = [];
    const indices: number[] = [];
    let next = 0;

    for (const face of raw.faces) {
        const ids = face.vertex_ids ?? [];
        const uvs = face.uvs ?? [];
        if (ids.length < 3) continue;

        const colorIndex = face.color ?? 0;
        const textured = face.notex !== true && face.texture !== false;
        const faceFlags = (face.no_shade ? 1 : 0) | (textured ? 0 : 2);

        // Fan-triangulate the n-gon.
        for (let i = 1; i < ids.length - 1; i++) {
            const corners = [0, i + 1, i];
            const p = corners.map((c) => {
                const vi = (ids[c] - 1) * 3;
                return [verts[vi], verts[vi + 1], verts[vi + 2]] as [number, number, number];
            });
            let [nx, ny, nz] = cross(
                p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2],
                p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2],
            );
            const len = Math.hypot(nx, ny, nz) || 1;
            // Negated to match the per-model mirror's winding flip.
            nx = -nx / len; ny = -ny / len; nz = -nz / len;

            for (let k = 0; k < corners.length; k++) {
                const c = corners[k];
                out.push(
                    p[k][0], p[k][1], p[k][2],
                    uvs[c * 2] ?? 0, uvs[c * 2 + 1] ?? 0,
                    nx, ny, nz,
                    colorIndex, faceFlags,
                );
                indices.push(next++);
            }
        }
    }

    return {
        name: node.name ?? 'mesh',
        visible: node.visible ?? true,
        vertices: new Float32Array(out),
        indices: new Uint32Array(indices),
        localMatrix: multiply(parentMatrix, nodeLocalMatrix(node)),
    };
}

// Walks the model graph and returns a flat list of GPU meshes, each with its
// baked placement matrix (mirror included).
export function buildModelMeshes(data: PicoCad2Data): GpuMesh[] {
    const meshes: GpuMesh[] = [];
    const walk = (node: PicoCad2Node, parentMatrix: Mat4) => {
        const worldLocal = multiply(parentMatrix, nodeLocalMatrix(node));
        const mesh = buildNodeMesh(node, parentMatrix);
        if (mesh) meshes.push(mesh);
        for (const child of node.children ?? []) walk(child, worldLocal);
    };
    const graph = data.graph;
    if (graph) {
        for (const child of graph.children ?? []) walk(child, mirrorMatrix());
        if (graph.mesh) {
            const m = buildNodeMesh(graph, mirrorMatrix());
            if (m) meshes.push(m);
        }
    }
    return meshes;
}
