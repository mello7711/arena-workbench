// Only recover an unchanged, visibly unsent composer. Never retry network errors.
export function clickUnsentComposer({ prompt, expectedUrl }) {
  if (location.href !== expectedUrl) return false;
  const visible = e => e.getClientRects().length > 0;
  if (Array.from(document.querySelectorAll('iframe')).some(e =>
    /recaptcha|captcha/i.test(e.src || '') && visible(e))) return false;
  const buttons = Array.from(document.querySelectorAll('button'));
  if (buttons.some(b => visible(b) && /^(Stop|Stop generating|Stop response|停止|停止生成)$/i.test(
    (b.getAttribute('aria-label') || b.innerText || '').trim()))) return false;
  const editors = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(visible);
  const editor = editors.at(-1);
  const normalize = s => String(s).replace(/\r\n/g, '\n').trim();
  if (!editor || normalize(editor.textContent) !== normalize(prompt)) return false;
  const send = buttons.find(b => visible(b) && !b.disabled &&
    /^(Send message|发送消息)$/i.test((b.getAttribute('aria-label') || b.innerText || '').trim()));
  if (!send) return false;
  send.click();
  return true;
}
