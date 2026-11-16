/**
 * utils/trendChart.js
 * 轻量折线图绘制（基于小程序 Canvas 2D，纯绘制无第三方依赖）。
 *
 * 设计目标：
 *  - 支持多条数据系列（同一时间轴 xs）叠加绘制；
 *  - 坐标轴标签：Y 轴数值刻度、X 轴时间标签；
 *  - 触摸高亮：竖线 + 圆点 + 数值 tooltip；
 *  - 明暗主题自适应（调用方传入 theme）；
 *  - 绘制坐标使用 CSS 像素，调用方已按 dpr 缩放 ctx，保证清晰。
 *
 * 对外：drawTrendChart(opts) -> 返回可视区域信息 { plotLeft, plotWidth, xs }，供触摸命中测试复用。
 */

// 配色（与详情页数据卡片主色保持一致）
const LIGHT = {
  grid: '#eef1f6',
  axisText: '#9aa3b2',
  highlightLine: 'rgba(31,41,55,0.35)',
  pointStroke: '#ffffff',
  tooltipBg: 'rgba(255,255,255,0.96)',
  tooltipBorder: '#e3e7ee',
  tooltipTitle: '#6b7280',
  tooltipText: '#1f2937',
};
const DARK = {
  grid: 'rgba(255,255,255,0.08)',
  axisText: 'rgba(255,255,255,0.55)',
  highlightLine: 'rgba(255,255,255,0.3)',
  pointStroke: '#1c1e24',
  tooltipBg: 'rgba(36,38,46,0.96)',
  tooltipBorder: 'rgba(255,255,255,0.14)',
  tooltipTitle: 'rgba(255,255,255,0.6)',
  tooltipText: '#f3f4f6',
};

function palette(theme) {
  return theme === 'dark' ? DARK : LIGHT;
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatClock(ts) {
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

// 数值格式化：大数取整，小数保留 1 位，保证坐标轴与 tooltip 清晰
function formatNum(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 100) return String(Math.round(v));
  return (Math.round(v * 10) / 10).toFixed(1);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTooltip(ctx, P, o) {
  const { x, plotLeft, plotRight, plotTop, series, idx, xs } = o;
  const title = formatClock(xs[idx]);
  const lines = series.map((s) => ({
    name: s.name,
    color: s.color,
    text:
      typeof s.data[idx] === 'number' && isFinite(s.data[idx])
        ? formatNum(s.data[idx]) + (s.unit ? ' ' + s.unit : '')
        : '—',
  }));

  ctx.font = '11px sans-serif';
  let maxW = ctx.measureText(title).width;
  lines.forEach((l) => {
    const w = ctx.measureText(l.name + ': ' + l.text).width;
    if (w > maxW) maxW = w;
  });

  const padX = 10;
  const lh = 16;
  const boxW = maxW + padX * 2;
  const boxH = lh * (lines.length + 1) + 8;

  // 默认放在手指右侧；空间不足则翻到左侧，再不足则贴左边界
  let bx = x + 12;
  if (bx + boxW > plotRight) bx = x - boxW - 12;
  if (bx < plotLeft) bx = plotLeft;
  const by = plotTop + 6;

  ctx.fillStyle = P.tooltipBg;
  roundRect(ctx, bx, by, boxW, boxH, 8);
  ctx.fill();
  ctx.strokeStyle = P.tooltipBorder;
  ctx.lineWidth = 1;
  roundRect(ctx, bx, by, boxW, boxH, 8);
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = P.tooltipTitle;
  ctx.fillText(title, bx + padX, by + lh / 2 + 4);
  lines.forEach((l, i) => {
    const ly = by + lh + i * lh + 4;
    ctx.fillStyle = l.color;
    ctx.fillRect(bx + padX, ly - 4, 8, 8);
    ctx.fillStyle = P.tooltipText;
    ctx.fillText(l.name + ': ' + l.text, bx + padX + 14, ly);
  });
}

/**
 * 绘制折线图。
 * opts:
 *  ctx       Canvas 2D 上下文（已按 dpr 缩放）
 *  width     CSS 像素宽
 *  height    CSS 像素高
 *  xs        number[] 时间戳（毫秒，升序）
 *  series    [{ name, color, unit, data: number[] }] 与 xs 等长
 *  theme     'light' | 'dark'
 *  highlight 可选，命中点的局部索引（相对 xs）
 * 返回 { plotLeft, plotWidth, xs }
 */
function drawTrendChart(opts) {
  const { ctx, width, height, xs, series, theme, highlight } = opts;
  const P = palette(theme);
  ctx.clearRect(0, 0, width, height);

  const padL = 46;
  const padR = 14;
  const padT = 16;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const plotLeft = padL;
  const plotTop = padT;
  const plotBottom = padT + plotH;
  const plotRight = plotLeft + plotW;

  const n = xs.length;

  // Y 轴值域（跨所有系列）
  let min = Infinity;
  let max = -Infinity;
  series.forEach((s) => {
    s.data.forEach((v) => {
      if (typeof v === 'number' && isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    });
  });
  if (!isFinite(min)) {
    min = 0;
    max = 1;
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const yPad = (max - min) * 0.08;
  min -= yPad;
  max += yPad;

  const xAt = (i) => plotLeft + (n === 1 ? 0 : (i / (n - 1)) * plotW);
  const yAt = (v) => plotBottom - ((v - min) / (max - min)) * plotH;

  // 横向网格 + Y 轴刻度标签
  const ticks = 4;
  ctx.font = '10px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (let k = 0; k <= ticks; k++) {
    const val = min + (max - min) * (k / ticks);
    const y = yAt(val);
    ctx.strokeStyle = P.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
    ctx.fillStyle = P.axisText;
    ctx.fillText(formatNum(val), plotLeft - 6, y);
  }

  // X 轴时间标签（首 / 中 / 尾）
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelIdxs = n <= 2 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
  labelIdxs.forEach((i) => {
    ctx.fillStyle = P.axisText;
    ctx.fillText(formatClock(xs[i]), xAt(i), plotBottom + 6);
  });

  // 各系列折线
  series.forEach((s) => {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = s.data[i];
      if (typeof v !== 'number' || !isFinite(v)) {
        started = false; // 断点不连线
        continue;
      }
      const x = xAt(i);
      const y = yAt(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  });

  // 触摸高亮
  let hlLocal = null;
  if (typeof highlight === 'number' && highlight >= 0 && highlight < n) {
    hlLocal = highlight;
    const hx = xAt(hlLocal);
    ctx.strokeStyle = P.highlightLine;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, plotTop);
    ctx.lineTo(hx, plotBottom);
    ctx.stroke();
    ctx.setLineDash([]);

    series.forEach((s) => {
      const v = s.data[hlLocal];
      if (typeof v === 'number' && isFinite(v)) {
        const y = yAt(v);
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(hx, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = P.pointStroke;
        ctx.stroke();
      }
    });

    drawTooltip(ctx, P, { x: hx, plotLeft, plotRight, plotTop, series, idx: hlLocal, xs });
  }

  return { plotLeft, plotWidth: plotW, xs };
}

module.exports = { drawTrendChart };
