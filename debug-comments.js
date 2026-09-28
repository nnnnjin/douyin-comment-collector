const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

/**
 * 调试工具 - 查看抖音视频页面的评论区结构
 */

async function debugCommentSection() {
  console.log('启动浏览器...');

  const chromePaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
  ].filter(Boolean);

  const userDataDir = path.join(__dirname, 'browser-data');

  let launchOptions = {
    headless: false,
    userDataDir: userDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1400,900'
    ]
  };

  for (const chromePath of chromePaths) {
    if (fs.existsSync(chromePath)) {
      launchOptions.executablePath = chromePath;
      break;
    }
  }

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();

  await page.setViewport({ width: 1400, height: 900 });

  console.log('\n请手动操作：');
  console.log('1. 在浏览器中搜索一个关键词');
  console.log('2. 点击一个视频进入详情页');
  console.log('3. 展开评论区');
  console.log('4. 然后按回车继续...\n');

  await page.goto('https://www.douyin.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  // 等待用户按回车
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
  });

  console.log('\n正在分析页面结构...\n');

  // 截图保存
  await page.screenshot({ path: 'debug-screenshot.png', fullPage: true });
  console.log('✓ 截图已保存: debug-screenshot.png');

  // 分析页面结构
  const pageInfo = await page.evaluate(() => {
    const info = {
      url: window.location.href,
      title: document.title,
      allCommentRelatedElements: [],
      commentButtons: [],
      possibleComments: []
    };

    // 查找所有包含 "comment" 的元素
    const allElements = document.querySelectorAll('*');
    allElements.forEach(el => {
      const className = el.className || '';
      const id = el.id || '';
      const dataAttrs = Array.from(el.attributes)
        .filter(attr => attr.name.startsWith('data-'))
        .map(attr => `${attr.name}="${attr.value}"`)
        .join(' ');

      if (className.toLowerCase().includes('comment') ||
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

    // 查找可能的评论按钮
    const buttons = document.querySelectorAll('button, div[role="button"], span[class*="icon"]');
    buttons.forEach(btn => {
      const text = btn.innerText || btn.getAttribute('aria-label') || '';
      if (text.includes('评论') || btn.className.includes('comment')) {
        info.commentButtons.push({
          tag: btn.tagName,
          className: btn.className,
          text: text,
          ariaLabel: btn.getAttribute('aria-label')
        });
      }
    });

    // 查找可能的评论内容
    const possibleCommentContainers = document.querySelectorAll(
      '[class*="list"], [class*="List"], [class*="container"], [class*="wrapper"]'
    );

    possibleCommentContainers.forEach(container => {
      const items = container.querySelectorAll('div, li');
      if (items.length > 3 && items.length < 100) {
        const sample = Array.from(items).slice(0, 3).map(item => ({
          className: item.className,
          text: item.innerText ? item.innerText.substring(0, 100) : '',
          hasUserLink: !!item.querySelector('a[href*="/user/"]')
        }));

        info.possibleComments.push({
          containerClass: container.className,
          itemCount: items.length,
          samples: sample
        });
      }
    });

    return info;
  });

  // 保存结果
  fs.writeFileSync('debug-page-info.json', JSON.stringify(pageInfo, null, 2));
  console.log('✓ 页面结构已保存: debug-page-info.json');

  console.log('\n=== 页面信息 ===');
  console.log('URL:', pageInfo.url);
  console.log('标题:', pageInfo.title);
  console.log('\n=== 找到的评论相关元素 ===');
  console.log(`共 ${pageInfo.allCommentRelatedElements.length} 个元素`);
  pageInfo.allCommentRelatedElements.slice(0, 10).forEach((el, i) => {
    console.log(`\n[${i + 1}] ${el.tag}`);
    console.log(`  class: ${el.className}`);
    console.log(`  id: ${el.id}`);
    console.log(`  data: ${el.dataAttrs}`);
    console.log(`  text: ${el.text}`);
    console.log(`  children: ${el.childCount}`);
  });

  console.log('\n=== 评论按钮 ===');
  console.log(`共 ${pageInfo.commentButtons.length} 个按钮`);
  pageInfo.commentButtons.forEach((btn, i) => {
    console.log(`\n[${i + 1}] ${btn.tag}`);
    console.log(`  class: ${btn.className}`);
    console.log(`  text: ${btn.text}`);
    console.log(`  aria-label: ${btn.ariaLabel}`);
  });

  console.log('\n=== 可能的评论列表 ===');
  console.log(`共 ${pageInfo.possibleComments.length} 个列表`);
  pageInfo.possibleComments.forEach((list, i) => {
    console.log(`\n[${i + 1}] ${list.containerClass}`);
    console.log(`  项目数: ${list.itemCount}`);
    console.log(`  示例:`);
    list.samples.forEach((sample, j) => {
      console.log(`    [${j + 1}] ${sample.className}`);
      console.log(`        ${sample.text}`);
      console.log(`        有用户链接: ${sample.hasUserLink}`);
    });
  });

  console.log('\n\n按回车关闭浏览器...');
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
  });

  await browser.close();
  console.log('完成！');
}

debugCommentSection().catch(console.error);
