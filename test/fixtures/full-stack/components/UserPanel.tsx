import { getCurrentUser } from '../src/services/users';

export function UserPanel() {
  const user = getCurrentUser('test-token');
  return <section>{user?.id}</section>;
}
