import * as vscode from 'vscode';
import { ChatViewProvider } from './chatView';
import { configureApiKey, setCookieCommand } from './deepseek';

export function activate(context: vscode.ExtensionContext) {
    const provider = new ChatViewProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.commands.registerCommand('deepseekAgent.openChat', async () => {
            await vscode.commands.executeCommand('workbench.view.extension.deepseekAgent');
            await vscode.commands.executeCommand('deepseekAgent.chatView.focus');
        }),
        vscode.commands.registerCommand('deepseekAgent.configureKey', () => configureApiKey(context)),
        vscode.commands.registerCommand('deepseekAgent.setCookie', () => setCookieCommand(context))
    );
}

export function deactivate() {}
