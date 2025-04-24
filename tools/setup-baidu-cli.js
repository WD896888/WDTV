#!/usr/bin/env node
// 设置百度URL提交命令行工具权限

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// 获取当前文件的目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CLI工具路径
const cliPath = path.join(__dirname, 'baidu-submit-cli.js');

async function setup() {
  try {
    console.log('设置百度URL提交命令行工具权限...');
    
    // 检查文件是否存在
    await fs.access(cliPath);
    
    // 设置执行权限
    await fs.chmod(cliPath, 0o755);
    
    // 在类UNIX系统上执行命令可能需要
    if (process.platform !== 'win32') {
      await execAsync(`chmod +x "${cliPath}"`);
    }
    
    console.log('百度URL提交命令行工具设置完成!');
    console.log(`您可以使用以下命令运行: npm run baidu-cli`);
  } catch (error) {
    console.error('设置百度URL提交命令行工具权限失败:', error);
  }
}

setup(); 