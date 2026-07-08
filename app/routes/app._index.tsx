import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useMemo, useState } from "react";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import styles from "../styles/analytics.module.css";

const RANGE_OPTIONS = [7, 30, 60] as const;
type RangeDays = (typeof RANGE_OPTIONS)[number];

type OpsRuleValues = {
  salesDrop: number;
  inventoryDays: number;
  highValueOrder: number;
  fulfillmentHours: number;
  refundRate: number;
};

const RULE_PROFILE_KEY = "demo";
const DEFAULT_OPS_RULE_VALUES: OpsRuleValues = {
  salesDrop: 30,
  inventoryDays: 7,
  highValueOrder: 300,
  fulfillmentHours: 24,
  refundRate: 10,
};

type Money = {
  amount: string;
  currencyCode: string;
};

type MoneyBag = {
  shopMoney: Money;
};

type OrderNode = {
  id: string;
  name: string;
  createdAt: string;
  processedAt: string | null;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  currentTotalPriceSet: MoneyBag;
  lineItems: {
    edges: Array<{
      node: {
        id: string;
        title: string;
        quantity: number;
        discountedTotalSet: MoneyBag;
        product: {
          id: string;
          title: string;
        } | null;
        variant: {
          id: string;
          title: string;
          sku: string | null;
        } | null;
      };
    }>;
  };
};

type ProductNode = {
  id: string;
  title: string;
  status: string;
  totalInventory: number | null;
  vendor: string;
  productType: string;
  updatedAt: string;
  priceRangeV2: {
    minVariantPrice: Money;
    maxVariantPrice: Money;
  };
};

type AnalyticsGraphqlResponse = {
  data?: {
    shop: {
      name: string;
      currencyCode: string;
      ianaTimezone: string;
    };
    orders: {
      edges: Array<{ node: OrderNode }>;
    };
    products: {
      edges: Array<{ node: ProductNode }>;
    };
  };
  errors?: Array<{ message: string }>;
};

type ProductOnlyGraphqlResponse = {
  data?: {
    shop: {
      name: string;
      currencyCode: string;
      ianaTimezone: string;
    };
    products: {
      edges: Array<{ node: ProductNode }>;
    };
  };
  errors?: Array<{ message: string }>;
};

type Metric = {
  label: string;
  value: string;
  detail: string;
  tone: "revenue" | "orders" | "items" | "products";
};

type TopProduct = {
  key: string;
  title: string;
  quantity: number;
  revenue: number;
  currencyCode: string;
};

type RecentOrder = {
  id: string;
  name: string;
  createdAt: string;
  total: number;
  currencyCode: string;
  financialStatus: string;
  fulfillmentStatus: string;
};

type ProductSnapshot = {
  id: string;
  title: string;
  status: string;
  inventory: number | null;
  priceRange: string;
  updatedAt: string;
};

type AlertSeverity = "critical" | "warning" | "info" | "success";
type AlertCategory = "营销" | "店铺运营" | "客户" | "财务";
type AttributionConfidence = "高" | "中" | "低";

type AttributionReason = {
  label: string;
  score: number;
  reasoning: string;
};

type AlertAttribution = {
  label: string;
  confidence: AttributionConfidence;
  score: number;
  reasoning: string;
  evidenceItems: string[];
  reasonTags: string[];
  aiBrief: string;
};

type Alert = {
  id: string;
  severity: Exclude<AlertSeverity, "success">;
  title: string;
  message: string;
  evidence: string;
  evidenceItems?: string[];
  attribution?: AlertAttribution;
  aiBrief?: string;
  action: string;
  category: AlertCategory;
  source: string;
  createdAt: string;
};

type WatchSummary = {
  tone: AlertSeverity;
  label: string;
  headline: string;
  riskScore: number;
  alertCount: number;
  criticalCount: number;
  warningCount: number;
};

type PeriodStats = {
  revenue: number;
  orderCount: number;
  itemCount: number;
  averageOrderValue: number;
};

type TrendSummary = {
  currentWindowLabel: string;
  previousWindowLabel: string;
  current: PeriodStats;
  previous: PeriodStats;
  revenueChangePercent: number | null;
  orderChangePercent: number | null;
  averageOrderValueChangePercent: number | null;
};

type TrendPoint = {
  key: string;
  label: string;
  revenue: number;
  orderCount: number;
};

type InventoryRisk = {
  id: string;
  title: string;
  status: string;
  inventory: number | null;
  risk: "Out of stock" | "Low stock" | "Unknown stock";
  priceRange: string;
};

type ProductMovement = {
  key: string;
  title: string;
  currentRevenue: number;
  previousRevenue: number;
  revenueDelta: number;
  contributionPercent: number;
};

type LoaderData = {
  rangeDays: RangeDays;
  demoMode: boolean;
  shopName: string;
  timezone: string;
  currencyCode: string;
  metrics: Metric[];
  alerts: Alert[];
  watchSummary: WatchSummary;
  trendSummary: TrendSummary;
  dailyTrend: TrendPoint[];
  topProducts: TopProduct[];
  recentOrders: RecentOrder[];
  products: ProductSnapshot[];
  inventoryRisks: InventoryRisk[];
  fetchedOrderCount: number;
  error: string | null;
  rules: OpsRuleValues;
};

type AiExplanation = {
  summary: string;
  whyItMatters: string;
  likelyCause: string;
  recommendedActions: string[];
  confidence: "高" | "中" | "低";
  unknowns: string[];
};

type AiExplanationState = {
  status: "loading" | "success" | "error";
  explanation?: AiExplanation;
  error?: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const rangeDays = normalizeRange(url.searchParams.get("range"));
  const demoMode = url.searchParams.get("demo") === "seeded";
  const sinceDate = getSinceDate(rangeDays);
  const rules = await loadOpsRuleValues();

  if (demoMode) {
    return buildDemoAnalyticsData(rangeDays, rules);
  }

  const { admin } = await authenticate.admin(request);

  try {
    const response = await admin.graphql(
      `#graphql
        query AnalyticsDashboard($orderQuery: String!) {
          shop {
            name
            currencyCode
            ianaTimezone
          }
          orders(
            first: 100
            sortKey: CREATED_AT
            reverse: true
            query: $orderQuery
          ) {
            edges {
              node {
                id
                name
                createdAt
                processedAt
                cancelledAt
                displayFinancialStatus
                displayFulfillmentStatus
                currentTotalPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                lineItems(first: 20) {
                  edges {
                    node {
                      id
                      title
                      quantity
                      discountedTotalSet {
                        shopMoney {
                          amount
                          currencyCode
                        }
                      }
                      product {
                        id
                        title
                      }
                      variant {
                        id
                        title
                        sku
                      }
                    }
                  }
                }
              }
            }
          }
          products(first: 50, sortKey: UPDATED_AT, reverse: true) {
            edges {
              node {
                id
                title
                status
                totalInventory
                vendor
                productType
                updatedAt
                priceRangeV2 {
                  minVariantPrice {
                    amount
                    currencyCode
                  }
                  maxVariantPrice {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }`,
      {
        variables: {
          orderQuery: `created_at:>=${sinceDate}`,
        },
      },
    );

    const responseJson = (await response.json()) as AnalyticsGraphqlResponse;

    if (!responseJson.data || responseJson.errors?.length) {
      return buildEmptyData({
        rangeDays,
        error:
          responseJson.errors?.map((error) => error.message).join(" ") ||
          "Shopify 没有返回可用的分析数据。",
      });
    }

    return buildAnalyticsData(responseJson.data, rangeDays, { rules });
  } catch (error) {
    const accessError = formatAdminApiError(error);

    try {
      const productResponse = await admin.graphql(
        `#graphql
          query ProductOnlyDashboard {
            shop {
              name
              currencyCode
              ianaTimezone
            }
            products(first: 50, sortKey: UPDATED_AT, reverse: true) {
              edges {
                node {
                  id
                  title
                  status
                  totalInventory
                  vendor
                  productType
                  updatedAt
                  priceRangeV2 {
                    minVariantPrice {
                      amount
                      currencyCode
                    }
                    maxVariantPrice {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          }`,
      );
      const productJson =
        (await productResponse.json()) as ProductOnlyGraphqlResponse;

      if (productJson.data && !productJson.errors?.length) {
        return buildAnalyticsData(
          {
            ...productJson.data,
            orders: { edges: [] },
          },
          rangeDays,
          { error: accessError, rules },
        );
      }

      return buildEmptyData({
        rangeDays,
        error:
          productJson.errors?.map((item) => item.message).join(" ") ||
          accessError,
      });
    } catch {
      return buildEmptyData({
        rangeDays,
        error: accessError,
      });
    }
  }
};

