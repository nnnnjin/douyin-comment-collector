'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer');
const Collector = require('../douyin-comment-collector');
const { waitForMessageEditor, inspectDraft, inspectDelivery, clickSendButton } = require('../message-editor');

test('does not confuse send button or structured placeholder with drafts; preserves real text and attachments', async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div role="dialog"><input type="button" value="发送"><div id="editor" contenteditable="true"><span data-slate-placeholder="true">请输入消息</span>\u200b<br></div></div>');
    const { input } = await waitForMessageEditor(page, new Set());
    assert.equal(await input.evaluate(el => el.id), 'editor');
    assert.equal((await input.evaluate(inspectDraft)).hasDraft, false);
    assert.match(await input.evaluate(el => el.textContent), /请输入消息/);
    await input.evaluate(el => { el.textContent = '请输入消息'; });
    assert.equal((await input.evaluate(inspectDraft)).hasDraft, true);
    await input.evaluate(el => { el.innerHTML = '<img alt="">'; });
    assert.equal((await input.evaluate(inspectDraft)).hasDraft, true);
    await input.dispose();
  } finally { await browser.close(); }
});

test('counts a sent bubble separately from the draft and can click the send button', async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="chat"><div id="editor" contenteditable="true">你好，测试</div></div>');
    const editor = await page.$('#editor');
    const before = await page.evaluate(inspectDelivery, editor, '你好，测试');
    assert.equal(before.count, 0);
    assert.equal(before.editorEmpty, false);
    await page.evaluate(() => {
      document.getElementById('editor').textContent = '';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.innerHTML = '<span>你好，测试</span>';
      document.querySelector('.chat').append(bubble);
      const send = document.createElement('button');
      send.textContent = '发送';
      document.body.append(send);
    });
    const after = await page.evaluate(inspectDelivery, editor, '你好，测试');
    assert.equal(after.count, 1);
    assert.equal(after.editorEmpty, true);
    assert.equal(await page.evaluate(clickSendButton), true);
    await editor.dispose();
  } finally { await browser.close(); }
});

test('waits for delayed iframe editor without role and ignores search and hidden inputs', async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<input placeholder="搜索消息"><textarea placeholder="消息" style="display:none"></textarea><iframe></iframe>');
    const frame = page.frames()[1];
    await frame.setContent('<div role="dialog" id="chat"></div>');
    await frame.evaluate(() => setTimeout(() => {
      document.getElementById('chat').innerHTML = '<div contenteditable="true"> </div>';
    }, 1200));
    const editor = await waitForMessageEditor(page, new Set(), { timeout: 4000 });
    assert.equal(editor.frame, frame);
    await editor.input.type('本地测试');
    assert.match(await editor.input.evaluate(el => el.textContent), /本地测试/);
    await editor.input.dispose();
    const popup = await browser.newPage();
    await popup.setContent('<textarea placeholder="发送消息"></textarea>');
    await page.setContent('<input placeholder="搜索消息">');
    const popupEditor = await waitForMessageEditor(page, new Set([popup]), { timeout: 1000 });
    assert.equal(popupEditor.frame, popup.mainFrame());
    await popupEditor.input.dispose();
    await assert.rejects(waitForMessageEditor(page, new Set(), { timeout: 300 }), { code: 'MESSAGE_EDITOR_TIMEOUT' });
  } finally { await browser.close(); }
});

test('bundled Chrome extracts comments from the local page fixture', async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.join(__dirname, '..', 'test', 'fixtures', 'comments-page.html')).href);
    const collector = new Collector({
      searchKeyword: '测试',
      commentKeywords: ['想要'],
      messageTemplate: '测试消息'
    });
    collector.page = page;
    const comments = await collector.extractDomComments('https://www.douyin.com/video/fixture', 1);
    assert.equal(comments.length, 2);
    assert.deepEqual(comments.map(comment => comment.username), ['用户甲', '用户乙']);
    assert.deepEqual(comments.map(comment => comment.content), ['我也想要', '怎么报名']);
    assert.ok(await collector.openCommentPanel());
  } finally {
    await browser.close();
  }
});
