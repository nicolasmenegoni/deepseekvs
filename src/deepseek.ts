import * as vscode from 'vscode';

const SECRET_KEY = 'deepseekAgent.apiKey';
const COOKIE_KEY = 'deepseekAgent.cookie';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

const SYSTEM_PROMPT_LINES = [
  'Você é um agente de IA dentro do VSCode que executa tarefas no computador do usuário (SO: {OS}).',
  'O usuário descreve um objetivo e você responde EXATAMENTE neste formato:',
  '',
  '1) Uma explicação curta em português.',
  '2) Blocos de código com três backticks seguidos de "bash" contendo os comandos necessários, na ordem, assumindo que o terminal já está na pasta do projeto.',
  '3) Se forem necessários arquivos novos, escreva "Crie o arquivo <nome.ext>:" antes de cada bloco de código com o conteúdo do arquivo.',
  '4) Ao final, pergunte se pode prosseguir ou liste próximos passos.',
  '',
  'Regras:',
  '- Um comando por linha; nunca use "sudo" sem avisar o motivo.',
  '- Prefira comandos não-interativos (ex.: apt-get install -y, npm init -y).',
  '- Nunca sugira apagar dados fora da pasta do projeto.'
];
export const SYSTEM_PROMPT = SYSTEM_PROMPT_LINES.join('\n');

/** Chama a API oficial do DeepSeek (OpenAI-compatible). */
export async function askDeepSeekApi(messages: ChatMessage[], context?: vscode.ExtensionContext): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('deepseekAgent');
    const baseUrl = cfg.get<string>('apiBaseUrl', 'https://api.deepseek.com').replace(/\/+$/, '');
    const model = cfg.get<string>('model', 'deepseek-chat');
    const key = await context?.secrets.get(SECRET_KEY);
    if (!key) {
        throw new Error(`API key não configurada. Use o comando "DeepSeek Agent: Configurar API Key" ou o botao de chave no chat.`);
    }
    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, stream: false, temperature: 0.2 }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`DeepSeek API respondeu ${res.status}: ${body.slice(0, 300)}`);
    }
    const json: any = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Resposta da API veio vazia.');
    return content;
}

/**
 * Modo WEB: abre chat.deepseek.com em um webview interno para o usuário fazer login
 * e copiar o Cookie da sessão, que depois é usado para chamadas à API interna do site.
 *
 * Observação: a API interna do chat.deepseek.com não é pública/estável — este modo é
 * experimental e pode quebrar a qualquer momento. O modo API é recomendado.
 */
let pendingWebPrompt: ((cookie: string) => void) | null = null;

export function resolveWebCookie(cookie: string) {
    if (pendingWebPrompt) { pendingWebCookie(cookie); }
}
function pendingWebCookie(c: string) { const cb = pendingWebPrompt!; pendingWebPrompt = null; cb(c); }

export function openLoginPage(): string {
    return 'https://chat.deepseek.com/';
}

export async function ensureCookie(context: vscode.ExtensionContext): Promise<string> {
    let cookie = await context.secrets.get(COOKIE_KEY);
    if (cookie) return cookie;
    return new Promise<string>((resolve, reject) => {
        pendingWebPrompt = resolve;
        vscode.window
            .showInformationMessage(
                'Faça login em chat.deepseek.com, abra DevTools (F12) → Network → qualquer requisição → copie o header "Cookie" completo, e cole abaixo.',
                'Abrir chat.deepseek.com',
                'Colar Cookie'
            )
            .then(async choice => {
                if (choice === 'Abrir chat.deepseek.com') {
                    await vscode.env.openExternal(vscode.Uri.parse('https://chat.deepseek.com/'));
                }
                if (choice === 'Colar Cookie' || choice === 'Abrir chat.deepseek.com') {
                    const value = await vscode.window.showInputBox({
                        prompt: 'Cole aqui o header Cookie da sessão do chat.deepseek.com',
                        password: true,
                        ignoreFocusOut: true,
                    });
                    if (!value) { pendingWebPrompt = null; reject(new Error('Cookie não informado.')); return; }
                    await context.secrets.store(COOKIE_KEY, value);
                    pendingWebCookie(value);
                } else {
                    pendingWebPrompt = null;
                    reject(new Error('Cancelado pelo usuário.'));
                }
            });
    });
}

