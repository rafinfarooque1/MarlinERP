const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});
const B='http://127.0.0.1:8080/api';let H;
const api=async(m,path,body)=>{const r=await fetch(B+path,{method:m,headers:{...H,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});let d=null;try{d=await r.json()}catch{};return{s:r.status,d}};
const one=async(s,v=[])=>(await p.query(s,v)).rows;
const snap=async(saleId)=>({
  stock:(await one(`select quantity::float q from stock_entries where item_id=2 and material_type='item' and branch_type='warehouse' and branch_id=1`))[0]?.q,
  ledger:await one(`select txn_type,qty_change::float q,notes from stock_ledger where doc_type='sale' and doc_id=$1 order by id`,[saleId||0]),
  receipts:await one(`select voucher_number,amount::float a from receipts where voucher_number=$1`,[saleId?.inv||'']),
  cust:(await one(`select total_purchases::float t from customers where id=1`))[0]?.t,
});
(async()=>{
const lr=await fetch(B+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'marlin1458'})});
H={authorization:'Bearer '+(await lr.json()).token};

const before={stock:(await one(`select quantity::float q from stock_entries where item_id=2 and branch_type='warehouse' and branch_id=1 and material_type='item'`))[0].q,
 cust:(await one(`select total_purchases::float t from customers where id=1`))[0].t,
 rc:(await one(`select count(*)::int n from receipts`))[0].n};
console.log('BEFORE',JSON.stringify(before));

// 1. CREATE
const c=await api('POST','/sales',{outletId:1,locationType:'warehouse',locationId:1,customerId:1,saleDate:'2026-07-29',
  lineItems:[{itemId:2,quantity:5,unitPrice:100}],paymentMode:'cash'});
console.log('CREATE',c.s,JSON.stringify({id:c.d?.id,inv:c.d?.invoiceNumber,total:c.d?.totalAmount}));
if(c.s!==201&&c.s!==200){console.log('FAIL create',JSON.stringify(c.d));await p.end();return}
const id=c.d.id, inv=c.d.invoiceNumber;

const a1={stock:(await one(`select quantity::float q from stock_entries where item_id=2 and branch_type='warehouse' and branch_id=1 and material_type='item'`))[0].q,
 led:await one(`select txn_type,qty_change::float q from stock_ledger where doc_type='sale' and doc_id=$1 order by id`,[id]),
 rec:await one(`select amount::float a from receipts where voucher_number=$1`,[inv]),
 cust:(await one(`select total_purchases::float t from customers where id=1`))[0].t};
console.log('AFTER CREATE',JSON.stringify(a1));
console.log('  stock -5 ?',a1.stock===before.stock-5,'| ledger sale row ?',a1.led.length===1&&a1.led[0].txn_type==='sale'&&a1.led[0].q===-5,'| cust +500 ?',a1.cust===before.cust+500);

// 2. EDIT: qty 5 -> 8
const e=await api('PUT','/sales/'+id,{outletId:1,locationType:'warehouse',locationId:1,customerId:1,saleDate:'2026-07-29',
  lineItems:[{itemId:2,quantity:8,unitPrice:100}],paymentMode:'cash'});
console.log('EDIT',e.s,JSON.stringify({total:e.d?.totalAmount}));
const a2={stock:(await one(`select quantity::float q from stock_entries where item_id=2 and branch_type='warehouse' and branch_id=1 and material_type='item'`))[0].q,
 led:await one(`select txn_type,qty_change::float q from stock_ledger where doc_type='sale' and doc_id=$1 order by id`,[id]),
 rec:await one(`select amount::float a from receipts where voucher_number=$1`,[inv]),
 cust:(await one(`select total_purchases::float t from customers where id=1`))[0].t};
console.log('AFTER EDIT',JSON.stringify(a2));
console.log('  stock -8 ?',a2.stock===before.stock-8,'| 3 ledger rows ?',a2.led.length===3,'| receipt restated 800 ?',a2.rec[0]?.a===800,'| cust +800 ?',a2.cust===before.cust+800);

// 3. CANCEL
const x=await api('POST','/sales/'+id+'/cancel',{reason:'stabilization verification'});
console.log('CANCEL',x.s,JSON.stringify(x.d));
const a3={stock:(await one(`select quantity::float q from stock_entries where item_id=2 and branch_type='warehouse' and branch_id=1 and material_type='item'`))[0].q,
 led:await one(`select txn_type,qty_change::float q from stock_ledger where doc_type='sale' and doc_id=$1 order by id`,[id]),
 rec:await one(`select amount::float a from receipts where voucher_number=$1`,[inv]),
 cust:(await one(`select total_purchases::float t from customers where id=1`))[0].t,
 canc:(await one(`select cancelled_at from sales where id=$1`,[id]))[0].cancelled_at};
console.log('AFTER CANCEL',JSON.stringify(a3));
console.log('  stock restored ?',a3.stock===before.stock,'| 4 ledger rows ?',a3.led.length===4,'| receipt gone ?',a3.rec.length===0,'| cust restored ?',a3.cust===before.cust,'| stamped ?',!!a3.canc);

// 4. double cancel blocked
const x2=await api('POST','/sales/'+id+'/cancel',{});
console.log('DOUBLE CANCEL',x2.s,x2.d?.code);
console.log('TEST_SALE_ID='+id);
await p.end()})().catch(e=>{console.log('ERR',e.message,e.stack);process.exit(1)});
