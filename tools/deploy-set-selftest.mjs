#!/usr/bin/env node
// 部署集闸的阴性自证：把仓库复制到临时目录，照着闸的每一类断言各下一刀，要求闸**点名**吃掉
// 那一刀；再来一刀本该无效的（写在注释里的假路径），要求它按无效算。
//
// 为什么这道脚本要住在仓里、进 CI：闸钉了 EXPECT_CHECKS / EXPECT_ROWS，但"钉住的数字"本身
// 不能证明闸还在看东西——引用解析全断的时候条数会掉，可解析口径被改坏的时候条数也能刚好对上。
// 唯一能证明"这条断言真的会红"的办法是当场把它打红一次。这里每一刀都锚在仓库自己的内容上
// （从 DEPLOY_SET_DUMP=1 的出处表里挑靶子），所以仓与仓不同、页面改了，台架跟着走。
//
// 用法：node tools/deploy-set-selftest.mjs     （只读原仓；写都写在临时副本里）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 按**路径段**判，不按子串：'.git' 是 '.github' 的前缀，用子串过滤会把 workflow 整段丢掉，
// 台架于是在一份没有 workflow 的副本上跑——W1/W3 天生红，基线都没有起点。
const skip = (rel) => rel.split('/').some((s) => s === '.git' || s === 'node_modules' || s === '.qoder' ||
  s.startsWith('_tmp-'));
const COPIES = [];
function fresh() {
  // 每刀一个副本，副本留着：基线副本要当靶子源用到最后（早先每 fresh() 删上一个，
  // X7 挑靶子时基线已经不在盘上了，于是"没有靶子"被当成了这一仓的形状）。
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-selftest-'));
  COPIES.push(w);
  const dst = path.join(w, 'repo');
  fs.cpSync(ROOT, dst, { recursive: true, filter: (src) => !skip(path.relative(ROOT, src) || '') });
  return dst;
}
const line = (s) => console.log(s);

