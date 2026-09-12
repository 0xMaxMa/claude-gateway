import { confirmSelection, voiceModeConfirmation } from '../../../mcp/tools/telegram/selection-confirmation';
const context=()=>({editMessageText:jest.fn(async()=>{}),reply:jest.fn(async()=>{}),deleteMessage:jest.fn(async()=>{})});
test.each(['on','auto','off'])('keeps %s confirmation as a message with no buttons',async mode=>{
 const ctx=context();const text=voiceModeConfirmation(mode);await confirmSelection(ctx,text);
 expect(ctx.editMessageText).toHaveBeenCalledWith(text,{reply_markup:{inline_keyboard:[]}});
 expect(ctx.deleteMessage).not.toHaveBeenCalled();expect(ctx.reply).not.toHaveBeenCalled();
});
test('voice name and provider stay visible and unmodified callbacks do not duplicate history',async()=>{
 const ctx=context();ctx.editMessageText.mockRejectedValue(Error('message is not modified'));
 await confirmSelection(ctx,'✅ Agent voice: Jessica · elevenlabs');expect(ctx.reply).not.toHaveBeenCalled();
});
test('failed edits fall back to a confirmation before deleting the old menu',async()=>{
 const ctx=context();ctx.editMessageText.mockRejectedValue(Error('cannot edit'));
 await confirmSelection(ctx,'✅ Agent voice: Jessica · elevenlabs');
 expect(ctx.reply).toHaveBeenCalledWith('✅ Agent voice: Jessica · elevenlabs');
 expect(ctx.reply.mock.invocationCallOrder[0]).toBeLessThan(ctx.deleteMessage.mock.invocationCallOrder[0]);
});
test('failed fallback delivery preserves the old menu',async()=>{
 const ctx=context();ctx.editMessageText.mockRejectedValue(Error('cannot edit'));ctx.reply.mockRejectedValue(Error('network'));
 await expect(confirmSelection(ctx,'confirmation')).rejects.toThrow('network');expect(ctx.deleteMessage).not.toHaveBeenCalled();
});
