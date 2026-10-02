// 帧时钟：把 requestAnimationFrame 给的墙钟时间戳换算成"这一帧真实过了多久"。
//
// 为什么单独一个文件：帧长换算是最容易写错也最容易被"反正我机器是 60Hz"糊过去的一段，
// 而它一旦错了，所有动画与计时都变成帧率的函数——120Hz 的手机上雷会提前炸、30Hz 上会拖尾。
// 放进模块里，tools/rate-test.mjs 才能拿 30/60/120Hz 三档去对拍同一段代码。
//
// 这里刻意不做定步长子步（fixed step + 累加器）：本局没有连续物理，FX 进度是时间的线性函数
// (t = (clock - at) / Motion.pop)，按 dt 精确累加即与帧率无关；再套一层 1/60 定步长只会
// 引入最多一帧的量化误差，把本来对的实现弄成"30Hz 比 120Hz 慢半帧"。

export function createFrameClock({ maxStepMs = 250 } = {}) {
  let last = 0;
  let total = 0;
  let primed = false;

  return {
    // 返回本帧步长（毫秒）。首帧返回 0：headless 台架的时钟从 1000ms 起跳，页面挂起后
    // 唤回时时间戳能跳几十秒，把它当"上一帧"就凭空造出一个巨型步长。
    frame(now) {
      if (!primed) {
        primed = true;
        last = now;
        return 0;
      }
      const dt = now - last;
      last = now;
      if (!(dt > 0)) return 0;                    // 时间戳回拨或同帧重复
      total += dt > maxStepMs ? maxStepMs : dt;   // 切后台回来分帧补，不一次跳完
      return dt > maxStepMs ? maxStepMs : dt;
    },
    get elapsed() {
      return total;
    },
    reset() {
      last = 0;
      total = 0;
      primed = false;
    },
  };
}
