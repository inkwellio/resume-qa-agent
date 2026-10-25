import { CloseOutlined, EllipsisOutlined, MessageFilled, MessageOutlined, PlusOutlined, RightOutlined, SearchOutlined, UserOutlined } from "@ant-design/icons";
import { Dropdown } from "antd";
import { useState } from "react";
import type { Profile, SessionSummary } from "../types";
import { groupSessions } from "../sessions";
import { Portrait } from "./ProfileViews";

function SparkIcon() {
  return (
    <svg className="spark-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2.4 13.55 8.45 19.6 10 13.55 11.55 12 17.6 10.45 11.55 4.4 10 10.45 8.45 12 2.4Zm6.15 12.05.7 1.85 1.85.7-1.85.7-.7 1.85-.7-1.85-1.85-.7 1.85-.7.7-1.85Z"
      />
    </svg>
  );
}

export function SessionSidebar({
  mode,
  profile,
  sessions,
  query,
  activeId,
  error,
  loading,
  requiresLogin = false,
  onQuery,
  onCreate,
  onSelect,
  onRename,
  onDelete,
  onReload,
  onClose,
}: {
  mode: "desktop" | "drawer";
  profile: Profile;
  sessions: SessionSummary[];
  query: string;
  activeId?: string;
  error?: string;
  loading?: boolean;
  requiresLogin?: boolean;
  onQuery: (value: string) => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => void;
  onReload: () => void;
  onClose?: () => void;
}) {
  const groups = groupSessions(sessions);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState("");

  async function commitRename(id: string) {
    const title = draft.trim();
    if (!title) {
      setEditingId(null);
      return;
    }
    try {
      await onRename(id, title);
      setEditingId(null);
      setRenameError("");
    } catch (reason) {
      setRenameError(reason instanceof Error ? reason.message : "没有改成新标题");
    }
  }

  const body = (
    <>
      <div className={mode === "drawer" ? "drawer-head" : "brand"}>
        <div className="brand-mark">
          <SparkIcon />
        </div>
        <div className="brand-copy">
          <strong>简历问答 Copilot</strong>
          <span>{mode === "drawer" ? "智能上下文记忆" : `${profile.name} · 智能人才咨询`}</span>
        </div>
        {mode === "drawer" ? (
          <button className="icon-button" type="button" aria-label="关闭历史" onClick={onClose}>
            <CloseOutlined />
          </button>
        ) : null}
      </div>
      <div className="sidebar-pad">
        <button className={mode === "drawer" ? "new-chat new-chat-solid" : "new-chat"} type="button" onClick={onCreate}>
          <PlusOutlined />
          新建对话
        </button>
      </div>
      <div className="sidebar-pad sidebar-search-pad">
        <label className="search-field">
          <SearchOutlined />
          <input
            value={query}
            placeholder="搜索对话..."
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
      </div>
      <div className="session-scroll">
        {loading ? (
          <div className="session-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ) : null}
        {!loading && error ? (
          <div className="session-empty">
            <strong>暂时连不上简历服务</strong>
            <span>{error}</span>
            <button type="button" onClick={onReload}>
              重试
            </button>
          </div>
        ) : null}
        {!loading && !error && groups.length === 0 ? (
          <div className="session-empty">
            <strong>{requiresLogin ? "验证邮箱后查看对话" : query ? "搜不到" : "还没有对话"}</strong>
            <span>{requiresLogin ? "验证后可保存和继续聊天" : query ? "换个关键词试试" : "提问之后会出现在这里"}</span>
          </div>
        ) : null}
        {renameError ? <p className="session-hint">{renameError}</p> : null}
        {!loading && !error
          ? groups.map((group) => (
              <section key={group.label} className="session-group">
                <div className="session-group-label">
                  <span>{group.label === "近 7 天" ? "最近 7 天" : group.label}</span>
                  {mode === "drawer" ? <span>{group.items.length} 条</span> : null}
                </div>
                {group.items.map((item) => {
                  const active = item.id === activeId;
                  return (
                    <div key={item.id} className={active ? "session-link active" : "session-link"}>
                      {mode === "drawer" ? active ? <MessageFilled /> : <MessageOutlined /> : null}
                      {editingId === item.id ? (
                        <input
                          className="session-rename"
                          value={draft}
                          aria-label="对话标题"
                          maxLength={80}
                          autoFocus
                          onChange={(event) => setDraft(event.target.value)}
                          onBlur={() => void commitRename(item.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void commitRename(item.id);
                            if (event.key === "Escape") setEditingId(null);
                          }}
                        />
                      ) : (
                        <button type="button" className="session-select" onClick={() => onSelect(item.id)}>
                          <span>{item.title || "未命名对话"}</span>
                        </button>
                      )}
                      {mode === "drawer" && active ? <RightOutlined className="session-chevron" /> : null}
                      <Dropdown
                        trigger={["click"]}
                        menu={{
                          items: [
                            {
                              key: "rename",
                              label: "重命名",
                              onClick: () => {
                                setDraft(item.title || "");
                                setEditingId(item.id);
                              },
                            },
                            { key: "delete", label: "删除", danger: true, onClick: () => onDelete(item.id) },
                          ],
                        }}
                      >
                        <button className="icon-button session-more" type="button" aria-label="对话操作">
                          <EllipsisOutlined />
                        </button>
                      </Dropdown>
                    </div>
                  );
                })}
              </section>
            ))
          : null}
      </div>
      <div className={mode === "drawer" ? "sidebar-dock drawer-dock" : "sidebar-dock"}>
        <div className="dock-person">
          <span className="dock-avatar">
            {mode === "drawer" ? (
              <Portrait className="dock-photo" src={profile.avatar} name={profile.name} />
            ) : (
              <span className="dock-glyph">
                <UserOutlined />
              </span>
            )}
            <i className="online-dot" />
          </span>
          <span className="dock-copy">
            <span className="dock-name">
              <strong>{profile.name}</strong>
              <em>候选人</em>
            </span>
            <span className="dock-status">
              <i />
              在线 · 随时解答
            </span>
          </span>
        </div>
      </div>
    </>
  );

  if (mode === "desktop") {
    return <aside className="sidebar">{body}</aside>;
  }

  return (
    <div className="mobile-history">
      <aside className="mobile-drawer" role="dialog" aria-label="历史对话记录">
        {body}
      </aside>
      <button className="mobile-mask" type="button" aria-label="关闭历史" onClick={onClose} />
    </div>
  );
}
