import { useEffect } from 'react';
import { useLocation } from 'wouter';
import { useLocationContext } from '@/lib/locationContext';
import Sales from '@/pages/headoffice/Sales';

export default function SalesPOS() {
  const [, navigate] = useLocation();
  const { locationState } = useLocationContext();

  useEffect(() => {
    if (!locationState.locationType || !locationState.locationId) {
      navigate('/sales');
    }
  }, [locationState, navigate]);

  if (!locationState.locationType || !locationState.locationId) return null;

  return (
    <Sales
      forceLocationType={locationState.locationType}
      forceLocationId={locationState.locationId}
      forceLocationName={locationState.locationName}
    />
  );
}
