// 本地开发用 mini D1 mock：对齐 Cloudflare D1 的 prepare/bind/first/all/run 接口
// 仅供 server.mjs（本地账号 API）与 test-sync.mjs（同步自测脚本）共用
// 仅支持 functions/api/_lib.mjs 实际使用的 8 条 SQL，未识别语句直接 reject 便于测试暴露失配
import fs from 'fs';
import path from 'path';

// 规范化 SQL：合并连续空白并去首尾，保证前缀匹配不受换行/多空格影响
function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

// 8 条受支持语句的规范化前缀（与 _lib.mjs 契约一一对应）
const SQL_USERS_BY_NAME = 'SELECT * FROM users WHERE username = ?';
const SQL_USERS_INSERT = 'INSERT INTO users (username, salt, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)';
const SQL_USERS_UPDATE_NAME = 'UPDATE users SET display_name = ? WHERE id = ?';
const SQL_DATA_SELECT = 'SELECT payload, revision FROM user_data WHERE user_id = ?';
const SQL_DATA_INSERT = 'INSERT INTO user_data (user_id, payload, revision, updated_at) VALUES (?, ?, ?, ?)';
const SQL_DATA_UPDATE = 'UPDATE user_data SET payload = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?';
const SQL_AVATAR_SELECT = 'SELECT data, updated_at FROM avatars WHERE user_id = ?';
const SQL_AVATAR_UPSERT = 'INSERT INTO avatars (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at';

export function createMiniD1(options = {}) {
  const file = options.file || null;

  // 内部数据结构：三张表，users 行含自增 id
  let data = { users: [], user_data: [], avatars: [] };

  // 启动时加载持久化文件；文件缺失/损坏均从空库开始
  if (file && fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        data = {
          users: Array.isArray(parsed.users) ? parsed.users : [],
          user_data: Array.isArray(parsed.user_data) ? parsed.user_data : [],
          avatars: Array.isArray(parsed.avatars) ? parsed.avatars : []
        };
      }
    } catch {
      // JSON 解析失败（文件损坏）：从空库开始，下次写入时覆盖
      data = { users: [], user_data: [], avatars: [] };
    }
  }

  // 每次数据变更后同步落盘；数据量小，writeFileSync 无性能问题
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      // 落盘失败不中断请求（本地开发容错），但打印便于排查
      console.error('mock-d1 持久化失败:', err.message);
    }
  }

  // users 表自增 id：取当前最大 id + 1
  function nextUserId() {
    return data.users.reduce((max, u) => Math.max(max, Number(u.id) || 0), 0) + 1;
  }

  // 未识别 SQL：统一 reject，便于测试暴露 _lib 与 mock 的失配
  function unsupported(sql) {
    return Promise.reject(new Error('mock-d1 unsupported sql: ' + sql));
  }

  // 执行已识别语句的核心逻辑；kind 区分返回值形态
  function execute(normSql, binds, kind) {
    // S1：按用户名查用户，first 返回整行或 null；all 返回单元素数组
    if (normSql.startsWith(SQL_USERS_BY_NAME)) {
      const row = data.users.find(u => u.username === binds[0]) || null;
      if (kind === 'all') return Promise.resolve({ results: row ? [row] : [] });
      return Promise.resolve(row);
    }
    // S2：新增用户，返回自增 id
    if (normSql.startsWith(SQL_USERS_INSERT)) {
      const row = {
        id: nextUserId(),
        username: binds[0],
        salt: binds[1],
        password_hash: binds[2],
        display_name: binds[3],
        created_at: binds[4]
      };
      data.users.push(row);
      save();
      return Promise.resolve({ meta: { changes: 1, last_row_id: row.id } });
    }
    // S3：按 id 更新昵称，changes 为实际更新条数
    if (normSql.startsWith(SQL_USERS_UPDATE_NAME)) {
      const target = data.users.find(u => Number(u.id) === Number(binds[1]));
      let changes = 0;
      if (target) {
        target.display_name = binds[0];
        changes = 1;
        save();
      }
      return Promise.resolve({ meta: { changes, last_row_id: null } });
    }
    // S4：查用户数据，first 仅返回 SELECT 列（对齐 D1 行为）
    if (normSql.startsWith(SQL_DATA_SELECT)) {
      const row = data.user_data.find(r => r.user_id === binds[0]) || null;
      const picked = row ? { payload: row.payload, revision: row.revision } : null;
      if (kind === 'all') return Promise.resolve({ results: picked ? [picked] : [] });
      return Promise.resolve(picked);
    }
    // S5：首次写入用户数据；主键冲突抛 UNIQUE 错误（对齐 D1 报错文案）
    if (normSql.startsWith(SQL_DATA_INSERT)) {
      if (data.user_data.some(r => r.user_id === binds[0])) {
        return Promise.reject(new Error('UNIQUE constraint failed: user_data.user_id'));
      }
      data.user_data.push({
        user_id: binds[0],
        payload: binds[1],
        revision: binds[2],
        updated_at: binds[3]
      });
      save();
      return Promise.resolve({ meta: { changes: 1, last_row_id: null } });
    }
    // S6：乐观锁更新，仅 user_id 与 revision 均匹配才生效（revision + 1）
    if (normSql.startsWith(SQL_DATA_UPDATE)) {
      const row = data.user_data.find(
        r => r.user_id === binds[2] && Number(r.revision) === Number(binds[3])
      );
      let changes = 0;
      if (row) {
        row.payload = binds[0];
        row.revision = Number(row.revision) + 1;
        row.updated_at = binds[1];
        changes = 1;
        save();
      }
      return Promise.resolve({ meta: { changes, last_row_id: null } });
    }
    // S7：查头像，first 仅返回 SELECT 列
    if (normSql.startsWith(SQL_AVATAR_SELECT)) {
      const row = data.avatars.find(r => r.user_id === binds[0]) || null;
      const picked = row ? { data: row.data, updated_at: row.updated_at } : null;
      if (kind === 'all') return Promise.resolve({ results: picked ? [picked] : [] });
      return Promise.resolve(picked);
    }
    // S8：头像 upsert（ON CONFLICT 更新），changes 恒为 1
    if (normSql.startsWith(SQL_AVATAR_UPSERT)) {
      const row = data.avatars.find(r => r.user_id === binds[0]);
      if (row) {
        row.data = binds[1];
        row.updated_at = binds[2];
      } else {
        data.avatars.push({ user_id: binds[0], data: binds[1], updated_at: binds[2] });
      }
      save();
      return Promise.resolve({ meta: { changes: 1, last_row_id: null } });
    }
    return unsupported(normSql);
  }

  // 构造绑定参数后的语句对象；也允许不经 bind 直接调用（对齐 D1 接口习惯）
  function makeStatement(sql, binds) {
    return {
      bind: (...args) => makeStatement(sql, args),
      first: () => execute(normalizeSql(sql), binds, 'first'),
      all: () => execute(normalizeSql(sql), binds, 'all'),
      run: () => execute(normalizeSql(sql), binds, 'run')
    };
  }

  return {
    prepare: (sql) => makeStatement(sql, [])
  };
}
