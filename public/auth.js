const Auth={
 token:localStorage.getItem('fleet_token')||'',user:null,
 async request(path,options={}){const headers={...(options.headers||{})};if(this.token)headers.Authorization=`Bearer ${this.token}`;const r=await fetch(path,{...options,headers});let data=null;try{data=await r.json()}catch{}if(!r.ok){const e=new Error(data?.error||`HTTP ${r.status}`);e.status=r.status;throw e}return data},
 async status(){return this.request('/api/auth/status')},
 async login(email,password){const data=await this.request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});this.token=data.token;this.user=data.user;localStorage.setItem('fleet_token',this.token);return data},
 async setup(payload){const data=await this.request('/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});return data},
 async me(){if(!this.token)throw Object.assign(new Error('No autenticado'),{status:401});const data=await this.request('/api/auth/me');this.user=data.user;return data.user},
 async logout(){try{await this.request('/api/auth/logout',{method:'POST'})}catch{}this.token='';this.user=null;localStorage.removeItem('fleet_token')}
};
window.Auth=Auth;