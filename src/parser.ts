// Parser que extrai blocos de código executáveis da resposta do DeepSeek.

export interface CodeBlock {
    language: string;
    code: string;
}

/** Extrai todos os blocos ```lang ... ``` da resposta markdown. */
export function extractCodeBlocks(text: string): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    const re = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        blocks.push({ language: (m[1] || '').toLowerCase(), code: m[2].trim() });
    }
    return blocks;
}

const SHELL_LANGS = new Set([
    'bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'cmd',
    'batch', 'powershell', 'ps', 'pwsh', 'dockerfile', '',
]);

/** Retorna apenas blocos que parecem ser comandos de terminal. */
export function extractShellBlocks(text: string): CodeBlock[] {
    return extractCodeBlocks(text).filter(b => SHELL_LANGS.has(b.language));
}

const FILE_HINT_RE =
    /\b(?:criar?|crie|salvar?|salve|escrever?|escreva|gerar?|gere|gravar?|grave|create|save|write|generate)\b.{0,80}?\b([\w./\\-]+\.[a-zA-Z]{1,8})\b/i;

/** Tenta detectar "crie o arquivo X" seguido de um bloco de código com linguagem não-shell. */
export function detectFileWrites(text: string): { path: string; content: string; language: string }[] {
    const results: { path: string; content: string; language: string }[] = [];
    // divide em parágrafos, mas mantém blocos ``` intactos (não podem conter linha vazia... 
    // para segurança, primeiro protege os blocos com placeholders)
    const blocks: CodeBlock[] = [];
    const protectedText = text.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
        blocks.push({ language: (lang || '').toLowerCase(), code: code.trim() });
        return '@@DSKBLK' + (blocks.length - 1) + '@@';
    });
    const paragraphs = protectedText.split(/\n{2,}/);
    for (const p of paragraphs) {
        const hint = p.match(FILE_HINT_RE);
        if (!hint) continue;
        const idxs = [...p.matchAll(/@@DSKBLK(\d+)@@/g)].map(m => parseInt(m[1], 10));
        for (const i of idxs) {
            const b = blocks[i];
            if (!b) continue;
            if (b.language === 'bash' || b.language === 'sh' || b.language === 'shell' || b.language === 'zsh') continue;
            results.push({ path: hint[2], content: b.code, language: b.language });
        }
    }
    return results;
}

function looksLikeShell(code: string): boolean {
    const first = code.split('\n')[0]?.trim() ?? '';
    return /^(cd|ls|mkdir|touch|echo|cat|sudo|apt|yum|dnf|npm|npx|pip|pip3|python|node|curl|wget|git|docker|java|javac|chmod|chown|cp|mv|rm|systemctl|ufw|ping)\b/.test(first);
}

/** Heurística: uma linha isolada `comando...` fora de bloco também pode ser comando. */
export function extractLooseCommands(text: string): string[] {
    const withoutBlocks = text.replace(/```[\s\S]*?```/g, '');
    const lines = withoutBlocks.split('\n');
    const cmds: string[] = [];
    for (let raw of lines) {
        let line = raw.trim();
        // remove prefixos de lista/markdown e prompt `$ `
        line = line.replace(/^[-*]\s+/, '').replace(/^>\s*/, '');
        const m = line.match(/^\$\s+(.+)$/);
        if (m) { cmds.push(m[1]); continue; }
        if (looksLikeShell(line) && !line.endsWith(':')) cmds.push(line);
    }
    return cmds;
}
