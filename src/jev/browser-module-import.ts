import type {BrowserLogicModule} from './browser-contract';
// Preserve native import for optional ESM packages when gateway is compiled as CJS.
export const importBrowserModule = new Function('url', 'return import(url)') as (url: string) => Promise<BrowserLogicModule>;
