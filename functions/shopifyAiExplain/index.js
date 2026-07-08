/* global process */

const http = require("http");

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";
const PORT = Number(process.env.PORT || 9000);

async function explain(payload) {
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

  const alert = payload.alert || {};

  if (!alert.title || !alert.evidence) {
    return {
      statusCode: 400,
      body: { error: "Alert title and evidence are required." },
    };
  }

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
                likelyCause: "最可能原因，不确定就说明证据不足",
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
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 900,
    }),
  });

  if (!aiResponse.ok) {
    const detail = await aiResponse.text();

    return {
      statusCode: 502,
      body: {
        error: `AI request failed with ${aiResponse.status}.`,
        detail: detail.slice(0, 300),
      },
    };
  }

  const result = await aiResponse.json();
  const content = result?.choices?.[0]?.message?.content;
  const explanation = normalizeExplanation(parseJson(content || "{}"), alert);

  return { statusCode: 200, body: { explanation } };
}

exports.main = async (event) => {
  const payload = parseBody(event);
  const result = await explain(payload);

  return cloudResponse(result.statusCode, result.body);
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
    const result = await explain(payload);
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
    whyItMatters: String(
      value.whyItMatters || "该异常会影响运营判断，需要优先复核。",
    ),
    likelyCause: String(value.likelyCause || "现有证据不足以判断唯一原因。"),
    recommendedActions: Array.isArray(value.recommendedActions)
      ? value.recommendedActions.slice(0, 4).map(String)
      : [String(alert.action || "复核异常证据并确认处理优先级。")],
    confidence: ["高", "中", "低"].includes(value.confidence)
      ? value.confidence
      : "中",
    unknowns: Array.isArray(value.unknowns)
      ? value.unknowns.slice(0, 4).map(String)
      : ["缺少更多上下文数据。"],
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