function gate(dir, env) {
  let out = '';
  let rc = 0;
  try {
    out = execFileSync('node', ['tools/deploy-set.mjs'],
      { cwd: dir, stdio: 'pipe', env: { ...process.env, ...(env || {}) } }).toString();
  } catch (e) {
    out = (e.stdout || '').toString() + (e.stderr || '').toString();
    rc = e.status === undefined ? 1 : e.status;
  }
  const lines = out.split('\n').filter((l) => l.trim() !== '');
  return {
    rc, lines,
    fails: lines.filter((l) => l.startsWith('  FAIL')),
    tally: (lines.find((l) => l.startsWith('部署集')) || '').trim(),
    checks: Number(((lines.find((l) => l.startsWith('部署集')) || '').match(/部署集：(\d+)/) || [])[1] || -1),
    rows: Number(((lines.find((l) => l.startsWith('rows:')) || '').match(/rows: (-?\d+)/) || [])[1] || -1),
  };
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const write = (dir, rel, txt) => fs.writeFileSync(path.join(dir, rel), txt);
// 每一刀都要有一根**唯一命中**的针：针打空了这一刀就没落地，"读数没变"会被当成闸失效。
function edit(dir, rel, needle, repl) {
  const t = read(dir, rel);
  const n = t.split(needle).length - 1;
  if (n !== 1) throw new Error(`needle ${JSON.stringify(needle).slice(0, 60)} 在 ${rel} 里命中 ${n} 次（要 1 次）`);
  write(dir, rel, t.split(needle).join(repl));
}
const mfOf = (dir) => JSON.parse(read(dir, 'manifest.webmanifest'));
const putMf = (dir, mf) => write(dir, 'manifest.webmanifest', JSON.stringify(mf, null, 2) + '\n');

const named = (res, want) => {
  const hit = res.fails.filter((l) => want.every((w) => l.includes(w)));
  return hit.length ? hit[0].trim() : null;
};

// ---- 基线：干净副本必须绿，且给台架交出靶子 ----
const base = fresh();
const baseRun = gate(base, { DEPLOY_SET_DUMP: '1' });
if (baseRun.rc !== 0) {
  line('BASELINE-RED 干净副本上闸就不绿，台架的期望（"打红之后 rc≠0"）没有起点');
  for (const l of baseRun.fails.slice(0, 12)) line('  ' + l.trim());
  line('DS_SELFTEST rc=1 BASELINE');
  process.exit(1);
}
// ref\t<出处>\t<声明串>[\t@<依附目录>]\t=> <解析结果>
const dump = baseRun.lines.filter((l) => l.startsWith('ref\t')).map((l) => {
  const f = l.split('\t');
  const withAt = f.length >= 5;
  return {
    from: f[1], spec: f[2], at: withAt ? f[3].replace(/^@/, '') : '',
    target: (withAt ? f[4] : f[3]).replace(/^=> /, ''),
  };
});
const real = (d) => d.target && !d.target.startsWith('(');
const pngRefs = dump.filter((d) => /\.(png|jpe?g|webp|svg)$/i.test(d.target) && real(d));
const jsEdge = dump.find((d) => /\.js$/.test(d.from) && /\.js$/.test(d.target) && real(d));
const cssFromDump = dump.filter((d) => /\.css$/.test(d.from)).map((d) => d.from);
const existing = (rel) => rel && fs.existsSync(path.join(base, rel));
const oneCssInDir = (rel) => (fs.existsSync(path.join(base, rel))
  ? fs.readdirSync(path.join(base, rel)).filter((f) => f.endsWith('.css')).map((f) => rel + '/' + f)[0] : null);
const cssFile = cssFromDump.find(existing) || oneCssInDir('css');
const jsFile = (dump.find((d) => /\.js$/.test(d.target) && d.target === 'js/main.js' && real(d)) || {}).target ||
  (fs.existsSync(path.join(base, 'js/main.js')) ? 'js/main.js' : null);
// R7 的两把刀要两枚靶子：页面上那句 og:image，和 README 里那份部署前缀声明（闸的 PAGES 就取它
// 的第一次出现）。读法与闸逐字一致，否则台架打的是空气。
const readOpt = (dir, rel) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), 'utf8') : '');
const ogTag = (readOpt(base, 'index.html').match(/property="og:image"\s+content="([^"]+)"/) || [])[1] || '';
const pagesUrl = (readOpt(base, 'README.md').match(/https?:\/\/[A-Za-z0-9._-]+\.github\.io\/[A-Za-z0-9._-]+/) || [])[0] || '';

line(`基线: rc=0 ${baseRun.tally} rows=${baseRun.rows} refs=${dump.length} 位图引用=${pngRefs.length}`);
const gaps = [];
if (!pngRefs.length) gaps.push('没解析到位图引用');
if (!jsEdge) gaps.push('没解析到模块图的边');
if (!cssFile) gaps.push('找不到可读的 CSS 站');
if (!jsFile) gaps.push('找不到可写注释的 JS 站');
if (gaps.length) {
  line(`COVERAGE 靶子不够：${gaps.join('、')}——这一仓的取径形状和台架假设不一致，去看 DEPLOY_SET_DUMP=1 的出处表`);
  line('DS_SELFTEST rc=1 COVERAGE');
  process.exit(1);
}

function knife(tag, want, mutate, note) {
  const dir = fresh();
  mutate(dir);
  const res = gate(dir);
  const hit = named(res, want);
  if (res.rc === 0) { line(`${tag} INERT · 这一刀没让闸红（FAIL=${res.fails.length}）`); return false; }
  if (!hit) {
    line(`${tag} UNNAMED · rc=${res.rc} 但没有一条 FAIL 同时含 ${want.join('+')}`);
    for (const l of res.fails.slice(0, 4)) line('      ' + l.trim());
    return false;
  }
  line(`${tag} OK · ${hit}${note ? ' · ' + note(res) : ''}`);
  return true;
}

let bad = 0;

// X1 清单落后于页面：assemble 不收位图目录。这一仓 55/59 走 icons/，2 个走 assets/，
// 期望由靶子自己决定，所以两个目录名都在针里。
if (!knife('X1 assemble 不收位图目录', ['R10', path.basename(pngRefs[0].target)], (dir) => {
  edit(dir, 'tools/assemble-site.sh', 'for d in icons assets; do', 'for d in probe_missing_dir; do');
})) bad += 1;

