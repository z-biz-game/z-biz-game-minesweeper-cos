# 设计文档 · 扫雷 Minesweeper（零猜测版）

面向维护者的技术说明：为什么这样实现、哪些不变量不能破坏、踩过的坑写在哪。
玩法与承诺清单在 [README.md](README.md)，验证矩阵也在那边。

---

## 1. 选型：为什么是浏览器而不是 SwiftUI

本组织的游戏仓有两套栈：SwiftUI + XcodeGen（`-ios`）与 Web/Canvas（`-cos`）。这个仓选后者，
理由不是"Web 更时髦"，而是**治理规则 2：交付报告里的每一条声称必须可核**。

- 这台机器只有 CommandLineTools：`xcodegen not found`，`xcodebuild` 需要完整 Xcode。
  写 Swift 就**无法编译验证**，只能靠读代码声称"能跑"——那正是假通过的温床。
- 浏览器栈的验证环是一条命令：起服务 → 开无头 Chrome → CDP 注入真实 PointerEvent →
  读运行时对象 → 断言。同一份代码直接发到 GitHub Pages，别人**点链接就能玩**。
- 扫雷的难点在**推理机制与求解器可信度**，不在渲染。Canvas 2D 在这个品类里没有天花板问题。

代价：Electron 壳是本机的，`-ios` 那批仓的 App Store 分发路径这里没有。

## 2. 一个机制，四处复用

承重结构是 `js/engine/solver.js`。它同时是四样东西：

| 用途 | 走哪条路 |
|---|---|
| 零猜测证明 | `solve()` 从开局格扫到不动点；安全格全开 ⇒ 这局可发 |
| 难度量尺 | `grade()` 数它跑了几趟 pass、最长跨度、有没有用到相减/总账 |
| 提示引擎 | `nextHint()` 返回带 `rule` 的一步，提示就是"这一步 + 它依据的规则" |
| 测试预言机 | `verify engine` / `npm test` 用它复核生成器，再用它把盘打通 |

架构上由此定死一条：**不能有第二套"给测试用的规则实现"**。`window.minesweeper` 暴露的每个入口
（`dig` / `flag` / `chord` / `useHint` / `tap`）都是手指走的那条路。第二条路会让测试通过而游戏是坏的。

不过"同一个求解器自己给自己发合格证"仍然是循环论证，所以独立性靠**三段不同的代码**：
`solve()`（批量、带 events 账本）判可发；`nextHint()`（单步、只看当前盘面）给建议；
`Game`（dig/flood/chord/自动插旗/胜负）执行。`npm test` 让后两者把 40 局真打完，
任何一段说谎都会露馅。

## 3. 全局不变量（破坏即出 bug）

### 3.1 种子的两层
```
originSeed  玩家/存档看到的种子，例如 'daily|2026-09-27'
base        generate() 内部派生的 `${seed}|${tier}|${size}`，写进 puzzle.seed
```
存档必须存 `originSeed`（`Store.saveResume` 里 `puzzle.originSeed || puzzle.seed`）。否则"继续本局"
会把 `base` 当种子再派生一次，生成一片**尺寸相同但雷位不同**的雷区，而 RLE 盘面照旧恢复成功——
玩家看到的是若干格被凭空翻开或合上，且没有任何一处会报错。

### 3.2 一次动作 = 一个撤销 entry
`this.move` 是当前 entry，`owns = !this.move` 决定谁负责收尾。`commit()` 的顺序是刻意的：

1. 先把 entry **推进 `history`、`moves++`**；
2. 然后**保持这个数组为 open**（`this.move = entry`）再跑 `afterChange()`，于是 `autoFlag()`
   追加的旗落进**同一个 entry** ⇒ 一次撤销同时收回开花与它换来的旗；
3. 最后才 `this.move = null` 并广播 `commit`。

`moves++` 必须在 `afterChange()` **之前**：否则赢家那一笔没入账，结算页步数永远少一步。
`flood`/`openCell`/`chordPlan` 全是纯函数，只有 `Game.write()` 改状态——这是"一次点开 21 格、
撤销只退一步"能成立的唯一原因，也是求解器能在不碰玩家盘面的情况下预演的原因。

### 3.3 撤销不退还步数
`undo()` 只回滚格子，不动 `moves`；`redo()` 把 entry 推回 `history` 也**不**再计数。
如果撤销退还步数而重做不补，`undo/redo` 来回就能把一局刷成"0 步"，而步数是成绩判优的第二关键字。
`verify play` 钉住了这一对。

### 3.4 提示先把旗当知识，再和真图对账
`nextHint()` 把玩家已插的旗喂进 `constraintsFor(field, knownMine)`：旗即公理。
不这样做的话，玩家每插一面旗都会削弱下一次求助（提示会去推那些"旗已经说明白"的格）。

