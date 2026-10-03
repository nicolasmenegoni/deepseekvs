import * as vscode from 'vscode';
import { askDeepSeek, ChatMessage, SYSTEM_PROMPT } from './deepseek';
import { buildActionsFromAnswer, approveAction, applyAction, ProposedAction } from './executor';

interface UIMessage {
    role: 'user' | 'assistant' | 'system';
    text: string;
    actions?: { id: number; kind: string; label: string }[];
}

let actionSeq = 0;

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'deepseekAgent.chatView';
    private view?: vscode.WebviewView;
    private history: ChatMessage[] = [];
    private pendingActions = new Map<number, ProposedAction>();
    private busy = false;

    constructor(private readonly ctx: vscode.ExtensionContext) {
        // retoma conversa anterior (últimas 30 mensagens)
        const saved = this.ctx.workspaceState.get<ChatMessage[]>('chatHistory', []);
        this.history = saved.slice(-30);
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

        webviewView.webview.onDidReceiveMessage(async msg => {
            try {
                if (msg.command === 'send') await this.handleUserMessage(msg.text);
                else if (msg.command === 'runAction') await this.handleRunAction(msg.id);
                else if (msg.command === 'configureKey') await vscode.commands.executeCommand('deepseekAgent.configureKey');
                else if (msg.command === 'setCookie') await vscode.commands.executeCommand('deepseekAgent.setCookie');
                else if (msg.command === 'clear') { this.history = []; await this.persist(); this.post({ command: 'clear' }); }
            } catch (e: any) {
                this.postAssistant(`⚠️ ${e.message ?? String(e)}`);
                this.busy = false;
                this.post({ command: 'busy', value: false });
            }
        });

        // replay do histórico salvo
        for (const m of this.history) {
            if (m.role === 'user') this.post({ command: 'addUser', text: m.content });
            if (m.role === 'assistant') this.postAssistant(m.content);
        }
    }

    private post(msg: any) { this.view?.webview.postMessage(msg); }

    private async persist() {
        await this.ctx.workspaceState.update('chatHistory', this.history.slice(-50));
    }

    private postAssistant(text: string, actions: ProposedAction[] = []) {
        const uiActions = actions.map(a => {
            const id = ++actionSeq;
            this.pendingActions.set(id, a);
            return { id, kind: a.kind, label: a.label };
        });
        this.post({ command: 'addAssistant', text, actions: uiActions });
    }

    private async handleUserMessage(text: string) {
        if (!text || !text.trim() || this.busy) return;
        this.busy = true;
        this.post({ command: 'busy', value: true });
        this.post({ command: 'addUser', text });
        this.history.push({ role: 'user', content: text.trim() });

        const os = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
        const system: ChatMessage = { role: 'system', content: SYSTEM_PROMPT.replace('{OS}', os) };
        const messages: ChatMessage[] = [system, ...this.history.slice(-20)];

        try {
            const answer = await askDeepSeek(messages, this.ctx);
            this.history.push({ role: 'assistant', content: answer });
            await this.persist();
            const actions = buildActionsFromAnswer(answer);
            this.postAssistant(answer, actions);
            if (actions.length > 0) {
                this.post({ command: 'hint', text: `💡 Detectei ${actions.length} ação(ões). Clique em "Executar" para aplicar (você aprova antes).` });
            }
        } catch (e: any) {
            this.postAssistant(`⚠️ Erro: ${e.message ?? e}`);
        } finally {
            this.busy = false;
            this.post({ command: 'busy', value: false });
        }
    }

    private async handleRunAction(id: number) {
        const action = this.pendingActions.get(id);
        if (!action) return;
        const ok = await approveAction(action);
        if (!ok) { this.post({ command: 'actionStatus', id, status: 'cancelado ✋' }); return; }
        try {
            const result = await applyAction(action);
            this.post({ command: 'actionStatus', id, status: result });
            // alimenta o agente com o resultado para ele continuar sozinho
            this.history.push({
                role: 'user',
                content: `[sistema] Ação aplicada: ${action.kind === 'command' ? 'comando' : 'arquivo'} "${action.label}" → ${result}. Continue a tarefa se houver próximos passos; senão responda APENAS "✅ Concluído".`,
            });
            const cfg = vscode.workspace.getConfiguration('deepseekAgent');
            const maxSteps = cfg.get<number>('maxAutoSteps', 10);
            const userTurns = this.history.filter(m => m.role === 'user').length;
            if (userTurns <= maxSteps && this.view) {
                // continua automaticamente uma rodada
                await this.continueAgent();
            }
        } catch (e: any) {
            this.post({ command: 'actionStatus', id, status: `erro: ${e.message}` });
        }
    }

    private async continueAgent() {
        if (this.busy) return;
        this.busy = true;
        this.post({ command: 'busy', value: true });
        try {
            const os = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
            const system: ChatMessage = { role: 'system', content: SYSTEM_PROMPT.replace('{OS}', os) };
            const answer = await askDeepSeek([system, ...this.history.slice(-20)], this.ctx);
            this.history.push({ role: 'assistant', content: answer });
            await this.persist();
            this.postAssistant(answer, buildActionsFromAnswer(answer));
        } catch (e: any) {
            this.postAssistant(`⚠️ ${e.message ?? e}`);
        } finally {
            this.busy = false;
            this.post({ command: 'busy', value: false });
        }
    }

    private getHtml(): string {
        return `<!DOCTYPE html>
<html lang="pt-br">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); display: flex; flex-direction: column; height: 100vh; background: var(--vscode-sideBar-background); color: var(--vscode-foreground); }
  #header { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 8px; }
  #header .title { font-weight: 600; flex: 1; }
  #header button { background: none; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-foreground); cursor: pointer; border-radius: 4px; padding: 2px 8px; }
  #chat { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 95%; padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.45; }
  .user { align-self: flex-end; background: var(--vscode-inputOption-activeBackground, #0e639c); color: var(--vscode-inputOption-activeForeground, #fff); }
  .assistant { align-self: flex-start; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
  .assistant pre { background: var(--vscode-textCodeBlock-background, rgba(0,0,0,.3)); padding: 8px; border-radius: 6px; overflow-x: auto; margin: 6px 0; }
  .assistant code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .sys { align-self: center; font-size: 11px; opacity: .7; }
  .actions { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  .action { display: flex; align-items: center; gap: 6px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 4px 6px; font-size: 12px; }
  .action code { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .action button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 3px 8px; cursor: pointer; }
  .action .status { font-size: 11px; opacity: .8; }
  #inputArea { display: flex; gap: 6px; padding: 10px; border-top: 1px solid var(--vscode-panel-border); }
  #input { flex: 1; resize: none; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px; padding: 8px; font-family: inherit; }
  #send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 6px; padding: 0 14px; cursor: pointer; }
  #send:disabled { opacity: .5; cursor: default; }
  .typing { font-style: italic; opacity: .7; }
</style>
</head>
<body>
  <div id="header">
    <span class="title">🤖 DeepSeek Agent</span>
    <button id="btnKey" title="Configurar API Key">🔑</button>
    <button id="btnCookie" title="Usar conta chat.deepseek.com (cookie)">🍪</button>
    <button id="btnClear" title="Limpar conversa">🗑</button>
  </div>
  <div id="chat"></div>
  <div id="inputArea">
    <textarea id="input" rows="2" placeholder="Ex.: Crie um servidor de Minecraft..."></textarea>
    <button id="send">➤</button>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  const chat = document.getElementById('chat');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  let typingEl = null;

  function esc(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

  function renderMarkdown(text){
    // markdown mínimo: blocos de código, código inline, negrito
    let html = esc(text);
    html = html.replace(/\`\`\`([a-z]*)\n([\s\S]*?)\`\`\`/g, (m,l,c)=>'<pre><code>'+c+'</code></pre>');
    html = html.replace(/\`([^\`\n]+)\`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    return html;
  }

  function addMsg(role, htmlText, actions){
    removeTyping();
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.innerHTML = htmlText;
    if (actions && actions.length){
      const box = document.createElement('div'); box.className='actions';
      for (const a of actions){
        const row = document.createElement('div'); row.className='action'; row.dataset.id = a.id;
        row.innerHTML = '<code>' + esc(a.label) + '</code><span class="status"></span>';
        const btn = document.createElement('button'); btn.textContent = a.kind==='file' ? 'Criar' : 'Executar';
        btn.onclick = ()=>{ btn.disabled = true; row.querySelector('.status').textContent='aguardando…'; vscode.postMessage({command:'runAction', id:a.id}); };
        row.appendChild(btn); box.appendChild(row);
      }
      div.appendChild(box);
    }
    chat.appendChild(div); chat.scrollTop = chat.scrollHeight;
    return div;
  }

  function showTyping(){ removeTyping(); typingEl = addMsg('assistant','<span class="typing">DeepSeek pensando…</span>'); }
  function removeTyping(){ if(typingEl){ typingEl.remove(); typingEl=null; } }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.command === 'addUser') addMsg('user', esc(m.text));
    if (m.command === 'addAssistant'){ showTypingOff(); addMsg('assistant', renderMarkdown(m.text), m.actions); }
    if (m.command === 'hint') addMsg('sys', esc(m.text)).className='msg sys';
    if (m.command === 'busy'){ sendBtn.disabled = m.value; if (m.value) showTyping(); else removeTyping(); }
    if (m.command === 'clear'){ chat.innerHTML=''; }
    if (m.command === 'actionStatus') updateActionStatus(m.id, m.status);
  });

  function updateActionStatus(id, status){
    const row = document.querySelector('.action[data-id="'+id+'"]');
    if (row) row.querySelector('.status').textContent = status;
  }

  function showTypingOff(){ removeTyping(); }

  function send(){
    const text = input.value.trim();
    if(!text || sendBtn.disabled) return;
    vscode.postMessage({ command:'send', text });
    input.value='';
  }
  sendBtn.onclick = send;
  input.addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); send(); }});
  document.getElementById('btnKey').onclick = ()=> vscode.postMessage({command:'configureKey'});
  document.getElementById('btnCookie').onclick = ()=> vscode.postMessage({command:'setCookie'});
  document.getElementById('btnClear').onclick = ()=> vscode.postMessage({command:'clear'});

  addMsg('sys','Peça algo ao agente, ex.: <b>"Crie um servidor de Minecraft"</b>. Ele pede instruções ao DeepSeek e aplica os comandos (com sua aprovação).');
</script>
</body>
</html>`;
    }
}
