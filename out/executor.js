"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildActionsFromAnswer = buildActionsFromAnswer;
exports.runCommandInTerminal = runCommandInTerminal;
exports.writeFile = writeFile;
exports.approveAction = approveAction;
exports.applyAction = applyAction;
exports.execQuick = execQuick;
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
const parser_1 = require("./parser");
const DANGEROUS_RE = /\b(rm\s+-rf\s+\/|mkfs|dd\s+if=|:\(\)\s*\{|shutdown|reboot|format\s+c:)\b/i;
function buildActionsFromAnswer(answer) {
    const actions = [];
    for (const block of (0, parser_1.extractShellBlocks)(answer)) {
        // Um bloco pode conter vários comandos; mantemos como uma ação única.
        const firstLine = block.code.split('\n')[0].slice(0, 80);
        actions.push({ kind: 'command', label: `$ ${firstLine}${block.code.split('\n').length > 1 ? ' …' : ''}`, payload: block.code });
    }
    for (const f of (0, parser_1.detectFileWrites)(answer)) {
        actions.push({ kind: 'file', label: `📄 ${f.path}`, payload: f.path, content: f.content });
    }
    return actions;
}
function getWorkspaceFolder() {
    const folders = vscode.workspace.workspaceFolders;
    return folders ? folders[0].uri : undefined;
}
/** Executa um bloco de comandos no terminal integrado (após aprovação). */
async function runCommandInTerminal(command) {
    const folder = getWorkspaceFolder();
    const shell = process.platform === 'win32' ? 'powershell.exe' : undefined;
    const term = vscode.window.createTerminal({ name: 'DeepSeek Agent', cwd: folder, shellPath: shell });
    term.show();
    // Envia linha a linha para o shell — o usuário vê tudo acontecendo.
    for (const line of command.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#'))
            continue;
        term.sendText(t);
    }
}
/** Cria/abre um arquivo sugerido pelo DeepSeek (após aprovação). */
async function writeFile(action) {
    const folder = getWorkspaceFolder();
    if (!folder) {
        throw new Error('Abra uma pasta no VSCode antes de criar arquivos.');
    }
    const target = vscode.Uri.joinPath(folder, action.payload.replace(/^\.?[\\/]+/, ''));
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
    await vscode.workspace.fs.writeFile(target, Buffer.from(action.content ?? '', 'utf8'));
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc);
    return target.fsPath;
}
/** Pede aprovação do usuário antes de agir. */
async function approveAction(action) {
    const cfg = vscode.workspace.getConfiguration('deepseekAgent');
    if (cfg.get('autoApproveCommands', false) && !DANGEROUS_RE.test(action.payload)) {
        return true;
    }
    if (action.kind === 'command') {
        const detail = action.payload.length > 400 ? action.payload.slice(0, 400) + '\n…' : action.payload;
        const choice = await vscode.window.showWarningMessage(`O DeepSeek quer executar:\n\n${detail}`, { modal: true, detail: 'Comandos serão enviados ao terminal integrado.' }, 'Executar', 'Cancelar');
        return choice === 'Executar';
    }
    const choice = await vscode.window.showInformationMessage(`Criar o arquivo "${action.payload}" com o conteúdo gerado pelo DeepSeek?`, { modal: true }, 'Criar', 'Cancelar');
    return choice === 'Criar';
}
async function applyAction(action) {
    if (DANGEROUS_RE.test(action.payload)) {
        const areYouSure = await vscode.window.showErrorMessage('Este comando parece perigoso (deleção em massa / formatação). Tem certeza?', { modal: true }, 'Sim, executar mesmo assim');
        if (areYouSure !== 'Sim, executar mesmo assim')
            return 'cancelado';
    }
    if (action.kind === 'command') {
        runCommandInTerminal(action.payload);
        return 'enviado ao terminal ⌨️';
    }
    const path = await writeFile(action);
    return `criado: ${path} 📄`;
}
/** Pequeno helper usado pelo modo web para rodar comandos sem terminal (opcional). */
function execQuick(cmd) {
    return new Promise(resolve => {
        (0, child_process_1.exec)(cmd, { cwd: getWorkspaceFolder()?.fsPath }, (err, stdout, stderr) => {
            resolve({ stdout, stderr, code: err ? err.code ?? 1 : 0 });
        });
    });
}
//# sourceMappingURL=executor.js.map