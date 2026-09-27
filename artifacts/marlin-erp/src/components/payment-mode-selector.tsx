import { useId } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CREATE_PAYMENT_MODE_OPTIONS, CREATE_SALE_PAYMENT_MODES } from '@/lib/paymentModes';

export type CollectionPaymentMode = (typeof CREATE_SALE_PAYMENT_MODES)[number];

export function PaymentModeSelector({
  value,
  onValueChange,
  disabled,
  className,
}: {
  value: CollectionPaymentMode;
  onValueChange: (value: CollectionPaymentMode) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();

  return (
    <div className={`space-y-1.5 ${className ?? ''}`.trim()}>
      <label htmlFor={id} className="text-sm font-medium">
        Payment Mode <span className="text-destructive">*</span>
      </label>
      <Select
        value={value}
        onValueChange={(nextValue) => onValueChange(nextValue as CollectionPaymentMode)}
        disabled={disabled}
      >
        <SelectTrigger id={id} data-testid="payment-mode-selector">
          <SelectValue placeholder="Select mode" />
        </SelectTrigger>
        <SelectContent>
          {CREATE_PAYMENT_MODE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}