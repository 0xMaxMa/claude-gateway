/** Fixed samples avoid accepting arbitrary prompts at the preview endpoint. */
export const VOICE_PREVIEW_TEXT: Record<string, string> = {
  en: 'Hello! This is a preview of my voice.',
  th: 'สวัสดี นี่คือตัวอย่างเสียงของฉัน ยินดีที่ได้รู้จัก',
  ar: 'مرحبًا! هذه عينة من صوتي. يسعدني لقاؤك.',
  de: 'Hallo! Dies ist eine Hörprobe meiner Stimme. Schön, dich kennenzulernen.',
  es: '¡Hola! Esta es una muestra de mi voz. Encantado de conocerte.',
  fr: 'Bonjour ! Voici un aperçu de ma voix. Ravi de vous rencontrer.',
  hi: 'नमस्ते! यह मेरी आवाज़ का एक नमूना है। आपसे मिलकर खुशी हुई।',
  id: 'Halo! Ini adalah contoh suara saya. Senang bertemu dengan Anda.',
  it: 'Ciao! Questa è un’anteprima della mia voce. Piacere di conoscerti.',
  ja: 'こんにちは。これは私の声のサンプルです。よろしくお願いします。',
  ko: '안녕하세요! 제 목소리 샘플입니다. 만나서 반갑습니다.',
  pt: 'Olá! Esta é uma amostra da minha voz. Prazer em conhecer você.',
  ru: 'Здравствуйте! Это пример моего голоса. Приятно познакомиться.',
  vi: 'Xin chào! Đây là bản nghe thử giọng nói của tôi. Rất vui được gặp bạn.',
  zh: '你好！这是我的声音示例。很高兴认识你。',
};

/** Documented fallback when a restricted provider key cannot read /models. */
export function voicePreviewLanguages(provider: string, model: string): string[] {
  const native = model.split('/').pop()!;
  const languages = Object.keys(VOICE_PREVIEW_TEXT);
  if (provider.includes('paxalabs')) return ['en', 'th'];
  if (provider === 'elevenlabs' || provider === 'upstream') {
    if (['eleven_flash_v2', 'eleven_turbo_v2', 'eleven_monolingual_v1'].includes(native)) return ['en'];
    if (['eleven_flash_v2_5', 'eleven_turbo_v2_5'].includes(native)) return languages.filter(language => language !== 'th');
    if (native === 'eleven_multilingual_v2') return languages.filter(language => !['th', 'vi'].includes(language));
  }
  return languages;
}

import { describeVoiceError } from './errors';
export function voicePreviewError(error: unknown): string { return describeVoiceError(error).message; }
