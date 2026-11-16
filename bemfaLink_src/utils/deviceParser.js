/**
 * utils/deviceParser.js
 * 解析巴法云设备消息：状态消息 vs 数据消息；以及各类型传感器数据解析。
 *
 * 状态消息规则（修复点）：
 *  - $online / $offline  -> 订阅者状态
 *  - #online / #offline  -> 发布者状态
 *  - 其他 # 开头（如 #28.0#57.6）-> 普通数据消息（发布者在线 + 订阅者在线）
 *  - 其他 $ 开头 -> 普通数据消息
 *  - 任意非空数据消息 -> 发布者在线、本机订阅者在线
 */

const EMOJI = {
  light: '💡',
  humiture: '🌡️',
  soil: '🌱',
  co2: '🟣',
  photores: '☀️',
  sensor: '📊',
};

const LABEL = {
  light: '灯光开关',
  humiture: '温湿度',
  soil: '土壤湿度',
  co2: 'CO₂ 浓度',
  photores: '光照强度',
  sensor: '通用传感器',
};

function iconEmoji(type) {
  return EMOJI[type] || EMOJI.sensor;
}

function typeLabel(type) {
  return LABEL[type] || '传感器';
}

// 判断消息种类
function classify(raw) {
  if (raw === undefined || raw === null) return { kind: 'unknown' };
  const msg = String(raw).trim();
  if (msg === '$online') return { kind: 'subStatus', online: true };
  if (msg === '$offline') return { kind: 'subStatus', online: false };
  if (msg === '#online') return { kind: 'pubStatus', online: true };
  if (msg === '#offline') return { kind: 'pubStatus', online: false };
  return { kind: 'data', text: msg };
}

// 解析传感器数据 -> 结构化字段
function parseSensor(type, text) {
  switch (type) {
    case 'light':
      return { state: text === 'on' ? 'on' : text === 'off' ? 'off' : 'unknown' };
    case 'humiture': {
      let temp;
      let hum;
      if (text.indexOf('#') === 0) {
        const parts = text.split('#').filter((p) => p.length > 0);
        temp = parseFloat(parts[0]);
        hum = parseFloat(parts[1]);
      } else if (text.indexOf(',') >= 0) {
        const parts = text.split(',');
        temp = parseFloat(parts[0]);
        hum = parseFloat(parts[1]);
      }
      return { temp, hum };
    }
    case 'soil': {
      const hasPct = text.indexOf('%') >= 0;
      const value = parseFloat(text.replace(/[^0-9.]/g, ''));
      return { value, unit: hasPct ? '%' : '' };
    }
    case 'co2': {
      const value = parseFloat(text.replace(/[^0-9.]/g, ''));
      return { value, unit: 'ppm' };
    }
    case 'photores': {
      const value = parseFloat(text.replace(/[^0-9.]/g, ''));
      return { value, unit: 'lux' };
    }
    default: {
      // 通用传感器兜底：尝试温湿度或单值
      if (text.indexOf('#') === 0) {
        const parts = text.split('#').filter((p) => p.length > 0);
        if (parts.length >= 2) return { value: parseFloat(parts[0]), value2: parseFloat(parts[1]) };
        return { value: parts[0] };
      }
      return { value: text };
    }
  }
}

// ---------- 告警阈值 ----------
// 不同设备类型适用的阈值字段
function thresholdFields(type) {
  if (type === 'humiture') {
    return [
      { key: 'tempMin', label: '温度下限', unit: '°C' },
      { key: 'tempMax', label: '温度上限', unit: '°C' },
      { key: 'humMin', label: '湿度下限', unit: '%' },
      { key: 'humMax', label: '湿度上限', unit: '%' },
    ];
  }
  if (type === 'light') return []; // 开关类无数值阈值
  return [
    { key: 'valueMin', label: '数值下限', unit: '' },
    { key: 'valueMax', label: '数值上限', unit: '' },
  ];
}

function defaultThresholds(type) {
  const th = { enabled: false };
  thresholdFields(type).forEach((f) => {
    th[f.key] = null;
  });
  return th;
}

// 评估是否越限，返回告警文案数组（未启用或字段无值则忽略）
function evaluateAlert(type, data, th) {
  if (!th || !th.enabled) return [];
  const out = [];
  if (type === 'humiture') {
    if (th.tempMax != null && data.temp != null && data.temp > th.tempMax) out.push('温度偏高 ' + data.temp + '°C（>' + th.tempMax + '°C）');
    if (th.tempMin != null && data.temp != null && data.temp < th.tempMin) out.push('温度偏低 ' + data.temp + '°C（<' + th.tempMin + '°C）');
    if (th.humMax != null && data.hum != null && data.hum > th.humMax) out.push('湿度偏高 ' + data.hum + '%（>' + th.humMax + '%）');
    if (th.humMin != null && data.hum != null && data.hum < th.humMin) out.push('湿度偏低 ' + data.hum + '%（<' + th.humMin + '%）');
  } else if (data && data.value != null) {
    const u = data.unit || '';
    if (th.valueMax != null && data.value > th.valueMax) out.push('数值偏高 ' + data.value + u + '（>' + th.valueMax + u + '）');
    if (th.valueMin != null && data.value < th.valueMin) out.push('数值偏低 ' + data.value + u + '（<' + th.valueMin + u + '）');
  }
  return out;
}

// 显示名：备注优先，无备注则用主题名（巴法云裸主题名）
function displayName(d) {
  const r = d && d.remark ? String(d.remark).trim() : '';
  return r || (d && d.name) || '';
}

// ---------- 历史时序数据（折线图数据源） ----------
// 每台设备最多保留 HISTORY_CAP 个点，超出丢弃最旧，避免本地存储无限增长。
const HISTORY_CAP = 300;

// 把当前数值写入设备历史。仅在有数值时写入；light 为开关类不记录趋势。
// 调用后由上层 persistDevices 统一落盘。
function appendHistory(dev, cap = HISTORY_CAP) {
  if (!dev || dev.type === 'light') return;
  const t = Date.now();
  let point;
  if (dev.type === 'humiture') {
    if (typeof dev.temp !== 'number' && typeof dev.hum !== 'number') return;
    point = { t, temp: dev.temp, hum: dev.hum };
  } else {
    if (typeof dev.value !== 'number') return;
    point = { t, value: dev.value };
  }
  if (!Array.isArray(dev.history)) dev.history = [];
  dev.history.push(point);
  if (dev.history.length > cap) dev.history.splice(0, dev.history.length - cap);
}

module.exports = { classify, parseSensor, iconEmoji, typeLabel, thresholdFields, defaultThresholds, evaluateAlert, displayName, appendHistory, HISTORY_CAP };
