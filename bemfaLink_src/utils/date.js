/**
 * utils/date.js
 * 简单日期格式化工具。
 */

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + formatTime(ts);
}

module.exports = { pad, formatTime, formatDateTime };
