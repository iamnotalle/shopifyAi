import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import styles from "../styles/analytics.module.css";

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
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  currentTotalPriceSet: MoneyBag;
  lineItems: {
    edges: Array<{
      node: {
        title: string;
        quantity: number;
        discountedTotalSet: MoneyBag;
      };
    }>;
  };
};

type ProductNode = {
  id: string;
  title: string;
  status: string;
  totalInventory: number | null;
  updatedAt: string;
  priceRangeV2: {
    minVariantPrice: Money;
    maxVariantPrice: Money;
  };
};

type ReportResponse = {
  data?: {
    shop: {
      name: string;
      currencyCode: string;
      ianaTimezone: string;
    };
    todayOrders: {
      edges: Array<{ node: OrderNode }>;
    };
    previousOrders: {
      edges: Array<{ node: OrderNode }>;
    };
    products: {
      edges: Array<{ node: ProductNode }>;
    };
  };
  errors?: Array<{ message: string }>;
};

type ProductOnlyReportResponse = {
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

type ReportItem = {
  title: string;
  detail: string;
  tone: "critical" | "warning" | "info" | "success";
};

type LoaderData = {
  shopName: string;
  timezone: string;
  currencyCode: string;
  reportDate: string;
  today: {
    revenue: number;
    orderCount: number;
    itemCount: number;
    averageOrderValue: number;
  };
  previous: {
    revenue: number;
    orderCount: number;
    itemCount: number;
    averageOrderValue: number;
  };
  focusItems: ReportItem[];
  inventoryRisks: ReportItem[];
  orderRisks: ReportItem[];
  salesSignals: ReportItem[];
  recentOrders: Array<{
    id: string;
    name: string;
    total: number;
    currencyCode: string;
    createdAt: string;
    financialStatus: string;
    fulfillmentStatus: string;
  }>;
  error: string | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const today = getDateKey(new Date());
  const yesterday = getDateKey(addDays(new Date(), -1));

  try {
    const response = await admin.graphql(
      `#graphql
        query DailyReport($todayQuery: String!, $previousQuery: String!) {
          shop {
            name
            currencyCode
            ianaTimezone
          }
          todayOrders: orders(
            first: 100
            sortKey: CREATED_AT
            reverse: true
            query: $todayQuery
          ) {
            edges {
              node {
                id
                name
                createdAt
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
                      title
                      quantity
                      discountedTotalSet {
                        shopMoney {
                          amount
                          currencyCode
                        }
                      }
                    }
                  }
                }
              }
            }
          }
          previousOrders: orders(
            first: 100
            sortKey: CREATED_AT
            reverse: true
            query: $previousQuery
          ) {
            edges {
              node {
                id
                name
                createdAt
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
                      title
                      quantity
                      discountedTotalSet {
                        shopMoney {
                          amount
                          currencyCode
                        }
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
          todayQuery: `created_at:>=${today}`,
          previousQuery: `created_at:>=${yesterday} created_at:<${today}`,
        },
      },
    );

    const responseJson = (await response.json()) as ReportResponse;

    if (!responseJson.data || responseJson.errors?.length) {
      return buildEmptyReport(
        responseJson.errors?.map((error) => error.message).join(" ") ||
          "Shopify 没有返回日报数据。",
      );
    }

    return buildReportData(responseJson.data);
  } catch (error) {
    const accessError = formatAdminApiError(error);

    try {
      const productResponse = await admin.graphql(
        `#graphql
          query DailyReportProductsOnly {
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
        (await productResponse.json()) as ProductOnlyReportResponse;

      if (productJson.data && !productJson.errors?.length) {
        return buildReportData(
          {
            ...productJson.data,
            todayOrders: { edges: [] },
            previousOrders: { edges: [] },
          },
          accessError,
        );
      }

      return buildEmptyReport(
        productJson.errors?.map((item) => item.message).join(" ") ||
          accessError,
      );
    } catch {
      return buildEmptyReport(accessError);
    }
  }
};

function buildEmptyReport(error: string): LoaderData {
  return {
    shopName: "Shopify 店铺",
    timezone: "店铺时区",
    currencyCode: "USD",
    reportDate: formatFullDate(new Date()),
    today: emptyStats(),
    previous: emptyStats(),
    focusItems: [
      {
        title: "日报数据读取失败",
        detail: error,
        tone: "critical",
      },
    ],
    inventoryRisks: [],
    orderRisks: [],
    salesSignals: [],
    recentOrders: [],
    error,
  };
}

function buildReportData(
  data: NonNullable<ReportResponse["data"]>,
  error: string | null = null,
): LoaderData {
  const todayOrders = data.todayOrders.edges.map(({ node }) => node);
  const previousOrders = data.previousOrders.edges.map(({ node }) => node);
  const products = data.products.edges.map(({ node }) => node);
  const todayStats = buildStats(todayOrders);
  const previousStats = buildStats(previousOrders);
  const currencyCode =
    todayOrders[0]?.currentTotalPriceSet.shopMoney.currencyCode ||
    previousOrders[0]?.currentTotalPriceSet.shopMoney.currencyCode ||
    data.shop.currencyCode;
  const inventoryRisks = buildInventoryRisks(products);
  const orderRisks = buildOrderRisks(todayOrders);
  const salesSignals = buildSalesSignals(todayStats, previousStats, currencyCode);
  const focusItems = [
    ...(error
      ? [
          {
            title: "订单数据权限未开",
            detail: error,
            tone: "warning" as const,
          },
        ]
      : []),
    ...salesSignals.filter((item) => item.tone !== "success"),
    ...inventoryRisks.slice(0, 2),
    ...orderRisks.slice(0, 2),
  ].slice(0, 5);

  return {
    shopName: data.shop.name,
    timezone: data.shop.ianaTimezone,
    currencyCode,
    reportDate: formatFullDate(new Date()),
    today: todayStats,
    previous: previousStats,
    focusItems:
      focusItems.length > 0
        ? focusItems
        : [
            {
              title: "今日暂无重点风险",
              detail: "销售、订单、库存和履约状态没有触发当前日报阈值。",
              tone: "success",
            },
          ],
    inventoryRisks,
    orderRisks,
    salesSignals,
    recentOrders: todayOrders.slice(0, 8).map((order) => ({
      id: order.id,
      name: order.name,
      total: parseMoney(order.currentTotalPriceSet.shopMoney.amount),
      currencyCode: order.currentTotalPriceSet.shopMoney.currencyCode,
      createdAt: order.createdAt,
      financialStatus: formatStatus(order.displayFinancialStatus),
      fulfillmentStatus: formatStatus(order.displayFulfillmentStatus),
    })),
    error,
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
    return "当前应用还未开通 Shopify 订单受保护客户数据访问，真实订单和销售额暂时不可读取。先用演示数据验证销售额、订单风险和日报逻辑，真实接店前再补齐订单权限。";
  }

  return message;
}

function emptyStats() {
  return {
    revenue: 0,
    orderCount: 0,
    itemCount: 0,
    averageOrderValue: 0,
  };
}

function buildStats(orders: OrderNode[]) {
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

  return {
    revenue,
    orderCount: orders.length,
    itemCount,
    averageOrderValue: orders.length === 0 ? 0 : revenue / orders.length,
  };
}

function buildInventoryRisks(products: ProductNode[]): ReportItem[] {
  const activeProducts = products.filter((product) => product.status === "ACTIVE");
  const outOfStock = activeProducts.filter(
    (product) => product.totalInventory !== null && product.totalInventory <= 0,
  );
  const lowStock = activeProducts.filter(
    (product) =>
      product.totalInventory !== null &&
      product.totalInventory > 0 &&
      product.totalInventory <= 5,
  );
  const unknownStock = activeProducts.filter(
    (product) => product.totalInventory === null,
  );

  return [
    ...outOfStock.map((product) => ({
      title: `${product.title} 缺货`,
      detail: "在售商品库存为 0，可能影响销售转化。",
      tone: "warning" as const,
    })),
    ...lowStock.map((product) => ({
      title: `${product.title} 低库存`,
      detail: `当前库存 ${product.totalInventory} 件，建议优先补货。`,
      tone: "info" as const,
    })),
    ...unknownStock.map((product) => ({
      title: `${product.title} 库存未知`,
      detail: "无法判断该商品库存状态，建议检查库存追踪设置。",
      tone: "info" as const,
    })),
  ];
}

function buildOrderRisks(orders: OrderNode[]): ReportItem[] {
  const risks: ReportItem[] = [];
  const unpaidOrders = orders.filter((order) => !isPaidOrder(order));
  const unfulfilledOrders = orders.filter((order) =>
    ["UNFULFILLED", "PARTIALLY_FULFILLED", "ON_HOLD"].includes(
      order.displayFulfillmentStatus || "",
    ),
  );

  if (orders.length === 0) {
    risks.push({
      title: "今日暂无订单",
      detail: "今日订单数为 0，请确认是否为测试店铺、流量不足或活动暂停。",
      tone: "critical",
    });
  }

  if (unpaidOrders.length > 0) {
    risks.push({
      title: "存在未付款订单",
      detail: `${unpaidOrders.length} 个订单尚未付款，建议检查支付状态。`,
      tone: "warning",
    });
  }

  if (unfulfilledOrders.length > 0) {
    risks.push({
      title: "存在未完成发货订单",
      detail: `${unfulfilledOrders.length} 个订单仍未完成履约。`,
      tone: "info",
    });
  }

  return risks;
}

function buildSalesSignals(
  today: ReturnType<typeof buildStats>,
  previous: ReturnType<typeof buildStats>,
  currencyCode: string,
): ReportItem[] {
  const revenueChange = calculatePercentChange(today.revenue, previous.revenue);
  const orderChange = calculatePercentChange(today.orderCount, previous.orderCount);
  const signals: ReportItem[] = [];

  if (today.orderCount === 0) {
    signals.push({
      title: "今日销售为 0",
      detail: "今日尚未读取到订单，销售额和客单价均为 0。",
      tone: "critical",
    });
  }

  if (revenueChange !== null && previous.revenue > 0) {
    signals.push({
      title:
        revenueChange < -30
          ? "销售额低于昨日"
          : revenueChange > 50
            ? "销售额高于昨日"
            : "销售额平稳",
      detail: `今日 ${formatCurrency(today.revenue, currencyCode)}，昨日 ${formatCurrency(
        previous.revenue,
        currencyCode,
      )}，变化 ${formatPercent(revenueChange)}。`,
      tone:
        revenueChange < -30
          ? "warning"
          : revenueChange > 50
            ? "info"
            : "success",
    });
  }

  if (orderChange !== null && previous.orderCount > 0) {
    signals.push({
      title:
        orderChange < -30
          ? "订单数低于昨日"
          : orderChange > 50
            ? "订单数高于昨日"
            : "订单数平稳",
      detail: `今日 ${today.orderCount} 单，昨日 ${previous.orderCount} 单，变化 ${formatPercent(
        orderChange,
      )}。`,
      tone:
        orderChange < -30
          ? "warning"
          : orderChange > 50
            ? "info"
            : "success",
    });
  }

  return signals.length > 0
    ? signals
    : [
        {
          title: "销售波动暂无基线",
          detail: "昨日与今日都没有足够订单，暂不判断销售波动。",
          tone: "info",
        },
      ];
}

function isPaidOrder(order: OrderNode) {
  return [
    "PAID",
    "PARTIALLY_PAID",
    "PARTIALLY_REFUNDED",
  ].includes(order.displayFinancialStatus || "");
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

function getDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);

  return next;
}

function formatCurrency(amount: number, currencyCode: string) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: currencyCode,
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  }).format(amount);
}

