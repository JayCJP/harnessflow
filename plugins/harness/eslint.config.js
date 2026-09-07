/**
 * eslint.config.js — harness 插件的 lint 配置（ESLint flat config）
 *
 * 为什么需要:
 *   - no-undef 取代 audit/harness-audit.js 里 178 行手写的正则悬空引用扫描器
 *     （那份实现自述「启发式……仍可能误报，故一律降为 WARNING」；ESLint 走真实 AST，
 *     准确率不是「高置信命中」而是确定的）
 *   - 统一风格: 改前 `function f (` 180 处 vs `function f(` 43 处且三个文件内部混用，
 *     harness-audit.js 全文双引号而其余 20 个文件单引号
 *
 * 约束:
 *   - 只进 devDependencies。插件被安装后必须 node 直跑、零运行时依赖
 *     （dependencies 为空 + vendor/ajv.bundle.js 是刻意设计）
 *   - vendor/ 必须排除: ajv.bundle.js 是 browserify 产物，单行十万字符
 *
 * 用法:
 *   npm run lint        检查
 *   npm run lint:fix    自动修复风格问题
 */

const neostandard = require('neostandard')

module.exports = [
  {
    // vendor 是第三方 bundle（单行十万字符），node_modules 与 graphify-out 是生成物
    ignores: ['vendor/**', 'node_modules/**', 'graphify-out/**']
  },

  ...neostandard({
    // 现有代码是 CommonJS + 无分号的 standard 风格，与 neostandard 默认一致
    noStyle: false,
    semi: false,
    globals: ['process', 'console', 'Buffer', '__dirname', '__filename', 'module', 'require', 'exports']
  }),

  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs'
    },
    rules: {
      // ── 本次重构真正想要的规则 ──
      // no-undef 是替换手写扫描器的核心（默认已开，此处显式声明意图）
      'no-undef': 'error',
      'no-unused-vars': ['error', {
        args: 'none', // 大量 JSDoc 化的回调保留形参名做文档，不视为未用
        caughtErrors: 'none' // catch (e) 里静默吞掉是本项目的既定模式（trace/debug 旁路）
      }],

      // ── 与现有代码风格冲突、暂不强制的项 ──
      // 现有代码大量使用中文标点与长行注释，行宽限制会产出上千条噪音
      '@stylistic/max-len': 'off',
      // 现有 JSON 输出拼接常用多行三元，格式化会改变可读性
      '@stylistic/multiline-ternary': 'off',
      // camelcase: hook 输入契约字段是 tool_name / tool_input / file_path（宿主定义，不能改）
      camelcase: 'off',
      // 大量输出是「给 Agent 照抄的命令模板」，其中的 ${CLAUDE_PLUGIN_ROOT} 必须保持字面量，
      // 改成真插值反而会输出空串 —— 这类字符串是刻意的，规则在此处只有误报
      'no-template-curly-in-string': 'off'
    }
  }
]
