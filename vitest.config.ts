import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 10000,
    include: ['tests/**/*.test.ts'],
    watch: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: {
      // 测试文件中 import 的路径需要对应到 src 目录
    },
  },
});
