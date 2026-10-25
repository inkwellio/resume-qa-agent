import { ExclamationCircleFilled, InfoCircleFilled } from "@ant-design/icons";
import { Button, Input } from "antd";
import { useState, type ReactNode } from "react";
import { AdminHttpError, adminErrorText, adminFetch } from "./client";

const PHONE = /^1[3-9]\d{9}$/;

function FieldError(props: { message: string }) {
  return <span className="admin-field-error"><ExclamationCircleFilled /> {props.message}</span>;
}

function AuthFrame(props: { children: ReactNode; status: string }) {
  return (
    <div className="admin-auth">
      <header className="admin-auth-bar">
        <span className="admin-brand">
          <span className="admin-brand-mark" aria-hidden>简</span>
          <strong>简历问答 · 管理后台</strong>
        </span>
      </header>
      <div className="admin-auth-main">{props.children}</div>
      <footer className="admin-auth-foot">
        <span>{props.status}</span>
        <span aria-hidden>·</span>
        <span>简历问答 · 智能简历咨询管控台</span>
      </footer>
    </div>
  );
}

export function AdminSetup(props: { onSuccess: () => void }) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<{ phone?: string; password?: string; confirm?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  async function submit() {
    const next: typeof errors = {};
    const normalized = phone.replace(/[\s-]/g, "");
    if (!PHONE.test(normalized)) next.phone = "请输入 11 位中国大陆手机号";
    if (password.length < 8) next.password = "密码至少 8 位";
    if (password !== confirmPassword) next.confirm = "两次密码不一致";
    setErrors(next);
    if (next.phone || next.password || next.confirm) return;
    setBusy(true);
    try {
      await adminFetch("/api/admin/setup", {
        method: "POST",
        body: JSON.stringify({ phone: normalized, password, confirmPassword }),
      });
      props.onSuccess();
    } catch (reason) {
      const message = reason instanceof AdminHttpError ? reason.message : adminErrorText(reason);
      if (message.includes("手机号")) setErrors({ phone: message });
      else if (message.includes("密码不一致")) setErrors({ confirm: message });
      else if (message.includes("密码")) setErrors({ password: message });
      else setErrors({ form: message });
    } finally {
      setBusy(false);
    }
  }

  const status = errors.phone || errors.password || errors.confirm ? "系统状态：输入数据校验" : "系统状态：初始化配置";
  return (
    <AuthFrame status={status}>
      <form className="admin-login-card" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="admin-login-mark" aria-hidden>简</div>
        <h1>简历问答 · 管理后台</h1>
        <p className="admin-note">首次设置站长账号</p>
        <label className="admin-field">
          <span>手机号</span>
          <Input value={phone} inputMode="numeric" autoComplete="tel" maxLength={11} placeholder="请输入 11 位手机号" status={errors.phone ? "error" : ""} disabled={busy} onChange={(event) => setPhone(event.target.value)} />
          {errors.phone ? <FieldError message={errors.phone} /> : null}
        </label>
        <label className="admin-field">
          <span>密码</span>
          <Input.Password value={password} autoComplete="new-password" placeholder="设置账号密码" status={errors.password ? "error" : ""} disabled={busy} onChange={(event) => setPassword(event.target.value)} />
          {errors.password ? <FieldError message={errors.password} /> : null}
        </label>
        <label className="admin-field">
          <span>确认密码</span>
          <Input.Password value={confirmPassword} autoComplete="new-password" placeholder="再次输入密码" status={errors.confirm ? "error" : ""} disabled={busy} onChange={(event) => setConfirmPassword(event.target.value)} />
          {errors.confirm ? <FieldError message={errors.confirm} /> : null}
        </label>
        <p className="admin-callout"><InfoCircleFilled aria-hidden /> <span>仅可创建一次，创建后将关闭注册</span></p>
        {errors.form ? <FieldError message={errors.form} /> : null}
        <Button type="primary" htmlType="submit" block loading={busy}>创建站长账号</Button>
        <a className="admin-quiet-link" href="/">返回首页</a>
      </form>
    </AuthFrame>
  );
}

export function AdminLogin(props: { onSuccess: () => void }) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const normalized = phone.replace(/[\s-]/g, "");
    if (!PHONE.test(normalized) || password.length < 8) {
      setPasswordError("手机号或密码错误");
      return;
    }
    setPasswordError("");
    setBusy(true);
    try {
      await adminFetch("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ phone: normalized, password }),
      });
      props.onSuccess();
    } catch (reason) {
      const message = reason instanceof AdminHttpError && reason.status === 401
        ? "手机号或密码错误"
        : adminErrorText(reason);
      setPasswordError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame status="权限：受限管控区">
      <form className="admin-login-card" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="admin-login-mark" aria-hidden>简</div>
        <h1>简历问答 · 管理后台</h1>
        <p className="admin-note">仅站长使用</p>
        <label className="admin-field">
          <span>手机号</span>
          <Input value={phone} inputMode="numeric" autoComplete="tel" maxLength={11} placeholder="请输入 11 位手机号" disabled={busy} onChange={(event) => setPhone(event.target.value)} />
        </label>
        <label className="admin-field">
          <span>密码</span>
          <Input.Password value={password} autoComplete="current-password" placeholder="请输入密码" status={passwordError ? "error" : ""} disabled={busy} onChange={(event) => setPassword(event.target.value)} />
          {passwordError ? <FieldError message={passwordError} /> : null}
        </label>
        <Button type="primary" htmlType="submit" block loading={busy}>登录</Button>
        <p className="admin-login-hint">访客请返回简历问答首页</p>
        <a className="admin-quiet-link" href="/">返回首页</a>
      </form>
    </AuthFrame>
  );
}