function normalizeRange(value: string | null): RangeDays {
  const parsed = Number(value);

  return RANGE_OPTIONS.includes(parsed as RangeDays)
    ? (parsed as RangeDays)
    : 30;
}

function getSinceDate(rangeDays: RangeDays) {
  const date = new Date();
  date.setDate(date.getDate() - rangeDays + 1);

  return date.toISOString().slice(0, 10);
}

async function loadOpsRuleValues(): Promise<OpsRuleValues> {
  try {
    const rows = await prisma.opsRuleSetting.findMany({
      where: { profileKey: RULE_PROFILE_KEY },
    });
    const values = { ...DEFAULT_OPS_RULE_VALUES };

    for (const row of rows) {
      if (isOpsRuleId(row.ruleId)) {
        values[row.ruleId] = row.value;
      }
    }

    return values;
  } catch {
    return DEFAULT_OPS_RULE_VALUES;
  }
}

function isOpsRuleId(ruleId: string): ruleId is keyof OpsRuleValues {
  return ruleId in DEFAULT_OPS_RULE_VALUES;
}

function buildEmptyData({
  rangeDays,
  error,
}: {
  rangeDays: RangeDays;
  error: string;
}): LoaderData {
  const alerts: Alert[] = [
    {
      id: "admin-api-error",
      severity: "critical",
      title: "后台数据接口连接失败",
      message: error,
      evidence: "没有拿到订单或商品分析数据。",
      action: "重新安装应用，或确认应用已获得读取订单和读取商品权限。",
      category: "店铺运营",
      source: "Shopify",
      createdAt: new Date().toISOString(),
    },
  ];

  return {
    rangeDays,
    demoMode: false,
    shopName: "Shopify 店铺",
    timezone: "店铺时区",
    currencyCode: "USD",
    metrics: buildMetrics({
      revenue: 0,
      orders: [],
      itemCount: 0,
      productCount: 0,
      currencyCode: "USD",
      rangeDays,
    }),
    alerts,
    watchSummary: buildWatchSummary(alerts),
    trendSummary: buildTrendSummary([], rangeDays),
    dailyTrend: buildDailyTrend([], rangeDays),
    topProducts: [],
    recentOrders: [],
    products: [],
    inventoryRisks: [],
    fetchedOrderCount: 0,
    error,
    rules: DEFAULT_OPS_RULE_VALUES,
  };
}

function buildDataAccessAlert(message: string): Alert {
  return {
    id: "order-data-access",
    severity: "warning",
    title: "订单数据权限未开",
    message,
    evidence: "当前页已降级为商品和库存数据，销售额、订单、履约和退款指标暂时为空。",
    evidenceItems: [
      "Shopify 已阻止读取 Order object。",
      "商品和库存数据仍可用于验证库存风险。",
      "点击“演示数据”可验证销售额、订单风险和异常归因。",
    ],
    action: "先用演示数据验证功能；真实接店前再完成 Shopify 订单数据权限配置。",
    category: "店铺运营",
    source: "Shopify Admin API",
    createdAt: new Date().toISOString(),
  };
}

function buildAnalyticsData(
  data: NonNullable<AnalyticsGraphqlResponse["data"]>,
  rangeDays: RangeDays,
  options: { error?: string | null; rules?: OpsRuleValues } = {},
): LoaderData {
  const orders = data.orders.edges.map(({ node }) => node);
  const products = data.products.edges.map(({ node }) => node);
  const rules = options.rules || DEFAULT_OPS_RULE_VALUES;
  const currencyCode =
    orders[0]?.currentTotalPriceSet.shopMoney.currencyCode ||
    data.shop.currencyCode;
  const revenue = orders.reduce(
    (total, order) =>
      total + parseMoney(order.currentTotalPriceSet.shopMoney.amount),
    0,
  );
  const itemCount = orders.reduce(
    (total, order) =>
      total +
      order.lineItems.edges.reduce(
        (lineTotal, { node }) => lineTotal + node.quantity,
        0,
      ),
    0,
  );
  const trendSummary = buildTrendSummary(orders, rangeDays);
  const alerts = [
    ...(options.error ? [buildDataAccessAlert(options.error)] : []),
    ...buildAlerts({
      orders,
      products,
      trendSummary,
      rangeDays,
      currencyCode,
      rules,
    }),
  ];

  return {
    rangeDays,
    demoMode: false,
    shopName: data.shop.name,
    timezone: data.shop.ianaTimezone,
    currencyCode,
    metrics: buildMetrics({
      revenue,
      orders,
      itemCount,
      productCount: products.length,
      currencyCode,
      rangeDays,
    }),
    alerts,
    watchSummary: buildWatchSummary(alerts),
    trendSummary,
    dailyTrend: buildDailyTrend(orders, rangeDays),
    topProducts: buildTopProducts(orders).slice(0, 5),
    recentOrders: orders.slice(0, 8).map((order) => ({
      id: order.id,
      name: order.name,
      createdAt: order.processedAt || order.createdAt,
      total: parseMoney(order.currentTotalPriceSet.shopMoney.amount),
      currencyCode: order.currentTotalPriceSet.shopMoney.currencyCode,
      financialStatus: formatStatus(order.displayFinancialStatus),
      fulfillmentStatus: formatStatus(order.displayFulfillmentStatus),
    })),
    products: products.map((product) => ({
      id: product.id,
      title: product.title,
      status: formatStatus(product.status),
      inventory: product.totalInventory,
      priceRange: formatPriceRange(product.priceRangeV2),
      updatedAt: product.updatedAt,
    })),
    inventoryRisks: buildInventoryRisks(products, rules),
    fetchedOrderCount: orders.length,
    error: options.error ?? null,
    rules,
  };
}

function formatAdminApiError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Shopify Admin API 请求失败。";

  if (
    message.includes("Order object") ||
    message.includes("protected-customer-data") ||
    message.includes("Protected Customer Data")
  ) {
    return "当前应用还未开通 Shopify 订单受保护客户数据访问，真实订单和销售额暂时不可读取。你可以先点击“演示数据”验证销售额、订单风险和异常归因逻辑。";
  }

  return message;
}

function buildDemoAnalyticsData(
  rangeDays: RangeDays,
  rules: OpsRuleValues = DEFAULT_OPS_RULE_VALUES,
): LoaderData {
  const currencyCode = "USD";
  const orders = buildDemoOrders();
  const products = buildDemoProducts();
  const revenue = orders.reduce(
    (total, order) =>
      total + parseMoney(order.currentTotalPriceSet.shopMoney.amount),
    0,
  );
  const itemCount = orders.reduce(
    (total, order) =>
      total +
      order.lineItems.edges.reduce(
        (lineTotal, { node }) => lineTotal + node.quantity,
        0,
      ),
    0,
  );
  const trendSummary = buildTrendSummary(orders, rangeDays);
  const alerts = buildAlerts({
    orders,
    products,
    trendSummary,
    rangeDays,
    currencyCode,
    rules,
  });

  return {
    rangeDays,
    demoMode: true,
    shopName: "Ulike Dev Demo",
    timezone: "Asia/Shanghai",
    currencyCode,
    metrics: buildMetrics({
      revenue,
      orders,
      itemCount,
      productCount: products.length,
      currencyCode,
      rangeDays,
    }),
    alerts,
    watchSummary: buildWatchSummary(alerts),
    trendSummary,
    dailyTrend: buildDailyTrend(orders, rangeDays),
    topProducts: buildTopProducts(orders).slice(0, 5),
    recentOrders: orders.slice(0, 8).map((order) => ({
      id: order.id,
      name: order.name,
      createdAt: order.processedAt || order.createdAt,
      total: parseMoney(order.currentTotalPriceSet.shopMoney.amount),
      currencyCode: order.currentTotalPriceSet.shopMoney.currencyCode,
      financialStatus: formatStatus(order.displayFinancialStatus),
      fulfillmentStatus: formatStatus(order.displayFulfillmentStatus),
    })),
    products: products.map((product) => ({
      id: product.id,
      title: product.title,
      status: formatStatus(product.status),
      inventory: product.totalInventory,
      priceRange: formatPriceRange(product.priceRangeV2),
      updatedAt: product.updatedAt,
    })),
    inventoryRisks: buildInventoryRisks(products, rules),
    fetchedOrderCount: orders.length,
    error: null,
    rules,
  };
}

