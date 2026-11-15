// Usage: node reset-password.js <username> <new-password>   (run on the server, with the same DATA_DIR)
const D=require("better-sqlite3"),c=require("crypto"),path=require("path");
const [,,u,p]=process.argv;if(!u||!p||p.length<8){console.log("Usage: node reset-password.js <username> <new-password (8+ chars)>");process.exit(1)}
const db=new D(path.join(process.env.DATA_DIR||path.join(__dirname,"data"),"clinic.db")),s=c.randomBytes(16);
const r=db.prepare("UPDATE users SET hash=? WHERE username=?").run(s.toString("hex")+":"+c.scryptSync(p,s,64).toString("hex"),u.toLowerCase());
if(r.changes){db.prepare("DELETE FROM sessions WHERE uid=(SELECT id FROM users WHERE username=?)").run(u.toLowerCase());console.log("Password reset for "+u)}else console.log("No such user");
