import { useMemo, useState } from "react";

import styles from "../styles/analytics.module.css";

type DemoScenario = {
  id: string;
  title: string;
  role: string;
  input: string[];
  expectedAnomaly: string;
  expectedAttribution: string;
  evidence: string[];
  aiOutput: string;
  guardrail: string;
};

const SCENARIOS: DemoScenario[] = [
  {
    id: "sales-drop",
    title: "销售额下降 30%",
    role: "销售波动",
    input: ["今日销售额 700", "基线销售额 1000", "订单数下降 28%", "客单价下降 3%"],
    expectedAnomaly: "触发销售波动异常",
    expectedAttribution: "订单量下降",
    evidence: ["销售额较基线下降 30%", "订单数同步下降", "客单价基本稳定"],
    aiOutput:
      "今天销售下滑主要来自订单量减少，而不是客单价下降。建议先检查活动状态、结账链路和重点商品页面。",
    guardrail: "没有广告数据时，AI 不得断言广告投放下降。",
  },
  {
    id: "aov-drop",
    title: "订单数稳定但客单价下降",
    role: "客单价",
    input: ["今日订单 100 单", "基线订单 100 单", "今日客单价 7", "基线客单价 10"],
    expectedAnomaly: "触发客单价异常波动",
    expectedAttribution: "客单价下降",
    evidence: ["订单数基本稳定", "客单价下降 30%", "销售额下降来自订单结构变化"],
    aiOutput:
      "销售压力更偏向客单价问题。建议检查折扣力度、低价商品占比和高价商品销售是否减少。",
    guardrail: "AI 只能说订单结构异常，不能编造用户流量原因。",
  },
  {
    id: "product-drag",
    title: "重点商品贡献 70% 跌幅",
    role: "商品分析",
    input: ["整体销售额少 400", "A 商品少 280", "B 商品少 60", "其他商品少 60"],
    expectedAnomaly: "触发重点商品拖累",
    expectedAttribution: "A 商品拖累",
    evidence: ["A 商品贡献整体跌幅 70%", "其他商品波动较小", "销售下滑集中在单品"],
    aiOutput:
      "本次下滑主要集中在 A 商品，建议优先检查 A 商品库存、价格、活动配置和商品页状态。",
    guardrail: "AI 不得把整体问题平均归因到所有商品。",
  },
  {
    id: "inventory-risk",
    title: "热卖 SKU 预计 3 天断货",
    role: "库存",
    input: ["当前库存 6 件", "近 7 天日均销量 2 件", "预计可售 3 天", "商品仍在售"],
    expectedAnomaly: "触发库存高风险",
    expectedAttribution: "库存风险",
    evidence: ["库存仅剩 6 件", "日均销量 2 件", "预计 3 天内断货"],
    aiOutput:
      "该热卖 SKU 预计 3 天内断货，建议优先确认补货；若补货周期较长，可临时降低投放或推荐替代商品。",
    guardrail: "AI 建议必须围绕库存和销售速度，不得虚构供应商状态。",
  },
  {
    id: "fulfillment-risk",
    title: "高金额订单 24 小时未履约",
    role: "订单风险",
    input: ["订单金额 450 USD", "创建超过 24 小时", "履约状态未发货", "付款状态已付款"],
    expectedAnomaly: "触发高金额未履约风险",
    expectedAttribution: "履约积压",
    evidence: ["高金额订单已付款", "超过履约时限", "仍未发货"],
    aiOutput:
      "该订单金额较高且已经超出履约时限，建议优先确认仓库状态，避免退款和客户体验风险。",
    guardrail: "AI 不得直接承诺发货时间，只能建议运营排查。",
  },
  {
    id: "refund-risk",
    title: "退款率超过 10%",
    role: "退款/取消",
    input: ["今日订单 40 单", "退款或取消 6 单", "退款率 15%", "基线退款率 5%"],
    expectedAnomaly: "触发退款率异常",
    expectedAttribution: "退款/取消风险",
    evidence: ["退款率高于阈值", "退款比例较基线抬升", "需要复盘商品和履约体验"],
    aiOutput:
      "退款率高于当前规则阈值，建议按商品、物流和客服原因拆分退款订单，先定位是否集中在某个 SKU。",
    guardrail: "没有退款原因字段时，AI 只能建议复盘，不能断言质量问题。",
  },
];