function formatPercent(value: number | null) {
  if (value === null) {
    return "无基线";
  }

  const prefix = value > 0 ? "+" : "";

  return `${prefix}${Math.round(value)}%`;
}

function formatFullDate(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(value);
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatStatus(value: string | null) {
  if (!value) {
    return "未知";
  }

  const statusMap: Record<string, string> = {
    PAID: "已付款",
    PARTIALLY_PAID: "部分付款",
    PARTIALLY_REFUNDED: "部分退款",
    PENDING: "待处理",
    REFUNDED: "已退款",
    UNFULFILLED: "未发货",
    PARTIALLY_FULFILLED: "部分发货",
    FULFILLED: "已发货",
    ON_HOLD: "暂停中",
  };

  return statusMap[value.toUpperCase()] || value;
}

function getToneLabel(tone: ReportItem["tone"]) {
  return {
    critical: "严重",
    warning: "预警",
    info: "提示",
    success: "正常",
  }[tone];
}

export default function DailyReport() {
  const {
    shopName,
    timezone,
    currencyCode,
    reportDate,
    today,
    previous,
    focusItems,
    inventoryRisks,
    orderRisks,
    salesSignals,
    recentOrders,
    error,
  } = useLoaderData<typeof loader>();

  return (
    <div className={styles.reportShell}>
      <header className={styles.reportHero}>
        <div>
          <span>日报</span>
          <h1>{shopName} 今日经营日报</h1>
          <p>{reportDate} · {timezone}</p>
        </div>
        <a className={styles.rangeButtonActive} href="/app">
          返回工作台
        </a>
      </header>

      {error && (
        <div className={styles.errorPanel}>
          <strong>日报数据读取失败。</strong>
          <span>{error}</span>
        </div>
      )}

      <section className={styles.reportSummaryGrid}>
        <div className={styles.reportMetric}>
          <span>今日销售额</span>
          <strong>{formatCurrency(today.revenue, currencyCode)}</strong>
          <small>昨日 {formatCurrency(previous.revenue, currencyCode)}</small>
        </div>
        <div className={styles.reportMetric}>
          <span>今日订单</span>
          <strong>{today.orderCount}</strong>
          <small>昨日 {previous.orderCount} 单</small>
        </div>
        <div className={styles.reportMetric}>
          <span>今日客单价</span>
          <strong>{formatCurrency(today.averageOrderValue, currencyCode)}</strong>
          <small>{today.itemCount} 件商品售出</small>
        </div>
        <div className={styles.reportMetric}>
          <span>风险事项</span>
          <strong>{focusItems.filter((item) => item.tone !== "success").length}</strong>
          <small>今日重点 + 风险清单</small>
        </div>
      </section>

      <section className={styles.reportGrid}>
        <ReportPanel title="今日重点" items={focusItems} emptyText="今日暂无重点事项。" />
        <ReportPanel
          title="库存风险"
          items={inventoryRisks}
          emptyText="没有发现库存风险。"
        />
        <ReportPanel
          title="订单风险"
          items={orderRisks}
          emptyText="没有发现订单风险。"
        />
        <ReportPanel
          title="销售波动"
          items={salesSignals}
          emptyText="暂无销售波动信号。"
        />
      </section>

      <section className={styles.panelCard}>
        <div className={styles.panelHeader}>
          <div>
            <span>今日订单明细</span>
            <strong>{recentOrders.length} 个订单</strong>
          </div>
        </div>
        {recentOrders.length > 0 ? (
          <div className={styles.compactTable}>
            {recentOrders.map((order) => (
              <div key={order.id}>
                <span>{order.name} · {formatTime(order.createdAt)}</span>
                <strong>{formatCurrency(order.total, order.currencyCode)}</strong>
                <em>{order.financialStatus} / {order.fulfillmentStatus}</em>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.emptyState}>今日暂无订单。</div>
        )}
      </section>
    </div>
  );
}

function ReportPanel({
  title,
  items,
  emptyText,
}: {
  title: string;
  items: ReportItem[];
  emptyText: string;
}) {
  return (
    <section className={styles.reportPanel}>
      <div className={styles.panelHeader}>
        <div>
          <span>{title}</span>
          <strong>{items.length}</strong>
        </div>
      </div>
      {items.length > 0 ? (
        <div className={styles.reportItemList}>
          {items.map((item) => (
            <article key={`${item.title}-${item.detail}`} className={styles.reportItem}>
              <span className={`${styles.severityBadge} ${styles[item.tone]}`}>
                {getToneLabel(item.tone)}
              </span>
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
            </article>
          ))}
        </div>
      ) : (
        <div className={styles.emptyState}>{emptyText}</div>
      )}
    </section>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
