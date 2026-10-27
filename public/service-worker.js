const CACHE='fleetchile-driver-shell-v2';
const SHELL=['/driver','/driver.html','/driver.css','/driver.js','/driver-vault.js','/driver-mobile.js','/auth.js','/manifest.webmanifest','/icon-192.svg','/icon-512.svg'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 for(const name of await caches.keys())if(name.startsWith('fleetchile-driver-shell-')&&name!==CACHE)await caches.delete(name);
 await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin)return;
 if(request.url.includes('/api/'))return;
 if(!SHELL.includes(url.pathname))return;
 const navigation=request.mode==='navigate'&&['/driver','/driver.html'].includes(url.pathname);
 // One complete version of the shell; APIs, credentials and evidence are never cached.
 event.respondWith(caches.open(CACHE).then(async cache=>{
  const cached=await cache.match(url.pathname);if(cached)return cached;
  try{return await fetch(request);}catch(e){if(navigation){const page=await cache.match('/driver.html');if(page)return page;}throw e;}
 }));
});
