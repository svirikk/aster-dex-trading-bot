import dotenv from 'dotenv';

// 🔹 Завантажуємо .env ТІЛЬКИ локально
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

import { config } from './config/settings.js';
import logger from './utils/logger.js';
import asterdexService from './services/asterdex.service.js';  // ← ЗМІНЕНО
import telegramService from './services/telegram.service.js';
import positionService from './services/position.service.js';
import riskService from './services/risk.service.js';
import { isTradingHoursActive, getTradingHoursInfo } from './services/time.service.js';
import { isSymbolAllowed, getCurrentDate } from './utils/helpers.js';


// Статистика
const statistics = {
  totalTrades: 0,
  winTrades: 0,
  loseTrades: 0,
  totalProfit: 0,
  startBalance: 0,
  currentBalance: 0,
  dailyTrades: 0,
  signalsIgnored: 0,
  totalSignals: 0,
  lastResetDate: getCurrentDate()
};

/**
 * Ініціалізація бота
 */
async function initialize() {
  try {
    logger.info('='.repeat(50));
    logger.info('Starting AsterDex Futures Trading Bot...');  // ← ЗМІНЕНО
    logger.info('='.repeat(50));

    // Підключення до AsterDex  // ← ЗМІНЕНО
    await asterdexService.connect();
    
    // Отримуємо початковий баланс
    statistics.startBalance = await asterdexService.getUSDTBalance();  // ← ЗМІНЕНО
    statistics.currentBalance = statistics.startBalance;
    
    logger.info(`[INIT] Starting balance: ${statistics.startBalance} USDT`);
    logger.info(`[INIT] Dry Run mode: ${config.trading.dryRun ? 'ENABLED' : 'DISABLED'}`);
    logger.info(`[INIT] Allowed symbols: ${config.trading.allowedSymbols.join(', ')}`);
    logger.info(`[INIT] Risk: ${config.risk.percentage}%, Leverage: ${config.risk.leverage}x`);
    logger.info(`[INIT] Trading hours: ${config.tradingHours.startHour}:00-${config.tradingHours.endHour}:00 UTC`);

    // Реєструємо обробник сигналів
    telegramService.onSignal(handleSignal);

    // Запускаємо моніторинг позицій
    positionService.startMonitoring(30000); // Перевірка кожні 30 секунд

    // Відправляємо повідомлення про запуск
    if (!config.trading.dryRun) {
      await telegramService.sendMessage(
        config.telegram.channelId,
        `🤖 <b>TRADING BOT STARTED</b>\n\n` +
        `Balance: ${statistics.startBalance.toFixed(2)} USDT\n` +
        `Mode: ${config.trading.dryRun ? 'DRY RUN' : 'LIVE TRADING'}\n` +
        `Trading hours: ${config.tradingHours.startHour}:00-${config.tradingHours.endHour}:00 UTC`
      );
    }

    logger.info('[INIT] ✅ Bot initialized and ready to trade');
    
    // Запускаємо щоденний звіт
    scheduleDailyReport();
    
  } catch (error) {
    logger.error(`[INIT] Initialization failed: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Обробка торговельного сигналу
 */
async function handleSignal(signal) {
  try {
    statistics.totalSignals++;
    
    const { symbol, direction, timestamp } = signal;
    
    logger.info(`[SIGNAL] Processing: ${symbol} ${direction}`);

    // Валідація сигналу
    const validation = await validateSignal(signal);
    
    if (!validation.valid) {
      logger.warn(`[SIGNAL] Validation failed: ${validation.reason}`);
      
      if (!config.trading.dryRun) {
        await telegramService.sendMessage(
          config.telegram.channelId,
          telegramService.formatSignalIgnoredMessage(symbol, direction, validation.reason, validation.info)
        );
      }
      
      if (validation.reason.includes('trading hours')) {
        statistics.signalsIgnored++;
      }
      
      return;
    }

    // Відкриваємо позицію
    await openPosition(signal);
    
  } catch (error) {
    logger.error(`[SIGNAL] Error handling signal: ${error.message}`);
    
    if (!config.trading.dryRun) {
      await telegramService.sendMessage(
        config.telegram.channelId,
        `❌ <b>ERROR PROCESSING SIGNAL</b>\n\n` +
        `Symbol: ${signal.symbol}\n` +
        `Direction: ${signal.direction}\n` +
        `Error: ${error.message}`
      );
    }
  }
}

/**
 * Валідація сигналу перед відкриттям позиції
 */
async function validateSignal(signal) {
  const { symbol, direction } = signal;

  // 1. Перевірка символу
  if (!isSymbolAllowed(symbol, config.trading.allowedSymbols.join(','))) {
    return {
      valid: false,
      reason: `Symbol ${symbol} not in allowed list`,
      info: {}
    };
  }

  // 2. Перевірка напрямку
  if (direction !== 'LONG' && direction !== 'SHORT') {
    return {
      valid: false,
      reason: `Invalid direction: ${direction}`,
      info: {}
    };
  }

  // 3. Перевірка торговельних годин
  if (!isTradingHoursActive()) {
    const hoursInfo = getTradingHoursInfo();
    return {
      valid: false,
      reason: 'Outside trading hours',
      info: {
        currentTime: `${hoursInfo.currentHour}:${String(hoursInfo.currentMinute).padStart(2, '0')}`,
        tradingHours: `${hoursInfo.startHour}:00-${hoursInfo.endHour}:00`,
        nextTrading: hoursInfo.nextTradingIn
      }
    };
  }

  // 4. Перевірка відкритих позицій
  if (positionService.hasOpenPosition(symbol)) {
    return {
      valid: false,
      reason: `Open position already exists for ${symbol}`,
      info: {}
    };
  }

  // 5. Перевірка максимальної кількості відкритих позицій
  if (positionService.getOpenPositionsCount() >= config.trading.maxOpenPositions) {
    return {
      valid: false,
      reason: `Maximum open positions (${config.trading.maxOpenPositions}) reached`,
      info: {}
    };
  }

  // 6. Перевірка максимальної кількості угод на день
  if (statistics.dailyTrades >= config.trading.maxDailyTrades) {
    return {
      valid: false,
      reason: `Maximum daily trades (${config.trading.maxDailyTrades}) reached`,
      info: {}
    };
  }

  // 7. Перевірка балансу
  try {
    const balance = await asterdexService.getUSDTBalance();  // ← ЗМІНЕНО
    statistics.currentBalance = balance;
    
    if (balance <= 0) {
      return {
        valid: false,
        reason: 'Insufficient balance',
        info: {}
      };
    }
  } catch (error) {
    return {
      valid: false,
      reason: `Error checking balance: ${error.message}`,
      info: {}
    };
  }

  // 8. Перевірка що символ існує та торгується
  try {
    const symbolInfo = await asterdexService.getSymbolInfo(symbol);  // ← ЗМІНЕНО
    if (symbolInfo.status !== 'Trading') {
      return {
        valid: false,
        reason: `Symbol ${symbol} is not trading`,
        info: {}
      };
    }
  } catch (error) {
    return {
      valid: false,
      reason: `Symbol ${symbol} not found or error: ${error.message}`,
      info: {}
    };
  }

  return { valid: true };
}

/**
 * Відкриття позиції
 */
async function openPosition(signal) {
  const { symbol, direction, timestamp } = signal;
  
  try {
    logger.info(`[TRADE] Opening position: ${symbol} ${direction}`);

    // Отримуємо поточний баланс
    const balance = await asterdexService.getUSDTBalance();  // ← ЗМІНЕНО
    statistics.currentBalance = balance;

    // Отримуємо поточну ціну
    const currentPrice = await asterdexService.getCurrentPrice(symbol);  // ← ЗМІНЕНО
    
    // Отримуємо інформацію про символ
    const symbolInfo = await asterdexService.getSymbolInfo(symbol);  // ← ЗМІНЕНО

    // Розраховуємо параметри позиції
    const positionParams = riskService.calculatePositionParameters(
      balance,
      currentPrice,
      direction,
      symbolInfo
    );

    // Перевірка достатності балансу
    if (!riskService.hasSufficientBalance(balance, positionParams.requiredMargin)) {
      throw new Error(`Insufficient balance. Required: ${positionParams.requiredMargin} USDT, Available: ${balance} USDT`);
    }

    if (config.trading.dryRun) {
      // DRY RUN режим - тільки логування
      logger.info('[DRY RUN] Would open position:');
      logger.info(`  Symbol: ${symbol}`);
      logger.info(`  Direction: ${direction}`);
      logger.info(`  Entry Price: ${positionParams.entryPrice}`);
      logger.info(`  Quantity: ${positionParams.quantity}`);
      logger.info(`  Take Profit: ${positionParams.takeProfit}`);
      logger.info(`  Stop Loss: ${positionParams.stopLoss}`);
      logger.info(`  Required Margin: ${positionParams.requiredMargin} USDT`);
      
      // Симулюємо успішне відкриття
      positionService.addOpenPosition({
        symbol,
        direction,
        entryPrice: positionParams.entryPrice,
        quantity: positionParams.quantity,
        takeProfit: positionParams.takeProfit,
        stopLoss: positionParams.stopLoss,
        orderId: 'DRY_RUN_' + Date.now(),
        timestamp,
        tpOrderId: 'DRY_RUN_TP',
        slOrderId: 'DRY_RUN_SL'
      });

      statistics.totalTrades++;
      statistics.dailyTrades++;
      
      return;
    }

    // Реальна торгівля
    // 1. Встановлюємо плече
    await asterdexService.setLeverage(symbol, config.risk.leverage);  // ← ЗМІНЕНО

    // 2. Відкриваємо Market ордер (комісія 0.035%)
    const side = asterdexService.getOrderSide(direction);  // ← ЗМІНЕНО
    const positionSide = asterdexService.getPositionSide(direction);  // ← ЗМІНЕНО
    
    const orderResult = await asterdexService.openMarketOrder(  // ← ЗМІНЕНО
      symbol,
      side,
      positionParams.quantity,
      positionSide
    );

    // 3. Встановлюємо Take Profit LIMIT (комісія 0.01% - економія 7x!)
    const tpResult = await asterdexService.setTakeProfit(  // ← ЗМІНЕНО
      symbol,
      side,
      positionParams.takeProfit,
      positionParams.quantity,
      positionSide
    );

    // 4. Встановлюємо Stop Loss LIMIT (комісія 0.01% - економія 7x!)
    const slResult = await asterdexService.setStopLoss(  // ← ЗМІНЕНО
      symbol,
      side,
      positionParams.stopLoss,
      positionParams.quantity,
      positionSide
    );

    // 5. Додаємо позицію до моніторингу
    positionService.addOpenPosition({
      symbol,
      direction,
      entryPrice: orderResult.avgPrice || positionParams.entryPrice,
      quantity: positionParams.quantity,
      takeProfit: positionParams.takeProfit,
      stopLoss: positionParams.stopLoss,
      orderId: orderResult.orderId,
      timestamp,
      tpOrderId: tpResult.orderId,
      slOrderId: slResult.orderId
    });

    // 6. Оновлюємо статистику
    statistics.totalTrades++;
    statistics.dailyTrades++;

    // 7. Відправляємо повідомлення в Telegram
    await telegramService.sendMessage(
      config.telegram.channelId,
      telegramService.formatPositionOpenedMessage({
        ...positionParams,
        balance,
        timestamp
      })
    );

    logger.info(`[TRADE] ✅ Position opened successfully: ${symbol} ${direction}`);

  } catch (error) {
    logger.error(`[TRADE] Error opening position: ${error.message}`);
    throw error;
  }
}

/**
 * Планує щоденний звіт
 */
function scheduleDailyReport() {
  // Відправляємо звіт щодня о 23:00 UTC
  const now = new Date();
  const reportTime = new Date();
  reportTime.setUTCHours(23, 0, 0, 0);
  
  if (reportTime <= now) {
    reportTime.setUTCDate(reportTime.getUTCDate() + 1);
  }
  
  const msUntilReport = reportTime - now;
  
  setTimeout(() => {
    sendDailyReport();
    // Плануємо наступний звіт
    setInterval(sendDailyReport, 24 * 60 * 60 * 1000); // Кожні 24 години
  }, msUntilReport);
  
  logger.info(`[REPORT] Daily report scheduled for ${reportTime.toISOString()}`);
}

/**
 * Відправляє щоденний звіт
 */
async function sendDailyReport() {
  try {
    const currentDate = getCurrentDate();
    
    // Скидаємо щоденну статистику якщо новий день
    if (currentDate !== statistics.lastResetDate) {
      statistics.dailyTrades = 0;
      statistics.signalsIgnored = 0;
      statistics.lastResetDate = currentDate;
      positionService.resetDailyStatistics();
    }

    const posStats = positionService.getStatistics();
    const currentBalance = await asterdexService.getUSDTBalance();  // ← ЗМІНЕНО
    const startBalance = statistics.startBalance;
    const totalPnl = currentBalance - startBalance;
    const roi = startBalance > 0 ? (totalPnl / startBalance) * 100 : 0;

    const report = {
      date: currentDate,
      tradingHours: {
        start: config.tradingHours.startHour,
        end: config.tradingHours.endHour
      },
      totalSignals: statistics.totalSignals,
      signalsIgnored: statistics.signalsIgnored,
      totalTrades: posStats.totalTrades,
      winTrades: posStats.winTrades,
      loseTrades: posStats.loseTrades,
      totalPnl: totalPnl,
      roi: roi,
      startBalance: startBalance,
      currentBalance: currentBalance
    };

    if (!config.trading.dryRun) {
      await telegramService.sendMessage(
        config.telegram.channelId,
        telegramService.formatDailyReport(report)
      );
    }

    logger.info('[REPORT] Daily report sent');
  } catch (error) {
    logger.error(`[REPORT] Error sending daily report: ${error.message}`);
  }
}

/**
 * Обробка завершення програми
 */
process.on('SIGINT', async () => {
  logger.info('\n[SHUTDOWN] Received SIGINT, shutting down gracefully...');
  
  positionService.stopMonitoring();
  
  if (!config.trading.dryRun) {
    await telegramService.sendMessage(
      config.telegram.channelId,
      `🛑 <b>TRADING BOT STOPPED</b>\n\n` +
      `Open positions: ${positionService.getOpenPositionsCount()}\n` +
      `Total trades today: ${statistics.dailyTrades}`
    );
  }
  
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('\n[SHUTDOWN] Received SIGTERM, shutting down gracefully...');
  
  positionService.stopMonitoring();
  process.exit(0);
});

// Запускаємо бота
initialize().catch(error => {
  logger.error(`[FATAL] Failed to start bot: ${error.message}`);
  process.exit(1);
});
