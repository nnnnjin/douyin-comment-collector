/**
 * 快速启动脚本
 * 使用自定义配置运行抖音自动刷视频程序
 */

const DouyinAutoPlayer = require('./douyin-auto');

// 尝试加载自定义配置，如果不存在则使用默认配置
let config;
try {
  config = require('./config.js');
  console.log('✓ 已加载自定义配置文件');
} catch (error) {
  console.log('ℹ 未找到 config.js，使用默认配置');
  config = {
    videoInterval: 15000,
    likeInterval: 30000,
    likeChance: 0.3,
    maxVideos: 0,
    headless: false
  };
}

// 创建播放器实例
const player = new DouyinAutoPlayer(config);

// 捕获 Ctrl+C 信号，优雅退出
process.on('SIGINT', async () => {
  console.log('\n\n收到停止信号...');
  player.stop();
  await player.close();
  process.exit(0);
});

// 捕获未处理的错误
process.on('unhandledRejection', (error) => {
  console.error('未处理的错误:', error);
  player.stop();
  process.exit(1);
});

// 启动程序
console.log('='.repeat(50));
console.log('抖音自动刷视频程序');
console.log('='.repeat(50));
console.log(`视频间隔: ${config.videoInterval / 1000} 秒`);
console.log(`点赞间隔: ${config.likeInterval / 1000} 秒`);
console.log(`点赞概率: ${config.likeChance * 100}%`);
console.log(`最大视频数: ${config.maxVideos === 0 ? '无限制' : config.maxVideos}`);
console.log('='.repeat(50));
console.log('\n');

player.run().catch(error => {
  console.error('程序运行出错:', error);
  process.exit(1);
});
