/**
 * Attachment picker for expense bills and receipts.
 *
 * A plain file input on purpose: the bill is one scan or photo picked at the
 * moment the expense is recorded, so a drag-and-drop uploader with its own
 * dependency tree would buy nothing. The file goes straight to object storage
 * and the caller receives the stored path to save on the expense row.
 */
import { useRef, useState } from 'react';
import { uploadAttachment, attachmentViewUrl } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Paperclip, Loader2, X, FileText } from 'lucide-react';
import { toast } from 'sonner';

interface Props {
  /** Stored object path, or null when nothing is attached yet. */
  value: string | null;
  onChange: (objectPath: string | null) => void;
  disabled?: boolean;
}

export function AttachmentField({ value, onChange, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handlePick = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const path = await uploadAttachment(file);
      onChange(path);
      toast.success('Bill attached');
    } catch (err: any) {
      toast.error(err?.data?.error ?? err?.message ?? 'Upload failed');
    } finally {
      setUploading(false);
      // Clear the input so picking the same file again still fires onChange.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="space-y-1.5">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
        className="hidden"
        onChange={e => handlePick(e.target.files?.[0])}
      />

      {value ? (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-muted/30 text-sm">
          <FileText className="w-3.5 h-3.5 text-primary shrink-0" />
          <a
            href={attachmentViewUrl(value)}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline truncate"
          >
            View attached bill
          </a>
          {!disabled && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 ml-auto text-muted-foreground hover:text-destructive shrink-0"
              onClick={() => onChange(null)}
              title="Remove attachment"
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          disabled={disabled || uploading}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? (
            <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> Uploading…</>
          ) : (
            <><Paperclip className="w-3.5 h-3.5 mr-2" /> Attach bill or receipt</>
          )}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        Images or PDF, up to 10 MB. Shown on the printed voucher as supporting proof.
      </p>
    </div>
  );
}
