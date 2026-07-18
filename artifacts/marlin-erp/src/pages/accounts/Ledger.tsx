import { useState } from 'react';
import { useListChartOfAccounts, useGetLedgerStatement } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BookOpen, Search, Download, Calendar } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export default function Ledger() {
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [fromDate, setFromDate] = useState(new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0]);
  const [toDate, setToDate] = useState(new Date().toISOString().split('T')[0]);

  const { data: accounts } = useListChartOfAccounts();
  const { data: statement, isLoading } = useGetLedgerStatement(
    { accountId: Number(selectedAccountId), fromDate, toDate }, 
    { query: { enabled: !!selectedAccountId } }
  );

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <BookOpen className="w-6 h-6 text-primary" /> Ledger Statement
            </h1>
            <p className="text-muted-foreground mt-1">View detailed transactions for a specific account</p>
          </div>
          <Button variant="outline" disabled={!statement}><Download className="w-4 h-4 mr-2" /> Export PDF</Button>
        </div>

        <div className="bg-card border border-border rounded-md shadow-sm p-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div className="space-y-2">
              <label className="text-sm font-medium">Select Account</label>
              <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose an account..." />
                </SelectTrigger>
                <SelectContent>
                  {accounts?.map(a => (
                    <SelectItem key={a.id} value={a.id.toString()}>{a.name} ({a.type})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">From Date</label>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">To Date</label>
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
          </div>
        </div>

        {selectedAccountId && statement ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-card border border-border p-4 rounded-md flex justify-between items-center">
                <span className="text-muted-foreground text-sm">Opening Balance</span>
                <span className="font-mono font-bold">₹{statement.openingBalance?.toLocaleString('en-IN') || 0}</span>
              </div>
              <div className="bg-card border border-border p-4 rounded-md flex justify-between items-center">
                <span className="text-muted-foreground text-sm">Closing Balance</span>
                <span className="font-mono font-bold text-primary">₹{statement.closingBalance?.toLocaleString('en-IN') || 0}</span>
              </div>
              <div className="bg-card border border-border p-4 rounded-md flex justify-between items-center">
                <span className="text-muted-foreground text-sm">Net Movement</span>
                <span className="font-mono font-bold">
                  ₹{((statement.closingBalance || 0) - (statement.openingBalance || 0)).toLocaleString('en-IN')}
                </span>
              </div>
            </div>

            <div className="bg-card border border-border rounded-md shadow-sm">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Loading transactions...</TableCell></TableRow>
                  ) : !statement.transactions || statement.transactions.length === 0 ? (
                    <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No transactions found for this period</TableCell></TableRow>
                  ) : (
                    statement.transactions.map((tx, idx) => (
                      <TableRow key={tx.id || idx}>
                        <TableCell>
                          <div className="flex items-center text-sm">
                            <Calendar className="w-3 h-3 mr-1 text-muted-foreground" />
                            {tx.date ? new Date(tx.date).toLocaleDateString() : '-'}
                          </div>
                        </TableCell>
                        <TableCell className="font-medium text-sm">{tx.description}</TableCell>
                        <TableCell className="text-right font-mono text-destructive">{tx.debit ? `₹${tx.debit.toLocaleString('en-IN')}` : '-'}</TableCell>
                        <TableCell className="text-right font-mono text-emerald-500">{tx.credit ? `₹${tx.credit.toLocaleString('en-IN')}` : '-'}</TableCell>
                        <TableCell className="text-right font-mono font-medium">₹{tx.balance?.toLocaleString('en-IN')}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : selectedAccountId && isLoading ? (
          <div className="flex items-center justify-center p-12 text-muted-foreground">Loading ledger data...</div>
        ) : (
          <div className="flex flex-col items-center justify-center p-12 border border-dashed border-border rounded-md text-muted-foreground">
            <BookOpen className="w-12 h-12 mb-4 opacity-20" />
            <p>Select an account and date range to view ledger</p>
          </div>
        )}
      </div>
    </AppLayout>
  );
}