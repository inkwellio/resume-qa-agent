import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

export const DEEPSEEK_PROVIDER_ID = "deepseek";

/**
 * 模型 id 以安装好的 pi-ai 目录为准，不在代码里凭记忆写死一份清单。
 * 默认优先选 reasoning 为 false 的模型，并在其中偏好 id 或名字带 flash 的快速模型。
 * 0.99.1 的 deepseek 目录里两个模型的 reasoning 都是 true，因此会落到 deepseek-flash，
 * Agent 运行时的思考级别保持默认的 off，问答靠检索和工具，不靠长思考。
 */
export function listDeepSeekModels(): readonly Model<Api>[] {
  return getBuiltinModels(DEEPSEEK_PROVIDER_ID);
}

export function selectChatModel(explicitId?: string): Model<Api> {
  const models = listDeepSeekModels();
  if (models.length === 0) {
    throw new Error("pi-ai 的 deepseek 目录是空的");
  }
  const requested = explicitId?.trim();
  if (requested) {
    const found = models.find((model) => model.id === requested);
    if (!found) {
      throw new Error(
        `DEEPSEEK_MODEL=${requested} 不在 deepseek 目录中。可选：${models.map((model) => model.id).join(", ")}`,
      );
    }
    return found;
  }
  const nonReasoning = models.filter((model) => model.reasoning === false);
  const pool = nonReasoning.length > 0 ? nonReasoning : models;
  return pool.find((model) => /flash/i.test(model.id) || /flash/i.test(model.name)) ?? pool[0]!;
}