// X2 模块图的一条边改名：浏览器 404 整个文件，而这一站之后没人扫过。
const edgeBase = jsEdge.spec.replace(/^.*\//, '');
const mangled = edgeBase.replace(/\.js$/, '-GONE.js');
if (!knife('X2 模块边改名', ['R8', mangled], (dir) => {
  const t = read(dir, jsEdge.from);
  const re = new RegExp('([\'"])' + jsEdge.spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\1', 'g');
  const hits = t.match(re) || [];
  // 改名本来就该把这一文件里的每一处都改掉（kurotto 的 ./engine/generate.js 出现两次：一次 import、
  // 一次动态 import）。以前这里要求"正好一次"，两次就把台架自己炸了——剂量不该比现实挑写法。
  // 0 次仍然是"刀口打空"，那必须报错，不能静默当这一刀没下。
  if (!hits.length) throw new Error(`${jsEdge.spec} 在 ${jsEdge.from} 里一次都没出现（刀口打空）`);
  write(dir, jsEdge.from, t.replace(re, (m, q) => q + m.slice(1, -1).replace(edgeBase, mangled) + q));
})) bad += 1;

// X3 CSS 里写绝对路径：Pages 的 /<repo>/ 前缀下会跳出去。
if (!knife('X3 CSS url() 改成绝对路径', ['R9', '/probe-absolute.css'], (dir) => {
  write(dir, cssFile, read(dir, cssFile) + "\n#ds-probe{background:url('/probe-absolute.css')}\n");
})) bad += 1;

// X4 manifest.start_url 绝对。
if (!knife('X4 start_url 改绝对', ['R4', 'start_url'], (dir) => {
  const mf = mfOf(dir); mf.start_url = '/probe-absolute-root/'; putMf(dir, mf);
})) bad += 1;

// X5 删掉所有 >=512 的图标声明（Chrome 不给安装提示）。
if (!knife('X5 删光 >=512 图标', ['R5'], (dir) => {
  const mf = mfOf(dir);
  mf.icons = (mf.icons || []).filter((i) => parseInt(String(i.sizes || '0x0'), 10) < 512);
  putMf(dir, mf);
})) bad += 1;

// X6 少一个必填字段。
if (!knife('X6 manifest 少 display', ['R3', 'display'], (dir) => {
  const mf = mfOf(dir); delete mf.display; putMf(dir, mf);
})) bad += 1;

// X7 位图说谎：声明尺寸与 IHDR 不符。走 JSON 结构改那一条，不做文本替换——
// "512x512" 这种串在一个 manifest 里出现两次以上，文本替换会打到隔壁那条上。
const sizedRef = pngRefs.find((d) => d.from.startsWith('manifest.') &&
  fs.existsSync(path.join(base, d.target)));
if (sizedRef) {
  if (!knife('X7 manifest 尺寸与真图不符', ['P2', path.basename(sizedRef.target)], (dir) => {
    const mf = mfOf(dir);
    const hit = (mf.icons || []).find((i) => String(i.src).trim() === sizedRef.spec) ||
      (mf.screenshots || []).find((i) => String(i.src).trim() === sizedRef.spec);
    if (!hit || !hit.sizes) throw new Error(`${sizedRef.spec} 在 manifest 里没有可改的 sizes`);
    hit.sizes = '256x256';
    putMf(dir, mf);
  }, (res) => '声明被改成 256x256')) bad += 1;
} else {
  line('X7 SKIP 没有一张带 sizes 且真在产物里的 PNG 靶子（闸的 P 段在这一仓无可核对象）');
  bad += 1;
}

// X8 workflow 不走那份清单（回到手抄三行的世界）。针打的是**调用那一行**：pages.yml 的注释里
// 也写着这个路径，拿路径当针会命中两次，edit() 会拒绝——那正是 W2 不该认散文的理由。
if (!knife('X8 pages.yml 不调 assemble', ['W2'], (dir) => {
  edit(dir, '.github/workflows/pages.yml', 'run: bash tools/assemble-site.sh _site',
    'run: mkdir -p _site && cp index.html _site/');
})) bad += 1;

// X9 闸不在每次 merge 前的 CI 里跑：坏清单能一路活到上线。
if (!knife('X9 ci.yml 不跑闸', ['W4'], (dir) => {
  edit(dir, '.github/workflows/ci.yml', 'run: node tools/deploy-set.mjs',
    'run: node tools/deploy-set-removed.mjs');
})) bad += 1;

// X11/X12 打的是 R7 的两个方向：这句话退回相对写法（抓取器不补 /<slug>/，卡片没图），
// 以及它指着**别的** slug（前缀抄错一个字母就是一张 404 的卡片）。第二把尤其要紧——
// 只看"像不像绝对 URL"的写法两种都能放过去。
// 这一仓没写 og:image 时两把都没有靶子：R7 按设计只在页面上确实有这句话时才成立，
// 所以那是合法的 SKIP，不是台架漏了一类（漏了要把 bad 加上去，让 rc 说真话）。
if (ogTag) {
  // 不用 edit() 的"字面量唯一命中"：同一张图常被 og:image 与 twitter:image 写两遍（chomp 就是），
  // 拿 content="<url>" 当针会命中两次而 throw。这一刀要打的只有 og 那一句，所以按整条属性的
  // 第一个匹配切，并要求整页只有一句 og:image——两处都写着 og:image 时这一刀的靶子就不明确了。
  if (!knife('X11 og:image 退回相对路径', ['R7'], (dir) => {
    const t = read(dir, 'index.html');
    const re = /property="og:image"\s+content="([^"]+)"/;
    if ((t.match(new RegExp(re.source, 'g')) || []).length !== 1) {
      throw new Error('og:image 在 index.html 里不止一句，这一刀的靶子不明确');
    }
    const m = re.exec(t);
    write(dir, 'index.html', t.slice(0, m.index) +
      `property="og:image" content="${m[1].slice(pagesUrl.length + 1)}"` + t.slice(m.index + m[0].length));
  }, () => 'og 变成 ' + ogTag.slice(pagesUrl.length + 1))) bad += 1;
  if (!knife('X12 og:image 的前缀指向别的 slug', ['R7'], (dir) => {
    const t = read(dir, 'README.md');
    const i = t.indexOf(pagesUrl);
    if (i < 0) throw new Error('README 里找不到那份部署前缀声明（闸的 PAGES 没有来源）');
    const wrong = pagesUrl.replace(/\/[^/]+$/, '/probe-wrong-slug');
    write(dir, 'README.md', t.slice(0, i) + wrong + t.slice(i + pagesUrl.length));
  }, () => `README 的部署前缀改成 ${pagesUrl.replace(/\/[^/]+$/, '/probe-wrong-slug')}`)) bad += 1;
} else {
  line('X11/X12 SKIP · index.html 没有 property="og:image" content="…" 这一句（R7 对空集合成立）');
}

