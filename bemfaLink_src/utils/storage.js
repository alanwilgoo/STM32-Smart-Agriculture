/**
 * utils/storage.js
 * 本地持久化：设备列表 + 用户设置（私钥/uid）
 * 使用 wx.getStorageSync / setStorageSync。
 */

const DEVICES_KEY = 'bemfa_devices';
const SETTINGS_KEY = 'bemfa_settings';
const DEFAULT_UID = ''; // 占位私钥，用户需替换
const { thresholdFields, defaultThresholds } = require('./deviceParser.js');

function getSettings() {
  return wx.getStorageSync(SETTINGS_KEY) || { uid: DEFAULT_UID };
}

function saveSettings(settings) {
  wx.setStorageSync(SETTINGS_KEY, settings);
}

function getUid() {
  return getSettings().uid || DEFAULT_UID;
}

// 兼容旧设备：补齐 thresholds 等默认字段，避免缺字段报错
function normalizeDevice(d) {
  if (!d.type) d.type = 'sensor';
  if (!d.thresholds) {
    d.thresholds = defaultThresholds(d.type);
  } else {
    const fields = thresholdFields(d.type);
    fields.forEach((f) => {
      if (!(f.key in d.thresholds)) d.thresholds[f.key] = null;
    });
    if (typeof d.thresholds.enabled !== 'boolean') d.thresholds.enabled = false;
  }
  if (typeof d.online !== 'boolean') d.online = false;
  if (typeof d.publisherOnline !== 'boolean') d.publisherOnline = false;
  if (typeof d.remark !== 'string') d.remark = '';
  if (!Array.isArray(d.history)) d.history = [];
  return d;
}

function getDevices() {
  const list = wx.getStorageSync(DEVICES_KEY) || [];
  return list.map(normalizeDevice);
}

function saveDevices(devices) {
  wx.setStorageSync(DEVICES_KEY, devices);
}

function clearAll() {
  wx.removeStorageSync(DEVICES_KEY);
  wx.removeStorageSync(SETTINGS_KEY);
}

function genId() {
  return 'dev_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

module.exports = {
  getSettings,
  saveSettings,
  getUid,
  getDevices,
  saveDevices,
  clearAll,
  genId,
  DEFAULT_UID,
};
