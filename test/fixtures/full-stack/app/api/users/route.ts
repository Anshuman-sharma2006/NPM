import { getCurrentUser } from '../../../src/services/users';

export function GET() {
  return getCurrentUser('test-token');
}