function buildDemoOrders(): OrderNode[] {
  const seedOrders = [
    {
      name: "#D1001",
      daysAgo: 9,
      title: "Ulike Air 10 IPL",
      amount: 220,
      fulfillmentStatus: "FULFILLED",
    },
    {
      name: "#D1002",
      daysAgo: 9,
      title: "Ulike Air 10 IPL",
      amount: 180,
      fulfillmentStatus: "FULFILLED",
    },
    {
      name: "#D1003",
      daysAgo: 10,
      title: "Ulike ReGlow Bundle",
      amount: 160,
      fulfillmentStatus: "FULFILLED",
    },
    {
      name: "#D1004",
      daysAgo: 11,
      title: "Ulike Care Accessory Kit",
      amount: 120,
      fulfillmentStatus: "FULFILLED",
    },
    {
      name: "#D1005",
      daysAgo: 1,
      title: "Ulike Mini Accessory",
      amount: 50,
      fulfillmentStatus: "UNFULFILLED",
    },
  ];

  return seedOrders.map((order, index) => {
    const processedAt = getDemoDate(order.daysAgo);

    return {
      id: `gid://shopify/Order/demo-${index + 1}`,
      name: order.name,
      createdAt: processedAt,
      processedAt,
      cancelledAt: null,
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: order.fulfillmentStatus,
      currentTotalPriceSet: {
        shopMoney: {
          amount: order.amount.toFixed(2),
          currencyCode: "USD",
        },
      },
      lineItems: {
        edges: [
          {
            node: {
              id: `gid://shopify/LineItem/demo-${index + 1}`,
              title: order.title,
              quantity: 1,
              discountedTotalSet: {
                shopMoney: {
                  amount: order.amount.toFixed(2),
                  currencyCode: "USD",
                },
              },
              product: {
                id: `gid://shopify/Product/demo-${index + 1}`,
                title: order.title,
              },
              variant: {
                id: `gid://shopify/ProductVariant/demo-${index + 1}`,
                title: "Default",
                sku: `DEMO-${index + 1}`,
              },
            },
          },
        ],
      },
    };
  });
}

function buildDemoProducts(): ProductNode[] {
  const now = new Date().toISOString();
  const products = [
    {
      title: "Ulike Air 10 IPL",
      inventory: 3,
      minPrice: "220.00",
      maxPrice: "220.00",
    },
    {
      title: "Ulike ReGlow Bundle",
      inventory: 0,
      minPrice: "160.00",
      maxPrice: "160.00",
    },
    {
      title: "Ulike Care Accessory Kit",
      inventory: 18,
      minPrice: "120.00",
      maxPrice: "120.00",
    },
    {
      title: "Ulike Mini Accessory",
      inventory: 42,
      minPrice: "50.00",
      maxPrice: "50.00",
    },
  ];

  return products.map((product, index) => ({
    id: `gid://shopify/Product/demo-product-${index + 1}`,
    title: product.title,
    status: "ACTIVE",
    totalInventory: product.inventory,
    vendor: "Ulike",
    productType: "Demo",
    updatedAt: now,
    priceRangeV2: {
      minVariantPrice: {
        amount: product.minPrice,
        currencyCode: "USD",
      },
      maxVariantPrice: {
        amount: product.maxPrice,
        currencyCode: "USD",
      },
    },
  }));
}

function getDemoDate(daysAgo: number) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(10, 0, 0, 0);

  return date.toISOString();
}

function buildMetrics({
  revenue,
  orders,
  itemCount,
  productCount,
  currencyCode,
  rangeDays,
}: {
  revenue: number;
  orders: OrderNode[];
  itemCount: number;
  productCount: number;
  currencyCode: string;
  rangeDays: RangeDays;
}): Metric[] {
  const orderCount = orders.length;
  const averageOrderValue = orderCount === 0 ? 0 : revenue / orderCount;

  return [
    {
      label: "销售额",
      value: formatCurrency(revenue, currencyCode),
      detail: `近 ${rangeDays} 天`,
      tone: "revenue",
    },
    {
      label: "订单数",
      value: orderCount.toLocaleString(),
      detail: `${orders.filter(isPaidOrder).length} 个已付款`,
      tone: "orders",
    },
    {
      label: "客单价",
      value: formatCurrency(averageOrderValue, currencyCode),
      detail: "按已读取订单计算",
      tone: "items",
    },
    {
      label: "扫描商品",
      value: productCount.toLocaleString(),
      detail: `${itemCount.toLocaleString()} 件商品售出`,
      tone: "products",
    },
  ];
}

function buildAlerts({
  orders,
  products,
  trendSummary,
  rangeDays,
  currencyCode,
  rules,
}: {
  orders: OrderNode[];
  products: ProductNode[];
  trendSummary: TrendSummary;
  rangeDays: RangeDays;
  currencyCode: string;
  rules: OpsRuleValues;
}): Alert[] {
  const alerts: Alert[] = [];
  const now = new Date().toISOString();
  const activeProducts = products.filter((product) => product.status === "ACTIVE");
  const outOfStockProducts = activeProducts.filter(
    (product) => product.totalInventory !== null && product.totalInventory <= 0,
  );
  const lowStockProducts = activeProducts.filter(
    (product) =>
      product.totalInventory !== null &&
      product.totalInventory > 0 &&
      product.totalInventory <= rules.inventoryDays,
  );
  const productMovements = buildProductMovements(orders, rangeDays);
  const unpaidOrders = orders.filter((order) => !isPaidOrder(order));
  const refundedOrders = orders.filter((order) =>
    ["REFUNDED", "PARTIALLY_REFUNDED", "VOIDED"].includes(
      order.displayFinancialStatus || "",
    ),
  );
  const staleFulfillmentOrders = orders.filter((order) => {
    const ageHours =
      (Date.now() - new Date(order.createdAt).getTime()) / 1000 / 60 / 60;

    return (
      ageHours >= rules.fulfillmentHours &&
      parseMoney(order.currentTotalPriceSet.shopMoney.amount) >=
        rules.highValueOrder &&
      isOpenFulfillmentStatus(order.displayFulfillmentStatus)
    );
  });

  if (orders.length === 0) {
    alerts.push({
      id: "no-orders",
      severity: "critical",
      title: "未检测到订单",
      message: `近 ${rangeDays} 天没有订单。`,
      evidence: "销售额、客单价、商品排行和订单趋势都为 0。",
      action: "在开发店铺里创建测试订单，或连接有真实订单记录的店铺。",
      category: "营销",
      source: "订单分析",
      createdAt: now,
    });
  }

  if (trendSummary.revenueChangePercent !== null) {
    if (
      trendSummary.previous.revenue >= 1 &&
      trendSummary.revenueChangePercent <= -rules.salesDrop
    ) {
      alerts.push({
        id: "revenue-drop",
        severity: "critical",
        title: "销售额大幅下滑",
        message: `销售额较上一周期变化 ${formatPercent(
          trendSummary.revenueChangePercent,
        )}。`,
        evidence: `${formatCurrency(
          trendSummary.current.revenue,
          currencyCode,
        )}，上一周期为 ${formatCurrency(
          trendSummary.previous.revenue,
          currencyCode,
        )}。`,
        action: "检查流量、结账链路、投放活动状态，以及主推商品库存。",
        category: "财务",
        source: "销售趋势",
        createdAt: now,
      });
    } else if (
      trendSummary.previous.revenue >= 1 &&
      trendSummary.revenueChangePercent >= 150
    ) {
      alerts.push({
        id: "revenue-spike",
        severity: "info",
        title: "销售额异常上涨",
        message: `销售额较上一周期变化 ${formatPercent(
          trendSummary.revenueChangePercent,
        )}。`,
        evidence: `${formatCurrency(
          trendSummary.current.revenue,
          currencyCode,
        )}，上一周期为 ${formatCurrency(
          trendSummary.previous.revenue,
          currencyCode,
        )}。`,
        action: "确认上涨是否来自活动，并检查促销商品库存是否足够。",
        category: "营销",
        source: "销售趋势",
        createdAt: now,
      });
    }
  }

  if (
    trendSummary.previous.orderCount >= 3 &&
    trendSummary.orderChangePercent !== null &&
    trendSummary.orderChangePercent <= -rules.salesDrop
  ) {
    alerts.push({
      id: "order-drop",
      severity: "warning",
      title: "订单量下滑",
      message: `订单量较上一周期变化 ${formatPercent(
        trendSummary.orderChangePercent,
      )}。`,
      evidence: `当前周期 ${trendSummary.current.orderCount} 单，上一周期 ${trendSummary.previous.orderCount} 单。`,
      action: "检查广告花费、站点访问、结账错误和支付通道状态。",
      category: "营销",
      source: "订单分析",
      createdAt: now,
    });
  }

  if (
    trendSummary.current.orderCount >= 3 &&
    trendSummary.previous.orderCount >= 3 &&
    trendSummary.averageOrderValueChangePercent !== null &&
    Math.abs(trendSummary.averageOrderValueChangePercent) >= 60
  ) {
    alerts.push({
      id: "aov-swing",
      severity: "warning",
      title: "客单价异常波动",
      message: `客单价较上一周期变化 ${formatPercent(
        trendSummary.averageOrderValueChangePercent,
      )}。`,
      evidence: `${formatCurrency(
        trendSummary.current.averageOrderValue,
        currencyCode,
      )}，上一周期为 ${formatCurrency(
        trendSummary.previous.averageOrderValue,
        currencyCode,
      )}。`,
      action: "检查折扣、套装、高客单商品，以及异常小额订单。",
      category: "财务",
      source: "客单价监控",
      createdAt: now,
    });
  }

  if (orders.length >= 5 && unpaidOrders.length / orders.length >= 0.25) {
    alerts.push({
      id: "unpaid-rate",
      severity: "warning",
      title: "未付款订单比例过高",
      message: `${orders.length} 个订单里有 ${unpaidOrders.length} 个未付款。`,
      evidence: `所选周期内 ${Math.round((unpaidOrders.length / orders.length) * 100)}% 订单处于未付款或待付款状态。`,
      action: "检查收款设置、欺诈审核和待付款支付方式。",
      category: "财务",
      source: "付款状态",
      createdAt: now,
    });
  }

  if (
    orders.length >= 5 &&
    refundedOrders.length / orders.length >= rules.refundRate / 100
  ) {
    alerts.push({
      id: "refund-rate",
      severity: "warning",
      title: "退款比例需要关注",
      message: `${orders.length} 个订单里有 ${refundedOrders.length} 个退款或作废。`,
      evidence: `所选周期内 ${Math.round((refundedOrders.length / orders.length) * 100)}% 订单带有退款相关状态。`,
      action: "复盘退款原因、商品质量问题和客服标签。",
      category: "客户",
      source: "退款监控",
      createdAt: now,
    });
  }

  if (staleFulfillmentOrders.length > 0) {
    alerts.push({
      id: "fulfillment-backlog",
      severity: "warning",
      title: "高金额订单发货积压",
      message: `${staleFulfillmentOrders.length} 个订单超过 ${rules.fulfillmentHours} 小时仍未完成发货，且金额达到 ${formatCurrency(rules.highValueOrder, currencyCode)}。`,
      evidence: staleFulfillmentOrders
        .slice(0, 3)
        .map((order) => order.name)
        .join(", "),
      action: "检查仓库队列、发货暂停原因和第三方履约应用。",
      category: "店铺运营",
      source: "履约监控",
      createdAt: now,
    });
  }

  if (outOfStockProducts.length > 0) {
    alerts.push({
      id: "out-of-stock",
      severity: "warning",
      title: "在售商品缺货",
      message: `${outOfStockProducts.length} 个在售商品库存为 0 或负数。`,
      evidence: outOfStockProducts
        .slice(0, 3)
        .map((product) => product.title)
        .join(", "),
      action: "尽快补货，或隐藏暂时无法销售的商品。",
      category: "店铺运营",
      source: "库存监控",
      createdAt: now,
    });
  }

  if (lowStockProducts.length > 0) {
    alerts.push({
      id: "low-stock",
      severity: "info",
      title: "低库存商品",
      message: `${lowStockProducts.length} 个在售商品库存小于等于 ${rules.inventoryDays}。`,
      evidence: lowStockProducts
        .slice(0, 3)
        .map((product) => `${product.title} (${product.totalInventory})`)
        .join(", "),
      action: "优先给近期有销量的商品补货。",
      category: "店铺运营",
      source: "库存监控",
      createdAt: now,
    });
  }

  if (products.length === 0) {
    alerts.push({
      id: "no-products",
      severity: "info",
      title: "未读取到商品",
      message: "商品扫描结果为 0。",
      evidence: "无法评估库存风险和商品排行。",
      action: "确认读取商品权限，以及店铺中是否有可读取商品。",
      category: "店铺运营",
      source: "商品数据",
      createdAt: now,
    });
  }

  return enrichAlerts(alerts, {
    currencyCode,
    inventoryProducts: [...outOfStockProducts, ...lowStockProducts],
    productMovements,
    refundedOrders,
    staleFulfillmentOrders,
    trendSummary,
    unpaidOrders,
  }).sort(
    (a, b) => getSeverityRank(b.severity) - getSeverityRank(a.severity),
  );
}

