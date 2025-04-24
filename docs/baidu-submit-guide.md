# 百度搜索引擎URL提交工具使用指南

本文档说明如何使用百度搜索引擎URL提交工具，向百度搜索主动推送网站URL，缩短爬虫发现链接的时间。

## 功能特点

- 支持从sitemap.xml自动提取URL
- 支持手动输入URL进行提交
- 提供命令行工具、API接口和Web界面
- 支持GitHub Actions自动化定期提交

## 使用方法

### 1. 命令行工具

命令行工具提供了交互式界面，方便开发者快速提交URL。

```bash
# 运行命令行工具
npm run baidu-cli
```

工具将显示菜单:
1. 从sitemap.xml提交所有URL
2. 手动输入URL提交
3. 退出

### 2. 自动化脚本

自动化脚本可以从sitemap.xml中提取URL并提交到百度搜索引擎。

```bash
# 运行自动化脚本
npm run baidu-submit
```

### 3. Web管理界面

Web管理界面位于`/admin/baidu-submit.html`，提供友好的图形界面，方便非技术人员使用。

访问地址: `https://你的网站域名/admin/baidu-submit.html`

### 4. GitHub Actions自动化

本项目已配置GitHub Actions工作流，会在每周一和周四的凌晨3点自动提交URL到百度搜索引擎。

GitHub Actions配置文件: `.github/workflows/baidu-submit.yml`

您也可以在GitHub仓库页面手动触发工作流。

## API接口说明

如果需要在其他应用中集成URL提交功能，可以使用API接口:

- 接口地址: `/api/baidu-submit`
- 请求方式: POST
- 请求参数:
  - `useSitemap`: 布尔值，是否使用sitemap.xml提取URL
  - `manualUrls`: 数组，手动输入的URL列表

示例请求:

```javascript
fetch('/api/baidu-submit', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    useSitemap: true,
    manualUrls: ['https://example.com/page1.html']
  })
})
.then(response => response.json())
.then(data => console.log(data));
```

## 配额说明

- 百度搜索资源平台对URL提交有配额限制
- API提交和手动提交共享配额，sitemap提交配额不与其他方式共享
- 配额不可累计，当日有效
- 具体配额以站点页面显示数据为准

## 常见问题

**Q: 提交URL后多久能被收录?**

A: 百度搜索引擎会在收到提交后尽快处理，但不保证收录时间和展现效果。

**Q: 提交后显示"非本站URL"是什么原因?**

A: 确保提交的URL与在百度搜索资源平台验证的站点一致。例如，如果验证的是`www.example.com`，则不应提交`example.com`的URL。

**Q: 如何修改准入密钥?**

A: 需要修改以下文件中的`BAIDU_TOKEN`变量:
- `functions/baidu-submit.js`
- `api/baidu-submit.js`
- `tools/baidu-submit-cli.js` 