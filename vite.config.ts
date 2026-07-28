import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { encodePicoCad2Compact } from './src/lib/picocad2_compact';

// Dev-only save endpoints for the editors: each receives generated module text
// and writes it to its fixed destination in src/. The editor pages are absent
// from build inputs, so neither these endpoints nor the editor-only source
// files exist in production.
function editorSave(): Plugin {
    const handle = (
        req: import('node:http').IncomingMessage,
        res: import('node:http').ServerResponse,
        toFile: (body: { mesh?: string; source?: string }) => string,
    ): void => {
        if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: 'POST only' }));
            return;
        }
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            void (async () => {
                try {
                    const parsed = JSON.parse(body) as { mesh?: string; source?: string };
                    if (typeof parsed.source !== 'string') throw new Error('bad request: need { source }');
                    await writeFile(toFile(parsed), parsed.source, 'utf8');
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ ok: true }));
                } catch (error) {
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
                }
            })();
        });
    };

    return {
        name: 'editor-save',
        configureServer(server) {
            server.middlewares.use('/__editor/save-animations', (req, res) =>
                handle(req, res, ({ mesh }) => {
                    if (!mesh || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(mesh)) throw new Error('bad mesh name');
                    return resolve(import.meta.dirname, 'src/assets/models', `${mesh}_animations.ts`);
                }),
            );
            server.middlewares.use('/__editor/save-controls', (req, res) =>
                handle(req, res, () => resolve(import.meta.dirname, 'src/controls.ts')),
            );
        },
    };
}

// Build-time model compaction: any bundled `assets/**/*.txt?raw` picoCAD2
// model is re-encoded with picocad2_compact (tuples instead of keyed JSON,
// no whitespace, bit-packed face flags) — parsePicoCad2 decodes the `pc2!`
// prefix transparently at runtime. Dev serves the raw files untouched.
function picocadCompact(): Plugin {
    return {
        name: 'picocad-compact',
        apply: 'build',
        enforce: 'pre',
        async load(id) {
            // No path filter: src/assets/primitives may be a symlink, and vite
            // resolves ids to the real path. Anything .txt?raw that parses as a
            // picoCAD2 model (texture + graph) gets compacted.
            const match = id.match(/^(.*\.txt)\?raw$/);
            if (!match) return null;
            const text = await readFile(match[1], 'utf8');
            try {
                const data = JSON.parse(text) as Parameters<typeof encodePicoCad2Compact>[0];
                if (!data?.texture || !data?.graph) return null;
                return `export default ${JSON.stringify(encodePicoCad2Compact(data))};`;
            } catch {
                return null;
            }
        },
    };
}

// Build input stays the default (index.html only) — editor_animation.html is
// dev-only and deliberately excluded from production builds.
export default defineConfig({
    plugins: [editorSave(), picocadCompact()],
});