function enrichAlerts(
  alerts: Alert[],
  context: {
    currencyCode: string;
    inventoryProducts: ProductNode[];
    productMovements: ProductMovement[];
    refundedOrders: OrderNode[];
    staleFulfillmentOrders: OrderNode[];
    trendSummary: TrendSummary;
    unpaidOrders: OrderNode[];
  },
): Alert[] {
  return alerts.map((alert) => {
    const attribution = buildAlertAttribution(alert, context);

    return {
      ...alert,
      attribution,
      evidenceItems: attribution.evidenceItems,
      aiBrief: attribution.aiBrief,
    };
  });
}

function buildAlertAttribution(
  alert: Alert,
  context: {
    currencyCode: string;
    inventoryProducts: ProductNode[];
    productMovements: ProductMovement[];
    refundedOrders: OrderNode[];
    staleFulfillmentOrders: OrderNode[];
    trendSummary: TrendSummary;
    unpaidOrders: OrderNode[];
  },
): AlertAttribution {
  const reasons: AttributionReason[] = [];
  const evidenceItems = buildBaseEvidence(alert, context);
  const topProductDrop = context.productMovements.find(
    (product) => product.revenueDelta < 0 && product.contributionPercent >= 20,
  );

  if (["revenue-drop", "order-drop"].includes(alert.id)) {
    if (
      context.trendSummary.orderChangePercent !== null &&
      context.trendSummary.orderChangePercent <= -20 &&
      (!context.trendSummary.averageOrderValueChangePercent ||
        context.trendSummary.averageOrderValueChangePercent > -20)
    ) {
      reasons.push({
        label: "订单量下降",
        score: 82,
        reasoning: "订单数同步下滑，客单价没有同等幅度下滑，销售压力更偏向订单量问题。",
      });
    }

    if (
      context.trendSummary.averageOrderValueChangePercent !== null &&
      context.trendSummary.averageOrderValueChangePercent <= -20
    ) {
      reasons.push({
        label: "客单价下降",
        score: 74,
        reasoning: "客单价明显低于基线，需要检查折扣、组合购或高价商品销售变化。",
      });
    }

    if (topProductDrop) {
      reasons.push({
        label: "重点商品拖累",
        score: Math.min(88, 50 + Math.round(topProductDrop.contributionPercent)),
        reasoning: `${topProductDrop.title} 贡献了主要跌幅，应该优先排查该商品的库存、价格、活动和页面状态。`,
      });
    }

    if (context.inventoryProducts.length > 0) {
      reasons.push({
        label: "库存压力",
        score: 58,
        reasoning: "存在缺货或低库存商品，可能影响热卖商品继续转化。",
      });
    }
  }

  if (alert.id === "aov-swing") {
    reasons.push({
      label: "客单价波动",
      score: 80,
      reasoning: "订单数有基础量且客单价大幅偏离基线，优先检查折扣、套装和高金额商品结构。",
    });
  }

  if (["out-of-stock", "low-stock"].includes(alert.id)) {
    reasons.push({
      label: "库存风险",
      score: alert.id === "out-of-stock" ? 90 : 70,
      reasoning:
        alert.id === "out-of-stock"
          ? "在售商品已经缺货，可能直接阻断转化。"
          : "在售商品库存接近安全线，需要提前确认补货和投放节奏。",
    });
  }

  if (alert.id === "refund-rate") {
    reasons.push({
      label: "退款/取消风险",
      score: 76,
      reasoning: "退款或作废订单比例偏高，需要结合商品质量、客服标签和履约体验复盘。",
    });
  }

  if (alert.id === "unpaid-rate") {
    reasons.push({
      label: "支付转化风险",
      score: 72,
      reasoning: "未付款订单比例偏高，优先检查支付方式、风控审核和结账链路。",
    });
  }

  if (alert.id === "fulfillment-backlog") {
    reasons.push({
      label: "履约积压",
      score: 78,
      reasoning: "存在超过 48 小时仍未完成履约的订单，可能影响客户体验和退款风险。",
    });
  }

  if (alert.id === "no-orders") {
    reasons.push({
      label: "数据或流量待确认",
      score: 66,
      reasoning: "当前周期没有订单，先确认是否为测试店铺数据不足，再排查活动、流量和结账链路。",
    });
  }

  if (alert.id === "no-products") {
    reasons.push({
      label: "商品数据缺失",
      score: 64,
      reasoning: "没有商品数据时无法判断库存和商品销售结构，优先确认权限和开发店铺测试数据。",
    });
  }

  const sortedReasons =
    reasons.length > 0
      ? reasons.sort((a, b) => b.score - a.score)
      : [
          {
            label: "需要人工确认",
            score: 45,
            reasoning: "当前证据可以证明异常存在，但还需要运营补充活动、广告或业务背景。",
          },
        ];
  const primary = sortedReasons[0];
  const uniqueEvidence = [...new Set(evidenceItems)].slice(0, 5);

  return {
    label: primary.label,
    confidence: getAttributionConfidence(primary.score),
    score: primary.score,
    reasoning: primary.reasoning,
    evidenceItems: uniqueEvidence,
    reasonTags: sortedReasons.slice(0, 3).map((reason) => reason.label),
    aiBrief: buildAiBrief(alert, primary, uniqueEvidence),
  };
}

