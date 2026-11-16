/**
 * app.js
 * 小程序入口：管理 MQTT 连接生命周期、全局设备状态、页面事件总线。
 *
 * 设计要点：
 *  - 连接由 app 统一维护（单例），各页面只读写 globalData.devices 并通过监听器刷新 UI。
 *  - 收到消息后更新全局设备状态并落盘，再通知已注册页面。
 *  - 订阅者在线：只要本机订阅成功即视为在线；收到任意数据消息 => 发布者在线。
 */

const MqttClient = require('./utils/mqttClient.js');
const storage = require('./utils/storage.js');
const { classify, parseSensor, evaluateAlert, appendHistory } = require('./utils/deviceParser.js');

const MQTT_URL = 'wss://bemfa.com:9504/wss';

App({
  globalData: {
    uid: '',
    connected: false,
    devices: [],
    client: null,
    theme: 'light', // 'light' | 'dark'，由系统/微信主题决定
  },

  // 页面监听器
  _listeners: [],
  _statusListeners: [],
  _alertListeners: [],
  _themePages: [],

  onLaunch() {
    const settings = storage.getSettings();
    this.globalData.uid = settings.uid;
    this.globalData.devices = storage.getDevices();
    // 兼容旧数据：巴法云主题是裸主题名（uid 仅作连接 clientId，不在主题里）。
    // 旧版本曾把 topic 存成 "uid/name"，需要归一化，否则订阅/匹配都收不到数据。
    let normalized = false;
    this.globalData.devices.forEach((d) => {
      if (d.topic && d.topic.indexOf('/') >= 0) {
        d.topic = d.name;
        normalized = true;
      }
    });
    if (normalized) this.persistDevices();
    this.initTheme();
    if (settings.uid) this.connectMqtt();
  },

  // ---- 主题适配：微信 dark mode 不触发 prefers-color-scheme，需主动监听 wx.onThemeChange ----
  initTheme() {
    let theme = 'light';
    try {
      const info = wx.getSystemInfoSync();
      if (info.theme === 'dark') theme = 'dark';
    } catch (e) {}
    this.globalData.theme = theme;
    if (wx.onThemeChange) {
      wx.onThemeChange((res) => {
        this.setTheme(res.theme === 'dark' ? 'dark' : 'light');
      });
    }
  },

  setTheme(theme) {
    if (this.globalData.theme === theme) return;
    this.globalData.theme = theme;
    const cls = theme === 'dark' ? 'dark' : '';
    this._themePages.slice().forEach((page) => {
      if (page && page.setData) page.setData({ themeClass: cls });
    });
  },

  syncTheme(page) {
    if (!page || !page.setData) return;
    const idx = this._themePages.indexOf(page);
    if (idx < 0) this._themePages.push(page);
    page.setData({ themeClass: this.globalData.theme === 'dark' ? 'dark' : '' });
  },

  unsyncTheme(page) {
    const idx = this._themePages.indexOf(page);
    if (idx >= 0) this._themePages.splice(idx, 1);
  },

  connectMqtt() {
    if (this.globalData.client && this.globalData.client.connected) return;
    const self = this;
    const client = new MqttClient({
      url: MQTT_URL,
      clientId: this.globalData.uid,
      onConnect() {
        self.globalData.connected = true;
        // 连接成功：已订阅设备订阅者在线
        self.globalData.devices.forEach((d) => {
          d.online = true;
        });
        self.persistDevices();
        const topics = self.globalData.devices.map((d) => d.topic).filter(Boolean);
        if (topics.length) client.subscribe(topics);
        self._emitStatus();
        self._notifyPages();
      },
      onClose() {
        self.globalData.connected = false;
        self._emitStatus();
        self._notifyPages();
      },
      onMessage(topic, payload) {
        self.handleMessage(topic, payload);
      },
      onError(err) {
        console.error('[app] mqtt error', err);
      },
    });
    this.globalData.client = client;
    client.connect();
  },

  handleMessage(topic, payload) {
    // 健壮匹配：云端下发的 topic 是裸主题名；兼容旧数据 "uid/name" 或带 /set、/up 后缀的情况。
    const t = (topic || '').trim();
    const dev = this.globalData.devices.find(
      (d) => d.topic === t || d.name === t || t.endsWith('/' + d.name)
    );
    if (!dev) return;
    const c = classify(payload);
    if (c.kind === 'subStatus') {
      dev.online = c.online;
    } else if (c.kind === 'pubStatus') {
      dev.publisherOnline = c.online;
    } else if (c.kind === 'data') {
      const parsed = parseSensor(dev.type, c.text);
      if (dev.type === 'light') {
        if (parsed.state === 'on') dev.state = 'on';
        else if (parsed.state === 'off') dev.state = 'off';
      } else {
        Object.assign(dev, parsed);
      }
      dev.publisherOnline = true; // 收到数据 => 发布者在线
      dev.lastUpdate = Date.now();
      appendHistory(dev); // 追加到历史时序，供详情页折线图使用
      this.checkAlerts(dev);
    }
    dev.online = true; // 本机已订阅
    this.persistDevices();
    this._notifyPages(dev);
  },

  publish(topic, message) {
    const client = this.globalData.client;
    if (client && client.connected) return client.publish(topic, message);
    return false;
  },

  // 设备列表变更后重新订阅
  reloadDevices() {
    this.globalData.devices = storage.getDevices();
    if (this.globalData.connected && this.globalData.client) {
      const topics = this.globalData.devices.map((d) => d.topic).filter(Boolean);
      if (topics.length) this.globalData.client.subscribe(topics);
    }
    this._notifyPages();
  },

  persistDevices() {
    storage.saveDevices(this.globalData.devices);
  },

  setUid(uid) {
    this.globalData.uid = uid;
    storage.saveSettings({ uid });
    if (this.globalData.client) this.globalData.client.close();
    this.globalData.client = null;
    this.globalData.connected = false;
    this.connectMqtt();
  },

  // ---- 事件总线 ----
  addListener(fn) {
    this._listeners.push(fn);
  },
  removeListener(fn) {
    const i = this._listeners.indexOf(fn);
    if (i >= 0) this._listeners.splice(i, 1);
  },
  _notifyPages(dev) {
    this._listeners.slice().forEach((fn) => fn(dev));
  },
  addStatusListener(fn) {
    this._statusListeners.push(fn);
  },
  removeStatusListener(fn) {
    const i = this._statusListeners.indexOf(fn);
    if (i >= 0) this._statusListeners.splice(i, 1);
  },
  _emitStatus() {
    this._statusListeners.slice().forEach((fn) => fn(this.globalData.connected));
  },

  // ---- 越限告警 + 微信推送 ----
  // 评估设备是否越限，更新告警状态；新告警触发应用内提示 + 巴法云微信推送
  checkAlerts(dev) {
    if (dev.type === 'light') {
      dev.alert = false;
      dev.alertText = '';
      return;
    }
    const alerts = evaluateAlert(dev.type, dev, dev.thresholds);
    if (alerts.length) {
      dev.alert = true;
      dev.alertText = alerts.join('；');
      const now = Date.now();
      // 仅在「新告警」且距上次推送 > 60s 时推送，避免刷屏
      if (!dev._alertActive && (!dev._lastPush || now - dev._lastPush > 60000)) {
        this.pushWechat(this.globalData.uid, dev.name, dev.name + ' 告警：' + dev.alertText);
        dev._lastPush = now;
        dev._alertActive = true;
        this._emitAlert(dev.alertText, dev);
      }
    } else {
      dev.alert = false;
      dev.alertText = '';
      dev._alertActive = false;
    }
  },

  // 调用巴法云微信推送 API（官方文档 api_wechat.html）。
  // 端点：https://apis.bemfa.com/vb/wechat/v1/wechatAlert （设备预警通知，GET）
  // 参数：uid=私钥, device=设备名, message=消息；可选 group/url
  // 前置：① 已在巴法云控制台绑定微信（关注公众号「巴法云」自动绑定）；
  //       ② 小程序后台把 https://apis.bemfa.com 加入 request 合法域名
  pushWechat(uid, deviceName, text) {
    if (!uid) return;
    const url =
      'https://apis.bemfa.com/vb/wechat/v1/wechatAlert?uid=' + encodeURIComponent(uid) +
      '&device=' + encodeURIComponent(deviceName) +
      '&message=' + encodeURIComponent(text);
    wx.request({
      url,
      method: 'GET',
      success(res) {
        // 正常返回 {"code":0,"msg":"success",...}；code:-1 多为 uid 未绑定微信
        console.log('[wechat-push]', res.statusCode, JSON.stringify(res.data));
      },
      fail(err) {
        console.error('[wechat-push] fail', err);
      },
    });
  },

  // 局部更新设备字段（如阈值配置），落盘并刷新页面（topic 不变，无需重新订阅）
  saveDevicePatch(id, patch) {
    const dev = this.globalData.devices.find((d) => d.id === id);
    if (!dev) return;
    Object.assign(dev, patch);
    this.persistDevices();
    this._notifyPages(dev);
  },

  // 告警事件（供页面做应用内 toast / 震动）
  addAlertListener(fn) {
    this._alertListeners.push(fn);
  },
  removeAlertListener(fn) {
    const i = this._alertListeners.indexOf(fn);
    if (i >= 0) this._alertListeners.splice(i, 1);
  },
  _emitAlert(text, dev) {
    this._alertListeners.slice().forEach((fn) => fn(text, dev));
  },
});
