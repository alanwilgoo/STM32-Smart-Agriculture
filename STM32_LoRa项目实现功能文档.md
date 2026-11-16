# STM32 LoRa 物联网监测系统 · 项目实现功能文档

---

## 1. 项目概述

### 1.1 背景与目标
在农业/环境多传感器监测场景中，传感器往往分散布置、布线困难。本项目设计一套**「终端采集板 + 中控接收板」**双板 LoRa 无线系统：

- 终端板就近采集多路传感器，经 LoRa 无线传到中控板；
- 中控板本地 OLED 实时显示，并经 ESP8266 上云（巴法云），实现远程查看与下发控制；
- 配套微信小程序作为移动端入口（创新项）。

### 1.2 技术指标
- 通信方式：LoRa P2P（LLCC68），频率 487.5 MHz，SF9，BW125，CR_4_5，CRC 开；
- 数据周期：终端板每 5 s 采集并发送一帧；
- 数据帧：10 字节 = 5 个 `int16_t`（温度×10 / 湿度×10 / CO2 ppm / 光照 lux / 土壤等级）；
- 上云：ESP8266 AT 透传 + 巴法云 MQTT（TCP），30 s 心跳；
- 软件架构：非抢占式时间片调度器（SysTick 驱动）。

---

## 2. 系统总体方案

### 2.1 架构框图
```
┌──────────── 终端板（发送端）────────────┐
│ 传感器：DHT22(PC15) CO2(MH-Z14A,USART2)  │
│        光敏(ADC) 土壤(ADC)               │
│        │ 每 5s 采集                       │
│        ▼ 打包 10 字节（5×int16）          │
│   LLCC68(NSS=PA4) → 空中 LoRa ──┐        │
│   LED1(PA8) LED2(PB15) LED3(PC13)│       │
└───────────────────────────────────────┘ │
                                         │ LoRa 无线
┌──────────── 中控板（接收端）────────────┘ │
│   LLCC68 → DIO1(PB10) 中断 → rx_done      │
│        ▼ app_lora_poll 解析 → g_sensor_data│
│   ┌──────────┬──────────┬──────────────┐  │
│   │ OLED显示  │ ESP8266  │ LED 控制       │  │
│   │ I2C1      │ USART2   │ LED1=连接状态  │  │
│   │(PD6/PD7)  │(WiFi/MQTT)│ LED3=light002 │  │
│   └──────────┴────┬─────┴ LED2=收发闪烁 │  │
└────────────────────┼────────────────────┘  │
                     ▼ TCP MQTT               │
┌──────────── 巴法云 bemfa.com ────────────┐  │
│   数据主题（上行）/ light002（下行控制）    │  │
└────────────────────┬────────────────────┘  │
                     ▼                        │
┌──────────── 微信小程序（创新·次要）────────┐ │
│   查看数据 / 下发 on·off 控制 LED3          │ │
└───────────────────────────────────────────┘ │
       调度器（SysTick 节拍，非抢占轮询）贯穿两端全部任务
```

### 2.2 工作原理
终端板把采集到的传感器数据打包为 10 字节帧，经 LLCC68 周期发送；中控板 LLCC68 处于连续接收模式，硬件收到包后由 DIO1（PB10 上升沿）中断置 `rx_done` 标志，主循环 `app_lora_poll` 轮询读 FIFO 并解析写入共享结构 `g_sensor_data`；OLED 与 MQTT 模块只读该结构，实现采集—显示—上云解耦。

---

## 3. 硬件设计

### 3.1 终端板（发送端）主要器件
| 模块 | 器件/接口 | 引脚/说明 |
|------|-----------|-----------|
| MCU | STM32F1 | 主控 |
| 温湿度 | DHT22（单总线） | PC15 |
| CO2 | MH-Z14A（串口） | USART2，6 字节帧（帧头 0x2C），中断接收 |
| 光照 | 光敏电阻（ADC） | ADC 采集电压，查表换算 lux（0~350） |
| 土壤 | 土壤湿度（ADC） | ADC 采集电压，查表换算等级（1 干燥~4 饱和） |
| LoRa | LLCC68 | NSS=PA4，RST=PB1，BUSY=PB0，DIO1=PB10（中断） |
| 指示 | LED1/LED2/LED3 | PA8 / PB15 / PC13 |

### 3.2 中控板（接收端）主要器件
| 模块 | 器件/接口 | 引脚/说明 |
|------|-----------|-----------|
| MCU | STM32F1 | 主控 |
| LoRa | LLCC68 | NSS=PA4，RST=PB1，BUSY=PB0，DIO1=PB10（EXTI 上升沿） |
| 显示 | OLED（SSD1306） | I2C1，SCL=PD6，SDA=PD7，器件地址 0x78 |
| 上云 | ESP8266（AT 透传） | USART2，115200 bps |
| 指示 | LED1/LED2/LED3 | PA8（PWM，连接状态）/ PB15（收发闪烁）/ PC13（light002 控） |
| 预留 | KEY1/KEY2 | PB12 / PB13 |