function buildBaseEvidence(
  alert: Alert,
  context: {
    currencyCode: string;
    inventoryProducts: ProductNode[];
    productMovements: ProductMovement[];
    refundedOrders: OrderNode[];
    staleFulfillmentOrders: OrderNode[];
    trendSummary: TrendSummary;
    unpaidOrders: OrderNode[];
  },
) {
  const evidenceItems = [alert.evidence];
  const { trendSummary } = context;
  const topProductDrop = context.productMovements.find(
    (product) => product.revenueDelta < 0 && product.contributionPercent >= 20,
  );

  if (trendSummary.revenueChangePercent !== null) {
    evidenceItems.push(
      `销售额变化 ${formatPercent(trendSummary.revenueChangePercent)}：当前 ${formatCurrency(
        trendSummary.current.revenue,
        context.currencyCode,
      )}，基线 ${formatCurrency(trendSummary.previous.revenue, context.currencyCode)}`,
    );
  }

  if (trendSummary.orderChangePercent !== null) {
    evidenceItems.push(
      `订单数变化 ${formatPercent(trendSummary.orderChangePercent)}：当前 ${trendSummary.current.orderCount} 单，基线 ${trendSummary.previous.orderCount} 单`,
    );
  }

  if (trendSummary.averageOrderValueChangePercent !== null) {
    evidenceItems.push(
      `客单价变化 ${formatPercent(
        trendSummary.averageOrderValueChangePercent,
      )}：当前 ${formatCurrency(
        trendSummary.current.averageOrderValue,
        context.currencyCode,
      )}`,
    );
  }

  if (topProductDrop) {
    evidenceItems.push(
      `${topProductDrop.title} 销售额减少 ${formatCurrency(
        Math.abs(topProductDrop.revenueDelta),
        context.currencyCode,
      )}，贡献整体跌幅 ${Math.round(topProductDrop.contributionPercent)}%`,
    );
  }

  if (context.inventoryProducts.length > 0) {
    evidenceItems.push(
      `库存风险商品：${context.inventoryProducts
        .slice(0, 3)
        .map((product) => `${product.title} (${product.totalInventory ?? "未知"})`)
        .join("、")}`,
    );
  }

  if (context.unpaidOrders.length > 0 && alert.id === "unpaid-rate") {
    evidenceItems.push(`未付款订单 ${context.unpaidOrders.length} 单`);
  }

  if (context.refundedOrders.length > 0 && alert.id === "refund-rate") {
    evidenceItems.push(`退款或作废订单 ${context.refundedOrders.length} 单`);
  }

  if (
    context.staleFulfillmentOrders.length > 0 &&
    alert.id === "fulfillment-backlog"
  ) {
    evidenceItems.push(
      `超 48 小时未履约订单：${context.staleFulfillmentOrders
        .slice(0, 3)
        .map((order) => order.name)
        .join("、")}`,
    );
  }

  return evidenceItems.filter(Boolean);
}

function buildAiBrief(
  alert: Alert,
  primaryReason: AttributionReason,
  evidenceItems: string[],
) {
  const evidenceText = evidenceItems.slice(0, 3).join("；");

  return `${alert.title} 值得关注：${evidenceText}。当前更偏向「${primaryReason.label}」，建议先按证据链处理；未接入的广告、流量或站外数据不会被当作确定结论。`;
}

function getAttributionConfidence(score: number): AttributionConfidence {
  if (score >= 80) {
    return "高";
  }

  if (score >= 60) {
    return "中";
  }

  return "低";
}

function buildWatchSummary(alerts: Alert[]): WatchSummary {
  const criticalCount = alerts.filter(
    (alert) => alert.severity === "critical",
  ).length;
  const warningCount = alerts.filter(
    (alert) => alert.severity === "warning",
  ).length;
  const infoCount = alerts.filter((alert) => alert.severity === "info").length;
  const riskScore = Math.min(
    100,
    criticalCount * 40 + warningCount * 22 + infoCount * 8,
  );

  if (criticalCount > 0) {
    return {
      tone: "critical",
      label: "严重",
      headline: "需要立即排查",
      riskScore,
      alertCount: alerts.length,
      criticalCount,
      warningCount,
    };
  }

  if (warningCount > 0) {
    return {
      tone: "warning",
      label: "预警",
      headline: "检测到运营风险",
      riskScore,
      alertCount: alerts.length,
      criticalCount,
      warningCount,
    };
  }

  if (infoCount > 0) {
    return {
      tone: "info",
      label: "观察",
      headline: "有轻微异常需要跟踪",
      riskScore,
      alertCount: alerts.length,
      criticalCount,
      warningCount,
    };
  }

  return {
    tone: "success",
    label: "健康",
    headline: "暂无活跃异常",
    riskScore: 0,
    alertCount: 0,
    criticalCount: 0,
    warningCount: 0,
  };
}

function buildTrendSummary(
  orders: OrderNode[],
  rangeDays: RangeDays,
): TrendSummary {
  const { currentOrders, previousOrders, windowDays } = splitComparisonOrders(
    orders,
    rangeDays,
  );
  const current = buildPeriodStats(currentOrders);
  const previous = buildPeriodStats(previousOrders);

  return {
    currentWindowLabel: `近 ${windowDays} 天`,
    previousWindowLabel: `前 ${windowDays} 天`,
    current,
    previous,
    revenueChangePercent: calculatePercentChange(
      current.revenue,
      previous.revenue,
    ),
    orderChangePercent: calculatePercentChange(
      current.orderCount,
      previous.orderCount,
    ),
    averageOrderValueChangePercent: calculatePercentChange(
      current.averageOrderValue,
      previous.averageOrderValue,
    ),
  };
}

function buildPeriodStats(orders: OrderNode[]): PeriodStats {
  const revenue = orders.reduce(
    (total, order) =>
      total + parseMoney(order.currentTotalPriceSet.shopMoney.amount),
    0,
  );
  const itemCount = orders.reduce(
    (total, order) =>
      total +
      order.lineItems.edges.reduce(
        (lineTotal, { node }) => lineTotal + node.quantity,
        0,
      ),
    0,
  );
  const orderCount = orders.length;

  return {
    revenue,
    itemCount,
    orderCount,
    averageOrderValue: orderCount === 0 ? 0 : revenue / orderCount,
  };
}

function buildDailyTrend(orders: OrderNode[], rangeDays: RangeDays): TrendPoint[] {
  const buckets = new Map<string, { revenue: number; orderCount: number }>();

  for (let offset = rangeDays - 1; offset >= 0; offset -= 1) {
    const date = startOfToday();
    date.setDate(date.getDate() - offset);
    buckets.set(getDateKey(date), { revenue: 0, orderCount: 0 });
  }

  for (const order of orders) {
    const key = getDateKey(getOrderAnalysisDate(order));
    const bucket = buckets.get(key);

    if (bucket) {
      bucket.revenue += parseMoney(order.currentTotalPriceSet.shopMoney.amount);
      bucket.orderCount += 1;
    }
  }

  return [...buckets.entries()].map(([key, bucket]) => ({
    key,
    label: formatDateLabel(key),
    revenue: bucket.revenue,
    orderCount: bucket.orderCount,
  }));
}

function buildProductMovements(
  orders: OrderNode[],
  rangeDays: RangeDays,
): ProductMovement[] {
  const { currentOrders, previousOrders } = splitComparisonOrders(
    orders,
    rangeDays,
  );
  const currentProducts = summarizeProductRevenue(currentOrders);
  const previousProducts = summarizeProductRevenue(previousOrders);
  const previousRevenue = buildPeriodStats(previousOrders).revenue;
  const currentRevenue = buildPeriodStats(currentOrders).revenue;
  const totalDrop = Math.max(previousRevenue - currentRevenue, 0);
  const keys = new Set([...currentProducts.keys(), ...previousProducts.keys()]);

  return [...keys]
    .map((key) => {
      const current = currentProducts.get(key);
      const previous = previousProducts.get(key);
      const currentProductRevenue = current?.revenue || 0;
      const previousProductRevenue = previous?.revenue || 0;
      const revenueDelta = currentProductRevenue - previousProductRevenue;

      return {
        key,
        title: current?.title || previous?.title || key,
        currentRevenue: currentProductRevenue,
        previousRevenue: previousProductRevenue,
        revenueDelta,
        contributionPercent:
          totalDrop > 0 && revenueDelta < 0
            ? (Math.abs(revenueDelta) / totalDrop) * 100
            : 0,
      };
    })
    .sort((a, b) => b.contributionPercent - a.contributionPercent);
}

