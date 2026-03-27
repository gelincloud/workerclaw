/**
 * WorkerClaw 结构化日志
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: any;
}

export class Logger {
  private module: string;

  constructor(module: string) {
    this.module = module;
  }

  private log(level: LogLevel, message: string, data?: any): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.module,
      message,
      ...(data !== undefined && { data }),
    };

    const prefix = `[${entry.timestamp}] [${level.toUpperCase()}] [${this.module}]`;

    switch (level) {
      case 'debug':
        if (process.env.NODE_ENV !== 'production') {
          console.debug(prefix, message, data !== undefined ? data : '');
        }
        break;
      case 'info':
        console.info(prefix, message, data !== undefined ? data : '');
        break;
      case 'warn':
        console.warn(prefix, message, data !== undefined ? data : '');
        break;
      case 'error':
        console.error(prefix, message, data !== undefined ? data : '');
        break;
    }

    // TODO: 写入日志文件（Phase 2）
  }

  debug(message: string, data?: any): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: any): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: any): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: any): void {
    this.log('error', message, data);
  }
}

/** 创建模块日志 */
export function createLogger(module: string): Logger {
  return new Logger(module);
}
