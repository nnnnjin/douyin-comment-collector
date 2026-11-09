// Copyright (c) 2026 wu. All rights reserved.
// Commercial use requires prior written permission from the copyright holder.
const puppeteer = require('puppeteer');

/**
 * 抖音网页版自动刷视频和点赞程序
 * 可配置刷视频频率和点赞频率
 */

class DouyinAutoPlayer {
  constructor(config = {}) {
    // 默认配置
    this.config = {
      videoInterval: config.videoInterval || 15000, // 刷视频间隔（毫秒），默认15秒
      likeInterval: config.likeInterval || 30000,   // 点赞间隔（毫秒），默认30秒
      likeChance: config.likeChance || 0.3,         // 点赞概率，默认30%
      maxVideos: config.maxVideos || 50,            // 最多刷多少个视频，0表示无限
      headless: config.headless !== undefined ? config.headless : false, // 是否无头模式
      douyinUrl: 'https://www.douyin.com/'
    };

    this.browser = null;
    this.page = null;
    this.videoCount = 0;
    this.likeCount = 0;
    this.isRunning = false;
  }

  /**
   * 初始化浏览器
   */
  async init() {
    console.log('正在启动浏览器...');

    // 尝试查找系统 Chrome 浏览器路径
    const chromePaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      process.env.CHROME_PATH
    ].filter(Boolean);

    let launchOptions = {
      headless: this.config.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled'
      ]
    };

    // 尝试使用系统 Chrome
    for (const chromePath of chromePaths) {
      try {
        const fs = require('fs');
        if (fs.existsSync(chromePath)) {
          launchOptions.executablePath = chromePath;
          console.log(`使用浏览器: ${chromePath}`);
          break;
        }
      } catch (err) {
        // 继续尝试下一个路径
      }
    }

    this.browser = await puppeteer.launch(launchOptions);

    this.page = await this.browser.newPage();

    // 设置视口大小
    await this.page.setViewport({ width: 1280, height: 800 });

    // 设置 User-Agent
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    console.log('浏览器启动成功！');
  }

  /**
   * 打开抖音网页版
   */
  async openDouyin() {
    console.log('正在打开抖音网页版...');

    // 直接打开推荐视频页面
    await this.page.goto('https://www.douyin.com/recommend', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // 等待页面加载
    await this.sleep(3000);
    console.log('抖音推荐页面加载完成！');
    console.log('提示：如需登录，请在浏览器中手动登录，然后程序会自动继续...');

    // 尝试点击进入全屏播放模式（如果有视频的话）
    try {
      await this.sleep(2000);
      // 尝试点击第一个视频进入播放模式
      const videoSelectors = [
        'div[data-e2e="feed-item"]',
        'div[class*="video-container"]',
        'div[class*="recommend-video"]',
        'xg-video-container'
      ];

      for (const selector of videoSelectors) {
        const video = await this.page.$(selector);
        if (video) {
          await video.click();
          console.log('已进入视频播放模式');
          await this.sleep(2000);
          break;
        }
      }
    } catch (error) {
      console.log('自动进入播放模式失败，请手动点击视频进入播放模式');
    }
  }

  /**
   * 等待函数
   */
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 添加随机延迟（模拟人类行为）
   */
  async randomDelay(baseMs, varianceMs = 1000) {
    const delay = baseMs + Math.random() * varianceMs;
    await this.sleep(delay);
  }

  /**
   * 滑动到下一个视频
   */
  async nextVideo() {
    try {
      // 模拟按下方向键向下或滚动
      await this.page.keyboard.press('ArrowDown');
      console.log(`✓ 切换到下一个视频 (已观看: ${++this.videoCount})`);
      return true;
    } catch (error) {
      console.error('切换视频失败:', error.message);
      return false;
    }
  }

  /**
   * 点赞当前视频
   */
  async likeVideo() {
    try {
      // 尝试多种可能的点赞按钮选择器
      const likeSelectors = [
        'div[class*="like"]',
        'svg[class*="icon-like"]',
        '[aria-label*="赞"]',
        'xg-icon[name="like"]'
      ];

      for (const selector of likeSelectors) {
        const likeButton = await this.page.$(selector);
        if (likeButton) {
          // 检查是否已经点赞
          const isLiked = await this.page.evaluate(el => {
            return el.classList.contains('active') ||
                   el.classList.contains('liked') ||
                   el.getAttribute('aria-pressed') === 'true';
          }, likeButton);

          if (!isLiked) {
            await likeButton.click();
            console.log(`❤️  点赞成功 (总点赞数: ${++this.likeCount})`);
            return true;
          } else {
            console.log('该视频已经点赞过了');
            return false;
          }
        }
      }

      // 如果找不到点赞按钮，使用键盘快捷键
      await this.page.keyboard.press('KeyZ');
      console.log(`❤️  点赞成功（快捷键）(总点赞数: ${++this.likeCount})`);
      return true;
    } catch (error) {
      console.error('点赞失败:', error.message);
      return false;
    }
  }

  /**
   * 主运行循环
   */
  async run() {
    await this.init();
    await this.openDouyin();

    // 等待用户登录（如果需要）
    console.log('\n等待 10 秒，请在此期间完成登录（如需要）...\n');
    await this.sleep(10000);

    this.isRunning = true;
    console.log('\n开始自动刷视频和点赞！');
    console.log(`配置: 视频间隔 ${this.config.videoInterval/1000}秒, 点赞概率 ${this.config.likeChance*100}%`);
    console.log('按 Ctrl+C 停止程序\n');

    let lastLikeTime = Date.now();

    while (this.isRunning) {
      // 检查是否达到最大视频数
      if (this.config.maxVideos > 0 && this.videoCount >= this.config.maxVideos) {
        console.log(`\n已达到最大视频数 ${this.config.maxVideos}，程序结束`);
        break;
      }

      // 决定是否点赞
      const currentTime = Date.now();
      const shouldLike = Math.random() < this.config.likeChance &&
                        (currentTime - lastLikeTime) >= this.config.likeInterval;

      if (shouldLike) {
        await this.likeVideo();
        lastLikeTime = currentTime;
        await this.randomDelay(2000, 1000);
      }

      // 等待指定的视频间隔时间
      await this.randomDelay(this.config.videoInterval, 2000);

      // 切换到下一个视频
      await this.nextVideo();
    }

    await this.close();
  }

  /**
   * 关闭浏览器
   */
  async close() {
    if (this.browser) {
      console.log('\n正在关闭浏览器...');
      console.log(`总计观看视频: ${this.videoCount}个`);
      console.log(`总计点赞: ${this.likeCount}次`);
      await this.browser.close();
      console.log('程序已退出');
    }
  }

  /**
   * 停止运行
   */
  stop() {
    this.isRunning = false;
  }
}

// 导出类
module.exports = DouyinAutoPlayer;

// 如果直接运行此文件
if (require.main === module) {
  const player = new DouyinAutoPlayer({
    videoInterval: 15000,  // 15秒切换一个视频
    likeInterval: 30000,   // 最少30秒点赞一次
    likeChance: 0.3,       // 30%概率点赞
    maxVideos: 0,          // 无限刷视频（设为0）
    headless: false        // 显示浏览器窗口
  });

  // 捕获 Ctrl+C 信号
  process.on('SIGINT', async () => {
    console.log('\n\n收到停止信号...');
    player.stop();
    await player.close();
    process.exit(0);
  });

  // 启动程序
  player.run().catch(error => {
    console.error('程序出错:', error);
    process.exit(1);
  });
}
