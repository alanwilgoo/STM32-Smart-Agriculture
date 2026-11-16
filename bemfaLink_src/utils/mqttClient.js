/**
 * utils/mqttClient.js
 * 原生实现 MQTT 3.1.1 协议（走 WebSocket 通道），不依赖第三方 mqtt.js。
 * 对接巴法云 bemfa.com：wss://bemfa.com:9504/wss
 *
 * 关键约束（来自踩坑总结）：
 *  - wx.connectSocket 不能传 header / protocols（会干扰握手）
 *  - SocketTask.send 不能传 isBuffer
 *  - 心跳间隔须 < Keep Alive（这里 KeepAlive=30s，心跳 30s 临界，改为 25s 留缓冲）
 *  - 真机 onMessage 的 data 可能是 ArrayBuffer，不能假定是 string
 *  - 一帧可能含多个报文，也可能被拆包，需要接收缓冲
 */

const KEEP_ALIVE = 30; // 秒（CONNECT 报文 Keep Alive 字段）
const PING_INTERVAL = 25000; // 毫秒，心跳发送间隔（< KEEP_ALIVE 留缓冲）

// ---------- UTF-8 编解码 ----------
function utf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.codePointAt(i);
    if (code > 0xffff) i++; // 跳过代理对
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return out;
}

