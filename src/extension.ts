import * as vscode from 'vscode';
import { ChatViewProvider } from './chatView';

export function activate(context: vscode.ExtensionContext) {
    const provider = new ChatViewProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.commands.registerCommand('deepseekAgent.openChat', async () => {
            await vscode.commands.executeCommand('deepseekAgent.chatView.focus');
        })
    );
}

export function deactivate() {}
