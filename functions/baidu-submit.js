// 百度搜索资源平台URL提交工具
import fetch from 'node-fetch';
import fs from 'fs/promises';
import { parseStringPromise } from 'xml2js';
import path from 'path';
import { fileURLToPath } from 'url';

// 配置信息
const BAIDU_PUSH_URL = 'http://data.zz.baidu.com/urls';
const SITE_URL = 'https://tv.wdmatch.fun';
const BAIDU_TOKEN = 'OBVryJwzowXUUW40';

// 获取当前文件的目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

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
 * 手动添加需要提交的URL列表
 */
function getAdditionalUrls() {
  // 可以在这里手动添加其他需要提交的URL
  return [
    `${SITE_URL}/`,
    `${SITE_URL}/about.html`,
    `${SITE_URL}/privacy.html`,
    `${SITE_URL}/player.html`,
    `${SITE_URL}/watch.html`
  ];
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
    const response = await fetch(`${BAIDU_PUSH_URL}?${params.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain'
      },
      body: urlsString
    });
    
    const result = await response.json();
    
    console.log('百度提交结果:', result);
    return result;
  } catch (error) {
    console.error('URL提交到百度失败:', error);
    throw error;
  }
}

/**
 * 主函数
 */
async function main() {
  try {
    // 从sitemap获取URL
    const sitemapUrls = await extractUrlsFromSitemap();
    
    // 获取额外的URL
    const additionalUrls = getAdditionalUrls();
    
    // 合并URL并去重
    const allUrls = [...new Set([...sitemapUrls, ...additionalUrls])];
    
    console.log(`准备提交 ${allUrls.length} 个URL到百度搜索资源平台...`);
    
    // 提交URL
    const result = await submitUrlsToBaidu(allUrls);
    
    if (result) {
      console.log(`成功提交 ${result.success} 个URL，剩余配额: ${result.remain}`);
      
      if (result.not_same_site && result.not_same_site.length > 0) {
        console.log('非本站URL:', result.not_same_site);
      }
      
      if (result.not_valid && result.not_valid.length > 0) {
        console.log('不合法URL:', result.not_valid);
      }
    }
  } catch (error) {
    console.error('百度URL提交失败:', error);
  }
}

// 执行主函数
main(); 