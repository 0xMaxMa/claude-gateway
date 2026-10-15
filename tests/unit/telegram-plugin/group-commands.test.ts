/**
 * PR #591 dev e2e: a command typed in a Telegram group got no reply. The
 * receiver's handlers return early outside a private chat, and the gateway
 * commands it forwards needed an explicit @mention to pass the group gate.
 */
import { defaultAccess, gateLogic, groupCommandReply, isMentionedPure, leadingCommand, stripCommandTarget, type Access } from '../../../mcp/tools/telegram/pure'

const allowed = (patch: Partial<Access> = {}): Access => ({ ...defaultAccess(), groupPolicy: 'allowlist', groupAllowlist: ['-100'], ...patch })
const group = (text: string, patch: Partial<Access> = {}, fromId = '7') =>
  groupCommandReply(allowed(patch), { chatType: 'supergroup', chatId: '-100', fromId, text, botUsername: 'agent_bot' })

describe('a direct-message-only command in a group', () => {
  it.each(['/model', '/models', '/help', '/status', '/clear', '/compact', '/restart', '/sessions', '/session', '/tasks', '/voice on', '/voices', '/call', '/start'])(
    '%s in an allowed group gets a pointer to the direct message', text => {
      expect(group(text)).toBe(`${text.split(' ')[0]} is only available in a direct message with the bot.`)
    })

  // Third review of #591 (L6): /cli got the pointer even where the terminal viewer is off.
  it('/cli gets the pointer only where the terminal viewer is on', () => {
    expect(group('/cli')).toBeUndefined()
    expect(groupCommandReply(allowed(), { chatType: 'group', chatId: '-100', fromId: '7', text: '/cli', botUsername: 'agent_bot', cliEnabled: true }))
      .toBe('/cli is only available in a direct message with the bot.')
  })

  // Third review of #591 (L5): a bot turned off (dmPolicy disabled) still answered in groups.
  it('stays silent when the bot is turned off', () => {
    expect(group('/model', { dmPolicy: 'disabled' })).toBeUndefined()
    expect(group('/model', { dmPolicy: 'disabled', groupPolicy: 'open' })).toBeUndefined()
  })

  // Third review of #591 (L14): the reply follows the gate itself, not a copy of its rules.
  it('mints no pairing code and saves nothing for a group the gate would pair', () => {
    const access = allowed({ groupAllowlist: [], pairing: true })
    expect(groupCommandReply(access, { chatType: 'group', chatId: '-100', fromId: '7', text: '/model', botUsername: 'agent_bot' })).toBeUndefined()
    expect(access.pending).toEqual({})
  })

  it('answers the command addressed to this bot, and not one addressed to another bot', () => {
    expect(group('/model@Agent_Bot')).toBe('/model is only available in a direct message with the bot.')
    expect(group('/model@other_bot')).toBeUndefined()
  })

  it('stays silent where the gate drops the group, without minting a pairing code', () => {
    expect(group('/model', { groupAllowlist: [] })).toBeUndefined()
    expect(group('/model', { groupPolicy: 'disabled' })).toBeUndefined()
    expect(group('/model', { legacyGroupAllowFrom: { '-100': ['8'] } })).toBeUndefined()
    expect(group('/model', { groupPolicy: 'open', groupAllowlist: [] })).toBeDefined()
  })

  it('leaves text, other commands, private chats and the commands the gateway answers in groups alone', () => {
    for (const text of ['hello', '/pstack:how', '/stop', '/new x', '/rename y', '/pstack_setup']) expect(group(text)).toBeUndefined()
    expect(groupCommandReply(allowed(), { chatType: 'private', chatId: '7', fromId: '7', text: '/model', botUsername: 'agent_bot' })).toBeUndefined()
  })
})

describe('a command the gateway answers in a group', () => {
  const gate = (text: string) => gateLogic(
    { fromId: '7', chatType: 'group', chatId: '-100', botUsername: 'agent_bot', messageText: text, messageEntities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] },
    () => allowed(), () => {}, () => 'code')

  it.each(['/stop', '/stop@agent_bot', '/new Design', '/rename Design review', '/pstack_setup', '/pstack-setup'])('%s is addressed to the bot, like a mention', text => {
    expect(gate(text).action).toBe('deliver')
  })

  it('does not treat other text or another bot\'s command as a mention', () => {
    expect(gate('/stop@other_bot').action).toBe('drop')
    expect(gate('/pstack:how').action).toBe('drop')
    expect(isMentionedPure({ messageText: 'plain', botUsername: 'agent_bot' })).toBe(false)
  })

  it('is forwarded without the @bot suffix so the gateway matches it', () => {
    expect(stripCommandTarget('/stop@agent_bot', 'agent_bot')).toBe('/stop')
    expect(stripCommandTarget('/rename@Agent_Bot Design review', 'agent_bot')).toBe('/rename Design review')
    expect(stripCommandTarget('/stop@other_bot', 'agent_bot')).toBe('/stop@other_bot')
    expect(stripCommandTarget('email me@agent_bot', 'agent_bot')).toBe('email me@agent_bot')
    expect(leadingCommand('/Stop', 'agent_bot')).toBe('stop')
  })
})
