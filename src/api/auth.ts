import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { ApiKey } from '../types';

/**
 * Express middleware that validates the Bearer token or X-Api-Key header
 * against the configured API keys.
 *
 * Uses timing-safe comparison to prevent timing-based key enumeration attacks.
 * Attaches the matched ApiKey to `req.apiKey` on success.
 */
export function createApiAuthMiddleware(apiKeys: ApiKey[]) {
  return function apiAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers['authorization'];
    const xApiKey = req.headers['x-api-key'] as string | undefined;

    let token: string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (xApiKey) {
      token = xApiKey.trim();
    }

    if (!token) {
      res.status(401).json({ error: 'Missing API key' });
      return;
    }

    const tokenBuf = Buffer.from(token);
    const matched = apiKeys.find((k) => {
      try {
        const keyBuf = Buffer.from(k.key);
        // timingSafeEqual requires same length — unequal lengths → not a match
        if (keyBuf.length !== tokenBuf.length) return false;
        return timingSafeEqual(keyBuf, tokenBuf);
      } catch {
        return false;
      }
    });

    if (!matched) {
      res.status(403).json({ error: 'Invalid API key' });
      return;
    }

    (req as Request & { apiKey: ApiKey }).apiKey = matched;
    next();
  };
}

/**
 * Returns true if the given API key is allowed to access the specified agent.
 * Keys with `admin: true` bypass all agent scope checks.
 */
export function canAccessAgent(apiKey: ApiKey, agentId: string): boolean {
  if (apiKey.admin) return true;
  if (apiKey.agents === '*') return true;
  return (apiKey.agents as string[]).includes(agentId);
}

/**
 * Returns true if the key has write access to the specified agent.
 * Requires both agent-scope access AND write flag (or admin).
 */
export function canWriteAgent(apiKey: ApiKey, agentId: string): boolean {
  if (apiKey.admin) return true;
  return apiKey.write === true && canAccessAgent(apiKey, agentId);
}

/**
 * Returns true if the key has admin privileges (cross-agent + destructive ops).
 */
export function isAdmin(apiKey: ApiKey): boolean {
  return apiKey.admin === true;
}
