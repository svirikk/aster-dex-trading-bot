import { config } from '../config/settings.js';
import { roundQuantity, roundPrice, isValidNumber } from '../utils/helpers.js';
import logger from '../utils/logger.js';

/**
 * Розраховує параметри позиції на основі risk management правил
 * @param {number} balance - баланс USDT на Futures акаунті
 * @param {number} entryPrice - поточна ціна входу
 * @param {string} direction - 'LONG' або 'SHORT'
 * @param {Object} symbolInfo - інформація про символ (tickSize, minQty, maxQty, pricePrecision)
 * @returns {Object} параметри позиції
 */
export function calculatePositionParameters(balance, entryPrice, direction, symbolInfo = {}) {
  try {
    // Валідація вхідних даних
    if (!isValidNumber(balance) || balance <= 0) {
      throw new Error(`Invalid balance: ${balance}`);
    }
    
    if (!isValidNumber(entryPrice) || entryPrice <= 0) {
      throw new Error(`Invalid entry price: ${entryPrice}`);
    }
    
    if (direction !== 'LONG' && direction !== 'SHORT') {
      throw new Error(`Invalid direction: ${direction}. Must be LONG or SHORT`);
    }

    // 1. Розрахувати ризик в USDT
    const riskAmount = balance * (config.risk.percentage / 100);
    logger.info(`[RISK] Balance: ${balance} USDT, Risk: ${config.risk.percentage}% = ${riskAmount} USDT`);

    // 2. Розрахувати Stop Loss ціну
    const stopLossPrice = direction === 'LONG'
      ? entryPrice * (1 - config.risk.stopLossPercent / 100)  // -0.3%
      : entryPrice * (1 + config.risk.stopLossPercent / 100); // +0.3%

    // 3. Розрахувати відстань до SL
    const stopLossDistance = Math.abs(entryPrice - stopLossPrice);
    
    if (stopLossDistance <= 0) {
      throw new Error('Stop loss distance is zero or negative');
    }

    // 4. Розрахувати розмір позиції (в USDT)
    // Формула: positionSize = (riskAmount / stopLossDistance) * entryPrice
    let positionSize = (riskAmount / stopLossDistance) * entryPrice;

    // 5. З урахуванням плеча
    const leverage = config.risk.leverage;
    const requiredMargin = positionSize / leverage;

    // Перевірка достатності балансу
    if (requiredMargin > balance) {
      logger.warn(`[RISK] Required margin (${requiredMargin} USDT) exceeds balance (${balance} USDT)`);
      // Перерахувати з максимально доступним балансом
      positionSize = balance * leverage;
    }

    // 6. Розрахувати кількість контрактів
    let quantity = positionSize / entryPrice;

    // 7. Розрахувати Take Profit ціну
    const takeProfitPrice = direction === 'LONG'
      ? entryPrice * (1 + config.risk.takeProfitPercent / 100)  // +0.5%
      : entryPrice * (1 - config.risk.takeProfitPercent / 100); // -0.5%

    // 8. Округлити значення згідно з вимогами біржі
    const tickSize = symbolInfo.tickSize || 0.0001;
    const pricePrecision = symbolInfo.pricePrecision !== undefined ? symbolInfo.pricePrecision : 4;
    const minQty = symbolInfo.minQty || 0;
    const maxQty = symbolInfo.maxQty || Infinity;

    quantity = roundQuantity(quantity, tickSize);
    const roundedEntryPrice = roundPrice(entryPrice, pricePrecision);
    const roundedStopLoss = roundPrice(stopLossPrice, pricePrecision);
    const roundedTakeProfit = roundPrice(takeProfitPrice, pricePrecision);

    // Перевірка мінімальних/максимальних обмежень
    if (quantity < minQty) {
      logger.warn(`[RISK] Calculated quantity (${quantity}) is less than minimum (${minQty}). Using minimum.`);
      quantity = minQty;
      // Перерахувати positionSize
      positionSize = quantity * entryPrice;
    }

    if (quantity > maxQty) {
      logger.warn(`[RISK] Calculated quantity (${quantity}) exceeds maximum (${maxQty}). Using maximum.`);
      quantity = maxQty;
      positionSize = quantity * entryPrice;
    }

    // Фінальна перевірка маржі
    const finalRequiredMargin = (quantity * entryPrice) / leverage;
    if (finalRequiredMargin > balance) {
      throw new Error(`Insufficient balance. Required: ${finalRequiredMargin} USDT, Available: ${balance} USDT`);
    }

    const result = {
      entryPrice: roundedEntryPrice,
      quantity: quantity,
      positionSize: positionSize,
      leverage: leverage,
      requiredMargin: finalRequiredMargin,
      stopLoss: roundedStopLoss,
      takeProfit: roundedTakeProfit,
      riskAmount: riskAmount,
      direction: direction
    };

    logger.info(`[RISK] Calculated position: ${quantity} @ ${roundedEntryPrice}, Margin: ${finalRequiredMargin} USDT, TP: ${roundedTakeProfit}, SL: ${roundedStopLoss}`);

    return result;
  } catch (error) {
    logger.error(`[RISK] Error calculating position parameters: ${error.message}`);
    throw error;
  }
}

/**
 * Перевіряє чи достатньо балансу для відкриття позиції
 */
export function hasSufficientBalance(balance, requiredMargin) {
  return isValidNumber(balance) && isValidNumber(requiredMargin) && balance >= requiredMargin;
}

export default {
  calculatePositionParameters,
  hasSufficientBalance
};
