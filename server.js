const express=require("express"),Database=require("better-sqlite3"),crypto=require("crypto"),path=require("path"),fs=require("fs");
const PORT=process.env.PORT||3000,DIR=process.env.DATA_DIR||path.join(__dirname,"data"),SECURE=process.env.INSECURE_COOKIES!=="1",TZ=process.env.CLINIC_TZ||"Asia/Kolkata";
fs.mkdirSync(DIR,{recursive:true});
const db=new Database(path.join(DIR,"clinic.db"));db.pragma("journal_mode=WAL");
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,hash TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(th TEXT PRIMARY KEY,uid INTEGER NOT NULL,exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS docs(coll TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,upd TEXT NOT NULL,PRIMARY KEY(coll,id));
CREATE TABLE IF NOT EXISTS regs(id INTEGER PRIMARY KEY,data TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY,v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,uid INTEGER,act TEXT,ref TEXT,at TEXT NOT NULL);`);
const now=()=>new Date().toISOString(),today=()=>new Date().toLocaleDateString("en-CA",{timeZone:TZ});
const sha=s=>crypto.createHash("sha256").update(s).digest("hex");
const hashPw=p=>{const s=crypto.randomBytes(16);return s.toString("hex")+":"+crypto.scryptSync(p,s,64).toString("hex")};
const okPw=(p,h)=>{const [s,x]=h.split(":"),y=crypto.scryptSync(p,Buffer.from(s,"hex"),64);return crypto.timingSafeEqual(y,Buffer.from(x,"hex"))};
const audit=(u,act,ref)=>db.prepare("INSERT INTO audit(uid,act,ref,at) VALUES(?,?,?,?)").run(u?u.id:null,act,ref||"",now());
const hits=new Map(),limited=(k,max,ms)=>{const t=Date.now(),a=(hits.get(k)||[]).filter(x=>t-x<ms);a.push(t);hits.set(k,a);return a.length>max};
setInterval(()=>{const t=Date.now();for(const [k,a] of hits)if(!a.some(x=>t-x<36e5))hits.delete(k);db.prepare("DELETE FROM sessions WHERE exp<?").run(t)},6e5).unref();
const PFX={patients:"P-",appts:"A-",rx:"RX-",bills:"INV-"};
const nextId=c=>PFX[c]+String(db.prepare("INSERT INTO kv(k,v) VALUES(?,'1') ON CONFLICT(k) DO UPDATE SET v=CAST(v AS INTEGER)+1 RETURNING v").get("seq:"+c).v).padStart(4,"0");
const all=c=>db.prepare("SELECT data FROM docs WHERE coll=? ORDER BY rowid").all(c).map(r=>JSON.parse(r.data));
const clinic=()=>{const r=db.prepare("SELECT v FROM kv WHERE k='clinic'").get();return r?JSON.parse(r.v):{}};
const str=(v,n)=>typeof v==="string"?v.trim().slice(0,n):"";
const E=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

const app=express();app.disable("x-powered-by");app.set("trust proxy",process.env.TRUST_PROXY==="1"?1:false);
app.use((q,s,n)=>{s.set({"Content-Security-Policy":"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","X-Frame-Options":"DENY"});if(q.path.startsWith("/api"))s.set("Cache-Control","no-store");n()});
app.use(express.json({limit:"200kb"}));
app.get("/",(q,s)=>s.sendFile(path.join(__dirname,"public/app.html")));
app.get("/qrcode.js",(q,s)=>s.sendFile(require.resolve("qrcode-generator/qrcode.js")));
app.get("/register",(q,s)=>s.type("html").send(fs.readFileSync(path.join(__dirname,"public/register.html"),"utf8").replace("{{CLINIC}}",E(clinic().name||"Clinic"))));

/* public: patient self-registration (inbox only, never writes patients directly) */
app.post("/api/public/register",(q,s)=>{
 if(limited("reg:"+q.ip,8,36e5))return s.status(429).json({error:"Too many submissions. Please try again later."});
 const b=q.body||{};if(b.website)return s.json({ok:true});
 const d={name:str(b.name,100),age:str(String(b.age??""),3),sex:str(b.sex,10),ph:str(b.ph,10),bg:str(b.bg,10),em:str(b.em,150),ad:str(b.ad,400),al:str(b.al,300),hx:str(b.hx,500),consent:b.consent===true};
 if(!d.name||!/^\d{1,3}$/.test(d.age)||+d.age>120||!/^[6-9]\d{9}$/.test(d.ph)||!["Male","Female","Other"].includes(d.sex)||!d.consent)return s.status(400).json({error:"Please check your name, age, sex, mobile number and consent."});
 if(db.prepare("SELECT COUNT(*) c FROM regs").get().c>=300)return s.status(503).json({error:"The clinic cannot accept more online registrations right now. Please register at the desk."});
 db.prepare("INSERT INTO regs(data,created) VALUES(?,?)").run(JSON.stringify(d),now());s.json({ok:true})});

/* auth */
const cookie=q=>{const m=/(?:^|;\s*)sid=([a-f0-9]{64})/.exec(q.headers.cookie||"");return m&&m[1]};
const login=(s,uid)=>{const t=crypto.randomBytes(32).toString("hex");db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(sha(t),uid,Date.now()+432e5);s.append("Set-Cookie",`sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${SECURE?"; Secure":""}`)};
const who=q=>{const t=cookie(q);if(!t)return null;const r=db.prepare("SELECT u.id,u.username,u.name,u.role FROM sessions s JOIN users u ON u.id=s.uid WHERE s.th=? AND s.exp>?").get(sha(t),Date.now());return r||null};
app.get("/api/status",(q,s)=>s.json({setup:db.prepare("SELECT COUNT(*) c FROM users").get().c===0,me:who(q)}));
app.use("/api",(q,s,n)=>{if(q.method!=="GET"&&q.headers["x-requested-with"]!=="opd"&&!q.path.startsWith("/public"))return s.status(403).json({error:"Forbidden"});n()});
app.post("/api/setup",(q,s)=>{if(db.prepare("SELECT COUNT(*) c FROM users").get().c)return s.status(403).json({error:"Already set up"});
 const b=q.body||{},un=str(b.username,30).toLowerCase(),nm=str(b.name,80),pw=typeof b.password==="string"?b.password:"";
 if(!/^[a-z0-9._-]{3,30}$/.test(un)||!nm||pw.length<8)return s.status(400).json({error:"Use a username (3+ letters/digits), your name and a password of 8+ characters."});
 const id=db.prepare("INSERT INTO users(username,name,role,hash,created) VALUES(?,?,?,?,?)").run(un,nm,"doctor",hashPw(pw),now()).lastInsertRowid;login(s,id);audit({id},"setup");s.json({ok:true})});
app.post("/api/login",(q,s)=>{const b=q.body||{},un=str(b.username,30).toLowerCase();
 if(limited("ip:"+q.ip,20,9e5)||limited("u:"+un,10,9e5))return s.status(429).json({error:"Too many attempts. Try again in 15 minutes."});
 const u=db.prepare("SELECT * FROM users WHERE username=?").get(un),ok=u&&typeof b.password==="string"&&okPw(b.password,u.hash);
 if(!ok){audit(null,"login_failed",un);return s.status(401).json({error:"Wrong username or password"})}
 login(s,u.id);audit(u,"login");s.json({ok:true})});
app.post("/api/logout",(q,s)=>{const t=cookie(q);if(t)db.prepare("DELETE FROM sessions WHERE th=?").run(sha(t));s.append("Set-Cookie","sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");s.json({ok:true})});
app.use("/api",(q,s,n)=>{q.u=who(q);q.u?n():s.status(401).json({error:"Please sign in"})});
const need=r=>(q,s,n)=>q.u.role===r?n():s.status(403).json({error:"Only a doctor can do this"});

app.get("/api/data",(q,s)=>{const d=q.u.role==="doctor";s.json({me:q.u,clinic:clinic(),patients:all("patients"),appts:all("appts"),rx:d?all("rx"):[],bills:all("bills"),
 regs:db.prepare("SELECT id,data,created FROM regs ORDER BY id").all().map(r=>({...JSON.parse(r.data),id:r.id,created:r.created})),
 users:d?db.prepare("SELECT id,username,name,role FROM users ORDER BY id").all():[]})});
app.put("/api/clinic",need("doctor"),(q,s)=>{const o={};for(const k of ["name","doctor","qual","reg","phone","time","addr"])o[k]=str((q.body||{})[k],200);db.prepare("INSERT INTO kv VALUES('clinic',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify(o));audit(q.u,"clinic");s.json(o)});
app.post("/api/users",need("doctor"),(q,s)=>{const b=q.body||{},un=str(b.username,30).toLowerCase(),nm=str(b.name,80),pw=typeof b.password==="string"?b.password:"";
 if(!/^[a-z0-9._-]{3,30}$/.test(un)||!nm||pw.length<8||!["doctor","staff"].includes(b.role))return s.status(400).json({error:"Enter username, name, role and a password of 8+ characters."});
 if(db.prepare("SELECT 1 FROM users WHERE username=?").get(un))return s.status(409).json({error:"That username is taken"});
 const id=db.prepare("INSERT INTO users(username,name,role,hash,created) VALUES(?,?,?,?,?)").run(un,nm,b.role,hashPw(pw),now()).lastInsertRowid;audit(q.u,"user_add",un);s.json({id,username:un,name:nm,role:b.role})});
app.delete("/api/users/:id",need("doctor"),(q,s)=>{if(+q.params.id===q.u.id)return s.status(400).json({error:"You cannot remove yourself"});db.prepare("DELETE FROM sessions WHERE uid=?").run(+q.params.id);db.prepare("DELETE FROM users WHERE id=?").run(+q.params.id);audit(q.u,"user_del",q.params.id);s.json({ok:true})});
app.post("/api/password",(q,s)=>{const b=q.body||{},u=db.prepare("SELECT * FROM users WHERE id=?").get(q.u.id);
 if(typeof b.current!=="string"||!okPw(b.current,u.hash))return s.status(403).json({error:"Current password is wrong"});
 if(typeof b.next!=="string"||b.next.length<8)return s.status(400).json({error:"New password must be 8+ characters"});
 db.prepare("UPDATE users SET hash=? WHERE id=?").run(hashPw(b.next),u.id);db.prepare("DELETE FROM sessions WHERE uid=? AND th!=?").run(u.id,sha(cookie(q)));audit(q.u,"password");s.json({ok:true})});

/* online registration inbox */
app.post("/api/registrations/:id/approve",(q,s)=>{const r=db.prepare("SELECT data FROM regs WHERE id=?").get(+q.params.id);if(!r)return s.status(404).json({error:"Not found"});
 const t=db.transaction(()=>{const id=nextId("patients"),d={...JSON.parse(r.data),id,date:today()};delete d.consent;db.prepare("INSERT INTO docs VALUES('patients',?,?,?)").run(id,JSON.stringify(d),now());db.prepare("DELETE FROM regs WHERE id=?").run(+q.params.id);return d});
 const d=t();audit(q.u,"reg_approve",d.id);s.json(d)});
app.delete("/api/registrations/:id",(q,s)=>{db.prepare("DELETE FROM regs WHERE id=?").run(+q.params.id);audit(q.u,"reg_reject",q.params.id);s.json({ok:true})});

/* records: patients, appts, rx (doctor only), bills */
const coll=(q,s,n)=>{if(!PFX[q.params.c])return s.status(404).json({error:"Unknown collection"});if(q.params.c==="rx"&&q.u.role!=="doctor")return s.status(403).json({error:"Only a doctor can do this"});
 if(!q.body||typeof q.body!=="object"||Array.isArray(q.body)||JSON.stringify(q.body).length>1e5)return s.status(400).json({error:"Bad data"});n()};
app.post("/api/:c",coll,(q,s)=>{const id=nextId(q.params.c),d={...q.body,id};if(q.params.c==="rx"||q.params.c==="bills")d.no=id;
 db.prepare("INSERT INTO docs VALUES(?,?,?,?)").run(q.params.c,id,JSON.stringify(d),now());audit(q.u,"create",id);s.json(d)});
app.put("/api/:c/:id",coll,(q,s)=>{if(!db.prepare("SELECT 1 FROM docs WHERE coll=? AND id=?").get(q.params.c,q.params.id))return s.status(404).json({error:"Not found"});
 const d={...q.body,id:q.params.id};if(q.params.c==="rx"||q.params.c==="bills")d.no=q.params.id;
 db.prepare("UPDATE docs SET data=?,upd=? WHERE coll=? AND id=?").run(JSON.stringify(d),now(),q.params.c,q.params.id);audit(q.u,"update",q.params.id);s.json(d)});
app.use((e,q,s,n)=>{if(e.type==="entity.parse.failed"||e.type==="entity.too.large")return s.status(400).json({error:"Bad request"});console.error(e);s.status(500).json({error:"Server error"})});
app.listen(PORT,()=>console.log("OPD Desk running on port "+PORT));
