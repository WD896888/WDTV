# WDTV - 免费在线视频搜索与观看平台

<div align="center">
  <img src="image/logo.png" alt="WDTV Logo" width="120">
  <br>
  <p><strong>自由观影，畅享精彩</strong></p>
</div>

## 📺 项目简介

WDTV 是一个轻量级、免费的在线视频搜索与观看平台，提供来自多个视频源的内容搜索与播放服务。无需注册，即开即用，支持多种设备访问。项目结合了前端技术和后端代理功能，可部署在支持服务端功能的各类网站托管服务上。**项目门户**： [libretv.is-an.org](https://libretv.is-an.org)

## 🚨 重要声明

- 本项目仅供学习和个人使用，为避免版权纠纷，请勿公开分享版权内容
- 请勿将部署的实例用于商业用途或公开服务
- 如因公开分享导致的任何法律问题，用户需自行承担责任
- 项目开发者不对用户的使用行为承担任何法律责任

## ⚠️ 同步与升级

对于更新可能会出现的错误和异常，在设置中备份配置后，首先清除页面Cookie，然后 Ctrl + F5 刷新页面。再次访问网页检查是否解决问题。


## 📋 详细部署指南

### Cloudflare Pages

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 Pages 服务
2. 点击"创建项目"，连接 Git 仓库，使用以下设置：
   - 构建命令：留空（无需构建）
   - 输出目录：留空（默认为根目录）
   - 项目配置（环境变量等）由仓库根目录的 `wrangler.toml` 提供，Dashboard 中的同名变量会被忽略
3. （可选，推荐）创建 KV 命名空间作为 M3U8 代理缓存：
   ```bash
   npx wrangler kv namespace create LIBRETV_PROXY_KV
   ```
   将返回的 `id` 填入 `wrangler.toml` 的 `[[kv_namespaces]]` 段并取消注释；未绑定 KV 时代理仍正常工作
4. CLI 手动部署（可选）：`npx wrangler pages deploy . --project-name=wdtv`

**与 Vercel 版对齐的优化（Cloudflare 专属文件）：**

| 文件 | 作用 |
| --- | --- |
| `_headers` | 静态资源缓存：`/js/` `/css/` `/image/` 缓存 1 天，`/libs/` 长缓存 1 年（immutable） |
| `_redirects` | `/s=xxx` 搜索短链重写到首页（200 重写，非跳转） |
| `_routes.json` | 仅 `/proxy/*` 走 Pages Function，其余请求纯静态直出（更低延迟、不消耗 Functions 配额） |
| `wrangler.toml` | Pages 项目配置：环境变量（`CACHE_TTL`/`M3U8_CACHE_TTL`/`DEBUG`）与 KV 绑定 |

代理函数 `functions/proxy/[[path]].js` 与 Vercel 版行为一致：m3u8 短缓存（120s）与 ts 分片长缓存（24h）分离、KV 缓存处理后的 m3u8、上游 30s 超时保护、豆瓣 Referer 防盗链、二进制透传响应头过滤。

### Vercel

1. 登录 [Vercel](https://vercel.com/)，点击"New Project"
2. 导入您的仓库，使用默认设置
3. 点击"Deploy"


### Docker
```
docker run -d \
  --name libretv \
  --restart unless-stopped \
  -p 8899:8080 \
  bestzwei/libretv:latest
```

### Docker Compose

`docker-compose.yml` 文件：

```yaml
services:
  libretv:
    image: bestzwei/libretv:latest
    container_name: libretv
    ports:
      - "8899:8080" # 将内部 8080 端口映射到主机的 8899 端口
    restart: unless-stopped
```
启动 WDTV：

```bash
docker compose up -d
```
访问 `http://localhost:8899` 即可使用。

### 本地开发环境

项目包含后端代理功能，需要支持服务器端功能的环境：

```bash
# 首先，通过复制示例来设置 .env 文件（可选）
cp .env.example .env

# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

访问 `http://localhost:8080` 即可使用（端口可在.env文件中通过PORT变量修改）。

> ⚠️ 注意：使用简单静态服务器（如 `python -m http.server` 或 `npx http-server`）时，视频代理功能将不可用，视频无法正常播放。完整功能测试请使用 Node.js 开发服务器。

## 账号系统（登录 / 数据云同步）

注册登录后，观影历史、播放进度、我的影院收藏、搜索历史与偏好设置将跨设备自动同步，并支持自定义头像与昵称。

### 一次性部署步骤（Cloudflare Pages）

```bash
npx wrangler d1 create wdtv-users          # 记下 database_id 填入 wrangler.toml
npx wrangler d1 execute wdtv-users --file=./schema.sql --remote
npx wrangler pages secret put AUTH_SECRET  # 生成：openssl rand -base64 32
```

### 说明

- 在 `wrangler.toml` 的 `[vars]` 中设置 `ALLOW_REGISTER="false"` 可关闭开放注册
- 密码在浏览器端经 PBKDF2 慢哈希后提交，服务端仅存 HMAC(AUTH_SECRET, 哈希)，即使数据库泄露也无法还原密码
- 用户数据整包存储于 D1（每用户 1 行），免费额度内自用绰绰有余
- 本地 `node server.mjs` 已实现同形 API，可直接体验完整账号功能

## 🔧 自定义配置

### API兼容性

WDTV 支持标准的苹果 CMS V10 API 格式。添加自定义 API 时需遵循以下格式：
- 搜索接口: `https://example.com/api.php/provide/vod/?ac=videolist&wd=关键词`
- 详情接口: `https://example.com/api.php/provide/vod/?ac=detail&ids=视频ID`

**添加 CMS 源**:
1. 在设置面板中选择"自定义接口"
2. 接口地址: `https://example.com/api.php/provide/vod`

## ⌨️ 键盘快捷键

播放器支持以下键盘快捷键：

- **空格键**: 播放/暂停
- **左右箭头**: 快退/快进
- **上下箭头**: 音量增加/减小
- **M 键**: 静音/取消静音
- **F 键**: 全屏/退出全屏
- **Esc 键**: 退出全屏

## 🛠️ 技术栈

- HTML5 + CSS3 + JavaScript (ES6+)
- Tailwind CSS
- HLS.js 用于 HLS 流处理
- DPlayer 视频播放器核心
- Cloudflare/Vercel/Netlify Serverless Functions
- 服务端 HLS 代理和处理技术
- localStorage 本地存储

## ⚠️ 免责声明

WDTV 仅作为视频搜索工具，不存储、上传或分发任何视频内容。所有视频均来自第三方 API 接口提供的搜索结果。如有侵权内容，请联系相应的内容提供方。

本项目开发者不对使用本项目产生的任何后果负责。使用本项目时，您必须遵守当地的法律法规。

## 🤝 衍生项目

它们提供了更多丰富的自定义功能，欢迎体验~

- **MoonTV**  
- **OrionTV**  

## 🥇 感谢支持

- **[Sharon](https://sharon.io)**
- **[ZMTO](https://zmto.com)**
- **[YXVM](https://yxvm.com)**  