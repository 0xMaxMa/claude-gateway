import { AppsModule } from '../../mcp/tools/apps/module';

describe('AppsModule', () => {
  describe('getTools', () => {
    it('exposes an install_app tool', () => {
      const tools = new AppsModule().getTools();
      expect(tools.map((t) => t.name)).toContain('install_app');
    });

    // Regression for #257: the tool contract must not tell agents a commit is
    // required for a GitHub install — the installer auto-resolves HEAD when it
    // is omitted. A "required" description makes agents stop and demand a hash.
    it('install_app presents commit as optional (auto-resolves HEAD), not required', () => {
      const tools = new AppsModule().getTools();
      const install = tools.find((t) => t.name === 'install_app');
      expect(install).toBeDefined();

      const props = (install!.inputSchema as {
        properties: Record<string, { description?: string }>;
        required?: string[];
      });

      // commit must not be a required field
      expect(props.required ?? []).not.toContain('commit');

      const commitDesc = props.properties['commit']?.description ?? '';
      const githubDesc = props.properties['github_url']?.description ?? '';

      // must not advertise commit as required
      expect(commitDesc.toLowerCase()).not.toContain('required');
      expect(githubDesc.toLowerCase()).not.toContain('requires commit');
      // must signal the optional / auto-resolve behavior
      expect(commitDesc.toLowerCase()).toContain('optional');
    });

    // Regression for #265: a pre-install inspect tool must exist so GitHub-URL
    // installs can surface required secrets before installing (browse_registry
    // only knows registry apps). Without it the agent reports "Secrets: none".
    it('exposes an inspect_app tool that accepts a github_url source', () => {
      const tools = new AppsModule().getTools();
      const inspect = tools.find((t) => t.name === 'inspect_app');
      expect(inspect).toBeDefined();

      const props = (inspect!.inputSchema as {
        properties: Record<string, { description?: string }>;
      }).properties;
      // accepts the same source fields as install (at least github_url)
      expect(props['github_url']).toBeDefined();
      expect(props['registry_app']).toBeDefined();
      expect(props['local_path']).toBeDefined();

      // description must point agents at it before install for secret discovery
      const desc = (inspect!.description ?? '').toLowerCase();
      expect(desc).toContain('secret');
    });
  });
});
