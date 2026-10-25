import { Alert, Button, Input, Modal } from "antd";
import { useEffect, useState } from "react";

export interface EmailSession { authenticated: boolean; email: string | null; configured: boolean }
export async function fetchEmailSession(signal?: AbortSignal): Promise<EmailSession> {
  const response = await fetch("/api/auth/session", { signal, cache: "no-store" });
  if (!response.ok) throw new Error("暂时无法获取登录状态，请刷新重试。");
  return response.json() as Promise<EmailSession>;
}

export function EmailLogin({ open, configured, onClose, onVerified }: {
  open: boolean; configured: boolean; onClose: () => void; onVerified: (session: EmailSession) => void;
}) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);
  const [error, setError] = useState("");
  const [deadline, setDeadline] = useState(0);
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    const update = () => setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);

  async function submit(action: "code" | "verify") {
    if (busy) return;
    setBusy(action === "code" ? "send" : "verify");
    setError("");
    try {
      const response = await fetch(`/api/auth/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), ...(action === "verify" ? { code } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json() as { message?: string; email?: string; retryAfter?: number };
      if (!response.ok) {
        const retry = Number(response.headers.get("Retry-After"));
        if (action === "code" && retry > 0) setDeadline(Date.now() + retry * 1000);
        throw new Error(body.message || "验证失败，请稍后重试。");
      }
      if (action === "code") {
        setSentTo(email.trim());
        setCode("");
        setDeadline(Date.now() + (body.retryAfter ?? 60) * 1000);
      } else {
        setCode("");
        onVerified({ authenticated: true, email: body.email ?? email.trim(), configured: true });
        onClose();
      }
    } catch (reason) {
      setError(reason instanceof TypeError ? "网络连接失败，请稍后重试。" : reason instanceof Error ? reason.message : "验证失败，请重试。");
    } finally { setBusy(null); }
  }

  return (
    <Modal title="验证邮箱后开始聊天" open={open} onCancel={onClose} footer={null} width={420} maskClosable={!busy} closable={!busy}>
      <form className="email-login-form" onSubmit={(event) => { event.preventDefault(); void submit("verify"); }}>
        <p>请输入你的邮箱，我们会发送一个 6 位验证码。验证成功后即可提问并保存聊天记录。</p>
        {!configured ? <Alert type="info" showIcon title="邮箱验证暂未开放，请稍后再来。" /> : null}
        {error ? <Alert type="error" showIcon title={error} role="alert" /> : null}
        <label htmlFor="login-email">邮箱地址</label>
        <Input id="login-email" type="email" autoComplete="email" required maxLength={254} value={email}
          placeholder="你的邮箱地址" disabled={Boolean(busy)} onChange={(event) => { setEmail(event.target.value); setCode(""); }} />
        <Button onClick={() => void submit("code")} loading={busy === "send"} disabled={!configured || Boolean(busy) || remaining > 0 || !email.trim()}>
          {remaining > 0 ? `${remaining} 秒后可重新发送` : "发送验证码"}
        </Button>
        {sentTo ? <p className="email-login-sent" role="status">验证码已发送至 {sentTo}，5 分钟内有效。未收到时请检查垃圾邮件。</p> : null}
        <label htmlFor="login-code">邮箱验证码</label>
        <Input id="login-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6}
          placeholder="6 位数字验证码" value={code} disabled={Boolean(busy)} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} />
        <Button type="primary" htmlType="submit" loading={busy === "verify"} disabled={!configured || Boolean(busy) || code.length !== 6}>
          验证并开始聊天
        </Button>
        <p className="email-login-privacy">邮箱仅用于登录验证和关联聊天记录，不会发送营销邮件。登录状态保留 7 天，请勿向他人透露验证码。</p>
      </form>
    </Modal>
  );
}
