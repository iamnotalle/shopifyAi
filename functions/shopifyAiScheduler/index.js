/* global process */

const ENDPOINT =
  process.env.SHOPIFY_AI_ENDPOINT ||
  "https://tt1-d2gfab46g22e748ed.service.tcloudbase.com/shopify-ai-explain";

exports.main = async (event = {}) => {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "runScheduledInspection",
      userId: "cloudbase-scheduler",
      role: "admin",
      triggerName: event.TriggerName || event.triggerName || "dailyShopifyAiInspection",
      triggeredAt: new Date().toISOString(),
    }),
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Scheduled inspection failed with ${response.status}: ${body.slice(0, 300)}`);
  }

  return {
    statusCode: response.status,
    body,
  };
};
