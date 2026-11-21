/* Import a full clinic backup from an Excel workbook (.xlsx): Patients, Visits, Bills, Prescriptions,
   Appointments, Medicines and Price List sheets (the MyClinicDesk backup layout; columns are matched by name).
   POST /api/import/backup {data:"data:...;base64,...", dry:true}  -> preview counts and notes
   POST /api/import/backup {data, dry:false}                         -> imports everything in one transaction
   Old OP numbers are kept (OP 2 -> OP-0002); a number already used by a different patient gets the next free number.
   A patient already present with the same OP number and name is treated as imported before and skipped with their records. */
module.exports=function({app,need,A,Q,one,all,tx,clinic,pref,nextId,audit,str,SH,TZ,cleanMeds,cleanPrices,cleanForm,cleanBoxes}){
const MAXB=6*1024*1024;
const K=s=>String(s==null?"":s).toLowerCase().replace(/[^a-z0-9]/g,"");
/* cell value -> plain value */
const cv=v=>{if(v==null)return "";if(v instanceof Date)return v.toISOString().replace("T"," ").slice(0,19);if(typeof v==="object"){if(v.richText)return v.richText.map(x=>x.text).join("");if("result" in v)return cv(v.result);if(v.text)return String(v.text);if(v.hyperlink)return String(v.text||v.hyperlink);return ""}return v};
const sheets=async buf=>{const ExcelJS=require("exceljs"),wb=new ExcelJS.Workbook();await wb.xlsx.load(buf);const o={};
 wb.eachSheet(ws=>{const rows=[];let head=null;ws.eachRow({includeEmpty:false},(row,i)=>{const vals=[];row.eachCell({includeEmpty:true},(c,j)=>{vals[j-1]=cv(c.value)});
  if(!head){head=vals.map(x=>String(x||"").trim());return}const r={};head.forEach((h,j)=>{if(h)r[h]=vals[j]===undefined?"":vals[j]});if(Object.values(r).some(x=>x!==""&&x!==null))rows.push(r)});
  o[K(ws.name)]={name:ws.name,head:head||[],rows}});return o};
/* column lookup by any of several names */
const col=(r,...names)=>{for(const n of names){const k=Object.keys(r).find(x=>K(x)===K(n));if(k!==undefined&&r[k]!==""&&r[k]!=null)return r[k]}return ""};
const yes=v=>v===true||/^(true|yes|y|1)$/i.test(String(v).trim()),isBool=v=>v===true||v===false||/^(true|false)$/i.test(String(v).trim());
/* dates: plain dates and midnight timestamps are kept; other timestamps are UTC and shown in the clinic's time zone */
const local=s=>{const d=new Date(s.replace(" ","T")+"Z");if(isNaN(d))return null;const p=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(d).map(x=>[x.type,x.value]));return {d:`${p.year}-${p.month}-${p.day}`,t:`${p.hour==="24"?"00":p.hour}:${p.minute}`}};
const when=v=>{const s=String(v||"").trim();if(!s)return {d:"",t:""};let m=/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?/.exec(s);if(m){if(!m[2]||(m[2]==="00"&&m[3]==="00"))return {d:m[1],t:""};return local(s)||{d:m[1],t:""}}
 m=/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s);if(m)return {d:`${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`,t:""};return {d:"",t:""}};
