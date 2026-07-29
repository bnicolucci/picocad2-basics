// picoCAD2 .txt -> .rm1
//
//   bun tools/rm1/convert.ts <in.txt|dir> [more...] [--out <dir>] [--pos16]
//
// Every file is decoded again after writing and compared to the source, so a
// conversion that silently mangles geometry fails loudly instead of shipping.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { readPicoCad2 } from './read_picocad2';
import { readRm1 } from './read_rm1';
import { writeRm1 } from './write_rm1';

type Args = { inputs: string[]; out: string | null; pos16: boolean };

function parseArgs(argv: string[]): Args {
    const args: Args = { inputs: [], out: null, pos16: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--out') args.out = argv[++i] ?? null;
        else if (argv[i] === '--pos16') args.pos16 = true;
        else args.inputs.push(argv[i]);
    }
    return args;
}

function expand(paths: string[]): string[] {
    const files: string[] = [];
    for (const path of paths) {
        if (!existsSync(path)) throw new Error(`no such file or directory: ${path}`);
        if (statSync(path).isDirectory()) {
            for (const entry of readdirSync(path)) {
                // Animation exports are near-full model copies, not models.
                if (extname(entry) === '.txt' && !/[-_]anim[-_]/.test(entry)) files.push(join(path, entry));
            }
        } else {
            files.push(path);
        }
    }
    return files.sort();
}

/** Re-decode and compare, so a broken conversion never reaches disk unnoticed. */
function verify(name: string, sourceText: string, bytes: Uint8Array, budget: number): void {
    const source = readPicoCad2(sourceText);
    const decoded = readRm1(bytes);
    const problems: string[] = [];

    if (decoded.nodes.length !== source.nodes.length) problems.push('node count differs');
    source.nodes.forEach((node, i) => {
        const got = decoded.nodes[i];
        if (!got) return;
        if (got.name !== node.name) problems.push(`node ${i} name "${got.name}" != "${node.name}"`);
        if (got.faces.length !== node.faces.length) problems.push(`node ${i} face count differs`);
        node.faces.forEach((face, f) => {
            const gotFace = got.faces[f];
            if (!gotFace) return;
            if (gotFace.ids.join(',') !== face.ids.join(',')) problems.push(`node ${i} face ${f} indices differ`);
        });
        node.verts.forEach((v, k) => {
            if (Math.abs(v - got.verts[k]) > budget) problems.push(`node ${i} vertex ${k} off by ${Math.abs(v - got.verts[k]).toFixed(4)}`);
        });
    });
    if (Array.from(decoded.texture).join(',') !== Array.from(source.texture).join(',')) problems.push('texture differs');

    if (problems.length > 0) {
        throw new Error(`${name}: verification failed\n  ${problems.slice(0, 5).join('\n  ')}`);
    }
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    if (args.inputs.length === 0) {
        console.error('usage: bun tools/rm1/convert.ts <in.txt|dir> [...] [--out <dir>] [--pos16]');
        process.exit(1);
    }

    const files = expand(args.inputs);
    if (args.out && !existsSync(args.out)) mkdirSync(args.out, { recursive: true });

    let totalIn = 0;
    let totalOut = 0;
    let totalGz = 0;
    let totalBr = 0;
    console.log('model                 source      .rm1     gzip   brotli   nodes  verts  faces   err(px@128)');

    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        const model = readPicoCad2(text);
        const result = writeRm1(model, { pos16: args.pos16 });

        let span = 0;
        for (let c = 0; c < 3; c++) {
            let min = Infinity;
            let max = -Infinity;
            for (const node of model.nodes) {
                for (let i = c; i < node.verts.length; i += 3) {
                    if (node.verts[i] < min) min = node.verts[i];
                    if (node.verts[i] > max) max = node.verts[i];
                }
            }
            if (Number.isFinite(min)) span = Math.max(span, max - min);
        }
        const name = basename(file, '.txt');
        verify(name, text, result.bytes, result.positionError * span + 1e-4);

        const gz = gzipSync(result.bytes, { level: 9 }).length;
        const br = brotliCompressSync(result.bytes, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
        }).length;
        const target = join(args.out ?? join(file, '..'), `${name}.rm1`);
        writeFileSync(target, result.bytes);

        totalIn += text.length;
        totalOut += result.bytes.byteLength;
        totalGz += gz;
        totalBr += br;
        console.log(
            `${name.padEnd(18)} ${String(text.length).padStart(8)} ${String(result.bytes.byteLength).padStart(9)}`
            + ` ${String(gz).padStart(8)} ${String(br).padStart(8)}`
            + ` ${String(model.nodes.length).padStart(7)} ${String(result.vertexCount).padStart(6)}`
            + ` ${String(result.faceCount).padStart(6)}   ${(result.positionError * 128).toFixed(3)}`,
        );
    }

    console.log(
        `\n${files.length} model(s): ${totalIn} -> ${totalOut} bytes`
        + ` (${(totalIn / totalOut).toFixed(1)}x smaller uncompressed)`
        + `\n  gzip ${totalGz}   brotli ${totalBr}`,
    );
}

main();
