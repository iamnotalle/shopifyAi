/* global process */

const http = require("http");

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";
const PORT = Number(process.env.PORT || 9000);

async function handlePayload(payload) {
  const apiKey =
    process.env.AI_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return {
      statusCode: 500,
      body: { error: "AI key is not configured on the server." },
    };
  }

  if (payload.inspection) {
    return summarizeInspection(apiKey, payload.inspection);
  }

  if (payload.alert) {
    return explainAlert(apiKey, payload.alert);
  }

  return {
    statusCode: 400,
    body: { error: "Either alert or inspection is required." },
  };
}

async function explainAlert(apiKey, alert) {
  if (!alert.title || !alert.evidence) {
    return {
      statusCode: 400,
      body: { error: "Alert title and evidence are required." },
    };
  }

  const value = await requestJsonFromModel(apiKey, {
    maxTokens: 900,
    messages: [
      {
        role: "system",
        content:
          "你是 Shopify 独立站运营分析助手。只基于用户给出的异常证据解释，不编造流量、广告、客户反馈或退货原因。输出严格 JSON。",
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: "为公开 Demo 中的运营异常生成中文解释和下一步动作。",
            alert,
            outputSchema: {
              summary: "一句话解释异常",
              whyItMatters: "为什么值得关注",
              likelyCause: "最可能原因；不确定就说明证据不足",
              recommendedActions: ["动作1", "动作2", "动作3"],
              confidence: "高/中/低",
              unknowns: ["还缺什么信息"],
            },
          },
          null,
          2,
        ),
      },
    ],
  });

  return {
    statusCode: 200,
    body: { explanation: normalizeExplanation(value, alert) },
  };
}

async function summarizeInspection(apiKey, inspection) {
  if (!inspection.summary || !Array.isArray(inspection.alerts)) {
    return {
      statusCode: 400,
      body: { error: "Inspection summary and alerts are required." },
    };
  }

  const value = await requestJsonFromModel(apiKey, {
    maxTokens: 1200,
    messages: [
      {
        role: "system",
        content:
          "你是 Shopify 独立站 AI 运营巡检助手。你会把规则命中、历史归档、趋势和缺失数据整理成运营日报。只能基于输入证据判断；没有证据时明确说缺失，不要编造广告、流量、客服或物流事实。输出严格 JSON。",
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: "生成自动巡检日报：今日重点、库存风险、订单风险、销售波动、多天趋势、同类异常归档、新旧/恶化判断、置信度和缺失数据。",
            inspection,
            outputSchema: {
              dailySummary: "今日最重要的运营结论，1-2 句话",
              trendJudgement: "多天趋势判断，说明是否持续下滑或恶化",
              archiveNotes: "同类异常归档结论，说明出现次数、重复问题或恶化",
              changeAssessment: "判断哪些是新问题，哪些是旧问题恶化/持续",
              confidence: "高/中/低",
              missingData: ["仍需补充的数据"],
              recommendedActions: ["动作1", "动作2", "动作3"],
              topPriority: "今天最优先处理的异常",
            },
          },
          null,
          2,
        ),
      },
    ],
  });

  return {
    statusCode: 200,
    body: { report: normalizeReport(value, inspection) },
  };
}

async function requestJsonFromModel(apiKey, options) {
  const baseUrl = process.env.AI_BASE_URL || DEFAULT_BASE_URL;
  const model = process.env.AI_MODEL || DEFAULT_MODEL;
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const aiResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: options.messages,
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: options.maxTokens,
    }),
  });

  if (!aiResponse.ok) {
    const detail = await aiResponse.text();
    throw new Error(`AI request failed with ${aiResponse.status}: ${detail.slice(0, 300)}`);
  }

  const result = await aiResponse.json();
  const content = result?.choices?.[0]?.message?.content;
  return parseJson(content || "{}");
}

exports.main = async (event) => {
  const payload = parseBody(event);

  try {
    const result = await handlePayload(payload);
    return cloudResponse(result.statusCode, result.body);
  } catch (error) {
    return cloudResponse(500, {
      error: error instanceof Error ? error.message : "AI request failed.",
    });
  }
};

const server = http.createServer(async (request, response) => {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 405, { error: "Only POST is supported." });
    return;
  }

  try {
    const payload = JSON.parse(await readBody(request));
    const result = await handlePayload(payload);
    writeJson(response, result.statusCode, result.body);
  } catch (error) {
    writeJson(response, 500, {
      error: error instanceof Error ? error.message : "AI request failed.",
    });
  }
});

if (require.main === module) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`shopifyAiExplain listening on ${PORT}`);
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body || "{}"));
    request.on("error", reject);
  });
}

function parseBody(event) {
  if (event.body && typeof event.body === "string") {
    try {
      return JSON.parse(event.body);
    } catch {
      return {};
    }
  }

  if (event.body && typeof event.body === "object") {
    return event.body;
  }

  return event || {};
}

function parseJson(content) {
  const candidate = String(content).trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const text = (fenced || candidate).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start >= 0 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }

  return JSON.parse(text);
}

function normalizeExplanation(value, alert) {
  return {
    summary: String(value.summary || `${alert.title} 已触发异常预警。`),
    whyItMatters: String(value.whyItMatters || "该异常会影响运营判断，需要优先复核。"),
    likelyCause: String(value.likelyCause || "现有证据不足以判断唯一原因。"),
    recommendedActions: Array.isArray(value.recommendedActions)
      ? value.recommendedActions.slice(0, 4).map(String)
      : [String(alert.action || "复核异常证据并确认处理优先级。")],
    confidence: ["高", "中", "低"].includes(value.confidence) ? value.confidence : "中",
    unknowns: Array.isArray(value.unknowns)
      ? value.unknowns.slice(0, 4).map(String)
      : ["缺少更多上下文数据。"],
  };
}

function normalizeReport(value, inspection) {
  const topAlert = [...(inspection.alerts || [])].sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  const fallbackActions = unique((inspection.alerts || []).map((alert) => alert.action)).slice(0, 4);

  return {
    dailySummary: String(
      value.dailySummary ||
        `本次巡检命中 ${inspection.summary.alertCount || 0} 个异常，需要优先处理 ${topAlert?.title || "最高风险项"}。`,
    ),
    trendJudgement: String(value.trendJudgement || inspection.trend?.judgement || "趋势证据不足，需要继续观察。"),
    archiveNotes: String(value.archiveNotes || "同类异常已归档，可继续观察重复出现次数。"),
    changeAssessment: String(
      value.changeAssessment ||
        `${inspection.summary.newCount || 0} 个新问题，${inspection.summary.worseCount || 0} 个旧问题恶化。`,
    ),
    confidence: ["高", "中", "低"].includes(value.confidence) ? value.confidence : inspection.summary.confidence || "中",
    missingData: Array.isArray(value.missingData)
      ? value.missingData.slice(0, 6).map(String)
      : (inspection.missingData || []).slice(0, 6).map(String),
    recommendedActions: Array.isArray(value.recommendedActions)
      ? value.recommendedActions.slice(0, 5).map(String)
      : fallbackActions,
    topPriority: String(value.topPriority || topAlert?.title || "继续观察"),
  };
}

function cloudResponse(statusCode, data) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(data),
  };
}

function writeJson(response, statusCode, data) {
  setCorsHeaders(response);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(data));
}

function setCorsHeaders(response) {
  for (const [key, value] of Object.entries(corsHeaders())) {
    response.setHeader(key, value);
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
