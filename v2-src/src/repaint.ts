/**
 * iPhoneのWebKitで、開いた直後に中身が描かれず空っぽに見えることがある
 * （月を切り替えるなど何か動かすと出る）。画面を開いてしばらくの間、
 * 中身が変わるたびに軽く描き直しをうながす。
 */
export function kickRepaint(el: HTMLElement | null, windowMs = 2500): () => void {
  if (!el || typeof MutationObserver === "undefined") return () => undefined;
  let timer: number | null = null;
  const kick = () => {
    timer = null;
    el.style.opacity = "0.999";
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.opacity = ""; }));
  };
  const schedule = () => { if (timer === null) timer = window.setTimeout(kick, 60); };
  const observer = new MutationObserver(schedule);
  observer.observe(el, { childList: true, subtree: true });
  schedule();
  const stop = window.setTimeout(() => observer.disconnect(), windowMs);
  return () => { observer.disconnect(); window.clearTimeout(stop); if (timer !== null) window.clearTimeout(timer); el.style.opacity = ""; };
}
