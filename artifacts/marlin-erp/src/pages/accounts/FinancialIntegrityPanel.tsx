import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, ShieldAlert } from "lucide-react";

type IntegrityProps = {
  fromDate?: string;
  toDate?: string;
  locationType?: string;
  locationId?: number;
};
type Check = {
  id: string;
  title: string;
  status: "PASS" | "WARN" | "FAIL";
  difference: number | null;
  unit: string;
  explanation: string;
  source: string;
};
type IntegrityResponse = {
  summary: { PASS: number; WARN: number; FAIL: number };
  checks: Check[];
  valuation?: { reliable: boolean; note: string | null };
};

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function defaultRange() {
  const today = new Date();
  return {
    from: `${today.getFullYear()}-01-01`,
    to: localDate(today),
  };
}

export function FinancialIntegrityPanel(props: IntegrityProps) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const fallback = defaultRange();
  const from = props.fromDate ?? fallback.from;
  const to = props.toDate ?? fallback.to;
  const params = new URLSearchParams({ fromDate: from, toDate: to, locationType: props.locationType ?? "all" });
  if (props.locationId != null) params.set("locationId", String(props.locationId));
  const query = useQuery<IntegrityResponse>({
    queryKey: ["financial-integrity", from, to, props.locationType ?? "all", props.locationId ?? null],
    queryFn: () => customFetch(`/api/accounts/integrity?${params.toString()}`),
    enabled: open,
    staleTime: 30_000,
  });

  return (
    <section className="rounded-xl border border-border/70 bg-card/60 p-4" data-testid="financial-integrity-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Financial Integrity Center</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Read-only checks for {from} to {to}. Unknown evidence is shown as a warning, never as a green zero.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen((value) => !value)} data-testid="run-integrity-checks">
          {query.isFetching ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="mr-1.5 h-3.5 w-3.5" />}
          {open ? "Refresh checks" : "Run integrity checks"}
        </Button>
      </div>
      {open && query.isLoading && (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking canonical books and stock evidence…</div>
      )}
      {open && query.isError && (
        <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600">
          Could not run the integrity diagnostic: {(query.error as any)?.message ?? "request failed"}
        </div>
      )}
      {open && query.data && (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2"><div className="font-mono text-lg font-semibold">{query.data.summary.PASS}</div><div>PASS</div></div>
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2"><div className="font-mono text-lg font-semibold">{query.data.summary.WARN}</div><div>WARN</div></div>
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2"><div className="font-mono text-lg font-semibold">{query.data.summary.FAIL}</div><div>FAIL</div></div>
          </div>
          <div className="divide-y rounded-lg border">
            {query.data.checks.map((item) => {
              const isExpanded = expanded === item.id;
              const icon = item.status === "PASS"
                ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                : <AlertTriangle className={`h-4 w-4 ${item.status === "FAIL" ? "text-red-600" : "text-amber-600"}`} />;
              return (
                <button key={item.id} type="button" className="w-full p-3 text-left" onClick={() => setExpanded(isExpanded ? null : item.id)}>
                  <div className="flex items-start gap-2">
                    {icon}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span className="font-mono text-xs text-muted-foreground">{item.id}</span>
                        <span>{item.title}</span>
                        {item.difference != null && Math.abs(item.difference) > 0.005 && <span className="font-mono text-xs text-red-600">Δ {item.difference.toFixed(2)} {item.unit}</span>}
                      </div>
                      {isExpanded && (
                        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                          <p>{item.explanation}</p>
                          <p className="font-mono">Source: {item.source}</p>
                        </div>
                      )}
                    </div>
                    <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}