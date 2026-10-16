import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(ROOT, 'uploads');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_PASSWORD_FILE = path.join(DATA, 'admin-password.txt');
const sessions = new Map();
let adminPassword;
let store;
let writeQueue = Promise.resolve();

const mimeTypes = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.ico':'image/x-icon' };
const safeText = (value, max=5000) => String(value ?? '').trim().slice(0,max);
const id = () => crypto.randomUUID();
const slug = (text) => safeText(text,100).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,70) || crypto.randomBytes(4).toString('hex');

async function init() {
  await Promise.all([fs.mkdir(DATA,{recursive:true}),fs.mkdir(UPLOADS,{recursive:true})]);
  if(process.env.ADMIN_PASSWORD) { adminPassword=process.env.ADMIN_PASSWORD; console.log('Admin password loaded from ADMIN_PASSWORD.'); }
  else {
    try { adminPassword = (await fs.readFile(ADMIN_PASSWORD_FILE,'utf8')).trim(); }
    catch {
      adminPassword = crypto.randomBytes(12).toString('base64url');
      await fs.writeFile(ADMIN_PASSWORD_FILE,adminPassword,{encoding:'utf8',mode:0o600});
      console.log(`First-run admin password: ${adminPassword}\nSaved in data/admin-password.txt`);
    }
  }
  const seed=JSON.parse(await fs.readFile(path.join(DATA,'store.seed.json'),'utf8'));
  try { store = JSON.parse(await fs.readFile(path.join(DATA,'store.json'),'utf8')); }
  catch { store = seed; }
  store.content={...seed.content,...(store.content||{})};
  for(const key of ['products','promotions','orders','customers','reviews','activity']) if(!Array.isArray(store[key])) store[key]=seed[key]||[];
  await saveStore();
}

function saveStore() {
  writeQueue = writeQueue.then(async () => {
    const temp = path.join(DATA,`store.${process.pid}.tmp`);
    await fs.writeFile(temp,JSON.stringify(store,null,2),'utf8');
    await fs.rename(temp,path.join(DATA,'store.json'));
  });
  return writeQueue;
}

function json(res,status,data,headers={}) {
  const body = JSON.stringify(data);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});
  res.end(body);
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),decodeURIComponent(x.slice(i+1))]}));
}

function authType(req) {
  const cookies=parseCookies(req); const token=cookies.jewel_admin;
  const entry=token && sessions.get(token);
  return entry && entry.expires > Date.now() ? entry.role : null;
}

