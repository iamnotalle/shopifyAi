import type { ActionFunctionArgs } from "react-router";

type AiExplainRequest = {
  alert?: {
    title?: string;
    message?: string;
    severity?: string;
    category?: string;
    evidence?: string;
    action?: string;
    source?: string;
    evidenceItems?: string[];
    attribution?: {
      label?: string;
      confidence?: string;
      reasoning?: string;
      reasonTags?: string[];
    };
  };
};

type AiExplanation = {
  summary: string;
  whyItMatters: string;
  likelyCause: string;
  recommendedActions: string[];
  confidence: "高" | "中" | "低";
  unknowns: string[];
};

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Only POST is supported." }, 405);
  }

  const apiKey =
    process.env.AI_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return json(
      {
        error:
          "AI_API_KEY is missing. Set it on the server before generating AI explanations.",
      },
      500,
    );
  }

  const payload = (await request.json()) as AiExplainRequest;
  const alert = payload.alert;

  if (!alert?.title || !alert?.evidence) {
    return json({ error: "Alert title and evidence are required." }, 400);
  }

  const baseUrl = process.env.AI_BASE_URL || DEFAULT_BASE_URL;
  const model = process.env.AI_MODEL || DEFAULT_MODEL;
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "你是 Shopify 独立站运营分析助手。只根据用户提供的证据解释异常。必须逐字保留 evidenceItems 中的指标和数字，严禁重排数字或把销售额/订单数/客单价/库存改写成未提供的指标。严禁编造购物车放弃率、流量、广告 ROI、结账速度、客户反馈、退货率、客服原因或供应商状态。未提供的数据只能放进 unknowns，不能当作事实。建议动作只能围绕 alert.action 和 unknowns，必须写成“建议检查/确认”。输出严格 JSON。",
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              task: "基于异常证据生成运营解释和下一步建议。",
              factualEvidenceMustCopyExactly: alert.evidenceItems || [
                alert.evidence,
              ],
              existingSuggestedAction: alert.action,
              guardrails: [
                "summary 必须引用 alert/evidence 中出现过的指标。",
                "所有百分比和指标名称必须和 factualEvidenceMustCopyExactly 保持对应，不能重排。",
                "likelyCause 只能基于 attribution 或 evidence，不足时写“证据不足”。",
                "recommendedActions 只能拆解 existingSuggestedAction，或建议补充 unknowns。",
                "不要出现购物车放弃率、广告 ROI、流量下降、页面加载慢、客户反馈、退货率等未提供指标。",
              ],
              outputSchema: {
                summary: "一句话解释异常",
                whyItMatters: "为什么值得运营关注",
                likelyCause: "最可能原因；证据不足时说明不确定",
                recommendedActions: ["运营下一步动作 1", "运营下一步动作 2"],
                confidence: "高/中/低",
                unknowns: ["缺失但会影响判断的信息"],
              },
              alert,
            },
            null,
            2,
          ),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 1200,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    return json(
      {
        error: `AI request failed with ${response.status}.`,
        detail: detail.slice(0, 400),
      },
      502,
    );
  }

  const result = await response.json();
  const content = result?.choices?.[0]?.message?.content;

  if (!content || typeof content !== "string") {
    return json({ error: "AI response did not include text content." }, 502);
  }

  try {
    return json({ explanation: normalizeExplanation(parseJsonObject(content)) });
  } catch {
    return json(
      {
        error: "AI response was not valid JSON.",
        detail: content.slice(0, 400),
      },
      502,
    );
  }
};

export const loader = async () =>
  json({ error: "Use POST to generate an AI explanation." }, 405);

function parseJsonObject(content: string) {
  const fencedJson = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fencedJson || content).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));
  }

  return JSON.parse(candidate);
}

function normalizeExplanation(value: Partial<AiExplanation>): AiExplanation {
  return {
    summary: String(value.summary || "AI 已生成解释，但摘要为空。"),
    whyItMatters: String(value.whyItMatters || "需要运营进一步确认。"),
    likelyCause: String(value.likelyCause || "证据不足，暂不判断具体原因。"),
    recommendedActions: Array.isArray(value.recommendedActions)
      ? value.recommendedActions.slice(0, 4).map(String)
      : ["复核异常证据", "确认是否需要人工处理"],
    confidence:
      value.confidence === "高" || value.confidence === "中"
        ? value.confidence
        : "低",
    unknowns: Array.isArray(value.unknowns)
      ? value.unknowns.slice(0, 4).map(String)
      : ["缺少更多上下文数据"],
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
