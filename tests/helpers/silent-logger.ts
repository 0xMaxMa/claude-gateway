import type { Logger } from '../../src/types';

export const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
