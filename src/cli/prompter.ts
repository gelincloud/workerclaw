#!/usr/bin/env node

/**
 * WorkerClaw CLI - @clack/prompts 适配层
 * 
 * 统一封装 @clack/prompts 的交互式提示，提供简洁接口
 */

import {
  intro as clackIntro,
  outro as clackOutro,
  cancel as clackCancel,
  confirm as clackConfirm,
  select as clackSelect,
  multiselect as clackMultiselect,
  text as clackText,
  password as clackPassword,
  spinner as clackSpinner,
  isCancel,
} from '@clack/prompts';

/**
 * 启动 Clack 交互流程
 */
export function intro(title: string): void {
  clackIntro(title);
}

/**
 * 结束 Clack 交互流程
 */
export function outro(message: string): void {
  clackOutro(message);
}

/**
 * 取消交互流程
 */
export function cancel(message?: string): void {
  clackCancel(message || '操作已取消');
}

/**
 * 确认提示
 */
export async function confirm(message: string, initialValue?: boolean): Promise<boolean> {
  const result = await clackConfirm({
    message,
    initialValue,
  });
  return isCancel(result) ? false : result;
}

/**
 * 单选
 */
export async function select(
  message: string,
  options: Array<{ value: string; label: string; hint?: string }>,
  initialValue?: string,
): Promise<string | null> {
  const result = await clackSelect({
    message,
    options: options as any,
    initialValue,
  });
  if (isCancel(result)) return null;
  return result as string;
}

/**
 * 多选
 */
export async function multiselect(
  message: string,
  options: Array<{ value: string; label: string; hint?: string }>,
  required?: boolean,
  initialValue?: string[],
): Promise<string[]> {
  const result = await clackMultiselect({
    message,
    options: options as any,
    required,
    initialValues: initialValue,
  });
  if (isCancel(result)) return [];
  return result as string[];
}

/**
 * 文本输入
 */
export async function text(message: string, placeholder?: string, initialValue?: string): Promise<string | null> {
  const result = await clackText({
    message,
    placeholder,
    initialValue,
  });
  if (isCancel(result)) return null;
  return result;
}

/**
 * 密码输入
 */
export async function password(message: string): Promise<string | null> {
  const result = await clackPassword({
    message,
  });
  if (isCancel(result)) return null;
  return result;
}

/**
 * 数字输入
 */
export async function num(message: string, initialValue?: number, min?: number, max?: number): Promise<number | null> {
  const result = await clackText({
    message,
    initialValue: initialValue?.toString(),
    placeholder: min !== undefined && max !== undefined ? `${min} - ${max}` : undefined,
    validate: (value) => {
      const n = Number(value);
      if (isNaN(n)) return '请输入有效数字';
      if (min !== undefined && n < min) return `最小值为 ${min}`;
      if (max !== undefined && n > max) return `最大值为 ${max}`;
    },
  });
  if (isCancel(result)) return null;
  return Number(result);
}

/**
 * 进度提示（spinner）
 */
export function spinner(): {
  start: (message: string) => void;
  stop: (message: string) => void;
  message: (msg: string) => void;
} {
  const s = clackSpinner();
  return {
    start: (message: string) => { s.start(message); },
    stop: (message: string) => { s.stop(message); },
    message: (msg: string) => { s.message(msg); },
  };
}
