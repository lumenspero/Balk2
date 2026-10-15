import * as ts from 'typescript';
import type { Evidence } from '../types.js';
import { enclosingOwner } from './owner.js';
import type { RepositoryProgram } from './repository-program.js';
import { unwrapExpression } from './static-keys.js';

/**
 * Who a method is called on, reduced to a stable identity so two uses of the same emitter
 * share an event channel and unrelated emitters never do.
 *
 * A scope looks like:
 * - `src/bus.ts:bus`: a module-level binding, however it is imported
 * - `src/app.ts:setup.emitter`: a local or parameter (one per declaration)
 * - `src/svc.ts:Svc.bus`: a class property, reached through `this` or an instance
 * - `src/app.ts:app.events.bus`: a property of an object literal bound to a variable
 * - `src/svc.ts:Svc`: `this` inside a class
 * - `global:document`, `global:window.document`: declared outside the repository
 * - `external:some-lib:bus`: imported from a package
 */
export type ReceiverIdentity =
  | {
      readonly kind: 'resolved';
      readonly scope: string;
      /** `high` for module-level and global receivers; `medium` where identity is approximate */
      readonly confidence: 'high' | 'medium';
      readonly evidence: Evidence;
    }
  | { readonly kind: 'unknown'; readonly reason: string };

const MAX_DEPTH = 6;

export class ReceiverResolver {
  private readonly pathOf: ReadonlyMap<ts.SourceFile, string>;
  private readonly checker: ts.TypeChecker;

  constructor(repository: RepositoryProgram) {
    this.checker = repository.checker;
    this.pathOf = new Map(
      [...repository.sourceFiles].map(([filePath, sourceFile]) => [sourceFile, filePath]),
    );
  }

  resolve(expression: ts.Expression): ReceiverIdentity {
    return this.resolveNode(expression, 0);
  }

