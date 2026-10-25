import { fileURLToPath } from "node:url";

/** resume-agent 仓库根目录。src 和 dist 的相对层级一致。 */
export const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
