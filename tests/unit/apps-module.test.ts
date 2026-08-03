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
  });
});