function utf8Decode(bytes, start, end) {
  let str = '';
  let i = start;
  while (i < end) {
    const b = bytes[i++];
    if (b < 0x80) str += String.fromCharCode(b);
    else if ((b & 0xe0) === 0xc0) str += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if ((b & 0xf0) === 0xe0) str += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else str += String.fromCharCode(((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
  }
  return str;
}

// ---------- 变长剩余长度编码 ----------
function encodeLength(len) {
  const arr = [];
  do {
    let digit = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) digit |= 0x80;
    arr.push(digit);
  } while (len > 0);
  return arr;
}

function decodeLength(bytes, start) {
  let value = 0;
  let multiplier = 1;
  for (let shift = 0; shift < 4; shift++) {
    if (start + shift >= bytes.length) return { value: 0, next: -1 }; // 长度字节未收全
    const digit = bytes[start + shift];
    value += (digit & 0x7f) * multiplier;
    multiplier *= 128;
    if ((digit & 0x80) === 0) return { value, next: start + shift + 1 };
  }
  return { value: 0, next: -1 }; // 畸形
}

// ---------- 报文构造 ----------
function buildConnect(clientId) {
  const name = utf8Encode('MQTT'); // 协议名
  const cid = utf8Encode(clientId);
  const variable = [0x00, name.length, ...name, 0x04 /*level*/, 0x02 /*clean session*/, 0x00, KEEP_ALIVE]; // keepAlive 2 字节
  const payload = [cid.length >> 8, cid.length & 0xff, ...cid];
  const remaining = variable.length + payload.length;
  return [0x10, ...encodeLength(remaining), ...variable, ...payload];
}

function buildSubscribe(packetId, topics) {
  const payload = [];
  topics.forEach((t) => {
    const tb = utf8Encode(t);
    payload.push(tb.length >> 8, tb.length & 0xff, ...tb, 0x00); // QoS 0
  });
  const variable = [(packetId >> 8) & 0xff, packetId & 0xff];
  const remaining = variable.length + payload.length;
  return [0x82, ...encodeLength(remaining), ...variable, ...payload];
}

function buildPublish(topic, message, qos) {
  qos = qos || 0;
  const tb = utf8Encode(topic);
  const mb = utf8Encode(message);
  const variable = [tb.length >> 8, tb.length & 0xff, ...tb];
  let remaining = variable.length + mb.length;
  let header = 0x30; // QoS0, dup=0, retain=0
  if (qos === 1) {
    remaining += 2;
    header = 0x32;
  }
  const packet = [header, ...encodeLength(remaining), ...variable];
  if (qos === 1) packet.push(0x00, 0x01); // Packet Identifier
  packet.push(...mb);
  return packet;
}

// ---------- MQTT 客户端 ----------
class MqttClient {
  constructor(options) {
    this.url = options.url;
    this.clientId = options.clientId;
    this.onConnect = options.onConnect || function () {};
    this.onClose = options.onClose || function () {};
    this.onMessage = options.onMessage || function () {};
    this.onError = options.onError || function () {};
    this.reconnect = options.reconnect !== false;
    this.connected = false;
    this._packetId = 1;
    this._socket = null;
    this._pingTimer = null;
    this._manualClose = false;
    this._buf = new Uint8Array(0);
  }

  connect() {
    this._manualClose = false;
    // 注意：不要传 header / protocols
    this._socket = wx.connectSocket({ url: this.url });
    this._socket.onOpen(() => this._onOpen());
    this._socket.onClose((res) => this._onClose(res));
    this._socket.onError((err) => this._onError(err));
    this._socket.onMessage((res) => this._onMessage(res));
  }

  _onOpen() {
    console.log('[mqtt] socket open, sending CONNECT');
    this._send(buildConnect(this.clientId));
  }

  _send(bytes) {
    if (!this._socket) return;
    try {
      const buffer = new Uint8Array(bytes).buffer;
      this._socket.send({ data: buffer });
    } catch (e) {
      console.error('[mqtt] send error', e);
    }
  }

  _onMessage(res) {
    let incoming;
    if (res.data instanceof ArrayBuffer) {
      incoming = new Uint8Array(res.data);
    } else if (typeof res.data === 'string') {
      incoming = new Uint8Array(utf8Encode(res.data));
    } else {
      incoming = new Uint8Array(res.data);
    }
    // 拼接到接收缓冲
    const buf = new Uint8Array(this._buf.length + incoming.length);
    buf.set(this._buf, 0);
    buf.set(incoming, this._buf.length);
    this._buf = buf;
    this._drain();
  }

  _drain() {
    const bytes = this._buf;
    let idx = 0;
    while (idx < bytes.length) {
      if (idx + 1 >= bytes.length) break; // 不足 1 字节固定头
      const ctrl = bytes[idx];
      const lenInfo = decodeLength(bytes, idx + 1);
      if (lenInfo.next === -1) break; // 剩余长度未收全
      const total = lenInfo.next + lenInfo.value;
      if (total > bytes.length) break; // 整包未收全
      const body = bytes.subarray(lenInfo.next, total);
      this._handlePacket(ctrl, body);
      idx = total;
    }
    this._buf = bytes.slice(idx); // 保留半包（slice 拷贝，避免持有大缓冲）
  }

  _handlePacket(ctrl, body) {
    const type = ctrl & 0xf0;
    if (type === 0x20) {
      // CONNACK
      this.connected = true;
      this._startPing();
      console.log('[mqtt] CONNACK ok, connected');
      this.onConnect();
    } else if (type === 0x90) {
      // SUBACK（忽略）
    } else if (type === 0xd0) {
      // PINGRESP（忽略）
    } else if (type === 0x30 || type === 0x32 || type === 0x34 || type === 0x36) {
      // PUBLISH
      let i = 0;
      const qos = (ctrl >> 1) & 0x03;
      const topicLen = (body[i] << 8) | body[i + 1];
      i += 2;
      const topic = utf8Decode(body, i, i + topicLen);
      i += topicLen;
      let packetId = null;
      if (qos > 0) {
        packetId = (body[i] << 8) | body[i + 1];
        i += 2;
      }
      const payload = utf8Decode(body, i, body.length);
      // 调试：打印 hex 前缀
      if (typeof console !== 'undefined') {
        const head = Array.from(body.subarray(0, Math.min(8, body.length)))
          .map((b) => ('0' + b.toString(16)).slice(-2))
          .join(' ');
        console.log('[mqtt] PUBLISH topic=', topic, 'payload=', payload, 'hex=', head);
      }
      this.onMessage(topic, payload);
      if (qos === 1) {
        this._send([0x40, 0x02, (packetId >> 8) & 0xff, packetId & 0xff]); // PUBACK
      }
    }
  }

  subscribe(topics) {
    if (!this.connected || !this._socket) return;
    const list = Array.isArray(topics) ? topics : [topics];
    if (!list.length) return;
    const pid = this._nextId();
    this._send(buildSubscribe(pid, list));
    console.log('[mqtt] SUBSCRIBE', list);
  }

  publish(topic, message) {
    if (!this.connected || !this._socket) return false;
    this._send(buildPublish(topic, message, 0));
    console.log('[mqtt] PUBLISH ->', topic, message);
    return true;
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this.connected && this._socket) this._send([0xc0, 0x00]); // PINGREQ
    }, PING_INTERVAL);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  close() {
    this._manualClose = true;
    this._stopPing();
    if (this._socket) {
      try {
        this._socket.close({});
      } catch (e) {}
      this._socket = null;
    }
    this.connected = false;
  }

  _onClose(res) {
    this.connected = false;
    this._stopPing();
    console.log('[mqtt] onClose code=', res.code, 'reason=', res.reason, 'wasClean=', res.wasClean);
    this.onClose(res);
    if (this.reconnect && !this._manualClose) {
      setTimeout(() => {
        if (!this._manualClose) this.connect();
      }, 3000);
    }
  }

  _onError(err) {
    console.error('[mqtt] onError', err);
    this.onError(err);
  }

  _nextId() {
    this._packetId = (this._packetId % 65535) + 1;
    return this._packetId;
  }
}

module.exports = MqttClient;
