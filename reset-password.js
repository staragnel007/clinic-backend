// Usage: DATABASE_URL=... node reset-password.js <username> <new-password>   (run on the server)
const {Pool}=require("pg"),c=require("crypto"),scrypt=require("util").promisify(c.scrypt);
const [,,u,p]=process.argv;
if(!process.env.DATABASE_URL||!u||!p||p.length<8){console.log("Usage: DATABASE_URL=... node reset-password.js <username> <new-password (8+ chars)>");process.exit(1)}
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==="1"?{rejectUnauthorized:process.env.PGSSL_STRICT==="1"}:undefined});
(async()=>{const s=c.randomBytes(16),h=s.toString("hex")+":"+(await scrypt(p,s,64)).toString("hex");
 const r=await pool.query("UPDATE users SET hash=$1 WHERE username=$2 RETURNING id",[h,u.toLowerCase()]);
 if(r.rowCount){await pool.query("DELETE FROM sessions WHERE uid=$1",[r.rows[0].id]);console.log("Password reset for "+u)}else console.log("No such user");
 await pool.end()})().catch(e=>{console.error(e.message);process.exit(1)});
