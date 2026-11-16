/**
 * pages/detail/detail.js —— 单设备详情
 */
const app = getApp();
const dateUtil = require('../../utils/date.js');
const { iconEmoji, typeLabel, thresholdFields, displayName } = require('../../utils/deviceParser.js');
const { drawTrendChart } = require('../../utils/trendChart.js');

Page({
  data: {
    device: null,
    connected: false,
    themeClass: '',
    chart: { hasData: false, series: [] }, // 折线图图例/空态用（数据量大，绘制用 this._chartSeries 避免 setData 负担）
    chartRange: 'all', // 'all' | '1m' | '5m'
  },

  onLoad(options) {
    this.id = options.id;
    this._listener = this.onUpdate.bind(this);
    this._statusListener = (c) => this.setData({ connected: c });
    this._alertListener = this.onAlert.bind(this);
    this._hl = null; // 折线图触摸高亮索引（相对当前可视窗口）
  },

  onShow() {
    app.addListener(this._listener);
    app.addStatusListener(this._statusListener);
    app.addAlertListener(this._alertListener);
    app.syncTheme(this);
    this.setData({ connected: app.globalData.connected });
    this.loadDevice();
    // 主题切换时重绘折线图（canvas 无法读取 CSS 变量，需主动重绘）
    if (wx.onThemeChange) {
      this._themeHandler = () => this.renderChart();
      wx.onThemeChange(this._themeHandler);
    }
  },

  onReady() {
    this.ensureCanvas();
  },

  onHide() {
    app.removeListener(this._listener);
    app.removeStatusListener(this._statusListener);
    app.removeAlertListener(this._alertListener);
    app.unsyncTheme(this);
    if (wx.offThemeChange && this._themeHandler) {
      wx.offThemeChange(this._themeHandler);
      this._themeHandler = null;
    }
  },

  loadDevice() {
    const dev =
      app.globalData.devices.find((d) => d.id === this.id) ||
      require('../../utils/storage.js').getDevices().find((d) => d.id === this.id);
    if (!dev) {
      wx.showToast({ title: '设备不存在', icon: 'none' });
      return;
    }
    this.setData({ device: this.decorate(dev) });
    this.buildChart(dev);
    this.renderChart();
  },

  onUpdate(dev) {
    if (!dev || dev.id === this.id) this.loadDevice();
  },

  decorate(d) {
    const base = {
      id: d.id,
      name: d.name,
      displayName: displayName(d),
      type: d.type,
      topic: d.topic,
      online: !!d.online,
      emoji: iconEmoji(d.type),
      typeText: typeLabel(d.type),
      lastUpdateText: d.lastUpdate ? dateUtil.formatDateTime(d.lastUpdate) : '',
      alert: !!d.alert,
      alertText: d.alertText || '',
      thresholds: d.thresholds || { enabled: false },
      thresholdFields: thresholdFields(d.type),
    };
    if (d.type === 'light') return Object.assign(base, { state: d.state || 'off' });
    if (d.type === 'humiture') return Object.assign(base, { temp: d.temp != null ? d.temp : '—', hum: d.hum != null ? d.hum : '—' });
    return Object.assign(base, { value: d.value != null ? d.value : '—', unit: d.unit || '' });
  },

  // ---------- 折线图 ----------
  // 由设备历史时序构建绘制用的 series（数值数组），并把图例/空态信息写回 setData
  buildChart(dev) {
    if (!dev || dev.type === 'light') {
      this._chartSeries = [];
      this._chartXs = [];
      this.setData({ chart: { hasData: false, series: [] } });
      return;
    }
    const hist = dev.history || [];
    const xs = hist.map((p) => p.t);
    let series;
    if (dev.type === 'humiture') {
      series = [
        { name: '温度', color: '#13c2c2', unit: '°C', data: hist.map((p) => p.temp) },
        { name: '湿度', color: '#52c41a', unit: '%', data: hist.map((p) => p.hum) },
      ];
    } else {
      const colorMap = { soil: '#52c41a', co2: '#8b5cf6', photores: '#fa8c16', sensor: '#3b82f6' };
      const nameMap = { soil: '土壤湿度', co2: 'CO₂', photores: '光照', sensor: '数值' };
      series = [
        {
          name: nameMap[dev.type] || '数值',
          color: colorMap[dev.type] || '#3b82f6',
          unit: dev.unit || '',
          data: hist.map((p) => p.value),
        },
      ];
    }
    this._chartSeries = series;
    this._chartXs = xs;
    this.setData({
      chart: {
        hasData: xs.length >= 2,
        series: series.map((s) => ({ name: s.name, color: s.color })),
      },
    });
  },

  // 查询并缓存 canvas 节点（Canvas 2D，按 dpr 缩放 ctx）
  ensureCanvas() {
    if (this._canvas || this._querying) {
      if (this._canvas) this.renderChart();
      return;
    }
    this._querying = true;
    const q = wx.createSelectorQuery();
    q.select('#trendCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        this._querying = false;
        if (!res || !res[0] || !res[0].node) return; // 灯光类无 canvas
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        let dpr = 2;
        try {
          dpr = wx.getSystemInfoSync().pixelRatio || 2;
        } catch (e) {}
        const cssW = res[0].width;
        const cssH = res[0].height;
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
        ctx.scale(dpr, dpr);
        this._canvas = canvas;
        this._ctx = ctx;
        this._cssW = cssW;
        this._cssH = cssH;
        this.renderChart();
      });
  },

  renderChart() {
    if (!this._canvas) {
      this.ensureCanvas();
      return;
    }
    const series = this._chartSeries;
    const xs = this._chartXs;
    if (!series || !series.length || !xs || xs.length < 2) {
      this.clearChart();
      return;
    }
    const range = this.data.chartRange || 'all';
    const now = Date.now();
    let startIdx = 0;
    if (range === '1m') startIdx = this._idxFromTime(now - 60000);
    else if (range === '5m') startIdx = this._idxFromTime(now - 300000);
    const fxs = xs.slice(startIdx);
    const fseries = series.map((s) => Object.assign({}, s, { data: s.data.slice(startIdx) }));
    if (fxs.length < 2) {
      this.clearChart();
      return;
    }
    const view = drawTrendChart({
      ctx: this._ctx,
      width: this._cssW,
      height: this._cssH,
      xs: fxs,
      series: fseries,
      theme: app.globalData.theme,
      highlight: this._hl,
    });
    this._view = view;
  },

  clearChart() {
    if (this._canvas && this._ctx) this._ctx.clearRect(0, 0, this._cssW, this._cssH);
  },

  _idxFromTime(t) {
    const xs = this._chartXs;
    if (!xs || !xs.length) return 0;
    for (let i = 0; i < xs.length; i++) if (xs[i] >= t) return i;
    return xs.length - 1;
  },

  _idxFromX(x) {
    const v = this._view;
    if (!v) return null;
    const n = v.xs.length;
    if (n < 2) return null;
    let r = (x - v.plotLeft) / v.plotWidth;
    if (r < 0) r = 0;
    if (r > 1) r = 1;
    return Math.round(r * (n - 1));
  },

  setRange(e) {
    const range = e.currentTarget.dataset.range;
    if (range === this.data.chartRange) return;
    this.setData({ chartRange: range }, () => this.renderChart());
  },

  // 触摸高亮：把触摸 x 映射到最近数据点并红绘
  onChartTouch(e) {
    if (!this._canvas) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const idx = this._idxFromX(t.x);
    if (idx == null) return;
    this._hl = idx;
    this.renderChart();
  },

  onChartTouchEnd() {
    this._hl = null;
    this.renderChart();
  },

  // ---------- 交互（开关/阈值） ----------
  toggleLight() {
    const d = this.data.device;
    if (!d) return;
    const next = d.state === 'on' ? 'off' : 'on';
    const ok = app.publish(d.topic, next);
    if (!ok) {
      wx.showToast({ title: '未连接，无法控制', icon: 'none' });
      return;
    }
    this.setData({ ['device.state']: next }); // 乐观更新，真实状态以回传为准
  },

  // 越限告警：仅当前设备弹提示 + 震动
  onAlert(text, dev) {
    if (dev && dev.id !== this.id) return;
    wx.showToast({ title: text, icon: 'none' });
    if (wx.vibrateShort) wx.vibrateShort({ type: 'medium' });
  },

  onThresholdToggle(e) {
    const th = Object.assign({}, this.data.device.thresholds, { enabled: e.detail.value });
    this.applyThresholds(th);
  },

  onThresholdInput(e) {
    const key = e.currentTarget.dataset.key;
    const raw = e.detail.value;
    let v = raw === '' ? null : parseFloat(raw);
    if (v !== null && isNaN(v)) v = null;
    const th = Object.assign({}, this.data.device.thresholds, { [key]: v });
    this.applyThresholds(th);
  },

  applyThresholds(th) {
    this.setData({ ['device.thresholds']: th });
    app.saveDevicePatch(this.id, { thresholds: th });
  },

  onPullDownRefresh() {
    this.loadDevice();
    wx.stopPullDownRefresh();
  },
});
