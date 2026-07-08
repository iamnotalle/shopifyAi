# Shopify AI Ops Alert Dashboard

一个面向 Shopify 独立站运营的 AI 异常预警看板 Demo。

项目目标不是做一个普通报表，而是把运营每天需要盯的异常变成一套可配置、可解释、可演示的工作台：系统先按规则发现异常，再把销售、订单、库存、退款、履约等证据组织起来，最后由 AI 生成面向运营的解释和处理建议。

## 功能亮点

- 今日重点：聚合销售额、订单数、客单价、商品数和风险数量。
- 异常预警：识别销售下滑、库存风险、订单风险、退款率异常、履约超时。
- 多指标归因：不是只看销售额，而是结合订单量、客单价、商品销量、库存、退款和履约状态判断异常原因。
- AI 解释：把命中的异常证据转换成中文解释、可能原因、建议动作和不确定项。
- 规则配置：运营可以保存销售下滑阈值、库存预警阈值、高金额订单阈值、履约超时阈值和退款率阈值。
- 演示数据模式：支持 `/demo` 公开演示，不需要 Shopify 登录，也不会读取真实店铺数据。

## 产品定位

这个项目模拟的是 Shopify App Store 里运营分析类应用的核心能力，但重点放在 AI 产品经理视角：

- 先定义什么算异常。
- 再定义异常需要哪些证据支撑。
- 然后让 AI 基于证据解释为什么值得关注。
- 最后把解释落到运营可以执行的动作。

AI 不负责凭空判断业务好坏，它负责把系统计算出的证据转译成更容易理解、复盘和沟通的运营语言。

## 技术栈

- Shopify React Router app template
- React Router 7
- TypeScript
- Prisma
- SQLite
- Shopify Admin GraphQL API
- OpenAI-compatible chat completion API

## 本地运行

安装依赖：

```bash
npm install
```

初始化 Prisma：

```bash
npm run setup
```

启动 Shopify 开发环境：

```bash
npm run dev
```

第一次接自己的 Shopify Partner app 时，先运行：

```bash
npm run config:link
```

然后按 Shopify CLI 提示选择自己的 app。公开仓库里的 `shopify.app.toml`
使用的是占位 `client_id`，不要直接拿它连接真实店铺。

如果只想看作品集演示，可以打开：

```text
/demo
```

这个路由会进入内置演示数据模式。

## 环境变量

复制 `.env.example` 后按自己的环境填写。不要把真实 `.env` 提交到 Git。

AI 解释接口支持 OpenAI-compatible API，例如 DeepSeek 或 OpenAI。模型 key 只在服务端读取，不会暴露到浏览器。

## 真实店铺说明

当前 Demo 默认适合验证：

- 权限流程
- 产品读取
- 库存风险
- 规则配置
- 演示订单分析
- AI 解释逻辑
- 页面嵌入和看板交互

如果要读取真实订单，需要 Shopify 的 Protected Customer Data 审批。没有审批时，应用会降级为产品和库存维度，不强行读取真实订单对象。

## 规则配置

规则配置已经落到数据库，不是前端假状态。当前支持保存：

- 销售下滑阈值
- 库存预警阈值
- 高金额订单阈值
- 履约超时阈值
- 退款率阈值

首页预警会读取保存后的规则重新计算异常。

## 验证命令

```bash
npm run typecheck
npm run lint
npm run build
```

## 项目价值

这个项目可以作为 AI 产品经理 0 到 1 项目展示：

- 从独立站运营场景拆需求。
- 设计异常预警规则和证据链。
- 明确 AI 在产品中的边界和作用。
- 用真实 Web App 形态完成可交互原型。
- 支持 Demo 分享、后续部署和真实 Shopify 接入扩展。
