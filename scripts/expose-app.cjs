'use strict';

const { parseAst } = require('rollup/parseAst');

// Test-only response instrumentation: production files are never modified.
// Identify App by its domain methods, not the bundler's local class name.
const appMethods = ['startRecording', 'stopRecording', 'captureView', 'restoreView', 'setNoclip', 'renderLoop'];

module.exports = function exposeApp(source) {
  const program = parseAst(source);
  const classes = new Map();
  for (const node of program.body) {
    if (node.type !== 'ClassDeclaration' || !node.id) continue;
    const methods = new Set(node.body.body.filter(member => member.type === 'MethodDefinition' && !member.computed).map(member => member.key.name));
    if (appMethods.every(name => methods.has(name))) classes.set(node.id.name, node);
  }
  const candidates = program.body.filter(node => node.type === 'ExpressionStatement'
    && node.expression.type === 'NewExpression'
    && node.expression.callee.type === 'Identifier'
    && node.expression.arguments.length === 0
    && classes.has(node.expression.callee.name));
  if (!candidates.length) return source;
  if (candidates.length !== 1) throw new Error('Ambiguous top-level App construction');
  const statement = candidates[0];
  // Bundlers may append export alias declarations after the terminal App call.
  if (program.body.some(node => node.start > statement.start && node.type === 'ExpressionStatement')) {
    throw new Error('App construction is not the terminal top-level expression');
  }
  return source.slice(0, statement.expression.start) + 'window.__app=' + source.slice(statement.expression.start);
};
