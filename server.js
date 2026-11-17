const express=require("express"),{Pool}=require("pg"),crypto=require("crypto"),path=require("path"),fs=require("fs"),scrypt=require("util").promisify(crypto.scrypt);
const PORT=process.env.PORT||3000,SECURE=process.env.INSECURE_COOKIES!=="1",TZ=process.env.CLINIC_TZ||"Asia/Kolkata";
if(!process.env.DATABASE_URL){console.error("DATABASE_URL is not set, e.g. postgres://user:password@host:5432/opd");process.exit(1)}
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==="1"?{rejectUnauthorized:process.env.PGSSL_STRICT==="1"}:undefined,max:10});
pool.on("error",e=>console.error("Postgres pool error:",e.message));
const Q=(t,p)=>pool.query(t,p),one=async(t,p)=>(await Q(t,p)).rows[0];
const tx=async f=>{const c=await pool.connect();try{await c.query("BEGIN");const r=await f(c);await c.query("COMMIT");return r}catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}};
const init=async()=>{await Q(`CREATE TABLE IF NOT EXISTS clinics(id SERIAL PRIMARY KEY,slug TEXT UNIQUE NOT NULL,created TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,hash TEXT NOT NULL,created TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sessions(th TEXT PRIMARY KEY,uid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,exp BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS docs(coll TEXT NOT NULL,id TEXT NOT NULL,n BIGSERIAL,data JSONB NOT NULL,upd TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(coll,id));
CREATE TABLE IF NOT EXISTS regs(id SERIAL PRIMARY KEY,data JSONB NOT NULL,created TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY,v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id BIGSERIAL PRIMARY KEY,uid INTEGER,act TEXT,ref TEXT,at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS resets(th TEXT PRIMARY KEY,uid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,exp BIGINT NOT NULL);
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_end TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'trial';
ALTER TABLE users ADD COLUMN IF NOT EXISTS cid INTEGER REFERENCES clinics(id) ON DELETE CASCADE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gsub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS users_gsub ON users(gsub);
ALTER TABLE docs ADD COLUMN IF NOT EXISTS cid INTEGER;
ALTER TABLE regs ADD COLUMN IF NOT EXISTS cid INTEGER;
ALTER TABLE audit ADD COLUMN IF NOT EXISTS cid INTEGER;
UPDATE users SET trial_end=now()+interval '14 days' WHERE trial_end IS NULL AND role='doctor'`);
 /* patient reports (PDF or photo) and the WhatsApp upload links */
 await Q(`CREATE TABLE IF NOT EXISTS reports(id BIGSERIAL PRIMARY KEY,cid INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,pid TEXT NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,data BYTEA NOT NULL,src TEXT NOT NULL DEFAULT 'clinic',uid INTEGER,created TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS reports_cid_pid ON reports(cid,pid);
CREATE TABLE IF NOT EXISTS report_links(th TEXT PRIMARY KEY,cid INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,pid TEXT NOT NULL,kind TEXT NOT NULL,exp TIMESTAMPTZ NOT NULL,created TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS shared_docs(th TEXT PRIMARY KEY,cid INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,pid TEXT NOT NULL,kind TEXT NOT NULL,ref TEXT,name TEXT NOT NULL,data BYTEA NOT NULL,exp TIMESTAMPTZ NOT NULL,created TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS shared_docs_exp ON shared_docs(exp)`);
 /* one-time move from the single-clinic layout: everything that exists becomes clinic 1 */
 await tx(async c=>{await c.query("SELECT pg_advisory_xact_lock(7002)");if((await c.query("SELECT 1 FROM kv WHERE k='schema' AND v='2'")).rowCount)return;
  if((await c.query("SELECT 1 FROM users WHERE cid IS NULL UNION ALL SELECT 1 FROM docs WHERE cid IS NULL UNION ALL SELECT 1 FROM regs WHERE cid IS NULL LIMIT 1")).rowCount){
   await c.query("INSERT INTO clinics(id,slug) VALUES(1,$1) ON CONFLICT(id) DO NOTHING",[newSlug()]);await c.query("SELECT setval('clinics_id_seq',GREATEST((SELECT MAX(id) FROM clinics),1))");
   for(const t of ["users","docs","regs","audit"])await c.query(`UPDATE ${t} SET cid=1 WHERE cid IS NULL`);
   await c.query("UPDATE kv SET k='c1:'||k WHERE k='clinic' OR k LIKE 'seq:%'")}
  await c.query("ALTER TABLE docs ALTER COLUMN cid SET NOT NULL");await c.query("ALTER TABLE docs DROP CONSTRAINT IF EXISTS docs_pkey");await c.query("ALTER TABLE docs ADD PRIMARY KEY(cid,coll,id)");
  await c.query("ALTER TABLE regs ALTER COLUMN cid SET NOT NULL");await c.query("ALTER TABLE users ALTER COLUMN cid SET NOT NULL");
  await c.query("INSERT INTO kv(k,v) VALUES('schema','2') ON CONFLICT(k) DO UPDATE SET v='2'")});
 /* clinic profile columns and the first-time setup flag */
 await Q(`ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS is_setup_complete BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS setup_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS name TEXT, ADD COLUMN IF NOT EXISTS tagline TEXT, ADD COLUMN IF NOT EXISTS logo TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT, ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS addr_street TEXT, ADD COLUMN IF NOT EXISTS addr_area TEXT, ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT, ADD COLUMN IF NOT EXISTS pincode TEXT,
  ADD COLUMN IF NOT EXISTS doctor_name TEXT, ADD COLUMN IF NOT EXISTS qualifications TEXT,
  ADD COLUMN IF NOT EXISTS specialization TEXT, ADD COLUMN IF NOT EXISTS reg_number TEXT,
  ADD COLUMN IF NOT EXISTS consult_fee NUMERIC(10,2), ADD COLUMN IF NOT EXISTS timings TEXT,
  ADD COLUMN IF NOT EXISTS gstin TEXT, ADD COLUMN IF NOT EXISTS footer_note TEXT,
  ADD COLUMN IF NOT EXISTS profile_updated TIMESTAMPTZ`);
 /* one-time: copy each clinic's profile out of the kv JSON into the columns. Clinics that already exist count as set up. */
 await tx(async c=>{await c.query("SELECT pg_advisory_xact_lock(7003)");if((await c.query("SELECT 1 FROM kv WHERE k='profile_cols'")).rowCount)return;
  for(const {id} of (await c.query("SELECT id FROM clinics ORDER BY id")).rows){const k="c"+id+":clinic",r=(await c.query("SELECT v FROM kv WHERE k=$1",[k])).rows[0];let o={};try{o=r?JSON.parse(r.v):{}}catch(e){}
   const v=PROF.map(([f])=>{const x=typeof o[f]==="number"?String(o[f]):o[f];return f==="fee"?(/^\d{1,8}(\.\d{1,2})?$/.test(str(x,20))?str(x,20):null):f==="logo"?(typeof x==="string"&&IMG.test(x)?x:null):(str(x,600)||null)});
   await c.query(`UPDATE clinics SET ${PROF.map(([,col],i)=>col+"=$"+(i+2)).join(",")},is_setup_complete=true,setup_completed_at=now(),profile_updated=now() WHERE id=$1`,[id,...v]);
   if(r){PROF.forEach(([f])=>delete o[f]);await c.query("UPDATE kv SET v=$2 WHERE k=$1",[k,JSON.stringify(o)])}}
  await c.query("INSERT INTO kv(k,v) VALUES('profile_cols','1')")})};
