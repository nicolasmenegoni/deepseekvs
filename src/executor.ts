import * as vscode from 'vscode';
import { exec } from 'child_process';
import { extractShellBlocks, detectFileWrites } from './parser';

const DANGEROUS_RE = /\b(rm\s+-rf\s+\/|mkfs|dd\s+if=|:\(\)\s*\{|shutdown|reboot|format\s+c:)\b/i;

/**
 * Analisa a resposta do DeepSeek e propõe "ações" ao usuário:
 *  - executar blocos de terminal (com aprovação)
 *  - criar arquivos sugeridos (com aprovação)
 */
export interface ProposedAction {
    kind: 'command' | 'file';
    label: string;      // resumo exibido no chat
    payload: string;    // comando ou caminho do arquivo
    content?: string;   // conteúdo do arquivo
}

export function buildActionsFromAnswer(answer: string): ProposedAction[] {
    const actions: ProposedAction[] = [];

    for (const block of extractShellBlocks(answer)) {
        // Um bloco pode conter vários comandos; mantemos como uma ação única.
        const firstLine = block.code.split('\n')[0].slice(0, 80);
        actions.push({ kind: 'command', label: `$ ${firstLine}${block.code.split('\n').length > 1 ? ' …' : ''}`, payload: block.code });
    }

    for (const f of detectFileWrites(answer)) {
        actions.push({ kind: 'file', label: `📄 ${f.path}`, payload: f.path, content: f.content });
    }

    return actions;
}

function getWorkspaceFolder(): vscode.Uri | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders ? folders[0].uri : undefined;
}

/** Executa um bloco de comandos no terminal integrado (após aprovação). */
export async function runCommandInTerminal(command: string): Promise<void> {
    const folder = getWorkspaceFolder();
    const shell = process.platform === 'win32' ? 'powershell.exe' : undefined;
    const term = vscode.window.createTerminal({ name: 'DeepSeek Agent', cwd: folder, shellPath: shell });
    term.show();
    // Envia linha a linha para o shell — o usuário vê tudo acontecendo.
    for (const line of command.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        term.sendText(t);
    }
}

/** Cria/abre um arquivo sugerido pelo DeepSeek (após aprovação). */
export async function writeFile(action: ProposedAction): Promise<string> {
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
export async function approveAction(action: ProposedAction): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration('deepseekAgent');
    if (cfg.get<boolean>('autoApproveCommands', false) && !DANGEROUS_RE.test(action.payload)) {
        return true;
    }
    if (action.kind === 'command') {
        const detail = action.payload.length > 400 ? action.payload.slice(0, 400) + '\n…' : action.payload;
        const choice = await vscode.window.showWarningMessage(
            `O DeepSeek quer executar:\n\n${detail}`,
            { modal: true, detail: 'Comandos serão enviados ao terminal integrado.' },
            'Executar',
            'Cancelar'
        );
        return choice === 'Executar';
    }
    const choice = await vscode.window.showInformationMessage(
        `Criar o arquivo "${action.payload}" com o conteúdo gerado pelo DeepSeek?`,
        { modal: true },
        'Criar',
        'Cancelar'
    );
    return choice === 'Criar';
}

export async function applyAction(action: ProposedAction): Promise<string> {
    if (DANGEROUS_RE.test(action.payload)) {
        const areYouSure = await vscode.window.showErrorMessage(
            'Este comando parece perigoso (deleção em massa / formatação). Tem certeza?',
            { modal: true },
            'Sim, executar mesmo assim'
        );
        if (areYouSure !== 'Sim, executar mesmo assim') return 'cancelado';
    }
    if (action.kind === 'command') {
        runCommandInTerminal(action.payload);
        return 'enviado ao terminal ⌨️';
    }
    const path = await writeFile(action);
    return `criado: ${path} 📄`;
}

/** Pequeno helper usado pelo modo web para rodar comandos sem terminal (opcional). */
export function execQuick(cmd: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise(resolve => {
        exec(cmd, { cwd: getWorkspaceFolder()?.fsPath }, (err, stdout, stderr) => {
            resolve({ stdout, stderr, code: err ? (err as any).code ?? 1 : 0 });
        });
    });
}