### 3.3 射频与引脚要点
- LoRa 参数两端完全一致（频率 487.5 MHz、SF9、BW125、CR_4_5、CRC 开、显式头、前导码 8），确保互通；
- LLCC68 HAL 层每次 SPI 命令前轮询 BUSY（PB0）引脚，避免总线冲突；
- DIO1 仅作“收包通知”，在 `HAL_GPIO_EXTI_Callback` 中置 `rx_done`，主循环再处理，保证中断短小、不阻塞。

---

## 4. 软件设计

### 4.1 总体软件结构（调度器 + 任务）
自研**非抢占式时间片调度器**（`User/middleware/scheduler.c`）：`scheduler_init()` 建表 → `scheduler_add_task(func, period_ms)` 注册 → `main()` 死循环 `scheduler_run()` 按 `HAL_GetTick()` 时间片轮询，到点才执行，**任务内零阻塞**（不用 `HAL_Delay` 死等）。

| 任务 | 周期 | 作用 |
|------|------|------|
| 发送端 `app_lora_send_poll`| 10 ms | 5 s 周期判断 + LED2 熄灭检查 + 传感器采集发送 |
| 接收端 `app_lora_poll` | 10 ms | 检查 `rx_done`、解析 LoRa 数据、LED2 闪烁 |
| 接收端 `app_mqtt_poll` | 50 ms | MQTT 心跳/发布/接收解析/掉线重连 + LED1 状态 |
| 接收端 `app_oled_poll` | 500 ms | OLED 事件驱动刷新（收到数据才重绘） |

代码位置：发送 `app_main.c:102`；接收 `app_main.c:113-115`；调度器 `scheduler.c:46`。

### 4.2 关键模块设计
- **LoRa 收发**：发送 `app_lora_send_poll`（`app_lora.c:130`）每 5 s 读传感器→`tx_data[5]`→`llcc68_lora_send(...,10,1000)`；接收 `app_lora_poll`（`app_lora.c:99`）读 10 字节，按 `int16_t*` 小端还原 5 路数据。
- **传感器驱动**：DHT22 单总线时序（起始+40 bit 读取+校验和）；CO2 MH-Z14A 串口状态机（帧头 0x2C + 校验和）；光敏/土壤 ADC 查表换算。
- **OLED 显示**：`oled_show_string` 为叠加绘制，故 `app_oled.c` 每行重绘前先 `oled_clear_line(y)` 清掉该行像素（修复旧字符残留，如 `T:82.5 H:6.0 63`）。
- **ESP8266 + MQTT**：`esp.c` 用 `HAL_UARTEx_ReceiveToIdle_IT` 空闲中断收包；`esp_mqtt.c` 实现 CONNECT/CONNACK/PUBLISH/SUBSCRIBE/PINGREQ/PINGRESP，私钥作 clientId；订阅 `light002` 主题→`app_mqtt_handle_publish` 解析 `on`/`off`→`led_ctrl(LED3,…)`。
- **共享数据**：`g_sensor_data`（写入：LoRa 接收；读取：OLED / MQTT）解耦各模块。

### 4.3 中断与通信流程
```
USART2(ESP) 空闲中断 → g_esp_rx_buf / g_esp_rx_cnt
PB10(DIO1) 上升沿  → EXTI → rx_done=1
SysTick         → 系统节拍，驱动 scheduler_run()
主循环          → 各 poll 任务按周期消费上述标志/缓冲
```

---

## 5. 功能实现与测试

| 验收项 | 实现要点 | 测试现象（判定） |
|------------------|----------|------------------|
| ① LoRa 无线传输 | 终端板 5 s 采温湿度/CO2/光照/土壤，打包 10 字节经 LLCC68 发送，LED2 闪 | 发送端串口每 5 s 打印 `[LoRa] 发送: T=.. H=.. CO2=.. Lux=.. S_H=..`；两模块靠近稳定收发 |
| ② OLED 显示 | 连续接收+解析，4 行显示温湿度/CO2/光照/土壤；行清屏防残影 | OLED 实时刷新无尾字符残留；收到数据 LED2 闪 |
| ③ 巴法云显示+控制 | ESP8266 透传连巴法云，上行发布数据；订阅 `light002` 控 LED3；LED1 常亮=连接；30 s 心跳+重连 | 云端/小程序见数据；下发 `on`/`off` 时 LED3 亮/灭 |
| ④ 调度器轮询 | 非抢占调度，4 任务按 10/10/50/500 ms 并发运转 | 主循环无裸 delay，①~③ 均通过调度驱动正常 |


---

## 6. 创新功能（小程序）

- **创新点：自定义微信小程序访问巴法云** 
  原生小程序，自研 MQTT 3.1.1 over WebSocket（`wss://bemfa.com:9504/wss`）；四页（设备列表/详情控制/管理/我的），多类型设备显示与 `light002` 灯控下发；暗黑模式+本地持久化。

---

## 8. 附录

### 8.1 源码结构
```
demo1_lora_send_schduler/   终端板工程
  User/app/        app_main.c app_lora.c sensor_data.h
  User/bsp/        lora/(llcc68*) dht22.c co2.c photores.c soil.c led.c oled/
  User/middleware/  scheduler.c
demo1_lora_recv_schduler/   中控板工程
  User/app/        app_main.c app_lora.c app_oled.c app_mqtt.c sensor_data.h
  User/bsp/        lora/(llcc68*) esp.c esp_mqtt.c led.c oled/ key.c
  User/middleware/  scheduler.c