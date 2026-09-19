import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Claude Gateway',
  description: 'Task orchestration, voice, and multi-channel conversations for Claude Code.',
  lang: 'en-US',
  base: process.env.DOCS_BASE || '/',
  srcExclude: ['README.md'],
  themeConfig: {
    siteTitle: 'claude-gateway',
    nav: [
      { text: 'Guide', link: '/guide/quickstart' },
      { text: 'Channels', link: '/guide/channels' },
      { text: 'Voice', link: '/guide/voice' },
      { text: 'API', link: '/api/' },
      { text: 'Reference', link: '/reference/configuration' }
    ],
    sidebar: [
      { text: 'Start here', items: [
        { text: 'Overview', link: '/' },
        { text: 'Quickstart', link: '/guide/quickstart' },
        { text: 'Architecture', link: '/reference/architecture' },
        { text: 'Agents & sessions', link: '/guide/agents' },
        { text: 'Orchestration & tasks', link: '/guide/orchestration' },
        { text: 'Worker harnesses', link: '/guide/worker-harnesses' }
      ] },
      { text: 'Connect a channel', link: '/guide/channels', collapsed: false, items: [
        { text: 'Telegram', link: '/channels/telegram' },
        { text: 'Discord', link: '/channels/discord' },
        { text: 'LINE', link: '/channels/line' },
        { text: 'Slack', link: '/channels/slack' },
        { text: 'WhatsApp · linked device', link: '/channels/whatsapp' },
        { text: 'WhatsApp · Cloud API', link: '/channels/whatsapp-cloud' },
        { text: 'WeChat', link: '/channels/wechat' }
      ] },
      { text: 'Voice', collapsed: false, items: [
        { text: 'Speech setup & providers', link: '/guide/voice' },
        { text: 'Voice API & WebSocket', link: '/api/voice' }
      ] },
      { text: 'Build your workflow', collapsed: false, items: [
        { text: 'Tools & skills', link: '/guide/tools' },
        { text: 'Memory & knowledge', link: '/guide/memory' },
        { text: 'Schedules & heartbeats', link: '/guide/schedules' },
        { text: 'Apps', link: '/guide/apps' }
      ] },
      { text: 'Configuration & operation', collapsed: true, items: [
        { text: 'Configuration overview', link: '/reference/configuration' },
        { text: 'Gateway settings', link: '/reference/gateway-settings' },
        { text: 'Orchestration settings', link: '/reference/orchestration-settings' },
        { text: 'Memory & learning settings', link: '/reference/memory-settings' },
        { text: 'CLI & API overview', link: '/reference/cli-api' },
        { text: 'CLI command reference', link: '/reference/cli' },
        { text: 'Operations & upgrades', link: '/guide/operations' },
        { text: 'Troubleshooting', link: '/guide/troubleshooting' },
        { text: 'Development & docs deployment', link: '/reference/development' }
      ] },
      { text: 'API reference', link: '/api/', collapsed: true, items: [
        { text: 'Authentication & endpoint overview', link: '/api/overview' },
        { text: 'System & metadata', link: '/api/system' },
        { text: 'Agents & wizard', link: '/api/agents' },
        { text: 'Messages & commands', link: '/api/messages' },
        { text: 'Streaming & reconnects', link: '/api/streaming' },
        { text: 'Sessions', link: '/api/sessions' },
        { text: 'Models', link: '/api/models' },
        { text: 'Orchestration', link: '/api/orchestration' },
        { text: 'Tasks & workers', link: '/api/tasks' },
        { text: 'Channels', collapsed: true, items: [
          { text: 'Telegram', link: '/api/telegram' },
          { text: 'Discord', link: '/api/discord' },
          { text: 'WhatsApp', link: '/api/whatsapp' },
          { text: 'WeChat', link: '/api/wechat' },
          { text: 'LINE, Slack & public webhooks', link: '/api/webhooks' }
        ] },
        { text: 'History', link: '/api/history' },
        { text: 'Workspace files', link: '/api/workspace' },
        { text: 'Skills', link: '/api/skills' },
        { text: 'Cron jobs', link: '/api/crons' },
        { text: 'Media', link: '/api/media' },
        { text: 'File shares', link: '/api/shares' },
        { text: 'Apps', link: '/api/apps' },
        { text: 'Connectors', link: '/api/connectors' },
        { text: 'Package updates', link: '/api/packages' },
        { text: 'PTY', link: '/api/pty' },
        { text: 'Terminal viewer', link: '/api/terminal' }
      ] }
    ],
    search: { provider: 'local' },
    outline: [2, 3],
    socialLinks: [{ icon: 'github', link: 'https://github.com/0xMaxMa/claude-gateway' }],
    editLink: { pattern: 'https://github.com/0xMaxMa/claude-gateway/edit/main/website/:path', text: 'Improve this page' },
    footer: { message: 'Claude Code inside.' }
  }
})
