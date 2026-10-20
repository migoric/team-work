import { OrderCard } from '@/components/OrderCard';

export default function OrderDetail({ params }: { params: { id: string } }) {
  return <OrderCard id={params.id} />;
}
