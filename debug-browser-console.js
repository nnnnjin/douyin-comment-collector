// Copyright (c) 2026 wu. All rights reserved.
// Commercial use requires prior written permission from the copyright holder.
// 简单的浏览器控制台脚本
// 在抖音视频页面打开浏览器控制台（F12），复制粘贴运行这个脚本

(function() {
  console.log('=== 抖音评论区调试工具 ===\n');

  const info = {
    url: window.location.href,
    title: document.title,
    allCommentRelatedElements: [],
    commentButtons: [],
    possibleComments: []
  };

  // 1. 查找所有包含 "comment" 的元素
  console.log('1. 查找包含 comment 的元素...');
  const allElements = document.querySelectorAll('*');
  allElements.forEach(el => {
    const className = el.className || '';
    const id = el.id || '';
    const dataAttrs = Array.from(el.attributes)
      .filter(attr => attr.name.startsWith('data-'))
      .map(attr => `${attr.name}="${attr.value}"`)
      .join(' ');

    if (className.toString().toLowerCase().includes('comment') ||
        id.toLowerCase().includes('comment') ||
        dataAttrs.toLowerCase().includes('comment')) {
      info.allCommentRelatedElements.push({
        tag: el.tagName,
        className: className.toString(),
        id: id,
        dataAttrs: dataAttrs,
        text: el.innerText ? el.innerText.substring(0, 50) : '',
        childCount: el.children.length
      });
    }
  });

  console.log(`找到 ${info.allCommentRelatedElements.length} 个相关元素`);
  console.log('前 10 个元素:');
  info.allCommentRelatedElements.slice(0, 10).forEach((el, i) => {
    console.log(`\n[${i + 1}] ${el.tag}`);
    console.log(`  class: ${el.className}`);
    console.log(`  id: ${el.id}`);
    console.log(`  text: ${el.text}`);
  });

  // 2. 查找评论按钮
  console.log('\n\n2. 查找评论按钮...');
  const buttons = document.querySelectorAll('button, div[role="button"], span, svg');
  buttons.forEach(btn => {
    const text = btn.innerText || btn.getAttribute('aria-label') || '';
    const className = btn.className || '';
    if (text.includes('评论') || className.toString().includes('comment')) {
      info.commentButtons.push({
        tag: btn.tagName,
        className: className.toString(),
        text: text,
        ariaLabel: btn.getAttribute('aria-label')
      });
    }
  });

  console.log(`找到 ${info.commentButtons.length} 个评论按钮`);
  info.commentButtons.forEach((btn, i) => {
    console.log(`\n[${i + 1}] ${btn.tag}`);
    console.log(`  class: ${btn.className}`);
    console.log(`  text: ${btn.text}`);
  });

  // 3. 查找可能的评论列表
  console.log('\n\n3. 查找评论列表...');
  const possibleCommentContainers = document.querySelectorAll(
    '[class*="list"], [class*="List"], [class*="container"], [class*="wrapper"]'
  );

  possibleCommentContainers.forEach(container => {
    const items = container.querySelectorAll('div, li');
    if (items.length > 2 && items.length < 200) {
      const samples = [];
      Array.from(items).slice(0, 3).forEach(item => {
        samples.push({
          className: item.className,
          text: item.innerText ? item.innerText.substring(0, 80) : '',
          hasUserLink: !!item.querySelector('a[href*="/user/"]')
        });
      });

      info.possibleComments.push({
        containerClass: container.className,
        itemCount: items.length,
        samples: samples
      });
    }
  });

  console.log(`找到 ${info.possibleComments.length} 个可能的列表`);
  info.possibleComments.slice(0, 5).forEach((list, i) => {
    console.log(`\n[${i + 1}] ${list.containerClass}`);
    console.log(`  项目数: ${list.itemCount}`);
    console.log(`  示例:`);
    list.samples.forEach((sample, j) => {
      console.log(`    [${j + 1}] ${sample.className.substring(0, 50)}`);
      console.log(`        ${sample.text.substring(0, 60)}`);
      console.log(`        有用户链接: ${sample.hasUserLink}`);
    });
  });

  // 4. 尝试直接提取评论
  console.log('\n\n4. 尝试直接提取评论内容...');
  const comments = [];

  // 尝试多种选择器
  const selectors = [
    '[class*="CommentItem"]',
    '[class*="comment-item"]',
    '[data-e2e="comment-item"]',
    'div[class*="comment"] div[class*="content"]'
  ];

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    console.log(`\n尝试选择器: ${selector}`);
    console.log(`找到 ${elements.length} 个元素`);

    if (elements.length > 0) {
      elements.forEach((el, i) => {
        if (i < 3) {
          console.log(`  [${i + 1}] ${el.className}`);
          console.log(`      ${el.innerText.substring(0, 100)}`);
        }
      });
    }
  }

  console.log('\n\n=== 调试完成 ===');
  console.log('请复制以上所有输出内容发给开发者');

  return info;
})();
