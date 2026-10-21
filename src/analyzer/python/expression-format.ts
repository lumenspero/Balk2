import type { CallArg, Comprehension, Expr, FStringPart, Param } from './ast.js';

/** Compact s-expression form of an expression, for tests and debugging. Spans are omitted. */
export function formatExpr(e: Expr): string {
  switch (e.kind) {
    case 'name':
      return e.id;
    case 'constant':
      return e.raw;
    case 'fstring':
      return `(f ${e.parts.map(formatPart).join('')})`;
    case 'attribute':
      return `(. ${formatExpr(e.value)} ${e.attr})`;
    case 'subscript':
      return `([] ${formatExpr(e.value)} ${formatExpr(e.index)})`;
    case 'slice':
      return `(slice ${optional(e.lower)} ${optional(e.upper)} ${optional(e.step)})`;
    case 'call':
      return `(call ${[formatExpr(e.func), ...e.args.map(formatArg)].join(' ')})`;
    case 'binop':
      return `(${e.op} ${formatExpr(e.left)} ${formatExpr(e.right)})`;
    case 'unaryop':
      return `(${e.op} ${formatExpr(e.operand)})`;
    case 'boolop':
      return `(${e.op} ${e.values.map(formatExpr).join(' ')})`;
    case 'compare': {
      const rest = e.ops.map((op, i) => `${op} ${formatExpr(e.comparators[i] ?? e.left)}`);
      return `(cmp ${formatExpr(e.left)} ${rest.join(' ')})`;
    }
    case 'ifexp':
      return `(if ${formatExpr(e.test)} ${formatExpr(e.body)} ${formatExpr(e.orelse)})`;
    case 'lambda':
      return `(lambda (${e.params.map(formatParam).join(' ')}) ${formatExpr(e.body)})`;
    case 'tuple':
      return `(tuple ${e.elements.map(formatExpr).join(' ')})`;
    case 'list':
      return `(list ${e.elements.map(formatExpr).join(' ')})`;
    case 'set':
      return `(set ${e.elements.map(formatExpr).join(' ')})`;
    case 'dict':
      return `(dict ${e.entries
        .map((entry) =>
          entry.key === null
            ? `**${formatExpr(entry.value)}`
            : `${formatExpr(entry.key)}:${formatExpr(entry.value)}`,
        )
        .join(' ')})`;
    case 'comprehension': {
      const value = e.value === null ? '' : ` : ${formatExpr(e.value)}`;
      const gens = e.generators.map(formatGenerator).join(' ');
      return `(${e.form}comp ${formatExpr(e.element)}${value} ${gens})`;
    }
    case 'starred':
      return `(* ${formatExpr(e.value)})`;
    case 'namedexpr':
      return `(:= ${formatExpr(e.target)} ${formatExpr(e.value)})`;
    case 'await':
      return `(await ${formatExpr(e.value)})`;
    case 'yield':
      return e.value === null ? '(yield)' : `(yield ${formatExpr(e.value)})`;
    case 'yieldfrom':
      return `(yield from ${formatExpr(e.value)})`;
  }
}

const optional = (e: Expr | null): string => (e === null ? '-' : formatExpr(e));

function formatPart(part: FStringPart): string {
  if (part.kind === 'literal') return part.raw;
  const debug = part.debug ? '=' : '';
  const conversion = part.conversion === null ? '' : `!${part.conversion}`;
  const spec = part.spec === null ? '' : `:${part.spec.map(formatPart).join('')}`;
  return `{${formatExpr(part.expr)}${debug}${conversion}${spec}}`;
}

function formatArg(arg: CallArg): string {
  const value = formatExpr(arg.value);
  switch (arg.kind) {
    case 'positional':
      return value;
    case 'keyword':
      return `${arg.name ?? ''}=${value}`;
    case 'star':
      return `*${value}`;
    case 'double-star':
      return `**${value}`;
  }
}

function formatParam(param: Param): string {
  const defaultValue = param.default === null ? '' : `=${formatExpr(param.default)}`;
  switch (param.kind) {
    case 'normal':
      return `${param.name ?? ''}${defaultValue}`;
    case 'vararg':
      return `*${param.name ?? ''}`;
    case 'kwarg':
      return `**${param.name ?? ''}`;
    case 'bare-star':
      return '*';
    case 'slash':
      return '/';
  }
}

function formatGenerator(gen: Comprehension): string {
  const ifs = gen.ifs.map((cond) => ` if ${formatExpr(cond)}`).join('');
  return `for ${formatExpr(gen.target)} in ${formatExpr(gen.iter)}${ifs}`;
}
