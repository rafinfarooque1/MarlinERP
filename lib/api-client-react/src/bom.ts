import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BomLine {
  materialType: 'material' | 'raw_material';
  materialId: number;
  quantity: number;
}

export interface BomTemplate {
  id: number;
  itemId: number;
  itemName?: string;
  lines: BomLine[];
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface BomTemplateInput {
  itemId: number;
  lines: BomLine[];
  notes?: string;
}

// ── Query keys ────────────────────────────────────────────────────────────────

export const getBomTemplatesQueryKey = () => ['/api/bom-templates'] as const;
export const getBomTemplateByItemQueryKey = (itemId: number) =>
  ['/api/bom-templates/item', itemId] as const;

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useListBomTemplates() {
  return useQuery({
    queryKey: getBomTemplatesQueryKey(),
    queryFn: ({ signal }) =>
      customFetch<BomTemplate[]>('/api/bom-templates', { signal }),
  });
}

export function useGetBomTemplateByItem(itemId: number, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: getBomTemplateByItemQueryKey(itemId),
    queryFn: ({ signal }) =>
      customFetch<BomTemplate>(`/api/bom-templates/item/${itemId}`, { signal }),
    enabled: opts?.enabled !== undefined ? opts.enabled : itemId > 0,
    retry: false,
  });
}

export function useCreateBomTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: BomTemplateInput) =>
      customFetch<BomTemplate>('/api/bom-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: getBomTemplatesQueryKey() });
      qc.invalidateQueries({ queryKey: getBomTemplateByItemQueryKey(result.itemId) });
    },
  });
}

export function useUpdateBomTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<BomTemplateInput> }) =>
      customFetch<BomTemplate>(`/api/bom-templates/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: getBomTemplatesQueryKey() });
      qc.invalidateQueries({ queryKey: getBomTemplateByItemQueryKey(result.itemId) });
    },
  });
}

export function useDeleteBomTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch<{ success: boolean }>(`/api/bom-templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getBomTemplatesQueryKey() });
    },
  });
}

// ── Imperative fetch (for use inside event handlers) ─────────────────────────

export async function fetchBomTemplateByItem(itemId: number): Promise<BomTemplate | null> {
  try {
    return await customFetch<BomTemplate>(`/api/bom-templates/item/${itemId}`);
  } catch {
    return null;
  }
}
