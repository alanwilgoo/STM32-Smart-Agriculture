/**
 * @file    co2.c
 * @brief   CO2 传感器驱动模块实现
 *
 * 实现原理：
 *   1. 串口2以「单字节中断接收 + 状态机」方式接收数据帧；
 *   2. 等待帧头阶段（idx=0）：逐字节判断，非 0x2C 则丢弃（自动对齐）；
 *   3. 接收帧内阶段（idx=1~5）：逐字节存入缓冲区；
 *   4. 收满6字节（idx=6）：置位完成标志，等待应用层 co2_read() 解析；
 *   5. 应用层对缓冲区做帧头与校验和验证，解析出 CO2 浓度与满量程。
 *
 * 设计要点：
 *   - 使用 HAL_UART_Receive_IT 每次只收1字节（纯长度触发，不读DR）；
 *   - 不使用 HAL_UARTEx_ReceiveToIdle_IT：
 *     其内部 __HAL_UART_CLEAR_IDLEFLAG 通过「读SR再读DR」清除IDLE，
 *     若此时DR中有已到达的字节，该字节会被读取丢弃，导致丢帧头 0x2C；
 *   - 不使用固定6字节 HAL_UART_Receive_IT：
 *     若初始启动时DR有残留字节导致首帧错位，后续无法自动恢复；
 *   - 状态机逐字节对齐帧头 0x2C，抗错位能力最强；
 *   - 中断回调中绝对禁止 printf 等阻塞操作。
 */
#include "main.h"
#include "usart.h"
#include "co2.h"
#include <stdio.h>

/* ============================ 私有全局变量 ============================
 * 接收缓冲区与状态标志仅在本模块内部使用，外部只能通过接口函数访问，
 * 实现数据的封装与保护。
 */
static uint8_t  g_co2_rx_buf[CO2_FRAME_SIZE]; /* 一帧 CO2 数据缓冲区          */
static uint8_t  g_co2_frame_end;              /* 一帧数据接收完成标志（1=完成）*/
static uint8_t  g_co2_rx_byte;                /* 单字节接收缓冲（HAL用）      */
static uint8_t  g_co2_rx_idx;                 /* 帧内字节索引（0~5）          */

/* ============================ 内部函数声明 ============================ */
static int  co2_frame_check(const uint8_t *frame, uint32_t size);
static void co2_rx_restart (void);

/* ============================ 对外接口函数 ============================ */
/**
 * @brief  初始化 CO2 传感器，启动串口2单字节中断接收
 *
 * @retval CO2_OK  初始化成功
 */
int co2_init(void)
{
	g_co2_frame_end = 0;
	g_co2_rx_idx    = 0;

	/* 清空DR中可能残留的全部字节（USART2初始化后传感器可能已发送多帧数据，
	 * 移位寄存器中可能堆积了旧字节）。必须用 while 循环清空：
	 * RXNE=1 表示 DR 中有一个字节，读DR后 RXNE 自动清零，
	 * 但若移位寄存器中还有下一个待传字节，硬件会立即再次置 RXNE=1，
	 * 因此需要循环直到 RXNE=0，确保 DR 完全清空。 */
	while (__HAL_UART_GET_FLAG(&huart2, UART_FLAG_RXNE))
		(void)huart2.Instance->DR;

	/* 清除ORE溢出标志（读SR再读DR，此时DR已空不会丢有效字节） */
	if (__HAL_UART_GET_FLAG(&huart2, UART_FLAG_ORE))
		__HAL_UART_CLEAR_OREFLAG(&huart2);

	/* 启动单字节中断接收，等待帧头 0x2C */
	co2_rx_restart();

	return CO2_OK;
}

/**
 * @brief  串口2单字节接收完成处理函数（由 HAL_UART_RxCpltCallback 调用）
 *
 * 状态机逻辑：
 *   - idx=0（等帧头）：当前字节 == 0x2C ?
 *       是 → 存入 buf[0]，idx 推进到 1
 *       否 → 丢弃，继续等待帧头（自动对齐机制）
 *   - idx=1~5（收帧体）：存入 buf[idx]，idx++
 *   - idx 达到 CO2_FRAME_SIZE（6）：
 *       置位 frame_end，idx 归零，一帧完成
 *
 * @note   本函数运行在中断上下文，绝对禁止 printf 等阻塞函数。
 */
void co2_rx_event_handler(uint32_t size)
{
	uint8_t byte = g_co2_rx_byte;

	if (g_co2_rx_idx == 0)
	{
		/* 阶段1：等待帧头 0x2C，非帧头字节直接丢弃 */
		if (byte == CO2_FRAME_HEADER)
		{
			g_co2_rx_buf[g_co2_rx_idx++] = byte;
		}
	}
	else
	{
		/* 阶段2：接收帧内剩余字节 */
		g_co2_rx_buf[g_co2_rx_idx++] = byte;

		if (g_co2_rx_idx >= CO2_FRAME_SIZE)
		{
			/* 收满6字节，一帧完成 */
			g_co2_frame_end = 1;
			g_co2_rx_idx = 0;
		}
	}

	/* 立即重启单字节接收，保证后续字节不丢失 */
	co2_rx_restart();
}

/**
 * @brief  读取并解析 CO2 传感器数据
 *
 * @param  co2_data 测量结果输出指针
 *
 * @retval CO2_OK          读取成功
 * @retval CO2_ERR_INVAL   参数错误
 * @retval CO2_ERR_NOFRAME 尚未收到新数据帧
 * @retval CO2_ERR_CHECK   数据帧校验失败
 */