function sessionCookie(token,maxAge=86400) {
  return `jewel_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

async function bodyJson(req,limit=1_000_000) {
  let data='';
  for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data)>limit) { const e=new Error('Request is too large.'); e.status=413; throw e; } }
  if (!data) return {};
  try { return JSON.parse(data); } catch { const e=new Error('Invalid JSON.'); e.status=400; throw e; }
}

function publicStore() {
  return {
    content:store.content,
    products:store.products.filter(p=>p.status==='published').map(p=>({...p,stock:availableStock(p.id)})),
    promotions:store.promotions.filter(p=>p.active).map(({code,type,value,minimum})=>({code,type,value,minimum})),
    reviews:store.reviews.filter(r=>r.status==='approved'),
    categories:[...new Set(store.products.filter(p=>p.status==='published').map(p=>p.category).filter(Boolean))]
  };
}

function adminData() {
  const customers = new Map();
  for (const c of store.customers) customers.set(c.email,{...c,orders:[]});
  for (const order of store.orders) {
    const email=(order.customer?.email||'').toLowerCase(); if (!email) continue;
    const customer=customers.get(email)||{name:order.customer.name||'',email,phone:order.customer.phone||'',createdAt:order.createdAt,orders:[]};
    customer.orders.push(order.id); customers.set(email,customer);
  }
  const cleanCustomers=[...customers.values()].map(({passwordHash,passwordSalt,...c})=>c);
  return {content:store.content,products:store.products,promotions:store.promotions,orders:store.orders,customers:cleanCustomers,reviews:store.reviews,activity:store.activity.slice(-30).reverse()};
}

function logActivity(action,detail='') {
  store.activity.push({id:id(),action:safeText(action,120),detail:safeText(detail,250),at:new Date().toISOString()});
  store.activity=store.activity.slice(-200);
}

function validImageUrl(value) {
  const text=safeText(value,4000);
  if (!text) return '';
  if (text.startsWith('/uploads/')) return text.replace(/[^/a-zA-Z0-9._-]/g,'');
  try { const u=new URL(text); if (['http:','https:'].includes(u.protocol)) return u.toString(); } catch {}
  return '';
}

function normalizeProduct(input, old={}) {
  const p={...old};
  for(const key of ['title','description','category','collection','material','purity','gemstone','shape']) p[key]=safeText(input[key]??old[key], key==='description'?3000:200);
  p.price=Math.max(0,Math.round(Number(input.price??old.price)||0));
  p.compareAt=Math.max(0,Math.round(Number(input.compareAt??old.compareAt)||0));
  p.stock=Math.max(0,Math.floor(Number(input.stock??old.stock)||0));
  p.sizeOptions=Array.isArray(input.sizeOptions)?input.sizeOptions.map(x=>safeText(x,60)).filter(Boolean).slice(0,40):(old.sizeOptions||[]);
  p.image=validImageUrl(input.image??old.image);
  p.featured=Boolean(input.featured??old.featured);
  p.status=['published','draft','archived'].includes(input.status)?input.status:(old.status||'draft');
  if(!p.id) p.id=slug(p.title);
  if(!p.createdAt) p.createdAt=new Date().toISOString();
  return p;
}

function promotionFor(code) {
  const wanted=safeText(code,50).toUpperCase();
  return store.promotions.find(p=>p.active && p.code.toUpperCase()===wanted) || null;
}

function availableStock(productId) {
  const held=store.orders.filter(o=>['New','Confirmed'].includes(o.status)&&!['Failed','Refunded'].includes(o.paymentStatus)).reduce((n,o)=>n+o.items.filter(i=>i.productId===productId&&!i.inventoryApplied).reduce((m,i)=>m+i.quantity,0),0);
  const product=store.products.find(p=>p.id===productId);
  return Math.max(0,Number(product?.stock||0)-held);
}

function estimateOrder(items,code) {
  let subtotal=0; const lines=[];
  for(const entry of items) {
    const product=store.products.find(p=>p.id===entry.productId && p.status==='published');
    const qty=Math.max(1,Math.min(20,Math.floor(Number(entry.quantity)||1)));
    if(!product) throw Object.assign(new Error('One of the selected products is no longer available.'),{status:400});
    const available=availableStock(product.id);
    if(available<qty) throw Object.assign(new Error(`${product.title} has only ${available} available.`),{status:400});
    const size=safeText(entry.size,60);
    if(product.sizeOptions?.length && size && !product.sizeOptions.includes(size)) throw Object.assign(new Error(`Choose a valid option for ${product.title}.`),{status:400});
    const line={productId:product.id,title:product.title,quantity:qty,unitPrice:product.price,size,image:product.image};
    subtotal += product.price*qty; lines.push(line);
  }
  let discount=0; const promo=promotionFor(code);
  if(promo && subtotal>=Number(promo.minimum||0)) discount=promo.type==='percent'?Math.round(subtotal*Math.min(90,Number(promo.value)||0)/100):Math.min(subtotal,Math.max(0,Number(promo.value)||0));
  const shipping=subtotal-discount>=10000?0:350;
  return {lines,subtotal,discount,shipping,total:Math.max(0,subtotal-discount+shipping),promoCode:discount?promo.code:''};
}

async function route(req,res) {
  const url=new URL(req.url,'http://localhost');
  const p=url.pathname;
  if(req.method==='GET' && p==='/api/store') return json(res,200,publicStore());
  if(req.method==='GET' && p==='/api/admin/session') return json(res,200,{authenticated:authType(req)==='admin'});
  if(req.method==='POST' && p==='/api/admin/login') {
    const data=await bodyJson(req); const supplied=Buffer.from(String(data.password||'')); const expected=Buffer.from(adminPassword); if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected)) return json(res,401,{error:'Incorrect admin password.'});
    const token=crypto.randomBytes(32).toString('base64url'); sessions.set(token,{role:'admin',expires:Date.now()+86400000});
    return json(res,200,{ok:true},{'Set-Cookie':sessionCookie(token)});
  }
  if(req.method==='POST' && p==='/api/admin/logout') {
    const token=parseCookies(req).jewel_admin; if(token)sessions.delete(token);
    return json(res,200,{ok:true},{'Set-Cookie':sessionCookie('',0)});
  }
  if(req.method==='POST' && p==='/api/orders') {
    const data=await bodyJson(req);
    const customer={name:safeText(data.customer?.name,150),email:safeText(data.customer?.email,200).toLowerCase(),phone:safeText(data.customer?.phone,50),address:safeText(data.customer?.address,400),city:safeText(data.customer?.city,100),postalCode:safeText(data.customer?.postalCode,20),country:safeText(data.customer?.country,100)};
    if(!customer.name||!customer.email||!customer.address||!customer.city) return json(res,400,{error:'Enter your name, email, street address, and city.'});
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email))return json(res,400,{error:'Enter a valid email address.'});
    const quote=estimateOrder(Array.isArray(data.items)?data.items:[],data.promoCode);
    const order={id:`AU-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,customer,items:quote.lines,subtotal:quote.subtotal,discount:quote.discount,shipping:quote.shipping,total:quote.total,promoCode:quote.promoCode,paymentMethod:'Payment to be arranged',paymentStatus:'Pending',status:'New',giftMessage:safeText(data.giftMessage,500),createdAt:new Date().toISOString(),events:[{status:'New',at:new Date().toISOString()}]};
    store.orders.push(order); logActivity('Order received',`${order.id} · ${customer.name}`); await saveStore();
    return json(res,201,{orderId:order.id,status:order.status,total:order.total});
  }
  if(req.method==='POST' && p==='/api/customers/signup') {
    const d=await bodyJson(req); const email=safeText(d.email,200).toLowerCase(); const name=safeText(d.name,150); const password=String(d.password||'');
    if(!name||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<8)return json(res,400,{error:'Enter your name, a valid email, and a password of at least 8 characters.'});
    if(store.customers.some(x=>x.email===email))return json(res,409,{error:'An account already exists for this email. Sign in instead.'});
    const passwordSalt=crypto.randomBytes(16).toString('hex'); const passwordHash=crypto.scryptSync(password,passwordSalt,64).toString('hex');
    const customer={id:id(),name,email,phone:safeText(d.phone,50),passwordSalt,passwordHash,createdAt:new Date().toISOString()}; store.customers.push(customer); logActivity('Customer account created',email); await saveStore();
    const token=crypto.randomBytes(32).toString('base64url'); sessions.set(token,{role:'customer',email,expires:Date.now()+86400000});
    return json(res,201,{ok:true,customer:{name,email}},{'Set-Cookie':sessionCookie(token)});
  }
  if(req.method==='POST' && p==='/api/customers/signin') {
    const d=await bodyJson(req); const email=safeText(d.email,200).toLowerCase(); const c=store.customers.find(x=>x.email===email);
    const supplied=crypto.scryptSync(String(d.password||''),c?.passwordSalt||'not-a-valid-salt',64).toString('hex');
    if(!c||!crypto.timingSafeEqual(Buffer.from(supplied,'hex'),Buffer.from(c.passwordHash,'hex')))return json(res,401,{error:'Email or password is incorrect.'});
    const token=crypto.randomBytes(32).toString('base64url'); sessions.set(token,{role:'customer',email,expires:Date.now()+86400000});
    return json(res,200,{ok:true,customer:{name:c.name,email:c.email}},{'Set-Cookie':sessionCookie(token)});
  }
  if(req.method==='GET' && p==='/api/customer/account') {
    const token=parseCookies(req).jewel_admin; const session=token&&sessions.get(token);
    if(!session||session.role!=='customer'||session.expires<Date.now())return json(res,401,{error:'Sign in to view your account.'});
    const customer=store.customers.find(x=>x.email===session.email); if(!customer)return json(res,404,{error:'Account not found.'});
    const {passwordHash,passwordSalt,...safeCustomer}=customer;
    return json(res,200,{customer:safeCustomer,orders:store.orders.filter(x=>x.customer.email===customer.email).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});
  }
  if(req.method==='POST' && p==='/api/reviews') {
    const data=await bodyJson(req); const product=store.products.find(x=>x.id===data.productId && x.status==='published');
    if(!product)return json(res,404,{error:'Product not found.'});
    const rating=Math.floor(Number(data.rating)); if(rating<1||rating>5)return json(res,400,{error:'Choose a rating from 1 to 5.'});
    const review={id:id(),productId:product.id,name:safeText(data.name,120),rating,text:safeText(data.text,1500),image:validImageUrl(data.image),status:'pending',createdAt:new Date().toISOString()};
    if(!review.name||!review.text)return json(res,400,{error:'Enter your name and review.'});
    store.reviews.push(review); await saveStore(); return json(res,201,{ok:true,message:'Thanks. Your review is awaiting approval.'});
  }
  if(req.method==='POST' && p==='/api/reviews/upload') {
    const data=await bodyJson(req,5*1024*1024); const match=String(data.dataUrl||'').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if(!match)return json(res,400,{error:'Choose a PNG, JPEG, or WebP image.'});
    const bytes=Buffer.from(match[2],'base64'); if(bytes.length>3*1024*1024)return json(res,413,{error:'Review images must be 3 MB or smaller.'});
    const ok=match[1]==='image/png'?bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):match[1]==='image/jpeg'?bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex')):bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
    if(!ok)return json(res,400,{error:'The image file could not be verified.'});
    const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[match[1]]; const file=`${crypto.randomBytes(12).toString('hex')}.${ext}`;
    await fs.writeFile(path.join(UPLOADS,file),bytes,{flag:'wx'}); return json(res,201,{url:`/uploads/${file}`});
  }

  if(p.startsWith('/api/admin/')) {
    if(authType(req)!=='admin')return json(res,401,{error:'Admin sign-in required.'});
    if(req.method==='GET' && p==='/api/admin/data')return json(res,200,adminData());
    if(req.method==='PUT' && p==='/api/admin/content') {
      const data=await bodyJson(req); const fields=['brandName','announcement','heroEyebrow','heroTitle','heroText','heroButton','heroImage','storyTitle','storyImage','storyText','contactEmail','currency','currencySymbol','footerText','shippingPolicy','returnsPolicy','carePolicy','privacyPolicy','termsPolicy'];
      for(const key of fields) if(key in data) store.content[key]=['heroImage','storyImage'].includes(key)?validImageUrl(data[key]):safeText(data[key],key.includes('Text')||key.includes('Policy')?3000:350);
      logActivity('Store content updated'); await saveStore(); return json(res,200,{content:store.content});
    }
    if(req.method==='POST' && p==='/api/admin/upload') {
      const data=await bodyJson(req,12*1024*1024); const match=String(data.dataUrl||'').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
      if(!match)return json(res,400,{error:'Choose a PNG, JPEG, or WebP image.'});
      const bytes=Buffer.from(match[2],'base64'); if(bytes.length>8*1024*1024)return json(res,413,{error:'Images must be 8 MB or smaller.'});
      const ok=match[1]==='image/png'?bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):match[1]==='image/jpeg'?bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex')):bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
      if(!ok)return json(res,400,{error:'The image file could not be verified.'});
      const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[match[1]]; const file=`${crypto.randomBytes(12).toString('hex')}.${ext}`;
      await fs.writeFile(path.join(UPLOADS,file),bytes,{flag:'wx'}); return json(res,201,{url:`/uploads/${file}`});
    }
    if(req.method==='POST' && p==='/api/admin/products') {
      const data=await bodyJson(req); const product=normalizeProduct(data); if(!product.title||!product.category)return json(res,400,{error:'Product name and category are required.'});
      while(store.products.some(x=>x.id===product.id))product.id=`${slug(product.title)}-${crypto.randomBytes(2).toString('hex')}`;
      store.products.push(product); logActivity('Product created',product.title); await saveStore(); return json(res,201,{product});
    }
    const productMatch=p.match(/^\/api\/admin\/products\/([^/]+)$/);
    if(productMatch) {
      const product=store.products.find(x=>x.id===decodeURIComponent(productMatch[1])); if(!product)return json(res,404,{error:'Product not found.'});
      if(req.method==='PUT') { const data=await bodyJson(req); Object.assign(product,normalizeProduct(data,product)); logActivity('Product updated',product.title); await saveStore(); return json(res,200,{product}); }
      if(req.method==='DELETE') { product.status='archived'; logActivity('Product archived',product.title); await saveStore(); return json(res,200,{ok:true}); }
    }
    if(req.method==='POST' && p==='/api/admin/promotions') {
      const d=await bodyJson(req), code=safeText(d.code,50).toUpperCase(); if(!code)return json(res,400,{error:'Promotion code is required.'});
      const promo={code,type:d.type==='fixed'?'fixed':'percent',value:Math.max(0,Number(d.value)||0),minimum:Math.max(0,Number(d.minimum)||0),active:Boolean(d.active)};
      const existing=store.promotions.findIndex(x=>x.code===code); if(existing>=0)store.promotions[existing]=promo;else store.promotions.push(promo);
      logActivity('Promotion saved',code); await saveStore(); return json(res,200,{promotion:promo});
    }
    const promoMatch=p.match(/^\/api\/admin\/promotions\/([^/]+)$/);
    if(promoMatch&&req.method==='DELETE') { store.promotions=store.promotions.filter(x=>x.code!==decodeURIComponent(promoMatch[1])); await saveStore(); return json(res,200,{ok:true}); }
    const reviewMatch=p.match(/^\/api\/admin\/reviews\/([^/]+)$/);
    if(reviewMatch&&req.method==='PUT') { const review=store.reviews.find(x=>x.id===decodeURIComponent(reviewMatch[1])); if(!review)return json(res,404,{error:'Review not found.'}); const d=await bodyJson(req); if(d.status==='approved'||d.status==='rejected')review.status=d.status; await saveStore(); return json(res,200,{review}); }
    if(reviewMatch&&req.method==='DELETE') { store.reviews=store.reviews.filter(x=>x.id!==decodeURIComponent(reviewMatch[1])); await saveStore(); return json(res,200,{ok:true}); }
    const orderMatch=p.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if(orderMatch&&req.method==='PUT') {
      const order=store.orders.find(x=>x.id===decodeURIComponent(orderMatch[1])); if(!order)return json(res,404,{error:'Order not found.'}); const d=await bodyJson(req);
      if(['New','Confirmed','Processing','Shipped','Delivered','Cancelled','Return requested','Returned'].includes(d.status)) {
        const oldStatus=order.status; const terminal=['Cancelled','Returned'];
        if(terminal.includes(oldStatus)&&!terminal.includes(d.status))return json(res,409,{error:'A cancelled or returned order cannot be reopened. Create a new order instead.'});
        order.status=d.status;
        if(['Processing','Shipped','Delivered'].includes(d.status)) for(const item of order.items) if(!item.inventoryApplied){const product=store.products.find(x=>x.id===item.productId);if(!product||product.stock<item.quantity){order.status=oldStatus;return json(res,409,{error:`Not enough stock to fulfill ${item.title}.`});}product.stock-=item.quantity;item.inventoryApplied=true;}
        if(['Cancelled','Returned'].includes(d.status)) for(const item of order.items) if(item.inventoryApplied&&!item.inventoryRestocked){const product=store.products.find(x=>x.id===item.productId);if(product)product.stock+=item.quantity;item.inventoryRestocked=true;}
        order.events.push({status:d.status,at:new Date().toISOString()});
      }
      if(['Pending','Paid','Failed','Refunded'].includes(d.paymentStatus))order.paymentStatus=d.paymentStatus;
      if(d.trackingNumber!==undefined)order.trackingNumber=safeText(d.trackingNumber,120);
      logActivity('Order updated',order.id); await saveStore(); return json(res,200,{order});
    }
    return json(res,404,{error:'Admin endpoint not found.'});
  }

  let filePath;
  if(p.startsWith('/uploads/')) filePath=path.resolve(UPLOADS,p.slice('/uploads/'.length));
  else filePath=path.resolve(PUBLIC,p==='/'?'index.html':`.${decodeURIComponent(p)}`);
  const base=p.startsWith('/uploads/')?UPLOADS:PUBLIC;
  if(!filePath.startsWith(path.resolve(base)+path.sep) && filePath!==path.resolve(base,'index.html'))return json(res,403,{error:'Forbidden.'});
  try { const data=await fs.readFile(filePath); const type=mimeTypes[path.extname(filePath).toLowerCase()]||'application/octet-stream'; res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",'Cache-Control':filePath.includes('/uploads/')?'public, max-age=31536000, immutable':'no-cache'});res.end(data); }
  catch { return json(res,404,{error:'Not found.'}); }
}

await init();
const server=http.createServer(async (req,res)=>{
  try { await route(req,res); }
  catch(error) { console.error(error); if(!res.headersSent)json(res,error.status||500,{error:error.status?error.message:'Something went wrong. Please try again.'}); else res.destroy(); }
});
server.listen(PORT,HOST,()=>console.log(`Jewelry store running at http://${HOST}:${PORT}`));

