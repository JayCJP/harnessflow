/**
 * errors.js — 结构化错误辅助（门控输出与经验沉淀的公用类型）
 *
 * 职责:
 *   - structuredError: 造一个带 failureType 的错误对象，替代裸字符串
 *   - errorToString / errorToType: 兼容「旧调用方还在传纯字符串」的读取侧
 *
 * 用法:
 *   const { structuredError, errorToString, errorToType } = require('./errors')
 *
 * 使用场景:
 *   - services/policy.js: 门控输出的 blockers 全是结构化错误，主 Agent 直接读
 *     type 就知道该怎么修，不必从 message 里猜
   - services/experience.js: 失败模式沉淀直接拿 type 当 failureType，
 *     无需关键词匹配（历史上靠正则猜类型，猜错就沉淀到错误的桶里）
 *
 * 说明:
 *   - level 是恢复等级：1=自动修复，2=提示修复，3=降级，4=人工介入。
 *     当前 policy.js 的 RECOVERY_SUGGESTIONS 无 level 1 条目（历史 3 个 autoFix 永不执行，
 *     已连同其驱动函数 attemptAutoRecovery 一并删除），实际只用到 2/3/4。
 *   - 本模块零依赖，可安全被任意层引用。
 */

/**
 * 创建结构化错误对象，用于门控校验输出
 * 结构化错误携带 failureType，可直接用于经验沉淀，无需关键词猜测
 * @param {string} type - 错误类型标识（如 'ac_missing_id', 'task_missing_title'）
 * @param {string} message - 错误描述文本（人可读）
 * @param {number} [level=2] - 恢复等级 (1=自动修复, 2=提示修复, 3=降级, 4=人工介入)
 * @param {string} [resolution=''] - 建议的解决方案
 * @returns {{ type: string, message: string, level: number, resolution: string }}
 */
function structuredError (type, message, level = 2, resolution = '') {
  return { type, message, level, resolution }
}

/**
 * 将结构化错误对象转为字符串（兼容旧的纯字符串 errors 格式）
 * @param {{ type: string, message: string }|string} err - 结构化错误或纯字符串
 * @returns {string} 纯字符串
 */
function errorToString (err) {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && err.message) return err.message
  return String(err)
}

/**
 * 从错误中提取 failureType（结构化错误直接取 type，纯字符串返回 'unknown'）
 * @param {{ type: string, message: string }|string} err - 结构化错误或纯字符串
 * @returns {string} failureType
 */
function errorToType (err) {
  if (typeof err === 'string') return 'unknown'
  if (err && typeof err === 'object' && err.type) return err.type
  return 'unknown'
}

module.exports = {
  structuredError,
  errorToString,
  errorToType
}
