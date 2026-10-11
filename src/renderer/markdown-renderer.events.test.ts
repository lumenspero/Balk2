import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import type { ConnectionMap } from '../types.js';
import { renderMarkdown } from './markdown-renderer.js';

const METADATA = { generatedAt: '2026-01-01T00:00:00Z' };

/** The lines of one `### heading` section, up to the next heading. */
function section(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`### ${heading}`));
  if (start < 0) throw new Error(`No section for ${heading}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('#'));
  return (end < 0 ? rest : rest.slice(0, end)).filter((line) => line.length > 0);
}

function eventMap(): ConnectionMap {
  const graph = new ConnectionGraph();
  graph.addFile('src/net.ts', 'typescript');
  graph.addFile('src/ui.ts', 'typescript');
  graph.addSymbol('src/net.ts', 'connect', 'function');
  graph.addSymbol('src/ui.ts', 'onReady', 'function');
  graph.addSymbol('src/ui.ts', 'cleanup', 'function');

  const socketReady = graph.addEventChannel('ready', 'src/net.ts:socket').id;
  const documentReady = graph.addEventChannel('ready', 'global:document').id;

  graph.addRelationship('emits', 'src/net.ts:connect', socketReady);
  graph.addRelationship('subscribes', 'src/ui.ts:onReady', socketReady, 'high', {
    metadata: { once: true },
  });
  graph.addRelationship('unsubscribes', 'src/ui.ts:cleanup', socketReady);
  graph.addRelationship('dispatches', 'src/ui.ts', documentReady, 'medium');
  return graph.build(METADATA);
}

describe('event channels', () => {
  const markdown = renderMarkdown(eventMap());

  it('shows publishers and subscribers together under their shared channel', () => {
    expect(section(markdown, 'event:src/net.ts:socket#ready')).toEqual([
      'Event: ready',
      'Scope: src/net.ts:socket',
      'Emitted by:',
      '  ← src/net.ts:connect',
      'Subscribed by:',
      '  ← src/ui.ts:onReady (once)',
      'Unsubscribed by:',
      '  ← src/ui.ts:cleanup',
    ]);
  });

  it('keeps same-named channels with different scopes separate', () => {
    expect(section(markdown, 'event:global:document#ready')).toEqual([
      'Event: ready',
      'Scope: global:document',
      'Dispatched by:',
      '  ← src/ui.ts (medium confidence)',
    ]);
  });

  it('lists the channels a symbol or file takes part in', () => {
    expect(section(markdown, 'src/net.ts:connect')).toEqual([
      'Emits:',
      '  → event:src/net.ts:socket#ready',
    ]);
    expect(section(markdown, 'src/ui.ts:onReady')).toEqual([
      'Subscribes to:',
      '  → event:src/net.ts:socket#ready (once)',
    ]);
    expect(section(markdown, 'src/ui.ts (')).toEqual([
      '*(No direct file imports)*',
      'Dispatches:',
      '  → event:global:document#ready (medium confidence)',
    ]);
  });

  it('does not list channel nodes as symbols', () => {
    const symbolSection = markdown.slice(
      markdown.indexOf('## Symbol Connections'),
      markdown.indexOf('## Event Channels'),
    );
    expect(symbolSection).not.toContain('### event:');
  });

  it('counts channels in the overview only when there are some', () => {
    expect(markdown).toContain('- **Event Channels**: 2');
    const plain = new ConnectionGraph();
    plain.addFile('a.ts');
    expect(renderMarkdown(plain.build(METADATA))).not.toContain('Event Channels');
  });
});

describe('unresolved observations', () => {
  const graph = new ConnectionGraph();
  graph.addSymbol('src/use.ts', 'run', 'function');
  const node = graph.addUnresolved({
    reason: 'ambiguous-global',
    attempted: 'references',
    subject: 'init',
    location: { filePath: 'src/use.ts', startLine: 7, startColumn: 3, endLine: 7, endColumn: 7 },
    candidates: ['src/b.ts:init', 'src/a.ts:init'],
  });
  graph.addRelationship('references', 'src/use.ts:run', node.id, 'low', { evidence: 'ts-program' });
  const markdown = renderMarkdown(graph.build(METADATA));

  it('renders the diagnostic with its candidates and where it was observed', () => {
    expect(section(markdown, node.id)).toEqual([
      'Reason: ambiguous-global',
      'Subject: init',
      'Attempted: references',
      'Location: src/use.ts:7:3',
      'Candidates:',
      '  - src/a.ts:init',
      '  - src/b.ts:init',
      'Observed from:',
      '  ← src/use.ts:run (references)',
    ]);
  });

  it('shows the low-confidence link from the owning symbol', () => {
    expect(section(markdown, 'src/use.ts:run')).toEqual([
      'References:',
      `  → ${node.id} (low confidence)`,
    ]);
  });

  it('is not listed among symbols and is counted in the overview', () => {
    const symbolSection = markdown.slice(
      markdown.indexOf('## Symbol Connections'),
      markdown.indexOf('## Unresolved Observations'),
    );
    expect(symbolSection).not.toContain('### unresolved:');
    expect(markdown).toContain('- **Unresolved Observations**: 1');
    expect(markdown.indexOf('## Unresolved Observations')).toBeGreaterThan(
      markdown.indexOf('## Symbol Connections'),
    );
  });
});

describe('unresolved observation detail', () => {
  const graph = new ConnectionGraph();
  const node = graph.addUnresolved({
    reason: 'dynamic-event-name',
    attempted: 'emits',
    subject: 'bus.emit(name)',
    location: { filePath: 'src/a.ts', startLine: 3, startColumn: 5, endLine: 3, endColumn: 19 },
    detail: '"name" is not a constant',
  });
  graph.addRelationship('emits', 'src/a.ts:run', node.id, 'low');
  const markdown = renderMarkdown(graph.build(METADATA));

  it('explains why the code could not be resolved', () => {
    expect(section(markdown, node.id)).toEqual([
      'Reason: dynamic-event-name',
      'Subject: bus.emit(name)',
      'Detail: "name" is not a constant',
      'Attempted: emits',
      'Location: src/a.ts:3:5',
      'Observed from:',
      '  ← src/a.ts:run (emits)',
    ]);
  });
});

describe('connection paths through event channels', () => {
  const markdown = renderMarkdown(eventMap());
  const paths = markdown.slice(markdown.indexOf('## Connection Paths'));

  it('traces a publisher to its subscriber through the shared channel', () => {
    expect(section(paths, 'event:src/net.ts:socket#ready')).toEqual([
      '  src/net.ts:connect',
      '  → emits →',
      '  event:src/net.ts:socket#ready',
      '  ← subscribed by ←',
      '  src/ui.ts:onReady',
    ]);
  });

  it('shows a channel with only a publisher as a single hop', () => {
    expect(section(paths, 'event:global:document#ready')).toEqual([
      '  src/ui.ts',
      '  → dispatches →',
      '  event:global:document#ready',
    ]);
  });

  it('can leave event channels out of the paths', () => {
    const without = renderMarkdown(eventMap(), { pathOptions: { includeEventChannels: false } });
    expect(without).not.toContain('## Connection Paths');
    expect(without).toContain('## Event Channels');
  });
});

describe('listener lifecycle notes', () => {
  const graph = new ConnectionGraph();
  const channel = graph.addEventChannel('click', 'global:document').id;
  graph.addRelationship('subscribes', 'src/a.ts:once', channel, 'high', {
    metadata: { once: true },
  });
  graph.addRelationship('subscribes', 'src/a.ts:both', channel, 'medium', {
    metadata: { once: true, abortable: true, capture: true, passive: true },
  });
  graph.addRelationship('subscribes', 'src/a.ts:plain', channel, 'high', {
    metadata: { capture: true, passive: true },
  });
  const markdown = renderMarkdown(graph.build(METADATA));

  it('shows once and abortable, which change what a listener does', () => {
    expect(section(markdown, channel)).toEqual([
      'Event: click',
      'Scope: global:document',
      'Subscribed by:',
      '  ← src/a.ts:both (medium confidence, once, abortable)',
      '  ← src/a.ts:once (once)',
      '  ← src/a.ts:plain',
    ]);
  });
});
