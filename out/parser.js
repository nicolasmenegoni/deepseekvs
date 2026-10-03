"use strict";
// Parser que extrai ações (comandos e arquivos) da resposta do DeepSeek.
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractCodeBlocks = extractCodeBlocks;
exports.extractShellBlocks = extractShellBlocks;
exports.detectFileWrites = detectFileWrites;
exports.extractLooseCommands = extractLooseCommands;
/** Extrai todos os blocos ```lang ... ``` da resposta markdown. */
function extractCodeBlocks(text) {
    const blocks = [];
    const re = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        blocks.push({ language: (m[1] || '').toLowerCase(), code: m[2].trim() });
    }
    return blocks;
}
const SHELL_LANGS = new Set([
    'bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'cmd',
    'batch', 'powershell', 'ps', 'pwsh', '',
]);
/** Retorna apenas blocos que parecem ser comandos de terminal. */
function extractShellBlocks(text) {
    return extractCodeBlocks(text).filter(b => SHELL_LANGS.has(b.language));
}
const FILE_HINT_RE = /\b(?:criar?|crie|salvar?|salve|escrever?|escreva|gerar?|gere|gravar?|grave|create|save|write|generate)\b.{0,80}?\b([\w./\\-]+\.[a-zA-Z]{1,8})\b/i;
/** Detecta "crie o arquivo X" seguido de bloco de código não-shell. */
function detectFileWrites(text) {
    const results = [];
    const blocks = [];
    // protege blocos com placeholders literais para dividir parágrafos em segurança
    const protectedText = text.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
        blocks.push({ language: (lang || '').toLowerCase(), code: code.trim() });
        return '@@DSKBLK' + (blocks.length - 1) + '@@';
    });
    const paragraphs = protectedText.split(/\n{2,}/);
    for (const p of paragraphs) {
        const hint = p.match(FILE_HINT_RE);
        if (!hint)
            continue;
        const idxs = [...p.matchAll(/@@DSKBLK(\d+)@@/g)].map(m => parseInt(m[1], 10));
        for (const i of idxs) {
            const b = blocks[i];
            if (!b)
                continue;
            if (SHELL_LANGS.has(b.language) && b.language !== '')
                continue;
            results.push({ path: hint[1], content: b.code, language: b.language });
        }
    }
    return results;
}
function looksLikeShell(code) {
    const first = code.split('\n')[0]?.trim() ?? '';
    return /^(cd|ls|mkdir|touch|echo|cat|sudo|apt|apt-get|yum|dnf|npm|npx|pip|pip3|python|python3|node|curl|wget|git|docker|java|javac|chmod|chown|cp|mv|rm|systemctl|ufw|ping|tar|unzip|zip|make|go|cargo|openjdk|rmdir|tee|export|source)\b/.test(first);
}
/** Heurística: linhas soltas `$ comando` ou começando com comando conhecido. */
function extractLooseCommands(text) {
    const withoutBlocks = text.replace(/```[\s\S]*?```/g, '');
    const lines = withoutBlocks.split('\n');
    const cmds = [];
    for (const raw of lines) {
        let line = raw.trim();
        line = line.replace(/^[-*]\s+/, '').replace(/^>\s*/, '').replace(/^\d+\.\s+/, '');
        const m = line.match(/^\$\s+(.+)$/);
        if (m) {
            cmds.push(m[1]);
            continue;
        }
        if (looksLikeShell(line) && !line.endsWith(':'))
            cmds.push(line);
    }
    return cmds;
}
//# sourceMappingURL=parser.js.map