let sent = [];
function fakeSocket() {
  return {
    onOpen(cb){ this._onOpen = cb; }, onClose(cb){ this._onClose = cb; },
    onError(cb){ this._onError = cb; }, onMessage(cb){ this._onMessage = cb; },
    send(o){ sent.push(new Uint8Array(o.data)); },
    close(){ if(this._onClose) this._onClose({code:1000,reason:'',wasClean:true}); },
  };
}
global.wx = { connectSocket(opts){ this._s = fakeSocket(); return this._s; } };
const MqttClient = require('./utils/mqttClient.js');
let connected = false, got = [];
const c = new MqttClient({ url:'wss://bemfa.com:9504/wss', clientId:'mytestuid',
  onConnect(){ connected = true; }, onMessage(t,p){ got.push([t,p]); } });
c.connect();
const connack = new Uint8Array([0x20,0x02,0x00,0x00]);
const topic = 'mytestuid/temp';   // 14 字节
const payload = '#28.0#57.6';      // 9 字节
const tb = [...Buffer.from(topic)]; const pb = [...Buffer.from(payload)];
const rem = 2 + tb.length + pb.length;          // 25 = 0x19
const pub = new Uint8Array([0x30, rem, 0x00, topic.length, ...tb, ...pb]);
wx._s._onOpen();
const both = new Uint8Array(connack.length + pub.length);
both.set(connack,0); both.set(pub, connack.length);
wx._s._onMessage({ data: both.buffer });
console.log('connected =', connected);
console.log('received =', JSON.stringify(got));
console.log('expect: connected=true, ["mytestuid/temp","#28.0#57.6"]');
