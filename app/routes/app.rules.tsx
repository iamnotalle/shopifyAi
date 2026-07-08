import type { ActionFunctionArgs } from "react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import prisma from "../db.server";
import styles from "../styles/analytics.module.css";

type RuleId =
  | "salesDrop"
  | "inventoryDays"
  | "highValueOrder"
  | "fulfillmentHours"
  | "refundRate";

type RuleConfig = {
  id: RuleId;
  title: string;
  owner: string;
  description: string;
  unit: string;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  example: string;
};

const RULES: RuleConfig[] = [
  {
    id: "salesDrop",
    title: "销售下滑阈值",
    owner: "运营",
    description: "今日或当前周期低于基线时触发销售波动预警。",
    unit: "%",
    defaultValue: 30,
    min: 10,
    max: 80,
    step: 5,
    example: "低于基线 30% 时，进入销售波动异常。",
  },
  {
    id: "inventoryDays",
    title: "库存可售天数",
    owner: "商品",
    description: "用库存除以近 7 天日均销量，判断热卖 SKU 是否接近断货。",
    unit: "天",
    defaultValue: 7,
    min: 1,
    max: 30,
    step: 1,
    example: "预计 7 天内断货时，进入库存风险。",
  },
  {
    id: "highValueOrder",
    title: "高金额订单线",
    owner: "履约",
    description: "高金额订单如果长时间未履约，需要单独拉出来处理。",
    unit: "USD",
    defaultValue: 300,
    min: 50,
    max: 1000,
    step: 50,
    example: "订单金额超过 300 USD 且未履约时，进入订单风险。",
  },
  {
    id: "fulfillmentHours",
    title: "未履约超时",
    owner: "履约",
    description: "订单创建后超过指定小时仍未履约，触发履约积压提醒。",
    unit: "小时",
    defaultValue: 24,
    min: 6,
    max: 96,
    step: 6,
    example: "超过 24 小时未发货时，进入履约风险。",
  },
  {
    id: "refundRate",
    title: "退款率异常线",
    owner: "客服",
    description: "退款或取消比例超过阈值时，提示复盘商品质量和履约体验。",
    unit: "%",
    defaultValue: 10,
    min: 2,
    max: 40,
    step: 2,
    example: "退款率超过 10% 时，进入客户风险。",
  },
];

const DEFAULT_VALUES = RULES.reduce(
  (values, rule) => ({
    ...values,
    [rule.id]: rule.defaultValue,
  }),
  {} as Record<RuleId, number>,
);

const PROFILE_KEY = "demo";

type LoaderData = {
  values: Record<RuleId, number>;
  savedAt: string | null;
  profileKey: string;
};

type ActionData =
  | {
      ok: true;
      savedAt: string;
      values: Record<RuleId, number>;
    }
  | {
      ok: false;
      error: string;
    };