const newSlug=()=>crypto.randomBytes(6).toString("hex");
const TRIAL_DAYS=Math.max(1,Math.min(365,+process.env.TRIAL_DAYS||14));
const today=()=>new Date().toLocaleDateString("en-CA",{timeZone:TZ}),sha=s=>crypto.createHash("sha256").update(s).digest("hex");
const hashPw=async p=>{const s=crypto.randomBytes(16);return s.toString("hex")+":"+(await scrypt(p,s,64)).toString("hex")};
const okPw=async(p,h)=>{const [s,x]=h.split(":"),y=await scrypt(p,Buffer.from(s,"hex"),64);return crypto.timingSafeEqual(y,Buffer.from(x,"hex"))};
let DUMMY;
const audit=(u,act,ref)=>Q("INSERT INTO audit(uid,cid,act,ref) VALUES($1,$2,$3,$4)",[u&&u.id||null,u&&u.cid||null,act,ref||""]).catch(e=>console.error("audit failed:",e.message));
const hits=new Map(),limited=(k,max,ms)=>{const t=Date.now(),a=(hits.get(k)||[]).filter(x=>t-x<ms);a.push(t);hits.set(k,a);return a.length>max};
setInterval(()=>{const t=Date.now();for(const [k,a] of hits)if(!a.some(x=>t-x<36e5))hits.delete(k);Q("DELETE FROM sessions WHERE exp<$1",[t]).catch(()=>{});Q("DELETE FROM resets WHERE exp<$1",[t]).catch(()=>{})},6e5).unref();
const SH=require("./public/shared.js"),DEF_FORM=SH.DEF_FORM;
const PFX={patients:"OP-",appts:"A-",rx:"RX-",bills:"INV-",visits:"V-"},CLIN=["dx","rx","notes","extra"];
const pref=async(cid,c)=>{if(c!=="patients"&&c!=="bills")return PFX[c];const o=await clinic(cid),p=o[c==="patients"?"opPrefix":"invPrefix"];return /^[A-Za-z0-9-]{1,8}$/.test(p||"")?p:PFX[c]};
const nextId=async(cid,c,x=Q)=>(await pref(cid,c))+String((await x("INSERT INTO kv(k,v) VALUES($1,'1') ON CONFLICT(k) DO UPDATE SET v=(kv.v::int+1)::text RETURNING v",["c"+cid+":seq:"+c])).rows[0].v).padStart(4,"0");
const all=async(cid,c)=>(await Q("SELECT data FROM docs WHERE cid=$1 AND coll=$2 ORDER BY n",[cid,c])).rows.map(r=>r.data);
/* The clinic profile lives in columns on `clinics`; every other setting (theme, stamp, forms, lists) stays in the kv JSON.
   clinic() returns both merged, using the same keys the browser has always used. */
const PROF=[["name","name"],["tag","tagline"],["logo","logo"],["phone","phone"],["email","email"],["addr","addr_street"],["area","addr_area"],["city","city"],["state","state"],["pin","pincode"],
 ["doctor","doctor_name"],["qual","qualifications"],["spec","specialization"],["reg","reg_number"],["fee","consult_fee"],["time","timings"],["gstin","gstin"],["billnote","footer_note"]];
const IMG=/^data:image\/(png|jpeg);base64,[A-Za-z0-9+\/=]+$/;
const clinic=async cid=>{const [r,p]=await Promise.all([one("SELECT v FROM kv WHERE k=$1",["c"+cid+":clinic"]),one("SELECT * FROM clinics WHERE id=$1",[cid])]);const o=r?JSON.parse(r.v):{};
 if(p)for(const [f,col] of PROF)o[f]=p[col]==null?"":f==="fee"?String(+p[col]):p[col];return o};
/* public pages find their clinic by slug; the old slug-less /register keeps working for clinic 1 */
const bySlug=async sl=>{if(!sl){const r=await one("SELECT id FROM clinics WHERE id=1");return r&&r.id}if(!/^[a-f0-9]{12}$/.test(sl))return null;const r=await one("SELECT id FROM clinics WHERE slug=$1",[sl]);return r&&r.id};
const str=(v,n)=>typeof v==="string"?v.replace(/\u0000/g,"").trim().slice(0,n):"";
const E=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const A=f=>(q,s,n)=>Promise.resolve(f(q,s,n)).catch(n),uid=v=>/^\d{1,9}$/.test(v)?+v:null;
const REG=fs.readFileSync(path.join(__dirname,"public/register.html"),"utf8");

const app=express();app.disable("x-powered-by");app.set("trust proxy",process.env.TRUST_PROXY==="1"?1:false);
app.use((q,s,n)=>{s.set({"Content-Security-Policy":"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","X-Frame-Options":"DENY"});if(q.path.startsWith("/api"))s.set("Cache-Control","no-store");n()});
app.use(["/api/clinic","/api/import"],express.json({limit:"9mb"}));
app.use("/api/public/register",express.json({limit:"400kb"}));
app.use(["/api/reports","/api/public/report-link"],express.json({limit:"6mb"}));
app.use("/api/shared",express.json({limit:"7mb"}));
app.use(express.json({limit:"200kb"}));
const APP=path.join(__dirname,"public/app.html");
/* signed-in users whose clinic is not set up always land on /setup-clinic, and only they can open it */
app.get(["/","/setup-clinic"],A(async(q,s)=>{const u=await who(q),onSetup=q.path==="/setup-clinic";
 if(u&&!u.setup&&!onSetup)return s.redirect("/setup-clinic");if(onSetup&&(!u||u.setup))return s.redirect("/");
 s.set("Cache-Control","no-store").sendFile(APP)}));
app.get(["/signup","/forgot","/reset"],(q,s)=>s.set("Cache-Control","no-store").sendFile(APP));
app.get("/medpacks.js",(q,s)=>s.sendFile(path.join(__dirname,"public/medpacks.js")));
app.get("/pricepacks.js",(q,s)=>s.sendFile(path.join(__dirname,"public/pricepacks.js")));
app.get("/shared.js",(q,s)=>s.sendFile(path.join(__dirname,"public/shared.js")));
app.get("/vendor/jspdf.js",(q,s)=>s.set("Cache-Control","public, max-age=604800").sendFile(require.resolve("jspdf/dist/jspdf.umd.min.js")));
app.get("/vendor/html2canvas.js",(q,s)=>s.set("Cache-Control","public, max-age=604800").sendFile(require.resolve("html2canvas/dist/html2canvas.min.js")));
app.get("/qrcode.js",(q,s)=>s.sendFile(require.resolve("qrcode-generator/qrcode.js")));
app.get(["/register","/register/:slug"],A(async(q,s)=>{const sl=q.params.slug||"",cid=await bySlug(sl);if(!cid)return s.status(404).type("text").send("This registration link is not valid. Please ask the clinic for a new one.");
 const c=await clinic(cid),nm=E(c.name||"Clinic");
 s.type("html").send(REG.replaceAll("{{SLUG}}",()=>sl).replaceAll("{{CLINIC}}",()=>nm).replace("{{HEADER}}",()=>regHead(c)))}));
const regHead=c=>{const ad=[c.addr,c.area,c.city,[c.state,c.pin].filter(Boolean).join(" - ")].filter(Boolean).join(", ");
 return (c.logo&&IMG.test(c.logo)?`<img src="${c.logo}" alt="">`:"")+`<h1>${E(c.name||"Clinic")}</h1>`+(c.tag?`<div class="tg">${E(c.tag)}</div>`:"")+
  (ad||c.phone?`<div class="ad">${E(ad)}${c.phone?(ad?"<br>":"")+"Phone: "+E(c.phone):""}</div>`:"")};

/* public: patient self-registration (inbox only, never writes patients directly) */
app.get("/api/public/form",A(async(q,s)=>{const cid=await bySlug(str(q.query.c,20));if(!cid)return s.status(404).json({error:"Unknown clinic"});const c=await clinic(cid);s.json({name:c.name||"Clinic",lang:c.lang||"",form:c.regForm||DEF_FORM})}));
app.post("/api/public/register",A(async(q,s)=>{
 if(limited("reg:"+q.ip,8,36e5))return s.status(429).json({error:"Too many submissions. Please try again later."});
 const b=q.body||{};if(b.website)return s.json({ok:true});
 const cid=await bySlug(str(q.query.c,20));if(!cid)return s.status(404).json({error:"Unknown clinic"});
 const form=(await clinic(cid)).regForm||DEF_FORM,d={},cu={},bad=m=>s.status(400).json({error:m});
 for(const sec of form.sections)for(const f of sec.f){const v=str(typeof b[f.id]==="number"?String(b[f.id]):b[f.id],f.y==="textarea"?500:150);
  if(!v){if(f.r)return bad("Please fill in: "+f.l);continue}
  if(f.id==="age"?!/^\d{1,3}$/.test(v)||+v>120:f.y==="number"?!/^\d{1,6}(\.\d{1,2})?$/.test(v):f.id==="ph"?!/^[6-9]\d{9}$/.test(v):f.y==="phone"?!/^\d{10}$/.test(v):f.y==="date"?!/^\d{4}-\d{2}-\d{2}$/.test(v):f.y==="select"?!(f.o||[]).includes(v):f.y==="yesno"?!["Yes","No"].includes(v):false)return bad("Please check: "+f.l);
  if(CORE.includes(f.id))d[f.id]=v;else cu[f.id]=v}
 if(b.consent!==true)return bad("Please tick the box to agree to the consent.");
 if(Object.keys(cu).length)d.custom=cu;
 if(form.sig){if(typeof b.sig!=="string"||!/^data:image\/png;base64,[A-Za-z0-9+\/=]{20,150000}$/.test(b.sig))return bad("Please sign in the box.");d.sig=b.sig}
 if((await one("SELECT COUNT(*)::int c FROM regs WHERE cid=$1",[cid])).c>=300)return s.status(503).json({error:"The clinic cannot accept more online registrations right now. Please register at the desk."});
 d.consent=true;d.consentAt=today();await Q("INSERT INTO regs(cid,data) VALUES($1,$2)",[cid,JSON.stringify(d)]);s.json({ok:true})}));

