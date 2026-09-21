import type { Mode } from './router';
import { TOOL_DEFINITIONS, TOOL_HANDLERS, type ToolDefinition } from './tools';

export const WRITE_TOOL_NAMES = ['confirmGeoAlert', 'dismissGeoAlert'] as const;
const ACTION_TOOL_NAMES: readonly string[] = ['getGeoHitlAlerts', ...WRITE_TOOL_NAMES];

export interface Toolset {
  definitions: ToolDefinition[];
  handlers: Record<string, (args: any) => unknown>;
  webSearch: boolean;
}

function pick(names: (name: string) => boolean): Pick<Toolset, 'definitions' | 'handlers'> {
  const definitions = TOOL_DEFINITIONS.filter((d) => names(d.function.name));
  const handlers: Record<string, (args: any) => unknown> = {};
  for (const d of definitions) handlers[d.function.name] = TOOL_HANDLERS[d.function.name];
  return { definitions, handlers };
}

/**
 * Tools available for one request. Write tools are included only in `action` mode, and
 * because handlers are copied per mode, a `web` request cannot resolve them even if the
 * model hallucinates a call to one.
 */
export function buildToolset(mode: Mode): Toolset {
  if (mode === 'action') return { ...pick((n) => ACTION_TOOL_NAMES.includes(n)), webSearch: false };
  const read = pick((n) => !(WRITE_TOOL_NAMES as readonly string[]).includes(n));
  return { ...read, webSearch: mode === 'web' };
}
