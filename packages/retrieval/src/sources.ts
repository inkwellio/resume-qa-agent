import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { chunkEntries } from "./chunk.js";
import { parseMarkdownEntry } from "./markdown.js";
import type { Profile, RawEntry, ResumeChunk } from "./types.js";

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStack(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function readProfileFile(file: string): Profile {
  const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const contact = (data.contact ?? {}) as Record<string, unknown>;
  const name = asText(data.name);
  if (!name) throw new Error("profile.json 缺少 name");
  const headline = asText(data.headline);
  if (!headline) throw new Error("profile.json 缺少 headline");
  return {
    example: data.example === true,
    name,
    headline,
    avatar: asText(data.avatar) || "/media/avatar.svg",
    skills: asStack(data.skills),
    contact: {
      email: asText(contact.email),
      phone: asText(contact.phone),
      github: asText(contact.github),
      website: asText(contact.website),
    },
    resumePdf: asText(data.resumePdf) || "/resume/example.pdf",
    resumePdfFilename: asText(data.resumePdfFilename) || "resume.pdf",
  };
}

function readJsonEntries(file: string): RawEntry[] {
  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (Array.isArray(data)) return data as RawEntry[];
  if (data && typeof data === "object" && Array.isArray((data as { entries?: unknown }).entries)) {
    return (data as { entries: RawEntry[] }).entries;
  }
  return [];
}

function collectFiles(dir: string, into: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "samples") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectFiles(full, into);
    else into.push(full);
  }
}

function readRawEntries(dir: string): RawEntry[] {
  const files: string[] = [];
  collectFiles(dir, files);
  const entries: RawEntry[] = [];
  for (const file of files) {
    if (file.endsWith(".example.md") || file.endsWith("README.md")) continue;
    if (file.endsWith(".md")) {
      entries.push(parseMarkdownEntry(readFileSync(file, "utf8"), file));
    } else if (file.endsWith(".json") && !file.endsWith("profile.json")) {
      entries.push(...readJsonEntries(file));
    }
  }
  return entries;
}

/** 读取简历目录：profile.json 做档案卡，其余 JSON / Markdown 做片段。 */
export function loadResumeDirectory(dir: string): { profile: Profile; chunks: ResumeChunk[] } {
  const profile = readProfileFile(join(dir, "profile.json"));
  const chunks = chunkEntries(readRawEntries(dir));
  if (chunks.length === 0) {
    throw new Error(`${dir} 里没有简历条目。请添加 JSON 或 Markdown。`);
  }
  return { profile, chunks };
}

export function loadProfile(dir: string): Profile {
  return readProfileFile(join(dir, "profile.json"));
}