/** Tenta usar a API interna do chat.deepseek.com com o cookie da sessão do usuário. */
export async function askDeepSeekWeb(messages: ChatMessage[], context: vscode.ExtensionContext): Promise<string> {
    const cookie = await ensureCookie(context);
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
    // Endpoint interno observado no app web (não documentado; pode mudar).
    const res = await fetch('https://chat.deepseek.com/api/v3/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
            Origin: 'https://chat.deepseek.com',
            Referer: 'https://chat.deepseek.com/',
        },
        body: JSON.stringify({
            messages,
            stream: false,
            model: 'deepseek-chat',
            inputs: [{ type: 'query', query: lastUser }],
        }),
    });
    if (res.status === 401 || res.status === 403) {
        await context.secrets.delete(COOKIE_KEY);
        throw new Error('Sessão expirada no chat.deepseek.com. Rode novamente e cole um Cookie novo (ou troque para o modo API).');
    }
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`chat.deepseek.com respondeu ${res.status}: ${body.slice(0, 300)}\n\n⚠️ O modo web é experimental. Recomendado: use o comando "Configurar API Key" e o modo "api".`);
    }
    const text = await res.text();
    // Aceita tanto JSON simples quanto SSE ("data: {...}")
    let answer = '';
    try {
        const json = JSON.parse(text);
        answer = json?.choices?.[0]?.message?.content ?? json?.content ?? '';
    } catch {
        for (const line of text.split('\n')) {
            const m = line.match(/^data:\s*(.+)$/);
            if (!m) continue;
            try {
                const obj = JSON.parse(m[1]);
                const delta = obj?.choices?.[0]?.delta?.content ?? obj?.content ?? '';
                answer += delta;
            } catch { /* ignora keep-alive */ }
        }
    }
    if (!answer) throw new Error('Não consegui interpretar a resposta do chat.deepseek.com (formato mudou?). Use o modo API.');
    return answer;
}

export async function askDeepSeek(messages: ChatMessage[], context: vscode.ExtensionContext): Promise<string> {
    const mode = vscode.workspace.getConfiguration('deepseekAgent').get<string>('mode', 'api');
    return mode === 'web' ? askDeepSeekWeb(messages, context) : askDeepSeekApi(messages, context);
}

// ---- Comandos de credenciais ----

export async function configureApiKey(context: vscode.ExtensionContext) {
    const existing = await context.secrets.get(SECRET_KEY);
    const value = await vscode.window.showInputBox({
        prompt: 'Sua API key do DeepSeek (crie em platform.deepseek.com → API Keys). Deixe vazio para remover.',
        password: true,
        ignoreFocusOut: true,
        placeHolder: existing ? '(já configurada — digite para substituir)' : 'sk-...',
    });
    if (value === undefined) return;
    if (value === '') { await context.secrets.delete(SECRET_KEY); vscode.window.showInformationMessage('API key removida.'); return; }
    await context.secrets.store(SECRET_KEY, value);
    const switchMode = await vscode.window.showInformationMessage('API key salva! Usar o modo API (recomendado)?', 'Sim', 'Não');
    if (switchMode === 'Sim') {
        await vscode.workspace.getConfiguration('deepseekAgent').update('mode', 'api', vscode.ConfigurationTarget.Global);
    }
}

export async function setCookieCommand(context: vscode.ExtensionContext) {
    await context.secrets.delete(COOKIE_KEY);
    try {
        await ensureCookie(context);
        await vscode.workspace.getConfiguration('deepseekAgent').update('mode', 'web', vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('Cookie salvo. Modo "web" ativado.');
    } catch (e: any) {
        vscode.window.showWarningMessage(e.message);
    }
}
