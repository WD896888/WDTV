// 本地开发用 mini D1 mock：对齐 Cloudflare D1 的 prepare/bind/first/all/run 接口
// 仅供 server.mjs（本地账号 API）使用
// 仅支持 functions/api/_lib.mjs 实际使用的 17 条 SQL，未识别语句直接 reject 便于测试暴露失配
// 顶层绝不静态 import node:fs / node:path：本文件位于 functions/api/ 下，Cloudflare Pages
// 打包 Functions 时会扫描同目录 .mjs，而 Workers 运行时没有这两个内置模块，静态 import
// 会让整包加载失败。仅本地 server.mjs 真正需要落盘时，按运行时能力惰性取用。
function nodeBuiltin(name) {
  try {
    return (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function')
      ? process.getBuiltinModule(name) : null;
  } catch (e) { return null; }
}

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
const SQL_USERS_LIST = 'SELECT id, username, display_name, created_at FROM users ORDER BY id';
const SQL_USERS_BY_ID = 'SELECT id FROM users WHERE id = ?';
const SQL_USERS_UPDATE_CRED = 'UPDATE users SET salt = ?, password_hash = ? WHERE id = ?';
const SQL_DATA_META = 'SELECT revision, updated_at FROM user_data WHERE user_id = ?';
const SQL_AVATAR_META = 'SELECT updated_at FROM avatars WHERE user_id = ?';
const SQL_USERS_DELETE = 'DELETE FROM users WHERE id = ?';
const SQL_DATA_DELETE = 'DELETE FROM user_data WHERE user_id = ?';
const SQL_AVATAR_DELETE = 'DELETE FROM avatars WHERE user_id = ?';
const SQL_DATA_FULL = 'SELECT payload, revision, updated_at FROM user_data WHERE user_id = ?';
// 片头片尾公共表（只读查询 + 本地测试播种用 INSERT；HTTP 层不暴露写入）
const SQL_SKIP_SELECT = 'SELECT title_key, title, season, episode, segment_type, start_sec, end_sec, votes, sources, origin, confidence FROM skip_marks_public WHERE title_key = ?';
const SQL_SKIP_INSERT = 'INSERT INTO skip_marks_public (title_key, title, season, episode, segment_type, start_sec, end_sec, votes, sources, origin, confidence, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const SQL_SKIP_CREATE = 'CREATE TABLE IF NOT EXISTS skip_marks_public';

export function createMiniD1(options = {}) {
  const file = options.file || null;
  const fs = nodeBuiltin('fs');
  const path = nodeBuiltin('path');

  // 内部数据结构：三张表，users 行含自增 id
  let data = { users: [], user_data: [], avatars: [], skip_marks_public: [] };

  // 启动时加载持久化文件；文件缺失/损坏均从空库开始（云端无 node:fs 时静默用内存库）
  if (file && fs && fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        data = {
          users: Array.isArray(parsed.users) ? parsed.users : [],
          user_data: Array.isArray(parsed.user_data) ? parsed.user_data : [],
          avatars: Array.isArray(parsed.avatars) ? parsed.avatars : [],
          skip_marks_public: Array.isArray(parsed.skip_marks_public) ? parsed.skip_marks_public : []
        };
      }
    } catch {
      // JSON 解析失败（文件损坏）：从空库开始，下次写入时覆盖
      data = { users: [], user_data: [], avatars: [], skip_marks_public: [] };
    }
  }

  // 每次数据变更后同步落盘；数据量小，writeFileSync 无性能问题
  function save() {
    if (!file || !fs) return;
    try {
      if (path) fs.mkdirSync(path.dirname(file), { recursive: true });
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
    // 用户名比较统一大小写不敏感：对齐 _lib.mjs 中 COLLATE NOCASE 查询
    // （handleMe 使用 JWT 中库内规范用户名，不受影响）
    if (normSql.startsWith(SQL_USERS_BY_NAME)) {
      const wanted = String(binds[0]).toLowerCase();
      const row = data.users.find(u => String(u.username).toLowerCase() === wanted) || null;
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
    // S9：管理端账号列表（不含盐与密码哈希），按 id 升序
    if (normSql.startsWith(SQL_USERS_LIST)) {
      const rows = data.users
        .slice()
        .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
        .map(u => ({ id: u.id, username: u.username, display_name: u.display_name, created_at: u.created_at }));
      return Promise.resolve({ results: rows });
    }
    // S10：按 id 查用户存在性，first 仅返回 id
    if (normSql.startsWith(SQL_USERS_BY_ID)) {
      const row = data.users.find(u => Number(u.id) === Number(binds[0])) || null;
      const picked = row ? { id: row.id } : null;
      if (kind === 'all') return Promise.resolve({ results: picked ? [picked] : [] });
      return Promise.resolve(picked);
    }
    // S11：管理端重置密码（更新盐与密码哈希）
    if (normSql.startsWith(SQL_USERS_UPDATE_CRED)) {
      const target = data.users.find(u => Number(u.id) === Number(binds[2]));
      let changes = 0;
      if (target) {
        target.salt = binds[0];
        target.password_hash = binds[1];
        changes = 1;
        save();
      }
      return Promise.resolve({ meta: { changes, last_row_id: null } });
    }
    // S12：查用户数据元信息（revision/updated_at，不取 payload）
    if (normSql.startsWith(SQL_DATA_META)) {
      const row = data.user_data.find(r => r.user_id === binds[0]) || null;
      const picked = row ? { revision: row.revision, updated_at: row.updated_at } : null;
      if (kind === 'all') return Promise.resolve({ results: picked ? [picked] : [] });
      return Promise.resolve(picked);
    }
    // S13：查头像元信息（仅 updated_at，不取 data）
    if (normSql.startsWith(SQL_AVATAR_META)) {
      const row = data.avatars.find(r => r.user_id === binds[0]) || null;
      const picked = row ? { updated_at: row.updated_at } : null;
      if (kind === 'all') return Promise.resolve({ results: picked ? [picked] : [] });
      return Promise.resolve(picked);
    }
    // S14：删除用户，changes 为实际删除条数
    if (normSql.startsWith(SQL_USERS_DELETE)) {
      const before = data.users.length;
      data.users = data.users.filter(u => Number(u.id) !== Number(binds[0]));
      const changes = before - data.users.length;
      if (changes) save();
      return Promise.resolve({ meta: { changes, last_row_id: null } });
    }
    // S15：删除用户数据
    if (normSql.startsWith(SQL_DATA_DELETE)) {
      const before = data.user_data.length;
      data.user_data = data.user_data.filter(r => r.user_id !== binds[0]);
      const changes = before - data.user_data.length;
      if (changes) save();
      return Promise.resolve({ meta: { changes, last_row_id: null } });
    }
    // S16：删除头像
    if (normSql.startsWith(SQL_AVATAR_DELETE)) {
      const before = data.avatars.length;
      data.avatars = data.avatars.filter(r => r.user_id !== binds[0]);
      const changes = before - data.avatars.length;
      if (changes) save();
      return Promise.resolve({ meta: { changes, last_row_id: null } });
    }
    // S17：查用户完整数据（payload/revision/updated_at）
    if (normSql.startsWith(SQL_DATA_FULL)) {
      const row = data.user_data.find(r => r.user_id === binds[0]) || null;
      const picked = row ? { payload: row.payload, revision: row.revision, updated_at: row.updated_at } : null;
      if (kind === 'all') return Promise.resolve({ results: picked ? [picked] : [] });
      return Promise.resolve(picked);
    }
    // S18：片头片尾公共表只读查询（按剧键）
    if (normSql.startsWith(SQL_SKIP_SELECT)) {
      const key = String(binds[0]);
      const rows = data.skip_marks_public.filter(r => String(r.title_key) === key);
      if (kind === 'all') return Promise.resolve({ results: rows });
      return Promise.resolve(rows[0] || null);
    }
    // S19：本地测试/运营播种写入（HTTP 层不暴露此语句）
    if (normSql.startsWith(SQL_SKIP_INSERT)) {
      data.skip_marks_public.push({
        title_key: binds[0],
        title: binds[1],
        season: binds[2],
        episode: binds[3],
        segment_type: binds[4],
        start_sec: binds[5],
        end_sec: binds[6],
        votes: binds[7],
        sources: binds[8],
        origin: binds[9],
        confidence: binds[10],
        updated_at: binds[11]
      });
      save();
      return Promise.resolve({ meta: { changes: 1, last_row_id: data.skip_marks_public.length } });
    }
    // S20：建表语句在本地 mock 中为 no-op（数据已在内存中）
    if (normSql.startsWith(SQL_SKIP_CREATE)) {
      return Promise.resolve({ meta: { changes: 0, last_row_id: null } });
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