/* reports: a PDF or a photo, at most 4 MB, checked by its first bytes rather than by what the browser claims */
const RKINDS=["Lab report","Scan / X-ray","ECG","Discharge summary","Previous prescription","Other"],RMAX=4*1024*1024,RLINK_MAX=10;
const rFile=b=>{const m=/^data:[^;,]{0,60};base64,([A-Za-z0-9+/=]+)$/.exec(typeof b.data==="string"?b.data:"");if(!m)return {err:"Choose a PDF or a photo to upload."};
 const buf=Buffer.from(m[1],"base64");if(!buf.length)return {err:"The file is empty."};if(buf.length>RMAX)return {err:"The file is larger than 4 MB."};
 const h=buf.subarray(0,12),mime=h.subarray(0,4).toString("latin1")==="%PDF"?"application/pdf":h[0]===0xff&&h[1]===0xd8&&h[2]===0xff?"image/jpeg":h.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))?"image/png":h.subarray(0,4).toString("latin1")==="RIFF"&&h.subarray(8,12).toString("latin1")==="WEBP"?"image/webp":"";
 if(!mime)return {err:"Only PDF, JPG, PNG or WEBP files can be uploaded."};
 const ext={"application/pdf":"pdf","image/jpeg":"jpg","image/png":"png","image/webp":"webp"}[mime];let name=str(b.name,120).replace(/[\\/:*?"<>|\u0000-\u001f]/g,"_")||"report";if(!name.toLowerCase().endsWith("."+ext))name=name.replace(/\.[a-z0-9]{1,5}$/i,"")+"."+ext;
 return {buf,mime,name}};
const rKind=k=>RKINDS.includes(k)?k:"Other";
const rLink=async t=>{if(!/^[a-f0-9]{48}$/.test(t||""))return null;return one("SELECT l.*,(SELECT COUNT(*)::int FROM reports r WHERE r.cid=l.cid AND r.pid=l.pid AND r.src='patient' AND r.created>=l.created) used FROM report_links l WHERE l.th=$1 AND l.exp>now()",[sha(t)])};
const UPL=fs.readFileSync(path.join(__dirname,"public/upload.html"),"utf8");
app.get("/u/:t",A(async(q,s)=>{s.set({"Cache-Control":"no-store","Referrer-Policy":"no-referrer"});const l=await rLink(q.params.t);
 if(!l)return s.status(404).type("text").send("This upload link has expired or is not valid. Please ask the clinic to send a new one.");
 const c=await clinic(l.cid);s.type("html").send(UPL.replace("{{HEADER}}",()=>regHead(c)).replaceAll("{{CLINIC}}",()=>E(c.name||"Clinic")))}));
app.get("/api/public/report-link/:t",A(async(q,s)=>{const l=await rLink(q.params.t);if(!l)return s.status(404).json({error:"This upload link has expired or is not valid."});
 const p=await one("SELECT data->>'name' n FROM docs WHERE cid=$1 AND coll='patients' AND id=$2",[l.cid,l.pid]);if(!p)return s.status(404).json({error:"This upload link is no longer valid."});
 s.set("Cache-Control","no-store").json({first:String(p.n||"").trim().split(/\s+/)[0],kind:l.kind,kinds:RKINDS,left:Math.max(0,RLINK_MAX-l.used),exp:l.exp})}));
app.post("/api/public/report-link/:t",A(async(q,s)=>{if(limited("rup:"+q.ip,30,36e5))return s.status(429).json({error:"Too many uploads. Please try again later."});
 const l=await rLink(q.params.t);if(!l)return s.status(404).json({error:"This upload link has expired or is not valid."});if(l.used>=RLINK_MAX)return s.status(429).json({error:`This link has already been used for ${RLINK_MAX} files. Please ask the clinic for a new link.`});
 if(!await one("SELECT 1 FROM docs WHERE cid=$1 AND coll='patients' AND id=$2",[l.cid,l.pid]))return s.status(404).json({error:"This upload link is no longer valid."});
 const f=rFile(q.body||{});if(f.err)return s.status(400).json({error:f.err});
 await Q("INSERT INTO reports(cid,pid,kind,name,mime,size,data,src) VALUES($1,$2,$3,$4,$5,$6,$7,'patient')",[l.cid,l.pid,rKind((q.body||{}).kind||l.kind),f.name,f.mime,f.buf.length,f.buf]);s.json({ok:true,left:Math.max(0,RLINK_MAX-l.used-1)})}));

/* PDFs sent on WhatsApp as a link: anyone with the link can open it for 3 days, then it is deleted */
const SKINDS=["Prescription","Invoice","Certificate","Patient report"],SMAX=5*1024*1024,SDAYS=3;
app.get("/d/:t",A(async(q,s)=>{s.set({"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Robots-Tag":"noindex"});
 if(limited("dl:"+q.ip,120,36e5))return s.status(429).type("text").send("Too many requests. Please try again later.");
 const t=q.params.t,r=/^[a-f0-9]{48}$/.test(t)?await one("SELECT name,data FROM shared_docs WHERE th=$1 AND exp>now()",[sha(t)]):null;
 if(!r)return s.status(404).type("text").send("This link has expired or is not valid. Please ask the clinic to send the document again.");
 s.removeHeader("Content-Security-Policy");s.set({"Content-Type":"application/pdf","Content-Disposition":`inline; filename="${r.name.replace(/[^\x20-\x7e]/g,"_").replace(/"/g,"")}"`,"X-Content-Type-Options":"nosniff"}).send(r.data)}));

/* auth */
const sameStr=(a,b)=>crypto.timingSafeEqual(crypto.createHash("sha256").update(String(a)).digest(),crypto.createHash("sha256").update(String(b)).digest());
const APP_URL=(process.env.APP_URL||"").replace(/\/+$/,""),GID=process.env.GOOGLE_CLIENT_ID||"",GSECRET=process.env.GOOGLE_CLIENT_SECRET||"";
const RESEND=process.env.RESEND_API_KEY||"",MAIL_FROM=process.env.MAIL_FROM||"",APP_NAME=process.env.APP_NAME||"Clinic Desk";
if(!APP_URL)console.warn("APP_URL is not set: Google sign-in and reset links will use the request's host.");
if(!GID||!GSECRET)console.warn("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not set: 'Continue with Google' is hidden.");
if(!RESEND||!MAIL_FROM)console.warn("RESEND_API_KEY/MAIL_FROM not set: password reset emails cannot be sent.");
const base=q=>APP_URL||(q.protocol+"://"+q.get("host"));
const EMAIL=/^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,24}$/i,mail=v=>{const e=str(v,254).toLowerCase();return EMAIL.test(e)?e:""};
const cookie=q=>{const m=/(?:^|;\s*)sid=([a-f0-9]{64})/.exec(q.headers.cookie||"");return m&&m[1]};
const login=async(s,id)=>{const t=crypto.randomBytes(32).toString("hex");await Q("INSERT INTO sessions(th,uid,exp) VALUES($1,$2,$3)",[sha(t),id,Date.now()+432e5]);s.append("Set-Cookie",`sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${SECURE?"; Secure":""}`)};
const who=async q=>{const t=cookie(q);if(!t)return null;return(await one("SELECT u.id,u.username,u.name,u.role,u.email,u.cid,c.slug,c.is_setup_complete AS setup FROM sessions s JOIN users u ON u.id=s.uid JOIN clinics c ON c.id=u.cid WHERE s.th=$1 AND s.exp>$2",[sha(t),Date.now()]))||null};
/* a new sign-up always gets its own clinic, so its records are invisible to every other clinic */
/* is_setup_complete defaults to false, so the new doctor is sent to /setup-clinic; the clinic name and email are pre-filled there */
const newClinic=async(c,{email,name,hash,gsub,clinicName})=>{const cid=(await c.query("INSERT INTO clinics(slug,name,email) VALUES($1,$2,$3) RETURNING id",[newSlug(),clinicName||null,email])).rows[0].id;
 return(await c.query("INSERT INTO users(username,name,role,hash,email,gsub,cid,trial_end) VALUES($1,$2,'doctor',$3,$1,$4,$5,now()+make_interval(days=>$6)) RETURNING id,cid",[email,name,hash,gsub||null,cid,TRIAL_DAYS])).rows[0]};