  private resolveNode(expression: ts.Expression, depth: number): ReceiverIdentity {
    const node = unwrapExpression(expression);
    if (depth > MAX_DEPTH) return unknown('reference chain too deep');

    if (ts.isIdentifier(node)) return this.resolveIdentifier(node, depth);
    if (node.kind === ts.SyntaxKind.ThisKeyword) return this.resolveThis(node);
    if (
      ts.isPropertyAccessExpression(node) ||
      (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    ) {
      return this.resolveProperty(node, depth);
    }
    return unknown('receiver is a computed expression');
  }

  private resolveIdentifier(node: ts.Identifier, depth: number): ReceiverIdentity {
    const original = this.checker.getSymbolAtLocation(node);
    if (!original) return unknown(`"${node.text}" is not resolved`);

    let symbol = original;
    let importedFrom: string | undefined;
    if (original.flags & ts.SymbolFlags.Alias) {
      importedFrom = moduleSpecifierOf(original);
      symbol = this.checker.getAliasedSymbol(original);
    }

    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) return unknown(`"${node.text}" has no declaration`);

    const sourceFile = declaration.getSourceFile();
    const filePath = this.pathOf.get(sourceFile);
    if (filePath === undefined || sourceFile.isDeclarationFile) {
      const scope =
        importedFrom !== undefined
          ? `external:${importedFrom}:${symbol.getName()}`
          : `global:${symbol.getName()}`;
      return resolved(scope, 'high');
    }

    // `const b = bus` is the same emitter as `bus`.
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0
    ) {
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer)) {
        const target = this.resolveNode(initializer, depth + 1);
        if (target.kind === 'resolved') return target;
      }
    }

    return this.declarationIdentity(declaration, symbol.getName(), filePath);
  }

  private resolveProperty(
    node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    depth: number,
  ): ReceiverIdentity {
    const nameNode = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
    const name = ts.isIdentifier(nameNode) || ts.isStringLiteralLike(nameNode) ? nameNode.text : '';
    if (name === '') return unknown('property name is not static');

    // Class properties and object-literal properties have an identity of their own, whichever
    // path reaches them (`this.bus`, `svc.bus`).
    const symbol = this.checker.getSymbolAtLocation(nameNode);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (declaration && isDeclaredMember(declaration)) {
      const sourceFile = declaration.getSourceFile();
      const filePath = this.pathOf.get(sourceFile);
      if (filePath !== undefined && !sourceFile.isDeclarationFile) {
        return this.declarationIdentity(declaration, name, filePath);
      }
    }

    // Anything else is the identity of its root plus the property path.
    const root = this.resolveNode(node.expression, depth + 1);
    if (root.kind === 'unknown') return root;
    return resolved(
      `${root.scope}.${name}`,
      root.scope.startsWith('global:') ? root.confidence : 'medium',
    );
  }

  private resolveThis(node: ts.Node): ReceiverIdentity {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isClassLike(current)) {
        const filePath = this.pathOf.get(node.getSourceFile());
        return current.name && filePath !== undefined
          ? resolved(`${filePath}:${current.name.text}`, 'medium')
          : unknown('this in an anonymous class');
      }
      if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) {
        return unknown('this in a plain function');
      }
      if (ts.isObjectLiteralExpression(current)) return unknown('this in an object literal');
    }
    return unknown('this outside a class');
  }

  private declarationIdentity(
    declaration: ts.Declaration,
    name: string,
    filePath: string,
  ): ReceiverIdentity {
    if (ts.isPropertyDeclaration(declaration)) {
      return classMember(declaration.parent, name, filePath);
    }
    if (
      ts.isParameter(declaration) &&
      ts.isParameterPropertyDeclaration(declaration, declaration.parent)
    ) {
      return classMember(declaration.parent.parent, name, filePath);
    }
    if (ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration)) {
      return this.objectLiteralMember(declaration, name, filePath);
    }

    const owner = enclosingOwner(declaration.parent, filePath);
    return owner === filePath
      ? resolved(`${filePath}:${name}`, 'high')
      : resolved(`${owner}.${name}`, 'medium');
  }

  /** `const app = { events: { bus } }` gives `bus` the identity `app.events.bus`. */
  private objectLiteralMember(
    declaration: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
    name: string,
    filePath: string,
  ): ReceiverIdentity {
    const path = [name];
    let literal: ts.Node = declaration.parent;

    for (;;) {
      let parent: ts.Node = literal.parent;
      while (
        ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent)
      ) {
        parent = parent.parent;
      }

      if (
        ts.isPropertyAssignment(parent) &&
        (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))
      ) {
        path.unshift(parent.name.text);
        literal = parent.parent;
        continue;
      }

      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        const base = this.declarationIdentity(parent, parent.name.text, filePath);
        return base.kind === 'resolved'
          ? { ...base, scope: `${base.scope}.${path.join('.')}` }
          : base;
      }

      return unknown('object literal is not bound to a variable');
    }
  }
}

function isDeclaredMember(declaration: ts.Declaration): boolean {
  return (
    ts.isPropertyDeclaration(declaration) ||
    ts.isPropertyAssignment(declaration) ||
    ts.isShorthandPropertyAssignment(declaration) ||
    (ts.isParameter(declaration) &&
      ts.isParameterPropertyDeclaration(declaration, declaration.parent))
  );
}

function classMember(classNode: ts.Node, name: string, filePath: string): ReceiverIdentity {
  if (ts.isClassLike(classNode) && classNode.name) {
    return resolved(`${filePath}:${classNode.name.text}.${name}`, 'medium');
  }
  return unknown('class member of an anonymous class');
}

function moduleSpecifierOf(alias: ts.Symbol): string {
  const declaration = alias.declarations?.[0];
  const importDeclaration = declaration
    ? ts.findAncestor(declaration, ts.isImportDeclaration)
    : undefined;
  const specifier = importDeclaration?.moduleSpecifier;
  return specifier && ts.isStringLiteral(specifier) ? specifier.text : 'unknown';
}

function resolved(scope: string, confidence: 'high' | 'medium'): ReceiverIdentity {
  return { kind: 'resolved', scope, confidence, evidence: 'ts-program' };
}

function unknown(reason: string): ReceiverIdentity {
  return { kind: 'unknown', reason };
}
