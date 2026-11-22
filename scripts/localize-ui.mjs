import ts from "typescript";

const attributes = new Set([
  "alt",
  "aria-label",
  "aria-description",
  "title",
  "placeholder",
  "label",
  "heading",
  "description",
  "subtitle",
  "hint",
  "status",
  "message",
  "emptyMessage",
  "emptyText",
  "automaticUnavailable",
  "manualUnavailable",
]);
const messageCalls = new Set([
  "alert",
  "confirm",
  "prompt",
  "Error",
  "DOMException",
  "setError",
  "setStatus",
  "setMessage",
  "setNotice",
  "setWarning",
  "setConflict",
  "draftText",
  "draftFormat",
]);
const internalLabels = new Set([
  "true",
  "false",
  "off",
  "on",
  "none",
  "auto",
  "button",
  "submit",
  "status",
  "dialog",
  "group",
  "main",
  "region",
  "textbox",
  "navigation",
  "tab",
  "string",
  "number",
  "object",
  "function",
  "undefined",
  "NaN",
  "http",
  "https",
  "json",
  "audio",
  "video",
  "svg",
  "path",
]);

function isMessage(text) {
  const key = text.trim();
  return (
    /[a-z]{2}/i.test(key) &&
    !internalLabels.has(key) &&
    !/^(?:https?:|\/|#|--|[\w-]+\.[\w-]+$)/.test(key) &&
    !/^[\w]+(?:_[\w]+)+$|^[a-z]+(?:[A-Z][a-z]+)+$/.test(key) &&
    !/^[A-Z0-9+ /-]{1,5}$/.test(key)
  );
}

export function localizeUI(
  text,
  filename,
  { callee, hasMessage = () => true, onMessage = () => {} } = {},
) {
  const file = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const edits = [];
  const stateSetters = new Set();
  function scan(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      ts.isCallExpression(node.initializer ?? node) &&
      /(?:^|\.)useState$/.test(node.initializer.expression.getText(file))
    ) {
      const setter = node.name.elements[1];
      if (setter && ts.isBindingElement(setter))
        stateSetters.add(setter.name.getText(file));
    }
    ts.forEachChild(node, scan);
  }
  scan(file);
  function add(node, key, replacement, start = node.getStart(file)) {
    if (!isMessage(key)) return;
    onMessage(key.trim());
    if (callee && hasMessage(key.trim()))
      edits.push({ start, end: node.end, replacement });
  }
  const translate = (key) => `${callee}(${JSON.stringify(key)})`;
  function visit(node, visible = false) {
    if (visible && ts.isIdentifier(node) && node.text === "kind") {
      if (callee)
        edits.push({
          start: node.getStart(file),
          end: node.end,
          replacement: `${callee}(kind)`,
        });
      return;
    }
    if (ts.isJsxText(node)) {
      const lines = node.text.split(/\r\n|\r|\n/);
      const normalized = lines
        .map((line, index) => {
          if (index > 0) line = line.trimStart();
          if (index < lines.length - 1) line = line.trimEnd();
          return line;
        })
        .filter(Boolean)
        .join(" ");
      add(node, normalized, `{${translate(normalized)}}`, node.pos);
      return;
    }
    if (ts.isJsxAttribute(node)) {
      if (!attributes.has(node.name.getText(file)) || !node.initializer) return;
      const value = node.initializer;
      if (ts.isStringLiteral(value))
        add(value, value.text, `{${translate(value.text)}}`);
      else visit(value, true);
      return;
    }
    if (
      visible &&
      ts.isPropertyAccessExpression(node) &&
      ["kind", "message", "name"].includes(node.name.text)
    ) {
      const value = node.getText(file);
      if (callee)
        edits.push({
          start: node.getStart(file),
          end: node.end,
          replacement:
            node.name.text === "name"
              ? `${callee}(${value}, [], true)`
              : `${callee}(${value})`,
        });
      return;
    }
    if (
      visible &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "replace" &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === "name"
    ) {
      if (callee)
        edits.push({
          start: node.getStart(file),
          end: node.end,
          replacement: `${callee}(${node.getText(file)}, [], true)`,
        });
      return;
    }
    if (visible && ts.isElementAccessExpression(node)) {
      visit(node.expression, visible);
      visit(node.argumentExpression);
      return;
    }
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      ts.isStringLiteralLike(node.expression) &&
      node.expression.text === "Full-length"
    ) {
      visit(node.expression, true);
      return;
    }
    if (
      ts.isStringLiteralLike(node) &&
      visible &&
      (visible !== "state" ||
        /(?:.*\s){2}|[.!?…]$|^\s*$/.test(node.text.trim()))
    ) {
      add(node, node.text, translate(node.text));
      return;
    }
    if (ts.isTemplateExpression(node) && visible) {
      let key = node.head.text;
      const values = [];
      for (const span of node.templateSpans) {
        key += `{v${values.length}}` + span.literal.text;
        values.push(span.expression.getText(file));
      }
      add(
        node,
        key,
        `${callee}(${JSON.stringify(key)}, [${values.join(",")}])`,
      );
      return;
    }
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.text;
      const jsxProps =
        ts.isObjectLiteralExpression(node.parent) &&
        ts.isCallExpression(node.parent.parent);
      visit(
        node.initializer,
        name === "children" ||
          (name === "status" ? jsxProps : attributes.has(name)),
      );
      return;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : node.expression.getText(file);
      if (["t", "uiText", "draftText", "draftFormat"].includes(name)) {
        const first = node.arguments?.[0];
        if (first && ts.isStringLiteralLike(first))
          onMessage(first.text.trim());
        return;
      }
      if (ts.isPropertyAccessExpression(node.expression))
        visit(node.expression.expression);
      else if (!ts.isIdentifier(node.expression)) visit(node.expression);
      const args = node.arguments ?? [];
      for (const [index, argument] of args.entries())
        visit(
          argument,
          (name === "createElement" && index >= 2) ||
            (messageCalls.has(name) && index === 0) ||
            ((stateSetters.has(name) || name === "useState") && index === 0
              ? "state"
              : false),
        );
      return;
    }
    if (ts.isConditionalExpression(node)) {
      visit(node.condition);
      visit(node.whenTrue, visible);
      visit(node.whenFalse, visible);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      visit(
        node.left,
        visible &&
          (operator === ts.SyntaxKind.PlusToken ||
            operator === ts.SyntaxKind.QuestionQuestionToken ||
            operator === ts.SyntaxKind.BarBarToken),
      );
      visit(
        node.right,
        visible &&
          (operator === ts.SyntaxKind.PlusToken ||
            operator === ts.SyntaxKind.QuestionQuestionToken ||
            operator === ts.SyntaxKind.BarBarToken ||
            operator === ts.SyntaxKind.AmpersandAmpersandToken),
      );
      return;
    }
    const carriesText =
      ts.isArrayLiteralExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isJsxExpression(node) ||
      ts.isReturnStatement(node) ||
      ts.isArrowFunction(node);
    ts.forEachChild(node, (child) =>
      visit(child, ts.isJsxExpression(child) || (carriesText && visible)),
    );
  }
  visit(file);
  for (const edit of edits.sort((a, b) => b.start - a.start))
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  return text;
}

export function shouldLocalizeSource(filename) {
  if (!filename.includes("/src/") && !filename.startsWith("src/")) return false;
  return (
    filename.endsWith(".tsx") ||
    /\/(ble|ifit|catalog|mediaServer|accountClient|defaultProgrammes|deviceProbe|workout|workoutCompletion)\.ts$/.test(
      filename,
    )
  );
}
