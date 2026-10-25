import { CalendarOutlined, CloseOutlined } from "@ant-design/icons";
import { Alert } from "antd";
import type { ProjectDetail } from "../types";

export function ProjectPanel({
  project,
  loading,
  error,
  onClose,
}: {
  project: ProjectDetail | null;
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  return (
    <aside className="project-panel">
      <div className="project-panel-head">
        <div className="project-panel-title">
          <strong>项目详情</strong>
          <i />
        </div>
        <button className="icon-button" type="button" aria-label="关闭项目详情" onClick={onClose}>
          <CloseOutlined />
        </button>
      </div>
      {loading ? <p className="muted">正在读取项目全文…</p> : null}
      {error ? <Alert type="warning" showIcon message={error} /> : null}
      {project ? (
        <>
          <div className="project-meta">
            <strong>{project.title}</strong>
            {project.period ? (
              <span className="project-period">
                <CalendarOutlined />
                {project.period}
              </span>
            ) : null}
            <div className="skill-row">
              {project.tech_stack.map((tech) => (
                <span key={tech} className="meta-chip">
                  {tech}
                </span>
              ))}
            </div>
          </div>
          <div className="project-section">
            <h3>项目说明</h3>
            <p>{project.text.trim()}</p>
          </div>
        </>
      ) : null}
    </aside>
  );
}
