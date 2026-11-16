/**
 * pages/index/index.js —— 设备列表首页
 */
const app = getApp();
const storage = require('../../utils/storage.js');
const dateUtil = require('../../utils/date.js');
const { iconEmoji, typeLabel, displayName } = require('../../utils/deviceParser.js');

function valueLabel(d) {
  if (d.type === 'light') return d.state === 'on' ? '已开启' : d.state === 'off' ? '已关闭' : '—';
  if (d.type === 'humiture') return (d.temp != null ? d.temp + '°C ' : '') + (d.hum != null ? d.hum + '%' : '');
  if (d.type === 'soil') return (d.value != null ? d.value : '—') + (d.unit || '');
  if (d.type === 'co2') return (d.value != null ? d.value : '—') + ' ' + (d.unit || '');
  if (d.type === 'photores') return d.value != null ? d.value + ' lux' : '—';
  return d.value != null ? String(d.value) : '—';
}

Page({
  data: {
    devices: [],
    connected: false,
    themeClass: '',
  },

  onLoad() {
    this._listener = this.onDeviceUpdate.bind(this);
    this._statusListener = this.onStatus.bind(this);
    this._alertListener = this.onAlert.bind(this);
  },

  onShow() {
    this.refreshDevices();
    app.addListener(this._listener);
    app.addStatusListener(this._statusListener);
    app.addAlertListener(this._alertListener);
    app.syncTheme(this);
    this.setData({ connected: app.globalData.connected });
  },

  onHide() {
    app.removeListener(this._listener);
    app.removeStatusListener(this._statusListener);
    app.removeAlertListener(this._alertListener);
    app.unsyncTheme(this);
  },

  refreshDevices() {
    const devices = app.globalData.devices.map((d) => this.decorate(d));
    this.setData({ devices });
  },

  onDeviceUpdate() {
    this.refreshDevices();
  },

  onStatus(connected) {
    this.setData({ connected });
  },

  onAlert(text) {
    wx.showToast({ title: text, icon: 'none' });
    if (wx.vibrateShort) wx.vibrateShort({ type: 'medium' });
  },

  // 列表页灯控：圆形电源按钮，无需进入详情，直接开关
  onLightPower(e) {
    e.stopPropagation && e.stopPropagation();
    const id = e.currentTarget.dataset.id;
    const next = e.currentTarget.dataset.next;
    const dev = app.globalData.devices.find((d) => d.id === id);
    if (!dev) return;
    const cmd = next;
    const ok = app.publish(dev.topic, cmd);
    if (!ok) {
      wx.showToast({ title: '未连接，无法控制', icon: 'none' });
      this.refreshDevices();
      return;
    }
    // 乐观更新本地状态；设备回传 on/off 会经 handleMessage 再次同步，保证一致
    dev.state = cmd;
    this.refreshDevices();
    wx.showToast({ title: cmd === 'on' ? '已开启' : '已关闭', icon: 'none' });
  },

  decorate(d) {
    return {
      id: d.id,
      name: d.name,
      displayName: displayName(d),
      hasRemark: !!(d.remark && d.remark.trim()),
      type: d.type,
      topic: d.topic,
      online: !!d.online,
      publisherOnline: !!d.publisherOnline,
      state: d.state || '',
      valueLabel: valueLabel(d),
      emoji: iconEmoji(d.type),
      typeText: typeLabel(d.type),
      alert: !!d.alert,
      alertText: d.alertText || '',
      lastUpdate: d.lastUpdate ? dateUtil.formatTime(d.lastUpdate) : '',
    };
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
  },

  goManage() {
    wx.switchTab({ url: '/pages/manage/manage' });
  },

  onPullDownRefresh() {
    this.refreshDevices();
    if (!app.globalData.connected && app.globalData.uid) app.connectMqtt();
    wx.stopPullDownRefresh();
  },
});
