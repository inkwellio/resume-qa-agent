import { Alert } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseAdminRoute, type AdminRoute } from "../admin-path";
import { AdminLogin, AdminSetup } from "./admin/AdminLogin";
import { AdminShell } from "./admin/AdminShell";
import { IpsPage } from "./admin/IpsPage";
import { PlaceholderPage } from "./admin/PlaceholderPage";
import { SessionDetailPage } from "./admin/SessionDetailPage";
import { SessionsPage } from "./admin/SessionsPage";
import { UsersPage } from "./admin/UsersPage";
import { adminFetch } from "./admin/client";

type Gate = { status: "loading" } | { status: "anon"; needsSetup: boolean } | { status: "in" };

function useAdminLocation() {
  const [loc, setLoc] = useState(() => ({
    pathname: window.location.pathname,
    search: window.location.search,
  }));
  useEffect(() => {
    const sync = () => setLoc({ pathname: window.location.pathname, search: window.location.search });
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const navigate = useCallback((to: string, mode: "push" | "replace" = "push") => {
    const url = new URL(to, window.location.origin);
    const next = url.pathname + url.search;
    if (next !== window.location.pathname + window.location.search) {
      if (mode === "replace") window.history.replaceState(null, "", next);
      else window.history.pushState(null, "", next);
    }
    setLoc({ pathname: url.pathname, search: url.search });
  }, []);
  return { pathname: loc.pathname, search: loc.search, navigate };
}

function isAppPage(route: AdminRoute): boolean {
  return route.page !== "login" && route.page !== "setup" && route.page !== "missing";
}

export function AdminPage() {
  const { pathname, search, navigate } = useAdminLocation();
  const route = parseAdminRoute(pathname, search);
  const [gate, setGate] = useState<Gate>({ status: "loading" });
  const [refreshKey, setRefreshKey] = useState(0);
  const [navOpen, setNavOpen] = useState(false);
  const pendingRef = useRef<string | null>(null);
  const locationRef = useRef({ pathname, search });
  locationRef.current = { pathname, search };

  useEffect(() => {
    const controller = new AbortController();
    void adminFetch<{ authenticated: boolean; needsSetup: boolean }>("/api/admin/session", { signal: controller.signal })
      .then((body) => {
        if (controller.signal.aborted) return;
        setGate(body.authenticated ? { status: "in" } : { status: "anon", needsSetup: body.needsSetup });
      })
      .catch(() => {
        if (!controller.signal.aborted) setGate({ status: "anon", needsSetup: false });
      });
    return () => controller.abort();
  }, []);

  const onUnauthorized = useCallback(() => {
    const here = locationRef.current.pathname + locationRef.current.search;
    if (isAppPage(parseAdminRoute(locationRef.current.pathname, locationRef.current.search))) pendingRef.current = here;
    setGate({ status: "anon", needsSetup: false });
  }, []);

  useEffect(() => {
    if (gate.status === "loading") return;
    const here = pathname + search;
    if (gate.status === "in") {
      if (route.page === "login" || route.page === "setup") {
        const next = pendingRef.current && pendingRef.current !== "/admin/login" && pendingRef.current !== "/admin/setup"
          ? pendingRef.current
          : "/admin";
        pendingRef.current = null;
        navigate(next, "replace");
      }
      return;
    }
    const target = gate.needsSetup ? "/admin/setup" : "/admin/login";
    if ((gate.needsSetup && route.page === "setup") || (!gate.needsSetup && route.page === "login")) return;
    if (isAppPage(route)) pendingRef.current = here;
    navigate(target, "replace");
  }, [gate, route, pathname, search, navigate]);

  function enter() {
    setGate({ status: "in" });
  }

  async function logout() {
    pendingRef.current = null;
    try { await adminFetch("/api/admin/logout", { method: "POST" }); } catch { /* 会话清不掉也先离开后台。 */ }
    setGate({ status: "anon", needsSetup: false });
    navigate("/admin/login");
  }

  if (gate.status === "loading") {
    return <div className="admin-auth"><p className="admin-status admin-auth-wait">正在确认登录状态…</p></div>;
  }
  if (gate.status === "anon") {
    if (gate.needsSetup) return route.page === "setup" ? <AdminSetup onSuccess={enter} /> : null;
    return route.page === "login" ? <AdminLogin onSuccess={enter} /> : null;
  }
  if (route.page === "login" || route.page === "setup") return null;

  return (
    <AdminShell
      route={route}
      navOpen={navOpen}
      onNavigate={navigate}
      onToggleNav={() => setNavOpen((open) => !open)}
      onCloseNav={() => setNavOpen(false)}
      onRefresh={() => setRefreshKey((value) => value + 1)}
      onLogout={() => void logout()}
    >
      <AdminBody
        route={route}
        refreshKey={refreshKey}
        onUnauthorized={onUnauthorized}
        onNavigate={navigate}
      />
    </AdminShell>
  );
}

function AdminBody(props: {
  route: AdminRoute;
  refreshKey: number;
  onUnauthorized: () => void;
  onNavigate: (to: string) => void;
}) {
  const { route } = props;
  if (route.page === "users") {
    return (
      <UsersPage
        refreshKey={props.refreshKey}
        onUnauthorized={props.onUnauthorized}
        onOpenSessions={(userId, email) => {
          const query = new URLSearchParams({ userId, email });
          props.onNavigate(`/admin/sessions?${query}`);
        }}
      />
    );
  }
  if (route.page === "sessions") {
    return (
      <SessionsPage
        key={`${route.userId ?? ""}:${route.userIdInvalid}`}
        refreshKey={props.refreshKey}
        userId={route.userId}
        email={route.email}
        userIdInvalid={route.userIdInvalid}
        onUnauthorized={props.onUnauthorized}
        onOpenSession={(id) => props.onNavigate(`/admin/sessions/${id}`)}
        onClearFilter={() => props.onNavigate("/admin/sessions")}
      />
    );
  }
  if (route.page === "session") {
    return (
      <SessionDetailPage
        key={route.id}
        refreshKey={props.refreshKey}
        sessionId={route.id}
        onUnauthorized={props.onUnauthorized}
        onBack={(userId, email) => {
          if (!userId) {
            props.onNavigate("/admin/sessions");
            return;
          }
          const query = new URLSearchParams({ userId });
          if (email) query.set("email", email);
          props.onNavigate(`/admin/sessions?${query}`);
        }}
      />
    );
  }
  if (route.page === "ips") {
    return <IpsPage refreshKey={props.refreshKey} onUnauthorized={props.onUnauthorized} />;
  }
  if (route.page === "feedback") {
    return <PlaceholderPage title="反馈" note="访客反馈还没有站长接口。v1.1 再接上，当前不读取、也不提交任何数据。" />;
  }
  if (route.page === "usage") {
    return <PlaceholderPage title="请求用量" note="按日请求次数还没有站长接口。v1.1 再接上。这里不展示金额或 Token 费用。" />;
  }
  return (
    <div className="admin-page">
      <Alert type="warning" showIcon message="没有这个页面。" />
    </div>
  );
}
