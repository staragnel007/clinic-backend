/* Google Drive backup.
   Each night (about 2 AM clinic time) every connected clinic on an active trial or the paid plan gets
   MyClinicDesk_Backup_YYYY-MM-DD.zip in a "MyClinicDesk Backups" folder of the doctor's Google Drive:
     Patient_Reports/OP-0001_Name.pdf   one Patient Report per patient (pdfkit)
     Clinic_Records_YYYY-MM-DD.xlsx     Patients, Visits, Prescriptions and Bills sheets (exceljs)
   Uses the drive.file permission: the app sees only the files it creates. The refresh token is stored
   encrypted with GDRIVE_TOKEN_KEY (AES-256-GCM). The newest 30 backups are kept. */
const crypto=require("crypto"),zlib=require("zlib");
/* pdfkit and exceljs are loaded only when a backup runs, so a problem with either library can never stop the app from starting */
let _pdf,_xl;const PDFDocument=function(o){_pdf=_pdf||require("pdfkit");return new _pdf(o)},XL=()=>(_xl=_xl||require("exceljs"));

module.exports=function(ctx){
const {Q,one,all,clinic,audit,str,base,who,TZ,SH,GID,GSECRET,A}=ctx;
const KEYRAW=process.env.GDRIVE_TOKEN_KEY||"",KEY=KEYRAW.length>=32?crypto.createHash("sha256").update(KEYRAW).digest():null;
const READY=!!(GID&&GSECRET&&KEY),KEEP=30,FOLDER="MyClinicDesk Backups",PREFIX="MyClinicDesk_Backup_",SCOPE="https://www.googleapis.com/auth/drive.file";
if(!KEY)console.warn("GDRIVE_TOKEN_KEY is not set (or shorter than 32 characters): Google Drive backup is disabled.");

const init=()=>Q(`CREATE TABLE IF NOT EXISTS gdrive(cid INTEGER PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,email TEXT NOT NULL,rtok TEXT NOT NULL,folder TEXT,uid INTEGER,
 connected TIMESTAMPTZ NOT NULL DEFAULT now(),last_ok TIMESTAMPTZ,last_file TEXT,last_try TIMESTAMPTZ,last_err TEXT)`);

/* ---------- token encryption ---------- */
const enc=t=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv("aes-256-gcm",KEY,iv),x=Buffer.concat([c.update(t,"utf8"),c.final()]);return ["v1",iv.toString("base64"),c.getAuthTag().toString("base64"),x.toString("base64")].join(":")};
const dec=s=>{const [v,iv,tag,x]=String(s).split(":");if(v!=="v1")throw new Error("Unknown token format");const d=crypto.createDecipheriv("aes-256-gcm",KEY,Buffer.from(iv,"base64"));d.setAuthTag(Buffer.from(tag,"base64"));return Buffer.concat([d.update(Buffer.from(x,"base64")),d.final()]).toString("utf8")};

/* active trial or paid plan (same rule as the admin dashboard: no trial end date counts as unlimited) */
const allowed=async cid=>{const u=await one("SELECT plan,trial_end FROM users WHERE cid=$1 AND role='doctor' ORDER BY id LIMIT 1",[cid]);return !!u&&(u.plan==="paid"||!u.trial_end||new Date(u.trial_end)>new Date())};

/* ---------- dates in the clinic's time zone ---------- */
const parts=(d=new Date())=>Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hour12:false}).formatToParts(d).map(p=>[p.type,p.value]));
const today=(d)=>{const p=parts(d);return `${p.year}-${p.month}-${p.day}`},hourNow=()=>+parts().hour%24;
const fd=s=>{if(!s)return "";const [y,m,d]=String(s).slice(0,10).split("-");return d&&m&&y?`${d}/${m}/${y}`:String(s)};

