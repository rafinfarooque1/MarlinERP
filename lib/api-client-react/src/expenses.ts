/**
 * Manual hooks for the expense audit trail (categories) and file attachments.
 * These supplement the auto-generated hooks in generated/api.ts, which do not
 * cover the audit columns added after the OpenAPI spec was written.
 */
import { useQuery } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExpenseCategory {
  name: string;
}

export interface UploadUrlResponse {
  uploadURL: string;
  objectPath: string;
  metadata: { name: string; size: number; contentType: string };
}

// ── Query keys ────────────────────────────────────────────────────────────────

export const getExpenseCategoriesQueryKey = () => ['/api/expenses/categories'] as const;

// ── Hooks ─────────────────────────────────────────────────────────────────────

/**
 * The fixed category list, served by the API so the picker can never drift from
 * what the server will accept. Cached for the session — it does not change.
 */
export function useExpenseCategories() {
  return useQuery({
    queryKey: getExpenseCategoriesQueryKey(),
    queryFn: ({ signal }) =>
      customFetch<ExpenseCategory[]>('/api/expenses/categories', { signal }),
    staleTime: Infinity,
  });
}

// ── Attachment upload ─────────────────────────────────────────────────────────

/**
 * Upload a bill or receipt and return the object path to store on the expense.
 *
 * Two hops by design: the server mints a short-lived presigned URL, then the
 * browser PUTs the bytes straight to storage. The file never passes through the
 * API server, so a large scan cannot tie up a request worker.
 *
 * Returns the `/objects/...` path — the only form the expense routes accept.
 */
export async function uploadAttachment(file: File): Promise<string> {
  const { uploadURL, objectPath } = await customFetch<UploadUrlResponse>(
    '/api/storage/uploads/request-url',
    {
      method: 'POST',
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        contentType: file.type || 'application/octet-stream',
      }),
    },
  );

  const put = await fetch(uploadURL, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!put.ok) {
    throw new Error(`Upload failed (${put.status}). Please try again.`);
  }

  return objectPath;
}

/** Browser URL that serves a stored attachment back through the API. */
export function attachmentViewUrl(objectPath: string): string {
  return `/api/storage${objectPath}`;
}
