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
exports.BrowserChat = void 0;
exports.agentJsonToMarkdown = agentJsonToMarkdown;
const vscode = __importStar(require("vscode"));
/**
 * Modo WEB: conversa com o chat.deepseek.com usando a SUA CONTA (sem API key).
 *
 * Fluxo:
 *  1. Abre https://chat.deepseek.com/ numa aba dentro do VSCode (Simple Browser)
 *     ou no navegador externo. Você faz login ali — é a sua conta.
 *  2. Cada mensagem da extensão vira um "pacote" (marcador [DSKAGENT:XXXX] +
 *     prompt) colocado no clipboard.
 *  3. O userscript "assets/deepseek-agent.user.js" (Tampermonkey), rodando na
 *     página do chat, pega o pacote do clipboard, digita no chat, envia, espera
 *     a resposta do DeepSeek e devolve o JSON pelo clipboard.
 *  4. A extensão lê o clipboard, captura a resposta e propõe aplicar os comandos
 *     e arquivos aqui no VSCode (com aprovação).
 *
 * Sem o userscript também funciona de forma semi-automática: use o botão
 * "🌐 Abrir chat" , cole o prompt (Ctrl+V já está copiado), envie, e depois
 * copie a resposta do assistente (botão de copiar do próprio chat) — a
 * extensão detecta o JSON no clipboard automaticamente.
 */
const CHAT_URL = 'https://chat.deepseek.com/';
class BrowserChat {
    constructor(context) {
        this.context = context;
        this.pending = null;
    }
    /** Abre o chat numa aba do VSCode (Simple Browser) ou no navegador padrão. */
    async open() {
        const candidates = [
            'vscode.simple-browser.show', // id público em algumas versões
            'browser-preview.show', // id interno do Simple Browser
            'simpleBrowser.show',
        ];
        for (const cmd of candidates) {
            try {
                await vscode.commands.executeCommand(cmd, vscode.Uri.parse(CHAT_URL));
                return;
            }
            catch { /* tenta o próximo */ }
        }
        await vscode.env.openExternal(vscode.Uri.parse(CHAT_URL));
    }
    /** Envia o prompt (via clipboard+userscript) e espera a resposta do chat. */
    async ask(prompt, onStatus) {
        if (this.pending)
            throw new Error('Já existe uma mensagem sendo enviada ao chat. Aguarde a resposta atual terminar.');
        const token = 'DSKAGENT:' + Math.random().toString(36).slice(2, 8).toUpperCase();
        const packet = `[${token}]\n${prompt}`;
        await this.open();
        await vscode.env.clipboard.writeText(packet);
        onStatus?.('Prompt copiado ✅ — o userscript no chat deve pegá-lo automaticamente. ' +
            'Se não houver userscript: cole (Ctrl+V) e envie na aba do chat; depois COPIE a resposta — eu capturo sozinha.');
        return new Promise((resolve, reject) => {
            let settled = false;
            let waitingReply = false;
            let replyStartedAt = 0;
            const startAt = Date.now();
            const done = (fn) => {
                if (settled)
                    return;
                settled = true;
                clearInterval(poll);
                clearTimeout(hardTimer);
                this.pending = null;
                fn();
            };
            const poll = setInterval(async () => {
                let clip = '';
                try {
                    clip = await vscode.env.clipboard.readText();
                }
                catch {
                    return;
                }
                if (!clip.trim())
                    return;
                if (!waitingReply && clip.includes(token)) {
                    waitingReply = true;
                    replyStartedAt = Date.now();
                    onStatus?.('Pacote recebido pelo bridge ✅ aguardando resposta do DeepSeek…');
                    return;
                }
                const md = agentJsonToMarkdown(clip);
                if (md) {
                    // resposta chegou (userscript ou cópia manual)
                    done(() => resolve(md));
                    return;
                }
                if (waitingReply && Date.now() - replyStartedAt > 5 * 60 * 1000) {
                    done(() => reject(new Error('TIMEOUT esperando a resposta. Verifique a aba do chat: login feito? userscript instalado? ' +
                        'Ou envie manualmente e copie a resposta do assistente.')));
                    return;
                }
                if (Date.now() - startAt > 10 * 60 * 1000) {
                    done(() => reject(new Error('Tempo esgotado (10 min) aguardando o chat.deepseek.com responder.')));
                }
            }, 1000);
            const hardTimer = setTimeout(() => {
                done(() => reject(new Error('Tempo esgotado aguardando o chat.deepseek.com responder.')));
            }, 10 * 60 * 1000 + 15_000);
            this.pending = {
                resolve,
                reject: (e) => done(() => reject(e)),
                timer: hardTimer,
            };
        });
    }
    /** Copia o último prompt para o clipboard (fallback manual). */
    async copyPrompt(prompt) {
        await vscode.env.clipboard.writeText(prompt);
    }
    dispose() { }
}
exports.BrowserChat = BrowserChat;
/**
 * Converte a resposta-JSON do agente (vinda do chat) no markdown que o parser
 * da extensão já sabe transformar em ações (blocos ```bash e "Crie o arquivo X:").
 * Retorna null se o texto não for (ou conter) um JSON válido do agente.
 */
function agentJsonToMarkdown(raw) {
    let s = raw.trim();
    if (!s)
        return null;
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last <= first)
        return null;
    let obj;
    try {
        obj = JSON.parse(s.slice(first, last + 1));
    }
    catch {
        return null;
    }
    if (!obj || typeof obj !== 'object')
        return null;
    if (!('explicacao' in obj) && !('comandos' in obj) && !('arquivos' in obj))
        return null;
    const parts = [];
    if (typeof obj.explicacao === 'string' && obj.explicacao.trim())
        parts.push(obj.explicacao.trim());
    if (Array.isArray(obj.comandos) && obj.comandos.length) {
        parts.push('Comandos para executar:\n```bash\n' + obj.comandos.filter((c) => typeof c === 'string').join('\n') + '\n```');
    }
    if (Array.isArray(obj.arquivos)) {
        for (const f of obj.arquivos) {
            if (f && typeof f.nome === 'string' && typeof f.conteudo === 'string') {
                parts.push(`Crie o arquivo ${f.nome}:\n\`\`\`\n${f.conteudo}\n\`\`\``);
            }
        }
    }
    const md = parts.join('\n\n');
    return md ? md : null;
}
//# sourceMappingURL=browserChat.js.map