代价是**公理可能是错的**，所以每条建议都要拿去和 `field.mines` 对账：
相符 ⇒ 正常给；矛盾 ⇒ 一定是某面旗插错了，此时**绝不**输出"挖这里"，改输出 `unflag` 并真的拔掉。
`verify hint` 断言：错误旗的点名数 = 拔除数，且全程 0 次致命提示。

开局那一格是**免费**的一步（`hint()` 在 `!hasOpened()` 时直接 dig 开局格、不 `hintsUsed++`）：
它是布雷规则保证安全的格，不是玩家漏掉的推理；而 `hintsUsed` 是成绩判优的第一关键字，
收这一格的钱等于把"求助过没有"这条线画歪。

### 3.5 尺寸与颜色只有一个来源
`js/theme.js` 是唯一的令牌表，`applyThemeVars()` 注入成 CSS 自定义属性，样式表和 canvas 读同一份。
`BoardView.layout()` 从容器尺寸**推导** cell 边长（`Cell.min 17 … Cell.max 46`）。
17px 是可读性底线而不是偏好：再往下数字和雷是同一团糊，所以 30 宽的盘在手机上宁可横向滚动。

### 3.6 3BV 必须用 `flood` 本体量
`grade()` 里的 3BV 是"调用真正的 `flood()` 数需要几次点击"，不是另写一份邻接估计。
两套实现必然漂移，而漂移的后果是**难度分与玩家实际点击数说的不是一件事**——
README 里那张实测表就成了一句修辞。

### 3.7 难度带是读出来的，不是调出来的
`TIERS[].band` 必须与 `npm run balance` 打印的分位一致（`generate.js` 顶部抄了整张表，含日期）。
改了 `grade()` 权重或 `solver.js` 的规则 ⇒ **重跑 balance、重写 band、更新那张表**。
手改 band 让它"看起来对"会让生成器退化成随机布雷：带子高过可达上限时不会报错，只会
永远返回"最接近的那个失败候选"，症状是突击队变成"加载很慢的那一档"。
`npm test` 与 `verify gen` 都断言 in-band 命中率、每盘尝试次数上限、以及**五档分数带互不重叠**。

### 3.8 存档必须带代价
`saveResume()` 除了 RLE 盘面还存 `moves` / `hints`，`begin({restore})` 再把它们装回 `Game`。
少了这两个数，"取六次求助 → 关标签页 → 回来收官"就能交出一份 `求助 0` 的纪录——
成绩判优的第一关键字直接失效。`verify save`/`verify resume` 各钉了一遍。

## 4. 踩过的坑

- **忽略玩家的旗，提示就不可用**：`nextHint` 早期版本把旗当噪声，结果五档全部推不完
  （旗一旦落下，后续步骤反复被同一格绊住）。修法见 §3.4。
- **突击队永远差一格**：30×16 盘上求解器停在"1 个安全格未开、99 面旗已满"。单线索与相减
  都读不出这一步，能读出的只有**全局雷数总账**。所以 `budget` 是第三条 pass，也是 `grade()`
  里权重最高的一项（+10）：用到它的盘确实更难。
- **`case 'over'` 写了两次**：和弦超插与"这一局已结束"都叫 `over`，第二个分支是死代码，
  症状是死盘回答"旗插得比数字还多"。现在结算态叫 `finished`，`engine-test` 断言两者不同名。
- **挖开会毁掉玩家自己插的旗**：`dig()` 早期对 FLAG 格照挖。旗是已经做出的断言，
  穿过去不是信息而是手滑，现在直接拒绝并提示"先拔掉"（问号格仍然可挖：它是备忘不是答案）。
- **`chordPlan` 先判 `done` 再判 `over`**：一个只剩 1 个未知格的线索，超插时回答的是
  "周围没有未知格了"而不是"旗多了"。这是对的（两者都为真，前者更具体），但测试夹具必须
  准备 ≥2 个未知安全格，否则"超插被拒"这条断言根本走不到那个分支。
- **`.hidden = true` 不等于看不见**。UA 样式表的 `[hidden] { display: none }` 特异性是 0，
  任何作者层 `display` 都能压过去。于是 `css/game.css` 顶部有一条 `[hidden] { display: none !important; }`
  统一兜住，屏切换的断言只问布局（`getClientRects()`）不问标志。加新的可隐藏元素不要写局部补丁。
- **测试自己也会说谎**：`tools/scenarios.js` 的 `done()` 必须 `splice` 出快照，返回 live 数组再清空
  会让每个场景报 `0 checks` 却仍带着失败计数——一份"看着像绿"的报告。`verify.sh` 对零断言直接判失败。
