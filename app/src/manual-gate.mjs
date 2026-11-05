// A generic 429 may accompany an interactive verification gate. In manual
// mode preserve the page and await the user's next send, rather than retrying.
export function requiresManualWait(status, text = '') {
  return status === 429 || (status === 403 && /captcha|verification|验证/i.test(text));
}
export function abortable(promise,signal){
  if(!signal)return promise;
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new Error('已请求停止'));
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    if(signal.aborted)abort();
  });
}