app.get("/api/status",A(async(q,s)=>s.json({me:await who(q),google:!!(GID&&GSECRET),reset:!!(RESEND&&MAIL_FROM)})));
app.use("/api",(q,s,n)=>{if(q.method!=="GET"&&q.headers["x-requested-with"]!=="opd"&&!q.path.startsWith("/public"))return s.status(403).json({error:"Forbidden"});n()});
app.post("/api/signup",A(async(q,s)=>{const b=q.body||{},em=mail(b.email),nm=str(b.name,80),cn=str(b.clinic,120),pw=typeof b.password==="string"?b.password:"";
 if(limited("su:"+q.ip,10,36e5))return s.status(429).json({error:"Too many sign-ups from here. Please try again later."});
 if(!nm)return s.status(400).json({error:"Please enter your name."});if(!em)return s.status(400).json({error:"Please enter a valid email address."});
 if(pw.length<8||pw.length>200)return s.status(400).json({error:"Choose a password of 8 or more characters."});
 try{const u=await tx(async c=>newClinic(c,{email:em,name:nm,hash:await hashPw(pw),clinicName:cn}));await login(s,u.id);await audit(u,"signup",em);s.json({ok:true})}
 catch(e){if(e.code==="23505")return s.status(409).json({error:"An account with this email already exists. Please sign in instead."});throw e}}));
app.post("/api/login",A(async(q,s)=>{const b=q.body||{},un=str(b.username,254).toLowerCase();
 if(limited("ip:"+q.ip,20,9e5)||limited("u:"+un,10,9e5))return s.status(429).json({error:"Too many attempts. Try again in 15 minutes."});
 const u=un&&await one("SELECT * FROM users WHERE username=$1 OR email=$1 ORDER BY (email=$1) DESC LIMIT 1",[un]),pw=typeof b.password==="string"?b.password:"",has=!!u&&u.hash.includes(":");
 const ok=await okPw(pw,has?u.hash:DUMMY)&&has&&pw!=="";
 if(!ok){await audit(null,"login_failed",un);return s.status(401).json({error:u&&!has?"This account uses Google. Click 'Continue with Google', or reset your password to add one.":"Wrong email or password"})}
 await login(s,u.id);await audit(u,"login");s.json({ok:true})}));
app.post("/api/logout",A(async(q,s)=>{const t=cookie(q);if(t)await Q("DELETE FROM sessions WHERE th=$1",[sha(t)]);s.append("Set-Cookie","sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");s.json({ok:true})}));

/* forgot / reset password: a single-use link, valid for 1 hour, emailed through Resend */
const sendMail=async(to,subject,text,html)=>{const r=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:"Bearer "+RESEND,"Content-Type":"application/json"},body:JSON.stringify({from:MAIL_FROM,to:[to],subject,text,html})});
 if(!r.ok)throw new Error("Resend "+r.status+": "+(await r.text()).slice(0,300))};
app.post("/api/forgot",A(async(q,s)=>{const em=mail(q.body&&q.body.email);
 if(!RESEND||!MAIL_FROM)return s.status(503).json({error:"Password reset by email is not set up yet. Please contact support."});
 if(!em)return s.status(400).json({error:"Please enter a valid email address."});
 if(limited("fg:"+q.ip,10,9e5))return s.status(429).json({error:"Too many requests. Try again in 15 minutes."});
 const u=!limited("fge:"+em,3,36e5)&&await one("SELECT id,cid,name,email FROM users WHERE email=$1",[em]);
 if(u){const t=crypto.randomBytes(32).toString("hex"),link=base(q)+"/reset?token="+t;
  await Q("DELETE FROM resets WHERE uid=$1",[u.id]);await Q("INSERT INTO resets(th,uid,exp) VALUES($1,$2,$3)",[sha(t),u.id,Date.now()+36e5]);
  const hi="Hi "+(u.name||"there")+",",msg="We received a request to reset the password for your "+APP_NAME+" account.",end="This link works once and expires in 1 hour. If you didn't ask for this, you can ignore this email; your password won't change.";
  sendMail(u.email,"Reset your "+APP_NAME+" password",`${hi}\n\n${msg}\n\nReset your password: ${link}\n\n${end}`,
   `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#14231c;max-width:480px"><p>${E(hi)}</p><p>${E(msg)}</p><p><a href="${E(link)}" style="display:inline-block;background:#1a5c3f;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold">Reset password</a></p><p style="font-size:13px;color:#6c7b73">Or paste this link into your browser:<br>${E(link)}</p><p style="font-size:13px;color:#6c7b73">${E(end)}</p></div>`)
   .then(()=>audit(u,"reset_sent",em)).catch(e=>console.error("Reset email failed:",e.message))}
 s.json({ok:true})}));
app.post("/api/reset",A(async(q,s)=>{const b=q.body||{},t=typeof b.token==="string"&&/^[a-f0-9]{64}$/.test(b.token)?b.token:"",pw=typeof b.password==="string"?b.password:"";
 if(limited("rs:"+q.ip,20,9e5))return s.status(429).json({error:"Too many attempts. Try again in 15 minutes."});
 if(pw.length<8||pw.length>200)return s.status(400).json({error:"Choose a password of 8 or more characters."});
 const r=t&&await one("DELETE FROM resets WHERE th=$1 RETURNING uid,exp",[sha(t)]);
 if(!r||r.exp<Date.now())return s.status(400).json({error:"This reset link is invalid or has expired. Please request a new one."});
 await Q("UPDATE users SET hash=$1 WHERE id=$2",[await hashPw(pw),r.uid]);await Q("DELETE FROM sessions WHERE uid=$1",[r.uid]);await Q("DELETE FROM resets WHERE uid=$1",[r.uid]);
 const u=await one("SELECT id,cid FROM users WHERE id=$1",[r.uid]);await login(s,u.id);await audit(u,"password_reset");s.json({ok:true})}));

/* Google sign-in / sign-up (OpenID Connect, authorization-code flow) */
const gRedirect=q=>base(q)+"/auth/google/callback";
app.get("/auth/google",(q,s)=>{if(!GID||!GSECRET)return s.status(404).send("Google sign-in is not set up");const st=crypto.randomBytes(24).toString("hex");
 s.append("Set-Cookie",`gst=${st}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600${SECURE?"; Secure":""}`);
 s.redirect("https://accounts.google.com/o/oauth2/v2/auth?"+new URLSearchParams({client_id:GID,redirect_uri:gRedirect(q),response_type:"code",scope:"openid email profile",state:st,prompt:"select_account"}))});
app.get("/auth/google/callback",A(async(q,s)=>{const fail=m=>{console.error("Google sign-in failed:",m);s.redirect("/?auth=google_failed")};
 s.append("Set-Cookie",`gst=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0${SECURE?"; Secure":""}`);
 if(!GID||!GSECRET)return s.status(404).send("Google sign-in is not set up");
 const m=/(?:^|;\s*)gst=([a-f0-9]{48})/.exec(q.headers.cookie||""),st=typeof q.query.state==="string"?q.query.state:"",code=typeof q.query.code==="string"?q.query.code:"";
 if(!m||!sameStr(m[1],st))return fail("state mismatch");if(!code)return s.redirect("/");
 if(limited("g:"+q.ip,30,9e5))return fail("rate limited");
 const tr=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({code,client_id:GID,client_secret:GSECRET,redirect_uri:gRedirect(q),grant_type:"authorization_code"})});
 const tk=await tr.json().catch(()=>({}));if(!tr.ok||!tk.access_token)return fail("token "+tr.status);
 const ir=await fetch("https://openidconnect.googleapis.com/v1/userinfo",{headers:{Authorization:"Bearer "+tk.access_token}}),g=await ir.json().catch(()=>({}));
 const em=mail(g.email),sub=str(g.sub,64);if(!ir.ok||!sub||!em||g.email_verified!==true)return fail("userinfo");
 let u=await one("SELECT id,cid FROM users WHERE gsub=$1",[sub]);
 if(!u){u=await one("UPDATE users SET gsub=$1 WHERE email=$2 AND gsub IS NULL RETURNING id,cid",[sub,em]);if(u)await audit(u,"google_linked",em)}
 if(!u){try{u=await tx(async c=>newClinic(c,{email:em,name:str(g.name,80)||em.split("@")[0],hash:"",gsub:sub}));await audit(u,"signup_google",em)}
  catch(e){if(e.code==="23505")return s.redirect("/?auth=google_taken");throw e}}
 await login(s,u.id);await audit(u,"login_google");s.redirect("/")}));

