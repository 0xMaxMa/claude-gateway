import { providerVoiceError } from '../errors';
import WebSocket from 'ws';
import { BoundedQueue } from '../queue';
import { VoiceError } from '../types';

export interface ProviderSocket { messages: AsyncIterable<Record<string, any>>; send(value: unknown): Promise<void>; audio(value: Uint8Array): Promise<void>; close(): void; }
export type SocketFactory = (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<ProviderSocket>;
export const openProviderSocket: SocketFactory = (url, headers, signal) => openSocket(url, headers, signal, false);
export const openBinaryProviderSocket: SocketFactory = (url, headers, signal) => openSocket(url, headers, signal, true);
function handshakeFailure(error: Error): VoiceError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ECONNREFUSED') return new VoiceError('PROVIDER_CONNECTION_REFUSED');
  if (code === 'EAI_AGAIN') return new VoiceError('PROVIDER_DNS_TEMPORARY');
  if (code === 'ENOTFOUND') return new VoiceError('PROVIDER_DNS_FAILED');
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN') return new VoiceError('PROVIDER_TLS_FAILED');
  return new VoiceError('PROVIDER_CONNECTION_FAILED');
}
const openSocket = async (url: string, headers: Record<string, string>, signal: AbortSignal, binaryAudio: boolean): Promise<ProviderSocket> => {
  signal.throwIfAborted();
  const ws = new WebSocket(url, { headers, maxPayload: 4 * 1024 * 1024 });
  const messages = new BoundedQueue<Record<string, any>>(4 * 1024 * 1024, value => Buffer.byteLength(JSON.stringify(value)));
  let opened = false;
  let handshakeError: VoiceError | undefined;
  const close = () => { ws.terminate(); messages.close(); };
  const abort = () => { messages.close(new VoiceError('PROVIDER_ABORTED')); ws.terminate(); };
  signal.addEventListener('abort', abort, { once: true });
  ws.on('message', (data, binary) => {
    try { messages.push(binaryAudio && binary ? { binaryAudio: data } : JSON.parse(data.toString())); }
    catch { messages.close(new VoiceError('INVALID_PROVIDER_MESSAGE')); ws.terminate(); }
  });
  ws.on('error', error => { handshakeError ??= handshakeFailure(error); messages.close(handshakeError); });
  ws.on('close', (code, reason) => {
    signal.removeEventListener('abort', abort);
    // Managed relays can exhaust a daily quota after the socket has opened.
    // Preserve that diagnostic instead of turning it into a generic reconnect.
    if (code === 1008 && reason.length) {
      try { const diagnostic = JSON.parse(reason.toString()); messages.close(providerVoiceError('VOICE', diagnostic?.error?.status, diagnostic)); return; } catch { /* native non-JSON close reason */ }
    }
    messages.close();
  });
  await new Promise<void>((resolve, reject) => {
    const fail = (error: VoiceError) => { clearTimeout(handshakeTimer); reject(error); };
    const handshakeTimer = setTimeout(() => {
      handshakeError = new VoiceError('PROVIDER_HANDSHAKE_TIMEOUT');
      messages.close(handshakeError); fail(handshakeError); ws.terminate();
    }, 10000);
    ws.once('unexpected-response', (_request, response) => {
      const parts: Buffer[] = []; let size = 0, finished = false;
      const finish = () => {
        if (finished) return; finished = true; clearTimeout(timer);
        let payload: unknown;
        try { payload = JSON.parse(Buffer.concat(parts).toString()); } catch { /* no structured diagnostic */ }
        handshakeError = providerVoiceError('VOICE', response.statusCode, payload);
        messages.close(handshakeError); fail(handshakeError); response.destroy(); ws.terminate();
      };
      const timer = setTimeout(finish, 2000);
      response.on('data', (part: Buffer) => { size += part.length; if (size <= 16384) parts.push(part); else finish(); });
      response.once('end', finish); response.once('error', finish); response.once('aborted', finish);
    });
    ws.once('open', () => { opened = true; clearTimeout(handshakeTimer); resolve(); });
    ws.once('error', error => fail(signal.aborted ? new VoiceError('PROVIDER_ABORTED') : handshakeError ?? handshakeFailure(error)));
    ws.once('close', () => { if (!opened) fail(signal.aborted ? new VoiceError('PROVIDER_ABORTED') : handshakeError ?? new VoiceError('PROVIDER_CONNECTION_CLOSED')); });
  });
  const send = (value: string | Uint8Array): Promise<void> => {
    if (signal.aborted || ws.readyState !== WebSocket.OPEN) return Promise.reject(new VoiceError('PROVIDER_CONNECTION_CLOSED'));
    if (ws.bufferedAmount > 1024 * 1024) return Promise.reject(new VoiceError('PROVIDER_TOO_SLOW'));
    return new Promise((resolve, reject) => ws.send(value, error => error ? reject(new VoiceError('PROVIDER_SEND_FAILED')) : resolve()));
  };
  return { messages, send: value => send(JSON.stringify(value)), audio: send, close };
};
