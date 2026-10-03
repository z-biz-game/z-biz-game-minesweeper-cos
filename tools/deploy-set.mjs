#!/usr/bin/env node
// 部署集闸：按 pages.yml 用的那份清单真拷一遍产物，然后要求「页面会去要的东西」都在产物里。
//
// 这里防的是一整类本地看不见、CI 也不红的坏法：仓里没有构建步骤，index.html 直读仓库根，
// 所以本地永远自洽；上线的站点却是 tools/assemble-site.sh 拷出来的那一份。清单落后于页面
// （加了 manifest/图标/SW 却忘了加进 cp），线上就是 404，而引擎测试、浏览器闸全都跑的是
// 仓库根，一条都不会红。这个闸跑的是**产物**。
//
// 四类断言，各管一种真实的坏法：
//   W 清单与页面同源：assemble 脚本存在且被 workflow 引用；闸本身被 CI 引用
//     （否则 CI 拷的是另一份清单，本闸验的就不是上线那一份）
//   R 引用可达：从 index.html 出发，沿着**页面自己声明的取径**走一遍——href/src、它 link
//     的每份 CSS 里的 url()、manifest 的 icons/screenshots/shortcuts、它请的每个 script
//     背后的整条 import 图，以及每一站里的运行时路径（new URL / serviceWorker.register /
//     scope / './' 打头的字面量）。逐个必须在产物里存在且非 0 字节。
//   R 不许绝对路径：'/sw.js' 在 Pages 的 /<repo>/ 前缀下会跳出项目站点
//   P 位图不许说谎：manifest 声明的 sizes 必须等于 PNG IHDR 的真实宽高
//
// 防自己空转：条数钉在 EXPECT_CHECKS / EXPECT_ROWS，解析不到引用（而不是引用都齐）也是红。
// 这两条会不会真的红由 tools/deploy-set-selftest.mjs 当场证明（那支脚本把仓库复制到临时目录、
// 照着上面每一类各下一刀，并要求闸点名吃掉那一刀），所以钉数字不必靠人的记性。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSEMBLE = 'tools/assemble-site.sh';
// R 段实际检查的路径条数。改页面/清单会改变它——那正是要它变的时候；没改页面却掉了，
// 说明引用解析不出来的那部分被悄悄放过了。对着 DEPLOY_SET_DUMP=1 的出处表能逐条核。
const EXPECT_CHECKS = 31;
// 全绿时这个闸实际跑的断言条数（W/R/P 三段之和）。钉住它，「少一条断言」就不可能是绿的：
// 删掉 manifest 里的一张图标会同时少一条 R10 与那张的 P1/P2 两行——那条路径缺文件本来就该红，
// 但 rows 能漂就是闸在缩水的信号，所以两个数一起钉。
const EXPECT_ROWS = 49;

let rows = 0;
const fails = [];
const ok = (cond, label, detail) => {
  rows += 1;
  if (!cond) fails.push(`${label}${detail ? '  ' + detail : ''}`);
};

const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

// ---- A：清单与页面同源 ----
// 认的是**调用那一行**，不是文件里出现过这个路径：workflow 的注释本来就会解释为什么用脚本，
// 只 grep 字符串的断言会被一句散文喂绿——那正是这一路闸在别处犯过的错。
const ASSEMBLE_CALL = /(^|\n)[ \t]*run:[ \t]*(?:bash|sh)[ \t]+tools\/assemble-site\.sh[ \t]+\S/;
const GATE_CALL = /(^|\n)[ \t]*run:[ \t]*node[ \t]+tools\/deploy-set\.mjs\b/;
const wf = readIf(path.join(ROOT, '.github/workflows/pages.yml'));
ok(wf !== null, 'W1 workflow/pages.yml 读得到', wf === null ? '文件不存在' : '');
if (wf !== null) {
  ok(ASSEMBLE_CALL.test(wf), 'W2 pages.yml 里真的调了 tools/assemble-site.sh',
    'pages.yml 没有 run: bash tools/assemble-site.sh <dir>：CI 拷的是另一份清单，本闸验的不是上线那份');
}
const ci = readIf(path.join(ROOT, '.github/workflows/ci.yml'));
ok(ci !== null, 'W3 workflow/ci.yml 读得到', ci === null ? '文件不存在' : '');
if (ci !== null) {
  ok(GATE_CALL.test(ci), 'W4 每次 merge 前的 CI 调这道闸',
    'ci.yml 没有 run: node tools/deploy-set.mjs 这一步：只有部署时才查，坏清单能一路活到上线');
}

