/** Gateway owns worker orchestration and connectors. Disable native side channels
 * before startup, not only after config/read (hooks can execute during startup).
 * Deliberate interactive safemode --params does not use this policy. */
export const DISABLED_CODEX_FEATURES = [
  'hooks', 'plugins', 'apps', 'browser_use', 'computer_use', 'multi_agent',
  'shell_snapshot', 'image_generation', 'skill_mcp_dependency_install',
  'workspace_dependencies',
] as const;

export function codexPolicyArgs(): string[] {
  return ['-c', 'notify=[]', '-c', 'web_search="disabled"',
    ...DISABLED_CODEX_FEATURES.flatMap(name => ['-c', `features.${name}=false`])];
}