/* ---------- Google OAuth (connect) ---------- */
const STATES=new Map();
const redirect=q=>base(q)+"/auth/gdrive/callback";
const back=(s,r)=>s.type("html").send(`<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/?gdrive=${r}#/settings"><title>Google Drive</title><p style="font:16px system-ui;padding:24px">Returning to MyClinicDesk… <a href="/?gdrive=${r}#/settings">Continue</a></p>`);
function authRoutes(app){
 app.get("/auth/gdrive",A(async(q,s)=>{const u=await who(q);if(!u||u.role!=="doctor")return s.redirect("/");if(!READY)return s.status(404).send("Google Drive backup is not set up on this server");
  if(!await allowed(u.cid))return s.redirect("/?gdrive=plan#/settings");
  for(const [k,v] of STATES)if(v.exp<Date.now())STATES.delete(k);
  const st=crypto.randomBytes(24).toString("hex");STATES.set(st,{cid:u.cid,uid:u.id,exp:Date.now()+6e5});
  s.redirect("https://accounts.google.com/o/oauth2/v2/auth?"+new URLSearchParams({client_id:GID,redirect_uri:redirect(q),response_type:"code",scope:"openid email "+SCOPE,state:st,access_type:"offline",prompt:"consent select_account",include_granted_scopes:"false",login_hint:u.email||""}))}));
 app.get("/auth/gdrive/callback",A(async(q,s)=>{s.set("Cache-Control","no-store");const st=String(q.query.state||""),me=STATES.get(st);STATES.delete(st);
  if(!me||me.exp<Date.now())return back(s,"failed");if(q.query.error)return back(s,"denied");
  const tr=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({code:String(q.query.code||""),client_id:GID,client_secret:GSECRET,redirect_uri:redirect(q),grant_type:"authorization_code"})});
  const tk=await tr.json().catch(()=>({}));if(!tr.ok||!tk.access_token){console.error("Drive connect failed:",tk.error||tr.status);return back(s,"failed")}
  if(!String(tk.scope||"").split(" ").includes(SCOPE))return back(s,"scope");
  if(!tk.refresh_token){console.error("Drive connect: no refresh token");return back(s,"failed")}
  const ir=await fetch("https://openidconnect.googleapis.com/v1/userinfo",{headers:{Authorization:"Bearer "+tk.access_token}}),g=await ir.json().catch(()=>({}));
  const em=str(g.email,200)||"Google account",old=await one("SELECT rtok FROM gdrive WHERE cid=$1",[me.cid]);
  await Q(`INSERT INTO gdrive(cid,email,rtok,uid) VALUES($1,$2,$3,$4) ON CONFLICT(cid) DO UPDATE SET email=EXCLUDED.email,rtok=EXCLUDED.rtok,uid=EXCLUDED.uid,connected=now(),folder=NULL,last_err=NULL`,[me.cid,em,enc(tk.refresh_token),me.uid]);
  if(old)revoke(old.rtok);await audit({id:me.uid,cid:me.cid},"gdrive_connect",em);back(s,"connected")}));
}
const revoke=rt=>{try{fetch("https://oauth2.googleapis.com/revoke?token="+encodeURIComponent(dec(rt)),{method:"POST"}).catch(()=>{})}catch(e){}};

/* ---------- Google Drive calls ---------- */
const access=async row=>{const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:GID,client_secret:GSECRET,refresh_token:dec(row.rtok),grant_type:"refresh_token"})}),j=await r.json().catch(()=>({}));
 if(!r.ok)throw new Error(j.error==="invalid_grant"?"Google Drive access was removed or has expired. Please disconnect and connect Google Drive again.":"Could not sign in to Google Drive ("+(j.error||r.status)+").");return j.access_token};
const gd=async(tok,url,o={})=>{const r=await fetch(url,{...o,headers:{Authorization:"Bearer "+tok,...(o.headers||{})}});if(!r.ok){const t=await r.text().catch(()=>"");let m=t;try{m=JSON.parse(t).error.message}catch(e){}const e=new Error(r.status===403&&/has not been used|disabled/i.test(m)?"The Google Drive API is not enabled for this app's Google Cloud project.":r.status===403&&/quota|storage/i.test(m)?"Your Google Drive is full.":`Google Drive error ${r.status}: ${String(m).slice(0,160)}`);e.status=r.status;throw e}return r.status===204?null:r.json()};
const DAPI="https://www.googleapis.com/drive/v3/files";
const folderOf=async(tok,row)=>{if(row.folder){try{const f=await gd(tok,`${DAPI}/${encodeURIComponent(row.folder)}?fields=id,trashed`);if(!f.trashed)return f.id}catch(e){if(e.status!==404)throw e}}
 const f=await gd(tok,DAPI+"?fields=id",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:FOLDER,mimeType:"application/vnd.google-apps.folder"})});await Q("UPDATE gdrive SET folder=$2 WHERE cid=$1",[row.cid,f.id]);return f.id};
