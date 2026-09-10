import path from 'path';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
// 本地账号 API：mini D1 mock + 云端 handleApi（与 Cloudflare Pages functions 共用同一实现）
import { createMiniD1 } from './functions/api/_mock-d1.mjs';
import { handleApi } from './functions/api/_lib.mjs';

dotenv.config();

// keep-alive 连接池：复用到上游的 TCP/TLS 连接，避免每个分片都重新握手
// （跨境/慢源每次握手可损耗数百毫秒，高并发预取下影响显著）
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  port: process.env.PORT || 8080,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  timeout: parseInt(process.env.REQUEST_TIMEOUT || '30000'),
  maxRetries: parseInt(process.env.MAX_RETRIES || '2'),
  cacheMaxAge: process.env.CACHE_MAX_AGE || '0',
  userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  debug: process.env.DEBUG === 'true'
};

const log = (...args) => {
  if (config.debug) {
    console.log('[DEBUG]', ...args);
  }
};

const app = express();

app.use(cors({
  origin: config.corsOrigin,
  methods: ['GET', 'POST', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// 仅解析 content-type: application/json 的请求体（账号 API 用），不影响 /proxy 流式代理与静态资源
app.use(express.json({ limit: '1mb' }));

// 本地账号 API：把 /api/* 请求转发给与云端共用的 handleApi（含 mini D1 mock 持久化）
const accountDb = createMiniD1({ file: path.join(__dirname, 'data', 'account-dev.json') });
const accountEnv = () => ({
  WDTV_DB: accountDb,
  AUTH_SECRET: process.env.AUTH_SECRET || 'wdtv-dev-secret',
  ALLOW_REGISTER: process.env.ALLOW_REGISTER || 'true'
});
app.use('/api', async (req, res) => {
  try {
    // req.path 在 /api 挂载点下为相对路径；originalUrl 还原完整 URL 供 handleApi 使用
    const url = new URL(req.originalUrl, 'http://localhost');
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    // 透传客户端请求头（剔除逐跳/传输层头），保证 If-None-Match 等条件请求语义完整；
    // content-length 必须剔除：body 会重新序列化，长度交给 Node 自行计算
    const headers = {};
    const SKIPPED = ['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'expect', 'content-length'];
    for (const [k, v] of Object.entries(req.headers)) {
      if (SKIPPED.includes(k)) continue;
      if (!hasBody && k === 'content-type') continue;
      headers[k] = v;
    }
    const request = new Request(url.href, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined
    });
    const resp = await handleApi(request, accountEnv());
    res.status(resp.status);
    // 逐头透传，跳过传输层头（Node 自行计算 content-length）
    resp.headers.forEach((v, k) => {
      if (!['content-length', 'transfer-encoding'].includes(k)) res.setHeader(k, v);
    });
    res.send(await resp.text());
  } catch (err) {
    console.error('账号 API 错误:', err);
    res.status(500).json({ error: '服务暂时不可用' });
  }
});

function renderPage(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  return content;
}

app.get(['/', '/index.html', '/player.html'], async (req, res) => {
  try {
    let filePath;
    switch (req.path) {
      case '/player.html':
        filePath = path.join(__dirname, 'player.html');
        break;
      default: // '/' 和 '/index.html'
        filePath = path.join(__dirname, 'index.html');
        break;
    }

    // HTML 禁用缓存：保证样式/脚本的版本号热更新能立即到达浏览器
    res.set('Cache-Control', 'no-store');
    const content = renderPage(filePath);
    res.send(content);
  } catch (error) {
    console.error('页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

app.get('/s=:keyword', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'index.html');
    const content = renderPage(filePath);
    res.send(content);
  } catch (error) {
    console.error('搜索页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

function isValidUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const allowedProtocols = ['http:', 'https:'];
    
    // 从环境变量获取阻止的主机名列表
    const blockedHostnames = (process.env.BLOCKED_HOSTS || 'localhost,127.0.0.1,0.0.0.0,::1').split(',');
    
    // 从环境变量获取阻止的 IP 前缀（仅私有网段：172.16.0.0/12 需逐段列出，避免误伤 172.0/15、172.32+ 等公网段）
    const blockedPrefixes = (process.env.BLOCKED_IP_PREFIXES || '192.168.,10.,172.16.,172.17.,172.18.,172.19.,172.20.,172.21.,172.22.,172.23.,172.24.,172.25.,172.26.,172.27.,172.28.,172.29.,172.30.,172.31.').split(',');
    
    if (!allowedProtocols.includes(parsed.protocol)) return false;
    if (blockedHostnames.includes(parsed.hostname)) return false;
    
    for (const prefix of blockedPrefixes) {
      if (parsed.hostname.startsWith(prefix)) return false;
    }
    
    return true;
  } catch {
    return false;
  }
}

app.get('/proxy/:encodedUrl', async (req, res) => {
  try {
    const encodedUrl = req.params.encodedUrl;
    const targetUrl = decodeURIComponent(encodedUrl);

    // 安全验证
    if (!isValidUrl(targetUrl)) {
      return res.status(400).send('无效的 URL');
    }

    log(`代理请求: ${targetUrl}`);

    // 添加请求超时和重试逻辑
    const maxRetries = config.maxRetries;
    let retries = 0;
    
    const makeRequest = async () => {
      try {
        return await axios({
          method: 'get',
          url: targetUrl,
          responseType: 'stream',
          timeout: config.timeout,
          httpAgent,
          httpsAgent,
          headers: {
            'User-Agent': config.userAgent,
            // BYTERANGE 分片：转发客户端 Range 头，上游按区间回 206（与 Cloudflare 版对齐）
            ...(req.headers.range ? { 'Range': req.headers.range } : {}),
            // 豆瓣图片CDN要求携带豆瓣站内Referer，否则按URL确定性返回418/403
            ...(targetUrl.includes('doubanio.com') || targetUrl.includes('douban.com')
              ? { 'Referer': 'https://movie.douban.com/' }
              : {})
          }
        });
      } catch (error) {
        // 仅对网络错误/超时重试；上游已返回HTTP状态码（4xx/5xx）时重试不会成功，只会拖慢响应
        if (retries < maxRetries && !error.response) {
          retries++;
          log(`重试请求 (${retries}/${maxRetries}): ${targetUrl}`);
          return makeRequest();
        }
        throw error;
      }
    };

    const response = await makeRequest();

    // 转发响应头（过滤敏感头）
    const headers = { ...response.headers };
    const sensitiveHeaders = (
      process.env.FILTERED_HEADERS || 
      'content-security-policy,cookie,set-cookie,x-frame-options,access-control-allow-origin'
    ).split(',');
    
    sensitiveHeaders.forEach(header => delete headers[header]);

    // 本地代理缓存策略：点播分片/图片可长缓存；m3u8 播放列表用短缓存
    const upstreamType = (headers['content-type'] || '').toLowerCase();
    headers['cache-control'] = upstreamType.includes('mpegurl')
      ? 'public, max-age=60'
      : 'public, max-age=86400';

    res.set(headers);

    // BYTERANGE 源：上游 206 分区响应原样透传状态码（axios 2xx 视为成功但 res 默认 200）
    if (response.status !== 200) {
      res.status(response.status);
    }

    // 管道传输响应流
    response.data.pipe(res);
  } catch (error) {
    console.error('代理请求错误:', error.message);
    if (error.response) {
      res.status(error.response.status || 500);
      error.response.data.pipe(res);
    } else {
      // 网络层错误（DNS/TCP/超时等）：附上底层原因，便于连接测试诊断
      const bits = [];
      if (error.code) bits.push(`code=${error.code}`);
      if (error.errno) bits.push(`errno=${error.errno}`);
      if (error.syscall) bits.push(`syscall=${error.syscall}`);
      if (error.hostname) bits.push(`host=${error.hostname}`);
      if (error.address) bits.push(`addr=${error.address}`);
      res.status(500).send(`请求失败: ${error.message}${bits.length ? ' | ' + bits.join(' | ') : ''}`);
    }
  }
});

// 静态资源禁用强缓存（css/js 版本号热更新立即生效；视频代理等大流量响应不受影响）
app.use(express.static(path.join(__dirname), {
  maxAge: config.cacheMaxAge,
  setHeaders: (res, filePath) => {
    if (/\.(html|css|js|json|webmanifest)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).send('服务器内部错误');
});

app.use((req, res) => {
  res.status(404).send('页面未找到');
});

// 启动服务器
app.listen(config.port, () => {
  console.log(`服务器运行在 http://localhost:${config.port}`);
  if (config.debug) {
    console.log('调试模式已启用');
    console.log('配置:', { ...config });
  }
});