// ---- 产物：默认用同一支脚本拷到临时目录；给了目录参数就查那个目录 ----
// CI 传的就是它即将上传的那个 _site——查一份自己重新拷的副本，等于没查上线那份。
const given = process.argv[2];
let site;
let cleanup = false;
if (given) {
  site = path.resolve(given);
  if (!fs.existsSync(path.join(site, 'index.html'))) {
    console.log('FATAL 传进来的产物目录里没有 index.html：' + site);
    console.log('rows: 0');
    process.exit(1);
  }
} else {
  site = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-set-'));
  cleanup = true;
  try {
    execFileSync('bash', [path.join(ROOT, ASSEMBLE), site], { stdio: 'pipe' });
  } catch (e) {
    console.log('FATAL assemble 失败：' + (e.stderr || e.message).toString().trim());
    console.log('rows: 0');
    process.exit(1);
  }
}

const rel = (p) => p.replace(/^\.\//, '').split('?')[0].split('#')[0];
const present = (r) => {
  const f = path.join(site, r);
  return fs.existsSync(f) && fs.statSync(f).size > 0;
};

// Pages 的项目站点挂在 https://<org>.github.io/<slug>/ 下面，产物目录只是这个前缀**后面**的
// 东西。og:image 要写成绝对 URL（抓取器不会替我们补前缀），所以闸得先知道前缀是什么，否则
// "把 slug 写错"与"图不存在"在闸眼里长得一模一样。
// 来源只认仓里那一份声明：README 的 https://…github.io/<slug>。不认 basename(ROOT)——这一仓
// 的 slug 与目录名可以不同（远端叫 pentapack-cos，目录叫 z-biz-game-pentapack-cos），而台架
// 的副本目录名更是随路径漂（它在 /tmp/ds-selftest-xxx/repo 里跑），拿目录名推前缀等于让闸
// 在副本上天生红。
const PAGES = ((readIf(path.join(ROOT, 'README.md')) || '')
  .match(/https?:\/\/[A-Za-z0-9._-]+\.github\.io\/[A-Za-z0-9._-]+/) || [])[0] || '';

// ---- B：引用可达 ----
// 引用不靠手打名单：只有一个入口，index.html 声明的取径；走多远由取径自己决定——每条引用
// 解析出来是个 .js/.css 就把它也当作一站，模块图于是自己把整条链交出来。手打名单漏扫的时候
// 本闸照样绿，而「名单漏扫」与「清单漏拷」是同一件事的两侧。
const html = readIf(path.join(ROOT, 'index.html')) || '';
const refs = []; // [出处, 声明串, 这串依附的目录（相对仓根；'' = 文档根，也就是 index.html 所在处）]
const push = (from, spec, at) => {
  const s = String(spec).trim();
  if (s) refs.push([from, s, at || '']);
};

const SKIP = ['data:', 'mailto:', 'blob:', '#', 'http:', 'https:'];
const external = (s) => SKIP.some((p) => s.startsWith(p));

// './x'、'../../assets/x.png' 这种自相对字面量：模块图的边、纹理名都是这个形状。
// 只在**去掉注释之后**的代码上匹配：散文不是引用——把它算进来，改一句注释就能把钉住的
// 条数顶歪，而下一次顶歪的人看见的 FAIL 跟自己的改动毫无关系。
const SELF_REL = /['"](\.{1,2}\/[^'"\n]+)['"]/g;
// 剩下的是「不带 ./ 的裸文件名」，只能靠调用点认。document.baseURI / serviceWorker.register /
// scope 都以文档为基，所以那几条形成的引用依附在仓根；new URL(x, import.meta.url) 以**本文件**
// 为基，这一条必须跟着文件走，跟着仓根走就查错了路径。
// register 那一条在两个点号前后都留 \s*：链式调用换行是 JS 的寻常写法（`navigator.serviceWorker`
// 一行、`.register(...)` 下一行），而这一条只用来决定**同一个字符串以什么为基**——认不出调用点
// 不会少查一条引用，只会让它退回按本文件解析，于是把一行正确的 register('./sw.js') 报成缺文件。
const CALL_SITES = [
  [/new URL\(\s*['"]([^'"]+)['"]\s*,\s*document\.baseURI/g, false],
  [/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g, true],
  [/navigator\s*\.\s*serviceWorker\s*\.\s*register\(\s*['"]([^'"]+)['"]/g, false],
  [/\bscope:\s*['"]([^'"]+)['"]/g, false],
];

// JS 去行注释与块注释（字符串内部不动，'https://' 里那两个斜杠不是注释）；CSS 只去块注释，
// 因为 url(//host/x) 那种协议相对写法在 CSS 里合法，按 JS 的规则切会把整行吃掉。
const stripComments = (src, blocksOnly) => {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (!blocksOnly && c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (!blocksOnly && (c === '"' || c === "'" || c === '`')) {
      const q = c;
      out += c; i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c; i += 1;
  }
  return out;
};

const dirOf = (r) => {
  const d = path.posix.dirname(r);
  return d === '.' ? '' : d;
};
// 目录或纯片段（'./'、'./#resume'）浏览器要的是那份文档本身。以前 rel() 把它们削成 ''，
// present('') 去 stat 产物目录——目录永远在、size 永远 > 0，那几条是假绿，一条也没验。
// 只认「文档根」这一种目录：'foo/' 不许跟着塌成 index.html，因为浏览器要的是 foo/index.html。
const resolveSpec = (specRaw, at) => {
  const s = String(specRaw).split('?')[0].split('#')[0];
  if (s === '' || s === '.' || s === './') return 'index.html';
  const joined = at ? path.posix.normalize(path.posix.join(at, s)) : s.replace(/^\.\//, '');
  return joined.endsWith('/') ? joined + 'index.html' : joined;
};

for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) push('index.html', m[1], '');

const mfText = readIf(path.join(ROOT, 'manifest.webmanifest'));
ok(mfText !== null, 'R1 manifest.webmanifest 在仓库根', '');
let mf = null;
if (mfText !== null) {
  try { mf = JSON.parse(mfText); } catch (e) { ok(false, 'R2 manifest 解析得了', String(e.message)); }
}
// manifest 里「带 src 的条目」只有一个收集口径：icons、screenshots、每条 shortcut 自己的
// icons。手写死名单会让某一种声明既不查可达也不查尺寸。
const entries = []; // [{from, src, sizes}]
if (mf) {
  for (const k of ['icons', 'screenshots']) {
    for (const i of mf[k] || []) {
      if (!i.src) continue;
      entries.push({ from: 'manifest.' + k, src: String(i.src).trim(), sizes: i.sizes });
    }
  }
  (mf.shortcuts || []).forEach((s, n) => {
    if (s.url) entries.push({ from: `manifest.shortcuts[${n}].url`, src: String(s.url).trim() });
    for (const i of s.icons || []) {
      if (!i.src) continue;
      entries.push({ from: `manifest.shortcuts[${n}].icons`, src: String(i.src).trim(), sizes: i.sizes });
    }
  });
  for (const e of entries) push(e.from, e.src, '');
  // 装不装得上取决于这几个字段在不在。scope 不在场时 Chrome 取 start_url 的目录，
  // Pages 前缀下那个目录就是站点根，所以它是「可缺省」而不是「必填」——但它在场就必须是相对的。
  const missing = ['name', 'short_name', 'start_url', 'display', 'theme_color',
    'background_color'].filter((k) => !mf[k]);
  ok(missing.length === 0, 'R3 manifest 六个必填字段都在', '缺 ' + missing.join(','));
  for (const k of ['start_url', 'scope']) {
    if (mf[k]) ok(!String(mf[k]).startsWith('/'), `R4 manifest.${k} 不能是绝对路径`,
      `${k}=${mf[k]} 在 Pages 的 /<repo>/ 前缀下会跳出项目站点`);
  }
  const big = (mf.icons || []).filter((i) => parseInt(String(i.sizes || '0x0'), 10) >= 512);
  ok(big.length > 0, 'R5 manifest 有 >=512 的图标（Chrome 否则不给安装提示）', '');
  const small = (mf.icons || []).filter((i) => {
    const n = parseInt(String(i.sizes || '0x0'), 10);
    return n >= 192 && n < 512;
  });
  ok(small.length > 0, 'R6 manifest 有 192~511 的图标（触屏主屏要的那一档）', '');
  // og:image 只在页面上确实写了这句话时成立：绝对 URL、指的就是**本站前缀下**的那一张，
  // 而那张图真在产物里。相对写法（assets/og.png）是这一条最初要抓的缺陷：抓取器读的是别人
  // 页面上的字符串，不会替 Pages 补 /<slug>/。但"绝对"本身不够——前缀抄错一个字母就是 404
  // 的卡片，所以拿 README 那份声明当尺子，量的不是"像不像绝对 URL"而是"是不是本站那一张"。
  const og = html.match(/property="og:image"\s+content="([^"]+)"/);
  if (og) {
    const v = og[1].trim();
    const detail = `og:image=${v} · README 声明的前缀 ${PAGES || '(解析不到)'}`;
    ok(v.startsWith(PAGES + '/') && present(decodeURIComponent(v.slice(PAGES.length + 1))),
      'R7 og:image 是本站绝对 URL 且那张图在产物里', detail);
  }
}

// 沿取径走：refs 边走边长，所以用下标扫而不是快照。
const scanned = new Set();
for (let k = 0; k < refs.length; k += 1) {
  const [from, spec, at] = refs[k];
  if (external(spec) || spec.startsWith('/')) continue; // 外链跳过；绝对路径由 R9 点名
  const r = resolveSpec(spec, at);
  if (!/\.(js|css)$/.test(r) || scanned.has(r)) continue;
  scanned.add(r);
  const text = readIf(path.join(ROOT, r));
  if (text === null) {
    ok(false, `R8 取径上的 ${r} 在仓库根读不到（读不到=这一站根本没扫）`, '出处 ' + from);
    continue;
  }
  if (r.endsWith('.css')) {
    for (const m of stripComments(text, true).matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      push(r, m[1], dirOf(r));
    }
    continue;
  }
  const code = stripComments(text, false);
  // 调用点优先于 SELF_REL：同一个字符串在一份文件里被两种形式认到时，只有调用点知道浏览器
  // 会拿谁作基。让 SELF_REL 也推进去不会多验一条——它按本文件解析出的那条路径根本没人请求，
  // 于是 register('./sw.js')（以文档为基，要的是仓根那份）会被报成缺 js/sw.js。
  const claimed = new Set();
  for (const [re, perFile] of CALL_SITES) {
    for (const m of code.matchAll(re)) { push(r, m[1], perFile ? dirOf(r) : ''); claimed.add(m[1]); }
  }
  for (const m of code.matchAll(SELF_REL)) {
    if (!claimed.has(m[1])) push(r, m[1], dirOf(r));
  }
}

// 钉住的条数要有人能对着源码核：DEPLOY_SET_DUMP=1 把每一条引用连同出处与解析结果打出来。
// 只打不计数，所以开着它跑，rows 与 EXPECT_ROWS 的关系不变。
if (process.env.DEPLOY_SET_DUMP) {
  for (const [from, spec, at] of refs) {
    console.log('ref\t' + from + '\t' + spec + (at ? '\t@' + at : '') + '\t=> ' +
      (external(spec) || spec.startsWith('/') ? '(不查：外链或绝对)' : resolveSpec(spec, at)));
  }
}

let checks = 0;
const counted = new Set();
for (const [from, spec, at] of refs) {
  if (external(spec)) continue;
  if (spec.startsWith('/')) {
    ok(false, `R9 绝对路径 ${spec} 会在 Pages 前缀下跳出站点`, '出处 ' + from);
    continue;
  }
  const r = resolveSpec(spec, at);
  const key = from + ' ' + spec + ' ' + r;
  if (counted.has(key)) continue; // 同一条字面量被两种形式认到（SELF_REL 与调用点），只查一次
  counted.add(key);
  checks += 1;
  ok(present(r), `R10 ${spec} 在部署产物里且非 0 字节`, '出处 ' + from + '，产物缺 ' + r);
}
// 解析不到引用就是闸空转，不是通过
ok(checks > 0, 'R11 至少解析出一条引用（0 条=引用没被读到，不是全都齐）', '实际 ' + checks + ' 条');
ok(checks === EXPECT_CHECKS, `R12 引用条数等于钉在文件里的 EXPECT_CHECKS（${EXPECT_CHECKS}）`,
  '实际 ' + checks + ' 条：改了页面就把 EXPECT_CHECKS 一起改，别让它默默变少');

// ---- D：位图不许说谎 ----
// 口径与 R 段同一份 entries：凡是 manifest 里声明了 sizes 的 PNG，声明值必须等于 IHDR 真实宽高。
// 同一张图被两处声明成同一个尺寸时只核一次，但缺文件的那条由 R 段点名，这里跳过不重复报。
let bitmaps = 0;
const sized = new Set();
for (const e of entries) {
  if (!e.sizes) continue;
  const r = rel(e.src);
  if (!/\.png$/i.test(r)) continue;
  const key = r + '@' + String(e.sizes);
  if (sized.has(key)) continue;
  sized.add(key);
  bitmaps += 1;
  const f = path.join(site, r);
  if (!fs.existsSync(f)) continue; // R 段已经报过缺文件
  const head = fs.readFileSync(f).subarray(0, 24);
  const isPng = head.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  ok(isPng, `P1 ${r} 是真 PNG 容器`, '不是 PNG 签名');
  if (!isPng) continue;
  const w = head.readUInt32BE(16), h = head.readUInt32BE(20);
  const [dw, dh] = String(e.sizes).split('x').map(Number);
  if (dw) ok(w === dw && h === dh, `P2 ${r} 实际 ${w}x${h} 等于声明的 ${e.sizes}`, '出处 ' + e.from);
}

if (cleanup) fs.rmSync(site, { recursive: true, force: true });

// 自计数：闸缩水必须先自己红。比较发生在计数之前，所以这里比的是「含这一条」的总数。
ok(rows + 1 === EXPECT_ROWS, `R13 这一次跑出的断言条数（含这一条）等于钉在文件里的 EXPECT_ROWS（${EXPECT_ROWS}）`,
  '实际 ' + (rows + 1) + ' 条');

for (const f of fails) console.log('  FAIL ' + f);
console.log(`部署集：${checks} 条引用（含 ${bitmaps} 张位图尺寸核对），失败 ${fails.length} 项`);
console.log(`rows: ${rows} fail: ${fails.length}`);
process.exit(fails.length === 0 && rows > 0 ? 0 : 1);
