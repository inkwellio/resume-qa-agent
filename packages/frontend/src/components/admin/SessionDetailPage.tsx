import { Alert, App, Button, Input } from "antd";
import { AdminHttpError, adminErrorText, adminFetch, formatIp, formatTime, recordedIp, shortId, useAdminQuery, type AdminSessionDetail } from "./client";

async function postBan(ip: string, onUnauthorized: () => void): Promise<void> {
  try {
    await adminFetch("/api/admin/ips/ban", { method: "POST", body: JSON.stringify({ ip }) });
  } catch (reason) {
    if (reason instanceof AdminHttpError && reason.status === 401) onUnauthorized();
    throw reason;
  }
}

export function SessionDetailPage(props: {
  refreshKey: number;
  sessionId: string;
  onUnauthorized: () => void;
  onBack: (userId: string | null, email: string | null) => void;
}) {
  const { modal, message: toast } = App.useApp();
  const detail = useAdminQuery<AdminSessionDetail>(
    `/api/admin/sessions/${props.sessionId}`,
    props.refreshKey,
    props.onUnauthorized,
  );
  const session = detail.data;

  function banVisitor() {
    if (!session) return;
    const recorded = recordedIp(session.ip);
    let draft = recorded;
    modal.confirm({
      title: "禁用该访客 IP",
      content: (
        <div className="admin-ip-form">
          <p className="admin-note">
            {recorded
              ? "已填入这轮会话记下的地址，可以直接禁止，也可以改成别的地址。"
              : "这份会话没有记录明文 IP。请填入从访问日志确认的地址。"}
          </p>
          <Input defaultValue={recorded} placeholder="IPv4 或 IPv6" spellCheck={false} autoComplete="off" onChange={(event) => { draft = event.target.value; }} />
        </div>
      ),
      okText: "永久禁止",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: async () => {
        const target = draft.trim();
        if (!target) {
          toast.warning("缺少明文 IP，需已知地址才能操作。");
          throw new Error("缺少明文 IP");
        }
        try {
          await postBan(target, props.onUnauthorized);
          toast.success("已永久禁止该 IP。");
        } catch (reason) {
          if (!(reason instanceof AdminHttpError && reason.status === 401)) toast.error(adminErrorText(reason));
          throw reason;
        }
      },
    });
  }

  return (
    <div className="admin-page admin-detail">
      <Button type="link" className="admin-back" onClick={() => props.onBack(session?.userId ?? null, session?.email ?? null)}>返回会话列表</Button>
      {detail.error ? <Alert type="error" showIcon message={detail.error} /> : null}
      {detail.loading && !session ? <p className="admin-status">正在读取…</p> : null}
      {session ? (
        <section className="admin-card">
          <div className="admin-detail-head">
            <div className="admin-card-head">
              <h1>{session.title || "未命名会话"}</h1>
              <p>
                {session.email || "未绑定邮箱"}
                {" · "}
                IP {formatIp(session.ip)}
                {" · "}
                更新于 {formatTime(session.updatedAt)}
                {" · "}
                <span className="admin-mono" title={session.id}>{shortId(session.id)}</span>
              </p>
            </div>
            <Button danger onClick={banVisitor}>禁用该访客 IP</Button>
          </div>
          <p className="admin-note">只展示可见问答。思考标签已去掉，工具原文不在这里。</p>
          {session.turns.length === 0 ? <p className="admin-empty">这轮对话没有可见问答。</p> : session.turns.map((turn, index) => (
            <article className="admin-turn" key={`${session.id}-${index}`}>
              <div className="admin-q">
                <div className="admin-kicker">问题</div>
                <p>{turn.question || "（没有问题文本）"}</p>
              </div>
              <div className="admin-a">
                <div className="admin-kicker">回答</div>
                <p>{turn.answer || "（模型没有留下可见回答）"}</p>
              </div>
            </article>
          ))}
        </section>
      ) : null}
    </div>
  );
}
