// Shared chrome for the dev-only editor pages: the status line, the save POST
// to the `editor-save` middleware (vite.config.ts), and the message hand-off
// across the reload that saving triggers — the written file is one the page
// imports, so Vite reloads it and would wipe the status.

export type SetStatus = (message: string, isError?: boolean) => void;

export function statusReporter(el: HTMLElement): SetStatus {
    return (message, isError = false) => {
        el.textContent = message;
        el.classList.toggle('error', isError);
    };
}

/** Resolves true when the file was written — callers that do something after a
    save (open a preview, say) can wait on it. */
export async function saveGenerated(
    setStatus: SetStatus,
    endpoint: string,
    body: unknown,
    savedKey: string,
    message: string,
): Promise<boolean> {
    setStatus('Saving…');
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const result = (await response.json()) as { ok?: boolean; error?: string };
        if (!response.ok || !result.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
        sessionStorage.setItem(savedKey, message);
        setStatus(message);
        return true;
    } catch (error) {
        setStatus(`Save failed: ${error instanceof Error ? error.message : error}`, true);
        return false;
    }
}

export function restoreSavedMessage(setStatus: SetStatus, savedKey: string): void {
    const message = sessionStorage.getItem(savedKey);
    if (!message) return;
    sessionStorage.removeItem(savedKey);
    setStatus(message);
}
