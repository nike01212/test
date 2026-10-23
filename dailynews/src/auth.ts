// 群組密碼登入：密碼對了就發一個簽過名的 cookie，之後每個請求只驗 cookie。
// 簽名用的金鑰由群組密碼推出來，所以改密碼 = 所有人自動登出。

export const SESSION_COOKIE = "dn_session";
export const SESSION_DAYS = 30;

// 同一個 IP 在 WINDOW 秒內輸錯 MAX_FAILURES 次，就暫時擋下
const MAX_FAILURES = 10;
const FAILURE_WINDOW_SECONDS = 15 * 60;

const encoder = new TextEncoder();

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(text));
}

function toBase64Url(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signingKey(groupPassword: string): Promise<CryptoKey> {
  const raw = await sha256(`dailynews-session-v1:${groupPassword}`);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function sign(groupPassword: string, payload: string): Promise<string> {
  const key = await signingKey(groupPassword);
  return toBase64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

// 先各自雜湊成固定長度再比對，避免從回應時間猜出密碼
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export function checkPassword(input: string, groupPassword: string): Promise<boolean> {
  return safeEqual(input, groupPassword);
}

export async function createSessionToken(groupPassword: string, now = Date.now()): Promise<string> {
  const exp = Math.floor(now / 1000) + SESSION_DAYS * 24 * 60 * 60;
  return `${exp}.${await sign(groupPassword, `v1.${exp}`)}`;
}

export async function isValidSession(token: string | undefined, groupPassword: string, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const [expText, sig] = token.split(".");
  const exp = Number(expText);
  if (!sig || !Number.isInteger(exp) || exp * 1000 < now) return false;
  return safeEqual(sig, await sign(groupPassword, `v1.${exp}`));
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "local";
}

// 資料庫出問題時不擋人（密碼本身還是要對），只記錄錯誤
export async function tooManyFailures(db: D1Database, ip: string, now = Date.now()): Promise<boolean> {
  try {
    const since = Math.floor(now / 1000) - FAILURE_WINDOW_SECONDS;
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ts >= ?")
      .bind(ip, since)
      .first<{ n: number }>();
    return (row?.n ?? 0) >= MAX_FAILURES;
  } catch (err) {
    console.error("login rate limit check failed", err);
    return false;
  }
}

export async function recordFailure(db: D1Database, ip: string, now = Date.now()): Promise<void> {
  const ts = Math.floor(now / 1000);
  try {
    await db.batch([
      db.prepare("INSERT INTO login_attempts (ip, ts) VALUES (?, ?)").bind(ip, ts),
      // 順手清掉一天前的舊紀錄，表格不會越長越大
      db.prepare("DELETE FROM login_attempts WHERE ts < ?").bind(ts - 24 * 60 * 60),
    ]);
  } catch (err) {
    console.error("record login failure failed", err);
  }
}

export async function clearFailures(db: D1Database, ip: string): Promise<void> {
  try {
    await db.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
  } catch (err) {
    console.error("clear login failures failed", err);
  }
}
