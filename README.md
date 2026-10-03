# DeepSeek Agent Chat (VSCode)

Agente no VSCode que conversa **direto no chat.deepseek.com usando a sua conta** — sem API key, sem custo de API. A extensão envia sua mensagem para o chat, captura a resposta do DeepSeek e executa os comandos/arquivos sugeridos aqui no VSCode (sempre pedindo sua aprovação).

## Como funciona (sem API!)

1. Você digita no chat da barra lateral (ex.: "Crie um servidor de Minecraft").
2. A extensão abre `https://chat.deepseek.com/` numa aba do VSCode (Simple Browser) ou no seu navegador — você usa o login da sua conta normalmente.
3. Sua mensagem vira um prompt de agente (com marcador `[DSKAGENT:XXXX]`) e é colocada no clipboard.
4. O **userscript bridge** (`assets/deepseek-agent.user.js`, rodando via Tampermonkey na página do chat) pega o prompt do clipboard, digita no chat, envia, espera a resposta e devolve em JSON pelo clipboard.
5. A extensão lê o clipboard, captura a resposta e mostra botões **Executar** (terminal integrado) / **Criar** (arquivo), com confirmação antes de cada ação.

## Instalação

```bash
npm install
npm run compile
npm run package        # gera o .vsix
code --install-extension deepseek-agent-chat-0.2.0.vsix
```

### Userscript (para automação total)
1. Instale o Tampermonkey no navegador (ou use a aba 🌐 dentro do VSCode com o botão 📜 para copiar o script).
2. Tampermonkey → "Create a new script" → cole o conteúdo de `assets/deepseek-agent.user.js` → Salvar.
3. Faça login em `https://chat.deepseek.com/`. Pronto.

## Sem userscript (modo semi-automático)
A extensão copia o prompt para o clipboard automaticamente. Basta:
- `Ctrl+V` + Enviar na aba do chat;
- quando o DeepSeek terminar, clique no botão **copiar** da resposta no site;
- a extensão detecta o JSON no clipboard sozinha e cria os botões de ação.

## Segurança
- Nada roda sozinho: cada comando/arquivo exige confirmação (e preview de diff se o arquivo já existir).
- Comandos sensíveis (`rm -rf`, `sudo`, pipes para shell…) exigem digitar `EXECUTAR`.
- Nenhuma chave de API é usada ou armazenada.