/* founder / super admin (separate from doctor logins; needs ADMIN_PASSWORD) */
const ADMIN_PW=process.env.ADMIN_PASSWORD||"",AKEY=crypto.createHash("sha256").update("opd-admin:"+ADMIN_PW).digest();
const admTok=()=>{const e=Date.now()+288e5;return e+"."+crypto.createHmac("sha256",AKEY).update(String(e)).digest("hex")};
const admOk=q=>{const m=/(?:^|;\s*)adm=(\d{10,14})\.([a-f0-9]{64})/.exec(q.headers.cookie||"");if(!ADMIN_PW||!m||+m[1]<Date.now())return false;return sameStr(crypto.createHmac("sha256",AKEY).update(m[1]).digest("hex"),m[2])};
if(!ADMIN_PW)console.warn("ADMIN_PASSWORD is not set: the /admin dashboard is disabled.");
else if(ADMIN_PW.length<12)console.warn("ADMIN_PASSWORD is short; use 12+ characters.");
app.get("/admin",(q,s)=>{if(!ADMIN_PW)return s.status(404).send("Not found");s.set("Cache-Control","no-store").sendFile(path.join(__dirname,"public/admin.html"))});
app.post("/api/admin/login",A(async(q,s)=>{if(!ADMIN_PW)return s.status(404).json({error:"Not found"});
 if(limited("adm:"+q.ip,8,9e5))return s.status(429).json({error:"Too many attempts. Try again in 15 minutes."});
 const p=q.body&&q.body.password;if(typeof p!=="string"||!sameStr(p,ADMIN_PW)){await audit(null,"admin_login_failed",q.ip);return s.status(401).json({error:"Wrong password"})}
 s.append("Set-Cookie",`adm=${admTok()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${SECURE?"; Secure":""}`);await audit(null,"admin_login");s.json({ok:true})}));
app.post("/api/admin/logout",(q,s)=>{s.append("Set-Cookie","adm=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");s.json({ok:true})});
const adm=(q,s,n)=>admOk(q)?n():s.status(401).json({error:"Admin sign-in required"});
const CL="SELECT id,username,name,created,plan,trial_end,CASE WHEN plan='paid' THEN 'paid' WHEN trial_end>now() THEN 'trial' ELSE 'expired' END status,CASE WHEN plan='paid' OR trial_end IS NULL THEN NULL ELSE CEIL(EXTRACT(EPOCH FROM (trial_end-now()))/86400)::int END days FROM users WHERE role='doctor'";
app.get("/api/admin/status",(q,s)=>s.json({ok:admOk(q)}));
app.get("/api/admin/clinics",adm,A(async(q,s)=>{const rows=(await Q(CL+" ORDER BY id")).rows,c=await clinic(1);
 s.json({clinicName:c.name||"",summary:{total:rows.length,trial:rows.filter(r=>r.status==="trial").length,paid:rows.filter(r=>r.status==="paid").length,expired:rows.filter(r=>r.status==="expired").length},clinics:rows})}));
app.post("/api/admin/clinics/:id/extend",adm,A(async(q,s)=>{const id=uid(q.params.id);if(!id)return s.status(404).json({error:"Not found"});
 const r=await one("UPDATE users SET trial_end=GREATEST(COALESCE(trial_end,now()),now())+interval '7 days' WHERE id=$1 AND role='doctor' AND plan<>'paid' RETURNING id",[id]);
 if(!r)return s.status(409).json({error:"Clinic not found, or it is already paid"});await audit(null,"admin_extend",String(id));s.json(await one(CL+" AND id=$1",[id]))}));
app.post("/api/admin/clinics/:id/paid",adm,A(async(q,s)=>{const id=uid(q.params.id);if(!id)return s.status(404).json({error:"Not found"});
 const paid=!(q.body&&q.body.paid===false);
 const r=await one("UPDATE users SET plan=$2 WHERE id=$1 AND role='doctor' RETURNING id",[id,paid?"paid":"trial"]);
 if(!r)return s.status(404).json({error:"Not found"});await audit(null,paid?"admin_paid":"admin_unpaid",String(id));s.json(await one(CL+" AND id=$1",[id]))}));
/* permanently delete an entry: if this is the clinic's only doctor, the whole clinic goes (staff, patients, visits, Rx, bills, registrations, settings);
   if the clinic has other doctors, only this doctor's login is removed and the clinic's records stay with them. Clinic 1 (the original clinic) is never wiped. */
app.get("/api/admin/clinics/:id/impact",adm,A(async(q,s)=>{const id=uid(q.params.id),u=id&&await one("SELECT id,cid FROM users WHERE id=$1 AND role='doctor'",[id]);if(!u)return s.status(404).json({error:"Not found"});
 const o=await one("SELECT (SELECT COUNT(*)::int FROM users WHERE cid=$1 AND role='doctor' AND id<>$2) docs,(SELECT COUNT(*)::int FROM users WHERE cid=$1 AND role<>'doctor') staff,(SELECT COUNT(*)::int FROM docs WHERE cid=$1 AND coll='patients') patients,(SELECT COUNT(*)::int FROM docs WHERE cid=$1 AND coll='visits') visits,(SELECT COUNT(*)::int FROM docs WHERE cid=$1 AND coll='bills') bills",[u.cid,id]);
 s.json({...o,whole:o.docs===0,blocked:o.docs===0&&u.cid===1})}));
app.delete("/api/admin/clinics/:id",adm,A(async(q,s)=>{const id=uid(q.params.id);if(!id)return s.status(404).json({error:"Not found"});
 const r=await tx(async c=>{const u=(await c.query("SELECT id,cid,username FROM users WHERE id=$1 AND role='doctor' FOR UPDATE",[id])).rows[0];if(!u)return {code:404};
  await c.query("SELECT 1 FROM clinics WHERE id=$1 FOR UPDATE",[u.cid]);
  const others=(await c.query("SELECT COUNT(*)::int n FROM users WHERE cid=$1 AND role='doctor' AND id<>$2",[u.cid,id])).rows[0].n;
  if(others>0){await c.query("DELETE FROM users WHERE id=$1",[id]);return {u,whole:false}}
  if(u.cid===1)return {code:409};
  for(const t of ["docs","regs","audit"])await c.query(`DELETE FROM ${t} WHERE cid=$1`,[u.cid]);
  await c.query("DELETE FROM kv WHERE k LIKE $1",["c"+u.cid+":%"]);
  await c.query("DELETE FROM clinics WHERE id=$1",[u.cid]); /* cascades to users, then their sessions and reset links */
  return {u,whole:true}});
 if(r.code===404)return s.status(404).json({error:"Not found"});
 if(r.code===409)return s.status(409).json({error:"This is the original clinic (#1) and its only doctor, so it can't be deleted from here."});
 await audit(null,r.whole?"admin_delete_clinic":"admin_delete_doctor",r.u.username+" (clinic "+r.u.cid+")");s.json({ok:true,whole:r.whole})}));
app.use("/api",A(async(q,s,n)=>{q.u=await who(q);q.u?n():s.status(401).json({error:"Please sign in"})}));
const need=r=>(q,s,n)=>q.u.role===r?n():s.status(403).json({error:"Only a doctor can do this"});
/* until clinic setup is finished, nothing can be created or changed except the clinic profile itself */
const GATED=/^\/(patients|appts|rx|bills|visits|registrations|import|users|sig|reports|shared)(\/|$)/;
app.use("/api",(q,s,n)=>q.u.setup||q.method==="GET"||!GATED.test(q.path)?n():s.status(409).json({error:"Please finish clinic setup first.",setup_required:true}));

app.get("/api/data",A(async(q,s)=>{const d=q.u.role==="doctor";
 const cid=q.u.cid,[cl,patients,appts,rx,bills,regs,users,visits,doctors]=await Promise.all([clinic(cid),all(cid,"patients"),all(cid,"appts"),d?all(cid,"rx"):[],all(cid,"bills"),Q("SELECT id,data,created FROM regs WHERE cid=$1 ORDER BY id",[cid]),d?Q("SELECT id,username,name,role,email FROM users WHERE cid=$1 ORDER BY id",[cid]):{rows:[]},all(cid,"visits"),Q("SELECT id,name FROM users WHERE cid=$1 AND role='doctor' ORDER BY id",[cid])]);
 const {slug,...me}=q.u;
 s.json({me,regPath:cid===1?"/register":"/register/"+slug,clinic:cl,patients,appts,rx,bills,doctors:doctors.rows,visits:d?visits:visits.map(v=>{const o={...v};CLIN.forEach(k=>delete o[k]);return o}),regs:regs.rows.map(r=>{const {sig,...o}=r.data;return {...o,id:r.id,created:r.created,hasSig:!!sig}}),users:users.rows})}));
