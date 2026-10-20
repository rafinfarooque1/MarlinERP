import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePermission } from "@/lib/usePermission";

type EvidenceResponse = {
  evidence: null | {
    id: number;
    effective_date: string;
    source_document: string;
    status: "draft" | "approved";
    created_by: string;
    approved_by: string | null;
    lines: Array<Record<string, unknown>>;
  };
};

export default function HistoricalStockEvidencePanel() {
  const queryClient = useQueryClient();
  const permission = usePermission("page:/headoffice/inventory-reports");
  const canManage = permission.canAdd && permission.canEdit;
  const [date, setDate] = useState("2026-08-31");
  const [sourceDocument, setSourceDocument] = useState("");
  const [notes, setNotes] = useState("");
  const [json, setJson] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const { data, refetch } = useQuery({
    queryKey: ["historical-stock-evidence", date],
    queryFn: () => customFetch<EvidenceResponse>(`/api/stock/historical-evidence/${date}`),
    enabled: canManage && /^\d{4}-\d{2}-\d{2}$/.test(date),
  });

  async function saveDraft() {
    setBusy(true);
    setMessage("");
    try {
      const lines = JSON.parse(json);
      if (!Array.isArray(lines)) throw new Error("Paste a JSON array of evidence lines.");
      const result = await customFetch<{ id: number }>(
        "/api/stock/historical-evidence",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ effectiveDate: date, sourceDocument, notes, lines }),
        },
      );
      setMessage(`Draft ${result.id} saved. It has not affected any report or live stock.`);
      await refetch();
    } catch (error: any) {
      setMessage(error?.data?.error ?? error?.message ?? "Could not save the evidence draft.");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    const id = data?.evidence?.id;
    if (!id || data?.evidence?.status !== "draft") return;
    setBusy(true);
    setMessage("");
    try {
      await customFetch(`/api/stock/historical-evidence/${id}/approve`, { method: "PATCH" });
      setMessage("Evidence approved. Historical financial statements will use this checkpoint; live stock is unchanged.");
      await queryClient.invalidateQueries();
      await refetch();
    } catch (error: any) {
      setMessage(error?.data?.error ?? error?.message ?? "Could not approve the evidence.");
    } finally {
      setBusy(false);
    }
  }

  async function loadReportCsv(file?: File) {
    if (!file) return;
    const text = await file.text();
    const matrix: string[][] = [];
    let row: string[] = [], cell = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"' && quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) { row.push(cell); cell = ""; }
      else if ((ch === "\n" || ch === "\r") && !quoted) {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); cell = "";
        if (row.some((v) => v.trim())) matrix.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some((v) => v.trim())) matrix.push(row);
    const header = matrix.shift()?.map((v) => v.trim()) ?? [];
    const index = (name: string) => header.indexOf(name);
    const required = ["material_type", "ref_id", "branch_type", "branch_id", "closing_qty_aug31", "historical_unit_cost"];
    if (required.some((name) => index(name) < 0)) {
      setMessage("This CSV is not the August 31 evidence report. Required quantity and cost columns were not found.");
      return;
    }
    const lines = matrix.map((r) => ({
      materialType: r[index("material_type")],
      refId: Number(r[index("ref_id")]),
      branchType: r[index("branch_type")],
      branchId: Number(r[index("branch_id")]),
      quantity: Number(r[index("closing_qty_aug31")]),
      unitCost: r[index("historical_unit_cost")]?.trim() ? Number(r[index("historical_unit_cost")]) : null,
    })).filter((r) => Number.isFinite(r.quantity) && r.quantity > 0);
    setJson(JSON.stringify(lines, null, 2));
    setMessage(`Loaded ${lines.length} positive-stock lines. Fill every missing historical unit cost from approved evidence before saving.`);
  }

  return (
    <details className="rounded-xl border p-4">
      <summary className="cursor-pointer font-semibold text-sm">Historical stock evidence (Administrator only)</summary>
      <p className="mt-2 text-xs text-muted-foreground">
        Save a dated, source-backed schedule as a draft, review it, then approve it. This does not change current quantities, average costs, batches, stock movements, or journals.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="text-xs">Effective date
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1" />
        </label>
        <label className="text-xs">Source document / reference
          <Input value={sourceDocument} onChange={(e) => setSourceDocument(e.target.value)} placeholder="Approved stock count or valuation reference" className="mt-1" />
        </label>
        <label className="text-xs md:col-span-2">Notes
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1" />
        </label>
        <label className="text-xs md:col-span-2">Evidence lines (JSON array)
          <input
            type="file"
            accept=".csv,text/csv"
            className="mb-2 block text-xs"
            onChange={(e) => void loadReportCsv(e.target.files?.[0])}
          />
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            placeholder={'[{"materialType":"item","refId":1,"branchType":"warehouse","branchId":2,"quantity":10,"unitCost":125.5}]'}
            className="mt-1 min-h-32 w-full rounded-md border bg-background p-3 font-mono text-xs"
          />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canManage && <Button size="sm" disabled={busy} onClick={() => void saveDraft()}>Save draft</Button>}
        {canManage && <Button size="sm" variant="secondary" disabled={busy || data?.evidence?.status !== "draft"} onClick={() => void approve()}>Approve checkpoint</Button>}
        {!canManage && <span className="text-xs text-muted-foreground">Historical evidence entry and approval require Administrator rights.</span>}
        <span className="text-xs text-muted-foreground">
          {data?.evidence ? `${data.evidence.status.toUpperCase()} · ${data.evidence.lines.length} lines · source: ${data.evidence.source_document}` : "No checkpoint for this date."}
        </span>
      </div>
      {message && <p className="mt-2 text-xs text-muted-foreground">{message}</p>}
    </details>
  );
}
