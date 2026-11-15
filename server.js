const express=require("express"),{Pool}=require("pg"),crypto=require("crypto"),path=require("path"),fs=require("fs"),scrypt=require("util").promisify(crypto.scrypt);
const PORT=process.env.PORT||3000,SECURE=process.env.INSECURE_COOKIES!=="1",TZ=process.env.CLINIC_TZ||"Asia/Kolkata";
if(!process.env.DATABASE_URL){console.error("DATABASE_URL is not set, e.g. postgres://user:password@host:5432/opd");process.exit(1)}
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==="1"?{rejectUnauthorized:process.env.PGSSL_STRICT==="1"}:undefined,max:10});
pool.on("error",e=>console.error("Postgres pool error:",e.message));
const Q=(t,p)=>pool.query(t,p),one=async(t,p)=>(await Q(t,p)).rows[0];
const tx=async f=>{const c=await pool.connect();try{await c.query("BEGIN");const r=await f(c);await c.query("COMMIT");return r}catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}};
const init=()=>Q(`CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,hash TEXT NOT NULL,created TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sessions(th TEXT PRIMARY KEY,uid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,exp BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS docs(coll TEXT NOT NULL,id TEXT NOT NULL,n BIGSERIAL,data JSONB NOT NULL,upd TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(coll,id));
CREATE TABLE IF NOT EXISTS regs(id SERIAL PRIMARY KEY,data JSONB NOT NULL,created TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY,v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id BIGSERIAL PRIMARY KEY,uid INTEGER,act TEXT,ref TEXT,at TIMESTAMPTZ NOT NULL DEFAULT now())`);
const today=()=>new Date().toLocaleDateString("en-CA",{timeZone:TZ}),sha=s=>crypto.createHash("sha256").update(s).digest("hex");
const hashPw=async p=>{const s=crypto.randomBytes(16);return s.toString("hex")+":"+(await scrypt(p,s,64)).toString("hex")};
const okPw=async(p,h)=>{const [s,x]=h.split(":"),y=await scrypt(p,Buffer.from(s,"hex"),64);return crypto.timingSafeEqual(y,Buffer.from(x,"hex"))};
let DUMMY;
const audit=(u,act,ref)=>Q("INSERT INTO audit(uid,act,ref) VALUES($1,$2,$3)",[u?u.id:null,act,ref||""]).catch(e=>console.error("audit failed:",e.message));
const hits=new Map(),limited=(k,max,ms)=>{const t=Date.now(),a=(hits.get(k)||[]).filter(x=>t-x<ms);a.push(t);hits.set(k,a);return a.length>max};
setInterval(()=>{const t=Date.now();for(const [k,a] of hits)if(!a.some(x=>t-x<36e5))hits.delete(k);Q("DELETE FROM sessions WHERE exp<$1",[t]).catch(()=>{})},6e5).unref();
const PFX={patients:"P-",appts:"A-",rx:"RX-",bills:"INV-"};
const nextId=async(c,x=Q)=>PFX[c]+String((await x("INSERT INTO kv(k,v) VALUES($1,'1') ON CONFLICT(k) DO UPDATE SET v=(kv.v::int+1)::text RETURNING v",["seq:"+c])).rows[0].v).padStart(4,"0");
const all=async c=>(await Q("SELECT data FROM docs WHERE coll=$1 ORDER BY n",[c])).rows.map(r=>r.data);
const clinic=async()=>{const r=await one("SELECT v FROM kv WHERE k='clinic'");return r?JSON.parse(r.v):{}};
const str=(v,n)=>typeof v==="string"?v.replace(/\u0000/g,"").trim().slice(0,n):"";
const E=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const A=f=>(q,s,n)=>Promise.resolve(f(q,s,n)).catch(n),uid=v=>/^\d{1,9}$/.test(v)?+v:null;
const REG=fs.readFileSync(path.join(__dirname,"public/register.html"),"utf8");

const app=express();app.disable("x-powered-by");app.set("trust proxy",process.env.TRUST_PROXY==="1"?1:false);
app.use((q,s,n)=>{s.set({"Content-Security-Policy":"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","X-Frame-Options":"DENY"});if(q.path.startsWith("/api"))s.set("Cache-Control","no-store");n()});
app.use(express.json({limit:"200kb"}));
app.get("/",(q,s)=>s.sendFile(path.join(__dirname,"public/app.html")));
app.get("/qrcode.js",(q,s)=>s.sendFile(require.resolve("qrcode-generator/qrcode.js")));
app.get("/register",A(async(q,s)=>s.type("html").send(REG.replaceAll("{{CLINIC}}",E((await clinic()).name||"Clinic")))));

