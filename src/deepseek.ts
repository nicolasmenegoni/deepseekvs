import * as vscode from 'vscode';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/** Mensagem final que vai para o chat.deepseek.com (via aba logada na sua conta). */
export function buildAgentPrompt(userText: string, history: ChatMessage[]): string {
    const os = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
    const prev = history
        .filter(m => m.role !== 'system')
        .slice(-6)
        .map(m => `${m.role === 'user' ? 'USUÁRIO' : 'VOCÊ'}: ${m.content.slice(0, 400)}`)
        .join('\n');
    const ctx = prev ? `\nCONVERSA ANTERIOR (resumo):\n${prev}\n` : '';
    return [
        `Você é o backend de uma extensão do VSCode chamada DeepSeek Agent. A extensão vai executar os comandos que você gerar no computador do usuário (SO: ${os}, terminal já posicionado na pasta do projeto).`,
        ctx.trim() ? '' : null,
        `NOVA TAREFA DO USUÁRIO:\n${userText}`,
        '',
        'REGRAS:',
        `- Responda pensando em comandos para ${os}${os === 'Linux' ? ' (bash)' : ''}.`,
        '- Explique curto e direto em português brasileiro.',
        '- Um comando por linha, prontos para colar no terminal; sem sudo (avise se for indispensável).',
        '- Prefira comandos não-interativos (-y, --yes, DEBIAN_FRONTEND=noninteractive, npm init -y etc).',
        '- Se precisar criar arquivos, use a lista "arquivos" com caminho relativo à pasta do projeto.',
        '',
        'FORMATO DA RESPOSTA (OBRIGATÓRIO):',
        'Responda APENAS um objeto JSON válido — sem markdown, sem cercas de código, sem nenhum texto fora do JSON — neste esquema:',
        '{"explicacao":"plano e explicações em markdown pt-br","comandos":["cmd1","cmd2"],"arquivos":[{"nome":"caminho/arquivo.ext","conteudo":"conteúdo completo"}]}',
        '"comandos" na ordem exata de execução; use [] quando não houver comandos ou arquivos.'
        ,
    ].filter(l => l !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}
