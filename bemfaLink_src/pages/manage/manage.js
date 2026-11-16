/**
 * pages/manage/manage.js —— 设备管理（增删改 + 统计概览）
 */
const app = getApp();
const storage = require('../../utils/storage.js');
const { iconEmoji, typeLabel, displayName } = require('../../utils/deviceParser.js');

const TYPES = ['light', 'humiture', 'soil', 'co2', 'photores', 'sensor'];
const TYPE_LABELS = TYPES.map((t) => typeLabel(t));

Page({
  data: {
    devices: [],
    stats: { total: 0, online: 0 },
    typeCount: {},
    showForm: false,
    editingId: '',
    form: { name: '', typeIndex: 0, remark: '' },
    typeLabels: TYPE_LABELS,
    themeClass: '',
  },

  onShow() {
    this.refresh();
    this._listener = () => this.refresh();
    app.addListener(this._listener);
    app.syncTheme(this);
  },

  onHide() {
    if (this._listener) app.removeListener(this._listener);
    app.unsyncTheme(this);
  },

  refresh() {
    const devices = storage.getDevices();
    const online = devices.filter((d) => d.online).length;
    const typeCount = {};
    devices.forEach((d) => {
      typeCount[d.type] = (typeCount[d.type] || 0) + 1;
    });
    this.setData({
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        displayName: displayName(d),
        hasRemark: !!(d.remark && d.remark.trim()),
        type: d.type,
        emoji: iconEmoji(d.type),
        typeText: typeLabel(d.type),
        online: !!d.online,
      })),
      stats: { total: devices.length, online },
      typeCount,
    });
  },

  showAdd() {
    this.setData({ showForm: true, editingId: '', form: { name: '', typeIndex: 0, remark: '' } });
  },

  hideForm() {
    this.setData({ showForm: false });
  },

  noop() {},

  onName(e) {
    this.setData({ 'form.name': e.detail.value });
  },

  onRemark(e) {
    this.setData({ 'form.remark': e.detail.value });
  },

  onType(e) {
    this.setData({ 'form.typeIndex': Number(e.detail.value) });
  },

  saveDevice() {
    const name = this.data.form.name.trim();
    const type = TYPES[this.data.form.typeIndex];
    if (!name) {
      wx.showToast({ title: '请输入设备名称', icon: 'none' });
      return;
    }
    const uid = app.globalData.uid || storage.getUid();
    if (!uid) {
      wx.showToast({ title: '请先在「我的」配置私钥', icon: 'none' });
      return;
    }
    let devices = storage.getDevices();
    const exist = devices.find((d) => d.name === name && d.id !== this.data.editingId);
    if (exist) {
      wx.showToast({ title: '设备名已存在', icon: 'none' });
      return;
    }
    // 巴法云 MQTT 主题就是控制台里的「裸主题名」（私钥 uid 仅作为连接 clientId，不在主题里）。
    // 订阅/发布/匹配都用这个裸主题名，否则云端下发的 topic 会是裸名，与 "uid/name" 永远匹配不上。
    const topic = name;
    const remark = this.data.form.remark.trim();
    if (this.data.editingId) {
      const dev = devices.find((d) => d.id === this.data.editingId);
      if (dev) {
        dev.name = name;
        dev.type = type;
        dev.topic = topic;
        dev.remark = remark;
      }
    } else {
      devices.push({
        id: storage.genId(),
        name,
        type,
        topic,
        remark,
        online: false,
        publisherOnline: false,
        state: '',
        lastUpdate: 0,
      });
    }
    storage.saveDevices(devices);
    app.reloadDevices();
    this.setData({ showForm: false });
    this.refresh();
    wx.showToast({ title: '已保存', icon: 'success' });
  },

  editDevice(e) {
    const id = e.currentTarget.dataset.id;
    const dev = storage.getDevices().find((d) => d.id === id);
    if (!dev) return;
    this.setData({
      showForm: true,
      editingId: id,
      form: { name: dev.name, typeIndex: TYPES.indexOf(dev.type), remark: dev.remark || '' },
    });
  },

  deleteDevice(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除设备',
      content: '确认删除该设备？此操作不可撤销。',
      success: (r) => {
        if (r.confirm) {
          const devices = storage.getDevices().filter((d) => d.id !== id);
          storage.saveDevices(devices);
          app.reloadDevices();
          this.refresh();
          wx.showToast({ title: '已删除', icon: 'success' });
        }
      },
    });
  },
});