/* public: patient self-registration (inbox only, never writes patients directly) */
app.post("/api/public/register",A(async(q,s)=>{
 if(limited("reg:"+q.ip,8,36e5))return s.status(429).json({error:"Too many submissions. Please try again later."});
 const b=q.body||{};if(b.website)return s.json({ok:true});
 const d={name:str(b.name,100),age:str(String(b.age??""),3),sex:str(b.sex,10),ph:str(b.ph,10),bg:str(b.bg,10),em:str(b.em,150),ad:str(b.ad,400),al:str(b.al,300),hx:str(b.hx,500),consent:b.consent===true};
 if(!d.name||!/^\d{1,3}$/.test(d.age)||+d.age>120||!/^[6-9]\d{9}$/.test(d.ph)||!["Male","Female","Other"].includes(d.sex)||!d.consent)return s.status(400).json({error:"Please check your name, age, sex, mobile number and consent."});
 if((await one("SELECT COUNT(*)::int c FROM regs")).c>=300)return s.status(503).json({error:"The clinic cannot accept more online registrations right now. Please register at the desk."});
 await Q("INSERT INTO regs(data) VALUES($1)",[JSON.stringify(d)]);s.json({ok:true})}));

/* auth */
const cookie=q=>{const m=/(?:^|;\s*)sid=([a-f0-9]{64})/.exec(q.headers.cookie||"");return m&&m[1]};
const login=async(s,id)=>{const t=crypto.randomBytes(32).toString("hex");await Q("INSERT INTO sessions(th,uid,exp) VALUES($1,$2,$3)",[sha(t),id,Date.now()+432e5]);s.append("Set-Cookie",`sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${SECURE?"; Secure":""}`)};
const who=async q=>{const t=cookie(q);if(!t)return null;return(await one("SELECT u.id,u.username,u.name,u.role FROM sessions s JOIN users u ON u.id=s.uid WHERE s.th=$1 AND s.exp>$2",[sha(t),Date.now()]))||null};
const nUsers=async()=>(await one("SELECT COUNT(*)::int c FROM users")).c;
app.get("/api/status",A(async(q,s)=>s.json({setup:await nUsers()===0,me:await who(q)})));
app.use("/api",(q,s,n)=>{if(q.method!=="GET"&&q.headers["x-requested-with"]!=="opd"&&!q.path.startsWith("/public"))return s.status(403).json({error:"Forbidden"});n()});
app.post("/api/setup",A(async(q,s)=>{
 const b=q.body||{},un=str(b.username,30).toLowerCase(),nm=str(b.name,80),pw=typeof b.password==="string"?b.password:"";
 if(!/^[a-z0-9._-]{3,30}$/.test(un)||!nm||pw.length<8)return s.status(400).json({error:"Use a username (3+ letters/digits), your name and a password of 8+ characters."});
 const h=await hashPw(pw),id=await tx(async c=>{await c.query("SELECT pg_advisory_xact_lock(7001)");if((await c.query("SELECT COUNT(*)::int c FROM users")).rows[0].c)return null;return(await c.query("INSERT INTO users(username,name,role,hash) VALUES($1,$2,'doctor',$3) RETURNING id",[un,nm,h])).rows[0].id});
 if(!id)return s.status(403).json({error:"Already set up"});await login(s,id);await audit({id},"setup");s.json({ok:true})}));
app.post("/api/login",A(async(q,s)=>{const b=q.body||{},un=str(b.username,30).toLowerCase();
 if(limited("ip:"+q.ip,20,9e5)||limited("u:"+un,10,9e5))return s.status(429).json({error:"Too many attempts. Try again in 15 minutes."});
 const u=await one("SELECT * FROM users WHERE username=$1",[un]),pw=typeof b.password==="string"?b.password:"",ok=await okPw(pw,u?u.hash:DUMMY)&&!!u&&pw!=="";
 if(!ok){await audit(null,"login_failed",un);return s.status(401).json({error:"Wrong username or password"})}
 await login(s,u.id);await audit(u,"login");s.json({ok:true})}));
app.post("/api/logout",A(async(q,s)=>{const t=cookie(q);if(t)await Q("DELETE FROM sessions WHERE th=$1",[sha(t)]);s.append("Set-Cookie","sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");s.json({ok:true})}));
app.use("/api",A(async(q,s,n)=>{q.u=await who(q);q.u?n():s.status(401).json({error:"Please sign in"})}));
const need=r=>(q,s,n)=>q.u.role===r?n():s.status(403).json({error:"Only a doctor can do this"});

app.get("/api/data",A(async(q,s)=>{const d=q.u.role==="doctor";
 const [cl,patients,appts,rx,bills,regs,users]=await Promise.all([clinic(),all("patients"),all("appts"),d?all("rx"):[],all("bills"),Q("SELECT id,data,created FROM regs ORDER BY id"),d?Q("SELECT id,username,name,role FROM users ORDER BY id"):{rows:[]}]);
 s.json({me:q.u,clinic:cl,patients,appts,rx,bills,regs:regs.rows.map(r=>({...r.data,id:r.id,created:r.created})),users:users.rows})}));
app.put("/api/clinic",need("doctor"),A(async(q,s)=>{const o={};for(const k of ["name","doctor","qual","reg","phone","time","addr"])o[k]=str((q.body||{})[k],200);
 await Q("INSERT INTO kv(k,v) VALUES('clinic',$1) ON CONFLICT(k) DO UPDATE SET v=excluded.v",[JSON.stringify(o)]);await audit(q.u,"clinic");s.json(o)}));