const upload=async(tok,folder,name,buf)=>{const r=await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name",{method:"POST",headers:{Authorization:"Bearer "+tok,"Content-Type":"application/json; charset=UTF-8","X-Upload-Content-Type":"application/zip","X-Upload-Content-Length":String(buf.length)},body:JSON.stringify({name,parents:[folder],mimeType:"application/zip"})});
 if(!r.ok){await gd(tok,"https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});throw new Error("Upload to Google Drive could not start ("+r.status+")")}
 const loc=r.headers.get("location"),u=await fetch(loc,{method:"PUT",headers:{"Content-Type":"application/zip","Content-Length":String(buf.length)},body:buf});if(!u.ok)throw new Error("Upload to Google Drive failed ("+u.status+")");return u.json()};
const tidy=async(tok,folder,keepId,name)=>{const q=`'${folder}' in parents and trashed=false and name contains '${PREFIX}'`,L=(await gd(tok,`${DAPI}?q=${encodeURIComponent(q)}&orderBy=createdTime desc&fields=files(id,name,createdTime)&pageSize=200`)).files||[];
 const drop=L.filter(f=>f.id!==keepId&&f.name===name).concat(L.filter(f=>f.id!==keepId&&f.name!==name).slice(KEEP-1));for(const f of drop)await gd(tok,`${DAPI}/${f.id}`,{method:"DELETE"}).catch(()=>{})};

/* ---------- the clinic's data ---------- */
const BUILTIN=["cc","dx","notes","rx"];
const load=async cid=>{const [c,patients,visits,rx,bills]=await Promise.all([clinic(cid),all(cid,"patients"),all(cid,"visits"),all(cid,"rx"),all(cid,"bills")]);
 const F=c.regForm&&Array.isArray(c.regForm.sections)?c.regForm:SH.DEF_FORM,fields=F.sections.flatMap(s=>s.f.map(f=>({...f,sec:s.t}))),seen=new Set(),FL=fields.filter(f=>!seen.has(f.id)&&seen.add(f.id));
 /* note boxes, same rules as the app: an old custom "Chief Complaint" box is the complaint itself */
 const bs=new Set(),BX=(Array.isArray(c.boxes)?c.boxes:[{id:"cc",l:"Chief Complaint"},{id:"dx",l:"Diagnosis"},{id:"b_prevtx",l:"Previous Treatment History"},{id:"notes",l:"Notes"},...(c.noteBoxes||[]).map(l=>({id:l,l}))])
  .filter(b=>b&&b.id!=="rx"&&!/^prescription$/i.test(String(b.l||"").trim())).map(b=>b.id!=="cc"&&/^chief complaints?$/i.test(String(b.l||"").trim())?{id:"cc",l:b.l,legacy:b.id}:b).filter(b=>!bs.has(b.id)&&bs.add(b.id));
 if(!bs.has("cc"))BX.unshift({id:"cc",l:"Chief Complaint"});if(!bs.has("dx"))BX.splice(BX.findIndex(b=>b.id==="cc")+1,0,{id:"dx",l:"Diagnosis"});
 return {c,patients,visits,rx,bills,FL,BX}};
const CORE=["name","age","sex","ph","bg","em","ad","al","hx"],HEAD=["name","age","sex","ph"];
const fv=(p,f)=>{const v=CORE.includes(f.id)?p[f.id]:(p.custom||{})[f.id];return v==null?"":String(v)};
const bxv=(v,b)=>String((BUILTIN.includes(b.id)?v[b.id]||(b.legacy&&(v.extra||{})[b.legacy]):(v.extra||{})[b.id])||"");
const paid=b=>(b.pays||[]).reduce((s,x)=>s+(+x.a||0),0);
const medTxt=m=>[m.n,m.d,m.f,m.u].filter(Boolean).join(" · ")+(m.i?` (${m.i})`:"");
const drName=c=>c.doctor?"Dr. "+String(c.doctor).trim().replace(/^Dr\.?\s*/i,""):"";

/* ---------- Patient Report PDF ----------
   The built-in PDF fonts cover English and Western European letters only; text in Indian scripts shows as "?"
   in the PDF but is kept in full in the Excel file. */
const T=s=>String(s==null?"":s).replace(/₹/g,"Rs.").replace(/[‐-‒]/g,"-").replace(/[^\x09\x0a\x0d\x20-\x7e -ÿ–—‘’“”•…·]+/g,"?");
const img=d=>{const m=/^data:image\/(png|jpe?g);base64,(.+)$/i.exec(d||"");return m?Buffer.from(m[2],"base64"):null};
const pdfReport=(D,p)=>new Promise((ok,no)=>{const {c,FL}=D,doc=new PDFDocument({size:"A4",margin:40,bufferPages:true,info:{Title:`Patient Report ${p.id}`,Author:T(c.name||"Clinic"),Creator:"MyClinicDesk"}}),out=[];
 doc.on("data",x=>out.push(x));doc.on("end",()=>ok(Buffer.concat(out)));doc.on("error",no);
 const W=doc.page.width-80,L=40,col=c.theme&&/^#[0-9a-f]{6}$/i.test(c.theme)?c.theme:"#1f3b5a",room=h=>{if(doc.y+h>doc.page.height-60)doc.addPage()};
 try{
 /* letterhead */
 const lh=img(c.lh);if(lh){try{doc.image(lh,L,30,{width:W});doc.moveDown(0.5);doc.y=Math.max(doc.y,30+W*0.18)}catch(e){}}
 else{const lg=img(c.logo);let x=L;if(lg){try{doc.image(lg,L,36,{fit:[70,60]});x=L+82}catch(e){}}
  doc.fillColor(col).font("Helvetica-Bold").fontSize(18).text(T(c.name||"Clinic"),x,38,{width:W-(x-L)});
  doc.fillColor("#222").font("Helvetica").fontSize(10);const dn=drName(c);if(dn)doc.font("Helvetica-Bold").text(T(dn),x).font("Helvetica");
  const cred=[c.qual,c.spec].filter(Boolean).join(" · ");if(cred)doc.text(T(cred),x);if(c.reg)doc.text(T("Reg. No: "+c.reg),x);
  const ad=[c.addr,c.area,c.city,[c.state,c.pin].filter(Boolean).join(" - ")].filter(Boolean).join(", ");doc.fillColor("#555").fontSize(9);if(ad)doc.text(T(ad),x,undefined,{width:W-(x-L)});
  const ph=[c.phone&&(c.phlabel||"Ph")+": "+c.phone,c.email].filter(Boolean).join("  ·  ");if(ph)doc.text(T(ph),x);if(c.time)doc.text(T(String(c.time).split(/\s*;\s*/).join("   ")),x,undefined,{width:W-(x-L)});
  doc.y=Math.max(doc.y,100)+6}
 doc.moveTo(L,doc.y).lineTo(L+W,doc.y).lineWidth(1.5).strokeColor(col).stroke();doc.moveDown(0.8);
 doc.fillColor("#111").font("Helvetica-Bold").fontSize(13).text("PATIENT REPORT",L,doc.y,{width:W,align:"center",characterSpacing:1});doc.moveDown(0.6);
 /* patient line */
 const y0=doc.y;doc.font("Helvetica-Bold").fontSize(11).text(T(p.name||""),L,y0,{continued:true}).font("Helvetica").text(T(`, ${p.age||"–"} y / ${p.sex||"–"}`));
 doc.fontSize(9.5).fillColor("#444").text(T(`${p.id}${p.ph?"  ·  +91 "+p.ph:""}`));doc.text(`Registered: ${fd(p.date)}`,L,y0,{width:W,align:"right"});doc.text(`Report date: ${fd(today())}`,{width:W,align:"right"});doc.y=Math.max(doc.y,y0+30);doc.moveDown(0.5);
 const H=t=>{room(40);doc.moveDown(0.4);doc.fillColor(col).font("Helvetica-Bold").fontSize(11).text(t,L);doc.moveTo(L,doc.y+1).lineTo(L+W,doc.y+1).lineWidth(0.6).strokeColor(col).stroke();doc.moveDown(0.4);doc.fillColor("#222").font("Helvetica").fontSize(9.5)};
 /* details and medical history */
 const det=FL.filter(f=>!HEAD.includes(f.id)&&f.y!=="yesno"&&fv(p,f)),yn=FL.filter(f=>f.y==="yesno"&&fv(p,f));
 if(det.length){H("Patient details");for(const f of det){room(16);doc.font("Helvetica-Bold").text(T(f.l)+": ",L,doc.y,{continued:true,width:W}).font("Helvetica").text(T(fv(p,f)))}}
 if(yn.length){H("Medical history");const half=W/2;for(let i=0;i<yn.length;i+=2){room(16);const y=doc.y;[yn[i],yn[i+1]].forEach((f,k)=>{if(!f)return;const v=fv(p,f);doc.font("Helvetica").fillColor("#222").text(T(f.l),L+k*half,y,{width:half-60});doc.font("Helvetica-Bold").fillColor(/^y/i.test(v)?"#b3261e":"#222").text(T(v),L+k*half+half-56,y,{width:50})});doc.fillColor("#222");doc.y=Math.max(doc.y,y+14)}}
 /* visits */
 const vs=D.visits.filter(v=>v.pid===p.id),rx=D.rx.filter(r=>r.pid===p.id),noFirst=!!p.date&&!vs.some(v=>v.date<=p.date)&&!vs.some(v=>v.mhChg==="First visit");
 const ccF=FL.find(f=>/complaint/i.test(f.l||"")),dates=[...new Set(vs.map(v=>v.date).concat(rx.map(r=>r.date)).concat(noFirst?[p.date]:[]))].filter(Boolean).sort();
 H(`Visits (${dates.length})`);
 if(!dates.length)doc.text("No visits yet.");else{const cw=[70,(W-70)*0.28,(W-70)*0.27,(W-70)*0.45],hx=[L,L+cw[0],L+cw[0]+cw[1],L+cw[0]+cw[1]+cw[2]];
  const head=()=>{room(24);const y=doc.y;doc.rect(L,y-3,W,17).fill("#eef2f6");doc.fillColor("#333").font("Helvetica-Bold").fontSize(9);["Date","Complaint","Diagnosis","Prescription"].forEach((t,i)=>doc.text(t,hx[i]+4,y,{width:cw[i]-8}));doc.y=y+18;doc.font("Helvetica").fillColor("#222")};head();
  for(const d of dates){const v=vs.filter(x=>x.date===d),r=rx.filter(x=>x.date===d),first=v.some(x=>x.mhChg==="First visit")||(noFirst&&d===p.date);
   const ccB=D.BX.find(b=>b.id==="cc"),cc=v.map(x=>bxv(x,ccB)).filter(Boolean).join("; ")||(noFirst&&d===p.date&&ccF?fv(p,ccF):""),dx=[...new Set(v.map(x=>x.dx).concat(r.map(x=>x.dx)).filter(Boolean))].join("; ");
   const pr=r.length?r.map(x=>`${x.no}\n`+(x.meds||[]).map((m,i)=>`${i+1}. ${medTxt(m)}`).join("\n")+(x.a?`\nNotes: ${x.a}`:"")).join("\n\n"):v.map(x=>x.rx).filter(Boolean).join("; ")||"–";
   const cells=[fd(d)+(first?"\nFirst visit":""),cc||"–",dx||"–",pr].map(T);doc.fontSize(9);const h=Math.max(...cells.map((t,i)=>doc.heightOfString(t,{width:cw[i]-8})))+8;
   if(doc.y+h>doc.page.height-60){doc.addPage();head()}const y=doc.y;cells.forEach((t,i)=>doc.fillColor(i===0&&first?"#333":"#222").text(t,hx[i]+4,y+3,{width:cw[i]-8}));
   doc.moveTo(L,y+h).lineTo(L+W,y+h).lineWidth(0.4).strokeColor("#d5d9de").stroke();doc.y=y+h+2}}
 /* billing */
 const bl=D.bills.filter(b=>b.pid===p.id);if(bl.length){const t=bl.reduce((s,b)=>s+(+b.t||0),0),pd=bl.reduce((s,b)=>s+paid(b),0);H("Billing");doc.text(T(`${bl.length} invoice${bl.length===1?"":"s"}  ·  Total Rs. ${t.toFixed(2)}  ·  Paid Rs. ${pd.toFixed(2)}  ·  ${t-pd<0?"Advance":"Balance"} Rs. ${Math.abs(t-pd).toFixed(2)}`),L)}
 /* signature and stamp */
 room(130);doc.moveDown(2);const sx=L+W-200;let sy=doc.y;const sg=img(c.sig);if(sg){try{doc.image(sg,sx+40,sy,{fit:[160,55],align:"right"});sy+=58}catch(e){}}
 doc.fillColor(c.stampcol==="Black"?"#111":"#1d3a8a").font("Helvetica-Bold").fontSize(10).text(T(drName(c)||"Doctor's signature"),sx,sy,{width:200,align:"right"}).font("Helvetica").fontSize(9);
 if(c.sigstyle==="full"){if(c.qual)doc.text(T(c.qual),sx,undefined,{width:200,align:"right"});if(c.reg)doc.text(T("Reg. No: "+c.reg),sx,undefined,{width:200,align:"right"})}
 String(c.stamp||"").split("\n").filter(Boolean).forEach(l=>doc.text(T(l),sx,undefined,{width:200,align:"right"}));
 if(c.stampmode==="box"){doc.moveDown(0.4);doc.rect(L+W-90,doc.y,90,90).dash(3,{space:3}).strokeColor("#999").stroke().undash()}
 /* footer on every page */
 const rg=doc.bufferedPageRange();for(let i=rg.start;i<rg.start+rg.count;i++){doc.switchToPage(i);const mb=doc.page.margins.bottom;doc.page.margins.bottom=0;doc.fillColor("#888").fontSize(7.5).text(T(`${c.name||"Clinic"} · Patient report ${p.id} · Page ${i-rg.start+1} of ${rg.count}`),L,doc.page.height-30,{width:W,align:"center",lineBreak:false});doc.page.margins.bottom=mb}
 }catch(e){return no(e)}doc.end()});

/* ---------- Excel workbook ---------- */
const xlsx=async D=>{const {c,FL,BX}=D,wb=new (XL().Workbook)();wb.creator="MyClinicDesk";wb.created=new Date();
 const P=Object.fromEntries(D.patients.map(p=>[p.id,p])),nm=id=>(P[id]||{}).name||"";
 const sheet=(name,cols,rows)=>{const s=wb.addWorksheet(name,{views:[{state:"frozen",ySplit:1}]});s.columns=cols.map(([header,key,width,fmt])=>({header,key,width:width||16,style:fmt?{numFmt:fmt}:{}}));rows.forEach(r=>s.addRow(r));
  s.getRow(1).font={bold:true,color:{argb:"FFFFFFFF"}};s.getRow(1).fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF1F3B5A"}};s.autoFilter={from:{row:1,column:1},to:{row:1,column:cols.length}};
  s.eachRow((row,i)=>{if(i>1)row.alignment={vertical:"top",wrapText:true}});return s};
 const extra=FL.filter(f=>!HEAD.includes(f.id));
 sheet("Patients",[["OP No","id",11],["Name","name",24],["Age","age",7],["Sex","sex",9],["Mobile","ph",14],["Registered on","date",14],["Next visit","fu",13],["Next visit time","fut",10],...extra.map(f=>[f.l,"f_"+f.id,f.y==="yesno"?10:22]),["Consent given on","consentAt",14]],
  D.patients.map(p=>({id:p.id,name:p.name,age:p.age,sex:p.sex,ph:p.ph,date:fd(p.date),fu:fd(p.fu),fut:p.fut||"",consentAt:fd(p.consentAt),...Object.fromEntries(extra.map(f=>["f_"+f.id,fv(p,f)]))})));
 const bv=Object.fromEntries(D.bills.filter(b=>b.vid).map(b=>[b.vid,b]));
 sheet("Visits",[["Date","date",12],["OP No","pid",11],["Patient","name",22],["Visit","type",12],...BX.map(b=>[b.l,"b_"+b.id,30]),["Billed (Rs)","bt",11,"#,##0.00"],["Paid (Rs)","bp",11,"#,##0.00"]],
  [...D.visits].sort((a,b)=>(a.date||"").localeCompare(b.date||"")).map(v=>({date:fd(v.date),pid:v.pid,name:nm(v.pid),type:v.mhChg==="First visit"?"First visit":"Follow-up",...Object.fromEntries(BX.map(b=>["b_"+b.id,bxv(v,b)])),bt:bv[v.id]?+bv[v.id].t||0:null,bp:bv[v.id]?paid(bv[v.id]):null})));
 sheet("Prescriptions",[["RX No","no",10],["Date","date",12],["OP No","pid",11],["Patient","name",22],["#","i",5],["Medicine","n",30],["Dose","d",10],["Frequency","f",11],["Duration","u",11],["Intake","in",14],["Diagnosis","dx",22],["Notes","a",30]],
  [...D.rx].sort((a,b)=>(a.date||"").localeCompare(b.date||"")).flatMap(r=>(r.meds&&r.meds.length?r.meds:[{}]).map((m,i)=>({no:r.no,date:fd(r.date),pid:r.pid,name:nm(r.pid),i:i+1,n:m.n||"",d:m.d||"",f:m.f||"",u:m.u||"",in:m.i||"",dx:i?"":r.dx||"",a:i?"":r.a||""}))));
 sheet("Bills",[["Invoice No","no",11],["Date","date",12],["OP No","pid",11],["Patient","name",22],["Items","items",40],["Total (Rs)","t",12,"#,##0.00"],["Paid (Rs)","p",12,"#,##0.00"],["Balance (Rs)","bal",12,"#,##0.00"],["Payment mode","m",14]],
  [...D.bills].sort((a,b)=>(a.date||"").localeCompare(b.date||"")).map(b=>({no:b.no,date:fd(b.date),pid:b.pid,name:nm(b.pid),items:(b.items||[]).map(x=>`${x.n}${+x.q>1?" ×"+x.q:""} @ ${x.r}`).join("; "),t:+b.t||0,p:paid(b),bal:(+b.t||0)-paid(b),m:[...new Set((b.pays||[]).map(x=>x.m).filter(Boolean))].join(", ")})));
 return Buffer.from(await wb.xlsx.writeBuffer())};

/* ---------- zip (deflate, UTF-8 names) ---------- */
const CRC=(()=>{const t=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c}return b=>{let c=-1;for(let i=0;i<b.length;i++)c=t[(c^b[i])&255]^(c>>>8);return (c^-1)>>>0}})();
const zip=files=>{const now=new Date(),dt=((now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1))&0xffff,dd=(((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate())&0xffff,loc=[],cen=[];let off=0;
 for(const f of files){const nmB=Buffer.from(f.name,"utf8"),raw=f.data,z=zlib.deflateRawSync(raw,{level:6}),crc=CRC(raw),h=Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(0x0800,6);h.writeUInt16LE(8,8);h.writeUInt16LE(dt,10);h.writeUInt16LE(dd,12);h.writeUInt32LE(crc,14);h.writeUInt32LE(z.length,18);h.writeUInt32LE(raw.length,22);h.writeUInt16LE(nmB.length,26);h.writeUInt16LE(0,28);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x0800,8);c.writeUInt16LE(8,10);c.writeUInt16LE(dt,12);c.writeUInt16LE(dd,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(z.length,20);c.writeUInt32LE(raw.length,24);c.writeUInt16LE(nmB.length,28);c.writeUInt32LE(off,42);
  loc.push(h,nmB,z);cen.push(c,nmB);off+=30+nmB.length+z.length}
 const cd=Buffer.concat(cen),e=Buffer.alloc(22);e.writeUInt32LE(0x06054b50,0);e.writeUInt16LE(files.length,8);e.writeUInt16LE(files.length,10);e.writeUInt32LE(cd.length,12);e.writeUInt32LE(off,16);return Buffer.concat([...loc,cd,e])};
const safe=s=>String(s||"").normalize("NFKD").replace(/[^\w\- ]+/g,"").trim().replace(/\s+/g,"_").slice(0,40);

/* build the whole archive for one clinic, entirely in memory: nothing is written to disk or to the database */
const build=async cid=>{const D=await load(cid),day=today(),files=[];
 for(const p of [...D.patients].sort((a,b)=>String(a.id).localeCompare(String(b.id),undefined,{numeric:true})))files.push({name:`Patient_Reports/${p.id}${safe(p.name)?"_"+safe(p.name):""}.pdf`,data:await pdfReport(D,p)});
 files.push({name:`Clinic_Records_${day}.xlsx`,data:await xlsx(D)});return {name:`${PREFIX}${day}.zip`,buf:zip(files),count:D.patients.length,parts:files.map(f=>f.data)}};
/* overwrite the PDFs, the Excel file and the zip in memory once the upload is over (success or failure) */
const wipe=pk=>{if(!pk)return;for(const b of pk.parts||[])b.fill(0);if(pk.buf)pk.buf.fill(0);pk.parts=null;pk.buf=null};

/* ---------- run a backup ---------- */
const RUNNING=new Set();
const run=async(cid,why)=>{if(RUNNING.has(cid))return;RUNNING.add(cid);
 try{const row=await one("SELECT * FROM gdrive WHERE cid=$1",[cid]);if(!row)return;
  let pk=null;try{if(!await allowed(cid))throw new Error("Google Drive backup needs an active trial or the paid plan.");
   const tok=await access(row),folder=await folderOf(tok,row);pk=await build(cid);const {name,buf,count}=pk,f=await upload(tok,folder,name,buf);wipe(pk);await tidy(tok,folder,f.id,name);
   await Q("UPDATE gdrive SET last_ok=now(),last_file=$2,last_err=NULL,last_try=now() WHERE cid=$1",[cid,name]);console.log(`Drive backup ok: clinic ${cid}, ${count} patients, ${(buf.length/1048576).toFixed(1)} MB (${why})`)}
  catch(e){const m=e instanceof TypeError&&/fetch/i.test(e.message)?"Could not reach Google Drive from the server. It will try again within the hour.":e.message;console.error(`Drive backup failed: clinic ${cid} (${why}):`,e.message);await Q("UPDATE gdrive SET last_err=$2,last_try=now() WHERE cid=$1",[cid,str(m,300)||"Backup failed"])}
  finally{wipe(pk)}}
 finally{RUNNING.delete(cid)}};

/* nightly: from 2 AM clinic time, each connected clinic without a backup today; a failed attempt is retried hourly.
   The UPDATE ... RETURNING claim stops two app instances from running the same clinic twice. */
const tick=async()=>{if(!READY||hourNow()<2)return;const day=today(),rows=(await Q("SELECT cid,last_ok,last_try FROM gdrive")).rows;
 for(const r of rows){if(r.last_ok&&today(new Date(r.last_ok))===day)continue;
  const c=await one("UPDATE gdrive SET last_try=now() WHERE cid=$1 AND (last_try IS NULL OR last_try<now()-interval '1 hour') RETURNING cid",[r.cid]);if(c)await run(r.cid,"nightly")}};

/* ---------- settings API ---------- */
function apiRoutes(app,need){
 app.get("/api/gdrive",need("doctor"),A(async(q,s)=>{const r=await one("SELECT email,connected,last_ok,last_file,last_try,last_err FROM gdrive WHERE cid=$1",[q.u.cid]);
  s.json({ready:READY,allowed:await allowed(q.u.cid),connected:!!r,...(r||{}),running:RUNNING.has(q.u.cid),keep:KEEP})}));
 app.post("/api/gdrive/backup",need("doctor"),A(async(q,s)=>{if(!READY)return s.status(400).json({error:"Google Drive backup is not set up on this server."});
  if(!await one("SELECT 1 FROM gdrive WHERE cid=$1",[q.u.cid]))return s.status(400).json({error:"Connect Google Drive first."});
  if(!await allowed(q.u.cid))return s.status(402).json({error:"Google Drive backup needs an active trial or the paid plan."});
  if(RUNNING.has(q.u.cid))return s.json({started:false,running:true});await audit(q.u,"gdrive_backup_now");run(q.u.cid,"manual");s.json({started:true,running:true})}));
 app.post("/api/gdrive/disconnect",need("doctor"),A(async(q,s)=>{const r=await one("DELETE FROM gdrive WHERE cid=$1 RETURNING rtok,email",[q.u.cid]);if(r){revoke(r.rtok);await audit(q.u,"gdrive_disconnect",r.email)}s.json({ok:true})}));
}
const start=()=>{if(!READY)return;setInterval(()=>tick().catch(e=>console.error("Drive backup scheduler:",e.message)),6e5).unref();setTimeout(()=>tick().catch(()=>{}),6e4).unref()};
return {init,authRoutes,apiRoutes,start,_test:{wipe,run,RUNNING,build,pdfReport,xlsx,zip,load,enc,dec,tick,hourNow}};
};
