import { validateToken } from '../auth/token';

export function getCurrentUser(token: string) {
  return validateToken(token) ? { id: 'user-1' } : null;
}
