import React from 'react';
import { ComingSoon } from '@/components/ComingSoon';
import { FormScreen } from '@/components/ui/FormScreen';

export default function ReceiptVouchersScreen() {
  return (
    <FormScreen title="Receipt Vouchers" subtitle="Money received">
      <ComingSoon
        icon="arrow-down-left"
        title="Receipt Vouchers"
        description="Record and review money received — coming in the next update."
      />
    </FormScreen>
  );
}
