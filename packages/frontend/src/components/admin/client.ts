import { useEffect, useState } from "react";

export const PAGE = 20;

export interface AdminUser {
  userId: string;
  email: string;
  createdAt: string;
  visitorCount: number;
  sessionCount: number;
  lastSessionAt: string | null;
}
export interface AdminSession {
  id: string;
  title: string;
  visitorId: string;
  userId: string | null;
  email: string | null;
  ip: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AdminTurn { question: string; answer: string }
export interface AdminSessionDetail extends AdminSession { turns: AdminTurn[] }
export interface PageBody { total: number; limit: number; offset: number }
export interface UsersBody extends PageBody { users: AdminUser[] }
export interface SessionsBody extends PageBody { sessions: AdminSession[] }
export interface IpWindow { startedAt: string; expiresAt: string; exhausted: boolean }
export interface BanRow { ip: string; note: string; createdAt: string; window: IpWindow | null }
export interface WindowRow {
  ipHash: string;
  ip: string | null;
  startedAt: string;
  expiresAt: string;
  exhausted: boolean;
  banned: boolean;
}
export interface IpsBody { bans: BanRow[]; windows: WindowRow[] }

export class AdminHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function adminFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, cache: "no-store", credentials: "same-origin" });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new AdminHttpError(body.message || "请求失败", response.status);
  return body as T;
}

export function adminErrorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : "读取失败";
}

export function recordedIp(value: string | null | undefined): string {
  const ip = value?.trim();
  if (!ip || ip === "unknown") return "";
  return ip;
}

export function formatIp(value: string | null | undefined): string {
  return recordedIp(value) || "—";
}

export function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

export function shortId(value: string): string {
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

export function emailInitials(email: string): string {
  const local = email.split("@")[0] ?? "";
  const letters = local.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();
  return letters || "—";
}

export function useAdminQuery<T>(
  path: string | null,
  refreshKey: number,
  onUnauthorized: () => void,
): { data: T | null; error: string; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(path !== null);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void adminFetch<T>(path, { signal: controller.signal })
      .then((body) => {
        if (!controller.signal.aborted) setData(body);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isAbort(reason)) return;
        if (reason instanceof AdminHttpError && reason.status === 401) {
          onUnauthorized();
          return;
        }
        setError(adminErrorText(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, refreshKey, onUnauthorized]);

  return { data, error, loading };
}