int co2_read(struct co2_t *co2_data)
{
	if (co2_data == NULL)
		return CO2_ERR_INVAL;

	/*
	 * 接收自愈看门狗：
	 * 正常运行时 huart2.RxState 恒为 BUSY_RX（回调内已重启）。
	 * 一旦因 ORE 溢出等错误被 HAL 终止接收，RxState 会回到 READY，
	 * 若不重启，后续数据帧将永远不再触发接收回调。
	 */
	if (huart2.RxState != HAL_UART_STATE_BUSY_RX)
	{
		printf("[CO2] RxState=%d, 重启接收\r\n", huart2.RxState);
		co2_rx_restart();
	}

	/* 尚未收到新数据帧，非错误，可稍后重试 */
	if (!g_co2_frame_end)
		return CO2_ERR_NOFRAME;

	/* 无论解析成功与否，都清除结束标志，避免重复处理同一帧 */
	g_co2_frame_end = 0;

	/* 调试打印：显示收到的原始字节（HEX格式）
	 * 放在主循环中执行，避免中断上下文中 printf 阻塞导致丢字节 */
	{
		uint8_t i;
		printf("[CO2] 收到 %d 字节:", CO2_FRAME_SIZE);
		for (i = 0; i < CO2_FRAME_SIZE; i++)
			printf(" %02X", g_co2_rx_buf[i]);
		printf("\r\n");
	}

	/* 帧头、校验和验证（状态机已保证帧头为0x2C，这里做双保险） */
	if (co2_frame_check(g_co2_rx_buf, CO2_FRAME_SIZE) != CO2_OK)
	{
		printf("[CO2] 帧校验失败 (CHECK)\r\n");
		return CO2_ERR_CHECK;
	}

	/* 解析 CO2 浓度与满量程（大端格式：高字节在前） */
	co2_data->concentration = (uint16_t)((g_co2_rx_buf[CO2_IDX_CONC_H] << 8) |
					       g_co2_rx_buf[CO2_IDX_CONC_L]);
	co2_data->full_scale = (uint16_t)((g_co2_rx_buf[CO2_IDX_RANGE_H] << 8) |
					     g_co2_rx_buf[CO2_IDX_RANGE_L]);

	return CO2_OK;
}

/* ============================ 内部功能函数 ============================ */
/**
 * @brief  校验一帧 CO2 数据（帧头、帧长、校验和）
 *
 * @param  frame 数据帧缓冲区指针
 * @param  size  数据帧有效字节数
 *
 * @retval CO2_OK        校验通过
 * @retval CO2_ERR_CHECK 校验失败
 */
static int co2_frame_check(const uint8_t *frame, uint32_t size)
{
	uint8_t checksum = 0;
	uint8_t i;

	/* 必须收到完整的一帧数据 */
	if (size < CO2_FRAME_SIZE)
		return CO2_ERR_CHECK;

	/* 帧头校验：MH-Z14A 帧头固定为 0x2C */
	if (frame[CO2_IDX_HEADER] != CO2_FRAME_HEADER)
		return CO2_ERR_CHECK;

	/* 校验和 = 前 5 字节累加和的低 8 位 */
	for (i = 0; i < CO2_FRAME_SIZE - 1; i++)
		checksum += frame[i];

	if (checksum != frame[CO2_IDX_CHECKSUM])
		return CO2_ERR_CHECK;

	return CO2_OK;
}

/**
 * @brief  重新启动串口2单字节中断接收
 *
 * @note   使用 HAL_UART_Receive_IT 接收1字节。
 *         HAL_UART_Receive_IT 内部只调用 UART_Start_Receive_IT：
 *           - 设置 pRxBuffPtr / RxXferSize=1 / RxXferCount=1
 *           - RxState = BUSY_RX
 *           - 使能 ERR / RXNE 中断
 *         不读DR，不清IDLE，不会丢弃字节。
 */
static void co2_rx_restart(void)
{
	/* 清除ORE标志（如有），避免使能中断瞬间触发错误中断。
	 * 注意：__HAL_UART_CLEAR_OREFLAG 会读SR再读DR，但仅当ORE标志
	 * 置位时才执行。ORE=1 表示发生了溢出（DR未及时读，新字节又到了），
	 * 此时DR中的字节本身已无效，清除不会丢有效数据。 */
	if (__HAL_UART_GET_FLAG(&huart2, UART_FLAG_ORE))
		__HAL_UART_CLEAR_OREFLAG(&huart2);

	HAL_UART_Receive_IT(&huart2, &g_co2_rx_byte, 1);
}

/**
 * @brief  UART错误恢复：清除错误标志并重新启动接收
 *
 * @note   当UART2发生Overrun/Framing/Noise等错误时，HAL会停止接收。
 *         调用此函数可清除错误状态并重新启动接收。
 *         错误发生时，正在接收的半帧数据肯定已损坏，因此必须重置
 *         帧内索引为0，回到等待帧头状态，确保后续正确对齐。
 */
void co2_rx_restart_from_error(void)
{
	/* 清除UART错误标志（每个清除宏的触发条件不同，逐一清除） */
	if (__HAL_UART_GET_FLAG(&huart2, UART_FLAG_ORE))
		__HAL_UART_CLEAR_OREFLAG(&huart2);
	if (__HAL_UART_GET_FLAG(&huart2, UART_FLAG_FE))
		__HAL_UART_CLEAR_FEFLAG(&huart2);
	if (__HAL_UART_GET_FLAG(&huart2, UART_FLAG_NE))
		__HAL_UART_CLEAR_NEFLAG(&huart2);

	/* 强制将UART状态恢复为READY（HAL因错误会将RxState置为READY） */
	huart2.RxState = HAL_UART_STATE_READY;

	/* 重置帧内索引为0，回到等待帧头状态，丢弃损坏的半帧数据 */
	g_co2_rx_idx = 0;

	/* 重新启动单字节接收 */
	HAL_UART_Receive_IT(&huart2, &g_co2_rx_byte, 1);
}
