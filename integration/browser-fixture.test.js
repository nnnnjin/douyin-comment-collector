'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer');
const Collector = require('../douyin-comment-collector');

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