const CORE=["name","age","sex","ph","bg","em","ad","al","hx"],LOCK=["name","age","sex","ph"],TYPES=["text","number","select","textarea","phone","date","yesno"];
/* registration form fields may carry a second-language label (t) and a placeholder (p); sections a translated title (tt);
   the form keeps its consent text (consent) and an optional translated consent (consentT) */
const cleanForm=f=>{try{const seen=new Set(),secs=(Array.isArray(f&&f.sections)?f.sections:[]).slice(0,12).map(sc=>{const o2={t:str(sc&&sc.t,80)||"Section",f:(Array.isArray(sc&&sc.f)?sc.f:[]).slice(0,40).map(x=>{const id=str(x&&x.id,12);if(!(CORE.includes(id)||/^c_[a-z0-9]{3,8}$/.test(id))||seen.has(id))return null;seen.add(id);const o={id,l:str(x.l,80)||"Field",y:TYPES.includes(x.y)?x.y:"text"};
  const tl=str(x.t,120),ph=str(x.p,80);if(tl)o.t=tl;if(ph)o.p=ph;
  if(LOCK.includes(id)){o.y={name:"text",age:"number",sex:"select",ph:"phone"}[id];o.r=1;o.k=1}else if(x.r)o.r=1;
  if(o.y==="select"){o.o=id==="sex"?["Male","Female","Other"]:lst(x.o,12,40);if(!o.o.length)o.o=["Option 1"]}return o}).filter(Boolean)};const tt=str(sc&&sc.tt,120);if(tt)o2.tt=tt;return o2});
 return LOCK.every(k=>seen.has(k))?{sig:!!(f&&f.sig),consent:str(f.consent,1500)||SH.CONSENT_EN,consentT:str(f.consentT,3000),sections:secs}:DEF_FORM}catch(e){return DEF_FORM}};
/* settings kept in the kv JSON; the clinic profile fields (PROF) are saved through /api/clinic/profile instead */
const SET={phlabel:100,review:300,revmsg:600,theme:20,sigstyle:8,stamp:600,stampcol:10,stampmode:6,hdr:8,txt:8,nsize:8};
const STATES=["Andaman and Nicobar Islands","Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chandigarh","Chhattisgarh","Dadra and Nagar Haveli and Daman and Diu","Delhi","Goa","Gujarat","Haryana","Himachal Pradesh","Jammu and Kashmir","Jharkhand","Karnataka","Kerala","Ladakh","Lakshadweep","Madhya Pradesh","Maharashtra","Manipur","Meghalaya","Mizoram","Nagaland","Odisha","Puducherry","Punjab","Rajasthan","Sikkim","Tamil Nadu","Telangana","Tripura","Uttar Pradesh","Uttarakhand","West Bengal"];
const GSTRE=/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
/* validates the setup / clinic profile form; returns cleaned values and a {field: message} map */
const checkProfile=b=>{const o={},e={},req=(k,n,msg)=>{o[k]=str(b[k],n);if(!o[k])e[k]=msg};
 req("name",120,"Enter your clinic name");o.tag=str(b.tag,150);
 o.logo=typeof b.logo==="string"?b.logo:"";if(o.logo&&!(o.logo.length<2.8e6&&IMG.test(o.logo)))e.logo="The logo must be a PNG or JPG image under 2MB";
 o.phone=str(b.phone,20).replace(/[\s()-]/g,"").replace(/^(\+?91|0)(?=\d{10}$)/,"");
 if(!o.phone)e.phone="Enter the clinic phone number";else if(!/^[6-9]\d{9}$/.test(o.phone))e.phone="Enter a 10-digit mobile number starting with 6, 7, 8 or 9";
 const em=str(b.email,254);o.email=em?mail(em):"";if(em&&!o.email)e.email="Enter a valid email address";
 req("addr",200,"Enter the street address");o.area=str(b.area,120);req("city",80,"Enter the city");
 const st=str(b.state,60);o.state=STATES.find(x=>x.toLowerCase()===st.toLowerCase())||"";if(!st)e.state="Choose the state";else if(!o.state)e.state="Choose a state from the list";
 o.pin=str(b.pin,10).replace(/\s/g,"");if(!o.pin)e.pin="Enter the pincode";else if(!/^[1-9]\d{5}$/.test(o.pin))e.pin="Pincode must be 6 digits";
 req("doctor",100,"Enter the doctor's full name");req("qual",150,"Enter the doctor's qualifications");o.spec=str(b.spec,120);req("reg",50,"Enter the council registration number");
 o.fee=str(typeof b.fee==="number"?String(b.fee):b.fee,12);if(o.fee&&!/^\d{1,7}(\.\d{1,2})?$/.test(o.fee))e.fee="Enter the fee as a number, e.g. 500";
 o.time=str(b.time,300);o.gstin=str(b.gstin,20).toUpperCase().replace(/\s/g,"");if(o.gstin&&!GSTRE.test(o.gstin))e.gstin="GSTIN should be 15 characters, e.g. 29ABCDE1234F1Z5";
 o.billnote=str(b.billnote,300);return {o,e}};
const profileRoute=finish=>A(async(q,s)=>{const {o,e}=checkProfile(q.body||{});
 if(Object.keys(e).length)return s.status(400).json({error:"Please fix the highlighted fields.",fields:e});
 await Q(`UPDATE clinics SET ${PROF.map(([,col],i)=>col+"=$"+(i+2)).join(",")},profile_updated=now()${finish?",is_setup_complete=true,setup_completed_at=COALESCE(setup_completed_at,now())":""} WHERE id=$1`,[q.u.cid,...PROF.map(([f])=>o[f]===""?null:o[f])]);
 await audit(q.u,finish?"setup_complete":"profile");s.json({clinic:await clinic(q.u.cid),setup:finish||q.u.setup})});
/* doctor's note boxes for each visit, in order: {id, l}. dx, rx and notes are built in; others are stored in visit.extra by id */
/* the clinic's medicine list (Settings > Prescription): type, name, strength, usual dosage, intake, days, in use */
const cleanMeds=v=>{const seen=new Set();return v.slice(0,3000).map(m=>{const n=str(m&&m.n,80);if(!n)return null;const o={id:str(m.id,12)||"m"+crypto.randomBytes(4).toString("hex"),t:str(m.t,12),n,s:str(m.s,30),d:str(m.d,30),i:str(m.i,20),u:str(String(m.u??""),4).replace(/\D/g,""),on:m.on!==false,src:str(m.src,8)};
 const k=[o.t,o.n,o.s].join(" ").toLowerCase().replace(/\s+/g," ");if(seen.has(k)||seen.has("#"+o.id))return null;seen.add(k);seen.add("#"+o.id);return o}).filter(Boolean)};
const cleanBoxes=v=>{const seen=new Set();return v.slice(0,15).map(x=>{const id=str(x&&x.id,60),l=str(x&&x.l,60),lg=str(x&&x.legacy,60);if(!id||!l||seen.has(id))return null;seen.add(id);return lg?{id,l,legacy:lg}:{id,l}}).filter(Boolean)};
const lst=(v,n,m)=>(Array.isArray(v)?v:[]).slice(0,n).map(x=>str(x,m)).filter(Boolean);
app.put("/api/clinic",need("doctor"),A(async(q,s)=>{const b=q.body||{},o={};for(const [k,n] of Object.entries(SET))o[k]=str(b[k],n);
 for(const k of ["sig","lh"])o[k]=typeof b[k]==="string"&&b[k].length<2.8e6&&IMG.test(b[k])?b[k]:"";
 for(const k of ["opPrefix","invPrefix"])o[k]=/^[A-Za-z0-9-]{1,8}$/.test(str(b[k],8))?str(b[k],8):"";
 o.lang=SH.LANGS.some(x=>x[0]===b.lang)?b.lang:"";o.regForm=cleanForm(b.regForm);o.noteBoxes=lst(b.noteBoxes,10,60);if(Array.isArray(b.boxes))o.boxes=cleanBoxes(b.boxes);o.meds=lst(b.meds,3000,80);if(Array.isArray(b.medlist))o.medlist=cleanMeds(b.medlist);o.prices=cleanPrices(b.prices);
 await Q("INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=excluded.v",["c"+q.u.cid+":clinic",JSON.stringify(o)]);await audit(q.u,"clinic");s.json(await clinic(q.u.cid))}));
