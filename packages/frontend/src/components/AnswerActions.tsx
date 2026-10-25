import { CheckOutlined, CopyOutlined, DislikeFilled, DislikeOutlined, LikeFilled, LikeOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Input, Popover, Radio } from "antd";
import { useState } from "react";
import type { ChatMessage } from "../types";

const REASONS = ["信息不准确", "没回答到点上", "其他"] as const;

async function sendFeedback(input: {
  sessionId: string;
  messageId: string;
  rating: "like" | "dislike" | "clear";
  reason?: string;
  comment?: string;
}): Promise<void> {
  const response = await fetch("/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || "没有记下反馈");
  }
}

export function AnswerActions({
  message,
  sessionId,
  canRegenerate,
  onRegenerate,
  onRated,
}: {
  message: ChatMessage;
  sessionId?: string;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onRated: (rating: "like" | "dislike" | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number] | "">("");
  const [comment, setComment] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const ready = Boolean(message.saved && sessionId);
  const bareStop = message.stopped === true && message.text.trim() === "";

  async function submit(rating: "like" | "dislike" | "clear", nextReason = "", nextComment = "") {
    if (!sessionId || !message.saved) return;
    setError("");
    await sendFeedback({
      sessionId,
      messageId: message.id,
      rating,
      ...(nextReason ? { reason: nextReason } : {}),
      ...(nextComment ? { comment: nextComment } : {}),
    });
    onRated(rating === "clear" ? null : rating);
    setOpen(false);
  }

  if (bareStop) {
    if (!canRegenerate) return null;
    return (
      <div className="answer-actions">
        <div className="action-icons">
          <button className="icon-button" type="button" aria-label="重新生成" onClick={onRegenerate}>
            <ReloadOutlined />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="answer-actions">
      <div className="action-icons">
        <button
          className={message.rating === "like" ? "icon-button active" : "icon-button"}
          type="button"
          aria-label="有用"
          disabled={!ready}
          onClick={() => {
            const next = message.rating === "like" ? "clear" : "like";
            void submit(next).catch((reasonError: unknown) => {
              setError(reasonError instanceof Error ? reasonError.message : "没有记下反馈");
            });
          }}
        >
          {message.rating === "like" ? <LikeFilled /> : <LikeOutlined />}
        </button>
        <Popover
          trigger="click"
          open={open}
          onOpenChange={(next) => {
            if (ready) setOpen(next);
          }}
          content={
            <div className="feedback-box">
              <Radio.Group
                value={reason}
                onChange={(event) => setReason(event.target.value as (typeof REASONS)[number])}
              >
                {REASONS.map((item) => (
                  <Radio key={item} value={item}>
                    {item}
                  </Radio>
                ))}
              </Radio.Group>
              <Input.TextArea
                value={comment}
                placeholder="补充说明，可以不填"
                autoSize={{ minRows: 2, maxRows: 4 }}
                onChange={(event) => setComment(event.target.value)}
              />
              <div className="feedback-actions">
                <Button
                  size="small"
                  type="primary"
                  onClick={() => {
                    void submit("dislike", reason, comment).catch((reasonError: unknown) => {
                      setError(reasonError instanceof Error ? reasonError.message : "没有记下反馈");
                    });
                  }}
                >
                  提交
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    void submit("dislike").catch((reasonError: unknown) => {
                      setError(reasonError instanceof Error ? reasonError.message : "没有记下反馈");
                    });
                  }}
                >
                  跳过
                </Button>
                {message.rating === "dislike" ? (
                  <Button
                    size="small"
                    type="text"
                    onClick={() => {
                      void submit("clear").catch((reasonError: unknown) => {
                        setError(reasonError instanceof Error ? reasonError.message : "没有撤销反馈");
                      });
                    }}
                  >
                    撤销
                  </Button>
                ) : null}
              </div>
            </div>
          }
        >
          <button
            className={message.rating === "dislike" ? "icon-button active" : "icon-button"}
            type="button"
            aria-label="没用"
            disabled={!ready}
          >
            {message.rating === "dislike" ? <DislikeFilled /> : <DislikeOutlined />}
          </button>
        </Popover>
        <button
          className="icon-button"
          type="button"
          aria-label={copied ? "已复制" : "复制回答"}
          onClick={() => {
            void navigator.clipboard.writeText(message.text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <CheckOutlined /> : <CopyOutlined />}
        </button>
        {canRegenerate ? (
          <button className="icon-button" type="button" aria-label="重新生成" onClick={onRegenerate}>
            <ReloadOutlined />
          </button>
        ) : null}
      </div>
      {error ? <span className="feedback-error">{error}</span> : null}
    </div>
  );
}
