import { Alert, App, Button, Input, Tooltip } from "antd";
import { useState } from "react";
import {
  AdminHttpError,
  adminErrorText,
  adminFetch,
  formatTime,
  useAdminQuery,
  type IpWindow,
  type IpsBody,
} from "./client";

function windowText(window: IpWindow | null): string {
  if (!window) return "没有聊天时段";
  const when = formatTime(window.expiresAt);
  return window.exhausted ? `已到期 · ${when}` : `进行中 · ${when} 到期`;
}

function IpActions(props: {
  ip: string | null;
  showBan: boolean;
  onAct: (action: "ban" | "unban", ip: string) => void;
}) {
  const known = Boolean(props.ip);
  const actions = (
    <span className="admin-row-actions-inner">
      {props.showBan ? (
        <Button danger size="small" disabled={!known} onClick={() => { if (props.ip) props.onAct("ban", props.ip); }}>永久禁止</Button>
      ) : null}
      <Button size="small" disabled={!known} onClick={() => { if (props.ip) props.onAct("unban", props.ip); }}>解除禁止</Button>
      {!known ? <span className="admin-row-hint">需已知地址</span> : null}
    </span>
  );
  if (known) return actions;
  return <Tooltip title="只有摘要，需已知明文地址才能操作">{actions}</Tooltip>;
}

export function IpsPage(props: {
  refreshKey: number;
  onUnauthorized: () => void;
}) {
  const { modal, message: toast } = App.useApp();
  const [tick, setTick] = useState(0);
  const [manualOpen, setManualOpen] = useState(false);
  const [ipInput, setIpInput] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const ips = useAdminQuery<IpsBody>("/api/admin/ips", props.refreshKey + tick, props.onUnauthorized);
  const bans = ips.data?.bans ?? [];
  const windows = ips.data?.windows ?? [];

  function confirmIp(action: "ban" | "unban", ip: string, note = "") {
    const target = ip.trim();
    if (!target) {
      toast.warning("缺少明文 IP，需已知地址才能操作。");
      return;
    }
    const ban = action === "ban";
    const remark = note.trim();
    modal.confirm({
      title: ban ? `永久禁止 ${target}？` : `解除 ${target} 的访问限制？`,
      content: ban
        ? "禁止后，该地址将无法访问聊天、登录、档案和历史接口。探活和本后台不受影响。"
        : "会移出永久黑名单，并清除该 IP 的 15 分钟聊天时段。下次成功提问重新计时，每日额度不变。",
      okText: ban ? "永久禁止" : "解除禁止",
      cancelText: "取消",
      okButtonProps: ban ? { danger: true } : undefined,
      onOk: async () => {
        try {
          const body = JSON.stringify(ban ? { ip: target, ...(remark ? { note: remark } : {}) } : { ip: target });
          await adminFetch(`/api/admin/ips/${action}`, { method: "POST", body });
          toast.success(ban ? "已永久禁止该 IP。" : "已解除禁止。该 IP 可以再次访问，聊天时段会重新计算。");
          setTick((value) => value + 1);
        } catch (reason) {
          if (reason instanceof AdminHttpError && reason.status === 401) {
            props.onUnauthorized();
            return;
          }
          toast.error(adminErrorText(reason));
          throw reason;
        }
      },
    });
  }

  return (
    <div className="admin-page">
      <header className="admin-page-head">
        <div>
          <h1>IP 管控</h1>
          <p>在每一行末尾操作。永久禁止后，该地址不能再访问聊天、登录和档案。解除禁止会移出黑名单，并清掉 15 分钟聊天时段。</p>
        </div>
        <Button onClick={() => setManualOpen((open) => !open)}>手动输入未知 IP</Button>
      </header>
      {ips.error ? <Alert type="error" showIcon message={ips.error} /> : null}
      <div className="admin-metrics">
        <article className="admin-metric">
          <span>黑名单</span>
          <strong>{ips.data ? bans.length : "—"}</strong>
          <small>最多列出 200 条</small>
        </article>
        <article className="admin-metric">
          <span>聊天时段</span>
          <strong>{ips.data ? windows.length : "—"}</strong>
          <small>最多列出 200 条</small>
        </article>
      </div>
      {manualOpen ? (
        <section className="admin-card">
          <div className="admin-card-head">
            <h2>手动输入未知 IP</h2>
            <p>列表里没有明文时，用访问日志里确认的地址。备注可选。</p>
          </div>
          <div className="admin-ip-form">
            <Input value={ipInput} placeholder="IPv4 或 IPv6" spellCheck={false} autoComplete="off" onChange={(event) => setIpInput(event.target.value)} />
            <Input value={noteInput} placeholder="备注，可选，最多 200 字" maxLength={200} onChange={(event) => setNoteInput(event.target.value)} />
            <div className="admin-actions">
              <Button danger onClick={() => confirmIp("ban", ipInput, noteInput)}>永久禁止</Button>
              <Button onClick={() => confirmIp("unban", ipInput)}>解除禁止</Button>
            </div>
          </div>
        </section>
      ) : null}
      <section className="admin-card">
        <div className="admin-card-head">
          <h2>永久黑名单</h2>
          <p>每行末尾可解除禁止。明文只来自站长输入的地址。</p>
        </div>
        {ips.loading && !ips.data ? <p className="admin-status">正在读取…</p> : null}
        {!ips.loading && !ips.error && bans.length === 0 ? <p className="admin-empty">黑名单是空的。</p> : null}
        {bans.length > 0 ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>IP 地址</th>
                  <th>备注</th>
                  <th>封禁时间</th>
                  <th>聊天时段</th>
                  <th className="admin-row-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {bans.map((ban) => (
                  <tr key={ban.ip}>
                    <td className="admin-mono">{ban.ip}</td>
                    <td>{ban.note || "—"}</td>
                    <td>{formatTime(ban.createdAt)}</td>
                    <td>{windowText(ban.window)}</td>
                    <td className="admin-row-actions"><IpActions ip={ban.ip} showBan={false} onAct={confirmIp} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      <section className="admin-card">
        <div className="admin-card-head">
          <h2>聊天时段</h2>
          <p>有明文的行可以直接禁止或解除。只有摘要的行需已知地址，按钮不可用。</p>
        </div>
        {!ips.loading && !ips.error && windows.length === 0 ? <p className="admin-empty">还没有聊天时段记录。</p> : null}
        {windows.length > 0 ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>地址</th>
                  <th>状态</th>
                  <th>开始</th>
                  <th>黑名单</th>
                  <th className="admin-row-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {windows.map((window) => (
                  <tr key={window.ipHash}>
                    <td className="admin-mono" title={window.ip ?? window.ipHash}>{window.ip || `${window.ipHash.slice(0, 12)}…`}</td>
                    <td>
                      <span className={window.exhausted ? "admin-tag admin-tag-warn" : "admin-tag admin-tag-ok"}>
                        {window.exhausted ? "已到期" : "进行中"}
                      </span>
                    </td>
                    <td>{formatTime(window.startedAt)}</td>
                    <td>{window.banned ? <span className="admin-tag admin-tag-bad">已封禁</span> : "未封禁"}</td>
                    <td className="admin-row-actions"><IpActions ip={window.ip} showBan onAct={confirmIp} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
