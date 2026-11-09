// Copyright (c) 2026 wu. All rights reserved.
// Commercial use requires prior written permission from the copyright holder.
'use strict';

// Restrict discovery to the opened conversation; never type into search/comment fields.
async function findEditor(frame) {
  const handle = await frame.evaluateHandle(() => {
    const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const candidates = [...document.querySelectorAll('textarea, input, [contenteditable="true"], [contenteditable="plaintext-only"]')];
    return candidates.find(el => {
      if (!visible(el) || el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') return false;
      // A chat may contain input[type=button] whose value is "发送".
      // Its value is a button caption, never a draft.
      if (el.tagName === 'INPUT' && !['text', ''].includes(el.type)) return false;
      if (!['INPUT', 'TEXTAREA'].includes(el.tagName) && !el.isContentEditable) return false;
      const hint = `${el.getAttribute('placeholder') || ''} ${el.getAttribute('data-placeholder') || ''} ${el.getAttribute('aria-label') || ''}`;
      if (/搜索|评论|search/i.test(hint)) return false;
      const chat = el.closest('[role="dialog"], [data-e2e*="chat"], [data-e2e*="message"], [class*="chat"], [class*="Chat"], [class*="conversation"], [class*="Conversation"], [class*="message"], [class*="Message"]');
      return /消息|私信|message/i.test(hint) || Boolean(chat);
    }) || null;
  });
  const element = handle.asElement();
  if (!element) await handle.dispose();
  return element;
}

async function waitForMessageEditor(page, popups, { signal, timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw Object.assign(new Error('任务已停止'), { code: 'ABORTED' });
    for (const candidate of [page, ...popups]) {
      if (candidate.isClosed()) continue;
      for (const frame of candidate.frames()) {
        try {
          const input = await findEditor(frame);
          if (input) return { input, frame };
        } catch (error) {
          if (!/detached|destroyed|closed|context/i.test(error.message)) throw error;
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Object.assign(new Error('私信窗口等待15秒后仍无可用输入框，可能未打开会话、对方限制私信或页面结构变化'), { code: 'MESSAGE_EDITOR_TIMEOUT' });
}

// Runs inside the page. Kept self-contained so Puppeteer can serialize it.
// The editor and every ancestor are ignored, so a draft still in the input
// cannot be counted as a sent bubble.
function inspectDelivery(editor, message) {
  const normalize = value => String(value || '').replace(/[\u200B\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  const draftText = element => {
    if (['INPUT', 'TEXTAREA'].includes(element.tagName)) return normalize(element.value);
    const copy = element.cloneNode(true);
    copy.querySelectorAll('[data-slate-placeholder="true"], [data-lexical-placeholder="true"], [aria-hidden="true"], script, style').forEach(node => node.remove());
    const text = normalize(copy.textContent);
    const hasAttachment = Boolean(copy.querySelector('img, video, audio, [data-attachment], [data-mention], [data-slate-void="true"]'));
    return text || hasAttachment ? text || ' ' : '';
  };
  const editorEmpty = !editor || !draftText(editor);
  const target = normalize(message);
  if (!editor || !target) return { count: 0, editorEmpty };
  const root = editor.closest('[role="dialog"], [data-e2e*="chat"], [data-e2e*="message"], [class*="conversation"], [class*="Conversation"], [class*="chat"], [class*="Chat"]') || editor.ownerDocument.body;
  let count = 0;
  for (const element of root.querySelectorAll('*')) {
    if (element === editor || editor.contains(element) || element.contains(editor)) continue;
    const text = normalize(element.innerText || '');
    if (!text || !text.includes(target)) continue;
    const childHasMessage = [...element.children].some(child => normalize(child.innerText || '').includes(target));
    if (childHasMessage) continue;
    count += 1;
  }
  return { count, editorEmpty };
}

function clickSendButton() {
  const visible = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const label = element => (element.innerText || element.getAttribute('aria-label') || '').replace(/\s+/g, '');
  const target = [...document.querySelectorAll('button, [role="button"], [aria-label="发送"]')]
    .find(element => visible(element) && label(element) === '发送');
  if (!target) return false;
  target.click();
  return true;
}

// Runs inside the page. Read a clone: never remove or overwrite actual user content.
function inspectDraft(el) {
  const normalize = value => String(value || '').replace(/[\u200B\uFEFF]/g, '').trim();
  if (['INPUT', 'TEXTAREA'].includes(el.tagName)) {
    const text = normalize(el.value);
    return { hasDraft: Boolean(text), textLength: text.length, hasAttachment: false };
  }
  const copy = el.cloneNode(true);
  copy.querySelectorAll('[data-slate-placeholder="true"], [data-lexical-placeholder="true"], [aria-hidden="true"], script, style').forEach(node => node.remove());
  const text = normalize(copy.textContent);
  const hasAttachment = Boolean(copy.querySelector('img, video, audio, [data-attachment], [data-mention], [data-slate-void="true"]'));
  return { hasDraft: Boolean(text) || hasAttachment, textLength: text.length, hasAttachment };
}

// Runs inside the page. Click the profile action beside 关注, never the site-header 私信.
function clickProfileMessageButton() {
  const visible = element => {
    if (!element || typeof element.getClientRects !== 'function') return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const label = element => String(element.innerText || element.textContent || '').replace(/\s+/g, '');
  const follow = [...document.querySelectorAll('button, [role="button"], a')].find(element => (
    visible(element) && /^\+?(关注|已关注|互相关注|回关)$/.test(label(element))
  ));
  if (!follow || typeof follow.getBoundingClientRect !== 'function') return { clicked: false, reason: 'no-follow' };
  const followRect = follow.getBoundingClientRect();
  let container = follow.parentElement;
  for (let depth = 0; depth < 8 && container; depth += 1) {
    const candidates = [...container.querySelectorAll('button, [role="button"], a')].filter(element => {
      if (element === follow || !visible(element) || label(element) !== '私信') return false;
      if (typeof element.getBoundingClientRect !== 'function') return false;
      return Math.abs(element.getBoundingClientRect().top - followRect.top) < 80;
    });
    if (candidates.length) {
      candidates.sort((a, b) => (
        Math.abs(a.getBoundingClientRect().left - followRect.left) - Math.abs(b.getBoundingClientRect().left - followRect.left)
      ));
      candidates[0].click();
      return { clicked: true };
    }
    container = container.parentElement;
  }
  return { clicked: false, reason: 'no-profile-message' };
}

// Runs inside the page. Distinguish a real composer from a privacy notice or the inbox list.
function inspectMessageSurface() {
  const visible = element => {
    if (!element || typeof element.getClientRects !== 'function') return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const text = element => String((element && (element.innerText || element.textContent)) || '').replace(/\s+/g, ' ').trim();
  const restriction = /隐私设置|无法发送私信|无法私信|暂不支持私信|不支持给.{0,8}私信|对方关闭了私信|私信功能已关闭/;
  const notices = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [class*="toast"], [class*="Toast"], div, p, span')].filter(element => {
    if (!visible(element)) return false;
    const value = text(element);
    if (!value || value.length > 80 || !restriction.test(value)) return false;
    return ![...element.children].some(child => restriction.test(text(child)));
  });
  if (notices.length) return 'restricted';

  const panels = [...document.querySelectorAll('[role="dialog"], [data-e2e*="im"], [class*="im-list"], [class*="message-list"], [class*="MessageList"]')].filter(visible);
  for (const panel of panels) {
    const hasEditor = [...panel.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')].some(visible);
    const sample = text(panel).slice(0, 20);
    const rows = panel.querySelectorAll('[data-e2e*="conversation"], [class*="conversation-item"], [class*="ConversationItem"], li');
    if (!hasEditor && /^(私信|消息)/.test(sample) && rows.length >= 2) return 'inbox';
  }
  const href = String((typeof location !== 'undefined' && location.href) || '');
  if (/douyin\.com\/(?:im|message)(?:\/|$)/.test(href)) {
    const hasEditor = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')].some(visible);
    if (!hasEditor) return 'inbox';
  }
  return 'pending';
}

module.exports = {
  waitForMessageEditor, inspectDraft, inspectDelivery, clickSendButton, clickProfileMessageButton, inspectMessageSurface
};