app.post("/api/users",need("doctor"),A(async(q,s)=>{const b=q.body||{},un=str(b.username,30).toLowerCase(),nm=str(b.name,80),pw=typeof b.password==="string"?b.password:"";
 if(!/^[a-z0-9._-]{3,30}$/.test(un)||!nm||pw.length<8||!["doctor","staff"].includes(b.role))return s.status(400).json({error:"Enter username, name, role and a password of 8+ characters."});
 try{const r=await one("INSERT INTO users(username,name,role,hash) VALUES($1,$2,$3,$4) RETURNING id",[un,nm,b.role,await hashPw(pw)]);await audit(q.u,"user_add",un);s.json({id:r.id,username:un,name:nm,role:b.role})}
 catch(e){if(e.code==="23505")return s.status(409).json({error:"That username is taken"});throw e}}));
app.delete("/api/users/:id",need("doctor"),A(async(q,s)=>{const id=uid(q.params.id);if(id===q.u.id)return s.status(400).json({error:"You cannot remove yourself"});
 if(id)await Q("DELETE FROM users WHERE id=$1",[id]);await audit(q.u,"user_del",q.params.id);s.json({ok:true})}));
app.post("/api/password",A(async(q,s)=>{const b=q.body||{},u=await one("SELECT * FROM users WHERE id=$1",[q.u.id]);
 if(typeof b.current!=="string"||!await okPw(b.current,u.hash))return s.status(403).json({error:"Current password is wrong"});
 if(typeof b.next!=="string"||b.next.length<8)return s.status(400).json({error:"New password must be 8+ characters"});
 await Q("UPDATE users SET hash=$1 WHERE id=$2",[await hashPw(b.next),u.id]);await Q("DELETE FROM sessions WHERE uid=$1 AND th<>$2",[u.id,sha(cookie(q))]);await audit(q.u,"password");s.json({ok:true})}));

/* online registration inbox */
app.post("/api/registrations/:id/approve",A(async(q,s)=>{const id=uid(q.params.id);
 const d=id&&await tx(async c=>{const r=(await c.query("DELETE FROM regs WHERE id=$1 RETURNING data",[id])).rows[0];if(!r)return null;
  const pid=await nextId("patients",(t,p)=>c.query(t,p)),d={...r.data,id:pid,date:today()};delete d.consent;
  await c.query("INSERT INTO docs(coll,id,data) VALUES('patients',$1,$2)",[pid,JSON.stringify(d)]);return d});
 if(!d)return s.status(404).json({error:"Not found"});await audit(q.u,"reg_approve",d.id);s.json(d)}));
app.delete("/api/registrations/:id",A(async(q,s)=>{const id=uid(q.params.id);if(id)await Q("DELETE FROM regs WHERE id=$1",[id]);await audit(q.u,"reg_reject",q.params.id);s.json({ok:true})}));

/* records: patients, appts, rx (doctor only), bills */
const coll=(q,s,n)=>{if(!PFX[q.params.c])return s.status(404).json({error:"Unknown collection"});if(q.params.c==="rx"&&q.u.role!=="doctor")return s.status(403).json({error:"Only a doctor can do this"});
 const j=q.body&&typeof q.body==="object"&&!Array.isArray(q.body)?JSON.stringify(q.body):"";if(!j||j.length>1e5||j.includes("\\u0000"))return s.status(400).json({error:"Bad data"});n()};
app.post("/api/:c",coll,A(async(q,s)=>{const id=await nextId(q.params.c),d={...q.body,id};if(q.params.c==="rx"||q.params.c==="bills")d.no=id;
 await Q("INSERT INTO docs(coll,id,data) VALUES($1,$2,$3)",[q.params.c,id,JSON.stringify(d)]);await audit(q.u,"create",id);s.json(d)}));
app.put("/api/:c/:id",coll,A(async(q,s)=>{const d={...q.body,id:q.params.id};if(q.params.c==="rx"||q.params.c==="bills")d.no=q.params.id;
 const r=await Q("UPDATE docs SET data=$1,upd=now() WHERE coll=$2 AND id=$3",[JSON.stringify(d),q.params.c,q.params.id]);
 if(!r.rowCount)return s.status(404).json({error:"Not found"});await audit(q.u,"update",q.params.id);s.json(d)}));
app.use((e,q,s,n)=>{if(e.type==="entity.parse.failed"||e.type==="entity.too.large")return s.status(400).json({error:"Bad request"});console.error(e);s.status(500).json({error:"Server error"})});

(async()=>{await init();DUMMY=await hashPw(crypto.randomBytes(8).toString("hex"));
 const srv=app.listen(PORT,()=>console.log("OPD Desk running on port "+PORT));
 const stop=()=>srv.close(()=>pool.end().then(()=>process.exit(0)));process.on("SIGTERM",stop);process.on("SIGINT",stop)})()
 .catch(e=>{console.error("Startup failed:",e.message);process.exit(1)});
