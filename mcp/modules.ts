import { TelegramModule } from './tools/telegram/module';
import { DiscordModule } from './tools/discord/module';
import { LineModule } from './tools/line/module';
import { SlackModule } from './tools/slack/module';
import { WhatsAppModule } from './tools/whatsapp/module';
import { WhatsAppCloudModule } from './tools/whatsapp-cloud/module';
import { WeChatModule } from './tools/wechat/module';
import { CronModule } from './tools/cron/module';
import { SkillsModule } from './tools/skills/module';
import { AgentModule } from './tools/agent/module';
import { BrowserModule } from './tools/browser/module';
import { ImageModule } from './tools/image/module';
import { VideoModule } from './tools/video/module';
import { ShareFileModule } from './tools/share-file/module';
import { AppsModule } from './tools/apps/module';
import { ApiModule } from './tools/api/module';
import { MemoryModule } from './tools/memory/module';
import { SafemodeModule } from './tools/safemode/module';
import type { ChannelModule, ToolModule } from './types';

/** Shared registration for execution and read-only capability discovery. */
export function gatewayModules(
  role?: string,
  media = false
): Array<ChannelModule | ToolModule> {
  return role
    ? [
        new MemoryModule(),
        ...(role === 'agent' ? [new SafemodeModule()] : []),
        ...(role === 'worker' ? [new CronModule()] : []),
        ...(role === 'worker' && media
          ? [
              new ImageModule(),
              new VideoModule(),
              new ShareFileModule(),
              new BrowserModule(),
            ]
          : []),
      ]
    : [
        new TelegramModule(),
        new DiscordModule(),
        new LineModule(),
        new SlackModule(),
        new WhatsAppModule(),
        new WhatsAppCloudModule(),
        new WeChatModule(),
        new CronModule(),
        new SkillsModule(),
        new AgentModule(),
        new BrowserModule(),
        new ImageModule(),
        new VideoModule(),
        new ShareFileModule(),
        new AppsModule(),
        new ApiModule(),
        new MemoryModule(),
      ];
}