// X10 阴性对照：写在注释里的假路径**不能**算引用。它同时钉住"条数没漂"——散文被当成引用的时候
// 条数会多，而下一次顶歪数字的人看到的 FAIL 与自己的改动毫无关系。
{
  const dir = fresh();
  write(dir, jsFile, read(dir, jsFile) +
    "\n// ds-probe: './prose-only.png' 与 '../assets/textures/nope.png' 都只活在注释里。\n");
  const res = gate(dir);
  if (res.rc !== 0 || res.checks !== baseRun.checks || res.rows !== baseRun.rows) {
    line(`X10 注释里的假路径 INERT-CLAIM · rc=${res.rc} 条数=${res.checks}（应 ${baseRun.checks}）rows=${res.rows}（应 ${baseRun.rows}）`);
    for (const l of res.fails.slice(0, 4)) line('      ' + l.trim());
    bad += 1;
  } else {
    line(`X10 注释里的假路径 OK · 散文没被算成引用，条数仍 ${baseRun.checks}、rows 仍 ${baseRun.rows}`);
  }
}

for (const w of COPIES) fs.rmSync(w, { recursive: true, force: true });
line(`DS_SELFTEST rc=${bad}（0=每一刀都按预期发力、阴性对照按预期不发力）`);
line(`DS_SELFTEST_BASELINE ${baseRun.tally} rows=${baseRun.rows}`);
process.exit(bad === 0 ? 0 : 1);