app.post("/api/clinic/setup",need("doctor"),profileRoute(true));
app.put("/api/clinic/profile",need("doctor"),profileRoute(false));
app.post("/api/import/patients",need("doctor"),A(async(q,s)=>{const rows=Array.isArray(q.body&&q.body.rows)?q.body.rows.slice(0,1000):[];let n=0;
 await tx(async c=>{for(const r of rows){const name=str(r&&r.name,100);if(!name)continue;const ph=str(String(r.ph??""),20).replace(/\D/g,"").slice(-10),dt=/^\d{4}-\d{2}-\d{2}$/.test(r.date||"")?r.date:today();
  const id=await nextId(q.u.cid,"patients",(t,p)=>c.query(t,p)),d={name,age:str(String(r.age??""),3).replace(/\D/g,""),sex:["Male","Female","Other"].includes(r.sex)?r.sex:"",ph:ph.length===10?ph:"",bg:str(r.bg,10),em:str(r.em,150),ad:str(r.ad,400),al:str(r.al,300),hx:str(r.hx,500),id,date:dt};
  await c.query("INSERT INTO docs(cid,coll,id,data) VALUES($1,'patients',$2,$3)",[q.u.cid,id,JSON.stringify(d)]);n++}});
 await audit(q.u,"import",String(n));s.json({added:n,skipped:rows.length-n})}));
app.post("/api/users",need("doctor"),A(async(q,s)=>{const b=q.body||{},un=str(b.username,30).toLowerCase(),nm=str(b.name,80),pw=typeof b.password==="string"?b.password:"",em=b.email?mail(b.email):"";
 if(!/^[a-z0-9._-]{3,30}$/.test(un)||!nm||pw.length<8||!["doctor","staff"].includes(b.role))return s.status(400).json({error:"Enter username, name, role and a password of 8+ characters."});
 if(b.email&&!em)return s.status(400).json({error:"That email address doesn't look right."});
 try{const r=await one("INSERT INTO users(username,name,role,hash,email,cid,trial_end) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $3='doctor' THEN now()+make_interval(days=>$7) END) RETURNING id",[un,nm,b.role,await hashPw(pw),em||null,q.u.cid,TRIAL_DAYS]);await audit(q.u,"user_add",un);s.json({id:r.id,username:un,name:nm,role:b.role,email:em||null})}
 catch(e){if(e.code==="23505")return s.status(409).json({error:"That username or email is already in use"});throw e}}));
app.delete("/api/users/:id",need("doctor"),A(async(q,s)=>{const id=uid(q.params.id);if(id===q.u.id)return s.status(400).json({error:"You cannot remove yourself"});
 if(id)await Q("DELETE FROM users WHERE id=$1 AND cid=$2",[id,q.u.cid]);await audit(q.u,"user_del",q.params.id);s.json({ok:true})}));
app.post("/api/password",A(async(q,s)=>{const b=q.body||{},u=await one("SELECT * FROM users WHERE id=$1",[q.u.id]);
 if(u.hash.includes(":")&&(typeof b.current!=="string"||!await okPw(b.current,u.hash)))return s.status(403).json({error:"Current password is wrong"});
 if(typeof b.next!=="string"||b.next.length<8)return s.status(400).json({error:"New password must be 8+ characters"});
 await Q("UPDATE users SET hash=$1 WHERE id=$2",[await hashPw(b.next),u.id]);await Q("DELETE FROM sessions WHERE uid=$1 AND th<>$2",[u.id,sha(cookie(q))]);await audit(q.u,"password");s.json({ok:true})}));

/* online registration inbox */
app.post("/api/registrations/:id/approve",A(async(q,s)=>{const id=uid(q.params.id);
 const cid=q.u.cid,d=id&&await tx(async c=>{const r=(await c.query("DELETE FROM regs WHERE id=$1 AND cid=$2 RETURNING data",[id,cid])).rows[0];if(!r)return null;
  const pid=await nextId(cid,"patients",(t,p)=>c.query(t,p)),d={...r.data,id:pid,date:today()};delete d.consent;d.consentAt=d.consentAt||today();if(d.sig){await c.query("INSERT INTO docs(cid,coll,id,data) VALUES($1,'sigs',$2,$3)",[cid,pid,JSON.stringify({sig:d.sig})]);d.hasSig=true;delete d.sig}
  await c.query("INSERT INTO docs(cid,coll,id,data) VALUES($1,'patients',$2,$3)",[cid,pid,JSON.stringify(d)]);
  /* registration counts as the first visit: carry over the complaint (if the form asks for one), yes/no answers and consent */
  const fs=((await clinic(cid)).regForm||DEF_FORM).sections.flatMap(x=>x.f),get=f=>CORE.includes(f.id)?d[f.id]:(d.custom||{})[f.id],mh={},ccf=fs.find(f=>/complaint/i.test(f.l));
  fs.filter(f=>f.y==="yesno").forEach(f=>{const x=get(f);if(x)mh[f.id]=x});
  const vid=await nextId(cid,"visits",(t,p)=>c.query(t,p)),fv={pid,date:today(),cc:ccf?get(ccf)||"":"",mhChg:"First visit",mh,consentAt:d.consentAt,id:vid};
  await c.query("INSERT INTO docs(cid,coll,id,data) VALUES($1,'visits',$2,$3)",[cid,vid,JSON.stringify(fv)]);return {...d,firstVisit:fv}});
 if(!d)return s.status(404).json({error:"Not found"});await audit(q.u,"reg_approve",d.id);s.json(d)}));
app.delete("/api/registrations/:id",A(async(q,s)=>{const id=uid(q.params.id);if(id)await Q("DELETE FROM regs WHERE id=$1 AND cid=$2",[id,q.u.cid]);await audit(q.u,"reg_reject",q.params.id);s.json({ok:true})}));

app.get("/api/sig/:id",A(async(q,s)=>{const r=await one("SELECT data FROM docs WHERE cid=$1 AND coll='sigs' AND id=$2",[q.u.cid,q.params.id]);s.json({sig:r?r.data.sig:""})}));
/* patient signature taken at the desk (Add / Edit patient); the QR page saves its signature through registration approval */
app.post("/api/sig/:id",A(async(q,s)=>{const id=str(q.params.id,20),sg=q.body&&q.body.sig;
 if(typeof sg!=="string"||!/^data:image\/png;base64,[A-Za-z0-9+\/=]{20,150000}$/.test(sg))return s.status(400).json({error:"Please ask the patient to sign in the box."});
 const r=await Q("UPDATE docs SET data=jsonb_set(data,'{hasSig}','true'::jsonb),upd=now() WHERE cid=$1 AND coll='patients' AND id=$2",[q.u.cid,id]);if(!r.rowCount)return s.status(404).json({error:"Patient not found"});
 await Q("INSERT INTO docs(cid,coll,id,data) VALUES($1,'sigs',$2,$3) ON CONFLICT(cid,coll,id) DO UPDATE SET data=excluded.data,upd=now()",[q.u.cid,id,JSON.stringify({sig:sg})]);
 await audit(q.u,"patient_sig",id);s.json({ok:true})}));

/* Settings > Invoice price list: name, category, price, in use. Duplicate names are dropped. */
function cleanPrices(a){const seen=new Set(),o=[];for(const x of (Array.isArray(a)?a:[]).slice(0,1500)){if(!x||typeof x!=="object")continue;const n=str(x.n,80);if(!n)continue;const c=str(x.c,40)||"Other",k=(c+"|"+n).toLowerCase().replace(/\s+/g," ");if(seen.has(k))continue;seen.add(k);
 const r=x.r===""||x.r==null?"":Math.round(Math.max(0,Math.min(1e7,+x.r||0))*100)/100;o.push({id:str(x.id,20)||"p"+o.length,n,c,r,on:x.on!==false})}return o}
/* delete one invoice row (doctor only) */
app.delete("/api/bills/:id",need("doctor"),A(async(q,s)=>{const id=str(q.params.id,20);const r=await Q("DELETE FROM docs WHERE cid=$1 AND coll='bills' AND id=$2",[q.u.cid,id]);if(!r.rowCount)return s.status(404).json({error:"Not found"});await audit(q.u,"bill_delete",id);s.json({ok:true})}));
/* reports for one patient (any signed-in user of the clinic; delete is doctor only) */
const RCOLS="id,pid,kind,name,mime,size,src,created,(SELECT name FROM users WHERE id=reports.uid) uname";
app.get("/api/reports/:pid",A(async(q,s)=>{s.json((await Q(`SELECT ${RCOLS} FROM reports WHERE cid=$1 AND pid=$2 ORDER BY created DESC,id DESC`,[q.u.cid,str(q.params.pid,20)])).rows)}));
app.post("/api/reports/:pid",A(async(q,s)=>{const pid=str(q.params.pid,20);if(!await one("SELECT 1 FROM docs WHERE cid=$1 AND coll='patients' AND id=$2",[q.u.cid,pid]))return s.status(404).json({error:"Patient not found"});
 const f=rFile(q.body||{});if(f.err)return s.status(400).json({error:f.err});
 const r=await one(`INSERT INTO reports(cid,pid,kind,name,mime,size,data,src,uid) VALUES($1,$2,$3,$4,$5,$6,$7,'clinic',$8) RETURNING ${RCOLS}`,[q.u.cid,pid,rKind(q.body.kind),f.name,f.mime,f.buf.length,f.buf,q.u.id]);await audit(q.u,"report_add",pid);s.json(r)}));
