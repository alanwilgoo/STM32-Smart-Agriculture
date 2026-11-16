/**
 * pages/mine/mine.js —— 我的（MQTT 配置 / 连接状态 / 清缓存）
 */
const app = getApp();
const storage = require('../../utils/storage.js');

Page({
  data: {
    uid: '',
    maskedUid: '',
    connected: false,
    showUid: false,
    themeClass: '',
  },

  onShow() {
    const uid = app.globalData.uid || storage.getUid();
    this.setData({ uid, maskedUid: this.mask(uid), connected: app.globalData.connected });
    this._statusListener = (c) => this.setData({ connected: c });
    app.addStatusListener(this._statusListener);
    app.syncTheme(this);
  },

  onHide() {
    if (this._statusListener) app.removeStatusListener(this._statusListener);
    app.unsyncTheme(this);
  },

  mask(uid) {
    if (!uid) return '';
    return uid.slice(0, 4) + '****' + uid.slice(-4);
  },

  toggleShow() {
    this.setData({ showUid: !this.data.showUid });
  },

  onUid(e) {
    this.setData({ uid: e.detail.value });
  },

  saveUid() {
    const uid = this.data.uid.trim();
    if (!uid) {
      wx.showToast({ title: '请输入私钥', icon: 'none' });
      return;
    }
    app.setUid(uid);
    this.setData({ maskedUid: this.mask(uid), connected: app.globalData.connected, showUid: false });
    wx.showToast({ title: '已保存并连接', icon: 'success' });
  },

  clearCache() {
    wx.showModal({
      title: '清空缓存',
      content: '将删除所有设备与配置，确定？',
      success: (r) => {
        if (r.confirm) {
          storage.clearAll();
          if (app.globalData.client) app.globalData.client.close();
          app.globalData.client = null;
          app.globalData.devices = [];
          app.globalData.uid = '';
          app.globalData.connected = false;
          this.setData({ uid: '', maskedUid: '', connected: false, showUid: false });
          wx.showToast({ title: '已清空', icon: 'success' });
        }
      },
    });
  },

  copyUid() {
    if (!this.data.uid) return;
    wx.setClipboardData({ data: this.data.uid });
  },

  openDoc() {
    wx.setClipboardData({ data: 'https://cloud.bemfa.com/docs/src/mqtt.html' });
    wx.showToast({ title: '文档链接已复制', icon: 'none' });
  },
});
