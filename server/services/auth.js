const crypto = require('node:crypto');
const { transaction } = require('../db');
const { record } = require('./audit');

const ROLES = ['admin', 'importer', 'reviewer', 'cards_manager'];
const SESSION_HOURS = 8;
const MIN_PASSWORD_LENGTH = 10;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return crypto.timingSafeEqual(actual, expected);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`كلمة المرور يجب ألا تقل عن ${MIN_PASSWORD_LENGTH} أحرف`);
  }
}

// Creates a user. The acting user (if any) is recorded in the audit log.
function createUser(db, actor, { username, fullName, password, role }) {
  if (!ROLES.includes(role)) throw new Error('الدور غير صالح');
  validatePassword(password);
  return transaction(db, () => {
    const info = db.prepare(
      'INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run(username, fullName, hashPassword(password), role);
    const user = { id: Number(info.lastInsertRowid), username, full_name: fullName, role, is_active: 1 };
    record(db, { userId: actor ? actor.id : null, action: 'user.create', entity: 'user', entityId: user.id, after: user });
    return user;
  });
}

// Returns a session token on success, or null. Never reveals whether the username exists.
function login(db, username, password) {
  const row = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  const ok = row && row.is_active === 1 && verifyPassword(password, row.password_hash);
  if (!ok) {
    record(db, { userId: row ? row.id : null, action: 'auth.login_failed', entity: 'user', entityId: username });
    return null;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), row.id, expires);
  record(db, { userId: row.id, action: 'auth.login', entity: 'user', entityId: row.id });
  return token;
}

// Changes the user's own password after checking the current one.
// Other sessions of this user are ended; the current session stays signed in.
function changePassword(db, user, currentPassword, newPassword, keepToken) {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  if (!row || !verifyPassword(String(currentPassword ?? ''), row.password_hash)) {
    throw new Error('كلمة المرور الحالية غير صحيحة');
  }
  validatePassword(newPassword);
  if (newPassword === currentPassword) throw new Error('كلمة المرور الجديدة يجب أن تختلف عن الحالية');
  transaction(db, () => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(user.id, hashToken(keepToken || ''));
  });
}

function currentUser(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.full_name, u.role, u.is_active
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(hashToken(token), new Date().toISOString());
  return row && row.is_active === 1 ? row : null;
}

function logout(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

function requireRole(user, ...allowed) {
  if (!user || !allowed.includes(user.role)) {
    const err = new Error('ليست لديك صلاحية لتنفيذ هذا الإجراء');
    err.status = 403;
    throw err;
  }
  return user;
}

module.exports = {
  ROLES, hashPassword, verifyPassword, createUser, login, logout, currentUser, requireRole, validatePassword, changePassword,
};