- **无头截图会拿到旧帧**：`show('menu')` 之后 DOM 已经是菜单（`getClientRects()` 证明），
  `Page.captureScreenshot` 却仍给出上一屏——后台标签页只在**有重绘**时推帧，纯 CSS 显隐不产生帧。
  `playtest.cjs shot` 现在先 `Page.bringToFront`。读截图的人以为界面坏了，其实是取证的方式错了。
- **端口 5217 上可能端着别的 app**：本组织另一个 `-cos` 仓的服务器长期占着它，`curl` 拿到的是
  别人的 `index.html`，页面加载"成功"而 `window.minesweeper` 永远不出现。`verify.sh` 现在
  在开浏览器之前先 grep 首页里确实有 minesweeper 字样；跑测试请显式给 `HTTP_PORT=`。
- **`navigator.vibrate` 与 `AudioContext` 要问浏览器而不是问事件**：合成 `PointerEvent` 也会到达
  监听器，据它解锁只会刷一串 console error 把真报错埋掉。判据用 `navigator.userActivation.hasBeenActive`。
- **落盘时机是"一次提交"，不是"一个格"**：`flushResume()` 的门闩看 `game.moves` 而不是
  `history.length`（entry 要到 `commit()` 才进 history，用后者会静默跳过每一局的第一步）。
  `pagehide` / `visibilitychange` 走同步 `flushResume()`，不等 400ms 防抖。

## 5. 验证台的操作细节

```bash
SCENARIOS="play hint" ./tools/verify.sh     # 只跑指定场景
HTTP_PORT=5300 ./tools/verify.sh            # 换端口（见上）
BASE_URL=https://… ./tools/verify.sh        # 打线上：同一套断言，验的是部署后的产物
SHOTS=dev ./tools/verify.sh                 # 追加 menu / board / win 三张截图到 tools/shots/
```

- **不要加** `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`：
  软件光栅会占满所有核心，且没有 CDP 客户端时 Chrome 不会自己退出（这条坑还烧过本机电池）。
- **`document.hidden` 必须强制 false**，否则无头模式认为页面在后台，渲染循环跳帧，
  依赖 rAF 的场景会对着一个"其实在跑"的浏览器超时。
- `save` / `resume` 两个场景**必须同一次跑**：它们共用同一个全新 `--user-data-dir`，
  存档只活在那次会话的 `localStorage` 里。单独跑 `resume` 必然报"没有存档"。
- `playtest.cjs` 把机器可读结论放在**最后一行**（`RESULT <json>`），console 噪声走 stderr。
- 等待用轮询 `/json/version` 与 `window.minesweeper.version`，不用 `sleep`——全新
  `--user-data-dir` 绑定 DevTools 的时间是不定的。
- 结算页有 900ms 的动画窗口，场景里的 `settled()` 会等它过去再断言文案；只 `sleep` 固定时长
  会让断言在慢机器上随机失败。

## 6. 文件地图

```
js/engine/rng.js       (45)  FNV-1a + mulberry32；dateSeed()：一切盘面按种子寻址
js/engine/field.js     (166) 状态常量、邻接表、flood/openCell/chordPlan/isWin/3BV —— 纯函数
js/engine/solver.js    (317) constraintsFor、solve()（批量）、nextHint()（单步 + 规则文案）
js/engine/generate.js  (165) TIERS 与实测 band、layMines(禁区)、grade()、attempt()/generate()
js/theme.js            (88)  令牌 + applyThemeVars() + 动效开关并集
js/audio/synth.js      (85)  零素材 WebAudio：dig/flood/flag/unflag/chord/boom/hint/win
js/store.js            (158) 单键 localStorage、RLE 盘面、recordBest 判优、markDaily、resume 代价
js/render/board.js     (292) layout() 推导尺寸、hitTest()、render()（旗/雷/数字/开花/爆炸/光标）
js/ui/game.js          (399) Game：动作与撤销 entry、自动插旗、hint 对账、计时与暂停
js/main.js             (823) 三屏路由、菜单、输入接线、结算文案、window.minesweeper 验证入口
tools/                         engine-test(466) / balance(129) / playtest CDP(186) / scenarios(613) / verify.sh(122)
```

## 7. 明确不做

- 不做"只有文件没有接线"的幽灵功能：新模块必须被视图或引擎真实调用。
- 不加运行时依赖。扫雷不需要后端、不需要打包器；加一个就等于把 CI 变成网络的函数。
- 不做需要猜的盘。宁可某些种子生成失败、退回更简单的档，也不上线"看起来无解"的雷区。
- 不做"托管自动解题"给玩家：`solveWithLogic()` 只挂在 `window.minesweeper` 上给验证台用，
  一键通关会把这款游戏唯一的内容（推理过程）抹掉。
