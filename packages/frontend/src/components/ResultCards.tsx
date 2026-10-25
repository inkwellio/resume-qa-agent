import { ArrowRightOutlined, DownloadOutlined } from "@ant-design/icons";
import { Tooltip } from "antd";
import { useState } from "react";
import { dedupedCitations, selectProjectCards, visibleCitations } from "../answer-extras";
import type { ToolDetails, ToolStep } from "../types";
import { stripThinkingTags } from "../visible-text";
import { ContactList } from "./ProfileViews";

const TYPE_LABEL = {
  experience: "经历",
  project: "项目",
  skill: "技能",
  education: "教育",
} as const;

export function CitationMarks({ tools, text }: { tools: ToolStep[]; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const visibleText = stripThinkingTags(text);
  const items = dedupedCitations(tools);
  const { shown, hiddenCount } = visibleCitations(tools, visibleText);
  const listed = expanded ? items : shown;
  if (!listed.length) return null;
  return (
    <>
      {listed.map((item, index) => (
        <Tooltip
          key={item.id}
          title={
            <span>
              <strong>{item.title}</strong>
              <br />
              {item.snippet}
            </span>
          }
        >
          <sup className="cite-chip">
            {index + 1} · {TYPE_LABEL[item.type]}
          </sup>
        </Tooltip>
      ))}
      {hiddenCount > 0 ? (
        <button type="button" className="cite-more" onClick={() => setExpanded((open) => !open)}>
          {expanded ? "收起" : `还有 ${hiddenCount} 条`}
        </button>
      ) : null}
    </>
  );
}

export function ResultCards({
  tools,
  text,
  onOpenProject,
}: {
  tools: ToolStep[];
  text: string;
  onOpenProject: (id: string) => void;
}) {
  const projects = selectProjectCards(tools, stripThinkingTags(text));
  const details = tools
    .map((step) => step.details)
    .filter((item): item is ToolDetails => Boolean(item))
    .filter((item) => item.kind === "download" || item.kind === "contact" || item.kind === "project_missing");
  if (!projects.length && !details.length) return null;
  return (
    <div className="result-stack">
      {projects.map((project) => (
        <button key={project.id} type="button" className="project-card" onClick={() => onOpenProject(project.id)}>
          <span className="project-card-copy">
            <span className="project-card-title">
              <strong>{project.title}</strong>
              {project.period ? <em>{project.period}</em> : null}
            </span>
            {project.tech_stack.length ? (
              <span className="skill-row">
                {project.tech_stack.map((tech) => (
                  <span key={tech} className="plain-chip">
                    {tech}
                  </span>
                ))}
              </span>
            ) : null}
          </span>
          <span className="detail-link">
            查看详情
            <ArrowRightOutlined />
          </span>
        </button>
      ))}
      {details.map((item, index) => (
        <ResultBlock key={`${item.kind}-${index}`} details={item} />
      ))}
    </div>
  );
}

function ResultBlock({ details }: { details: ToolDetails }) {
  if (details.kind === "download") {
    return (
      <a className="file-card" href={details.url}>
        <span className="file-card-copy">
          <strong>{details.filename}</strong>
          <span>PDF</span>
        </span>
        <span className="detail-link">
          下载简历
          <DownloadOutlined />
        </span>
      </a>
    );
  }
  if (details.kind === "contact") {
    return (
      <div className="contact-card">
        <strong>联系方式</strong>
        <ContactList contact={details} />
      </div>
    );
  }
  if (details.kind === "project_missing") {
    return <p className="muted">没有找到这个项目。</p>;
  }
  return null;
}
