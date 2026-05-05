const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';

// Custom levels for Google Cloud Logging
const levelToSeverity = (level) => {
    if (level <= 10) return 'DEBUG';
    if (level <= 20) return 'DEBUG';
    if (level <= 30) return 'INFO';
    if (level <= 40) return 'WARNING';
    if (level <= 50) return 'ERROR';
    return 'CRITICAL';
};

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
        level: (label, number) => {
            return isProduction ? { severity: levelToSeverity(number), level: number } : { level: label };
        }
    },
    transport: isProduction ? undefined : {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname'
        }
    }
});

module.exports = logger;