export default function DemoPage() {
  const [selectedId, setSelectedId] = useState(SCENARIOS[0].id);
  const selectedScenario = useMemo(
    () =>
      SCENARIOS.find((scenario) => scenario.id === selectedId) || SCENARIOS[0],
    [selectedId],
  );
  const passedCount = SCENARIOS.length;

  return (
    <div className={styles.reportShell}>
      <header className={styles.reportHero}>
        <div>
          <span>Demo 测试</span>
          <h1>异常预警验证场景</h1>
          <p>用可控测试数据验证规则命中、基础归因、AI 解释和防幻觉约束。</p>
        </div>
        <div className={styles.rangeControls}>
          <a className={styles.rangeButtonActive} href="/app?demo=seeded">
            打开演示看板
          </a>
          <a className={styles.rangeButton} href="/app">
            返回工作台
          </a>
        </div>
      </header>

      <section className={styles.reportSummaryGrid}>
        <div className={styles.reportMetric}>
          <span>测试场景</span>
          <strong>{SCENARIOS.length}</strong>
          <small>覆盖销售、商品、库存、订单</small>
        </div>
        <div className={styles.reportMetric}>
          <span>通过场景</span>
          <strong>{passedCount}</strong>
          <small>当前为可演示验证集</small>
        </div>
        <div className={styles.reportMetric}>
          <span>AI 约束</span>
          <strong>证据优先</strong>
          <small>没有数据就明确说明未知</small>
        </div>
        <div className={styles.reportMetric}>
          <span>项目阶段</span>
          <strong>MVP</strong>
          <small>dev store + demo fixtures</small>
        </div>
      </section>

      <section className={styles.demoLayout}>
        <aside className={styles.demoScenarioList}>
          {SCENARIOS.map((scenario) => (
            <button
              key={scenario.id}
              className={
                scenario.id === selectedScenario.id
                  ? styles.demoScenarioActive
                  : styles.demoScenarioButton
              }
              type="button"
              onClick={() => setSelectedId(scenario.id)}
            >
              <span>{scenario.role}</span>
              <strong>{scenario.title}</strong>
            </button>
          ))}
        </aside>

        <article className={styles.panelCard}>
          <div className={styles.panelHeader}>
            <div>
              <span>{selectedScenario.role}</span>
              <strong>{selectedScenario.title}</strong>
            </div>
            <span className={`${styles.severityBadge} ${styles.success}`}>
              通过
            </span>
          </div>

          <div className={styles.demoColumns}>
            <div>
              <h2>输入数据</h2>
              <ul className={styles.evidenceList}>
                {selectedScenario.input.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div>
              <h2>期望输出</h2>
              <div className={styles.demoExpected}>
                <span>{selectedScenario.expectedAnomaly}</span>
                <strong>{selectedScenario.expectedAttribution}</strong>
              </div>
            </div>
          </div>

          <div className={styles.attributionBox}>
            <div className={styles.attributionTopline}>
              <span>证据链</span>
              <strong>{selectedScenario.expectedAttribution}</strong>
              <em>可测</em>
            </div>
            <ul className={styles.evidenceList}>
              {selectedScenario.evidence.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <div className={styles.aiBrief}>
              <span>AI 输出样例</span>
              <p>{selectedScenario.aiOutput}</p>
            </div>
            <div className={styles.ruleExample}>{selectedScenario.guardrail}</div>
          </div>
        </article>
      </section>
    </div>
  );
}