export const loader = async (): Promise<LoaderData> => {
  const rows = await prisma.opsRuleSetting.findMany({
    where: { profileKey: PROFILE_KEY },
    orderBy: { updatedAt: "desc" },
  });
  const values = { ...DEFAULT_VALUES };

  for (const row of rows) {
    const rule = getRule(row.ruleId);

    if (rule) {
      values[rule.id] = normalizeRuleValue(rule, row.value);
    }
  }

  return {
    values,
    savedAt: rows[0]?.updatedAt.toISOString() || null,
    profileKey: PROFILE_KEY,
  };
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionData> => {
  try {
    const formData = await request.formData();
    const values = readRuleValues(formData);
    const now = new Date();

    await Promise.all(
      RULES.map((rule) =>
        prisma.opsRuleSetting.upsert({
          where: {
            profileKey_ruleId: {
              profileKey: PROFILE_KEY,
              ruleId: rule.id,
            },
          },
          update: {
            value: values[rule.id],
            updatedAt: now,
          },
          create: {
            profileKey: PROFILE_KEY,
            ruleId: rule.id,
            value: values[rule.id],
            updatedAt: now,
          },
        }),
      ),
    );

    return {
      ok: true,
      savedAt: now.toISOString(),
      values,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "规则保存失败，请稍后重试。",
    };
  }
};

export default function RulesPage() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [values, setValues] = useState(loaderData.values);
  const isSaving = navigation.state === "submitting";
  const savedAt =
    actionData?.ok === true ? actionData.savedAt : loaderData.savedAt;
  const saveError = actionData?.ok === false ? actionData.error : null;

  useEffect(() => {
    setValues(loaderData.values);
  }, [loaderData.values]);

  const activeRules = useMemo(
    () =>
      RULES.map((rule) => ({
        ...rule,
        value: values[rule.id],
      })),
    [values],
  );

  return (
    <div className={styles.reportShell}>
      <header className={styles.reportHero}>
        <div>
          <span>规则配置</span>
          <h1>运营口径管理</h1>
          <p>运营确认阈值，系统按规则巡检，AI 只基于命中的证据生成解释。</p>
        </div>
        <a className={styles.rangeButtonActive} href="/app">
          返回工作台
        </a>
      </header>

      <Form method="post" className={styles.rulesForm}>
        <section className={styles.rulesHeroGrid}>
          <div className={styles.panelCard}>
            <div className={styles.panelHeader}>
              <div>
                <span>规则权责</span>
                <strong>人定口径，系统执行</strong>
              </div>
            </div>
            <div className={styles.rulePrinciples}>
              <div>
                <strong>运营</strong>
                <span>定义什么算异常、哪些 SKU 特别关注、什么情况必须当天处理。</span>
              </div>
              <div>
                <strong>系统</strong>
                <span>读取 Shopify 数据，按规则计算异常、证据链和归因标签。</span>
              </div>
              <div>
                <strong>AI</strong>
                <span>把证据翻译成中文日报、处理建议和可追问的运营解释。</span>
              </div>
            </div>
          </div>

          <div className={styles.panelCard}>
            <div className={styles.panelHeader}>
              <div>
                <span>当前状态</span>
                <strong>{savedAt ? "已保存到规则库" : "使用默认规则"}</strong>
              </div>
            </div>
            <div className={styles.ruleSnapshot}>
              {activeRules.slice(0, 3).map((rule) => (
                <div key={rule.id}>
                  <span>{rule.title}</span>
                  <strong>
                    {rule.value}
                    {rule.unit}
                  </strong>
                </div>
              ))}
            </div>
            <button
              className={styles.primaryButton}
              type="submit"
              disabled={isSaving}
            >
              {isSaving ? "保存中..." : "保存规则"}
            </button>
            {savedAt && (
              <p className={styles.saveHint}>
                已在 {formatSavedAt(savedAt)} 保存到 {loaderData.profileKey} 工作区。
              </p>
            )}
            {saveError && <p className={styles.saveError}>{saveError}</p>}
          </div>
        </section>

        <section className={styles.ruleGrid}>
          {activeRules.map((rule) => (
            <article key={rule.id} className={styles.ruleCard}>
              <div className={styles.ruleCardHeader}>
                <div>
                  <span>{rule.owner}</span>
                  <strong>{rule.title}</strong>
                </div>
                <em>
                  {rule.value}
                  {rule.unit}
                </em>
              </div>
              <p>{rule.description}</p>
              <label className={styles.ruleInputRow}>
                <span>阈值</span>
                <input
                  min={rule.min}
                  max={rule.max}
                  step={rule.step}
                  type="range"
                  value={rule.value}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [rule.id]: normalizeRuleValue(rule, event.target.value),
                    }))
                  }
                />
                <input
                  min={rule.min}
                  max={rule.max}
                  name={rule.id}
                  step={rule.step}
                  type="number"
                  value={rule.value}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [rule.id]: normalizeRuleValue(rule, event.target.value),
                    }))
                  }
                />
              </label>
              <div className={styles.ruleExample}>{rule.example}</div>
            </article>
          ))}
        </section>
      </Form>
    </div>
  );
}

function readRuleValues(formData: FormData): Record<RuleId, number> {
  return RULES.reduce(
    (values, rule) => ({
      ...values,
      [rule.id]: normalizeRuleValue(rule, formData.get(rule.id)),
    }),
    {} as Record<RuleId, number>,
  );
}

function normalizeRuleValue(
  rule: RuleConfig,
  value: FormDataEntryValue | number | string | null,
) {
  const parsed = Number(value);
  const fallback = Number.isFinite(parsed) ? parsed : rule.defaultValue;
  const clamped = Math.min(rule.max, Math.max(rule.min, fallback));

  return Number(clamped.toFixed(2));
}

function getRule(ruleId: string) {
  return RULES.find((rule) => rule.id === ruleId);
}

function formatSavedAt(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
