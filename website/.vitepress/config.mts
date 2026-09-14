import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Claude Gateway',
  description: 'Run your agents, connect your channels, and keep your work in one place.',
  lang: 'en-US',
  base: process.env.DOCS_BASE || '/',
  srcExclude: ['README.md'],
  themeConfig: {
    siteTitle: 'claude-gateway',
    nav: [
      { text: 'Guide', link: '/guide/quickstart' },
      { text: 'Reference', link: '/reference/configuration' },
      { text: 'Preview · PR #465', link: '/preview/orchestration' }
    ],
    sidebar: [
      { text: 'Start here', items: [
        { text: 'Overview', link: '/' },
        { text: 'Quickstart', link: '/guide/quickstart' },
        { text: 'Connect a channel', link: '/guide/channels' },
        { text: 'Agents & sessions', link: '/guide/agents' }
      ] },
      { text: 'Build your workflow', items: [
        { text: 'Tools & skills', link: '/guide/tools' },
        { text: 'Memory & knowledge', link: '/guide/memory' },
        { text: 'Schedules & heartbeats', link: '/guide/schedules' },
        { text: 'Apps', link: '/guide/apps' }
      ] },
      { text: 'Operate & integrate', items: [
        { text: 'Configuration', link: '/reference/configuration' },
        { text: 'CLI & HTTP API', link: '/reference/cli-api' },
        { text: 'Operations & upgrades', link: '/guide/operations' },
        { text: 'Troubleshooting', link: '/guide/troubleshooting' }
      ] },
      { text: 'Unreleased · PR #465', items: [
        { text: 'Orchestration & tasks', link: '/preview/orchestration' },
        { text: 'Voice', link: '/preview/voice' }
      ] }
    ],
    search: { provider: 'local' },
    outline: [2, 3],
    socialLinks: [{ icon: 'github', link: 'https://github.com/0xMaxMa/claude-gateway' }],
    editLink: { pattern: 'https://github.com/0xMaxMa/claude-gateway/edit/main/website/:path', text: 'Improve this page' },
    footer: { message: 'Self-hosted. Your agents, your workspace.' }
  }
})
