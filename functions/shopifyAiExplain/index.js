/* global process */

const http = require("http");
const cloudbase = require("@cloudbase/node-sdk");

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";
const COLLECTIONS = {
  shops: "shopify_ai_shops",
  rules: "shopify_ai_rules",
  inspections: "shopify_ai_inspections",
  alerts: "shopify_ai_alerts",
  reports: "shopify_ai_reports",
};
const DEFAULT_RULES = {
  salesDrop: 35,
  inventoryDays: 5,
  highValueOrder: 450,
  fulfillmentHours: 36,
  refundRate: 12,
};
const PORT = Number(process.env.PORT || 9000);

const cloudApp = cloudbase.init({
  env: process.env.TCB_ENV || process.env.SCF_NAMESPACE || cloudbase.SYMBOL_CURRENT_ENV,
});
const db = cloudApp.database();

async function handlePayload(payload) {
  if (isTimerPayload(payload)) {
    return runScheduledInspections({
      ...payload,
      action: "runScheduledInspection",
      userId: "cloudbase-scheduler",
      role: "admin",
    });
  }

  if (payload.action) {
    return handleStateAction(payload);
  }

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

async function handleStateAction(payload) {
  const action = payload.action || "getState";
  const shopId = normalizeId(payload.shopId || payload.demoId);
  const user = {
    userId: normalizeId(payload.userId || `${shopId}-owner`),
    role: normalizeRole(payload.role || "owner"),
  };

  if (action === "getState") {
    const state = await getState(shopId);
    return {
      statusCode: 200,
      body: {
        demoId: shopId,
        shopId,
        user,
        collections: COLLECTIONS,
        state,
        persisted: Boolean(state),
      },
    };
  }

  if (action === "saveState") {
    const state = sanitizeState(payload.state || {});
    const savedState = await saveState(shopId, state, user);
    return {
      statusCode: 200,
      body: {
        demoId: shopId,
        shopId,
        user,
        collections: COLLECTIONS,
        state: savedState,
        persisted: true,
      },
    };
  }

  if (action === "resetState") {
    await deleteState(shopId);
    return {
      statusCode: 200,
      body: {
        demoId: shopId,
        shopId,
        user,
        collections: COLLECTIONS,
        state: null,
        persisted: false,
      },
    };
  }

  if (action === "runScheduledInspection") {
    return runScheduledInspections({ ...payload, shopId, user });
  }

  if (action === "updateAlertLifecycle") {
    const result = await updateAlertLifecycle(shopId, payload, user);
    return {
      statusCode: 200,
      body: {
        demoId: shopId,
        shopId,
        user,
        collections: COLLECTIONS,
        state: result.state,
        updatedAlert: result.alert,
        persisted: true,
      },
    };
  }

  return {
    statusCode: 400,
    body: { error: "Unsupported action." },
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

async function getState(shopId) {
  await ensureCollections();

  const [shop, rulesDoc, inspections, alerts, reports] = await Promise.all([
    getDocument(COLLECTIONS.shops, shopId),
    getDocument(COLLECTIONS.rules, rulesDocId(shopId)),
    getShopDocuments(COLLECTIONS.inspections, shopId),
    getShopDocuments(COLLECTIONS.alerts, shopId),
    getShopDocuments(COLLECTIONS.reports, shopId),
  ]);

  if (!shop && !rulesDoc && inspections.length === 0) {
    return null;
  }

  const alertsByInspection = groupBy(alerts, "inspectionId");
  const reportsByInspection = groupBy(reports, "inspectionId");
  const inspectionHistory = inspections
    .sort((a, b) => new Date(b.runAt || 0) - new Date(a.runAt || 0))
    .map((inspection) => {
      const inspectionAlerts = (alertsByInspection[inspection.inspectionId] || []).sort((a, b) => a.position - b.position);
      const report = reportsByInspection[inspection.inspectionId]?.[0] || null;

      return {
        id: inspection.inspectionId,
        dayKey: inspection.dayKey,
        runAt: inspection.runAt,
        source: inspection.source,
        summary: inspection.summary || {},
        trend: inspection.trend || {},
        alerts: inspectionAlerts.map(stripSystemFields),
        archive: inspection.archive || [],
        missingData: inspection.missingData || [],
        aiReport: report ? stripSystemFields(report.report || report) : null,
      };
    });

  return {
    shop: shop ? stripSystemFields(shop) : null,
    rules: rulesDoc?.rules || null,
    inspectionHistory,
    updatedAt: maxDate([shop?.updatedAt, rulesDoc?.updatedAt, ...inspections.map((item) => item.updatedAt)]),
    version: 2,
  };
}

async function saveState(shopId, state, user) {
  await ensureCollections();

  const now = new Date().toISOString();
  const shop = {
    shopId,
    shopDomain: `${shopId}.demo.myshopify.com`,
    platform: "shopify",
    status: "demo",
    plan: "public-demo",
    installedByUserId: user.userId,
    installedByRole: user.role,
    permissions: ["rules:write", "inspections:write", "alerts:read", "ai_reports:read"],
    updatedAt: now,
    version: 2,
  };
  const rulesDoc = {
    shopId,
    ruleSetId: "default",
    rules: state.rules,
    updatedByUserId: user.userId,
    updatedByRole: user.role,
    updatedAt: now,
    version: 2,
  };

  await Promise.all([
    db.collection(COLLECTIONS.shops).doc(shopId).set(shop),
    db.collection(COLLECTIONS.rules).doc(rulesDocId(shopId)).set(rulesDoc),
    removeShopDocuments(COLLECTIONS.inspections, shopId),
    removeShopDocuments(COLLECTIONS.alerts, shopId),
    removeShopDocuments(COLLECTIONS.reports, shopId),
  ]);

  for (const [index, inspection] of state.inspectionHistory.entries()) {
    await saveInspectionTree(shopId, inspection, index, user, now);
  }

  return getState(shopId);
}

async function runScheduledInspections(payload) {
  await ensureCollections();

  const user = payload.user || {
    userId: normalizeId(payload.userId || "cloudbase-scheduler"),
    role: normalizeRole(payload.role || "admin"),
  };
  const targetShopId = payload.shopId && normalizeId(payload.shopId);
  const shops = targetShopId ? [{ shopId: targetShopId }] : await getSchedulableShops();
  const targets = shops.length ? shops : [{ shopId: "public-demo" }];
  const results = [];

  for (const shop of targets) {
    const shopId = normalizeId(shop.shopId);
    const state = await getState(shopId);
    const rules = { ...DEFAULT_RULES, ...(state?.rules || {}) };
    const inspection = buildScheduledInspection(shopId, rules, state?.inspectionHistory || []);
    await ensureShopAndRules(shopId, rules, user, "scheduled");
    await saveInspectionTree(shopId, inspection, 0, user, new Date().toISOString());
    results.push({
      shopId,
      inspectionId: inspection.id,
      alertCount: inspection.alerts.length,
      topPriority: inspection.aiReport.topPriority,
    });
  }

  const state = targetShopId ? await getState(targetShopId) : null;

  return {
    statusCode: 200,
    body: {
      scheduled: true,
      ranAt: new Date().toISOString(),
      results,
      state,
    },
  };
}

async function updateAlertLifecycle(shopId, payload, user) {
  await ensureCollections();

  const status = normalizeAlertStatus(payload.status || payload.lifecycle?.status);
  const note = asText(payload.note || payload.lifecycle?.note || "", 500);
  const inspectionId = normalizeDocId(payload.inspectionId || "");
  const alertId = payload.alertId ? normalizeDocId(payload.alertId) : "";
  const alertTitle = payload.title || payload.alertTitle || "";
  const alerts = await getShopDocuments(COLLECTIONS.alerts, shopId);
  const alert = alerts.find(
    (item) =>
      (!inspectionId || item.inspectionId === inspectionId) &&
      (!alertId || item.alertId === alertId || normalizeDocId(item.id || "") === alertId) &&
      (!alertTitle || item.title === alertTitle),
  );

  if (!alert) {
    return {
      alert: null,
      state: await getState(shopId),
    };
  }

  const now = new Date().toISOString();
  const nextNotes = Array.isArray(alert.lifecycleNotes) ? [...alert.lifecycleNotes] : [];

  if (note) {
    nextNotes.push({
      note,
      userId: user.userId,
      role: user.role,
      at: now,
    });
  }

  const nextAlert = {
    ...alert,
    lifecycleStatus: status,
    ownerUserId: payload.ownerUserId ? normalizeId(payload.ownerUserId) : alert.ownerUserId || user.userId,
    ownerRole: normalizeRole(payload.ownerRole || alert.ownerRole || user.role),
    lifecycleUpdatedAt: now,
    lifecycleUpdatedBy: user.userId,
    lifecycleNotes: nextNotes.slice(-12),
    acknowledgedAt: status === "acknowledged" ? alert.acknowledgedAt || now : alert.acknowledgedAt || null,
    inProgressAt: status === "in_progress" ? alert.inProgressAt || now : alert.inProgressAt || null,
    resolvedAt: status === "resolved" ? now : alert.resolvedAt || null,
    ignoredAt: status === "ignored" ? now : alert.ignoredAt || null,
  };
  const { _id, ...document } = nextAlert;
  await db.collection(COLLECTIONS.alerts).doc(_id).set(document);

  return {
    alert: stripSystemFields(nextAlert),
    state: await getState(shopId),
  };
}

async function getSchedulableShops() {
  try {
    const result = await db.collection(COLLECTIONS.shops).limit(100).get();
    return Array.isArray(result?.data) ? result.data : [];
  } catch {
    return [];
  }
}

async function ensureShopAndRules(shopId, rules, user, source) {
  const now = new Date().toISOString();
  const existingShop = await getDocument(COLLECTIONS.shops, shopId);
  const existingRules = await getDocument(COLLECTIONS.rules, rulesDocId(shopId));

  if (!existingShop) {
    await db.collection(COLLECTIONS.shops).doc(shopId).set({
      shopId,
      shopDomain: `${shopId}.demo.myshopify.com`,
      platform: "shopify",
      status: "demo",
      plan: "public-demo",
      installedByUserId: user.userId,
      installedByRole: user.role,
      permissions: ["rules:write", "inspections:write", "alerts:read", "ai_reports:read"],
      createdBy: source,
      updatedAt: now,
      version: 2,
    });
  }

  if (!existingRules) {
    await db.collection(COLLECTIONS.rules).doc(rulesDocId(shopId)).set({
      shopId,
      ruleSetId: "default",
      rules,
      updatedByUserId: user.userId,
      updatedByRole: user.role,
      updatedAt: now,
      version: 2,
    });
  }
}

function buildScheduledInspection(shopId, rules, history) {
  const now = new Date();
  const currentRevenue = 955;
  const previousRevenue = 2730;
  const currentOrders = 12;
  const previousOrders = 26;
  const revenueChange = pctNumber(currentRevenue, previousRevenue);
  const orderChange = pctNumber(currentOrders, previousOrders);
  const alerts = [
    makeScheduledAlert({
      title: "销售额大幅下滑",
      severity: "critical",
      evidence: `销售额变化 ${revenueChange.toFixed(0)}%，订单量变化 ${orderChange.toFixed(0)}%。`,
      action: "检查投放、结账链路、主推商品库存和活动节奏。",
      score: 91,
      history,
    }),
    makeScheduledAlert({
      title: "库存风险",
      severity: "info",
      evidence: `Ulike Air 10 IPL 库存 3，ReGlow Bundle 库存 0，低于规则阈值 ${rules.inventoryDays}。`,
      action: "优先给仍有销量的低库存商品补货或暂停投放。",
      score: 74,
      history,
    }),
    makeScheduledAlert({
      title: "高金额订单履约超时",
      severity: "warning",
      evidence: `1 笔订单超过 ${rules.fulfillmentHours} 小时仍未履约，金额高于 ${rules.highValueOrder} 美元。`,
      action: "确认仓库、物流和三方履约应用状态。",
      score: 70,
      history,
    }),
  ];
  const summary = summarizeScheduledAlerts(alerts);
  const inspectionId = `scheduled-${dateKey(now)}-${Date.now()}`;

  return {
    id: inspectionId,
    dayKey: dateKey(now),
    runAt: now.toISOString(),
    source: "scheduled",
    summary: {
      ...summary,
      revenue: currentRevenue,
      previousRevenue,
      orders: currentOrders,
      previousOrders,
      revenueChange,
      orderChange,
      aovChange: -22,
    },
    trend: {
      judgement: "定时巡检发现销售额和订单量同时走弱，且库存风险仍在持续。",
      revenueChange,
      orderChange,
      aovChange: -22,
      last3VsPrev3: -28,
    },
    alerts,
    archive: alerts.map((alert) => ({
      title: alert.title,
      occurrences: countHistoricalAlerts(history, alert.title) + 1,
      currentScore: alert.score,
      previousScore: alert.previousScore,
      changeType: alert.changeType,
      confidence: alert.confidence,
    })),
    missingData: unique(alerts.flatMap((alert) => alert.missingData)).slice(0, 8),
    aiReport: {
      dailySummary: `${shopId} 定时巡检命中 ${alerts.length} 个异常，最高优先级是销售额大幅下滑。`,
      trendJudgement: "销售额和订单量共振下滑，库存缺口可能继续限制后续转化。",
      archiveNotes: "同类异常已按标题归档，用于判断新问题、持续问题和恶化问题。",
      changeAssessment: `${summary.newCount} 个新问题，${summary.worseCount} 个旧问题恶化，${summary.persistentCount} 个旧问题持续。`,
      confidence: summary.confidence,
      missingData: unique(alerts.flatMap((alert) => alert.missingData)).slice(0, 6),
      recommendedActions: unique(alerts.map((alert) => alert.action)).slice(0, 5),
      topPriority: "销售额大幅下滑",
    },
  };
}

function makeScheduledAlert({ title, severity, evidence, action, score, history }) {
  const previous = findHistoricalAlert(history, title);
  const changeType = previous
    ? score >= (previous.score || 0) + 8
      ? "旧问题恶化"
      : "旧问题持续"
    : "新问题";

  return {
    id: normalizeDocId(title),
    title,
    severity,
    message: evidence,
    evidence,
    action,
    score,
    previousScore: previous?.score ?? null,
    changeType,
    confidence: score >= 75 ? "高" : "中",
    confidenceScore: score,
    missingData: missingDataForScheduledAlert(title),
    lifecycleStatus: "open",
    ownerUserId: null,
    ownerRole: null,
    openedAt: new Date().toISOString(),
    lifecycleNotes: [],
  };
}

function summarizeScheduledAlerts(alerts) {
  const confidenceScore = average(alerts.map((alert) => alert.confidenceScore || 45));

  return {
    alertCount: alerts.length,
    criticalCount: alerts.filter((alert) => alert.severity === "critical").length,
    warningCount: alerts.filter((alert) => alert.severity === "warning").length,
    newCount: alerts.filter((alert) => alert.changeType === "新问题").length,
    worseCount: alerts.filter((alert) => alert.changeType === "旧问题恶化").length,
    persistentCount: alerts.filter((alert) => alert.changeType === "旧问题持续").length,
    confidence: confidenceFromScore(confidenceScore),
    confidenceScore,
  };
}

function findHistoricalAlert(history, title) {
  return (history || [])
    .flatMap((inspection) => (inspection.alerts || []).map((alert) => ({ ...alert, runAt: inspection.runAt })))
    .filter((alert) => alert.title === title)
    .sort((a, b) => new Date(b.runAt || 0) - new Date(a.runAt || 0))[0];
}

function countHistoricalAlerts(history, title) {
  return (history || []).reduce(
    (count, inspection) => count + (inspection.alerts || []).filter((alert) => alert.title === title).length,
    0,
  );
}

function missingDataForScheduledAlert(title) {
  if (title.includes("销售")) {
    return ["广告花费与点击", "渠道流量", "结账转化率", "活动日历"];
  }

  if (title.includes("库存")) {
    return ["近 7 日 SKU 销量", "补货 ETA", "供应商可用库存"];
  }

  if (title.includes("履约")) {
    return ["仓库处理时长", "物流商状态", "三方履约应用日志"];
  }

  return ["真实 Shopify 明细", "运营备注"];
}

async function saveInspectionTree(shopId, inspection, index, user, now) {
  const inspectionId = normalizeDocId(inspection.id || `inspection-${index}`);
  const inspectionDocId = scopedDocId(shopId, inspectionId);
  const report = inspection.aiReport || null;
  const alerts = Array.isArray(inspection.alerts) ? inspection.alerts : [];

  await db.collection(COLLECTIONS.inspections).doc(inspectionDocId).set({
    shopId,
    inspectionId,
    dayKey: inspection.dayKey,
    runAt: inspection.runAt,
    source: inspection.source,
    summary: inspection.summary || {},
    trend: inspection.trend || {},
    archive: inspection.archive || [],
    missingData: inspection.missingData || [],
    createdByUserId: user.userId,
    createdByRole: user.role,
    updatedAt: now,
    version: 2,
  });

  await Promise.all(
    alerts.map((alert, alertIndex) => {
      const lifecycleStatus = normalizeAlertStatus(alert.lifecycleStatus || "open");

      return db.collection(COLLECTIONS.alerts).doc(alertDocId(shopId, inspectionId, alertIndex, alert.title)).set({
        ...alert,
        shopId,
        inspectionId,
        alertId: normalizeDocId(alert.id || alert.title || `alert-${alertIndex}`),
        position: alertIndex,
        lifecycleStatus,
        ownerUserId: alert.ownerUserId || null,
        ownerRole: alert.ownerRole || null,
        openedAt: alert.openedAt || now,
        acknowledgedAt: alert.acknowledgedAt || null,
        inProgressAt: alert.inProgressAt || null,
        resolvedAt: lifecycleStatus === "resolved" ? alert.resolvedAt || now : alert.resolvedAt || null,
        ignoredAt: lifecycleStatus === "ignored" ? alert.ignoredAt || now : alert.ignoredAt || null,
        lifecycleUpdatedAt: alert.lifecycleUpdatedAt || now,
        lifecycleUpdatedBy: alert.lifecycleUpdatedBy || user.userId,
        lifecycleNotes: Array.isArray(alert.lifecycleNotes) ? alert.lifecycleNotes.slice(-12) : [],
        updatedAt: now,
        version: 2,
      });
    }),
  );

  if (report) {
    await db.collection(COLLECTIONS.reports).doc(reportDocId(shopId, inspectionId)).set({
      shopId,
      inspectionId,
      report,
      generatedBy: "ai",
      updatedAt: now,
      version: 2,
    });
  }
}

async function deleteState(shopId) {
  await ensureCollections();

  await Promise.all([
    removeShopDocuments(COLLECTIONS.inspections, shopId),
    removeShopDocuments(COLLECTIONS.alerts, shopId),
    removeShopDocuments(COLLECTIONS.reports, shopId),
    removeDocument(COLLECTIONS.rules, rulesDocId(shopId)),
    removeDocument(COLLECTIONS.shops, shopId),
  ]);
}

async function getDocument(collectionName, docId) {
  try {
    const result = await db.collection(collectionName).doc(docId).get();
    const data = result?.data;

    if (Array.isArray(data)) {
      return data[0] || null;
    }

    return data || null;
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

async function getShopDocuments(collectionName, shopId) {
  const result = await db.collection(collectionName).where({ shopId }).limit(100).get();
  const data = result?.data;
  return Array.isArray(data) ? data : [];
}

async function removeShopDocuments(collectionName, shopId) {
  const docs = await getShopDocuments(collectionName, shopId);

  await Promise.all(docs.map((doc) => removeDocument(collectionName, doc._id)));
}

async function removeDocument(collectionName, docId) {
  if (!docId) return;

  try {
    await db.collection(collectionName).doc(docId).remove();
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

async function ensureCollections() {
  await Promise.all(Object.values(COLLECTIONS).map(ensureCollection));
}

async function ensureCollection(collectionName) {
  try {
    await db.createCollection(collectionName);
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
  }
}

function sanitizeState(state) {
  return {
    rules: sanitizeRules(state.rules || {}),
    inspectionHistory: Array.isArray(state.inspectionHistory)
      ? state.inspectionHistory.slice(0, 20).map(sanitizeInspection)
      : [],
  };
}

function sanitizeRules(rules) {
  return {
    salesDrop: clampNumber(rules.salesDrop, 10, 80, 35),
    inventoryDays: clampNumber(rules.inventoryDays, 1, 30, 5),
    highValueOrder: clampNumber(rules.highValueOrder, 50, 1000, 450),
    fulfillmentHours: clampNumber(rules.fulfillmentHours, 6, 96, 36),
    refundRate: clampNumber(rules.refundRate, 2, 40, 12),
  };
}

function sanitizeInspection(item) {
  return {
    id: asText(item.id, 80),
    dayKey: asText(item.dayKey, 16),
    runAt: asText(item.runAt, 40),
    source: asText(item.source, 32),
    summary: item.summary || {},
    trend: item.trend || {},
    alerts: Array.isArray(item.alerts) ? item.alerts.slice(0, 12) : [],
    archive: Array.isArray(item.archive) ? item.archive.slice(0, 12) : [],
    missingData: Array.isArray(item.missingData) ? item.missingData.slice(0, 12).map(String) : [],
    aiReport: item.aiReport || null,
  };
}

function normalizeId(value) {
  const text = String(value || "").toLowerCase();

  if (!text) {
    return "public-demo";
  }

  const normalized = text
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || `id-${hashText(text)}`;
}

function normalizeRole(value) {
  const role = String(value || "owner").toLowerCase();
  return ["owner", "admin", "analyst", "viewer"].includes(role) ? role : "viewer";
}

function normalizeDocId(value) {
  return normalizeId(value).slice(0, 64);
}

function normalizeAlertStatus(value) {
  const status = String(value || "open").toLowerCase();
  return ["open", "acknowledged", "in_progress", "resolved", "ignored"].includes(status) ? status : "open";
}

function scopedDocId(shopId, id) {
  return `${normalizeDocId(shopId)}_${normalizeDocId(id)}`.slice(0, 120);
}

function rulesDocId(shopId) {
  return scopedDocId(shopId, "rules-default");
}

function alertDocId(shopId, inspectionId, index, title) {
  return scopedDocId(shopId, `${inspectionId}_alert_${index}_${title || "untitled"}`);
}

function reportDocId(shopId, inspectionId) {
  return scopedDocId(shopId, `${inspectionId}_ai-report`);
}

function groupBy(items, key) {
  return items.reduce((accumulator, item) => {
    const groupKey = item[key];

    if (!groupKey) {
      return accumulator;
    }

    accumulator[groupKey] ||= [];
    accumulator[groupKey].push(item);
    return accumulator;
  }, {});
}

function stripSystemFields(value) {
  if (!value || typeof value !== "object") {
    return value;
  }

  const hiddenFields = new Set([
    "_id",
    "shopId",
    "inspectionId",
    "alertId",
    "ruleSetId",
    "position",
    "version",
    "updatedAt",
    "createdByUserId",
    "createdByRole",
    "updatedByUserId",
    "updatedByRole",
    "generatedBy",
  ]);

  return Object.fromEntries(Object.entries(value).filter(([key]) => !hiddenFields.has(key)));
}

function maxDate(values) {
  const timestamps = values
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));

  if (!timestamps.length) {
    return null;
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

function isTimerPayload(payload) {
  return Boolean(payload?.TriggerName || payload?.triggerName || payload?.Type === "timer" || payload?.Time);
}

function pctNumber(current, previous) {
  if (!previous) return 0;
  return ((current - previous) / previous) * 100;
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function average(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function confidenceFromScore(score) {
  if (score >= 75) return "高";
  if (score >= 55) return "中";
  return "低";
}

function hashText(value) {
  let hash = 0;
  const text = String(value || "");

  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }

  return hash.toString(36);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

function asText(value, maxLength) {
  return String(value || "").slice(0, maxLength);
}

function isAlreadyExistsError(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  return text.includes("already") || text.includes("exist") || text.includes("collection existed");
}

function isNotFoundError(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  return text.includes("not found") || text.includes("not exist") || text.includes("does not exist");
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
