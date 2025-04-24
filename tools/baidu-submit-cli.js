#!/usr/bin/env node
// 百度搜索资源平台URL提交CLI工具
import fetch from 'node-fetch';
import fs from 'fs/promises';
import { parseStringPromise } from 'xml2js';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

// 配置信息
const BAIDU_PUSH_URL = 'http://data.zz.baidu.com/urls';
const SITE_URL = 'https://tv.wdmatch.fun';
const BAIDU_TOKEN = 'OBVryJwzowXUUW40';

// 获取当前文件的目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// 创建readline接口
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

/**
 * 从sitemap.xml提取URL
 */
async function extractUrlsFromSitemap() {
  try {
    const sitemapPath = path.join(rootDir, 'sitemap.xml');
    const sitemapContent = await fs.readFile(sitemapPath, 'utf-8');
    
    const result = await parseStringPromise(sitemapContent);
    
    if (result.urlset && result.urlset.url) {
      return result.urlset.url.map(urlObj => urlObj.loc[0]);
    }
    
    return [];
  } catch (error) {
    console.error('提取sitemap URLs失败:', error);
    return [];
  }
}

/**
 * 提交URL到百度
 */
async function submitUrlsToBaidu(urls) {
  if (!urls || urls.length === 0) {
    console.log('没有URL需要提交');
    return;
  }
  
  const urlsString = urls.join('\n');
  const params = new URLSearchParams({
    site: SITE_URL,
    token: BAIDU_TOKEN
  });
  
  try {
    console.log(`开始提交 ${urls.length} 个URL到百度...`);
    
    const response = await fetch(`${BAIDU_PUSH_URL}?${params.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain'
      },
      body: urlsString
    });
    
    const result = await response.json();
    
    console.log('百度提交结果:', result);
    
    if (result.success) {
      console.log(`✅ 成功: 提交了 ${result.success} 个URL`);
      console.log(`ℹ️ 剩余配额: ${result.remain}`);
    }
    
    if (result.not_same_site && result.not_same_site.length > 0) {
      console.log(`⚠️ 非本站URL: ${result.not_same_site.join(', ')}`);
    }
    
    if (result.not_valid && result.not_valid.length > 0) {
      console.log(`⚠️ 不合法URL: ${result.not_valid.join(', ')}`);
    }
    
    return result;
  } catch (error) {
    console.error('❌ URL提交到百度失败:', error);
    throw error;
  }
}

/**
 * 显示主菜单并获取用户选择
 */
function showMenu() {
  console.log('\n百度搜索引擎URL提交工具');
  console.log('=======================');
  console.log('1. 从sitemap.xml提交所有URL');
  console.log('2. 手动输入URL提交');
  console.log('3. 退出');
  console.log('=======================');
  rl.question('请选择操作 (1-3): ', handleMenuChoice);
}

/**
 * 处理菜单选择
 */
async function handleMenuChoice(choice) {
  switch (choice) {
    case '1':
      await submitFromSitemap();
      break;
    case '2':
      await manualSubmit();
      break;
    case '3':
      console.log('感谢使用，再见！');
      rl.close();
      return;
    default:
      console.log('❌ 无效选择，请重新输入');
      break;
  }
  
  showMenu();
}

/**
 * 从sitemap提交URL
 */
async function submitFromSitemap() {
  try {
    console.log('正在从sitemap.xml提取URL...');
    const urls = await extractUrlsFromSitemap();
    
    if (urls.length === 0) {
      console.log('❌ sitemap.xml中没有找到URL');
      return;
    }
    
    console.log(`找到 ${urls.length} 个URL:`);
    urls.forEach((url, index) => {
      console.log(`${index + 1}. ${url}`);
    });
    
    rl.question('是否提交这些URL? (y/n): ', async (answer) => {
      if (answer.toLowerCase() === 'y') {
        await submitUrlsToBaidu(urls);
      } else {
        console.log('❌ 已取消提交');
      }
    });
    
  } catch (error) {
    console.error('❌ 从sitemap提交失败:', error);
  }
}

/**
 * 手动输入URL提交
 */
function manualSubmit() {
  console.log('请输入要提交的URL（每行一个，输入空行结束）:');
  
  const urls = [];
  
  function collectUrl() {
    rl.question('> ', (url) => {
      if (url.trim()) {
        urls.push(url.trim());
        collectUrl();
      } else {
        if (urls.length === 0) {
          console.log('❌ 未输入任何URL');
          return;
        }
        
        rl.question(`确认提交以上 ${urls.length} 个URL? (y/n): `, async (answer) => {
          if (answer.toLowerCase() === 'y') {
            await submitUrlsToBaidu(urls);
          } else {
            console.log('❌ 已取消提交');
          }
        });
      }
    });
  }
  
  collectUrl();
}

// 启动程序
console.log('百度搜索引擎URL提交工具 v1.0.0');
console.log('站点: ' + SITE_URL);
showMenu(); 