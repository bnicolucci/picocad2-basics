import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { encodePicoCad2Compact } from './src/lib/picocad2_compact';

// Dev-only save endpoint for the Animation editor: receives the generated
// "<mesh>_animations.ts" module text and writes it into src/assets/models/.
// The editor page itself is absent from build inputs, so neither this endpoint
// nor the "-anim-" source exports exist in production.
function editorSave(): Plugin {
    return {
        name: 'editor-save',
        configureServer(server) {
            server.middlewares.use('/__editor/save-animations', (req, res) => {
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
                            const { mesh, source } = JSON.parse(body) as { mesh?: string; source?: string };
                            if (!mesh || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(mesh) || typeof source !== 'string') {
                                throw new Error('bad request: need { mesh, source }');
                            }
                            const file = resolve(import.meta.dirname,'src/assets/models', `${mesh}_animations.ts`);
                            await writeFile(file, source, 'utf8');
                            res.setHeader('Content-Type', 'application/json');
                            res.end(JSON.stringify({ ok: true }));
                        } catch (error) {
                            res.statusCode = 400;
                            res.setHeader('Content-Type', 'application/json');
                            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
                        }
                    })();
                });
            });
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
