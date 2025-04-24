// 百度搜索资源平台URL提交API
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
 * 提交URL到百度
 */
async function submitUrlsToBaidu(urls) {
  if (!urls || urls.length === 0) {
    return { error: '没有URL需要提交' };
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
    return result;
  } catch (error) {
    console.error('URL提交到百度失败:', error);
    return { error: error.message };
  }
}

/**
 * API处理函数
 */
export default async function handler(req, res) {
  // 只接受POST请求
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只允许POST请求' });
  }
  
  try {
    const { useSitemap, manualUrls } = req.body;
    
    // 收集URL
    let urls = [];
    
    // 如果选择使用sitemap
    if (useSitemap) {
      const sitemapUrls = await extractUrlsFromSitemap();
      urls = [...urls, ...sitemapUrls];
    }
    
    // 如果提供了手动URL
    if (Array.isArray(manualUrls) && manualUrls.length > 0) {
      // 过滤掉空URL
      const filteredManualUrls = manualUrls.filter(url => url.trim().length > 0);
      urls = [...urls, ...filteredManualUrls];
    }
    
    // 去重
    urls = [...new Set(urls)];
    
    if (urls.length === 0) {
      return res.status(400).json({ error: '没有有效的URL需要提交' });
    }
    
    // 提交URL
    const result = await submitUrlsToBaidu(urls);
    
    // 返回结果
    return res.status(200).json(result);
  } catch (error) {
    console.error('百度URL提交API错误:', error);
    return res.status(500).json({ error: '服务器内部错误' });
  }
} 