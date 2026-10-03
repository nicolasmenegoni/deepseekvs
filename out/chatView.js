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
exports.ChatViewProvider = void 0;
const vscode = __importStar(require("vscode"));
const deepseek_1 = require("./deepseek");
const browserChat_1 = require("./browserChat");
const executor_1 = require("./executor");
let actionSeq = 0;
class ChatViewProvider {
    constructor(ctx) {
        this.ctx = ctx;
        this.history = [];
        this.pendingActions = new Map();
        this.busy = false;
        this.lastPacket = '';
        this.browser = new browserChat_1.BrowserChat(ctx);
        const saved = this.ctx.workspaceState.get('chatHistory', []);
        this.history = Array.isArray(saved) ? saved.slice(-30) : [];
    }
    resolveWebviewView(webviewView) {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            try {
                if (msg.command === 'send')
                    await this.handleUserMessage(msg.text);
                else if (msg.command === 'runAction')
                    await this.handleRunAction(msg.id);
                else if (msg.command === 'openChat')
                    await this.browser.open();
                else if (msg.command === 'copyPacket') {
                    await vscode.env.clipboard.writeText(this.lastPacket);
                    this.post({ command: 'hint', text: '📋 Prompt do agente copiado. Cole (Ctrl+V) no chat.deepseek.com e envie.' });
                }
                else if (msg.command === 'installScript')
                    await this.installUserscript();
                else if (msg.command === 'clear') {
                    this.history = [];
                    await this.persist();
                    this.post({ command: 'clear' });
                }
            }
            catch (e) {
                this.postAssistant(`⚠️ ${e?.message ?? String(e)}`);
            }
            finally {
                this.busy = false;
                this.post({ command: 'busy', value: false });
            }
        });
        for (const m of this.history) {
            if (m.role === 'user')
                this.post({ command: 'addUser', text: m.content });
            if (m.role === 'assistant')
                this.postAssistant(m.content);
        }
    }
    post(msg) { this.view?.webview.postMessage(msg); }
    async persist() {
        await this.ctx.workspaceState.update('chatHistory', this.history.slice(-50));
    }
    postAssistant(text, actions = []) {
        const uiActions = actions.map(a => {
            const id = ++actionSeq;
            this.pendingActions.set(id, a);
            return { id, kind: a.kind, label: a.label };
        });
        this.post({ command: 'addAssistant', text, actions: uiActions });
    }
    /** Mostra status temporário "digitando…" com texto dinâmico. */
    setStatus(text) { this.post({ command: 'status', text }); }
    async handleUserMessage(text) {
        if (!text || !text.trim() || this.busy)
            return;
        this.busy = true;
        this.post({ command: 'busy', value: true });
        this.post({ command: 'addUser', text });
        this.history.push({ role: 'user', content: text.trim() });
        const agentPrompt = (0, deepseek_1.buildAgentPrompt)(text.trim(), this.history);
        this.lastPacket = agentPrompt;
        try {
            this.setStatus('Abrindo chat.deepseek.com na sua conta…');
            const answer = await this.browser.ask(agentPrompt, s => this.setStatus(s));
            this.history.push({ role: 'assistant', content: answer });
            await this.persist();
            const actions = (0, executor_1.buildActionsFromAnswer)(answer);
            this.postAssistant(answer, actions);
            if (actions.length > 0) {
                this.post({ command: 'hint', text: `💡 Detectei ${actions.length} ação(ões). Clique em "Executar"/"Criar" para aplicar (você aprova antes).` });
            }
        }
        catch (e) {
            this.history.push({ role: 'assistant', content: `⚠️ ${e?.message ?? e}` });
            await this.persist();
            this.postAssistant(`⚠️ ${e?.message ?? e}\n\nDicas:\n• Veja se a aba do chat está logada na sua conta.\n• Instale o userscript bridge (botão 📜) para envio/captura automáticos.\n• Ou use 🌐 → cole o prompt → envie → copie a resposta: eu capturo pelo clipboard.`);
        }
        finally {
            this.busy = false;
            this.post({ command: 'busy', value: false });
        }
    }
    async handleRunAction(id) {
        const action = this.pendingActions.get(id);
        if (!action)
            return;
        const ok = await (0, executor_1.approveAction)(action);
        if (!ok) {
            this.post({ command: 'actionStatus', id, status: 'cancelado ✋' });
            return;
        }
        try {
            const result = await (0, executor_1.applyAction)(action);
            this.post({ command: 'actionStatus', id, status: result });
        }
        catch (e) {
            this.post({ command: 'actionStatus', id, status: `erro: ${e.message}` });
        }
    }
    /** Copia o conteúdo do userscript para o clipboard e abre a página de instalação. */
    async installUserscript() {
        try {
            const uri = vscode.Uri.joinPath(this.ctx.extensionUri, 'assets', 'deepseek-agent.user.js');
            const bytes = await vscode.workspace.fs.readFile(uri);
            await vscode.env.clipboard.writeText(Buffer.from(bytes).toString('utf8'));
            await vscode.env.openExternal(vscode.Uri.parse('https://chat.deepseek.com/'));
            this.post({ command: 'hint', text: '📜 Userscript copiado! No navegador: Tampermonkey → Criar novo script → cole → Salvar. Depois volte ao chat e mande a mensagem de novo.' });
        }
        catch (e) {
            this.post({ command: 'hint', text: `⚠️ Não consegui abrir o userscript (${e.message}). Ele está no arquivo assets/deepseek-agent.user.js da extensão.` });
        }
    }
    getHtml() {
        return `<!DOCTYPE html>
<html lang="pt-br">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); display: flex; flex-direction: column; height: 100vh; background: var(--vscode-sideBar-background); color: var(--vscode-foreground); }
  #header { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 6px; }
  #header .title { font-weight: 600; flex: 1; }
  #header button { background: none; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-foreground); cursor: pointer; border-radius: 4px; padding: 2px 7px; }
  #chat { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 95%; padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.45; }
  .user { align-self: flex-end; background: var(--vscode-inputOption-activeBackground, #0e639c); color: var(--vscode-inputOption-activeForeground, #fff); }
  .assistant { align-self: flex-start; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
  .assistant pre { background: var(--vscode-textCodeBlock-background, rgba(0,0,0,.3)); padding: 8px; border-radius: 6px; overflow-x: auto; margin: 6px 0; }
  .assistant code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .sys { align-self: center; font-size: 11px; opacity: .75; text-align: center; }
  .actions { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  .action { display: flex; align-items: center; gap: 6px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 4px 6px; font-size: 12px; }
  .action code { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .action button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 3px 8px; cursor: pointer; }
  .action .status { font-size: 11px; opacity: .8; }
  #inputArea { display: flex; gap: 6px; padding: 10px; border-top: 1px solid var(--vscode-panel-border); }
  #input { flex: 1; resize: none; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px; padding: 8px; font-family: inherit; }
  #send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 6px; padding: 0 14px; cursor: pointer; }
  #send:disabled { opacity: .5; cursor: default; }
  .typing { font-style: italic; opacity: .8; }
</style>
</head>
<body>
  <div id="header">
    <span class="title">🤖 DeepSeek Agent</span>
    <button id="btnOpen" title="Abrir chat.deepseek.com (sua conta)">🌐</button>
    <button id="btnCopy" title="Copiar último prompt para colar no chat">📋</button>
    <button id="btnScript" title="Instalar userscript bridge (envio automático)">📜</button>
    <button id="btnClear" title="Limpar conversa">🗑</button>
  </div>
  <div id="chat"></div>
  <div id="inputArea">
    <textarea id="input" rows="2" placeholder="Ex.: Crie um servidor de Minecraft…"></textarea>
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

  function showTyping(txt){ removeTyping(); typingEl = addMsg('assistant','<span class="typing">'+esc(txt||'DeepSeek pensando…')+'</span>'); }
  function updateTyping(txt){ if(typingEl){ typingEl.querySelector('.typing').textContent = txt; } else showTyping(txt); }
  function removeTyping(){ if(typingEl){ typingEl.remove(); typingEl=null; } }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.command === 'addUser') addMsg('user', esc(m.text));
    if (m.command === 'addAssistant'){ removeTyping(); addMsg('assistant', renderMarkdown(m.text), m.actions); }
    if (m.command === 'hint') addMsg('sys', esc(m.text));
    if (m.command === 'status') updateTyping(m.text);
    if (m.command === 'busy'){ sendBtn.disabled = m.value; if (m.value) showTyping('Enviando ao chat.deepseek.com…'); }
    if (m.command === 'clear'){ chat.innerHTML=''; }
    if (m.command === 'actionStatus') updateActionStatus(m.id, m.status);
  });

  function updateActionStatus(id, status){
    const row = document.querySelector('.action[data-id="'+id+'"]');
    if (row) row.querySelector('.status').textContent = status;
  }

  function send(){
    const text = input.value.trim();
    if(!text || sendBtn.disabled) return;
    vscode.postMessage({ command:'send', text });
    input.value='';
  }
  sendBtn.onclick = send;
  input.addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); send(); }});
  document.getElementById('btnOpen').onclick = ()=> vscode.postMessage({command:'openChat'});
  document.getElementById('btnCopy').onclick = ()=> vscode.postMessage({command:'copyPacket'});
  document.getElementById('btnScript').onclick = ()=> vscode.postMessage({command:'installScript'});
  document.getElementById('btnClear').onclick = ()=> vscode.postMessage({command:'clear'});

  addMsg('sys','Peça algo, ex.: <b>"Crie um servidor de Minecraft"</b>. A extensão envia ao chat.deepseek.com (sua conta, sem API key), captura a resposta e aplica os comandos aqui — sempre pedindo sua aprovação.<br/>Primeiro uso: botão 🌐 para abrir/logar, 📜 para instalar o userscript de automação.');
</script>
</body>
</html>`;
    }
}
exports.ChatViewProvider = ChatViewProvider;
ChatViewProvider.viewType = 'deepseekAgent.chatView';
//# sourceMappingURL=chatView.js.map