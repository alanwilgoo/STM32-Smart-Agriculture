/**
 * @file    isr_callback.c
 * @brief   HAL 中断回调函数集合
 *
 * 回调分发说明：
 *   1. USART1（调试串口）：接收事件上报给应用层，由应用层处理；
 *   2. USART2（CO2传感器 MH-Z14A）：使用 HAL_UART_Receive_IT 单字节接收
 *      + 状态机方式，每收到1字节在 HAL_UART_RxCpltCallback 中调用
 *      co2_rx_event_handler()，状态机自动对齐帧头 0x2C 并收满6字节。
 *      不使用 IDLE 模式（HAL_UARTEx_ReceiveToIdle_IT 内部会读DR丢弃字节）；
 *   3. EXTI DIO1（LLCC68 LoRa中断）：HAL_GPIO_EXTI_Callback 中调用
 *      DIO1_EXTI_Callback()，处理TX_DONE/RX_DONE/TIMEOUT/CRC_ERROR中断。
 */
#include "main.h"
#include "co2.h"

/* 引用应用层定义的串口1接收标志 */
extern uint32_t g_uart1_rx_cnt;
extern uint32_t g_uart1_rx_end;

#include "llcc68_p2p.h"


/**
 * @brief  UART 错误回调（Overrun/Framing/Noise等错误时由HAL调用）
 *
 * 当UART2收到噪声或Overrun错误时，HAL会停止接收并调用此函数。
 * 如果不重新启动接收，UART2将永久停止工作。
 */
void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart)
{
	if (huart->Instance == USART2)
	{
		/* UART2发生错误（Overrun/Noise/Framing），重启接收 */
		co2_rx_restart_from_error();
	}
}

//GPIO外部中断回调函数
void HAL_GPIO_EXTI_Callback(uint16_t GPIO_Pin)
{
	if(GPIO_Pin==LORA_DIO1_Pin){
		//调用处理Lora收发的回调
		DIO1_EXTI_Callback();
	}
}

/**
 * @brief  UART 接收完成回调（接收满指定长度数据时由 HAL 调用）
 *
 * @param  huart 触发回调的串口句柄
 */
void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
	/* USART1 接收完成：置位接收结束标志，供应用层轮询 */
	if (huart->Instance == USART1)
		g_uart1_rx_end = 1;

	/* USART2 接收完成（CO2传感器，单字节+状态机）：
	 *   使用 HAL_UART_Receive_IT 每次接收1字节，由 HAL 调用此回调。
	 *   co2_rx_event_handler() 内部状态机自动对齐帧头 0x2C，
	 *   收满6字节后置位完成标志。
	 *   注意：不能用 HAL_UARTEx_RxEventCallback，因为
	 *   HAL_UARTEx_ReceiveToIdle_IT 内部 __HAL_UART_CLEAR_IDLEFLAG
	 *   会读DR，可能丢弃已到达的下一帧首字节。 */
	if (huart->Instance == USART2)
		co2_rx_event_handler(1);
}

/**
 * @brief  UART 接收事件回调（收到指定长度或检测到空闲时由 HAL 调用）
 *
 * @param  huart 触发回调的串口句柄
 * @param  Size  本次实际接收到的字节数
 */
void HAL_UARTEx_RxEventCallback(UART_HandleTypeDef *huart, uint16_t Size)
{
	/* USART1 接收事件：记录字节数并置位结束标志，供应用层轮询 */
	if (huart->Instance == USART1) {
		g_uart1_rx_cnt = Size;
		g_uart1_rx_end = 1;
	}

	/* USART2（CO2传感器）已改用 HAL_UART_Receive_IT 纯长度触发模式，
	 * 不再使用 IDLE 接收，此回调不再处理 USART2。
	 * CO2 接收完成回调改在 HAL_UART_RxCpltCallback 中处理。 */
}
