import { createOrder } from './services/order.js';
import { validatePayment } from './services/payment.js';

function checkout() {
  const order = createOrder('keyboard');
  return validatePayment(order);
}

checkout();

export { checkout };