const phone=v=>{let d=String(v||"").replace(/\D/g,"");if(d.length===12&&d.startsWith("91"))d=d.slice(2);else if(d.length===11&&d.startsWith("0"))d=d.slice(1);return d.slice(0,15)};
const sexOf=v=>/^m/i.test(String(v||""))?"Male":/^f/i.test(String(v||""))?"Female":String(v||"").trim()?"Other":"";
const money=v=>{const n=parseFloat(String(v==null?"":v).replace(/[^0-9.\-]/g,""));return isFinite(n)?Math.round(n*100)/100:0};
const jsonVals=v=>{try{const o=JSON.parse(String(v||""));return o&&typeof o==="object"?o:{}}catch(e){return {}}};
const today=()=>{const p=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`};
/* patient columns that are not patient details */
const SKIP=["id","opnumber","op","opno","invoicenumber","submissionmethod","patientsignature","dentistsignature","doctorsignature","createdat","updatedat","customdata","deletedat","recallrequired","recallat","recallmessagedat","doctorid","icd10code","diagnosistype","recallconsultantid","consentagreed","consent","registrationdate","date"];
const VISITCOLS={chiefcomplaint:"cc",complaint:"cc",diagnosis:"dx",treatmentplan:"tp",previousdentalhistory:"prev",previoustreatmenthistory:"prev",notes:"notes"};
const CORECOL={name:"name",patientname:"name",age:"age",sex:"sex",gender:"sex",address:"ad",phone:"ph",mobile:"ph",phonenumber:"ph",bloodgroup:"bg",allergies:"al",knownallergies:"al",emergencycontact:"em",guardian:"em"};

/* work out everything the import will do, without writing */
const plan=async(cid,S)=>{const notes=[],c=await clinic(cid),F=JSON.parse(JSON.stringify(c.regForm&&Array.isArray(c.regForm.sections)?c.regForm:SH.DEF_FORM)),fields=F.sections.flatMap(s=>s.f);
 const P=(S.patients||{rows:[]}).rows,V=(S.visits||{rows:[]}).rows,B=(S.bills||S.invoices||{rows:[]}).rows,RX=(S.prescriptions||{rows:[]}).rows,AP=(S.appointments||{rows:[]}).rows,MD=(S.medicines||{rows:[]}).rows,PL=(S.pricelist||S.prices||{rows:[]}).rows;
 if(!P.length)throw new Error("No Patients sheet with rows was found in this file.");
 const exist=Object.fromEntries((await all(cid,"patients")).map(p=>[p.id,p])),pfx=await pref(cid,"patients"),T=today();
 /* note boxes: make sure there is a Treatment Plan and a Previous Treatment History box */
 let boxes=Array.isArray(c.boxes)?c.boxes.slice():[{id:"cc",l:"Chief Complaint"},{id:"dx",l:"Diagnosis"},{id:"b_prevtx",l:"Previous Treatment History"},{id:"notes",l:"Notes"}],boxAdd=[];
 const boxFor=(re,id,l)=>{let b=boxes.find(x=>re.test(x.l||""));if(!b){b={id,l};boxes.push(b);boxAdd.push(l)}return b.id};
 const BOX={tp:boxFor(/treatment\s*plan/i,"b_tplan","Treatment Plan"),prev:boxFor(/previous|past\s*(dental|treatment)/i,"b_prevtx","Previous Treatment History")};
 const putBox=(v,k,val)=>{val=String(val||"").trim();if(!val)return;const id=k==="cc"||k==="dx"||k==="notes"?k:BOX[k];if(["cc","dx","notes"].includes(id)){if(!v[id])v[id]=val}else{v.extra=v.extra||{};if(!v.extra[id])v.extra[id]=val}};
 /* patient detail columns -> registration form fields (matched by label; missing ones are added) */
 const head=(S.patients.head||[]).filter(h=>h),fmap={},added=[];let n=0;
 for(const h of head){const k=K(h);if(SKIP.includes(k)||VISITCOLS[k]||CORECOL[k])continue;const vals=P.map(r=>r[h]).filter(x=>x!==""&&x!=null&&x!==false);if(!vals.length)continue;
  if(/^(xrayidnumber|registrationno|registrationnumber)$/.test(k)&&P.every(r=>{const v=String(r[h]??"").replace(/\D/g,""),op=String(col(r,"OP Number","OP No","OP")).replace(/\D/g,"");return !v||v===op}))continue;
  let f=fields.find(x=>K(x.l)===k)||fields.find(x=>K(x.l).startsWith(k)||k.startsWith(K(x.l))&&K(x.l).length>4);
  if(!f){const bool=P.every(r=>r[h]===""||r[h]==null||isBool(r[h]));let id="c_"+k.slice(0,8);if(id.length<5)id="c_"+(k+"fld").slice(0,8);while(fields.some(x=>x.id===id))id="c_"+k.slice(0,5)+(++n);
   f={id,l:String(h).replace(/\s+/g," ").trim().slice(0,80),y:bool?"yesno":"text"};const sec=bool?F.sections.find(s=>/medical/i.test(s.t))||F.sections[F.sections.length-1]:F.sections[0];if(sec.f.length>=40)continue;sec.f.push(f);fields.push(f);added.push(f.l)}
  fmap[h]=f}
 /* patients */
 const byOld={},pats=[],skipOld=new Set();let delP=0,dupP=0,reNum=0,oddPh=0,maxOp=0;
 const used=new Set(Object.keys(exist));
 for(const r of [...P].sort((a,b)=>(+col(a,"OP Number","OP No","OP")||1e9)-(+col(b,"OP Number","OP No","OP")||1e9))){const old=String(col(r,"ID","Patient ID")),name=String(col(r,"Name","Patient Name")).trim();
  if(col(r,"Deleted At")){delP++;skipOld.add(old);continue}if(!name){skipOld.add(old);continue}
  const op=parseInt(String(col(r,"OP Number","OP No","OP")).replace(/\D/g,""))||0;let id=op?pfx+String(op).padStart(4,"0"):"",oldOp="";
  if(id&&exist[id]&&K(exist[id].name)===K(name)){dupP++;skipOld.add(old);continue}
  if(!id||used.has(id)){oldOp=op?String(op):"";id="";reNum++}else used.add(id);if(op)maxOp=Math.max(maxOp,op);
  const ph=phone(col(r,"Phone","Mobile","Phone Number"));if(ph&&ph.length!==10)oddPh++;
  const cr=when(col(r,"Created At","Registration Date","Date")),date=cr.d||T,p={name,age:String(col(r,"Age")).replace(/\D/g,"").slice(0,3),sex:sexOf(col(r,"Sex","Gender")),ph,date,imported:true};
  for(const [h,cl] of Object.entries(CORECOL))if(!p[cl]&&r[Object.keys(r).find(x=>K(x)===h)]){const v=String(r[Object.keys(r).find(x=>K(x)===h)]).trim();if(cl!=="name"&&cl!=="age"&&cl!=="sex"&&cl!=="ph")p[cl]=v.slice(0,400)}
  for(const [h,f] of Object.entries(fmap)){const v=r[h];if(v===""||v==null)continue;const val=f.y==="yesno"?(yes(v)?"Yes":"No"):String(v).trim();if(!val)continue;if(["ad","bg","em","al","hx"].includes(f.id))p[f.id]=val.slice(0,500);else{p.custom=p.custom||{};p.custom[f.id]=val.slice(0,500)}}
  if(yes(col(r,"Consent Agreed","Consent")))p.consentAt=date;if(oldOp)p.oldOp=oldOp;
  const rc=when(col(r,"Recall At"));if(yes(col(r,"Recall Required"))&&rc.d&&rc.d>=T){p.fu=rc.d;if(rc.t&&rc.t!=="00:00")p.fut=rc.t}
  const cd=jsonVals(col(r,"Custom Data")),first={};for(const [h,k] of Object.entries(VISITCOLS)){const key=Object.keys(r).find(x=>K(x)===h);if(key)putBox(first,k,r[key])}
  for(const [k2,v2] of Object.entries(cd)){if(/treatment_?plan/i.test(k2))putBox(first,"tp",v2);else if(/diagnos/i.test(k2))putBox(first,"dx",v2);else if(/complaint/i.test(k2))putBox(first,"cc",v2);else if(String(v2||"").trim())putBox(first,"notes",`${k2.replace(/^note:/,"").replace(/_[a-z0-9]{6,}$/,"").replace(/[_:]/g," ")}: ${v2}`)}
  pats.push({old,id,p,first});byOld[old]=pats[pats.length-1]}
 /* visits: earliest one per patient becomes the first visit */
 const vs=[],vByOld={};let skV=0;
 for(const r of V){const pt=byOld[String(col(r,"Patient ID"))];if(!pt){skV++;continue}const d=when(col(r,"Visit Date","Date")).d||pt.p.date,v={pid:null,date:d};
  putBox(v,"cc",col(r,"Chief Complaint","Complaint"));putBox(v,"dx",col(r,"Diagnosis"));putBox(v,"tp",col(r,"Treatment Plan"));putBox(v,"notes",col(r,"Notes"));
  for(const [k2,v2] of Object.entries(jsonVals(col(r,"Custom Data"))))if(String(v2||"").trim())putBox(v,/treatment_?plan/i.test(k2)?"tp":"notes",/treatment_?plan/i.test(k2)?v2:`${k2.replace(/^note:/,"").replace(/_[a-z0-9]{6,}$/,"").replace(/[_:]/g," ").replace(/^anyOther$/i,"Any other")}: ${v2}`);
  const x={old:String(col(r,"ID")),pt,v,ord:String(col(r,"Created At"))};vs.push(x);vByOld[x.old]=x}
 vs.sort((a,b)=>(a.v.date+a.ord).localeCompare(b.v.date+b.ord));
 const mhOf=p=>Object.fromEntries(fields.filter(f=>f.y==="yesno").map(f=>[f.id,(p.custom||{})[f.id]||""]).filter(x=>x[1]));
 for(const pt of pats){const mine=vs.filter(x=>x.pt===pt);let f=mine[0];
  if(!f){f={old:"",pt,v:{pid:null,date:pt.p.date}};vs.unshift(f)}else if(f.v.date<pt.p.date){pt.p.date=f.v.date;if(pt.p.consentAt)pt.p.consentAt=f.v.date}
  f.v.mhChg="First visit";f.v.mh=mhOf(pt.p);if(pt.p.consentAt)f.v.consentAt=pt.p.consentAt;for(const k of ["cc","dx","notes"])if(pt.first[k]&&!f.v[k])f.v[k]=pt.first[k];for(const [k,val] of Object.entries(pt.first.extra||{}))if(!(f.v.extra||{})[k]){f.v.extra=f.v.extra||{};f.v.extra[k]=val}}
 /* bills: lines of the same visit (or same patient and day) form one invoice */
 const bg=new Map();let skB=0;
 for(const r of B){const pt=byOld[String(col(r,"Patient ID"))];if(!pt){skB++;continue}const d=when(col(r,"Appointment Date","Bill Date","Date","Created At")).d||pt.p.date,vk=String(col(r,"Visit ID")),key=pt.old+"|"+(vk||d);
  if(!bg.has(key))bg.set(key,{pt,date:d,vis:vByOld[vk]||null,items:[],paid:0,m:new Set()});const g=bg.get(key),amt=money(col(r,"Amount","Total","Price"));
  g.items.push({n:String(col(r,"Description","Service","Item")||"Charges").trim().slice(0,120)||"Charges",q:1,r:amt});g.paid+=money(col(r,"Amount Paid","Paid"));const pm=String(col(r,"Payment Method","Payment Mode")).trim();if(pm)g.m.add(/upi/i.test(pm)?"UPI":/card/i.test(pm)?"Card":/cash/i.test(pm)?"Cash":pm.slice(0,20))}
 const bills=[...bg.values()].sort((a,b)=>a.date.localeCompare(b.date));
 /* prescriptions: medicines of the same visit form one prescription */
 const rg=new Map();
 for(const r of RX){const pt=byOld[String(col(r,"Patient ID"))];if(!pt)continue;const vk=String(col(r,"Visit ID")),vis=vByOld[vk],key=pt.old+"|"+(vk||"x");if(!rg.has(key))rg.set(key,{pt,date:vis?vis.v.date:pt.p.date,meds:[]});
  const fr=String(col(r,"Frequency Text")).trim()||[col(r,"Morning"),col(r,"Afternoon"),col(r,"Evening")].map(x=>String(x===""?0:x)).join("-"),dd=String(col(r,"Duration Days","Days")).trim();
  rg.get(key).meds.push({n:[col(r,"Form"),col(r,"Name","Medicine"),col(r,"Strength")].filter(Boolean).join(" ").slice(0,120),d:"",f:fr==="0-0-0"?"":fr,u:dd?dd+" days":"",i:String(col(r,"Intake")).trim()})}
 const rxs=[...rg.values()];
 /* appointments */
 const exA=new Set((await all(cid,"appts")).map(a=>[a.date,a.time||"",K(a.nm||a.pid)].join("|")));
 const appts=AP.map(r=>{const oid=String(col(r,"Patient ID")),pt=byOld[oid],w=when(col(r,"Starts At","Date","Start")),st=String(col(r,"Status")).toLowerCase();if(!w.d)return null;if(!pt&&oid&&skipOld.has(oid)&&dupP)return null;
  const a={date:w.d,time:w.t,note:String(col(r,"Notes","Service Type")).trim().slice(0,200),st:/cancel|no.?show/.test(st)?"Cancelled":/complet|done|visited/.test(st)?"Done":"Booked"};
  if(pt)return {pt,a};const nm=String(col(r,"Patient Name","Name")).trim(),ph=phone(col(r,"Patient Phone","Phone"));if(!nm||exA.has([a.date,a.time,K(nm)].join("|")))return null;return {pt:null,a:{...a,pid:"",nm,ph,np:true}}}).filter(Boolean);
 /* medicines and price list */
 const mk=m=>K(m.t)+"|"+K(m.n)+"|"+K(m.s),exM=new Set((c.medlist||[]).map(mk)),exP=new Set((c.prices||[]).map(p=>K(p.c||"Other")+"|"+K(p.n)));
 const meds=MD.map(r=>({t:String(col(r,"Form","Type")).trim(),n:String(col(r,"Name")).trim(),s:String(col(r,"Strength")).trim(),d:String(col(r,"Default Dosage","Dosage")).trim(),i:String(col(r,"Default Intake","Intake")).trim(),u:String(col(r,"Default Duration Days","Days")).replace(/\D/g,""),on:col(r,"Is Active")===""?true:yes(col(r,"Is Active")),src:"import"})).filter(m=>m.n&&!exM.has(mk(m)));
 const prices=PL.map(r=>({n:String(col(r,"Name")).trim(),c:String(col(r,"Category","Lab Category")).trim()||"Other",r:money(col(r,"Price")),on:col(r,"Is Active")===""?true:yes(col(r,"Is Active"))})).filter(x=>x.n&&!exP.has(K(x.c)+"|"+K(x.n)));
 const docs=((S.doctors||{rows:[]}).rows||[]).length;
 if(delP)notes.push(`${delP} patient${delP>1?"s are":" is"} marked as deleted in the file and will be skipped, with their visits and bills.`);
 if(dupP)notes.push(`${dupP} patient${dupP>1?"s are":" is"} already in MyClinicDesk with the same OP number and name, so they and their records are skipped.`);
 if(reNum)notes.push(`${reNum} OP number${reNum>1?"s are":" is"} already used by a different patient here; ${reNum>1?"they get":"it gets"} the next free number, and the old number is noted on the record.`);
 if(oddPh)notes.push(`${oddPh} phone number${oddPh>1?"s don't":" doesn't"} have 10 digits; ${oddPh>1?"they are":"it is"} kept as written so you can correct ${oddPh>1?"them":"it"}.`);
 if(added.length)notes.push(`New fields will be added to your registration form: ${added.join(", ")}.`);
 if(boxAdd.length)notes.push(`New note boxes will be added: ${boxAdd.join(", ")}.`);
 if(docs)notes.push(`${docs} doctor${docs>1?"s are":" is"} listed in the file. Doctors are not imported; add them under Settings › Team if they need to sign in.`);
 notes.push("Patient and doctor signature images are not part of the file, so they are not imported.");
 const billed=bills.reduce((s,g)=>s+g.items.reduce((x,i)=>x+i.r,0),0),paid=bills.reduce((s,g)=>s+g.paid,0);
 return {c,F,boxes,boxChanged:boxAdd.length>0,formChanged:added.length>0,pats,vs,bills,rxs,appts,meds,prices,maxOp,
  summary:{patients:pats.length,visits:vs.length,firstVisits:pats.length,followups:vs.length-pats.length,bills:bills.length,billLines:B.length-skB,billed,paid,prescriptions:rxs.length,appointments:appts.length,medicines:meds.length,prices:prices.length,skippedDeleted:delP,skippedExisting:dupP,renumbered:reNum,clinicName:String(((S.about||{rows:[]}).rows.find(r=>K(Object.values(r)[0])==="clinic")||{})[Object.keys((S.about||{rows:[{}]}).rows[0]||{})[1]]||""),notes}}};

const commit=async(cid,X,u)=>tx(async c=>{const q=(t,p)=>c.query(t,p),ins=(coll,id,d)=>q("INSERT INTO docs(cid,coll,id,data) VALUES($1,$2,$3,$4)",[cid,coll,id,JSON.stringify(d)]);
 for(const pt of X.pats){if(!pt.id)pt.id=null}
 /* keep old OP numbers; continue numbering after the highest one */
 await q("INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=GREATEST(kv.v::int,$2::int)::text",["c"+cid+":seq:patients",String(X.maxOp)]);
 for(const pt of X.pats){if(!pt.id)pt.id=await nextId(cid,"patients",q);pt.p.id=pt.id;await ins("patients",pt.id,pt.p)}
 for(const x of X.vs){x.v.pid=x.pt.id;const id=await nextId(cid,"visits",q);x.v.id=id;await ins("visits",id,x.v)}
 for(const g of X.bills){const id=await nextId(cid,"bills",q),t=Math.round(g.items.reduce((s,i)=>s+i.r,0)*100)/100,paid=Math.round(g.paid*100)/100;
  const d={pid:g.pt.id,date:g.date,items:g.items,s:t,d:0,t,pays:paid>0?[{d:g.date,a:paid,m:[...g.m][0]||"Cash"}]:[],id,no:id,imported:true};if(g.vis&&g.vis.v.id)d.vid=g.vis.v.id;await ins("bills",id,d)}
 for(const r of X.rxs){const id=await nextId(cid,"rx",q);await ins("rx",id,{pid:r.pt.id,date:r.date,meds:r.meds,id,no:id,imported:true})}
 for(const a of X.appts){const id=await nextId(cid,"appts",q);await ins("appts",id,{...a.a,pid:a.pt?a.pt.id:a.a.pid||"",id})}
 /* clinic settings: form fields, note boxes, medicine list, price list */
 const kr=await q("SELECT v FROM kv WHERE k=$1",["c"+cid+":clinic"]),o=kr.rows[0]?JSON.parse(kr.rows[0].v):{};let ch=false;
 if(X.formChanged){const f=cleanForm(X.F);if(f){o.regForm=f;ch=true}}
 if(X.boxChanged){o.boxes=cleanBoxes(X.boxes);ch=true}
 if(X.meds.length){const base=Array.isArray(o.medlist)?o.medlist:[];o.medlist=cleanMeds(base.concat(X.meds.map((m,i)=>({...m,id:"im"+Date.now().toString(36)+i}))));ch=true}
 if(X.prices.length){o.prices=cleanPrices((o.prices||[]).concat(X.prices.map((p,i)=>({...p,id:"ip"+i+Date.now().toString(36).slice(-4)}))));ch=true}
 if(ch)await q("INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=excluded.v",["c"+cid+":clinic",JSON.stringify(o)])});

app.post("/api/import/backup",need("doctor"),A(async(q,s)=>{const b=q.body||{},m=/^data:[^;,]*;base64,([A-Za-z0-9+/=]+)$/.exec(typeof b.data==="string"?b.data:"");
 if(!m)return s.status(400).json({error:"Choose the Excel backup file (.xlsx) to import."});const buf=Buffer.from(m[1],"base64");
 if(buf.length>MAXB)return s.status(400).json({error:"The file is larger than 6 MB."});if(buf.subarray(0,2).toString("latin1")!=="PK")return s.status(400).json({error:"This is not an Excel (.xlsx) file. If it is a CSV file, use the CSV option instead."});
 let S;try{S=await sheets(buf)}catch(e){return s.status(400).json({error:"The Excel file could not be read. Open it in Excel and save it again as .xlsx, then try again."})}
 let X;try{X=await plan(q.u.cid,S)}catch(e){return s.status(400).json({error:e.message})}
 if(b.dry!==false)return s.json({dry:true,...X.summary});
 await commit(q.u.cid,X,q.u);await audit(q.u,"import_backup",`${X.summary.patients} patients, ${X.summary.visits} visits, ${X.summary.bills} bills`);s.json({dry:false,...X.summary})}));
};
