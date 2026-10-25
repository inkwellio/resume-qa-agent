import { CheckCircleFilled, DownloadOutlined, MailOutlined } from "@ant-design/icons";
import { Button, Modal } from "antd";
import { useState } from "react";
import type { Profile } from "../types";

export function Portrait({ src, name, className }: { src: string; name: string; className: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span className={`${className} portrait-fallback`} aria-hidden="true">
        {name.slice(0, 1) || "人"}
      </span>
    );
  }
  return <img className={className} src={src} alt="" onError={() => setBroken(true)} />;
}

export function ContactList({ contact }: { contact: Profile["contact"] }) {
  const rows = [
    ["邮箱", contact.email],
    ["电话", contact.phone],
    ["GitHub", contact.github],
    ["网站", contact.website],
  ].filter((row): row is [string, string] => Boolean(row[1]));
  if (!rows.length) return <p className="muted">简历里没有留下联系方式。</p>;
  return (
    <ul className="contact-list">
      {rows.map(([label, value]) => (
        <li key={label}>
          <span>{label}</span>
          {value.startsWith("http") ? (
            <a href={value} target="_blank" rel="noreferrer">
              {value}
            </a>
          ) : (
            <strong>{value}</strong>
          )}
        </li>
      ))}
    </ul>
  );
}

function useContact(profile: Profile) {
  const [open, setOpen] = useState(false);
  const modal = (
    <Modal
      className="contact-modal"
      title={`联系${profile.name}`}
      open={open}
      footer={null}
      onCancel={() => setOpen(false)}
    >
      <ContactList contact={profile.contact} />
    </Modal>
  );
  return { openContact: () => setOpen(true), modal };
}

export function WelcomeProfile({ profile }: { profile: Profile }) {
  const { openContact, modal } = useContact(profile);
  return (
    <article className="hero-card">
      <div className="hero-main">
        <Portrait className="hero-avatar" src={profile.avatar} name={profile.name} />
        <div className="hero-copy">
          <div className="hero-name-line">
            <h1>{profile.name}</h1>
            {profile.example ? (
              <span className="pill pill-verified">
                <CheckCircleFilled />
                示例数据
              </span>
            ) : null}
          </div>
          <p className="hero-headline">{profile.headline}</p>
          <div className="skill-row">
            {profile.skills.map((skill) => (
              <span key={skill} className="skill-chip">
                {skill}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="hero-actions">
        <Button className="btn-primary-block" type="primary" icon={<DownloadOutlined />} href={profile.resumePdf}>
          下载简历 (PDF)
        </Button>
        <Button className="btn-quiet-block" icon={<MailOutlined />} onClick={openContact}>
          联系我
        </Button>
      </div>
      {modal}
    </article>
  );
}

export function CompactProfile({ profile, narrow }: { profile: Profile; narrow: boolean }) {
  const { openContact, modal } = useContact(profile);
  const initial = profile.name.slice(0, 1);
  return (
    <article className={narrow ? "compact-card compact-card-mobile" : "compact-card"}>
      <div className="compact-main">
        {narrow ? (
          <span className="compact-photo-wrap">
            <Portrait className="compact-photo" src={profile.avatar} name={profile.name} />
            <span className="online-dot" />
          </span>
        ) : (
          <span className="compact-mark">
            {initial}
            <span className="online-dot" />
          </span>
        )}
        <div className="compact-copy">
          <div className="compact-name-line">
            <strong>{profile.name}</strong>
            {profile.example ? <span className="years-pill">示例数据</span> : null}
          </div>
          <p className="compact-headline">{profile.headline}</p>
          <div className={narrow ? "skill-row skill-scroll" : "skill-row"}>
            {profile.skills.map((skill) => (
              <span key={skill} className={narrow ? "skill-chip skill-chip-round" : "skill-chip"}>
                {skill}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className={narrow ? "compact-actions compact-actions-grid" : "compact-actions"}>
        <Button className="btn-soft" icon={<DownloadOutlined />} href={profile.resumePdf}>
          {narrow ? "下载简历" : "下载简历 (PDF)"}
        </Button>
        <Button className="btn-primary-inline" type="primary" icon={<MailOutlined />} onClick={openContact}>
          联系我
        </Button>
      </div>
      {modal}
    </article>
  );
}