app.post("/api/reports/:pid/link",A(async(q,s)=>{const pid=str(q.params.pid,20);if(!await one("SELECT 1 FROM docs WHERE cid=$1 AND coll='patients' AND id=$2",[q.u.cid,pid]))return s.status(404).json({error:"Patient not found"});
 const t=crypto.randomBytes(24).toString("hex");await Q("DELETE FROM report_links WHERE exp<now()");await Q("INSERT INTO report_links(th,cid,pid,kind,exp) VALUES($1,$2,$3,$4,now()+interval '7 days')",[sha(t),q.u.cid,pid,rKind((q.body||{}).kind)]);
 await audit(q.u,"report_link",pid);s.json({url:base(q)+"/u/"+t,days:7,max:RLINK_MAX})}));
app.get("/api/report-file/:id",A(async(q,s)=>{const id=/^\d{1,18}$/.test(q.params.id)?q.params.id:"0",r=await one("SELECT name,mime,data FROM reports WHERE cid=$1 AND id=$2",[q.u.cid,id]);if(!r)return s.status(404).type("text").send("Report not found");
 s.removeHeader("Content-Security-Policy");s.set({"Content-Type":r.mime,"Content-Disposition":`${q.query.dl?"attachment":"inline"}; filename="${r.name.replace(/[^\x20-\x7e]/g,"_").replace(/"/g,"")}"; filename*=UTF-8''${encodeURIComponent(r.name)}`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}).send(r.data)}));
app.delete("/api/reports/:id",need("doctor"),A(async(q,s)=>{const id=/^\d{1,18}$/.test(q.params.id)?q.params.id:"0",r=await one("DELETE FROM reports WHERE cid=$1 AND id=$2 RETURNING pid",[q.u.cid,id]);if(!r)return s.status(404).json({error:"Not found"});await audit(q.u,"report_delete",r.pid);s.json({ok:true})}));

/* store a PDF made in the browser and return a 3-day link for the WhatsApp message */
app.post("/api/shared",A(async(q,s)=>{const b=q.body||{},pid=str(b.pid,20),kind=SKINDS.includes(b.kind)?b.kind:"";if(!kind)return s.status(400).json({error:"Unknown document"});
 if(kind==="Prescription"&&q.u.role!=="doctor")return s.status(403).json({error:"Only a doctor can do this"});
 if(!await one("SELECT 1 FROM docs WHERE cid=$1 AND coll='patients' AND id=$2",[q.u.cid,pid]))return s.status(404).json({error:"Patient not found"});
 const m=/^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/.exec(typeof b.data==="string"?b.data:"");const buf=m?Buffer.from(m[1],"base64"):null;
 if(!buf||buf.subarray(0,4).toString("latin1")!=="%PDF")return s.status(400).json({error:"The PDF could not be made. Please try again."});if(buf.length>SMAX)return s.status(400).json({error:"The PDF is larger than 5 MB."});
 const name=(str(b.name,100).replace(/[^\w.\- ]/g,"_")||"document").replace(/\.pdf$/i,"")+".pdf",t=crypto.randomBytes(24).toString("hex");
 await Q("DELETE FROM shared_docs WHERE exp<now()");
 await Q(`INSERT INTO shared_docs(th,cid,pid,kind,ref,name,data,exp) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '${SDAYS} days')`,[sha(t),q.u.cid,pid,kind,str(b.ref,30)||null,name,buf]);
 await audit(q.u,"share_pdf",pid);s.json({url:base(q)+"/d/"+t,days:SDAYS})}));

/* records: patients, appts, rx (doctor only), bills */
const coll=(q,s,n)=>{if(!PFX[q.params.c])return s.status(404).json({error:"Unknown collection"});if(q.params.c==="rx"&&q.u.role!=="doctor")return s.status(403).json({error:"Only a doctor can do this"});
 const j=q.body&&typeof q.body==="object"&&!Array.isArray(q.body)?JSON.stringify(q.body):"";if(!j||j.length>1e5||j.includes("\\u0000"))return s.status(400).json({error:"Bad data"});n()};
/* delete one visit (doctor only); its auto-created invoice goes too unless a payment was recorded on it */
app.delete("/api/visits/:id",need("doctor"),A(async(q,s)=>{const id=str(q.params.id,20),cid=q.u.cid;
 const r=await tx(async c=>{const v=(await c.query("DELETE FROM docs WHERE cid=$1 AND coll='visits' AND id=$2 RETURNING id",[cid,id])).rowCount;if(!v)return null;
  const b=(await c.query("DELETE FROM docs WHERE cid=$1 AND coll='bills' AND data->>'vid'=$2 AND COALESCE(jsonb_array_length(data->'pays'),0)=0 RETURNING id",[cid,id])).rows[0];return {billDeleted:b?b.id:null}});
 if(!r)return s.status(404).json({error:"Visit not found"});await audit(q.u,"visit_delete",id);s.json({ok:true,...r})}));
app.delete("/api/patients/:id",need("doctor"),A(async(q,s)=>{const id=q.params.id,cid=q.u.cid;await tx(async c=>{await c.query("DELETE FROM docs WHERE cid=$1 AND coll IN ('patients','sigs') AND id=$2",[cid,id]);await c.query("DELETE FROM docs WHERE cid=$1 AND coll IN ('visits','rx','bills','appts') AND data->>'pid'=$2",[cid,id]);await c.query("DELETE FROM reports WHERE cid=$1 AND pid=$2",[cid,id]);await c.query("DELETE FROM report_links WHERE cid=$1 AND pid=$2",[cid,id]);await c.query("DELETE FROM shared_docs WHERE cid=$1 AND pid=$2",[cid,id])});await audit(q.u,"patient_delete",id);s.json({ok:true})}));
app.post("/api/:c",coll,A(async(q,s)=>{const id=await nextId(q.u.cid,q.params.c),d={...q.body,id};if(q.params.c==="visits"&&q.u.role!=="doctor")CLIN.forEach(k=>delete d[k]);if(q.params.c==="rx"||q.params.c==="bills")d.no=id;
 await Q("INSERT INTO docs(cid,coll,id,data) VALUES($1,$2,$3,$4)",[q.u.cid,q.params.c,id,JSON.stringify(d)]);await audit(q.u,"create",id);s.json(d)}));
app.put("/api/:c/:id",coll,A(async(q,s)=>{const d={...q.body,id:q.params.id};if(q.params.c==="visits"&&q.u.role!=="doctor"){const o=await one("SELECT data FROM docs WHERE cid=$1 AND coll='visits' AND id=$2",[q.u.cid,q.params.id]);CLIN.forEach(k=>{delete d[k];if(o&&o.data[k]!==undefined)d[k]=o.data[k]})}if(q.params.c==="rx"||q.params.c==="bills")d.no=q.params.id;
 const r=await Q("UPDATE docs SET data=$1,upd=now() WHERE cid=$2 AND coll=$3 AND id=$4",[JSON.stringify(d),q.u.cid,q.params.c,q.params.id]);
 if(!r.rowCount)return s.status(404).json({error:"Not found"});await audit(q.u,"update",q.params.id);s.json(d)}));
app.use((e,q,s,n)=>{if(e.type==="entity.parse.failed"||e.type==="entity.too.large")return s.status(400).json({error:"Bad request"});console.error(e);s.status(500).json({error:"Server error"})});

(async()=>{await init();DUMMY=await hashPw(crypto.randomBytes(8).toString("hex"));
 setInterval(()=>Q("DELETE FROM shared_docs WHERE exp<now()").catch(()=>{}),36e5).unref();
 const srv=app.listen(PORT,()=>console.log("Clinic server running on port "+PORT));
 const stop=()=>srv.close(()=>pool.end().then(()=>process.exit(0)));process.on("SIGTERM",stop);process.on("SIGINT",stop)})()
 .catch(e=>{console.error("Startup failed:",e.message);process.exit(1)});
