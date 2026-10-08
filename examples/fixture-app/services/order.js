import { validatePayment } from './payment.js';

function createOrder(item) {
  return { item, status: validatePayment(item) };
}

export { createOrder, validatePayment };