function splitComparisonOrders(orders: OrderNode[], rangeDays: RangeDays) {
  const windowDays = Math.min(7, Math.max(1, Math.floor(rangeDays / 2)));
  const currentStart = startOfToday();
  currentStart.setDate(currentStart.getDate() - windowDays + 1);
  const previousStart = new Date(currentStart);
  previousStart.setDate(previousStart.getDate() - windowDays);
  const currentOrders = orders.filter(
    (order) => getOrderAnalysisDate(order) >= currentStart,
  );
  const previousOrders = orders.filter((order) => {
    const createdAt = getOrderAnalysisDate(order);

    return createdAt >= previousStart && createdAt < currentStart;
  });

  return {
    currentOrders,
    previousOrders,
    windowDays,
  };
}

function summarizeProductRevenue(orders: OrderNode[]) {
  const productMap = new Map<
    string,
    { title: string; revenue: number; quantity: number }
  >();

  for (const order of orders) {
    for (const { node } of order.lineItems.edges) {
      const key = node.product?.id || node.variant?.id || node.title;
      const current = productMap.get(key) || {
        title: node.product?.title || node.title,
        revenue: 0,
        quantity: 0,
      };

      current.revenue += parseMoney(node.discountedTotalSet.shopMoney.amount);
      current.quantity += node.quantity;
      productMap.set(key, current);
    }
  }

  return productMap;
}

function buildInventoryRisks(
  products: ProductNode[],
  rules: OpsRuleValues = DEFAULT_OPS_RULE_VALUES,
): InventoryRisk[] {
  return products
    .filter((product) => product.status === "ACTIVE")
    .filter(
      (product) =>
        product.totalInventory === null ||
        product.totalInventory <= rules.inventoryDays,
    )
    .map((product) => ({
      id: product.id,
      title: product.title,
      status: formatStatus(product.status),
      inventory: product.totalInventory,
      risk: getInventoryRisk(product.totalInventory),
      priceRange: formatPriceRange(product.priceRangeV2),
    }))
    .sort((a, b) => getInventoryRiskRank(a.risk) - getInventoryRiskRank(b.risk));
}

function buildTopProducts(orders: OrderNode[]): TopProduct[] {
  const productMap = new Map<string, TopProduct>();

  for (const order of orders) {
    for (const { node } of order.lineItems.edges) {
      const key = node.product?.id || node.variant?.id || node.title;
      const current = productMap.get(key) || {
        key,
        title: node.product?.title || node.title,
        quantity: 0,
        revenue: 0,
        currencyCode: node.discountedTotalSet.shopMoney.currencyCode,
      };

      current.quantity += node.quantity;
      current.revenue += parseMoney(node.discountedTotalSet.shopMoney.amount);
      productMap.set(key, current);
    }
  }

  return [...productMap.values()].sort((a, b) => {
    if (b.revenue !== a.revenue) {
      return b.revenue - a.revenue;
    }

    return b.quantity - a.quantity;
  });
}

function isPaidOrder(order: OrderNode) {
  return [
    "PAID",
    "PARTIALLY_PAID",
    "PARTIALLY_REFUNDED",
  ].includes(order.displayFinancialStatus || "");
}

function getOrderAnalysisDate(order: OrderNode) {
  return new Date(order.processedAt || order.createdAt);
}

function isOpenFulfillmentStatus(value: string | null) {
  return [
    "UNFULFILLED",
    "PARTIALLY_FULFILLED",
    "IN_PROGRESS",
    "ON_HOLD",
    "SCHEDULED",
    "REQUEST_DECLINED",
  ].includes(value || "");
}

function parseMoney(amount: string) {
  const value = Number(amount);

  return Number.isFinite(value) ? value : 0;
}

function calculatePercentChange(current: number, previous: number) {
  if (previous === 0) {
    return current === 0 ? 0 : null;
  }

  return ((current - previous) / previous) * 100;
}

function getSeverityRank(severity: AlertSeverity) {
  return {
    critical: 3,
    warning: 2,
    info: 1,
    success: 0,
  }[severity];
}

function getInventoryRiskRank(risk: InventoryRisk["risk"]) {
  return {
    "Out of stock": 0,
    "Low stock": 1,
    "Unknown stock": 2,
  }[risk];
}

function getInventoryRisk(inventory: number | null): InventoryRisk["risk"] {
  if (inventory === null) {
    return "Unknown stock";
  }

  return inventory <= 0 ? "Out of stock" : "Low stock";
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);

  return date;
}

function getDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function formatCurrency(amount: number, currencyCode: string) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: currencyCode,
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  }).format(amount);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDateLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatPercent(value: number | null) {
  if (value === null) {
    return "无基线";
  }

  const prefix = value > 0 ? "+" : "";

  return `${prefix}${Math.round(value)}%`;
}

