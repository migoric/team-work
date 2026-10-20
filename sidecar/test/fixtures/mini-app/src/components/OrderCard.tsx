import { fetchOrder } from '../lib/api';

export function OrderCard({ id }: { id: string }) {
  const order = fetchOrder(id);
  return <article>{order.title}</article>;
}
