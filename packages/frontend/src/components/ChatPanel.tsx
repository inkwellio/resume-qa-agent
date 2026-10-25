import {
  ArrowRightOutlined,
  ArrowUpOutlined,
  EditOutlined,
  EllipsisOutlined,
  ExclamationCircleFilled,
  MenuOutlined,
  ShareAltOutlined,
  UserOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { Bubble, Sender, ThoughtChain } from "@ant-design/x";
import { App, Dropdown } from "antd";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { deleteSession, fetchSession, fetchSessions, renameSession } from "../sessions";
import { readSse } from "../sse";
import type { ChatMessage, Profile, ProjectDetail, SessionSummary, ToolDetails, ToolStatus, ToolStep } from "../types";
import { AnswerActions } from "./AnswerActions";
import { CompactProfile, WelcomeProfile } from "./ProfileViews";
import { ProjectPanel } from "./ProjectPanel";
import { CitationMarks, ResultCards } from "./ResultCards";
import { SessionSidebar } from "./SessionSidebar";
import { EmailLogin, fetchEmailSession, type EmailSession } from "./EmailLogin";

const AssistantMarkdown = lazy(() => import("./AssistantMarkdown").then((module) => ({ default: module.AssistantMarkdown })));

function MarkdownAnswer(props: ComponentProps<typeof AssistantMarkdown>) {
  return (
    <Suspense fallback={<div className="assistant-md assistant-md-loading">{props.text}{props.footer}</div>}>
      <AssistantMarkdown {...props} />
    </Suspense>
  );
}

/** 与 data/resume 示例人物「林知夏」对应的欢迎问题。换成自己的简历后请一并修改。 */
const SUGGESTIONS = [
  "他最有代表性的项目是什么？",
  "2023 年后做过哪些 React 项目？",
  "为什么适合前端岗位？",
];

const DONE_LABEL: Record<string, string> = {
  search_resume: "已查阅相关经历",
  get_project_detail: "已获取项目详情",
  download_resume: "已获取简历文件",
  get_contact: "已获取联系方式",
};

function stepTitle(step: ToolStep): string {
  const done = step.status === "success" ? DONE_LABEL[step.name] : undefined;
  return done ?? step.label;
}

function thoughtStatus(status: ToolStatus): "loading" | "success" | "error" {
  if (status === "pending") return "loading";
  if (status === "error") return "error";
  return "success";
}

function answerHasCitations(tools: ToolStep[] | undefined): boolean {
  return (tools ?? []).some((step) => step.details?.kind === "search" && step.details.items.length > 0);
}

function progressText(message: ChatMessage): string {
  const pending = message.tools?.find((step) => step.status === "pending");
  if (!pending || pending.name === "search_resume") return "正在检索简历…";
  return pending.label || "正在检索简历…";
}

function explainFailure(reason: unknown, fallback: string): string {
  if (reason instanceof TypeError) return "网络连接中断了，请再试一次。";
  if (reason instanceof Error && /failed to fetch|network|load failed|网络/i.test(reason.message)) {
    return "网络连接中断了，请再试一次。";
  }
  return reason instanceof Error ? reason.message : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function asToolDetails(value: unknown): ToolDetails | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  return value as ToolDetails;
}

export function ChatPanel({ profile, narrow, mock }: { profile: Profile; narrow: boolean; mock: boolean }) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [emailSession, setEmailSession] = useState<EmailSession>({ authenticated: false, email: null, configured: false });
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [authAttempt, setAuthAttempt] = useState(0);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectError, setProjectError] = useState("");
  const [projectLoading, setProjectLoading] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState("");
  const [threadErrorId, setThreadErrorId] = useState("");
  const [listTick, setListTick] = useState(0);
  const [copiedLink, setCopiedLink] = useState(false);
  const sessionId = useRef<string | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const runToken = useRef(0);
  const threadRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const messageCount = useRef(0);
  const { modal, message: toast } = App.useApp();
  messageCount.current = messages.length;

  useEffect(() => {
    const controller = new AbortController();
    setAuthLoading(true);
    setAuthError("");
    void fetchEmailSession(controller.signal).then(setEmailSession).catch((reason: unknown) => {
      if (!controller.signal.aborted) setAuthError(explainFailure(reason, "无法获取登录状态。"));
    }).finally(() => { if (!controller.signal.aborted) setAuthLoading(false); });
    return () => controller.abort();
  }, [authAttempt]);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  function scrollThreadToEnd() {
    const node = threadRef.current;
    if (!node || messageCount.current === 0 || !stickToBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }

  useLayoutEffect(() => {
    scrollThreadToEnd();
  }, [messages]);

  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    let lastTop = node.scrollTop;
    const onScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      const movedUp = node.scrollTop < lastTop - 1;
      if (movedUp && distance > 48) stickToBottom.current = false;
      else if (distance <= 48) stickToBottom.current = true;
      lastTop = node.scrollTop;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    const content = node.firstElementChild;
    const observer = content ? new ResizeObserver(() => scrollThreadToEnd()) : null;
    if (content && observer) observer.observe(content);
    return () => {
      node.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!emailSession.authenticated) {
      setSessions([]);
      setSessionError("");
      setSessionsLoading(false);
      return;
    }
    setSessionsLoading(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetchSessions(sessionQuery)
        .then((items) => {
          if (cancelled) return;
          setSessions(items);
          setSessionError("");
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          setSessionError(explainFailure(reason, "没有读到对话列表").replace("网络连接中断了，请再试一次。", "暂时连不上简历服务"));
        })
        .finally(() => {
          if (!cancelled) setSessionsLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sessionQuery, messages.length, activeId, listTick, emailSession.authenticated]);

  function patchAssistant(id: string, recipe: (message: ChatMessage) => ChatMessage) {
    setMessages((current) => current.map((message) => (message.id === id ? recipe(message) : message)));
  }

  function upsertTool(id: string, step: ToolStep) {
    patchAssistant(id, (message) => {
      const tools = message.tools ?? [];
      const index = tools.findIndex((item) => item.toolCallId === step.toolCallId);
      const next = index === -1 ? [...tools, step] : tools.map((item, itemIndex) => (itemIndex === index ? { ...item, ...step } : item));
      return { ...message, tools: next };
    });
  }

  async function openProject(id: string) {
    setProjectOpen(true);
    setProjectLoading(true);
    setProjectError("");
    setProject(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(id)}`);
      const body = (await response.json()) as ProjectDetail & { message?: string };
      if (!response.ok || body.kind !== "project") {
        throw new Error(body.message || "没有找到这个项目。");
      }
      setProject(body);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "没有找到这个项目。");
    } finally {
      setProjectLoading(false);
    }
  }

  async function stopGeneration() {
    const id = sessionId.current;
    if (!id) return;
    await fetch("/api/chat/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: id }),
    }).catch(() => undefined);
  }

  async function send(text: string, options?: { regenerate?: boolean; retry?: boolean; resend?: boolean }) {
    const question = text.trim();
    const retry = options?.retry === true;
    const regenerate = options?.regenerate === true;
    const resend = options?.resend === true;
    if ((!question && !retry && !regenerate) || streaming) return;
    if (!emailSession.authenticated) {
      if (question) setDraft(question);
      setAuthOpen(true);
      return;
    }
    stickToBottom.current = true;
    if (!retry && !regenerate && !resend) setDraft("");
    const token = runToken.current;
    const alive = () => token === runToken.current;
    let assistantId: string = crypto.randomUUID();
    setMessages((current) => {
      const dropAssistant = retry || regenerate || resend;
      const base = dropAssistant && current.at(-1)?.role === "assistant" ? current.slice(0, -1) : current;
      return [
        ...base,
        ...(dropAssistant ? [] : [{ id: crypto.randomUUID(), role: "user" as const, text: question }]),
        { id: assistantId, role: "assistant" as const, text: "", streaming: true, tools: [] },
      ];
    });
    setStreaming(true);
    setThreadError("");
    setThreadErrorId("");
    const controller = new AbortController();
    abortRef.current = controller;
    let gotDone = false;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          retry
            ? { retry: true, ...(sessionId.current ? { sessionId: sessionId.current } : {}) }
            : {
                message: question,
                ...(sessionId.current ? { sessionId: sessionId.current } : {}),
                ...(regenerate ? { regenerate: true } : {}),
              },
        ),
        signal: controller.signal,
      });
      if (!alive()) return;
      if (!response.ok) {
        if (response.status === 401) {
          setEmailSession((current) => ({ ...current, authenticated: false, email: null }));
          setAuthOpen(true);
          if (question) setDraft(question);
        }
        let message = "请求失败";
        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) message = body.message;
        } catch {
          message = "请求失败";
        }
        throw new Error(message);
      }
      await readSse(response, (event, data) => {
        if (!alive()) return;
        if (event === "session" && typeof data.sessionId === "string") {
          sessionId.current = data.sessionId;
          setActiveId(data.sessionId);
        } else if (event === "text_delta" && typeof data.delta === "string") {
          patchAssistant(assistantId, (message) => ({ ...message, text: message.text + data.delta }));
        } else if (event === "tool_start" || event === "tool_progress" || event === "tool_end") {
          const toolCallId = String(data.toolCallId ?? "");
          const status: ToolStatus = data.status === "error" ? "error" : data.status === "success" ? "success" : "pending";
          upsertTool(assistantId, {
            toolCallId,
            name: String(data.name ?? ""),
            label: String(data.label ?? "正在查阅"),
            status,
            ...(data.args !== undefined ? { args: data.args } : {}),
            ...(typeof data.content === "string" ? { content: data.content } : {}),
            ...(asToolDetails(data.details) ? { details: asToolDetails(data.details) } : {}),
          });
        } else if (event === "error" && typeof data.message === "string") {
          patchAssistant(assistantId, (message) => ({ ...message, error: data.message as string }));
        } else if (event === "done") {
          gotDone = true;
          const serverId = typeof data.messageId === "string" ? data.messageId : assistantId;
          const stopped = data.stopReason === "aborted";
          patchAssistant(assistantId, (message) => ({
            ...message,
            id: serverId,
            saved: true,
            streaming: false,
            stopped,
            ...(stopped ? { error: undefined, tools: message.tools?.filter((step) => step.status !== "pending") } : {}),
          }));
          assistantId = serverId;
          setListTick((value) => value + 1);
        }
      });
      if (alive() && !gotDone) {
        patchAssistant(assistantId, (current) => ({
          ...current,
          error: current.error || "网络连接中断了，请再试一次。",
        }));
      }
    } catch (error) {
      if (!alive() || controller.signal.aborted) return;
      patchAssistant(assistantId, (current) => ({ ...current, error: explainFailure(error, "请求失败") }));
    } finally {
      if (alive()) {
        patchAssistant(assistantId, (current) => ({ ...current, streaming: false }));
        setStreaming(false);
      }
      if (abortRef.current === controller) abortRef.current = null;
      setListTick((value) => value + 1);
    }
  }

  function startNewChat() {
    runToken.current += 1;
    const id = sessionId.current;
    if (streaming && id) {
      void fetch("/api/chat/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
      }).catch(() => undefined);
    }
    abortRef.current?.abort();
    stickToBottom.current = true;
    sessionId.current = undefined;
    setActiveId(undefined);
    setMessages([]);
    setDraft("");
    setProjectOpen(false);
    setSessionsOpen(false);
    setThreadError("");
    setThreadErrorId("");
    setStreaming(false);
  }

  async function openSession(id: string) {
    runToken.current += 1;
    const current = sessionId.current;
    if (streaming && current) {
      void fetch("/api/chat/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: current }),
      }).catch(() => undefined);
    }
    abortRef.current?.abort();
    setStreaming(false);
    setThreadLoading(true);
    setThreadError("");
    setThreadErrorId("");
    setProjectOpen(false);
    setSessionsOpen(false);
    try {
      const session = await fetchSession(id);
      sessionId.current = session.id;
      setActiveId(session.id);
      stickToBottom.current = true;
      setMessages(session.messages);
    } catch (reason) {
      sessionId.current = undefined;
      setActiveId(undefined);
      setMessages([]);
      setThreadError(explainFailure(reason, "没有找到这轮对话").replace("网络连接中断了，请再试一次。", "暂时连不上简历服务"));
      setThreadErrorId(id);
    } finally {
      setThreadLoading(false);
    }
  }

  function confirmDelete(id: string) {
    const title = sessions.find((item) => item.id === id)?.title || "这轮对话";
    modal.confirm({
      className: "delete-confirm",
      title: "删除这轮对话？",
      icon: <ExclamationCircleFilled />,
      content: `「${title}」会直接删除，消息一并去掉，没有回收站。`,
      okText: "删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: async () => {
        await deleteSession(id);
        setSessions((current) => current.filter((item) => item.id !== id));
        if (sessionId.current === id) startNewChat();
      },
    });
  }

  async function share() {
    try {
      await navigator.clipboard.writeText(new URL("/", window.location.origin).href);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 1500);
    } catch {
      void toast.warning("无法复制链接，请从浏览器地址栏复制主页地址。");
    }
  }

  const empty = messages.length === 0 && !threadLoading;
  const lastAssistantId = [...messages].reverse().find((message) => message.role === "assistant")?.id;
  const note = mock ? "答案由 AI 根据简历内容生成 · 本地演示" : "答案由 AI 根据简历内容生成";

  const composer = (
    <div className="composer-block">
      <div className="email-auth-bar">
        {authLoading ? <span role="status">正在检查登录状态…</span> : authError ? <><span role="alert">{authError}</span><button type="button" onClick={() => setAuthAttempt((value) => value + 1)}>重试</button></> : emailSession.authenticated ? (
          <><span>已验证：{emailSession.email}</span><button type="button" disabled={streaming} onClick={() => {
            void fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((response) => {
              if (!response.ok) throw new Error("退出失败，请重试。");
              startNewChat();
              setEmailSession((current) => ({ ...current, authenticated: false, email: null }));
              setSessions([]);
            }).catch(() => { void toast.error("退出失败，请稍后重试。"); });
          }}>退出登录</button></>
        ) : <><span>{emailSession.configured ? "验证邮箱后即可参与聊天" : "邮箱验证暂未开放"}</span><button type="button" onClick={() => setAuthOpen(true)}>邮箱验证</button></>}
      </div>
      <Sender
        className="composer"
        value={draft}
        onChange={setDraft}
        loading={streaming}
        disabled={authLoading || Boolean(authError)}
        placeholder={emailSession.authenticated ? "问问我的经历..." : "验证邮箱后即可提问…"}
        submitType="enter"
        autoSize={{ minRows: 1, maxRows: 6 }}
        onSubmit={(value) => void send(value)}
        onCancel={() => void stopGeneration()}
        suffix={(_, info) => {
          const { SendButton } = info.components;
          if (streaming) {
            return (
              <button className="composer-stop" type="button" aria-label="停止生成" onClick={() => void stopGeneration()}>
                <span />
              </button>
            );
          }
          return <SendButton className="send-button" aria-label="发送" icon={<ArrowUpOutlined />} />;
        }}
      />
      <p className="composer-note">{note}</p>
    </div>
  );

  const sidebarProps = {
    profile,
    requiresLogin: !emailSession.authenticated,
    sessions,
    query: sessionQuery,
    activeId,
    error: sessionError,
    loading: sessionsLoading,
    onQuery: setSessionQuery,
    onCreate: startNewChat,
    onReload: () => {
      setSessionsLoading(true);
      setListTick((value) => value + 1);
    },
    onRename: async (id: string, title: string) => {
      await renameSession(id, title);
      setSessions((current) => current.map((item) => (item.id === id ? { ...item, title } : item)));
    },
    onDelete: confirmDelete,
    onSelect: (id: string) => {
      void openSession(id);
    },
  };

  return (
    <div className="shell">
      <EmailLogin open={authOpen} configured={emailSession.configured} onClose={() => setAuthOpen(false)} onVerified={(session) => {
        startNewChat();
        setDraft(draft);
        setEmailSession(session);
        setListTick((value) => value + 1);
      }} />
      {narrow ? null : <SessionSidebar mode="desktop" {...sidebarProps} />}
      <div className="workspace">
        <header className="topbar">
          {narrow ? (
            <>
              <button
                className="icon-button icon-button-lg"
                type="button"
                aria-label="打开历史记录"
                onClick={() => {
                  setProjectOpen(false);
                  setSessionsOpen(true);
                }}
              >
                <MenuOutlined />
              </button>
              <div className="topbar-title">
                <i className="live-dot" />
                <h1>简历问答</h1>
              </div>
              <div className="topbar-actions">
                <button className="icon-button icon-button-lg" type="button" aria-label="新建对话" onClick={startNewChat}>
                  <EditOutlined />
                </button>
                <button className="icon-button icon-button-lg" type="button" aria-label="分享主页" onClick={() => void share()}>
                  <ShareAltOutlined />
                </button>
                <span className="topbar-avatar">
                  <UserOutlined />
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="topbar-title">
                <strong>
                  {profile.name} · 简历问答
                </strong>
                <span className="capability-pill">
                  <i />
                  {profile.headline.split("·")[0]?.trim() || "简历问答"}
                </span>
              </div>
              <div className="topbar-actions">
                <button className="share-button" type="button" onClick={() => void share()}>
                  <ShareAltOutlined />
                  {copiedLink ? "已复制链接" : "分享主页"}
                </button>
                <Dropdown
                  menu={{
                    items: [{ key: "new", label: "新建对话", onClick: startNewChat }],
                  }}
                >
                  <button className="icon-button" type="button" aria-label="更多">
                    <EllipsisOutlined />
                  </button>
                </Dropdown>
                <span className="topbar-avatar">
                  <UserOutlined />
                </span>
              </div>
            </>
          )}
        </header>
        <div className="stage">
          <div className="thread-wrap">
            <div className="thread" ref={threadRef}>
              <div className={empty && !narrow ? "thread-inner thread-welcome" : "thread-inner"}>
                {empty && !narrow ? <WelcomeProfile profile={profile} /> : <CompactProfile profile={profile} narrow={narrow} />}
                <div className="intro">
                  <div className="intro-copy">
                    {empty && !narrow ? (
                      <div className="intro-meta">
                        <strong>简历助手 Copilot</strong>
                        <span>{emailSession.authenticated ? "智能问答已就绪" : "验证邮箱后开始问答"}</span>
                      </div>
                    ) : null}
                    <div className={empty && !narrow ? "intro-bubble intro-bubble-welcome" : "intro-bubble"}>
                      你好，我是{profile.name}的简历助手，可以问我他的项目、技能和经历。
                      {empty && !narrow ? "你可以点击下方热门问题，也可以在下方输入框自由提问。" : ""}
                    </div>
                    <div className={empty && !narrow ? "suggestion-grid" : narrow ? "suggestion-list" : "suggestion-pills"}>
                      {SUGGESTIONS.map((label) => (
                        <button key={label} type="button" onClick={() => void send(label)}>
                          <span>{label}</span>
                          {narrow || (empty && !narrow) ? (
                            <ArrowRightOutlined className="suggestion-arrow" />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {threadLoading ? (
                  <div className="thread-skeleton" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                ) : null}
                {threadError ? (
                  <div className="answer-error">
                    <p>
                      <WarningFilled />
                      {threadError}
                    </p>
                    {threadErrorId ? (
                      <button type="button" onClick={() => void openSession(threadErrorId)}>
                        重试
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {threadLoading
                  ? null
                  : messages.map((message) =>
                  message.role === "user" ? (
                    <div key={message.id} className="user-row">
                      <Bubble
                        placement="end"
                        variant="borderless"
                        content={message.text}
                        className="user-bubble"
                      />
                    </div>
                  ) : (
                    <div key={message.id} className="assistant-block">
                      {message.streaming && !message.text && !message.tools?.length ? (
                        <p className="progress-hint" role="status">
                          <i />
                          {progressText(message)}
                        </p>
                      ) : null}
                      {message.tools && message.tools.length > 0 ? (
                        <ThoughtChain
                          className="tool-chain"
                          line={false}
                          items={message.tools.map((step) => ({
                            key: step.toolCallId,
                            title: stepTitle(step),
                            status: thoughtStatus(step.status),
                            blink: step.status === "pending",
                          }))}
                        />
                      ) : null}
                      {message.text || message.error || message.stopped ? (
                        <div className="assistant-row">
                          <div className="assistant-copy">
                            {message.text || message.error || message.stopped ? (
                              <div className="assistant-card">
                                {message.text ? (
                                  <MarkdownAnswer
                                    text={message.text}
                                    allowedLinks={[
                                      profile.resumePdf, profile.contact.github, profile.contact.website,
                                      ...(profile.contact.email ? [`mailto:${profile.contact.email}`] : []),
                                      ...(profile.contact.phone ? [`tel:${profile.contact.phone}`] : []),
                                    ]}
                                    footer={
                                      answerHasCitations(message.tools) || message.stopped ? (
                                        <div className="assistant-md-tail">
                                          <CitationMarks tools={message.tools ?? []} text={message.text} />
                                          {message.stopped ? <span className="stopped-mark">已停止生成</span> : null}
                                        </div>
                                      ) : null
                                    }
                                  />
                                ) : message.stopped ? (
                                  <span className="stopped-mark">已停止生成</span>
                                ) : null}
                                <ResultCards
                                  tools={message.tools ?? []}
                                  text={message.text}
                                  onOpenProject={(id) => void openProject(id)}
                                />
                                {message.error ? (
                                  <div className="answer-error">
                                    <p>
                                      <WarningFilled />
                                      {message.error}
                                    </p>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (message.saved) {
                                          void send("", { retry: true });
                                          return;
                                        }
                                        const question = [...messages].reverse().find((item) => item.role === "user")?.text ?? "";
                                        void send(question, { resend: true });
                                      }}
                                    >
                                      重试
                                    </button>
                                  </div>
                                ) : null}
                                {!message.streaming && !message.error ? (
                                  <AnswerActions
                                    message={message}
                                    sessionId={sessionId.current}
                                    canRegenerate={Boolean(message.saved && message.id === lastAssistantId && !streaming)}
                                    onRegenerate={() => {
                                      const question = [...messages].reverse().find((item) => item.role === "user")?.text ?? "";
                                      void send(question, { regenerate: true });
                                    }}
                                    onRated={(rating) => patchAssistant(message.id, (current) => ({ ...current, rating }))}
                                  />
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ),
                )}
              </div>
            </div>
            <div className="composer-dock">{composer}</div>
          </div>
          {projectOpen && !narrow ? (
            <ProjectPanel
              project={project}
              loading={projectLoading}
              error={projectError}
              onClose={() => setProjectOpen(false)}
            />
          ) : null}
        </div>
      </div>
      {narrow && sessionsOpen ? <SessionSidebar mode="drawer" {...sidebarProps} onClose={() => setSessionsOpen(false)} /> : null}
      {narrow && projectOpen ? (
        <div className="mobile-project">
          <button className="mobile-mask" type="button" aria-label="关闭项目详情" onClick={() => setProjectOpen(false)} />
          <ProjectPanel project={project} loading={projectLoading} error={projectError} onClose={() => setProjectOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}
