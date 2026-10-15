import * as ts from 'typescript';
import type { SourceSpan, StateOperation, StateRelationship } from '../types.js';
import { isIdentifierPosition } from './global-references.js';
import { enclosingOwner } from './owner.js';
import { snippetOf, spanOf } from './spans.js';
import { isConst, unwrapExpression } from './static-keys.js';
import { destructuringOf, type StateReference, type StateRootResolver } from './state-roots.js';

/**
 * One read, write or delete of shared state at one place in the source. A reference whose
 * segments include `null` touches a computed property; the caller decides whether that becomes a
 * wildcard path or an unresolved observation (`state.dynamicPaths`).
 */
export interface StateAccessFact {
  readonly relationship: StateRelationship;
  readonly operation: StateOperation;
  readonly reference: StateReference;
  /** Symbol id of the enclosing function, method or class, or the file path */
  readonly owner: string;
  readonly span: SourceSpan;
  /** The accessing expression on one line, for diagnostics */
  readonly subject: string;
}

type Use = readonly [StateRelationship, StateOperation];

const READ: Use = ['readsState', 'read'];
const ASSIGN: Use = ['writesState', 'assign'];
const DELETE: Use = ['deletesState', 'delete'];

/**
 * Every static access to shared state in one file.
 *
 * Only the outermost expression of a property chain is an access: `store.cart.items = []` writes
 * `cart.items` and does not also read `store` or `store.cart`. How it is used decides the
 * operation:
 *
 * - `=` (including a destructuring or `for...of` target) writes;
 * - `+=`, `||=` and the like read and write (`compound-assign`);
 * - `++` and `--` read and write (`increment`);
 * - `delete` deletes;
 * - anything else reads.
 *
 * A call is behavior, not data access: `store.items.push(x)` and `App.init()` record nothing here.
 * Calls to state methods (`store.get('user')`) are recognized separately.
 *
 * Destructuring with `const` reads each destructured path (`const { cart } = store` reads
 * `cart`), not the whole container.
 */
export function collectStateAccesses(
  sourceFile: ts.SourceFile,
  filePath: string,
  resolver: StateRootResolver,
): StateAccessFact[] {
  const facts: StateAccessFact[] = [];
  const handled = new Set<ts.Node>();

  const record = (node: ts.Node, reference: StateReference, uses: readonly Use[]): void => {
    const owner = enclosingOwner(node, filePath);
    const span = spanOf(node, filePath);
    const subject = snippetOf(node);
    for (const [relationship, operation] of uses) {
      facts.push({ relationship, operation, reference, owner, span, subject });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) recordDestructuring(node, resolver, handled, record);

    if (!handled.has(node) && isAccessCandidate(node)) {
      const uses = usesOf(node);
      if (uses.length > 0) {
        const reference = resolver.resolve(node);
        if (reference) record(node, reference, uses);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return facts.sort(
    (a, b) =>
      a.span.startLine - b.span.startLine ||
      a.span.startColumn - b.span.startColumn ||
      (a.relationship < b.relationship ? -1 : a.relationship > b.relationship ? 1 : 0),
  );
}

/** The outermost expression of a property chain, or an identifier used as a value. */
function isAccessCandidate(node: ts.Node): node is ts.Expression {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return !isChainBase(node);
  }
  if (ts.isIdentifier(node)) {
    return (
      isIdentifierPosition(node) &&
      !isChainBase(node) &&
      !ts.isTypeQueryNode(node.parent) &&
      !ts.isQualifiedName(node.parent)
    );
  }
  return false;
}

/** True when `node` is the object of a longer property chain (`store` in `store.cart`). */
function isChainBase(node: ts.Expression): boolean {
  const outer = climbWrappers(node);
  const parent = outer.parent;
  return (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === outer
  );
}

/** What the code does to the value of `node`; empty when it is called rather than accessed. */
function usesOf(node: ts.Expression): readonly Use[] {
  const outer = climbWrappers(node);
  const parent = outer.parent;

  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === outer) {
    return [];
  }
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === outer) return [];
  if (ts.isDecorator(parent)) return [];
  // `export default store` re-exports the binding without reading its contents, as `export { store }`
  // does. A property path there (`export default store.user`) is still evaluated, so it is a read.
  if (ts.isIdentifier(node) && ts.isExportAssignment(parent)) return [];

  if (ts.isDeleteExpression(parent) && parent.expression === outer) return [DELETE];

  if (ts.isBinaryExpression(parent) && parent.left === outer && isAssignment(parent)) {
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ? [ASSIGN]
      : [
          ['readsState', 'compound-assign'],
          ['writesState', 'compound-assign'],
        ];
  }

  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return [
      ['readsState', 'increment'],
      ['writesState', 'increment'],
    ];
  }

  if (isDestructuringTarget(outer)) return [ASSIGN];

  return [READ];
}

/**
 * `const { a, b: { c } } = <state>` reads `a` and `b.c`, one fact per binding, rather than the
 * whole container. The initializer is then marked handled so it is not also read as a whole.
 */
function recordDestructuring(
  declaration: ts.VariableDeclaration,
  resolver: StateRootResolver,
  handled: Set<ts.Node>,
  record: (node: ts.Node, reference: StateReference, uses: readonly Use[]) => void,
): void {
  if (!ts.isObjectBindingPattern(declaration.name) || !declaration.initializer) return;
  if (!isConst(declaration)) return;

  const base = resolver.resolve(declaration.initializer);
  if (!base) return;

  const leaves = bindingLeaves(declaration.name);
  const destructured = leaves.map(destructuringOf);
  // A rest element or computed key leaves part of the read unknown; read the container instead.
  if (destructured.some((entry) => entry === undefined)) return;

  handled.add(declaration.initializer);
  handled.add(unwrapExpression(declaration.initializer));
  leaves.forEach((leaf, index) => {
    const keys = destructured[index]?.keys ?? [];
    record(leaf, { ...base, segments: [...base.segments, ...keys] }, [READ]);
  });
}

/** Binding elements that bind a name, through nested object patterns. */
function bindingLeaves(pattern: ts.ObjectBindingPattern): ts.BindingElement[] {
  return pattern.elements.flatMap((element) =>
    ts.isObjectBindingPattern(element.name) ? bindingLeaves(element.name) : [element],
  );
}

/** True when `node` is assigned through an object or array destructuring, or a `for...of`/`in`. */
function isDestructuringTarget(node: ts.Expression): boolean {
  let current: ts.Node = node;
  let throughLiteral = false;

  for (;;) {
    const parent: ts.Node = current.parent;

    if (ts.isPropertyAssignment(parent) && parent.initializer === current) {
      current = parent.parent;
      throughLiteral = true;
    } else if (
      (ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) &&
      parent.expression === current
    ) {
      current = parent.parent;
      throughLiteral = true;
    } else if (ts.isArrayLiteralExpression(parent) || ts.isObjectLiteralExpression(parent)) {
      current = parent;
      throughLiteral = true;
    } else if (ts.isParenthesizedExpression(parent)) {
      current = parent;
    } else if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      return throughLiteral && parent.left === current;
    } else if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) {
      return parent.initializer === current;
    } else {
      return false;
    }
  }
}

function isAssignment(node: ts.BinaryExpression): boolean {
  return (
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

/** The outermost of `(x)`, `x!`, `x as T`, `x satisfies T` and `<T>x` around `node`. */
function climbWrappers(node: ts.Expression): ts.Expression {
  let current: ts.Expression = node;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isNonNullExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent) ||
    ts.isTypeAssertionExpression(current.parent)
  ) {
    current = current.parent;
  }
  return current;
}
