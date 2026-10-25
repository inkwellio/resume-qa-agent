import { Alert, Button } from "antd";
import { useState } from "react";
import { PAGE, emailInitials, formatTime, shortId, useAdminQuery, type SessionsBody, type UsersBody } from "./client";
import { Pager } from "./Pager";

export function UsersPage(props: {
  refreshKey: number;
  onUnauthorized: () => void;
  onOpenSessions: (userId: string, email: string) => void;
}) {
  const [offset, setOffset] = useState(0);
  const users = useAdminQuery<UsersBody>(`/api/admin/users?limit=${PAGE}&offset=${offset}`, props.refreshKey, props.onUnauthorized);
  const sessions = useAdminQuery<SessionsBody>("/api/admin/sessions?limit=1&offset=0", props.refreshKey, props.onUnauthorized);
  const rows = users.data?.users ?? [];

  return (
    <div className="admin-page">
      <header className="admin-page-head">
        <div>
          <h1>登录用户</h1>
          <p>查看已用邮箱验证的账号、会话数和最近会话时间。</p>
        </div>
      </header>
      {users.error ? <Alert type="error" showIcon message={users.error} /> : null}
      <div className="admin-metrics">
        <article className="admin-metric">
          <span>登录用户</span>
          <strong>{users.data ? users.data.total : "—"}</strong>
          <small>邮箱已验证</small>
        </article>
        <article className="admin-metric">
          <span>会话</span>
          <strong>{sessions.error ? "—" : sessions.data ? sessions.data.total : "—"}</strong>
          <small>有消息的会话</small>
        </article>
      </div>
      <section className="admin-card">
        <div className="admin-card-head">
          <h2>已登录用户</h2>
          <p>点「查看会话」进入该用户的会话列表。</p>
        </div>
        {users.loading && !users.data ? <p className="admin-status">正在读取…</p> : null}
        {!users.loading && !users.error && rows.length === 0 ? <p className="admin-empty">还没有人通过邮箱登录。</p> : null}
        {rows.length > 0 ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>邮箱</th>
                  <th>用户</th>
                  <th>访客</th>
                  <th>会话</th>
                  <th>注册时间</th>
                  <th>最近会话</th>
                  <th className="admin-row-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((user) => (
                  <tr key={user.userId}>
                    <td>
                      <span className="admin-person">
                        <span className="admin-avatar" aria-hidden>{emailInitials(user.email)}</span>
                        <span>{user.email}</span>
                      </span>
                    </td>
                    <td className="admin-mono" title={user.userId}>{shortId(user.userId)}</td>
                    <td>{user.visitorCount}</td>
                    <td>{user.sessionCount}</td>
                    <td>{formatTime(user.createdAt)}</td>
                    <td>{formatTime(user.lastSessionAt)}</td>
                    <td className="admin-row-actions">
                      <Button type="link" onClick={() => props.onOpenSessions(user.userId, user.email)}>查看会话</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <Pager offset={offset} total={users.data?.total ?? 0} onChange={setOffset} />
      </section>
    </div>
  );
}
