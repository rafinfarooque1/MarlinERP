import React from 'react';
import { ComingSoon } from '@/components/ComingSoon';
import { FormScreen } from '@/components/ui/FormScreen';

export default function PaymentVouchersScreen() {
  return (
    <FormScreen title="Payment Vouchers" subtitle="Money paid out">
      <ComingSoon
        icon="arrow-up-right"
        title="Payment Vouchers"
        description="Record and review money paid out — coming in the next update."
      />
    </FormScreen>
  );
}
