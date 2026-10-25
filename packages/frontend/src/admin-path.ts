/** 站长页不进入访客侧栏。/admin 与其子路径都算后台。 */
export function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AdminRoute =
  | { page: "login" }
  | { page: "setup" }
  | { page: "users" }
  | { page: "sessions"; userId: string | null; email: string | null; userIdInvalid: boolean }
  | { page: "session"; id: string }
  | { page: "ips" }
  | { page: "feedback" }
  | { page: "usage" }
  | { page: "missing" };

function stripSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function readEmail(params: URLSearchParams): string | null {
  const email = params.get("email")?.trim() ?? "";
  if (!email || email.length > 254) return null;
  for (const char of email) {
    if (char.charCodeAt(0) < 32) return null;
  }
  return email;
}

/** 把地址解析成后台页面。会话过滤只接受合法用户编号。 */
export function parseAdminRoute(pathname: string, search = ""): AdminRoute {
  const path = stripSlash(pathname);
  if (path === "/admin/login") return { page: "login" };
  if (path === "/admin/setup") return { page: "setup" };
  if (path === "/admin") return { page: "users" };
  if (path === "/admin/ips") return { page: "ips" };
  if (path === "/admin/feedback") return { page: "feedback" };
  if (path === "/admin/usage") return { page: "usage" };
  if (path === "/admin/sessions") {
    const params = new URLSearchParams(search);
    const rawUserId = params.get("userId")?.trim() ?? "";
    if (!rawUserId) return { page: "sessions", userId: null, email: readEmail(params), userIdInvalid: false };
    if (!UUID.test(rawUserId)) return { page: "sessions", userId: null, email: null, userIdInvalid: true };
    return { page: "sessions", userId: rawUserId, email: readEmail(params), userIdInvalid: false };
  }
  const session = /^\/admin\/sessions\/([^/]+)$/.exec(path);
  if (session?.[1]) {
    let id = session[1];
    try { id = decodeURIComponent(id); } catch { return { page: "missing" }; }
    return UUID.test(id) ? { page: "session", id } : { page: "missing" };
  }
  return { page: "missing" };
}
