// ==UserScript==
// @name         DeepSeek Agent Bridge (VSCode)
// @namespace    https://github.com/local-dev/deepseek-agent-chat
// @version      1.0.0
// @description  Ponte entre a extensão "DeepSeek Agent Chat" do VSCode e o chat.deepseek.com: pega prompts marcados com [DSKAGENT:XXXX] vindos do clipboard, envia ao chat, espera a resposta e devolve em JSON pelo clipboard.
// @match        https://chat.deepseek.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const TOKEN_RE = /\[DSKAGENT:[A-Z0-9]+\]/;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function findBox() {
    let el = document.querySelector('textarea:not([disabled])')
          || document.querySelector('div[contenteditable="true"]:not([disabled])');
    if (el) return el;
    const cand = [...document.querySelectorAll('input[type="text"], input:not([type]), textarea, [contenteditable]')]
      .filter(e => /ask|question|message|prompt|pergunta|mensagem|deepseek/i.test(
        (e.getAttribute('placeholder') || '') + ' ' + (e.getAttribute('aria-label') || '')));
    return cand[0] || null;
  }

  function sendButtons() {
    return [...document.querySelectorAll('button')].filter(b => {
      if (b.disabled || b.closest('#__agentbar')) return false;
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const txt = (b.textContent || '').trim().toLowerCase();
      if (/send|enviar/.test(aria) || /^(send|enviar)$/.test(txt)) return true;
      const svg = b.querySelector('svg'); if (!svg) return false;
      const r = b.getBoundingClientRect();
      return r.width >= 10 && r.width <= 70 && r.height >= 10 && r.height <= 70;
    });
  }

  // última mensagem do assistente (blocos de markdown renderizado)
  function lastReply() {
    const sels = ['[class*="markdown"]', '.message-content', '[id^="msg-id"]', 'article'];
    let nodes = [];
    for (const s of sels) {
      const q = [...document.querySelectorAll(s)].filter(n => n.offsetHeight > 0 && !n.querySelector('textarea'));
      if (q.length) { nodes = q; break; }
    }
    if (!nodes.length) return '';
    const texts = nodes.map(n => (n.innerText || '').trim()).filter(Boolean);
    return texts.length ? texts[texts.length - 1] : '';
  }

  function injectBar() {
    let bar = document.getElementById('__agentbar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = '__agentbar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1f6feb;color:#fff;font:12px sans-serif;padding:5px 10px;box-shadow:0 2px 8px rgba(0,0,0,.4);white-space:pre-wrap;max-height:40vh;overflow:auto;';
    document.documentElement.appendChild(bar);
    return bar;
  }
  function say(t) { injectBar().textContent = '🤖 DeepSeek Agent Bridge: ' + t; }

  async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  async function trySend(box) {
    const before = lastReply();
    box.focus();
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    await sleep(1200);
    if (lastReply() !== before || !(box.value || box.textContent || '').length) return true;
    for (const b of sendButtons()) {
      b.click(); await sleep(1000);
      if (lastReply() !== before || !(box.value || box.textContent || '').length) return true;
    }
    return false;
  }

  function extractToken(prompt) {
    const m = prompt.match(TOKEN_RE);
    return m ? m[0] : '';
  }

  async function processPrompt(prompt) {
    const token = extractToken(prompt);
    say('Processando prompt do VSCode… (' + token + ')');

    // confirma recebimento ecoando o mesmo texto no clipboard
    await copyToClipboard(prompt);

    const box = findBox();
    if (!box) { say('❌ Não achei a caixa de mensagem. Você está logado?'); return; }

    box.focus();
    if ('value' in box) { box.value = prompt; }
    else {
      box.innerHTML = '';
      try { document.execCommand('insertText', false, prompt); } catch (e) { box.textContent = prompt; }
    }
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(700);

    const sent = await trySend(box);
    if (!sent) { say('⚠️ Texto digitado mas não consegui enviar — clique em Enviar manualmente.'); }

    say('Aguardando resposta do DeepSeek…');
    let last = '', stableSince = Date.now(), started = Date.now(), reply = '';
    while (Date.now() - started < 300000) {
      await sleep(1000);
      const cur = lastReply();
      if (cur && cur !== prompt) {
        reply = cur;
        if (cur === last) { if (Date.now() - stableSince > 4000) break; }
        else { last = cur; stableSince = Date.now(); }
      }
      say('Gerando resposta… ' + Math.round((Date.now() - started) / 1000) + 's');
    }

    if (!reply) { say('❌ Timeout: nenhuma resposta capturada.'); return; }

    // normaliza para JSON (tenta extrair se o modelo enrolou)
    let out = reply.trim();
    const first = out.indexOf('{'), final = out.lastIndexOf('}');
    if (first !== -1 && final > first) {
      try { JSON.parse(out.slice(first, final + 1)); out = out.slice(first, final + 1); } catch (e) { /* mantém cru */ }
    }
    const ok = await copyToClipboard(out);
    say(ok ? '✅ Resposta copiada! Volte ao VSCode.' : '❌ Não consegui copiar. Selecione e copie a resposta manualmente.');
  }

  // ----- loop principal: vigia o clipboard atrás de pacotes do VSCode -----
  let busy = false;
  let lastSeen = '';
  async function poll() {
    if (busy) return;
    let clip = '';
    try { clip = await navigator.clipboard.readText(); } catch (e) { return; }
    if (!clip || clip === lastSeen) return;
    if (!TOKEN_RE.test(clip)) return;
    // já respondemos este token?
    if (window.__dsAgentDone && window.__dsAgentDone.includes(extractToken(clip))) return;
    busy = true;
    lastSeen = clip;
    window.__dsAgentDone = (window.__dsAgentDone || []) .concat(extractToken(clip));
    try { await processPrompt(clip); } finally { busy = false; }
  }

  say('Ativo ✅ aguardando prompts do VSCode no clipboard.');
  setInterval(poll, 1500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
})();
