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
    // Vertex range per source face (file order), for UV-scroll animation:
    // `tex` motion segments target faces by 1-based face_id.
    faceVertexRanges: { start: number; count: number }[];
};

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
    const faceVertexRanges: { start: number; count: number }[] = [];
    let next = 0;

    for (const face of raw.faces) {
        const ids = face.vertex_ids ?? [];
        const uvs = face.uvs ?? [];
        if (ids.length < 3) {
            faceVertexRanges.push({ start: next, count: 0 });
            continue;
        }
        const faceStart = next;

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
        faceVertexRanges.push({ start: faceStart, count: next - faceStart });
    }

    return {
        name: node.name ?? 'mesh',
        visible: node.visible ?? true,
        vertices: new Float32Array(out),
        indices: new Uint32Array(indices),
        localMatrix: multiply(parentMatrix, nodeLocalMatrix(node)),
        faceVertexRanges,
    };
}

// A model graph node kept live (not baked): local TRS stays editable so
// animation can move nodes. `meshIndex` points into the parallel GpuMesh list.
export type ModelNode = {
    name: string;
    visible: boolean;
    pos: Vec3;
    rot: Vec3; // radians, XYZ order (as authored in the file)
    scale: Vec3;
    meshIndex: number | null;
    children: ModelNode[];
};

// Walks the model graph into a live node tree plus per-node meshes with
// IDENTITY placement — node matrices are composed at render time from the
// tree, so transforms (and animation) stay live. The X-mirror is applied by
// the scene flattener at the model root.
export function buildModelGraph(data: PicoCad2Data): { root: ModelNode; meshes: GpuMesh[] } {
    const meshes: GpuMesh[] = [];
    const build = (node: PicoCad2Node): ModelNode => {
        let meshIndex: number | null = null;
        const mesh = buildNodeMesh(node, identity());
        if (mesh && mesh.indices.length > 0) {
            meshIndex = meshes.length;
            meshes.push(mesh);
        }
        return {
            name: node.name ?? '',
            visible: node.visible ?? true,
            pos: vec(node.transform?.pos, 0),
            rot: vec(node.transform?.rot, 0),
            scale: vec(node.transform?.scale, 1),
            meshIndex,
            children: (node.children ?? []).map(build),
        };
    };
    const graph = data.graph ?? {};
    return { root: build(graph), meshes };
}

