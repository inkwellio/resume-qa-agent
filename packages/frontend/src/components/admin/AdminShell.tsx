import {
  BarChartOutlined,
  CommentOutlined,
  DashboardOutlined,
  GlobalOutlined,
  MenuOutlined,
  MessageOutlined,
} from "@ant-design/icons";
import { Button } from "antd";
import { useEffect, type MouseEvent, type ReactNode } from "react";
import type { AdminRoute } from "../../admin-path";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  soon?: boolean;
  active: boolean;
}

function navItems(route: AdminRoute): NavItem[] {
  return [
    { href: "/admin", label: "概览", icon: <DashboardOutlined />, active: route.page === "users" },
    { href: "/admin/sessions", label: "会话", icon: <CommentOutlined />, active: route.page === "sessions" || route.page === "session" },
    { href: "/admin/ips", label: "IP 管控", icon: <GlobalOutlined />, active: route.page === "ips" },
    { href: "/admin/feedback", label: "反馈", icon: <MessageOutlined />, soon: true, active: route.page === "feedback" },
    { href: "/admin/usage", label: "请求用量", icon: <BarChartOutlined />, soon: true, active: route.page === "usage" },
  ];
}

function crumb(route: AdminRoute): string {
  switch (route.page) {
    case "users": return "登录用户";
    case "sessions": return "会话列表";
    case "session": return "问答详情";
    case "ips": return "IP 管控";
    case "feedback": return "反馈";
    case "usage": return "请求用量";
    default: return "未找到页面";
  }
}

export function AdminShell(props: {
  route: AdminRoute;
  navOpen: boolean;
  onNavigate: (to: string) => void;
  onToggleNav: () => void;
  onCloseNav: () => void;
  onRefresh: () => void;
  onLogout: () => void;
  children: ReactNode;
}) {
  const title = crumb(props.route);
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · 站长后台`;
    return () => { document.title = previous; };
  }, [title]);

  function go(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    props.onNavigate(href);
    props.onCloseNav();
  }

  return (
    <div className="admin-frame">
      {props.navOpen ? <button type="button" className="admin-scrim" aria-label="关闭导航" onClick={props.onCloseNav} /> : null}
      <aside className={props.navOpen ? "admin-sider is-open" : "admin-sider"}>
        <div className="admin-brand">
          <span className="admin-brand-mark" aria-hidden>问</span>
          <span>
            <strong>简历问答 Admin</strong>
            <small>站长后台</small>
          </span>
        </div>
        <div className="admin-nav-label">导航</div>
        <nav className="admin-nav" aria-label="后台导航">
          {navItems(props.route).map((item) => (
            <a key={item.href} href={item.href} className={item.active ? "is-active" : ""} onClick={(event) => go(event, item.href)}>
              {item.icon}
              <span>{item.label}</span>
              {item.soon ? <span className="admin-soon">v1.1</span> : null}
            </a>
          ))}
        </nav>
        <a className="admin-sider-back" href="/">返回简历页</a>
      </aside>
      <div className="admin-main">
        <header className="admin-topbar">
          <div className="admin-topbar-title">
            <Button className="admin-nav-toggle" aria-label="打开导航" icon={<MenuOutlined />} onClick={props.onToggleNav} />
            <nav className="admin-crumbs" aria-label="当前位置">
              <a href="/admin" onClick={(event) => go(event, "/admin")}>站长后台</a>
              {props.route.page === "session" ? (
                <>
                  <span aria-hidden>/</span>
                  <a href="/admin/sessions" onClick={(event) => go(event, "/admin/sessions")}>会话列表</a>
                </>
              ) : null}
              <span aria-hidden>/</span>
              <span>{title}</span>
            </nav>
          </div>
          <div className="admin-topbar-actions">
            <Button onClick={props.onRefresh}>刷新</Button>
            <Button type="text" onClick={props.onLogout}>退出登录</Button>
          </div>
        </header>
        <div className="admin-content">{props.children}</div>
      </div>
    </div>
  );
}
