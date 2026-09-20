export type ToolStability = 'stable' | 'experimental';
export type ToolPolicy = { name: string; stability: ToolStability };

// This registry is intentionally independent from the JSON schemas so ordinary
// launcher/config commands do not read contract files. Adding a future tool
// requires an explicit policy entry; experimental entries remain disabled by
// default until the user opts in with tools.allow.
export const toolPolicies: readonly ToolPolicy[] = [
  { name: 'exec_command', stability: 'stable' },
  { name: 'write_stdin', stability: 'stable' },
  { name: 'apply_patch', stability: 'stable' },
  { name: 'view_image', stability: 'stable' },
  { name: 'list_exec_sessions', stability: 'stable' },
  { name: 'terminate_exec_session', stability: 'stable' }
];

export const knownToolNames = new Set(toolPolicies.map(tool => tool.name));
export const defaultToolAllowlist = toolPolicies.filter(tool => tool.stability === 'stable').map(tool => tool.name);

export function validateToolAllowlist(value: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const name of value) {
    if (!knownToolNames.has(name)) throw new Error('Unknown tool in tools.allow: ' + name);
    if (seen.has(name)) throw new Error('Duplicate tool in tools.allow: ' + name);
    seen.add(name);
  }
  return [...value];
}

export function enabledToolNames(allow: readonly string[]): Set<string> {
  return new Set(validateToolAllowlist(allow));
}
