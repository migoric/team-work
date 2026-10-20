import { Button } from '@/components/ui/Button';
import { OrderCard } from '@/components/OrderCard';

export default function Orders() {
  return (
    <section>
      <Button label="筛选" />
      <OrderCard id="1" />
    </section>
  );
}
