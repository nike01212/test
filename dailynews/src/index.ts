import {
  checkPassword,
  clearFailures,
  clearSessionCookie,
  clientIp,
  createSessionToken,
  isValidSession,
  readCookie,
  recordFailure,
  SESSION_COOKIE,
  sessionCookie,
  tooManyFailures,
} from "./auth";
import { handleApi, pruneOldBodies } from "./api";
import { scheduledClosing } from "./closing";
import { json } from "./http";

// 沒登入也能拿到的東西：登入頁本身和它需要的檔案
const PUBLIC_PATHS = new Set(["/login", "/login.js", "/style.css", "/favicon.svg", "/robots.txt", "/api/login"]);

// 要和 wrangler.jsonc 的 triggers 寫得一模一樣
const CLOSING_CRON = "30 6,8,10,12,14,23 * * *";

// 不擋爬取，搜尋引擎才看得到每個回應上的 noindex；真正不收錄靠的是 X-Robots-Tag
const ROBOTS_TXT = "User-agent: *\nDisallow:\n";

function withSiteHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  out.headers.set("Referrer-Policy", "no-referrer");
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("X-Frame-Options", "DENY");
  out.headers.set("Cache-Control", "private, no-cache");
  return out;
}

// 測試站把左上角的網站名稱（index.html 的 .brand）換成 SITE_BRAND，分頁標題前面加 SITE_TITLE_PREFIX
// （網頁之後換標題也會加：app.js 讀 <html> 的 data-title-prefix）；正式站兩個都沒設，原樣送出
function withBrand(res: Response, brand: string | undefined, titlePrefix: string | undefined): Response {
  if ((!brand && !titlePrefix) || !res.headers.get("Content-Type")?.startsWith("text/html")) return res;
  const rewriter = new HTMLRewriter();
  if (brand) {
    rewriter.on(".brand", {
      element(el) {
        el.setInnerContent(brand);
      },
    });
  }
  if (titlePrefix) {
    rewriter
      .on("html", {
        element(el) {
          el.setAttribute("data-title-prefix", titlePrefix);
        },
      })
      .on("title", {
        element(el) {
          el.prepend(titlePrefix);
        },
      });
  }
  return rewriter.transform(res);
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

async function handleLogin(request: Request, env: Env, secure: boolean): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!env.GROUP_PASSWORD) return json({ error: "網站還沒設定群組密碼，請聯絡發起人。" }, 503);

  const ip = clientIp(request);
  if (await tooManyFailures(env.DB, ip)) {
    return json({ error: "嘗試太多次了，請 15 分鐘後再試。" }, 429);
  }

  let password = "";
  try {
    const body = await request.json<{ password?: unknown }>();
    if (typeof body.password === "string") password = body.password;
  } catch {
    return json({ error: "格式錯誤" }, 400);
  }

  if (!(await checkPassword(password, env.GROUP_PASSWORD))) {
    await recordFailure(env.DB, ip);
    return json({ error: "密碼錯誤，請再試一次。" }, 401);
  }

  await clearFailures(env.DB, ip);
  const token = await createSessionToken(env.GROUP_PASSWORD);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, secure) });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const secure = url.protocol === "https:";

  if (path === "/robots.txt") {
    return new Response(ROBOTS_TXT, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (path === "/api/login") return handleLogin(request, env, secure);

  const loggedIn =
    !!env.GROUP_PASSWORD && (await isValidSession(readCookie(request, SESSION_COOKIE), env.GROUP_PASSWORD));

  if (!loggedIn && !PUBLIC_PATHS.has(path)) {
    if (path.startsWith("/api/")) return json({ error: "請先輸入群組密碼" }, 401);
    return redirect("/login");
  }
  if (loggedIn && path === "/login") return redirect("/");

  if (path === "/api/logout") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(secure) });
  }
  if (path.startsWith("/api/")) {
    try {
      return (await handleApi(request, env, url)) ?? json({ error: "not found" }, 404);
    } catch (err) {
      console.error("api error", path, err);
      return json({ error: "伺服器出了點問題，請稍後再試。" }, 500);
    }
  }

  return withBrand(await env.ASSETS.fetch(request), env.SITE_BRAND, env.SITE_TITLE_PREFIX);
}

export default {
  async fetch(request, env): Promise<Response> {
    return withSiteHeaders(await route(request, env));
  },
  // wrangler.jsonc 的 triggers 有兩個排程，依 cron 分開處理（時間都是 UTC）
  async scheduled(controller, env, ctx): Promise<void> {
    if (controller.cron === CLOSING_CRON) {
      // 台北 14:30、16:30、18:30、20:30、22:30、隔天 07:30：先存前一個交易日的上櫃收盤快照（存過就跳過），
      // 再比對新貼的個股在前一個交易日收盤有沒有漲停（比對過的不再抓）
      ctx.waitUntil(scheduledClosing(env, controller.scheduledTime).then(console.log));
      return;
    }
    // 每天台北時間 03:00 清掉太舊的圖片全文
    ctx.waitUntil(
      pruneOldBodies(env).then(({ before, cleared }) => console.log(`圖片全文：清掉 ${before} 以前的 ${cleared} 則`)),
    );
  },
} satisfies ExportedHandler<Env>;
