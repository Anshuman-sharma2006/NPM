import { getCurrentUser } from '../src/services/users';

const router = { get() {} };
function listUsers() {
  return getCurrentUser('test-token');
}
router.get('/users', listUsers);
