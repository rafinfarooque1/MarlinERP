import { useState } from 'react';
import { useGetLedgerStatement, useListAccountsFlat } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FileText, Download, Calendar } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';

export default function Ledger() {
  const { data: accounts = [] } = useListAccountsFlat();
  const [accountId, setAccountId] = useState<string>('');
  const now = new Date();
  const [fromDate, setFromDate] = useState(`${now.getFullYear()}-01-01`);
  const [toDate, setToDate] = useState(now.toISOString().split('T')[0]);

  const { data: statement, isLoading } = useGetLedgerStatement(
    accountId && fromDate && toDate ? { accountId: Number(accountId), fromDate, toDate } : { accountId: 0, fromDate, toDate },
    { query: { enabled: !!accountId } }
  );

  const entries = (statement as any)?.entries || (statement as any)?.transactions || [];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><FileText className="w-6 h-6 text-primary" /> Ledger Statement</h1>
            <p className="text-muted-foreground mt-1">Account-wise debit / credit statement</p>
          </div>
          <Button variant="outline" size="sm" disabled={!entries.length} onClick={() => downloadCSV('ledger.csv', entries.map((e: any) => ({ Date: e.date, Description: e.description, Debit: e.debit || 0, Credit: e.credit || 0, Balance: e.balance || 0 })))}>
            <Download className="w-4 h-4 mr-2" /> Export
          </Button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger className="w-60"><SelectValue placeholder="Select account" /></SelectTrigger>
            <SelectContent>{(accounts as any[]).map((a: any) => <SelectItem key={a.id} value={String(a.id)}>{a.code ? `[${a.code}] ` : ''}{a.name}</SelectItem>)}</SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-muted-foreground" />
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-36" />
            <span className="text-muted-foreground">to</span>
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-36" />
          </div>
        </div>

        {statement && (
          <div className="grid grid-cols-3 gap-4">
            {[['Opening Balance', `₹${Number(statement.openingBalance || 0).toLocaleString('en-IN')}`], ['Closing Balance', `₹${Number(statement.closingBalance || 0).toLocaleString('en-IN')}`], ['Entries', String(entries.length)]].map(([k, v]) => (
              <div key={k} className="bg-card border border-border rounded-xl p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">{k}</p>
                <p className="text-xl font-bold font-mono text-primary mt-1">{v}</p>
              </div>
            ))}
          </div>
        )}

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!accountId ? (
                <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                  <FileText className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>Select an account to view statement</p>
                </TableCell></TableRow>
              ) : isLoading ? [...Array(5)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : entries.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground">No entries for this period</TableCell></TableRow>
              ) : entries.map((e: any, i: number) => (
                <TableRow key={i} className="hover:bg-muted/10">
                  <TableCell className="text-sm">{new Date(e.date).toLocaleDateString('en-IN')}</TableCell>
                  <TableCell className="text-sm">{e.description}</TableCell>
                  <TableCell><Badge variant="outline" className="text-xs capitalize">{e.entryType}</Badge></TableCell>
                  <TableCell className="text-right font-mono text-red-500">{e.debit ? `₹${Number(e.debit).toLocaleString('en-IN')}` : '—'}</TableCell>
                  <TableCell className="text-right font-mono text-emerald-500">{e.credit ? `₹${Number(e.credit).toLocaleString('en-IN')}` : '—'}</TableCell>
                  <TableCell className="text-right font-mono font-bold">₹{Number(e.balance || 0).toLocaleString('en-IN')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </AppLayout>
  );
}
