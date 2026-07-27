import { controlScheme, MAX_ACTION_BUTTONS, type ControlActionButton } from '../control_scheme';

function normalizeKeyCode(raw: string): string {
    const trimmed = raw.trim();
    if (/^[a-zA-Z]$/.test(trimmed)) return `Key${trimmed.toUpperCase()}`;
    if (/^[0-9]$/.test(trimmed)) return `Digit${trimmed}`;
    if (trimmed.toLowerCase() === 'space') return 'Space';
    return trimmed;
}

function formatControlSchemeSource(actions: ControlActionButton[]): string {
    const lines = actions.map(
        (a) =>
            `        { id: ${JSON.stringify(a.id)}, label: ${JSON.stringify(a.label)}, key: ${JSON.stringify(a.key)}, gamepadButton: ${a.gamepadButton} },`,
    );
    return (
        `// Hand-authored-but-editor-writable registry: editor_controls.html\n` +
        `// regenerates this whole file on save via POST /__editor/save-control-scheme.\n` +
        `//\n` +
        `// This is the one small, fixed set of buttons a whole game gets. WASD/arrow\n` +
        `// keys are always movement — not part of this list, never renamed or\n` +
        `// reassigned (see sys_ecs_control_player). Up to MAX_ACTION_BUTTONS action\n` +
        `// buttons below cover everything else (shoot, jump, turret left/right,\n` +
        `// whatever a given game needs). Keeping this capped is deliberate: it forces\n` +
        `// game ideas built with this engine to stay PICO-8-simple, rather than\n` +
        `// growing an open-ended set of key bindings.\n\n` +
        `export type ControlActionButton = {\n` +
        `    id: string;\n` +
        `    label: string;\n` +
        `    key: string;\n` +
        `    gamepadButton: number;\n` +
        `};\n\n` +
        `export const MAX_ACTION_BUTTONS = ${MAX_ACTION_BUTTONS};\n\n` +
        `export type ControlScheme = {\n` +
        `    actions: ControlActionButton[];\n` +
        `};\n\n` +
        `export const controlScheme: ControlScheme = {\n` +
        `    actions: [\n${lines.join('\n')}\n    ],\n` +
        `};\n`
    );
}

function main(): void {
    const actionListEl = document.getElementById('action-list');
    const addActionBtn = document.getElementById('add-action-btn') as HTMLButtonElement | null;
    const saveBtn = document.getElementById('save-btn');
    const sceneEditorBtn = document.getElementById('scene-editor-btn');
    const blueprintEditorBtn = document.getElementById('blueprint-editor-btn');
    const statusEl = document.getElementById('status');

    // Working copy — editing here never touches the live `controlScheme`
    // import until Save is clicked.
    const actions: ControlActionButton[] = controlScheme.actions.map((a) => ({ ...a }));

    function nextActionId(): string {
        let n = 1;
        while (actions.some((a) => a.id === `action${n}`)) n++;
        return `action${n}`;
    }

    function setStatus(message: string): void {
        if (statusEl) statusEl.textContent = message;
    }

    function render(): void {
        if (!actionListEl) return;
        actionListEl.innerHTML = '';

        for (const action of actions) {
            const row = document.createElement('div');
            row.className = 'action-row';

            const labelField = document.createElement('div');
            labelField.className = 'field';
            const labelLabel = document.createElement('label');
            labelLabel.textContent = 'name';
            const labelInput = document.createElement('input');
            labelInput.className = 'input';
            labelInput.type = 'text';
            labelInput.value = action.label;
            labelInput.addEventListener('input', () => {
                action.label = labelInput.value;
            });
            labelField.append(labelLabel, labelInput);

            const keyField = document.createElement('div');
            keyField.className = 'field';
            const keyLabel = document.createElement('label');
            keyLabel.textContent = 'key';
            const keyInput = document.createElement('input');
            keyInput.className = 'input';
            keyInput.type = 'text';
            keyInput.value = action.key;
            keyInput.addEventListener('change', () => {
                action.key = normalizeKeyCode(keyInput.value);
                keyInput.value = action.key;
            });
            keyField.append(keyLabel, keyInput);

            const gamepadField = document.createElement('div');
            gamepadField.className = 'field';
            const gamepadLabel = document.createElement('label');
            gamepadLabel.textContent = 'pad btn';
            const gamepadInput = document.createElement('input');
            gamepadInput.className = 'input';
            gamepadInput.type = 'number';
            gamepadInput.min = '0';
            gamepadInput.step = '1';
            gamepadInput.value = String(action.gamepadButton);
            gamepadInput.addEventListener('change', () => {
                const parsed = Number(gamepadInput.value);
                action.gamepadButton = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
                gamepadInput.value = String(action.gamepadButton);
            });
            gamepadField.append(gamepadLabel, gamepadInput);

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'remove-btn';
            removeBtn.textContent = '×';
            removeBtn.title = `Remove ${action.label}`;
            removeBtn.addEventListener('click', () => {
                const index = actions.indexOf(action);
                if (index !== -1) actions.splice(index, 1);
                render();
            });

            row.append(labelField, keyField, gamepadField, removeBtn);
            actionListEl.appendChild(row);
        }

        if (addActionBtn) addActionBtn.disabled = actions.length >= MAX_ACTION_BUTTONS;
    }

    addActionBtn?.addEventListener('click', () => {
        if (actions.length >= MAX_ACTION_BUTTONS) return;
        const id = nextActionId();
        actions.push({ id, label: `Action ${actions.length + 1}`, key: 'KeyC', gamepadButton: actions.length });
        render();
    });

    saveBtn?.addEventListener('click', () => {
        void (async () => {
            try {
                const source = formatControlSchemeSource(actions);
                const res = await fetch('/__editor/save-control-scheme', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ source }),
                });
                if (!res.ok) throw new Error(`Failed to save: ${await res.text()}`);
                setStatus('Saved src/control_scheme.ts');
            } catch (err) {
                setStatus('');
                window.alert(err instanceof Error ? err.message : String(err));
            }
        })();
    });

    sceneEditorBtn?.addEventListener('click', () => {
        window.location.href = 'editor.html';
    });

    blueprintEditorBtn?.addEventListener('click', () => {
        window.location.href = 'editor_blueprint.html';
    });

    render();
}

main();
