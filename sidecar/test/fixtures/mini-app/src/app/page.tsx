import { Button } from '@/components/ui/Button';
import { OrderCard } from '@/components/OrderCard';

export default function Home() {
  return (
    <main>
      <Button label="下单" />
      <OrderCard id="1" />
    </main>
  );
}
