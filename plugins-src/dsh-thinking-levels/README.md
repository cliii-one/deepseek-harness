# @cliii-one/dsh-thinking-levels

DeepSeek Harness 模型思考等级设置插件:编辑 `llm-pi-ai` 管理的第三方模型的 `reasoningEfforts`(7 个标准思考档位与每档线上值),经官方 settings RPC 整组写回 settings.yaml。

> 注意:npm 上存在同名包 `dsh-thinking-levels`(drscrewdriver 维护,功能不同)。本包为 scoped 名 `@cliii-one/dsh-thinking-levels`,两者无关联。

参考 `@mzzsfy/dsh-model-capability-editor` 的架构(客户端自注册 + settings RPC + 整组合并写回 + 冲突重放),聚焦"思考等级"单一生效面,零第三方依赖。

## 功能

- 打开官方「模型」设置页后,右侧浮动「思考等级」按钮,点开完整编辑面板。
- provider 选择(来源为 describe 返回的 `providers` 键),列出各模型行。
- 思考档位七档(off / minimal / low / medium / high / xhigh / max,与宿主 pi-ai `THINKING_LEVELS` 一致)开关 + 每档线上值输入,判定表:

  | 勾选状态 | 写回行为 |
  |---|---|
  | 全不勾选 | 删除 `reasoningEfforts` 字段(回到 host 默认) |
  | 仅勾选 off,拼写留空 | `reasoningEfforts: false`(禁用推理) |
  | off 勾选拼写留空,存在其他勾选档 | 对象形态 `off: null` |
  | off 勾选拼写填值 | 对象形态 `off: "拼写"` |
  | 非 off 档勾选拼写留空 | 对象形态 `档位名: "档位名"`(线上值取档位名) |
  | 非 off 档勾选拼写填值 | 对象形态 `档位名: "拼写"`(如 `high: ultra`) |

- 一键草稿填充:对未声明任何档位的模型填入七档全勾、拼写留空的草稿;只改内存草稿,写回仍需手动保存;已声明档位的模型不受影响。
- 保存 = mutate set `providers.<route>.models` 整个数组:以 describe 读到的数组为基线,未编辑条目原样保留;providers 缺失或 models 非数组时拒绝保存(防静默覆写为空数组)。
- 修订冲突:重读 describe 取新 revision,按字段级 diff 仅重放本次修改,重试一次;再冲突报错终止,绝不静默覆盖。
- `settings` wire 面缺失 / describe 失败 / `writable === false`:面板显示具体原因并只读,绝不静默。
- 未触及判定以草稿加载时点冻结的种子(seed)为参照:加载后他方对基线的修改,不会被零编辑的保存静默回滚。

## 与 @mzzsfy/dsh-model-capability-editor 的关系

- 架构同源:客户端自注册(`__ModuleLoader__.load`)、settings 双代际传输面(typed remote / connection.api)、整组合并保存流、冲突字段级重放均沿用其成熟做法。
- 差异:本插件**只编辑 `reasoningEfforts`**(不做 `input` 多模态声明),**不做官方模型行行内注入**(无 MutationObserver 行锚点扫描),仅提供浮动面板;**零外部依赖**(无 toast 依赖,反馈走 console)。
- 与其互斥字段集不重叠,可共存;但两者都写 `providers.<route>.models` 数组,同时打开编辑时后保存者以最新基线合并,不丢对方字段。

## 安装(经 npm,由 GitHub Actions 自动发布)

```sh
dsh plugin --profile web add @cliii-one/dsh-thinking-levels
```

重启 DeepSeek Harness 后生效。发版流程:改 `package.json` 的 `version` + push 到 main,工作流跑单测通过后自动 `npm publish`(需仓库配置 `NPM_TOKEN` secret;scoped 包首次发布无需额外参数,工作流已带 `--access public`)。

## 开发

```sh
npm test   # node --test test/*.test.mjs,纯逻辑层单测,无外部依赖
```

覆盖:档位判定表与拼写回填、异型基线守卫、整组写回基线合并、孤儿草稿上报、settings 双面适配(含信封拆包与错误透传)、冲突重读重放与二次冲突终止、只读拒绝、一键草稿填充、标题精确匹配。

## License

MIT