function formatStatus(value: string | null) {
  if (!value) {
    return "未知";
  }

  const statusMap: Record<string, string> = {
    ACTIVE: "在售",
    ARCHIVED: "已归档",
    CANCELLED: "已取消",
    CRITICAL: "严重",
    DRAFT: "草稿",
    EXPIRED: "已过期",
    INFO: "提示",
    IN_PROGRESS: "处理中",
    NEUTRAL: "普通",
    ON_HOLD: "暂停中",
    OPEN: "打开",
    PAID: "已付款",
    PARTIALLY_FULFILLED: "部分发货",
    PARTIALLY_PAID: "部分付款",
    PARTIALLY_REFUNDED: "部分退款",
    PENDING: "待处理",
    REFUNDED: "已退款",
    REQUEST_DECLINED: "请求被拒",
    SCHEDULED: "已计划",
    SUCCESS: "正常",
    UNFULFILLED: "未发货",
    VOIDED: "已作废",
    WARNING: "预警",
  };

  return (
    statusMap[value.toUpperCase()] ||
    value
      .toLowerCase()
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function formatInventoryRisk(risk: InventoryRisk["risk"]) {
  return {
    "Out of stock": "缺货",
    "Low stock": "低库存",
    "Unknown stock": "库存未知",
  }[risk];
}

function formatPriceRange(priceRange: ProductNode["priceRangeV2"]) {
  const min = parseMoney(priceRange.minVariantPrice.amount);
  const max = parseMoney(priceRange.maxVariantPrice.amount);
  const currencyCode = priceRange.minVariantPrice.currencyCode;

  if (min === max) {
    return formatCurrency(min, currencyCode);
  }

  return `${formatCurrency(min, currencyCode)} - ${formatCurrency(
    max,
    currencyCode,
  )}`;
}

function formatSeverity(severity: AlertSeverity) {
  return {
    critical: "严重",
    warning: "预警",
    info: "提示",
    success: "正常",
  }[severity];
}

function getGreeting() {
  const hour = new Date().getHours();

  if (hour < 11) {
    return "早上好";
  }

  if (hour < 18) {
    return "下午好";
  }

  return "晚上好";
}

export default function Index() {
  const {
    rangeDays,
    demoMode,
    shopName,
    timezone,
    currencyCode,
    metrics,
    alerts,
    watchSummary,
    trendSummary,
    dailyTrend,
    topProducts,
    recentOrders,
    products,
    inventoryRisks,
    fetchedOrderCount,
    error,
    rules,
  } = useLoaderData<typeof loader>();
  const [archivedIds, setArchivedIds] = useState<string[]>([]);
  const [aiExplanations, setAiExplanations] = useState<
    Record<string, AiExplanationState>
  >({});
  const activeAlerts = alerts.filter((alert) => !archivedIds.includes(alert.id));
  const archivedAlerts = alerts.filter((alert) => archivedIds.includes(alert.id));
  const maxDailyRevenue = Math.max(
    ...dailyTrend.map((point) => point.revenue),
    1,
  );
  const maxDailyOrders = Math.max(
    ...dailyTrend.map((point) => point.orderCount),
    1,
  );
  const gaugeToneClass = {
    critical: styles.segmentCritical,
    warning: styles.segmentWarning,
    info: styles.segmentInfo,
    success: styles.segmentSuccess,
  }[watchSummary.tone];
  const activeGaugeSegments = Math.max(
    1,
    Math.round((watchSummary.riskScore / 100) * 34),
  );
  const generateAiExplanation = async (alert: Alert) => {
    setAiExplanations((current) => ({
      ...current,
      [alert.id]: { status: "loading" },
    }));

    try {
      const response = await fetch("/api/ai/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alert: {
            title: alert.title,
            message: alert.message,
            severity: alert.severity,
            category: alert.category,
            evidence: alert.evidence,
            evidenceItems: alert.evidenceItems,
            action: alert.action,
            source: alert.source,
            attribution: alert.attribution
              ? {
                  label: alert.attribution.label,
                  confidence: alert.attribution.confidence,
                  reasoning: alert.attribution.reasoning,
                  reasonTags: alert.attribution.reasonTags,
                }
              : null,
          },
        }),
      });
      const payload = await response.json();

      if (!response.ok || payload.error) {
        throw new Error(payload.error || "AI 解释生成失败。");
      }

      setAiExplanations((current) => ({
        ...current,
        [alert.id]: {
          status: "success",
          explanation: payload.explanation,
        },
      }));
    } catch (error) {
      setAiExplanations((current) => ({
        ...current,
        [alert.id]: {
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "AI 解释生成失败，请稍后重试。",
        },
      }));
    }
  };
  const moduleRows = useMemo(
    () => [
      {
        label: "营销",
        title:
          activeAlerts.find((alert) => alert.category === "营销")?.title ||
          "暂无最近对话",
        count: activeAlerts.filter((alert) => alert.category === "营销").length,
      },
      {
        label: "店铺运营",
        title:
          activeAlerts.find((alert) => alert.category === "店铺运营")?.title ||
          "暂无最近对话",
        count: activeAlerts.filter((alert) => alert.category === "店铺运营")
          .length,
      },
      {
        label: "客户",
        title:
          activeAlerts.find((alert) => alert.category === "客户")?.title ||
          "暂无最近对话",
        count: activeAlerts.filter((alert) => alert.category === "客户").length,
      },
      {
        label: "财务",
        title:
          activeAlerts.find((alert) => alert.category === "财务")?.title ||
          "暂无最近对话",
        count: activeAlerts.filter((alert) => alert.category === "财务").length,
      },
    ],
    [activeAlerts],
  );
  const taskRows = [
    {
      title: "经营健康度日报",
      detail: "每天 09:00 扫描订单、销售额、库存和履约状态",
      status: "已启用",
    },
    {
      title: "库存异常巡检",
      detail: "每小时检查缺货、低库存和库存未知商品",
      status: inventoryRisks.length > 0 ? "有风险" : "正常",
    },
    {
      title: "销售波动复盘",
      detail: "每周一对比近 7 天与上一周期表现",
      status: "已启用",
    },
  ];
  const skillRows = [
    {
      title: "库存预警",
      value: inventoryRisks.length,
      detail: "缺货、低库存、库存未知",
    },
    {
      title: "订单趋势",
      value: fetchedOrderCount,
      detail: "订单量、销售额、客单价",
    },
    {
      title: "付款与退款",
      value: activeAlerts.filter((alert) => alert.category === "财务").length,
      detail: "未付款、退款、作废",
    },
    {
      title: "履约积压",
      value: activeAlerts.filter((alert) => alert.id === "fulfillment-backlog")
        .length,
      detail: "超时未发货订单",
    },
  ];

  return (
    <div className={styles.workspaceShell}>
      <aside className={styles.sidebar}>
        <div className={styles.brandRow}>
          <span className={styles.brandMark}>O</span>
          <strong>OpsPilot</strong>
          <button className={styles.iconButton} type="button" aria-label="折叠侧边栏">
            <span>□</span>
          </button>
        </div>

        <div className={styles.workspacePicker}>
          <span className={styles.workspaceAvatar}>SH</span>
          <div>
            <strong>{shopName}</strong>
            <span>Shopify 工作区</span>
          </div>
          <span>⌄</span>
        </div>

        <nav className={styles.navList} aria-label="运营助手导航">
          <a className={styles.navItemActive} href="/app">
            <span>▦</span>
            总览
          </a>
          <a className={styles.navItem} href="/app?view=schedules">
            <span>◷</span>
            定时任务
          </a>
          <a className={styles.navItem} href="/app?view=skills">
            <span>⚡</span>
            技能
          </a>
          <a className={styles.navItem} href="/app/rules">
            <span>◈</span>
            规则配置
          </a>
          <a className={styles.navItem} href="/app/demo">
            <span>◎</span>
            Demo 测试
          </a>
          <a className={styles.navItem} href="/app?demo=seeded">
            <span>◆</span>
            演示数据
          </a>
        </nav>

        <div className={styles.navGroup}>
          <span>运营助手</span>
          {moduleRows.map((row) => (
            <div key={row.label} className={styles.moduleLink}>
              <div>
                <strong>{row.label}</strong>
                <small>{row.title}</small>
              </div>
              {row.count > 0 && <em>{row.count}</em>}
            </div>
          ))}
        </div>

        <div className={styles.profileCard}>
          <span className={styles.profileAvatar}>SU</span>
          <div>
            <strong>support</strong>
            <span>support@ulikeglobal.com</span>
          </div>
        </div>
      </aside>

      <main className={styles.workspaceMain}>
        <header className={styles.heroHeader}>
          <div>
            <h1>{getGreeting()}，support</h1>
            <p>
              {shopName} 的经营信号已经同步到运营助手。
              {demoMode ? "当前正在使用演示订单验证销售额和异常归因。" : ""}
            </p>
            <div className={styles.ruleStatusStrip}>
              <span>销售跌幅 {rules.salesDrop}%</span>
              <span>库存阈值 {rules.inventoryDays}</span>
              <span>高金额 {formatCurrency(rules.highValueOrder, currencyCode)}</span>
              <span>履约 {rules.fulfillmentHours} 小时</span>
              <span>退款率 {rules.refundRate}%</span>
            </div>
          </div>
          <div className={styles.rangeControls}>
            {RANGE_OPTIONS.map((option) => (
              <a
                key={option}
                className={
                  rangeDays === option
                    ? styles.rangeButtonActive
                    : styles.rangeButton
                }
                href={`/app?range=${option}${demoMode ? "&demo=seeded" : ""}`}
              >
                近 {option} 天
              </a>
            ))}
            <a
              className={demoMode ? styles.rangeButtonActive : styles.rangeButton}
              href={demoMode ? "/app" : "/app?demo=seeded"}
            >
              {demoMode ? "真实数据" : "演示数据"}
            </a>
          </div>
        </header>

        {error && (
          <div className={styles.errorPanel}>
            <strong>后台数据接口响应失败。</strong>
            <span>{error}</span>
          </div>
        )}

        <section className={styles.heroGrid}>
          <div className={styles.healthCard}>
            <div className={styles.panelHeader}>
              <div>
                <span>经营健康度</span>
                <strong>{watchSummary.headline}</strong>
              </div>
              <span className={`${styles.statusPill} ${styles[watchSummary.tone]}`}>
                {watchSummary.label}
              </span>
            </div>

            <div className={styles.gaugeWrap} aria-label="经营健康度仪表盘">
              <div className={styles.gauge}>
                {Array.from({ length: 34 }, (_, index) => (
                  <span
                    key={index}
                    className={`${styles.gaugeSegment} ${
                      index < activeGaugeSegments ? gaugeToneClass : ""
                    }`}
                    style={{ transform: `rotate(${220 + index * 3.05}deg)` }}
                  />
                ))}
              </div>
              <div className={styles.gaugeCenter}>
                <span>{watchSummary.riskScore}</span>
                <strong>{watchSummary.label}</strong>
              </div>
            </div>

            <p className={styles.cardNote}>
              已连接 Shopify 数据源，当前读取 {fetchedOrderCount} 个订单、{products.length} 个商品。
            </p>

            <div className={styles.connectionBar}>
              <span className={styles.shopifyDot}>S</span>
              <strong>1 个连接已启用</strong>
              <button className={styles.roundButton} type="button" aria-label="添加连接">
                +
              </button>
            </div>
          </div>

          <div className={styles.priorityPanel}>
            <div className={styles.priorityHeader}>
              <div>
                <strong>优先处理</strong>
                <span>{activeAlerts.length}</span>
              </div>
              <button className={styles.archiveButton} type="button">
                已归档 <em>{archivedAlerts.length}</em>
              </button>
            </div>

            <div className={styles.alertFeed}>
              {activeAlerts.length > 0 ? (
                activeAlerts.map((alert) => {
                  const aiState = aiExplanations[alert.id];

                  return (
                  <article key={alert.id} className={styles.priorityCard}>
                    <div className={styles.cardTopline}>
                      <span className={`${styles.severityBadge} ${styles[alert.severity]}`}>
                        {formatSeverity(alert.severity)}
                      </span>
                      <div className={styles.cardActions}>
                        <button
                          type="button"
                          aria-label="归档事项"
                          onClick={() =>
                            setArchivedIds((ids) =>
                              ids.includes(alert.id) ? ids : [...ids, alert.id],
                            )
                          }
                        >
                          ✓
                        </button>
                        <button
                          type="button"
                          aria-label="生成真实 AI 解释"
                          disabled={aiState?.status === "loading"}
                          onClick={() => generateAiExplanation(alert)}
                        >
                          {aiState?.status === "loading" ? "…" : "AI"}
                        </button>
                      </div>
                    </div>
                    <h2>{alert.title}</h2>
                    <p>{alert.message}</p>
                    <p className={styles.evidenceText}>{alert.evidence}</p>
                    {alert.attribution && (
                      <div className={styles.attributionBox}>
                        <div className={styles.attributionTopline}>
                          <span>归因</span>
                          <strong>{alert.attribution.label}</strong>
                          <em>置信度 {alert.attribution.confidence}</em>
                        </div>
                        <p>{alert.attribution.reasoning}</p>
                        <ul className={styles.evidenceList}>
                          {alert.attribution.evidenceItems.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                        <div className={styles.reasonTags}>
                          {alert.attribution.reasonTags.map((tag) => (
                            <span key={tag}>{tag}</span>
                          ))}
                        </div>
                        <div className={styles.aiBrief}>
                          <span>AI 解释草稿</span>
                          <p>{alert.attribution.aiBrief}</p>
                        </div>
                      </div>
                    )}
                    {aiState?.status === "success" && aiState.explanation && (
                      <div className={styles.liveAiBox}>
                        <div className={styles.liveAiHeader}>
                          <span>真实 AI 解释</span>
                          <em>置信度 {aiState.explanation.confidence}</em>
                        </div>
                        <strong>{aiState.explanation.summary}</strong>
                        <p>{aiState.explanation.whyItMatters}</p>
                        <p>{aiState.explanation.likelyCause}</p>
                        <ul>
                          {aiState.explanation.recommendedActions.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                        {aiState.explanation.unknowns.length > 0 && (
                          <small>
                            未知信息：
                            {aiState.explanation.unknowns.join(" / ")}
                          </small>
                        )}
                      </div>
                    )}
                    {aiState?.status === "error" && (
                      <div className={styles.liveAiError}>{aiState.error}</div>
                    )}
                    <div className={styles.actionText}>{alert.action}</div>
                    <footer>
                      <span>◷ {formatDate(alert.createdAt)}</span>
                      <span>•</span>
                      <span>▣ {alert.category}</span>
                      <span>•</span>
                      <span>{alert.source}</span>
                    </footer>
                  </article>
                  );
                })
              ) : (
                <div className={styles.emptyPriority}>
                  <strong>暂无需要优先处理的事项</strong>
                  <span>所有异常已归档或当前周期未触发告警。</span>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className={styles.metricGrid}>
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className={`${styles.metricCard} ${styles[metric.tone]}`}
            >
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
              <small>{metric.detail}</small>
            </div>
          ))}
        </section>

        <section className={styles.opsGrid}>
          <div className={styles.panelCard}>
            <div className={styles.panelHeader}>
              <div>
                <span>定时任务</span>
                <strong>自动巡检</strong>
              </div>
            </div>
            <div className={styles.taskList}>
              {taskRows.map((task) => (
                <div key={task.title} className={styles.taskRow}>
                  <div>
                    <strong>{task.title}</strong>
                    <span>{task.detail}</span>
                  </div>
                  <em>{task.status}</em>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.panelCard}>
            <div className={styles.panelHeader}>
              <div>
                <span>技能</span>
                <strong>运营能力</strong>
              </div>
            </div>
            <div className={styles.skillGrid}>
              {skillRows.map((skill) => (
                <div key={skill.title} className={styles.skillCard}>
                  <span>{skill.title}</span>
                  <strong>{skill.value}</strong>
                  <small>{skill.detail}</small>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.opsGrid}>
          <div className={styles.panelCard}>
            <div className={styles.panelHeader}>
              <div>
                <span>趋势基线</span>
                <strong>
                  {trendSummary.currentWindowLabel} vs {trendSummary.previousWindowLabel}
                </strong>
              </div>
              <span>{formatPercent(trendSummary.revenueChangePercent)}</span>
            </div>
            <div className={styles.comparisonGrid}>
              <div>
                <span>{trendSummary.currentWindowLabel}</span>
                <strong>
                  {formatCurrency(trendSummary.current.revenue, currencyCode)}
                </strong>
                <small>{trendSummary.current.orderCount} 单</small>
              </div>
              <div>
                <span>{trendSummary.previousWindowLabel}</span>
                <strong>
                  {formatCurrency(trendSummary.previous.revenue, currencyCode)}
                </strong>
                <small>{trendSummary.previous.orderCount} 单</small>
              </div>
              <div>
                <span>客单价变化</span>
                <strong>
                  {formatPercent(trendSummary.averageOrderValueChangePercent)}
                </strong>
                <small>
                  {formatCurrency(trendSummary.current.averageOrderValue, currencyCode)}
                </small>
              </div>
            </div>
            <div className={styles.trendChart}>
              {dailyTrend.map((point) => {
                const revenueHeight = Math.max(
                  4,
                  Math.round((point.revenue / maxDailyRevenue) * 100),
                );
                const orderHeight = Math.max(
                  4,
                  Math.round((point.orderCount / maxDailyOrders) * 100),
                );

                return (
                  <div key={point.key} className={styles.trendColumn}>
                    <div className={styles.trendBars}>
                      <span
                        className={styles.revenueBar}
                        style={{ height: `${revenueHeight}%` }}
                        title={`${point.label}: ${formatCurrency(
                          point.revenue,
                          currencyCode,
                        )}`}
                      />
                      <span
                        className={styles.orderBar}
                        style={{ height: `${orderHeight}%` }}
                        title={`${point.label}: ${point.orderCount} 单`}
                      />
                    </div>
                    <span>{point.label}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className={styles.panelCard}>
            <div className={styles.panelHeader}>
              <div>
                <span>数据源</span>
                <strong>Shopify</strong>
              </div>
              <span>{timezone}</span>
            </div>
            <div className={styles.dataSourceList}>
              <div>
                <span className={styles.shopifyDot}>S</span>
                <div>
                  <strong>{shopName}</strong>
                  <span>{fetchedOrderCount} 个订单 / {products.length} 个商品</span>
                </div>
              </div>
              <div>
                <span>□</span>
                <div>
                  <strong>归档事项</strong>
                  <span>{archivedAlerts.length} 个事项已移出优先处理</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.tableGrid}>
          <div className={styles.panelCard}>
            <div className={styles.panelHeader}>
              <div>
                <span>热卖商品</span>
                <strong>Top products</strong>
              </div>
            </div>
            {topProducts.length > 0 ? (
              <div className={styles.compactTable}>
                {topProducts.map((product) => (
                  <div key={product.key}>
                    <span>{product.title}</span>
                    <strong>{product.quantity.toLocaleString()} 件</strong>
                    <em>{formatCurrency(product.revenue, product.currencyCode)}</em>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.emptyState}>没有找到订单商品明细。</div>
            )}
          </div>

          <div className={styles.panelCard}>
            <div className={styles.panelHeader}>
              <div>
                <span>近期订单</span>
                <strong>Recent orders</strong>
              </div>
            </div>
            {recentOrders.length > 0 ? (
              <div className={styles.compactTable}>
                {recentOrders.map((order) => (
                  <div key={order.id}>
                    <span>{order.name}</span>
                    <strong>{formatCurrency(order.total, order.currencyCode)}</strong>
                    <em>{order.financialStatus} / {order.fulfillmentStatus}</em>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.emptyState}>所选周期内没有订单。</div>
            )}
          </div>

          <div className={styles.panelCard}>
            <div className={styles.panelHeader}>
              <div>
                <span>库存风险</span>
                <strong>{inventoryRisks.length}</strong>
              </div>
            </div>
            {inventoryRisks.length > 0 ? (
              <div className={styles.compactTable}>
                {inventoryRisks.slice(0, 8).map((product) => (
                  <div key={product.id}>
                    <span>{product.title}</span>
                    <strong>{formatInventoryRisk(product.risk)}</strong>
                    <em>
                      {product.inventory === null
                        ? "库存未知"
                        : `库存 ${product.inventory.toLocaleString()} 件`}
                    </em>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.emptyState}>没有发现库存风险。</div>
            )}
          </div>
        </section>

        <button className={styles.floatingButton} type="button" aria-label="新增任务">
          +
        </button>
      </main>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
