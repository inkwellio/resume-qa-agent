import { Alert, Button } from "antd";
import { useState } from "react";
import { PAGE, formatIp, formatTime, shortId, useAdminQuery, type SessionsBody } from "./client";
import { Pager } from "./Pager";

export function SessionsPage(props: {
  refreshKey: number;
  userId: string | null;
  email: string | null;
  userIdInvalid: boolean;
  onUnauthorized: () => void;
  onOpenSession: (id: string) => void;
  onClearFilter: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const path = props.userIdInvalid
    ? null
    : `/api/admin/sessions?${new URLSearchParams({
      limit: String(PAGE),
      offset: String(offset),
      ...(props.userId ? { userId: props.userId } : {}),
    })}`;
  const sessions = useAdminQuery<SessionsBody>(path, props.refreshKey, props.onUnauthorized);
  const rows = sessions.data?.sessions ?? [];

  return (
    <div className="admin-page">
      <header className="admin-page-head">
        <div>
          <h1>会话列表</h1>
          <p>只列出有消息的会话。点进去看问题和助手可见回答，不含工具原文。</p>
        </div>
      </header>
      {props.userIdInvalid ? <Alert type="error" showIcon message="用户编号格式不正确，无法筛选会话。" /> : null}
      {props.userId ? (
        <div className="admin-filter">
          <span>正在查看 {props.email || shortId(props.userId)} 的会话</span>
          <Button type="link" onClick={props.onClearFilter}>查看全部</Button>
        </div>
      ) : null}
      {sessions.error ? <Alert type="error" showIcon message={sessions.error} /> : null}
      <section className="admin-card">
        <div className="admin-card-head">
          <h2>会话</h2>
          {sessions.data ? <p>共 {sessions.data.total} 条</p> : null}
        </div>
        {sessions.loading && !sessions.data ? <p className="admin-status">正在读取…</p> : null}
        {!props.userIdInvalid && !sessions.loading && !sessions.error && rows.length === 0 ? <p className="admin-empty">没有会话。</p> : null}
        {rows.length > 0 ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>标题</th>
                  <th>邮箱</th>
                  <th>访客</th>
                  <th>IP</th>
                  <th>创建时间</th>
                  <th>更新时间</th>
                  <th className="admin-row-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((session) => (
                  <tr key={session.id}>
                    <td>{session.title || "未命名会话"}</td>
                    <td>{session.email || "未绑定邮箱"}</td>
                    <td className="admin-mono" title={session.visitorId}>{shortId(session.visitorId)}</td>
                    <td className="admin-mono">{formatIp(session.ip)}</td>
                    <td>{formatTime(session.createdAt)}</td>
                    <td>{formatTime(session.updatedAt)}</td>
                    <td className="admin-row-actions">
                      <Button type="link" onClick={() => props.onOpenSession(session.id)}>问答详情</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <Pager offset={offset} total={sessions.data?.total ?? 0} onChange={setOffset} />
      </section>
    </div>
  );
}
