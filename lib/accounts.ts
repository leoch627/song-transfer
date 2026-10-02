import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { AppError } from "./http";
import { taskStore, type TaskStore, DAY } from "./task-store";

const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
export type User = { id: string; username: string };
export function normalizeUsername(value: unknown) {
  if (typeof value !== "string") throw new AppError("请输入用户名。");
  const name = value.trim().normalize("NFC").toLowerCase();
  if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(name))
    throw new AppError("用户名需为 3～32 个文字、数字、下划线或短横线。");
  return name;
}
export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 8 || value.length > 128)
    throw new AppError("密码需为 8～128 个字符。");
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt);
  return `scrypt$${salt}$${key.toString("hex")}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [algorithm, salt, encoded] = hash.split("$");
  if (
    algorithm !== "scrypt" ||
    !/^[a-f0-9]{32}$/.test(salt) ||
    !/^[a-f0-9]{128}$/.test(encoded)
  )
    return false;
  const key = await derive(password, salt);
  return timingSafeEqual(key, Buffer.from(encoded, "hex"));
}
export const sessionHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function rateLimitAccount(
  scope: string,
  limit: number,
  windowMs: number,
  store: TaskStore = taskStore(),
) {
  store.transaction(() => {
    store.db
      .prepare("DELETE FROM auth_attempts WHERE at<=?")
      .run(store.now() - DAY);
    const row = store.db
      .prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE scope=? AND at>?")
      .get(scope, store.now() - windowMs) as { n: number };
    if (row.n >= limit)
      throw new AppError(
        "尝试次数过多，请稍后再试。",
        429,
        Math.ceil(windowMs / 1000),
      );
    store.db
      .prepare("INSERT INTO auth_attempts VALUES(?,?)")
      .run(scope, store.now());
  });
}
export async function registerAccount(
  username: unknown,
  password: unknown,
  store: TaskStore = taskStore(),
): Promise<User> {
  const name = normalizeUsername(username);
  validatePassword(password);
  const hash = await hashPassword(password),
    id = randomUUID();
  try {
    store.db
      .prepare("INSERT INTO users VALUES(?,?,?,?)")
      .run(id, name, hash, store.now());
  } catch (error) {
    if (store.db.prepare("SELECT id FROM users WHERE username=?").get(name))
      throw new AppError("这个用户名已被使用。", 409);
    throw error;
  }
  return { id, username: name };
}
export async function loginAccount(
  username: unknown,
  password: unknown,
  store: TaskStore = taskStore(),
): Promise<User> {
  const name = normalizeUsername(username);
  validatePassword(password);
  const row = store.db
    .prepare("SELECT id,username,password_hash FROM users WHERE username=?")
    .get(name) as (User & { password_hash: string }) | undefined;
  const hash =
    row?.password_hash || `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;
  if (!(await verifyPassword(password, hash)) || !row)
    throw new AppError("用户名或密码不正确。", 401);
  return { id: row.id, username: row.username };
}
export function newWebSession(user: User, store: TaskStore = taskStore()) {
  const token = randomBytes(32).toString("base64url");
  store.db
    .prepare("DELETE FROM web_sessions WHERE expires_at<=?")
    .run(store.now());
  store.db
    .prepare("INSERT INTO web_sessions VALUES(?,?,?)")
    .run(sessionHash(token), user.id, store.now() + 30 * DAY);
  return token;
}
export function sessionUser(
  token: string | undefined,
  store: TaskStore = taskStore(),
): User | null {
  if (!token || token.length > 100) return null;
  return (
    (store.db
      .prepare(
        "SELECT users.id,users.username FROM users JOIN web_sessions ON users.id=web_sessions.user_id WHERE token_hash=? AND expires_at>?",
      )
      .get(sessionHash(token), store.now()) as User | undefined) || null
  );
}
